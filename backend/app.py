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

import base64
import io
import json
import os
import re
import sqlite3
from datetime import datetime, timezone, timedelta
import secrets
import time
import uuid
from functools import wraps

import bleach
import markdown as markdown_lib
import psycopg2
import psycopg2.extras
import requests
from flask import Flask, request, jsonify, send_from_directory, send_file, redirect
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
SESSION_TTL = 30 * 24 * 3600  # 登录态 30 天


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
    if request.path.startswith("/api/"):
        # 接口不能被平板/浏览器缓存，否则会看到旧的空列表
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["Vary"] = "Authorization"
    elif request.path.startswith("/media/"):
        # 历史图片走可缓存地址，首次加载后浏览器直接复用
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif resp.mimetype == "text/html":
        # HTML 每次回源校验，保证拿到最新静态资源版本号
        resp.headers["Cache-Control"] = "no-cache"
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
            "SELECT u.id, u.email, u.username, u.is_admin, u.coins, u.display_name, u.bio, u.avatar, u.banner, "
            "u.likes_public, u.bookmarks_public FROM sessions s "
            "JOIN users u ON u.username = s.username "
            "WHERE s.token=? AND s.expires>?",
            (token, time.time()),
        ).fetchone()
        if not row:
            # 兼容旧 token（users.token 单列），迁移后会自动复制进 sessions
            row = conn.execute(
                "SELECT id, email, username, is_admin, coins, display_name, bio, avatar, banner, "
                "likes_public, bookmarks_public FROM users WHERE token=? AND token_expires>?",
                (token, time.time()),
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
        today = _today_shanghai()
        conn.execute(
            "INSERT INTO users (email, username, password, is_admin, coins, last_daily_coin, display_name) "
            "VALUES (?, ?, ?, 0, 10, ?, ?)",
            (fake_email, username, pwd_hash, today, username),
        )
        conn.commit()
        token = secrets.token_urlsafe(32)
        expires = time.time() + SESSION_TTL
        # 按用户名写登录态，不依赖自增 ID（PG 下 cursor.lastrowid 取不到值）
        conn.execute(
            "UPDATE users SET token=?, token_expires=? WHERE username=?",
            (token, expires, username)
        )
        conn.execute(
            "INSERT INTO sessions (token, username, expires) VALUES (?, ?, ?)",
            (token, username, expires),
        )
        conn.execute("DELETE FROM sessions WHERE expires<=?", (time.time(),))
        conn.commit()
        user_id = conn.last_id_by_key("users", "username", username)
    except sqlite3.IntegrityError:
        return jsonify({"error": "这个昵称已经被注册了"}), 400
    finally:
        conn.close()
    return jsonify({"token": token, "user": {"id": user_id, "email": fake_email, "username": username,
                                             "is_admin": 0, "coins": 10, "display_name": username,
                                             "bio": "", "avatar": "", "banner": "",
                                             "likes_public": 0, "bookmarks_public": 0}})


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
        # 管理员也可以用邮箱登录（例如 admin@ywies.local）
        if not row and "@" in username:
            row = conn.execute(
                "SELECT * FROM users WHERE LOWER(email)=LOWER(?) ORDER BY is_admin DESC, id LIMIT 1",
                (username,),
            ).fetchone()
        if not row:
            return jsonify({"error": "昵称或密码不对"}), 401
        if not check_password_hash(row["password"], password):
            return jsonify({"error": "昵称或密码不对"}), 401
        coins = _claim_daily_coins(conn, row["id"])
        token = secrets.token_urlsafe(32)
        expires = time.time() + SESSION_TTL
        conn.execute(
            "UPDATE users SET token=?, token_expires=? WHERE id=?",
            (token, expires, row["id"])
        )
        conn.execute(
            "INSERT INTO sessions (token, username, expires) VALUES (?, ?, ?)",
            (token, row["username"], expires),
        )
        conn.execute("DELETE FROM sessions WHERE expires<=?", (time.time(),))
        conn.commit()
        return jsonify({
            "token": token,
            "user": {"id": row["id"], "email": row["email"], "username": row["username"],
                     "is_admin": row["is_admin"], "coins": coins,
                     "display_name": row["display_name"] or row["username"],
                     "bio": row["bio"] or "", "avatar": row["avatar"] or "",
                     "banner": row["banner"] or "",
                     "likes_public": row["likes_public"] or 0,
                     "bookmarks_public": row["bookmarks_public"] or 0}
        })
    finally:
        conn.close()


@app.route("/api/me", methods=["GET"])
def me():
    user = _get_current_user()
    if not user:
        return jsonify({"error": "未登录"}), 401
    level, image_limit, post_count = _user_level_and_limit(user)
    conn = get_db()
    try:
        coins = _claim_daily_coins(conn, user["id"])
    finally:
        conn.close()
    data = dict(user)
    data.update({"level": level, "max_post_images": image_limit, "post_count": post_count, "coins": coins})
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


SHANGHAI_TZ = timezone(timedelta(hours=8))
_EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _parse_utc(value):
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _relative_time_labels(value):
    """非管理员看到的相对时间：刚刚/N分钟前/N小时前/N天前，超过29天只给日期。"""
    dt = _parse_utc(value)
    if not dt:
        return "", ""
    now = datetime.now(timezone.utc)
    diff = max(0, int((now - dt).total_seconds()))
    if diff < 60:
        return "刚刚", "Just now"
    if diff < 3600:
        n = diff // 60
        return f"{n}分钟前", f"{n} min ago"
    if diff < 86400:
        n = diff // 3600
        return f"{n}小时前", f"{n} hr ago"
    if diff < 30 * 86400:
        n = diff // 86400
        return f"{n}天前", f"{n} day ago" if n == 1 else f"{n} days ago"
    local = dt.astimezone(SHANGHAI_TZ)
    now_local = now.astimezone(SHANGHAI_TZ)
    month = _EN_MONTHS[local.month - 1]
    if local.year != now_local.year:
        return f"{local.year}年{local.month}月{local.day}日", f"{month} {local.day}, {local.year}"
    return f"{local.month}月{local.day}日", f"{month} {local.day}"


def _time_fields(value, viewer_admin=False, key="created_at"):
    zh, en = _relative_time_labels(value)
    return {
        key: _fmt_time(value) if viewer_admin else "",
        key + "_zh": zh,
        key + "_en": en,
    }


def _log_audit(conn, action, actor, target_type, target_id, post_id=0, content=""):
    """记录删除等管理动作，保留内容快照，供管理员事后调查。"""
    try:
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False)
        conn.execute(
            "INSERT INTO audit_log (action, actor, target_type, target_id, post_id, content) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (action, actor or "", target_type or "", int(target_id or 0), int(post_id or 0), content or ""),
        )
    except Exception as e:
        print(f"[审计] 写入失败：{e}")


def _today_shanghai():
    return datetime.now(SHANGHAI_TZ).date().isoformat()


def _claim_daily_coins(conn, user_id):
    """每天首次登录/打开网站发 3 币；当天只发一次，不发通知。"""
    row = conn.execute(
        "SELECT coins, last_daily_coin FROM users WHERE id=?", (user_id,)
    ).fetchone()
    if not row:
        return 0
    coins = row["coins"] or 0
    today = _today_shanghai()
    last = row["last_daily_coin"] or ""
    if not last:
        conn.execute("UPDATE users SET last_daily_coin=? WHERE id=?", (today, user_id))
        conn.commit()
        return coins
    if last >= today:
        return coins
    cur = conn.execute(
        "UPDATE users SET coins=COALESCE(coins, 0)+3, last_daily_coin=? "
        "WHERE id=? AND last_daily_coin=?",
        (today, user_id, last),
    )
    conn.commit()
    if cur.rowcount > 0:
        return coins + 3
    row = conn.execute("SELECT coins FROM users WHERE id=?", (user_id,)).fetchone()
    return (row["coins"] if row and row["coins"] is not None else coins)


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


_MD_TAGS = [
    "p", "br", "strong", "em", "del", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "pre", "code", "hr", "a", "img",
    "table", "thead", "tbody", "tr", "th", "td", "sup", "sub",
]
_MD_ATTRS = {
    "a": ["href", "title", "target", "rel"],
    "img": ["src", "alt", "title"],
    "code": ["class"],
    "th": ["align"],
    "td": ["align"],
}


def _render_markdown(text):
    html = markdown_lib.markdown(
        text or "",
        extensions=["extra", "sane_lists", "nl2br"],
        output_format="html",
    )
    cleaned = bleach.clean(
        html,
        tags=_MD_TAGS,
        attributes=_MD_ATTRS,
        protocols=["http", "https", "mailto"],
        strip=True,
    )
    return cleaned


def _row_to_dict(row, reply_count=None, liked=False, coined=False, viewer_admin=False):
    keys = row.keys()
    images = _parse_images(row["images"]) if "images" in keys else []
    cover = row["image_url"] or ""
    if not images and cover:
        # 兼容 2.2 之前只存了单张 image_url 的老帖
        images = [cover]
    has_image = bool(images or cover)

    # 历史 base64 图片不放进 JSON（否则列表/详情一次几 MB），
    # 改成一个可缓存的图片地址，浏览器按需加载。
    normalized = []
    for u in images:
        if u[:5].lower() == "data:":
            u = f"/media/posts/{row['id']}"
        if u not in normalized:
            normalized.append(u)
    images = normalized
    cover = images[0] if images else ""
    return {
        "id": row["id"],
        "title": row["title"],
        "content": row["content"],
        "author": row["author"],
        "tags": row["tags"] or "",
        "board": (row["board"] if "board" in keys else "general") or "general",
        "kind": (row["kind"] if "kind" in keys else "post") or "post",
        "format": (row["format"] if "format" in keys else "plain") or "plain",
        "music_artist": (row["music_artist"] if "music_artist" in keys else "") or "",
        "music_url": (row["music_url"] if "music_url" in keys else "") or "",
        "content_html": _render_markdown(row["content"]) if (("format" in keys and row["format"] == "markdown")) else "",
        "image": cover,
        "images": images,
        "has_image": has_image,
        "views": row["views"],
        "likes": row["likes"] if "likes" in keys else 0,
        "coins": row["coins"] if "coins" in keys else 0,
        "liked": bool(liked),
        "coined": bool(coined),
        "replies": reply_count if reply_count is not None else 0,
        **_time_fields(row["created_at"], viewer_admin),
    }


