# app.py - 校园发帖平台后端主程序
# 接口：
#   POST /api/send-code            -> 发送邮箱验证码
#   POST /api/register             -> 注册 {email, password, code}
#   POST /api/login                -> 登录 {email, password}
#   GET  /api/me                   -> 当前登录用户信息
#   GET  /api/posts                -> 帖子列表
#   POST /api/posts                -> 发新帖（需登录）
#   GET  /api/posts/<id>           -> 帖子详情
#   DELETE /api/posts/<id>         -> 删帖（管理员或楼主）
#   GET  /api/posts/<id>/comments  -> 评论列表
#   POST /api/posts/<id>/comments  -> 发评论（需登录）
#   DELETE /api/posts/<id>/comments/<cid>  -> 删评论（管理员或评论者）
#   GET  /api/tags                 -> 所有标签
#   GET  /api/admin/stats          -> 注册用户数等统计（管理员）

import json
import os
import re
import sqlite3
from datetime import datetime, timezone
import secrets
import time
import uuid
from functools import wraps

import psycopg2
import psycopg2.extras
import requests
from flask import Flask, request, jsonify, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash

from ai_client import ai_reply
from email_service import send_code

app = Flask(__name__)

DB_PATH = os.path.join(os.path.dirname(__file__), "school_posts.db")
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..")
# 环境变量里的连接串容易被粘贴带入换行 / 空格 / 引号，导致 PG 报
# database "postgres\n" does not exist；这里统一清洗，双端都安全。
DATABASE_URL = "".join((os.getenv("DATABASE_URL") or "").split()).strip('"').strip("'") or None

# 图片存储（Supabase Storage）。密钥只从环境变量读，绝不写进代码或日志。
SUPABASE_URL = (os.getenv("SUPABASE_URL") or "").strip().strip('"').strip("'").rstrip("/")
SUPABASE_KEY = (os.getenv("SUPABASE_SERVICE_KEY") or "").strip().strip('"').strip("'")
SUPABASE_BUCKET = (os.getenv("SUPABASE_BUCKET") or "").strip().strip('"').strip("'")
MAX_IMAGE_BYTES = 10 * 1024 * 1024

# 2.5 等级 -> 单帖图片张数（唯一真源，之后只改这里）
LEVEL_IMAGE_LIMITS = {1: 3, 2: 5, 3: 7, 4: 9}
# (发帖数达到, 等级)，从高到低匹配；按当前发帖数计算
LEVEL_POST_THRESHOLDS = ((30, 4), (10, 3), (3, 2), (0, 1))

app.config["MAX_CONTENT_LENGTH"] = MAX_IMAGE_BYTES + 2 * 1024 * 1024

_CODE_STORE = {}
CODE_TTL = 300
_SESSION_STORE = {}
SESSION_TTL = 7 * 24 * 3600


class _DbWrapper:
    """包装数据库连接，自动把 ? 占位符转成当前数据库的占位符"""
    def __init__(self, conn, use_pg):
        self._conn = conn
        self._use_pg = use_pg
        if not use_pg:
            conn.row_factory = sqlite3.Row

    def execute(self, sql, params=()):
        if self._use_pg:
            sql = sql.replace("?", "%s")
            cur = self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            cur.execute(sql, params)
            return cur
        else:
            return self._conn.execute(sql, params)

    def last_id(self, cur):
        """兼容 SQLite 和 PostgreSQL 获取最后插入的 ID"""
        if self._use_pg:
            row = cur.fetchone()
            return row["id"] if row else 0
        return cur.lastrowid

    def last_id_by_key(self, table, key_col, key_val):
        """插入后按唯一字段反查 ID（最稳妥，兼容两种数据库）"""
        row = self.execute(f"SELECT id FROM {table} WHERE {key_col}=?", (key_val,)).fetchone()
        return row["id"] if row else 0

    def max_id(self, table):
        row = self.execute(f"SELECT MAX(id) AS m FROM {table}").fetchone()
        return row["m"] if row and row["m"] is not None else 0

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


