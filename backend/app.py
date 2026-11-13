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
# 环境变量里的连接串容易被粘贴带入换行 / 空格 / 引号，导致 PG 报
# database "postgres\n" does not exist；这里统一清洗，双端都安全。
DATABASE_URL = "".join((os.getenv("DATABASE_URL") or "").split()).strip('"').strip("'") or None

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
    return jsonify({"user": user})


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
        conn.execute(
            "INSERT INTO posts (title, content, author, tags, image_url) VALUES (?, ?, ?, ?, ?)",
            (title, content, author, tags, image),
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
        conn.execute(
            "INSERT INTO comments (post_id, author, content) VALUES (?, ?, ?)",
            (post_id, author, content),
        )
        conn.commit()
        new_id = conn.max_id("comments")
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

        # 自动补列（兼容 SQLite 和 PostgreSQL）：老库缺哪列就补哪列
        text_cols = {"tags", "email", "token", "image_url"}
        col_sets = {}
        for table, cols in [
            ("posts", ["tags", "likes", "coins", "image_url"]),
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
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=debug_mode)