@app.route("/api/logout", methods=["POST"])
def logout():
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:].strip()
        conn = get_db()
        try:
            conn.execute("DELETE FROM sessions WHERE token=?", (token,))
            conn.execute(
                "UPDATE users SET token='', token_expires=0 WHERE token=?", (token,)
            )
            conn.commit()
        finally:
            conn.close()
    return jsonify({"ok": True})


BOARDS = {
    "general": "灌水",
    "study": "学习",
    "music": "音乐",
    "poll": "投票",
    "share": "分享",
}


def _normalize_board(value):
    value = (value or "").strip()
    return value if value in BOARDS else "general"


def _poll_payload(conn, post_id, viewer):
    poll = conn.execute(
        "SELECT id, question, closed FROM polls WHERE post_id=?", (post_id,)
    ).fetchone()
    if not poll:
        return None
    rows = conn.execute(
        """SELECT o.id, o.text, o.position,
                  (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id=o.id) AS count
           FROM poll_options o WHERE o.poll_id=? ORDER BY o.position, o.id""",
        (poll["id"],),
    ).fetchall()
    total = conn.execute(
        "SELECT COUNT(*) AS c FROM poll_votes WHERE poll_id=?", (poll["id"],)
    ).fetchone()["c"]
    my_option = 0
    if viewer:
        mine = conn.execute(
            "SELECT option_id FROM poll_votes WHERE poll_id=? AND username=?",
            (poll["id"], viewer),
        ).fetchone()
        my_option = mine["option_id"] if mine else 0
    return {
        "id": poll["id"],
        "question": poll["question"] or "",
        "closed": bool(poll["closed"]),
        "total": total,
        "my_option_id": my_option,
        "options": [{
            "id": r["id"], "text": r["text"] or "",
            "count": r["count"] or 0,
            "percent": round((r["count"] or 0) * 100 / total, 1) if total else 0,
        } for r in rows],
    }


def _bookmarked_ids(conn, username, post_ids):
    if not username or not post_ids:
        return set()
    placeholders = ",".join("?" for _ in post_ids)
    rows = conn.execute(
        "SELECT post_id FROM bookmarks WHERE username=? AND post_id IN (" + placeholders + ")",
        tuple([username] + list(post_ids)),
    ).fetchall()
    return {r["post_id"] for r in rows}


@app.route("/api/posts", methods=["GET"])
def list_posts():
    viewer = _get_current_user()
    viewer_admin = bool(viewer and viewer.get("is_admin"))
    viewer_name = viewer["username"] if viewer else ""
    board = (request.args.get("board") or "").strip()
    where = ""
    params = []
    if board and board != "all":
        board = _normalize_board(board)
        where = "WHERE p.board=?"
        params = [board]
    conn = get_db()
    try:
        rows = conn.execute(
            """SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS reply_count
               FROM posts p """ + where + " ORDER BY p.id DESC",
            tuple(params),
        ).fetchall()
        bookmarked = _bookmarked_ids(conn, viewer_name, [r["id"] for r in rows])
        out = []
        for r in rows:
            item = _row_to_dict(r, r["reply_count"], viewer_admin=viewer_admin)
            item["bookmarked"] = r["id"] in bookmarked
            if item.get("kind") == "poll":
                item["poll"] = _poll_payload(conn, r["id"], viewer_name)
            out.append(item)
        return jsonify(out)
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/vote", methods=["POST"])
@login_required
def vote_poll(post_id):
    data = request.get_json(silent=True) or {}
    try:
        option_id = int(data.get("option_id") or 0)
    except (TypeError, ValueError):
        option_id = 0
    me = request.current_user["username"]
    conn = get_db()
    try:
        poll = conn.execute(
            "SELECT id, closed FROM polls WHERE post_id=?", (post_id,)
        ).fetchone()
        if not poll:
            return jsonify({"error": "投票不存在"}), 404
        if poll["closed"]:
            return jsonify({"error": "投票已结束"}), 400
        option = conn.execute(
            "SELECT id FROM poll_options WHERE id=? AND poll_id=?",
            (option_id, poll["id"]),
        ).fetchone()
        if not option:
            return jsonify({"error": "选项不存在"}), 400
        cur = conn.execute(
            "INSERT INTO poll_votes (poll_id, option_id, username) VALUES (?, ?, ?) "
            "ON CONFLICT (poll_id, username) DO NOTHING",
            (poll["id"], option_id, me),
        )
        if cur.rowcount == 0:
            return jsonify({"error": "你已经投过票了"}), 400
        conn.commit()
        return jsonify({"ok": True, "poll": _poll_payload(conn, post_id, me)})
    finally:
        conn.close()


@app.route("/api/posts", methods=["POST"])
@login_required
def create_post():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    content = (data.get("content") or "").strip()
    author = request.current_user["username"]
    board = _normalize_board(data.get("board") or "general")
    requested_kind = (data.get("kind") or "").strip()
    if board == "poll":
        kind = "poll"
    elif board in ("study", "share"):
        kind = "poll" if requested_kind == "poll" else "note"
    elif board == "music":
        kind = "poll" if requested_kind == "poll" else "music"
    else:
        kind = "poll" if requested_kind == "poll" else "post"
    if kind not in ("post", "poll", "note", "music"):
        kind = "post"
    post_format = "markdown" if kind == "note" else "plain"
    music_artist = (data.get("music_artist") or "").strip()[:100]
    music_url = (data.get("music_url") or "").strip()
    raw_tags = (data.get("tags") or "").strip()
    tags_list = []
    for t in raw_tags.split(","):
        t = t.strip().lstrip("#").strip()[:30]
        if t and t not in tags_list:
            tags_list.append(t)
    tags = ",".join(tags_list)
    if not title:
        return jsonify({"error": "标题不能为空"}), 400
    if kind not in ("poll", "music") and not content:
        return jsonify({"error": "内容不能为空"}), 400
    if kind == "music":
        if not music_artist:
            return jsonify({"error": "请填写歌手"}), 400
        if not music_url or not (music_url.startswith("https://") or music_url.startswith("http://")):
            return jsonify({"error": "请填写合法的音乐外链"}), 400
        if len(music_url) > 2048:
            return jsonify({"error": "音乐外链太长"}), 400

    poll_options = []
    if kind == "poll":
        raw_options = data.get("poll_options")
        if not isinstance(raw_options, list):
            return jsonify({"error": "投票至少需要两个选项"}), 400
        for opt in raw_options:
            text = (opt or "").strip()[:200] if isinstance(opt, str) else ""
            if text and text not in poll_options:
                poll_options.append(text)
        if len(poll_options) < 2:
            return jsonify({"error": "投票至少需要两个选项"}), 400
        if len(poll_options) > 6:
            return jsonify({"error": "投票最多六个选项"}), 400

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
            "INSERT INTO posts (title, content, author, tags, image_url, images, board, kind, format, music_artist, music_url) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (title, content, author, tags, cover, images_json, board, kind, post_format, music_artist, music_url),
        )
        new_id = conn.max_id("posts")
        if kind == "poll":
            conn.execute(
                "INSERT INTO polls (post_id, question) VALUES (?, ?)", (new_id, title)
            )
            poll_id = conn.max_id("polls")
            for pos, opt in enumerate(poll_options):
                conn.execute(
                    "INSERT INTO poll_options (poll_id, text, position) VALUES (?, ?, ?)",
                    (poll_id, opt, pos),
                )
        conn.commit()
        row = conn.execute("SELECT * FROM posts WHERE id=?", (new_id,)).fetchone()
        item = _row_to_dict(row, 0, viewer_admin=bool(request.current_user.get("is_admin")))
        item["bookmarked"] = False
        if kind == "poll":
            item["poll"] = _poll_payload(conn, new_id, author)
        return jsonify(item), 201
    finally:
        conn.close()


@app.route("/api/markdown/preview", methods=["POST"])
@login_required
def markdown_preview():
    data = request.get_json(silent=True) or {}
    content = (data.get("content") or "")[:30000]
    return jsonify({"html": _render_markdown(content)})


@app.route("/api/posts/<int:post_id>", methods=["GET"])
def get_post(post_id):
    user = _get_current_user()
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
        liked = False
        coined = False
        if user:
            liked = conn.execute(
                "SELECT 1 AS x FROM post_likes WHERE post_id=? AND username=?",
                (post_id, user["username"]),
            ).fetchone() is not None
            coined = conn.execute(
                "SELECT 1 AS x FROM post_coins WHERE post_id=? AND username=?",
                (post_id, user["username"]),
            ).fetchone() is not None
        item = _row_to_dict(row, row["reply_count"], liked=liked, coined=coined,
                            viewer_admin=bool(user and user.get("is_admin")))
        item["bookmarked"] = bool(user and conn.execute(
            "SELECT 1 AS x FROM bookmarks WHERE username=? AND post_id=?",
            (user["username"], post_id),
        ).fetchone())
        if item.get("kind") == "poll":
            item["poll"] = _poll_payload(conn, post_id, user["username"] if user else "")
        return jsonify(item)
    finally:
        conn.close()