def get_db():
    if DATABASE_URL:
        try:
            conn = psycopg2.connect(DATABASE_URL)
        except Exception as e:
            # 只打印错误原因，不回显连接串内容（避免密码进日志）
            print(f"[数据库] 连接 PostgreSQL 失败：{type(e).__name__}: {str(e).splitlines()[0] if str(e) else ''}")
            raise
        return _DbWrapper(conn, use_pg=True)
    else:
        conn = sqlite3.connect(DB_PATH)
        return _DbWrapper(conn, use_pg=False)


@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    return resp


@app.errorhandler(413)
def payload_too_large(e):
    return jsonify({"error": "图片太大（单张上限 10MB）"}), 413


@app.route("/api/config", methods=["GET"])
def app_config():
    level, image_limit, _ = _user_level_and_limit(_get_current_user())
    return jsonify({
        "max_post_images": image_limit,
        "level": level,
        "max_image_mb": MAX_IMAGE_BYTES // (1024 * 1024),
        "upload_enabled": bool(SUPABASE_URL and SUPABASE_KEY and SUPABASE_BUCKET),
    })


def _get_current_user():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:].strip()
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, email, username, is_admin FROM users WHERE token=? AND token_expires>?",
            (token, time.time())
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def _level_from_post_count(count):
    for need, level in LEVEL_POST_THRESHOLDS:
        if count >= need:
            return level
    return 1


def _user_level_and_limit(user):
    """返回 (等级, 单帖图片上限, 已发帖数)。未登录按 1 级。"""
    if not user:
        return 1, LEVEL_IMAGE_LIMITS[1], 0
    conn = get_db()
    try:
        count = conn.execute(
            "SELECT COUNT(*) AS c FROM posts WHERE author=?", (user["username"],)
        ).fetchone()["c"]
    finally:
        conn.close()
    if user.get("is_admin"):
        return 4, LEVEL_IMAGE_LIMITS[4], count
    level = _level_from_post_count(count)
    return level, LEVEL_IMAGE_LIMITS[level], count


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        user = _get_current_user()
        if not user:
            return jsonify({"error": "未登录"}), 401
        request.current_user = user
        return f(*args, **kwargs)
    return wrapper


def admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        user = _get_current_user()
        if not user:
            return jsonify({"error": "未登录"}), 401
        if not user.get("is_admin"):
            return jsonify({"error": "需要管理员权限"}), 403
        request.current_user = user
        return f(*args, **kwargs)
    return wrapper


@app.route("/api/send-code", methods=["POST"])
def send_code_api():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        return jsonify({"error": "邮箱格式不对"}), 400
    conn = get_db()
    try:
        row = conn.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if row:
            return jsonify({"error": "这个邮箱已经注册过了"}), 400
    finally:
        conn.close()
    code = f"{secrets.randbelow(1000000):06d}"
    _CODE_STORE[email] = (code, time.time() + CODE_TTL)
    ok = send_code(email, code)
    if not ok:
        return jsonify({"error": "邮件发送失败"}), 500
    return jsonify({"ok": True, "message": "验证码已发送（5 分钟内有效）"})


@app.route("/api/register", methods=["POST"])
def register():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    if not username or len(username) < 2:
        return jsonify({"error": "昵称至少 2 个字符"}), 400
    if len(password) < 6:
        return jsonify({"error": "密码至少 6 位"}), 400
    pwd_hash = generate_password_hash(password)
    fake_email = username + "@ywies.local"
    conn = get_db()
    try:
        # 先查重：SQLite 与 PostgreSQL 的异常类型不同，靠异常判断会漏
        if conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone():
            return jsonify({"error": "这个昵称已经被注册了"}), 400
        conn.execute(
            "INSERT INTO users (email, username, password, is_admin) VALUES (?, ?, ?, 0)",
            (fake_email, username, pwd_hash),
        )
        conn.commit()
        token = secrets.token_urlsafe(32)
        # 按用户名写登录态，不依赖自增 ID（PG 下 cursor.lastrowid 取不到值）
        conn.execute(
            "UPDATE users SET token=?, token_expires=? WHERE username=?",
            (token, time.time() + SESSION_TTL, username)
        )
        conn.commit()
        user_id = conn.last_id_by_key("users", "username", username)
    except sqlite3.IntegrityError:
        return jsonify({"error": "这个昵称已经被注册了"}), 400
    finally:
        conn.close()
    return jsonify({"token": token, "user": {"id": user_id, "email": fake_email, "username": username, "is_admin": 0}})


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        if not row:
            return jsonify({"error": "昵称或密码不对"}), 401
        if not check_password_hash(row["password"], password):
            return jsonify({"error": "昵称或密码不对"}), 401
        token = secrets.token_urlsafe(32)
        conn.execute(
            "UPDATE users SET token=?, token_expires=? WHERE id=?",
            (token, time.time() + SESSION_TTL, row["id"])
        )
        conn.commit()
        return jsonify({
            "token": token,
            "user": {"id": row["id"], "email": row["email"], "username": row["username"], "is_admin": row["is_admin"]}
        })
    finally:
        conn.close()


