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

import os
import re
import sqlite3
import secrets
import time
from functools import wraps

import psycopg2
import psycopg2.extras
from flask import Flask, request, jsonify, send_from_directory
from werkzeug.security import generate_password_hash, check_password_hash

from ai_client import ai_reply
from email_service import send_code

app = Flask(__name__)

DB_PATH = os.path.join(os.path.dirname(__file__), "school_posts.db")
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..")
DATABASE_URL = os.getenv("DATABASE_URL")

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

    def commit(self):
        self._conn.commit()

    def close(self):
        self._conn.close()


def get_db():
    if DATABASE_URL:
        conn = psycopg2.connect(DATABASE_URL)
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


def _get_current_user():
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    token = auth[7:].strip()
    sess = _SESSION_STORE.get(token)
    if not sess:
        return None
    user_id, expires_at = sess
    if time.time() > expires_at:
        _SESSION_STORE.pop(token, None)
        return None
    conn = get_db()
    try:
        row = conn.execute("SELECT id, email, username, is_admin FROM users WHERE id=?", (user_id,)).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


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
        cur = conn.execute(
            "INSERT INTO users (email, username, password, is_admin) VALUES (?, ?, ?, 0)",
            (fake_email, username, pwd_hash),
        )
        conn.commit()
        user_id = cur.lastrowid
    except sqlite3.IntegrityError:
        return jsonify({"error": "这个昵称已经被注册了"}), 400
    finally:
        conn.close()
    token = secrets.token_urlsafe(32)
    _SESSION_STORE[token] = (user_id, time.time() + SESSION_TTL)
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
        _SESSION_STORE[token] = (row["id"], time.time() + SESSION_TTL)
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
    return jsonify({"user": user})


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


def _row_to_dict(row, reply_count=None):
    return {
        "id": row["id"],
        "title": row["title"],
        "content": row["content"],
        "author": row["author"],
        "tags": row["tags"] or "",
        "image": row["image_url"] or "",
        "views": row["views"],
        "likes": row["likes"] if "likes" in row.keys() else 0,
        "coins": row["coins"] if "coins" in row.keys() else 0,
        "replies": reply_count if reply_count is not None else 0,
        "created_at": row["created_at"],
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
    image = (data.get("image") or "").strip()
    if not title:
        return jsonify({"error": "标题不能为空"}), 400
    if not content:
        return jsonify({"error": "内容不能为空"}), 400
    if image and len(image) > 2 * 1024 * 1024 * 1.4:
        return jsonify({"error": "图片太大"}), 400
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO posts (title, content, author, tags, image_url) VALUES (?, ?, ?, ?, ?)",
            (title, content, author, tags, image),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM posts WHERE id=?", (cur.lastrowid,)).fetchone()
        return jsonify(_row_to_dict(row, 0)), 201
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>", methods=["GET"])
def get_post(post_id):
    conn = get_db()
    try:
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


@app.route("/api/posts/<int:post_id>/comments", methods=["GET"])
def list_comments(post_id):
    conn = get_db()
    try:
        rows = conn.execute("SELECT * FROM comments WHERE post_id=? ORDER BY id ASC", (post_id,)).fetchall()
        return jsonify([dict(r) for r in rows])
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
        cur = conn.execute(
            "INSERT INTO comments (post_id, author, content) VALUES (?, ?, ?)",
            (post_id, author, content),
        )
        conn.commit()
        return jsonify({"id": cur.lastrowid, "post_id": post_id, "author": author,
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
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        post_count = conn.execute("SELECT COUNT(*) FROM posts").fetchone()[0]
        comment_count = conn.execute("SELECT COUNT(*) FROM comments").fetchone()[0]
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
        return jsonify([dict(r) for r in rows])
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
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS posts (
                    id SERIAL PRIMARY KEY,
                    title TEXT NOT NULL,
                    content TEXT DEFAULT '',
                    author TEXT NOT NULL,
                    image TEXT DEFAULT '',
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
            conn.commit()

        # 自动补列（兼容 SQLite 和 PostgreSQL）
        for table, cols in [
            ("posts", ["tags", "likes", "coins"]),
            ("comments", ["likes"]),
            ("users", ["email", "is_admin"]),
        ]:
            if is_pg:
                existing = [r["column_name"] for r in conn.execute(
                    "SELECT column_name FROM information_schema.columns WHERE table_name=%s", (table,)
                ).fetchall()]
            else:
                existing = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
            for col in cols:
                if col not in existing:
                    coltype = "TEXT DEFAULT ''" if col in ("tags", "email") else "INTEGER DEFAULT 0"
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}")
                    print(f"[迁移] 已给 {table} 表加上 {col} 列")
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
            print(f"[初始化] 管理员账号：{admin_email}（密码：{admin_password}）")
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
    if not os.path.exists(DB_PATH):
        print("[提示] 数据库不存在，正在自动初始化...")
        from db_init import create_tables
        create_tables()
    _migrate()
    app.run(host="0.0.0.0", port=5000, debug=True)