@app.route("/api/users/<username>", methods=["GET"])
def user_profile(username):
    viewer = _get_current_user()
    viewer_admin = bool(viewer and viewer.get("is_admin"))
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT id, username, display_name, bio, avatar, banner, is_admin, "
            "likes_public, bookmarks_public, created_at FROM users WHERE username=?",
            (username,),
        ).fetchone()
        if not user:
            return jsonify({"error": "用户不存在"}), 404
        total = conn.execute(
            "SELECT COUNT(*) AS c FROM posts WHERE author=?", (username,)
        ).fetchone()["c"]
        comments_count = conn.execute(
            "SELECT COUNT(*) AS c FROM comments WHERE author=?", (username,)
        ).fetchone()["c"]
        likes_total = conn.execute(
            "SELECT COALESCE(SUM(likes), 0) AS c FROM posts WHERE author=?", (username,)
        ).fetchone()["c"]
        following_count = conn.execute(
            "SELECT COUNT(*) AS c FROM follows WHERE follower=?", (username,)
        ).fetchone()["c"]
        followers_count = conn.execute(
            "SELECT COUNT(*) AS c FROM follows WHERE following=?", (username,)
        ).fetchone()["c"]
        is_following = False
        if viewer:
            is_following = conn.execute(
                "SELECT 1 AS x FROM follows WHERE follower=? AND following=?",
                (viewer["username"], username),
            ).fetchone() is not None
        is_self = bool(viewer and viewer["username"] == username)
        can_view_likes = is_self or bool(user["likes_public"])
        can_view_bookmarks = is_self or bool(user["bookmarks_public"])
        liked_count = conn.execute(
            "SELECT COUNT(*) AS c FROM post_likes l JOIN posts p ON p.id=l.post_id WHERE l.username=?",
            (username,),
        ).fetchone()["c"] if can_view_likes else None
        bookmarked_count = conn.execute(
            "SELECT COUNT(*) AS c FROM bookmarks b JOIN posts p ON p.id=b.post_id WHERE b.username=?",
            (username,),
        ).fetchone()["c"] if can_view_bookmarks else None
        rows = conn.execute(
            """SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS reply_count
               FROM posts p WHERE p.author=? ORDER BY p.id DESC LIMIT 500""",
            (username,),
        ).fetchall()
        post_items = []
        for r in rows:
            item = _row_to_dict(r, r["reply_count"], viewer_admin=viewer_admin)
            if item.get("kind") == "poll":
                item["poll"] = _poll_payload(conn, r["id"], viewer["username"] if viewer else "")
            post_items.append(item)
        level = 4 if (user["is_admin"] or 0) else _level_from_post_count(total)
        return jsonify({
            "user": {
                "id": user["id"],
                "username": user["username"],
                "display_name": user["display_name"] or user["username"],
                "bio": user["bio"] or "",
                "avatar": user["avatar"] or "",
                "banner": user["banner"] or "",
                "is_admin": user["is_admin"] or 0,
                "level": level,
                "post_count": total,
                "comments_count": comments_count,
                "likes_total": likes_total,
                "following_count": following_count,
                "followers_count": followers_count,
                "is_following": is_following,
                "is_self": is_self,
                "likes_public": bool(user["likes_public"]),
                "bookmarks_public": bool(user["bookmarks_public"]),
                "liked_count": liked_count,
                "bookmarked_count": bookmarked_count,
                **_time_fields(user["created_at"], viewer_admin),
            },
            "posts": post_items,
        })
    finally:
        conn.close()


def _profile_saved_posts(username, typ):
    viewer = _get_current_user()
    viewer_name = viewer["username"] if viewer else ""
    viewer_admin = bool(viewer and viewer.get("is_admin"))
    conn = get_db()
    try:
        target = conn.execute(
            "SELECT username, likes_public, bookmarks_public FROM users WHERE username=?",
            (username,),
        ).fetchone()
        if not target:
            return jsonify({"error": "用户不存在"}), 404
        is_self = viewer_name == username
        public = bool(target["likes_public"] if typ == "likes" else target["bookmarks_public"])
        if not is_self and not public:
            return jsonify({"error": "该列表未公开"}), 403
        if typ == "likes":
            join = "JOIN post_likes x ON x.post_id=p.id"
            cond = "x.username=?"
            order = "x.created_at DESC, p.id DESC"
        else:
            join = "JOIN bookmarks x ON x.post_id=p.id"
            cond = "x.username=?"
            order = "x.created_at DESC, p.id DESC"
        rows = conn.execute(
            "SELECT p.*, (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS reply_count "
            "FROM posts p " + join + " WHERE " + cond + " ORDER BY " + order + " LIMIT 200",
            (username,),
        ).fetchall()
        total = conn.execute(
            "SELECT COUNT(*) AS c FROM posts p " + join + " WHERE " + cond,
            (username,),
        ).fetchone()["c"]
        bookmarked = _bookmarked_ids(conn, viewer_name, [r["id"] for r in rows])
        out = []
        for r in rows:
            item = _row_to_dict(r, r["reply_count"], viewer_admin=viewer_admin)
            item["bookmarked"] = r["id"] in bookmarked
            if item.get("kind") == "poll":
                item["poll"] = _poll_payload(conn, r["id"], viewer_name)
            out.append(item)
        return jsonify({"posts": out, "total": total, "is_self": is_self, "public": public})
    finally:
        conn.close()


@app.route("/api/users/<username>/likes", methods=["GET"])
def user_liked_posts(username):
    return _profile_saved_posts(username, "likes")


@app.route("/api/users/<username>/bookmarks", methods=["GET"])
def user_bookmarked_posts(username):
    return _profile_saved_posts(username, "bookmarks")


@app.route("/api/users/<username>/follow", methods=["POST"])
@login_required
def follow_user(username):
    me = request.current_user["username"]
    if username == me:
        return jsonify({"error": "不能关注自己"}), 400
    data = request.get_json(silent=True) or {}
    on = bool(data.get("on"))
    conn = get_db()
    try:
        target = conn.execute("SELECT username FROM users WHERE username=?", (username,)).fetchone()
        if not target:
            return jsonify({"error": "用户不存在"}), 404
        if on:
            conn.execute(
                "INSERT INTO follows (follower, following) VALUES (?, ?) "
                "ON CONFLICT (follower, following) DO NOTHING",
                (me, username),
            )
        else:
            conn.execute(
                "DELETE FROM follows WHERE follower=? AND following=?", (me, username)
            )
        conn.commit()
        following_count = conn.execute(
            "SELECT COUNT(*) AS c FROM follows WHERE follower=?", (username,)
        ).fetchone()["c"]
        followers_count = conn.execute(
            "SELECT COUNT(*) AS c FROM follows WHERE following=?", (username,)
        ).fetchone()["c"]
        return jsonify({
            "ok": True,
            "is_following": on,
            "following_count": following_count,
            "followers_count": followers_count,
        })
    finally:
        conn.close()


@app.route("/api/users/<username>/connections", methods=["GET"])
def user_connections(username):
    typ = request.args.get("type", "following")
    if typ not in ("following", "followers"):
        return jsonify({"error": "type 只能是 following 或 followers"}), 400
    viewer = _get_current_user()
    conn = get_db()
    try:
        if not conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone():
            return jsonify({"error": "用户不存在"}), 404
        if typ == "followers":
            rows = conn.execute(
                "SELECT u.username, u.display_name, u.avatar FROM follows f "
                "JOIN users u ON u.username=f.follower WHERE f.following=? ORDER BY f.id DESC LIMIT 500",
                (username,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT u.username, u.display_name, u.avatar FROM follows f "
                "JOIN users u ON u.username=f.following WHERE f.follower=? ORDER BY f.id DESC LIMIT 500",
                (username,),
            ).fetchall()
        following_set = set()
        if viewer:
            following_set = {
                r["following"] for r in conn.execute(
                    "SELECT following FROM follows WHERE follower=?", (viewer["username"],)
                ).fetchall()
            }
        return jsonify({
            "type": typ,
            "users": [{
                "username": r["username"],
                "display_name": r["display_name"] or r["username"],
                "avatar": r["avatar"] or "",
                "is_following": r["username"] in following_set,
                "is_self": bool(viewer and viewer["username"] == r["username"]),
            } for r in rows],
        })
    finally:
        conn.close()


@app.route("/api/follows", methods=["GET"])
@login_required
def list_follows():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT following FROM follows WHERE follower=? ORDER BY id DESC",
            (request.current_user["username"],),
        ).fetchall()
        return jsonify({"following": [r["following"] for r in rows]})
    finally:
        conn.close()


def _extract_mentions(conn, content):
    """从评论内容中找出真实存在的 @用户名。"""
    text = content or ""
    if "@" not in text:
        return []
    rows = conn.execute("SELECT username FROM users").fetchall()
    names = []
    for r in rows:
        name = r["username"] or ""
        if not name or name in names:
            continue
        pattern = r"(?<![A-Za-z0-9_.])@" + re.escape(name) + r"(?=$|[\s，。！？、,.!?;:：；()（）\[\]【】])"
        if re.search(pattern, text):
            names.append(name)
    return names


def _rename_user_everywhere(conn, old_name, new_name):
    """昵称即登录名：改名时同步所有历史署名和账号关联。"""
    conn.execute("UPDATE posts SET author=? WHERE author=?", (new_name, old_name))
    conn.execute("UPDATE comments SET author=? WHERE author=?", (new_name, old_name))
    conn.execute("UPDATE comment_likes SET username=? WHERE username=?", (new_name, old_name))
    conn.execute("UPDATE post_likes SET username=? WHERE username=?", (new_name, old_name))
    conn.execute("UPDATE post_coins SET username=? WHERE username=?", (new_name, old_name))
    conn.execute("UPDATE post_reads SET username=? WHERE username=?", (new_name, old_name))
    conn.execute("UPDATE bookmarks SET username=? WHERE username=?", (new_name, old_name))
    conn.execute("UPDATE poll_votes SET username=? WHERE username=?", (new_name, old_name))
    conn.execute("UPDATE messages SET sender=? WHERE sender=?", (new_name, old_name))
    conn.execute("UPDATE messages SET receiver=? WHERE receiver=?", (new_name, old_name))
    conn.execute("UPDATE notifs SET username=? WHERE username=?", (new_name, old_name))
    conn.execute("UPDATE follows SET follower=? WHERE follower=?", (new_name, old_name))
    conn.execute("UPDATE follows SET following=? WHERE following=?", (new_name, old_name))
    conn.execute("UPDATE sessions SET username=? WHERE username=?", (new_name, old_name))
    conn.execute("UPDATE audit_log SET actor=? WHERE actor=?", (new_name, old_name))
    conn.execute("UPDATE users SET username=?, display_name=? WHERE username=?", (new_name, new_name, old_name))