@app.route("/api/me", methods=["GET"])
def me():
    user = _get_current_user()
    if not user:
        return jsonify({"error": "未登录"}), 401
    level, image_limit, post_count = _user_level_and_limit(user)
    data = dict(user)
    data.update({"level": level, "max_post_images": image_limit, "post_count": post_count})
    return jsonify({"user": data})


@app.route("/api/health", methods=["GET"])
def health():
    """部署自检：确认线上跑的是哪个提交、连的是哪种数据库（不暴露密钥）"""
    ok = True
    try:
        conn = get_db()
        try:
            conn.execute("SELECT 1").fetchone()
        finally:
            conn.close()
    except Exception:
        ok = False
    return jsonify({
        "ok": ok,
        "db": "postgres" if DATABASE_URL else "sqlite",
        "commit": os.environ.get("RENDER_GIT_COMMIT", "dev")[:7],
    })


@app.route("/chat", methods=["POST", "OPTIONS"])
def chat():
    if request.method == "OPTIONS":
        return ("", 204)
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    role = (data.get("role") or "").strip()
    if not message:
        return jsonify({"error": "message 不能为空"}), 400
    if not role:
        return jsonify({"error": "role 不能为空"}), 400
    try:
        reply = ai_reply(message, role)
    except Exception as e:
        return jsonify({"error": f"AI 服务出错：{e}"}), 502
    return jsonify({"reply": reply})


def _fmt_time(value):
    """把数据库时间统一成 'YYYY-MM-DD HH:MM:SS'（UTC）。
    PostgreSQL 返回 datetime 对象（Flask 会序列化成英文 HTTP 日期），
    SQLite 返回 'YYYY-MM-DD HH:MM:SS' 字符串，这里统一成同一种格式。"""
    if value is None:
        return ""
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        return value.strftime("%Y-%m-%d %H:%M:%S")
    text = str(value)
    if len(text) >= 19 and text[4] == "-" and text[7] == "-":
        return text[:19].replace("T", " ")
    return text


def _parse_images(raw):
    """posts.images 存的是 JSON 数组字符串；老帖没这一列/为空时返回 []。"""
    if not raw:
        return []
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    return [u for u in value if isinstance(u, str) and u.strip()]


def _row_to_dict(row, reply_count=None):
    keys = row.keys()
    images = _parse_images(row["images"]) if "images" in keys else []
    cover = row["image_url"] or ""
    if not images and cover:
        # 兼容 2.2 之前只存了单张 image_url 的老帖
        images = [cover]
    if images:
        cover = images[0]
    return {
        "id": row["id"],
        "title": row["title"],
        "content": row["content"],
        "author": row["author"],
        "tags": row["tags"] or "",
        "image": cover,
        "images": images,
        "views": row["views"],
        "likes": row["likes"] if "likes" in keys else 0,
        "coins": row["coins"] if "coins" in keys else 0,
        "replies": reply_count if reply_count is not None else 0,
        "created_at": _fmt_time(row["created_at"]),
    }