def _repair_display_names(conn):
    """修复旧版本只改 display_name、没改 username 的账号。"""
    rows = conn.execute(
        "SELECT username, display_name FROM users "
        "WHERE display_name IS NOT NULL AND display_name<>'' AND display_name<>username"
    ).fetchall()
    fixed = 0
    for r in rows:
        old = r["username"]
        new = (r["display_name"] or "").strip()[:30]
        if not new or new == old:
            continue
        if conn.execute("SELECT id FROM users WHERE username=?", (new,)).fetchone():
            continue
        try:
            _rename_user_everywhere(conn, old, new)
            conn.commit()
            fixed += 1
            print(f"[迁移] 昵称同步：{old} -> {new}")
        except Exception as e:
            conn.rollback()
            print(f"[迁移] 昵称同步跳过 {old}: {e}")
    return fixed


@app.route("/api/users/search", methods=["GET"])
@login_required
def search_users():
    q = (request.args.get("q") or "").strip()[:30]
    like = "%" + q + "%"
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT username, display_name, avatar FROM users "
            "WHERE username LIKE ? OR display_name LIKE ? "
            "ORDER BY username LIMIT 8",
            (like, like),
        ).fetchall()
        return jsonify([{
            "username": r["username"],
            "display_name": r["display_name"] or r["username"],
            "avatar": r["avatar"] or "",
        } for r in rows])
    finally:
        conn.close()


@app.route("/api/me/profile", methods=["POST"])
@login_required
def update_my_profile():
    data = request.get_json(silent=True) or {}
    new_name = (data.get("display_name") or "").strip()
    if len(new_name) < 1:
        return jsonify({"error": "昵称不能为空"}), 400
    new_name = new_name[:30]
    bio = (data.get("bio") or "").strip()[:200]
    avatar = (data.get("avatar") or "").strip()
    banner = (data.get("banner") or "").strip()
    likes_public = 1 if data.get("likes_public") else 0
    bookmarks_public = 1 if data.get("bookmarks_public") else 0
    for value, label in ((avatar, "头像"), (banner, "背景")):
        if value and (len(value) > 2048 or not (value.startswith("https://") or value.startswith("http://"))):
            return jsonify({"error": f"{label}地址不合法"}), 400
    old_name = request.current_user["username"]
    conn = get_db()
    try:
        if new_name != old_name:
            taken = conn.execute(
                "SELECT id FROM users WHERE username=? AND id<>?",
                (new_name, request.current_user["id"]),
            ).fetchone()
            if taken:
                return jsonify({"error": "这个昵称已经被使用了"}), 400
            _rename_user_everywhere(conn, old_name, new_name)
        else:
            conn.execute(
                "UPDATE users SET display_name=? WHERE id=?",
                (new_name, request.current_user["id"]),
            )
        conn.execute(
            "UPDATE users SET bio=?, avatar=?, banner=?, likes_public=?, bookmarks_public=? WHERE id=?",
            (bio, avatar, banner, likes_public, bookmarks_public, request.current_user["id"]),
        )
        conn.commit()
        return jsonify({"ok": True, "user": {
            "id": request.current_user["id"],
            "username": new_name,
            "display_name": new_name,
            "bio": bio,
            "avatar": avatar,
            "banner": banner,
            "likes_public": likes_public,
            "bookmarks_public": bookmarks_public,
            "is_admin": request.current_user.get("is_admin") or 0,
        }})
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


@app.route("/media/posts/<int:post_id>", methods=["GET"])
def post_media(post_id):
    conn = get_db()
    try:
        row = conn.execute("SELECT image_url FROM posts WHERE id=?", (post_id,)).fetchone()
    finally:
        conn.close()
    if not row or not row["image_url"]:
        return jsonify({"error": "图片不存在"}), 404
    src = row["image_url"]
    if src[:5].lower() != "data:":
        if not (src.startswith("http://") or src.startswith("https://")):
            return jsonify({"error": "图片不存在"}), 404
        return redirect(src)
    m = re.match(r"^data:(image/(?:jpeg|jpg|png|webp|gif));base64,(.+)$", src, re.S | re.I)
    if not m:
        return jsonify({"error": "图片格式不支持"}), 404
    mime = m.group(1).lower()
    if mime == "image/jpg":
        mime = "image/jpeg"
    try:
        blob = base64.b64decode(m.group(2))
    except Exception:
        return jsonify({"error": "图片数据损坏"}), 404
    resp = send_file(io.BytesIO(blob), mimetype=mime, max_age=31536000)
    resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.route("/api/posts/<int:post_id>", methods=["DELETE"])
@login_required
def delete_post(post_id):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT author, title, content, tags, image_url, images FROM posts WHERE id=?",
            (post_id,),
        ).fetchone()
        if not row:
            return jsonify({"error": "帖子不存在"}), 404
        is_admin = request.current_user.get("is_admin")
        is_author = row["author"] == request.current_user["username"]
        if not is_admin and not is_author:
            return jsonify({"error": "只能删除自己的帖子或由管理员删除"}), 403
        comments = conn.execute(
            "SELECT id, author, content, parent_id, reply_to, created_at "
            "FROM comments WHERE post_id=? ORDER BY id ASC",
            (post_id,),
        ).fetchall()
        _log_audit(
            conn, "delete_post", request.current_user["username"], "post", post_id, post_id,
            {
                "title": row["title"] or "",
                "content": row["content"] or "",
                "author": row["author"] or "",
                "tags": row["tags"] or "",
                "comments": [{
                    "id": c["id"], "author": c["author"] or "", "content": c["content"] or "",
                    "parent_id": c["parent_id"] or 0, "reply_to": c["reply_to"] or "",
                    "created_at": _fmt_time(c["created_at"]),
                } for c in comments],
            },
        )
        conn.execute(
            "DELETE FROM comment_likes WHERE comment_id IN "
            "(SELECT id FROM comments WHERE post_id=?)",
            (post_id,),
        )
        conn.execute("DELETE FROM post_likes WHERE post_id=?", (post_id,))
        conn.execute("DELETE FROM post_coins WHERE post_id=?", (post_id,))
        conn.execute("DELETE FROM post_reads WHERE post_id=?", (post_id,))
        conn.execute("DELETE FROM bookmarks WHERE post_id=?", (post_id,))
        conn.execute(
            "DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE post_id=?)",
            (post_id,),
        )
        conn.execute(
            "DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE post_id=?)",
            (post_id,),
        )
        conn.execute("DELETE FROM polls WHERE post_id=?", (post_id,))
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
    me = request.current_user["username"]
    conn = get_db()
    try:
        post = conn.execute("SELECT author, title FROM posts WHERE id=?", (post_id,)).fetchone()
        if not post:
            return jsonify({"error": "帖子不存在"}), 404
        changed = False
        if on:
            cur = conn.execute(
                "INSERT INTO post_likes (post_id, username) VALUES (?, ?) "
                "ON CONFLICT (post_id, username) DO NOTHING",
                (post_id, me),
            )
            changed = cur.rowcount > 0
            if changed:
                conn.execute("UPDATE posts SET likes = COALESCE(likes, 0) + 1 WHERE id=?", (post_id,))
                if post["author"] and post["author"] != me:
                    conn.execute(
                        "INSERT INTO notifs (username, title, text, post_id) VALUES (?, ?, ?, ?)",
                        (post["author"], "有人赞了你的帖子", f"{me} 赞了《{post['title'] or ''}》", post_id),
                    )
        else:
            cur = conn.execute(
                "DELETE FROM post_likes WHERE post_id=? AND username=?", (post_id, me)
            )
            changed = cur.rowcount > 0
            if changed:
                conn.execute(
                    "UPDATE posts SET likes = CASE WHEN likes > 0 THEN likes - 1 ELSE 0 END WHERE id=?",
                    (post_id,),
                )
        conn.commit()
        row = conn.execute("SELECT likes FROM posts WHERE id=?", (post_id,)).fetchone()
        if not row:
            return jsonify({"error": "帖子不存在"}), 404
        liked = conn.execute(
            "SELECT 1 AS x FROM post_likes WHERE post_id=? AND username=?", (post_id, me)
        ).fetchone() is not None
        return jsonify({"likes": row["likes"], "liked": liked})
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/bookmark", methods=["POST"])
@login_required
def toggle_bookmark(post_id):
    data = request.get_json(silent=True) or {}
    on = bool(data.get("on"))
    me = request.current_user["username"]
    conn = get_db()
    try:
        if not conn.execute("SELECT id FROM posts WHERE id=?", (post_id,)).fetchone():
            return jsonify({"error": "帖子不存在"}), 404
        if on:
            conn.execute(
                "INSERT INTO bookmarks (username, post_id) VALUES (?, ?) "
                "ON CONFLICT (username, post_id) DO NOTHING",
                (me, post_id),
            )
        else:
            conn.execute(
                "DELETE FROM bookmarks WHERE username=? AND post_id=?", (me, post_id)
            )
        conn.commit()
        return jsonify({"ok": True, "bookmarked": on})
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/coin", methods=["POST"])
@login_required
def toggle_coin(post_id):
    data = request.get_json(silent=True) or {}
    on = bool(data.get("on"))
    me = request.current_user["username"]
    conn = get_db()
    try:
        post = conn.execute("SELECT author, title FROM posts WHERE id=?", (post_id,)).fetchone()
        if not post:
            return jsonify({"error": "帖子不存在"}), 404
        if post["author"] == me:
            return jsonify({"error": "不能给自己的帖子投币"}), 400
        if not on:
            return jsonify({"error": "投币后不能撤回"}), 400
        try:
            amount = int(data.get("amount", 1))
        except (TypeError, ValueError):
            amount = 1
        if amount not in (1, 2):
            return jsonify({"error": "投币数量只能是 1 或 2"}), 400
        wallet = conn.execute(
            "SELECT coins FROM users WHERE username=?", (me,)
        ).fetchone()
        balance = (wallet["coins"] if wallet and wallet["coins"] is not None else 0)
        if balance < amount:
            return jsonify({"error": "硬币不足"}), 400
        cur = conn.execute(
            "INSERT INTO post_coins (post_id, username, amount) VALUES (?, ?, ?) "
            "ON CONFLICT (post_id, username) DO NOTHING",
            (post_id, me, amount),
        )
        if cur.rowcount > 0:
            upd = conn.execute(
                "UPDATE users SET coins = COALESCE(coins, 0) - ? "
                "WHERE username=? AND COALESCE(coins, 0) >= ?",
                (amount, me, amount),
            )
            if upd.rowcount == 0:
                conn.rollback()
                return jsonify({"error": "硬币不足"}), 400
            conn.execute("UPDATE posts SET coins = COALESCE(coins, 0) + ? WHERE id=?", (amount, post_id))
            if post["author"]:
                conn.execute(
                    "INSERT INTO notifs (username, title, text, post_id) VALUES (?, ?, ?, ?)",
                    (post["author"], "有人给你的帖子投了币",
                     f"{me} 给《{post['title'] or ''}》投了 {amount} 币", post_id),
                )
        conn.commit()
        row = conn.execute("SELECT coins FROM posts WHERE id=?", (post_id,)).fetchone()
        if not row:
            return jsonify({"error": "帖子不存在"}), 404
        own = conn.execute(
            "SELECT amount FROM post_coins WHERE post_id=? AND username=?", (post_id, me)
        ).fetchone()
        wallet = conn.execute("SELECT coins FROM users WHERE username=?", (me,)).fetchone()
        return jsonify({
            "coins": row["coins"],
            "coined": True,
            "amount": (own["amount"] if own and own["amount"] else amount),
            "balance": (wallet["coins"] if wallet and wallet["coins"] is not None else 0),
        })
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
    user = _get_current_user()
    viewer_admin = bool(user and user.get("is_admin"))
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM comments WHERE post_id=? ORDER BY id ASC", (post_id,)).fetchall()
        liked_ids = set()
        if user:
            liked_rows = conn.execute(
                "SELECT comment_id FROM comment_likes WHERE username=? AND comment_id IN "
                "(SELECT id FROM comments WHERE post_id=?)",
                (user["username"], post_id),
            ).fetchall()
            liked_ids = {r["comment_id"] for r in liked_rows}
        out = []
        for r in rows:
            item = dict(r)
            item.update(_time_fields(item["created_at"], viewer_admin))
            item["parent_id"] = item.get("parent_id") or 0
            item["reply_to"] = item.get("reply_to") or ""
            item["liked"] = r["id"] in liked_ids
            out.append(item)
        return jsonify(out)
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
    try:
        parent_id = int(data.get("parent_id") or 0)
    except (TypeError, ValueError):
        parent_id = 0
    conn = get_db()
    try:
        # 先确认帖子存在，顺便拿到作者和标题给通知用（也修掉对不存在帖子插孤儿评论的旧问题）
        post = conn.execute("SELECT title, author FROM posts WHERE id=?", (post_id,)).fetchone()
        if not post:
            return jsonify({"error": "帖子不存在"}), 404
        post_title = post["title"] or ""
        post_author = post["author"] or ""

        reply_to = ""
        if parent_id:
            parent = conn.execute(
                "SELECT id, author, parent_id FROM comments WHERE id=? AND post_id=?",
                (parent_id, post_id),
            ).fetchone()
            if not parent:
                return jsonify({"error": "被回复的评论不存在"}), 400
            reply_to = parent["author"] or ""
            if parent["parent_id"]:
                # 回复“回复”时，挂到最上层评论下，并记录被回复的人
                root = conn.execute(
                    "SELECT id FROM comments WHERE id=? AND post_id=?",
                    (parent["parent_id"], post_id),
                ).fetchone()
                if root:
                    parent_id = root["id"]
                else:
                    parent_id = 0
                    reply_to = ""
            else:
                parent_id = parent["id"]

        conn.execute(
            "INSERT INTO comments (post_id, author, content, parent_id, reply_to) VALUES (?, ?, ?, ?, ?)",
            (post_id, author, content, parent_id, reply_to),
        )
        new_id = conn.max_id("comments")

        notified = set()
        # 回复某条评论时优先通知被回复的人
        if parent_id and reply_to and reply_to != author:
            conn.execute(
                "INSERT INTO notifs (username, title, text, post_id) VALUES (?, ?, ?, ?)",
                (reply_to, "有人回复了你的评论", f"{author}：{content[:40]}", post_id),
            )
            notified.add(reply_to)
        # 再通知帖子作者；自己评论自己的帖子不发，和回复通知重复时不发
        if post_author and post_author != author and post_author not in notified:
            conn.execute(
                "INSERT INTO notifs (username, title, text, post_id) VALUES (?, ?, ?, ?)",
                (post_author, "有人评论了你的帖子", f"{author} 评论了《{post_title}》", post_id),
            )
            notified.add(post_author)
        # @ 提到的人；如果已经因为评论/回复通知过，不重复发
        for mentioned in _extract_mentions(conn, content):
            if mentioned == author or mentioned in notified:
                continue
            conn.execute(
                "INSERT INTO notifs (username, title, text, post_id) VALUES (?, ?, ?, ?)",
                (mentioned, "有人提到了你", f"{author} 在《{post_title}》的评论中提到了你", post_id),
            )
            notified.add(mentioned)
        conn.commit()
        return jsonify({
            "id": new_id, "post_id": post_id, "author": author,
            "content": content, "likes": 0, "created_at": "刚刚",
            "parent_id": parent_id, "reply_to": reply_to,
        }), 201
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/comments/<int:cid>/like", methods=["POST"])
@login_required
def toggle_comment_like(post_id, cid):
    data = request.get_json(silent=True) or {}
    on = bool(data.get("on"))
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id FROM comments WHERE id=? AND post_id=?", (cid, post_id)
        ).fetchone()
        if not row:
            return jsonify({"error": "评论不存在"}), 404
        me = request.current_user["username"]
        changed = False
        if on:
            cur = conn.execute(
                "INSERT INTO comment_likes (comment_id, username) VALUES (?, ?) "
                "ON CONFLICT (comment_id, username) DO NOTHING",
                (cid, me),
            )
            changed = cur.rowcount > 0
            if changed:
                conn.execute("UPDATE comments SET likes = COALESCE(likes, 0) + 1 WHERE id=?", (cid,))
        else:
            cur = conn.execute(
                "DELETE FROM comment_likes WHERE comment_id=? AND username=?", (cid, me)
            )
            changed = cur.rowcount > 0
            if changed:
                conn.execute(
                    "UPDATE comments SET likes = CASE WHEN likes > 0 THEN likes - 1 ELSE 0 END WHERE id=?",
                    (cid,),
                )
        conn.commit()
        row = conn.execute("SELECT likes FROM comments WHERE id=?", (cid,)).fetchone()
        if not row:
            return jsonify({"error": "评论不存在"}), 404
        liked = conn.execute(
            "SELECT 1 AS x FROM comment_likes WHERE comment_id=? AND username=?", (cid, me)
        ).fetchone() is not None
        return jsonify({"likes": row["likes"], "liked": liked})
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/comments/<int:cid>", methods=["DELETE"])
@login_required
def delete_comment(post_id, cid):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT id, author, content, parent_id, reply_to, created_at "
            "FROM comments WHERE id=? AND post_id=?",
            (cid, post_id),
        ).fetchone()
        if not row:
            return jsonify({"error": "评论不存在"}), 404
        is_admin = request.current_user.get("is_admin")
        is_author = row["author"] == request.current_user["username"]
        if not is_admin and not is_author:
            return jsonify({"error": "只能删除自己的评论或由管理员删除"}), 403
        replies = conn.execute(
            "SELECT id, author, content, parent_id, reply_to, created_at "
            "FROM comments WHERE parent_id=? ORDER BY id ASC",
            (cid,),
        ).fetchall()
        _log_audit(
            conn, "delete_comment", request.current_user["username"], "comment", cid, post_id,
            {
                "comment": {
                    "id": row["id"], "author": row["author"] or "", "content": row["content"] or "",
                    "parent_id": row["parent_id"] or 0, "reply_to": row["reply_to"] or "",
                    "created_at": _fmt_time(row["created_at"]),
                },
                "replies": [{
                    "id": c["id"], "author": c["author"] or "", "content": c["content"] or "",
                    "parent_id": c["parent_id"] or 0, "reply_to": c["reply_to"] or "",
                    "created_at": _fmt_time(c["created_at"]),
                } for c in replies],
            },
        )
        # 删除这条评论及其下回复（当前只支持一层回复）
        conn.execute(
            "DELETE FROM comment_likes WHERE comment_id IN "
            "(SELECT id FROM comments WHERE id=? OR parent_id=?)",
            (cid, cid),
        )
        conn.execute("DELETE FROM comments WHERE parent_id=?", (cid,))
        conn.execute("DELETE FROM comments WHERE id=?", (cid,))
        conn.commit()
        return jsonify({"ok": True})
    finally:
        conn.close()