@app.route("/api/posts", methods=["GET"])
def list_posts():
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS reply_count
               FROM posts p ORDER BY p.id DESC"""
        ).fetchall()
        return jsonify([_row_to_dict(r, r["reply_count"]) for r in rows])
    finally:
        conn.close()


@app.route("/api/posts", methods=["POST"])
@login_required
def create_post():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    content = (data.get("content") or "").strip()
    author = request.current_user["username"]
    tags = (data.get("tags") or "").strip()
    if not title:
        return jsonify({"error": "标题不能为空"}), 400
    if not content:
        return jsonify({"error": "内容不能为空"}), 400

    # 新前端传 images（Storage 公开 URL 数组）；老前端只传 image（单张 base64）
    images = []
    raw_images = data.get("images")
    if isinstance(raw_images, list):
        for url in raw_images:
            if not isinstance(url, str):
                continue
            url = url.strip()
            if not url:
                continue
            if not (url.startswith("https://") or url.startswith("http://")):
                return jsonify({"error": "图片地址不合法"}), 400
            if len(url) > 2048:
                return jsonify({"error": "图片地址太长"}), 400
            if url not in images:
                images.append(url)
    legacy = (data.get("image") or "").strip()
    legacy_single = False
    if not images and legacy:
        # 兼容旧缓存页面：仍接受单张 base64，但沿用旧上限，不写进 images 数组
        if len(legacy) > 2 * 1024 * 1024 * 1.4:
            return jsonify({"error": "图片太大"}), 400
        images = [legacy]
        legacy_single = True
    _, image_limit, _ = _user_level_and_limit(request.current_user)
    if len(images) > image_limit:
        return jsonify({"error": f"当前等级最多上传 {image_limit} 张图片"}), 400

    cover = images[0] if images else ""
    images_json = "" if (not images or legacy_single) else json.dumps(images, ensure_ascii=False)
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO posts (title, content, author, tags, image_url, images) VALUES (?, ?, ?, ?, ?, ?)",
            (title, content, author, tags, cover, images_json),
        )
        conn.commit()
        new_id = conn.max_id("posts")
        row = conn.execute("SELECT * FROM posts WHERE id=?", (new_id,)).fetchone()
        return jsonify(_row_to_dict(row, 0)), 201
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>", methods=["GET"])
def get_post(post_id):
    conn = get_db()
    try:
        exists = conn.execute("SELECT id FROM posts WHERE id=?", (post_id,)).fetchone()
        if not exists:
            return jsonify({"error": "帖子不存在"}), 404
        conn.execute("UPDATE posts SET views = COALESCE(views, 0) + 1 WHERE id=?", (post_id,))
        conn.commit()
        row = conn.execute(
            """SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS reply_count
               FROM posts p WHERE p.id=?""",
            (post_id,),
        ).fetchone()
        if not row:
            return jsonify({"error": "帖子不存在"}), 404
        return jsonify(_row_to_dict(row, row["reply_count"]))
    finally:
        conn.close()



@app.route("/api/users/<username>", methods=["GET"])
def user_profile(username):
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT id, username, is_admin, created_at FROM users WHERE username=?",
            (username,),
        ).fetchone()
        if not user:
            return jsonify({"error": "用户不存在"}), 404
        total = conn.execute(
            "SELECT COUNT(*) AS c FROM posts WHERE author=?", (username,)
        ).fetchone()["c"]
        rows = conn.execute(
            """SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS reply_count
               FROM posts p WHERE p.author=? ORDER BY p.id DESC LIMIT 20""",
            (username,),
        ).fetchall()
        level = 4 if (user["is_admin"] or 0) else _level_from_post_count(total)
        return jsonify({
            "user": {
                "id": user["id"],
                "username": user["username"],
                "is_admin": user["is_admin"] or 0,
                "level": level,
                "post_count": total,
                "created_at": _fmt_time(user["created_at"]),
            },
            "posts": [_row_to_dict(r, r["reply_count"]) for r in rows],
        })
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>", methods=["DELETE"])
@login_required
def delete_post(post_id):
    conn = get_db()
    try:
        row = conn.execute("SELECT author FROM posts WHERE id=?", (post_id,)).fetchone()
        if not row:
            return jsonify({"error": "帖子不存在"}), 404
        is_admin = request.current_user.get("is_admin")
        is_author = row["author"] == request.current_user["username"]
        if not is_admin and not is_author:
            return jsonify({"error": "只能删除自己的帖子或由管理员删除"}), 403
        conn.execute("DELETE FROM comments WHERE post_id=?", (post_id,))
        conn.execute("DELETE FROM posts WHERE id=?", (post_id,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/like", methods=["POST"])
@login_required
def toggle_like(post_id):
    data = request.get_json(silent=True) or {}
    on = bool(data.get("on"))
    conn = get_db()
    try:
        if not conn.execute("SELECT id FROM posts WHERE id=?", (post_id,)).fetchone():
            return jsonify({"error": "帖子不存在"}), 404
        if on:
            conn.execute("UPDATE posts SET likes = COALESCE(likes, 0) + 1 WHERE id=?", (post_id,))
        else:
            conn.execute(
                "UPDATE posts SET likes = CASE WHEN likes > 0 THEN likes - 1 ELSE 0 END WHERE id=?",
                (post_id,),
            )
        conn.commit()
        # commit 后 cursor 结果集清空，重新 SELECT 拿真实值
        row = conn.execute("SELECT likes FROM posts WHERE id=?", (post_id,)).fetchone()
        if not row:
            return jsonify({"error": "帖子不存在"}), 404
        return jsonify({"likes": row["likes"]})
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/coin", methods=["POST"])
@login_required
def toggle_coin(post_id):
    data = request.get_json(silent=True) or {}
    on = bool(data.get("on"))
    conn = get_db()
    try:
        if not conn.execute("SELECT id FROM posts WHERE id=?", (post_id,)).fetchone():
            return jsonify({"error": "帖子不存在"}), 404
        if on:
            conn.execute("UPDATE posts SET coins = COALESCE(coins, 0) + 1 WHERE id=?", (post_id,))
        else:
            conn.execute(
                "UPDATE posts SET coins = CASE WHEN coins > 0 THEN coins - 1 ELSE 0 END WHERE id=?",
                (post_id,),
            )
        conn.commit()
        row = conn.execute("SELECT coins FROM posts WHERE id=?", (post_id,)).fetchone()
        if not row:
            return jsonify({"error": "帖子不存在"}), 404
        return jsonify({"coins": row["coins"]})
    finally:
        conn.close()


_IMAGE_MIME_EXT = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
}


@app.route("/api/upload", methods=["POST"])
@login_required
def upload_image():
    if not (SUPABASE_URL and SUPABASE_KEY and SUPABASE_BUCKET):
        return jsonify({"error": "图片上传未配置"}), 503
    f = request.files.get("file")
    if not f:
        return jsonify({"error": "没有收到图片"}), 400
    mime = (f.mimetype or "").lower()
    ext = _IMAGE_MIME_EXT.get(mime)
    if not ext:
        return jsonify({"error": "只支持 JPG / PNG / WebP / GIF"}), 400
    blob = f.read(MAX_IMAGE_BYTES + 1)
    if not blob:
        return jsonify({"error": "图片为空"}), 400
    if len(blob) > MAX_IMAGE_BYTES:
        return jsonify({"error": "图片太大（单张上限 10MB）"}), 400

    uid = request.current_user["id"]
    path = f"posts/{uid}/{uuid.uuid4().hex}.{ext}"
    endpoint = f"{SUPABASE_URL}/storage/v1/object/{SUPABASE_BUCKET}/{path}"
    headers = {
        "Authorization": "Bearer " + SUPABASE_KEY,
        "apikey": SUPABASE_KEY,
        "Content-Type": mime,
        "x-upsert": "false",
    }
    try:
        resp = requests.post(endpoint, headers=headers, data=blob, timeout=30)
    except Exception as e:
        # 只记录异常类型，绝不回显连接串或密钥
        print(f"[上传] 请求 Storage 失败：{type(e).__name__}")
        return jsonify({"error": "图片上传失败，请稍后重试"}), 502
    if resp.status_code not in (200, 201):
        print(f"[上传] Storage 返回 {resp.status_code}: {resp.text[:200]}")
        return jsonify({"error": f"图片上传失败（Storage {resp.status_code}）"}), 502
    public_url = f"{SUPABASE_URL}/storage/v1/object/public/{SUPABASE_BUCKET}/{path}"
    return jsonify({"url": public_url}), 201


@app.route("/api/posts/<int:post_id>/comments", methods=["GET"])
def list_comments(post_id):
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM comments WHERE post_id=? ORDER BY id ASC", (post_id,)).fetchall()
        return jsonify([dict(r, created_at=_fmt_time(r["created_at"])) for r in rows])
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/comments", methods=["POST"])
@login_required
def create_comment(post_id):
    data = request.get_json(silent=True) or {}
    content = (data.get("content") or "").strip()
    author = request.current_user["username"]
    if not content:
        return jsonify({"error": "内容不能为空"}), 400
    conn = get_db()
    try:
        # 先确认帖子存在，顺便拿到作者和标题给通知用（也修掉对不存在帖子插孤儿评论的旧问题）
        post = conn.execute("SELECT title, author FROM posts WHERE id=?", (post_id,)).fetchone()
        if not post:
            return jsonify({"error": "帖子不存在"}), 404
        post_title = post["title"] or ""
        post_author = post["author"] or ""
        conn.execute(
            "INSERT INTO comments (post_id, author, content) VALUES (?, ?, ?)",
            (post_id, author, content),
        )
        new_id = conn.max_id("comments")
        # 通知帖子作者；自己评论自己的帖子不发
        if post_author and post_author != author:
            conn.execute(
                "INSERT INTO notifs (username, title, text) VALUES (?, ?, ?)",
                (post_author, "有人评论了你的帖子", f"{author} 评论了《{post_title}》"),
            )
        conn.commit()
        return jsonify({"id": new_id, "post_id": post_id, "author": author,
                        "content": content, "likes": 0, "created_at": "刚刚"}), 201
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/comments/<int:cid>", methods=["DELETE"])
@login_required
def delete_comment(post_id, cid):
    conn = get_db()
    try:
        row = conn.execute("SELECT author FROM comments WHERE id=? AND post_id=?", (cid, post_id,)).fetchone()
        if not row:
            return jsonify({"error": "评论不存在"}), 404
        is_admin = request.current_user.get("is_admin")
        is_author = row["author"] == request.current_user["username"]
        if not is_admin and not is_author:
            return jsonify({"error": "只能删除自己的评论或由管理员删除"}), 403
        conn.execute("DELETE FROM comments WHERE id=?", (cid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/api/notifs", methods=["GET"])
@login_required
def list_notifs():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, title, text, is_read, created_at FROM notifs WHERE username=? ORDER BY id DESC",
            (request.current_user["username"],),
        ).fetchall()
        notifs = [{
            "id": r["id"],
            "title": r["title"] or "",
            "text": r["text"] or "",
            "is_read": r["is_read"] or 0,
            "created_at": _fmt_time(r["created_at"]),
        } for r in rows]
        unread = sum(1 for n in notifs if not n["is_read"])
        return jsonify({"notifs": notifs, "unread": unread})
    finally:
        conn.close()


@app.route("/api/notifs/read", methods=["POST"])
@login_required
def read_notifs():
    conn = get_db()
    try:
        conn.execute("UPDATE notifs SET is_read=1 WHERE username=?", (request.current_user["username"],))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/api/tags", methods=["GET"])
def list_tags():
    conn = get_db()
    try:
        rows = conn.execute("SELECT tags FROM posts WHERE tags IS NOT NULL AND tags != ''").fetchall()
        counter = {}
        for r in rows:
            for t in (r["tags"] or "").split(","):
                t = t.strip()
                if t:
                    counter[t] = counter.get(t, 0) + 1
        result = sorted(counter.items(), key=lambda x: -x[1])
        return jsonify([{"name": t, "count": c} for t, c in result])
    finally:
        conn.close()


@app.route("/api/admin/stats", methods=["GET"])
@admin_required
def admin_stats():
    conn = get_db()
    try:
        # 注意：PostgreSQL 的 RealDictCursor 返回字典，不能用 [0] 取下标，统一用列别名 + 键访问
        user_count = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()["c"]
        post_count = conn.execute("SELECT COUNT(*) AS c FROM posts").fetchone()["c"]
        comment_count = conn.execute("SELECT COUNT(*) AS c FROM comments").fetchone()["c"]
        return jsonify({"users": user_count, "posts": post_count, "comments": comment_count})
    finally:
        conn.close()


@app.route("/api/admin/users", methods=["GET"])
@admin_required
def admin_users():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, username, email, is_admin, created_at FROM users ORDER BY id"
        ).fetchall()
        return jsonify([dict(r, created_at=_fmt_time(r["created_at"])) for r in rows])
    finally:
        conn.close()


@app.route("/api/admin/users/<int:uid>", methods=["DELETE"])
@admin_required
def admin_delete_user(uid):
    current = request.current_user
    if uid == current["id"]:
        return jsonify({"error": "不能删除自己"}), 400
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not user:
            return jsonify({"error": "用户不存在"}), 404
        # 级联删除该用户的帖子和评论（简化处理）
        conn.execute("DELETE FROM comments WHERE author IN (SELECT username FROM users WHERE id=?)", (uid,))
        conn.execute("DELETE FROM posts WHERE author=(SELECT username FROM users WHERE id=?)", (uid,))
        conn.execute("DELETE FROM users WHERE id=?", (uid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/")
def home():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def frontend_files(path):
    return send_from_directory(FRONTEND_DIR, path)


def _migrate():
    conn = get_db()
    try:
        # 先建表（PostgreSQL 用）
        is_pg = bool(DATABASE_URL)
        if is_pg:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    id SERIAL PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    email TEXT DEFAULT '',
                    password TEXT NOT NULL,
                    is_admin INTEGER DEFAULT 0,
                    token TEXT DEFAULT '',
                    token_expires INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS posts (
                    id SERIAL PRIMARY KEY,
                    title TEXT NOT NULL,
                    content TEXT DEFAULT '',
                    author TEXT NOT NULL,
                    image_url TEXT DEFAULT '',
                    images TEXT DEFAULT '',
                    tags TEXT DEFAULT '',
                    likes INTEGER DEFAULT 0,
                    coins INTEGER DEFAULT 0,
                    views INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS comments (
                    id SERIAL PRIMARY KEY,
                    post_id INTEGER NOT NULL,
                    author TEXT NOT NULL,
                    content TEXT NOT NULL,
                    likes INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS notifs (
                    id SERIAL PRIMARY KEY,
                    username TEXT NOT NULL,
                    title TEXT DEFAULT '',
                    text TEXT DEFAULT '',
                    is_read INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()
        else:
            # SQLite 分支：已存在的 school_posts.db 不会有 notifs 表，这里幂等补建
            conn.execute("""
                CREATE TABLE IF NOT EXISTS notifs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    title TEXT DEFAULT '',
                    text TEXT DEFAULT '',
                    is_read INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()

        # 自动补列（兼容 SQLite 和 PostgreSQL）：老库缺哪列就补哪列
        text_cols = {"tags", "email", "token", "image_url", "images"}
        col_sets = {}
        for table, cols in [
            ("posts", ["tags", "likes", "coins", "image_url", "images"]),
            ("comments", ["likes"]),
            ("users", ["email", "is_admin", "token", "token_expires"]),
        ]:
            if is_pg:
                existing = [r["column_name"] for r in conn.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_name=%s", (table,)
                ).fetchall()]
            else:
                existing = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
            col_sets[table] = set(existing)
            for col in cols:
                if col not in existing:
                    coltype = "TEXT DEFAULT ''" if col in text_cols else "INTEGER DEFAULT 0"
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}")
                    print(f"[迁移] 已给 {table} 表加上 {col} 列")

            # 修复：PostgreSQL 里如果 token 列被错误建成 INTEGER，删掉重建为 TEXT
            if is_pg and table == "users" and "token" in existing:
                col_type = conn.execute(
                    "SELECT data_type FROM information_schema.columns WHERE table_name=%s AND column_name='token'",
                    (table,)
                ).fetchone()
                if col_type and col_type["data_type"] == "integer":
                    conn.execute("ALTER TABLE users DROP COLUMN token")
                    conn.execute("ALTER TABLE users ADD COLUMN token TEXT DEFAULT ''")
                    print("[迁移] 已重建 users.token 列为 TEXT")
        conn.commit()

        # 兼容老库：帖子配图列曾叫 image，把内容搬到新列 image_url（旧列保留不动）
        if "image" in col_sets.get("posts", set()):
            try:
                moved = conn.execute(
                    "UPDATE posts SET image_url=image "
                    "WHERE (image_url IS NULL OR image_url='') AND image IS NOT NULL AND image<>''"
                ).rowcount
                conn.commit()
                if moved:
                    print(f"[迁移] 已把 {moved} 条帖子的旧 image 列内容迁到 image_url")
            except Exception as e:
                print(f"[迁移] 旧 image 列迁移跳过：{e}")

        # 常用查询加索引（幂等，SQLite / PostgreSQL 都支持）
        for ddl in (
            "CREATE INDEX IF NOT EXISTS idx_users_token ON users(token)",
            "CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)",
        ):
            try:
                conn.execute(ddl)
            except Exception as e:
                print(f"[迁移] 建索引跳过：{e}")
        conn.commit()

        # 清理旧种子帖子
        seed_titles = (
            "欢迎来到 YWIES 论坛",
            "CCA 招新｜机器人组还差一个机械臂手",
            "三楼食堂今天的麻辣香锅绝了",
            "有人来换越狱牌吗",
            "距离阿哈出世还有最后1天",
        )
        placeholders = ",".join("?" for _ in seed_titles)
        deleted = conn.execute(f"DELETE FROM posts WHERE title IN ({placeholders})", seed_titles).rowcount
        if deleted:
            conn.commit()
            print(f"[迁移] 已清理 {deleted} 条旧种子测试帖子")

        # 管理员初始化 / 同步
        admin_email = os.getenv("ADMIN_EMAIL", "admin@ywies.local")
        admin_password = os.getenv("ADMIN_PASSWORD", "admin123")
        admin_row = conn.execute("SELECT id, email FROM users WHERE is_admin=1").fetchone()
        if not admin_row:
            pwd_hash = generate_password_hash(admin_password)
            conn.execute(
                "INSERT INTO users (email, username, password, is_admin) VALUES (?, ?, ?, 1)",
                (admin_email, "管理员", pwd_hash),
            )
            conn.commit()
            print(f"[初始化] 管理员账号已创建：{admin_email}（密码见 ADMIN_PASSWORD 环境变量）")
        else:
            pwd_hash = generate_password_hash(admin_password)
            conn.execute(
                "UPDATE users SET email=?, password=? WHERE id=?",
                (admin_email, pwd_hash, admin_row["id"]),
            )
            conn.commit()
            if admin_row["email"] != admin_email:
                print(f"[更新] 管理员邮箱已改为：{admin_email}")
            print(f"[同步] 管理员密码已按环境变量更新")
    finally:
        conn.close()


if __name__ == "__main__":
    if not DATABASE_URL and not os.path.exists(DB_PATH):
        print("[提示] 数据库不存在，正在自动初始化...")
        from db_init import create_tables
        create_tables()
    print("[数据库] 使用 PostgreSQL（云端）" if DATABASE_URL else "[数据库] 使用本地 SQLite")
    _migrate()
    # 线上默认关闭调试器（Werkzeug 调试页会暴露源码与执行入口）；本地设 FLASK_DEBUG=1 才开
    debug_mode = os.getenv("FLASK_DEBUG", "").strip() in ("1", "true", "True") and not DATABASE_URL
    port = int(os.getenv("PORT", "5000"))
    if debug_mode:
        app.run(host="0.0.0.0", port=port, debug=True)
    else:
        # 生产环境用 Waitress（多线程 WSGI），不再使用 Flask/Werkzeug 开发服务器
        from waitress import serve
        print(f"[启动] Waitress 生产 WSGI，端口 {port}，线程 6")
        serve(app, host="0.0.0.0", port=port, threads=6)