@app.route("/api/notifs", methods=["GET"])
@login_required
def list_notifs():
    viewer_admin = bool(request.current_user.get("is_admin"))
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, title, text, post_id, is_read, created_at FROM notifs WHERE username=? ORDER BY id DESC",
            (request.current_user["username"],),
        ).fetchall()
        notifs = [{
            "id": r["id"],
            "title": r["title"] or "",
            "text": r["text"] or "",
            "post_id": r["post_id"] or 0,
            "is_read": r["is_read"] or 0,
            **_time_fields(r["created_at"], viewer_admin),
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


@app.route("/api/messages", methods=["GET"])
@login_required
def message_inbox():
    me = request.current_user["username"]
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, sender, receiver, content, is_read, created_at FROM messages "
            "WHERE sender=? OR receiver=? ORDER BY id DESC LIMIT 500",
            (me, me),
        ).fetchall()
    finally:
        conn.close()
    viewer_admin = bool(request.current_user.get("is_admin"))
    conversations = {}
    for r in rows:
        peer = r["receiver"] if r["sender"] == me else r["sender"]
        if peer not in conversations:
            conversations[peer] = {
                "peer": peer,
                "last": r["content"],
                **_time_fields(r["created_at"], viewer_admin, key="time"),
                "unread": 0,
            }
        if r["sender"] == peer and not r["is_read"]:
            conversations[peer]["unread"] += 1
    data = list(conversations.values())
    return jsonify({"conversations": data, "unread": sum(c["unread"] for c in data)})


@app.route("/api/messages/<username>", methods=["GET"])
@login_required
def message_thread(username):
    me = request.current_user["username"]
    if username == me:
        return jsonify({"error": "不能给自己发私信"}), 400
    conn = get_db()
    try:
        peer = conn.execute("SELECT username FROM users WHERE username=?", (username,)).fetchone()
        if not peer:
            return jsonify({"error": "用户不存在"}), 404
        rows = conn.execute(
            "SELECT id, sender, receiver, content, is_read, created_at FROM messages "
            "WHERE (sender=? AND receiver=?) OR (sender=? AND receiver=?) "
            "ORDER BY id DESC LIMIT 200",
            (me, username, username, me),
        ).fetchall()
        rows = list(reversed(rows))
        viewer_admin = bool(request.current_user.get("is_admin"))
        messages = [{
            "id": r["id"],
            "sender": r["sender"],
            "receiver": r["receiver"],
            "content": r["content"],
            **_time_fields(r["created_at"], viewer_admin),
        } for r in rows]
        conn.execute(
            "UPDATE messages SET is_read=1 WHERE sender=? AND receiver=?",
            (username, me),
        )
        conn.commit()
        return jsonify({"peer": username, "messages": messages})
    finally:
        conn.close()


@app.route("/api/messages/<username>", methods=["POST"])
@login_required
def send_message(username):
    me = request.current_user["username"]
    if username == me:
        return jsonify({"error": "不能给自己发私信"}), 400
    data = request.get_json(silent=True) or {}
    content = (data.get("content") or "").strip()
    if not content:
        return jsonify({"error": "内容不能为空"}), 400
    if len(content) > 1000:
        return jsonify({"error": "私信最多 1000 字"}), 400
    conn = get_db()
    try:
        peer = conn.execute("SELECT username FROM users WHERE username=?", (username,)).fetchone()
        if not peer:
            return jsonify({"error": "用户不存在"}), 404
        conn.execute(
            "INSERT INTO messages (sender, receiver, content) VALUES (?, ?, ?)",
            (me, username, content),
        )
        new_id = conn.max_id("messages")
        conn.execute(
            "INSERT INTO notifs (username, title, text) VALUES (?, ?, ?)",
            (username, "你收到一条私信", f"{me}：{content[:40]}"),
        )
        conn.commit()
        return jsonify({
            "id": new_id,
            "sender": me,
            "receiver": username,
            "content": content,
            "created_at": "刚刚",
        }), 201
    finally:
        conn.close()


@app.route("/api/reads", methods=["GET"])
@login_required
def list_reads():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT pr.post_id FROM post_reads pr JOIN posts p ON p.id=pr.post_id "
            "WHERE pr.username=?",
            (request.current_user["username"],),
        ).fetchall()
        return jsonify({"posts": [r["post_id"] for r in rows]})
    finally:
        conn.close()


@app.route("/api/reads/sync", methods=["POST"])
@login_required
def sync_reads():
    data = request.get_json(silent=True) or {}
    raw = data.get("posts")
    if not isinstance(raw, list):
        return jsonify({"error": "posts 必须是数组"}), 400
    ids = []
    for x in raw[:2000]:
        try:
            pid = int(x)
        except (TypeError, ValueError):
            continue
        if pid > 0 and pid not in ids:
            ids.append(pid)
    conn = get_db()
    try:
        for pid in ids:
            conn.execute(
                "INSERT INTO post_reads (post_id, username) VALUES (?, ?) "
                "ON CONFLICT (post_id, username) DO NOTHING",
                (pid, request.current_user["username"]),
            )
        conn.commit()
        return jsonify({"ok": True, "count": len(ids)})
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/read", methods=["POST"])
@login_required
def mark_post_read(post_id):
    conn = get_db()
    try:
        if not conn.execute("SELECT id FROM posts WHERE id=?", (post_id,)).fetchone():
            return jsonify({"error": "帖子不存在"}), 404
        conn.execute(
            "INSERT INTO post_reads (post_id, username) VALUES (?, ?) "
            "ON CONFLICT (post_id, username) DO NOTHING",
            (post_id, request.current_user["username"]),
        )
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
            seen = set()
            for t in (r["tags"] or "").split(","):
                t = t.strip().lstrip("#").strip()
                if t and t not in seen:
                    seen.add(t)
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
        admin_count = conn.execute("SELECT COUNT(*) AS c FROM users WHERE is_admin=1").fetchone()["c"]
        coins_total = conn.execute("SELECT COALESCE(SUM(coins), 0) AS c FROM users").fetchone()["c"]
        return jsonify({
            "users": user_count, "posts": post_count, "comments": comment_count,
            "admins": admin_count, "coins": coins_total,
        })
    finally:
        conn.close()


@app.route("/api/admin/posts", methods=["GET"])
@admin_required
def admin_posts():
    q = (request.args.get("q") or "").strip()[:100]
    try:
        limit = max(1, min(int(request.args.get("limit", 50)), 200))
    except (TypeError, ValueError):
        limit = 50
    try:
        offset = max(0, int(request.args.get("offset", 0)))
    except (TypeError, ValueError):
        offset = 0
    where = ""
    params = []
    if q:
        where = ("WHERE (LOWER(p.title) LIKE LOWER(?) OR LOWER(p.content) LIKE LOWER(?) "
                 "OR LOWER(p.author) LIKE LOWER(?))")
        like = "%" + q + "%"
        params = [like, like, like]
    conn = get_db()
    try:
        total = conn.execute(
            "SELECT COUNT(*) AS c FROM posts p " + where, tuple(params)
        ).fetchone()["c"]
        rows = conn.execute(
            """SELECT p.id, p.title, p.content, p.author, p.tags, p.likes, p.coins,
                      p.views, p.image_url, p.images, p.board, p.kind, p.created_at,
                      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS replies
               FROM posts p """ + where + " ORDER BY p.id DESC LIMIT ? OFFSET ?",
            tuple(params + [limit, offset]),
        ).fetchall()
        return jsonify({
            "posts": [{
                "id": r["id"], "title": r["title"] or "", "content": r["content"] or "",
                "author": r["author"] or "", "tags": r["tags"] or "",
                "board": r["board"] or "general", "kind": r["kind"] or "post",
                "likes": r["likes"] or 0, "coins": r["coins"] or 0,
                "views": r["views"] or 0, "replies": r["replies"] or 0,
                "image_url": r["image_url"] or "", "images": r["images"] or "",
                "created_at": _fmt_time(r["created_at"]),
            } for r in rows],
            "total": total, "limit": limit, "offset": offset,
        })
    finally:
        conn.close()


@app.route("/api/admin/audit", methods=["GET"])
@admin_required
def admin_audit():
    """管理员内容审查：精确时间只在这里和 admin 账号的页面返回。"""
    conn = get_db()
    try:
        posts = conn.execute(
            """SELECT p.id, p.title, p.author, p.created_at, p.views, p.likes,
                      (SELECT COUNT(*) FROM comments c WHERE c.post_id=p.id) AS replies
               FROM posts p ORDER BY p.id DESC LIMIT 100"""
        ).fetchall()
        comments = conn.execute(
            """SELECT c.id, c.post_id, c.author, c.content, c.created_at,
                      c.parent_id, c.reply_to, p.title AS post_title
               FROM comments c LEFT JOIN posts p ON p.id=c.post_id
               ORDER BY c.id DESC LIMIT 300"""
        ).fetchall()
        deletions = conn.execute(
            "SELECT id, action, actor, target_type, target_id, post_id, content, created_at "
            "FROM audit_log ORDER BY id DESC LIMIT 200"
        ).fetchall()
        return jsonify({
            "posts": [{
                "id": r["id"], "title": r["title"] or "", "author": r["author"] or "",
                "created_at": _fmt_time(r["created_at"]),
                "views": r["views"] or 0, "likes": r["likes"] or 0,
                "replies": r["replies"] or 0,
            } for r in posts],
            "comments": [{
                "id": r["id"], "post_id": r["post_id"], "post_title": r["post_title"] or "",
                "author": r["author"] or "", "content": r["content"] or "",
                "created_at": _fmt_time(r["created_at"]),
                "parent_id": r["parent_id"] or 0, "reply_to": r["reply_to"] or "",
            } for r in comments],
            "deletions": [{
                "id": r["id"], "action": r["action"] or "", "actor": r["actor"] or "",
                "target_type": r["target_type"] or "", "target_id": r["target_id"] or 0,
                "post_id": r["post_id"] or 0, "content": r["content"] or "",
                "created_at": _fmt_time(r["created_at"]),
            } for r in deletions],
            "generated_at": _fmt_time(datetime.now(timezone.utc)),
        })
    finally:
        conn.close()


@app.route("/api/admin/users", methods=["GET"])
@admin_required
def admin_users():
    q = (request.args.get("q") or "").strip()[:100]
    try:
        limit = max(1, min(int(request.args.get("limit", 200)), 500))
    except (TypeError, ValueError):
        limit = 200
    try:
        offset = max(0, int(request.args.get("offset", 0)))
    except (TypeError, ValueError):
        offset = 0
    where = ""
    params = []
    if q:
        where = ("WHERE (LOWER(u.username) LIKE LOWER(?) OR LOWER(COALESCE(u.display_name,'')) LIKE LOWER(?) "
                 "OR LOWER(COALESCE(u.email,'')) LIKE LOWER(?))")
        like = "%" + q + "%"
        params = [like, like, like]
    conn = get_db()
    try:
        total = conn.execute(
            "SELECT COUNT(*) AS c FROM users u " + where, tuple(params)
        ).fetchone()["c"]
        rows = conn.execute(
            """SELECT u.id, u.username, u.display_name, u.email, u.is_admin, u.coins,
                      u.avatar, u.created_at,
                      (SELECT COUNT(*) FROM posts p WHERE p.author=u.username) AS post_count,
                      (SELECT COUNT(*) FROM comments c WHERE c.author=u.username) AS comment_count
               FROM users u """ + where + " ORDER BY u.id DESC LIMIT ? OFFSET ?",
            tuple(params + [limit, offset]),
        ).fetchall()
        return jsonify({
            "users": [{
                "id": r["id"], "username": r["username"],
                "display_name": r["display_name"] or r["username"],
                "email": r["email"] or "", "is_admin": r["is_admin"] or 0,
                "coins": r["coins"] or 0, "avatar": r["avatar"] or "",
                "post_count": r["post_count"] or 0,
                "comment_count": r["comment_count"] or 0,
                "created_at": _fmt_time(r["created_at"]),
            } for r in rows],
            "total": total, "limit": limit, "offset": offset,
        })
    finally:
        conn.close()


@app.route("/api/admin/users/<int:uid>/role", methods=["POST"])
@admin_required
def admin_set_role(uid):
    data = request.get_json(silent=True) or {}
    make_admin = bool(data.get("is_admin"))
    current = request.current_user
    if uid == current["id"]:
        return jsonify({"error": "不能修改自己的管理员权限"}), 400
    conn = get_db()
    try:
        target = conn.execute(
            "SELECT id, username, is_admin FROM users WHERE id=?", (uid,)
        ).fetchone()
        if not target:
            return jsonify({"error": "用户不存在"}), 404
        if not make_admin and (target["is_admin"] or 0):
            admins = conn.execute("SELECT COUNT(*) AS c FROM users WHERE is_admin=1").fetchone()["c"]
            if admins <= 1:
                return jsonify({"error": "至少要保留一个管理员"}), 400
        conn.execute("UPDATE users SET is_admin=? WHERE id=?", (1 if make_admin else 0, uid))
        _log_audit(
            conn, "set_admin", current["username"], "user", uid, 0,
            {"username": target["username"], "is_admin": 1 if make_admin else 0},
        )
        conn.commit()
        return jsonify({"ok": True, "is_admin": 1 if make_admin else 0})
    finally:
        conn.close()


@app.route("/api/admin/users/<int:uid>/reset-password", methods=["POST"])
@admin_required
def admin_reset_password(uid):
    current = request.current_user
    if uid == current["id"]:
        return jsonify({"error": "不能重置自己的密码，请通过环境变量修改"}), 400
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
    password = "".join(secrets.choice(alphabet) for _ in range(10))
    conn = get_db()
    try:
        target = conn.execute("SELECT id, username FROM users WHERE id=?", (uid,)).fetchone()
        if not target:
            return jsonify({"error": "用户不存在"}), 404
        conn.execute(
            "UPDATE users SET password=?, token='', token_expires=0 WHERE id=?",
            (generate_password_hash(password), uid),
        )
        conn.execute("DELETE FROM sessions WHERE username=?", (target["username"],))
        _log_audit(
            conn, "reset_password", current["username"], "user", uid, 0,
            {"username": target["username"]},
        )
        conn.commit()
        return jsonify({"ok": True, "password": password})
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
        # 级联删除该用户的内容：评论、帖子、帖下评论、通知、私信
        username = user["username"]
        post_count = conn.execute("SELECT COUNT(*) AS c FROM posts WHERE author=?", (username,)).fetchone()["c"]
        comment_count = conn.execute("SELECT COUNT(*) AS c FROM comments WHERE author=?", (username,)).fetchone()["c"]
        _log_audit(
            conn, "delete_user", current["username"], "user", uid, 0,
            {"username": username, "email": user["email"] or "",
             "posts": post_count, "comments": comment_count},
        )
        conn.execute(
            "DELETE FROM comments WHERE parent_id IN (SELECT id FROM comments WHERE author=?)",
            (username,),
        )
        conn.execute("DELETE FROM comments WHERE author=?", (username,))
        conn.execute("DELETE FROM comments WHERE post_id IN (SELECT id FROM posts WHERE author=?)", (username,))
        conn.execute(
            "DELETE FROM poll_votes WHERE username=? OR poll_id IN "
            "(SELECT id FROM polls WHERE post_id IN (SELECT id FROM posts WHERE author=?))",
            (username, username),
        )
        conn.execute(
            "DELETE FROM poll_options WHERE poll_id IN "
            "(SELECT id FROM polls WHERE post_id IN (SELECT id FROM posts WHERE author=?))",
            (username,),
        )
        conn.execute(
            "DELETE FROM polls WHERE post_id IN (SELECT id FROM posts WHERE author=?)",
            (username,),
        )
        conn.execute(
            "DELETE FROM bookmarks WHERE username=? OR post_id IN "
            "(SELECT id FROM posts WHERE author=?)",
            (username, username),
        )
        conn.execute("DELETE FROM posts WHERE author=?", (username,))
        conn.execute("DELETE FROM notifs WHERE username=?", (username,))
        conn.execute("DELETE FROM messages WHERE sender=? OR receiver=?", (username, username))
        conn.execute("DELETE FROM comment_likes WHERE username=?", (username,))
        conn.execute("DELETE FROM comment_likes WHERE comment_id NOT IN (SELECT id FROM comments)")
        conn.execute("DELETE FROM post_likes WHERE username=?", (username,))
        conn.execute("DELETE FROM post_coins WHERE username=?", (username,))
        conn.execute("DELETE FROM post_reads WHERE username=?", (username,))
        conn.execute(
            "DELETE FROM post_reads WHERE post_id IN (SELECT id FROM posts WHERE author=?)",
            (username,),
        )
        conn.execute("DELETE FROM follows WHERE follower=? OR following=?", (username, username))
        conn.execute(
            "DELETE FROM post_likes WHERE post_id IN (SELECT id FROM posts WHERE author=?)",
            (username,),
        )
        conn.execute(
            "DELETE FROM post_coins WHERE post_id IN (SELECT id FROM posts WHERE author=?)",
            (username,),
        )
        conn.execute("DELETE FROM sessions WHERE username=?", (username,))
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
        # 首次创建 comment_likes 时，历史点赞计数无法归属到账号，需要清零
        try:
            if is_pg:
                has_likes_table = conn.execute(
                    "SELECT 1 AS x FROM information_schema.tables "
                    "WHERE table_schema='public' AND table_name='comment_likes'"
                ).fetchone() is not None
            else:
                has_likes_table = conn.execute(
                    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='comment_likes'"
                ).fetchone() is not None
        except Exception:
            has_likes_table = True
        # 首次创建 post_likes / post_coins 时，历史计数无法归属账号，需要清零
        try:
            if is_pg:
                has_post_likes_table = conn.execute(
                    "SELECT 1 AS x FROM information_schema.tables "
                    "WHERE table_schema='public' AND table_name='post_likes'"
                ).fetchone() is not None
                has_post_coins_table = conn.execute(
                    "SELECT 1 AS x FROM information_schema.tables "
                    "WHERE table_schema='public' AND table_name='post_coins'"
                ).fetchone() is not None
            else:
                has_post_likes_table = conn.execute(
                    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='post_likes'"
                ).fetchone() is not None
                has_post_coins_table = conn.execute(
                    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='post_coins'"
                ).fetchone() is not None
        except Exception:
            has_post_likes_table = True
            has_post_coins_table = True
        has_post_reactions = has_post_likes_table and has_post_coins_table
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
                    coins INTEGER DEFAULT 10,
                    last_daily_coin TEXT DEFAULT '',
                    display_name TEXT DEFAULT '',
                    bio TEXT DEFAULT '',
                    avatar TEXT DEFAULT '',
                    banner TEXT DEFAULT '',
                    likes_public INTEGER DEFAULT 0,
                    bookmarks_public INTEGER DEFAULT 0,
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
                    board TEXT DEFAULT 'general',
                    kind TEXT DEFAULT 'post',
                    format TEXT DEFAULT 'plain',
                    music_artist TEXT DEFAULT '',
                    music_url TEXT DEFAULT '',
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
                    parent_id INTEGER DEFAULT 0,
                    reply_to TEXT DEFAULT '',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS notifs (
                    id SERIAL PRIMARY KEY,
                    username TEXT NOT NULL,
                    title TEXT DEFAULT '',
                    text TEXT DEFAULT '',
                    post_id INTEGER DEFAULT 0,
                    is_read INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id SERIAL PRIMARY KEY,
                    sender TEXT NOT NULL,
                    receiver TEXT NOT NULL,
                    content TEXT NOT NULL,
                    is_read INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS comment_likes (
                    id SERIAL PRIMARY KEY,
                    comment_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (comment_id, username)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    expires INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS post_likes (
                    id SERIAL PRIMARY KEY,
                    post_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (post_id, username)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS post_coins (
                    id SERIAL PRIMARY KEY,
                    post_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    amount INTEGER DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (post_id, username)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS audit_log (
                    id SERIAL PRIMARY KEY,
                    action TEXT NOT NULL,
                    actor TEXT DEFAULT '',
                    target_type TEXT DEFAULT '',
                    target_id INTEGER DEFAULT 0,
                    post_id INTEGER DEFAULT 0,
                    content TEXT DEFAULT '',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS post_reads (
                    id SERIAL PRIMARY KEY,
                    post_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (post_id, username)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS follows (
                    id SERIAL PRIMARY KEY,
                    follower TEXT NOT NULL,
                    following TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (follower, following)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS bookmarks (
                    id SERIAL PRIMARY KEY,
                    username TEXT NOT NULL,
                    post_id INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (username, post_id)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS polls (
                    id SERIAL PRIMARY KEY,
                    post_id INTEGER NOT NULL UNIQUE,
                    question TEXT DEFAULT '',
                    closed INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS poll_options (
                    id SERIAL PRIMARY KEY,
                    poll_id INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    position INTEGER DEFAULT 0
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS poll_votes (
                    id SERIAL PRIMARY KEY,
                    poll_id INTEGER NOT NULL,
                    option_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (poll_id, username)
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
                    post_id INTEGER DEFAULT 0,
                    is_read INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sender TEXT NOT NULL,
                    receiver TEXT NOT NULL,
                    content TEXT NOT NULL,
                    is_read INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS comment_likes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    comment_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (comment_id, username)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    expires INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS post_likes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    post_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (post_id, username)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS post_coins (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    post_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    amount INTEGER DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (post_id, username)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS audit_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    action TEXT NOT NULL,
                    actor TEXT DEFAULT '',
                    target_type TEXT DEFAULT '',
                    target_id INTEGER DEFAULT 0,
                    post_id INTEGER DEFAULT 0,
                    content TEXT DEFAULT '',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS post_reads (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    post_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (post_id, username)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS follows (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    follower TEXT NOT NULL,
                    following TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (follower, following)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS bookmarks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL,
                    post_id INTEGER NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (username, post_id)
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS polls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    post_id INTEGER NOT NULL UNIQUE,
                    question TEXT DEFAULT '',
                    closed INTEGER DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS poll_options (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    poll_id INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    position INTEGER DEFAULT 0
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS poll_votes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    poll_id INTEGER NOT NULL,
                    option_id INTEGER NOT NULL,
                    username TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (poll_id, username)
                )
            """)
            conn.commit()

        if not has_likes_table:
            # 评论点赞改为按账号记录；旧计数没有用户名，无法去重，一次性归零
            try:
                conn.execute("UPDATE comments SET likes=0")
                conn.commit()
                print("[迁移] 初始化评论点赞：历史计数已清零（从现在起按账号去重）")
            except Exception as e:
                print(f"[迁移] 评论点赞计数清零跳过：{e}")

        if not has_post_reactions:
            # 帖子点赞/投币改为按账号记录；旧计数无法归属，一次性归零
            try:
                conn.execute("DELETE FROM post_likes")
                conn.execute("DELETE FROM post_coins")
                conn.execute("UPDATE posts SET likes=0, coins=0")
                conn.commit()
                print("[迁移] 初始化帖子点赞/投币：历史计数已清零（从现在起按账号去重）")
            except Exception as e:
                print(f"[迁移] 帖子点赞/投币计数清零跳过：{e}")

        # 自动补列（兼容 SQLite 和 PostgreSQL）：老库缺哪列就补哪列
        text_cols = {"tags", "email", "token", "image_url", "images", "reply_to", "last_daily_coin",
                     "display_name", "bio", "avatar", "banner"}
        col_sets = {}
        for table, cols in [
            ("posts", ["tags", "likes", "coins", "image_url", "images"]),
            ("comments", ["likes", "parent_id", "reply_to"]),
            ("notifs", ["post_id"]),
            ("users", ["email", "is_admin", "token", "token_expires", "coins", "last_daily_coin",
                       "display_name", "bio", "avatar", "banner", "likes_public", "bookmarks_public"]),
            ("posts", ["board", "kind", "format", "music_artist", "music_url"]),
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
                    if table == "users" and col == "coins":
                        coltype = "INTEGER DEFAULT 10"
                    elif table == "posts" and col == "board":
                        coltype = "TEXT DEFAULT 'general'"
                    elif table == "posts" and col == "kind":
                        coltype = "TEXT DEFAULT 'post'"
                    elif table == "posts" and col == "format":
                        coltype = "TEXT DEFAULT 'plain'"
                    else:
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

        # 初始钱包：已有账号一次性补到 10 币；当天不重复发每日 3 币
        try:
            conn.execute(
                "UPDATE users SET coins=10 WHERE coins IS NULL"
            )
            conn.execute(
                "UPDATE users SET last_daily_coin=? "
                "WHERE last_daily_coin IS NULL OR last_daily_coin=''",
                (_today_shanghai(),),
            )
            conn.commit()
        except Exception as e:
            print(f"[迁移] 初始钱包跳过：{e}")

        try:
            _repair_display_names(conn)
        except Exception as e:
            print(f"[迁移] 昵称修复跳过：{e}")

        # 登录态迁移：把旧 users.token 复制进 sessions，升级后不用重新登录
        try:
            conn.execute("DELETE FROM sessions WHERE expires<=?", (time.time(),))
            legacy = conn.execute(
                "SELECT username, token, token_expires FROM users "
                "WHERE token IS NOT NULL AND token<>'' AND token_expires>?",
                (time.time(),),
            ).fetchall()
            for r in legacy:
                conn.execute(
                    "INSERT INTO sessions (token, username, expires) VALUES (?, ?, ?) "
                    "ON CONFLICT (token) DO NOTHING",
                    (r["token"], r["username"], r["token_expires"]),
                )
            conn.commit()
        except Exception as e:
            print(f"[迁移] 登录态迁移跳过：{e}")

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

        # 清理已删评论留下的点赞记录（幂等）
        try:
            conn.execute("DELETE FROM comment_likes WHERE comment_id NOT IN (SELECT id FROM comments)")
            conn.execute("DELETE FROM post_likes WHERE post_id NOT IN (SELECT id FROM posts)")
            conn.execute("DELETE FROM post_coins WHERE post_id NOT IN (SELECT id FROM posts)")
            conn.execute("DELETE FROM post_reads WHERE post_id NOT IN (SELECT id FROM posts)")
            conn.commit()
        except Exception as e:
            print(f"[迁移] 点赞/投币清理跳过：{e}")

        # 帖子投币：新增 amount；清理历史自投币，并按记录重算总币数
        try:
            if is_pg:
                amount_col = conn.execute(
                    "SELECT 1 AS x FROM information_schema.columns "
                    "WHERE table_schema='public' AND table_name='post_coins' AND column_name='amount'"
                ).fetchone() is not None
            else:
                amount_col = any(
                    (r["name"] if "name" in r.keys() else r[1]) == "amount"
                    for r in conn.execute("PRAGMA table_info(post_coins)").fetchall()
                )
            if not amount_col:
                conn.execute("ALTER TABLE post_coins ADD COLUMN amount INTEGER DEFAULT 1")
                conn.commit()
                print("[迁移] 已给 post_coins 加上 amount 列")
            conn.execute(
                "DELETE FROM post_coins WHERE EXISTS ("
                "SELECT 1 FROM posts p WHERE p.id = post_coins.post_id AND p.author = post_coins.username)"
            )
            conn.execute(
                "UPDATE posts SET coins = CAST(COALESCE(("
                "SELECT SUM(pc.amount) FROM post_coins pc WHERE pc.post_id = posts.id), 0) AS INTEGER)"
            )
            conn.commit()
        except Exception as e:
            print(f"[迁移] 投币数量迁移跳过：{e}")

        # 常用查询加索引（幂等，SQLite / PostgreSQL 都支持）
        for ddl in (
            "CREATE INDEX IF NOT EXISTS idx_users_token ON users(token)",
            "CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id)",
            "CREATE INDEX IF NOT EXISTS idx_messages_receiver ON messages(receiver, is_read)",
            "CREATE INDEX IF NOT EXISTS idx_posts_board ON posts(board)",
            "CREATE INDEX IF NOT EXISTS idx_bookmarks_user ON bookmarks(username)",
            "CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id)",
            "CREATE INDEX IF NOT EXISTS idx_poll_options_poll ON poll_options(poll_id)",
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
        # ADMIN_USERNAME / ADMIN_EMAIL 指定的账号会被提升为管理员；
        # 只有显式设置 ADMIN_PASSWORD 时才改密码，避免误重置个人账号密码。
        admin_email_env = (os.getenv("ADMIN_EMAIL") or "").strip()
        admin_password_env = (os.getenv("ADMIN_PASSWORD") or "").strip()
        admin_username_env = (os.getenv("ADMIN_USERNAME") or "").strip()
        admin_email = admin_email_env or "admin@ywies.local"
        admin_password = admin_password_env or "admin123"

        target = None
        if admin_username_env:
            target = conn.execute(
                "SELECT id, username, email, is_admin FROM users "
                "WHERE username=? OR display_name=? ORDER BY is_admin DESC, id LIMIT 1",
                (admin_username_env, admin_username_env),
            ).fetchone()
        if not target and admin_email:
            # ADMIN_EMAIL 不含 @ 时优先当用户名/昵称匹配；
            # 否则容易命中旧管理员被改过的 email，而不是个人账号。
            if "@" not in admin_email:
                target = conn.execute(
                    "SELECT id, username, email, is_admin FROM users "
                    "WHERE LOWER(username)=LOWER(?) OR LOWER(COALESCE(display_name,''))=LOWER(?) "
                    "ORDER BY is_admin DESC, id LIMIT 1",
                    (admin_email, admin_email),
                ).fetchone()
            else:
                target = conn.execute(
                    "SELECT id, username, email, is_admin FROM users "
                    "WHERE LOWER(COALESCE(email,''))=LOWER(?) "
                    "ORDER BY is_admin DESC, id LIMIT 1",
                    (admin_email,),
                ).fetchone()
                if not target:
                    target = conn.execute(
                        "SELECT id, username, email, is_admin FROM users "
                        "WHERE LOWER(username)=LOWER(?) OR LOWER(COALESCE(display_name,''))=LOWER(?) "
                        "ORDER BY is_admin DESC, id LIMIT 1",
                        (admin_email, admin_email),
                    ).fetchone()

        if target:
            sets = ["is_admin=1"]
            params = []
            if admin_password_env:
                sets.append("password=?")
                params.append(generate_password_hash(admin_password_env))
            if admin_email_env and "@" in admin_email:
                sets.append("email=?")
                params.append(admin_email)
            params.append(target["id"])
            conn.execute("UPDATE users SET " + ", ".join(sets) + " WHERE id=?", tuple(params))
            conn.commit()
            print(f"[管理员] 已提升账号：{target['username']}")
            if admin_password_env:
                print("[管理员] 密码已按 ADMIN_PASSWORD 同步")
        else:
            admin_row = conn.execute(
                "SELECT id, email FROM users WHERE is_admin=1 ORDER BY id LIMIT 1"
            ).fetchone()
            if not admin_row:
                username = admin_username_env or "管理员"
                email = admin_email if "@" in admin_email else "admin@ywies.local"
                pwd_hash = generate_password_hash(admin_password)
                conn.execute(
                    "INSERT INTO users (email, username, password, is_admin) VALUES (?, ?, ?, 1)",
                    (email, username, pwd_hash),
                )
                conn.commit()
                print(f"[初始化] 管理员账号已创建：{username} / {email}")
            else:
                sets = []
                params = []
                if admin_password_env:
                    sets.append("password=?")
                    params.append(generate_password_hash(admin_password_env))
                if admin_email_env and "@" in admin_email:
                    sets.append("email=?")
                    params.append(admin_email)
                if sets:
                    params.append(admin_row["id"])
                    conn.execute("UPDATE users SET " + ", ".join(sets) + " WHERE id=?", tuple(params))
                    conn.commit()
                    print("[管理员] 已按环境变量同步原有管理员")
                else:
                    print("[管理员] 使用现有管理员账号；未显式设置 ADMIN_PASSWORD，不修改密码")
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
