# app.py - 校园发帖平台后端主程序
# 接口：
#   POST /chat                       -> AI 对话
#   GET  /api/posts                  -> 帖子列表
#   POST /api/posts                  -> 发新帖（title, content, author, tags, image）
#   GET  /api/posts/<id>             -> 单条帖子详情
#   GET  /api/posts/<id>/comments    -> 帖子评论列表
#   POST /api/posts/<id>/comments    -> 发表评论
#   GET  /api/tags                   -> 所有已使用过的标签（去重）
#   POST /api/upload                 -> base64 图片上传（返回 data URL）

import os
import sqlite3
import base64

from flask import Flask, request, jsonify, send_from_directory
from ai_client import ai_reply

app = Flask(__name__)

DB_PATH = os.path.join(os.path.dirname(__file__), "school_posts.db")
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..")
# 图片最大 ~2MB（base64 后约 2.7MB）
MAX_IMAGE_BYTES = 2 * 1024 * 1024


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


# ============================ 跨域 ============================
@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


# ============================ AI 对话 ============================
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


# ============================ 帖子 ============================
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
            """
            SELECT p.*,
                   (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS reply_count
            FROM posts p
            ORDER BY p.id DESC
            """
        ).fetchall()
        return jsonify([_row_to_dict(r, r["reply_count"]) for r in rows])
    finally:
        conn.close()


@app.route("/api/posts", methods=["POST"])
def create_post():
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "").strip()
    content = (data.get("content") or "").strip()
    author = (data.get("author") or "匿名同学").strip()
    tags = (data.get("tags") or "").strip()
    image = (data.get("image") or "").strip()

    if not title:
        return jsonify({"error": "标题不能为空"}), 400
    if not content:
        return jsonify({"error": "内容不能为空"}), 400

    # 图片大小限制
    if image and len(image) > MAX_IMAGE_BYTES * 1.4:
        return jsonify({"error": "图片太大，请压缩到 2MB 以内"}), 400

    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO posts (title, content, author, tags, image_url) VALUES (?, ?, ?, ?, ?)",
            (title, content, author, tags, image),
        )
        conn.commit()
        new_id = cur.lastrowid
        row = conn.execute("SELECT * FROM posts WHERE id = ?", (new_id,)).fetchone()
        return jsonify(_row_to_dict(row, 0)), 201
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>", methods=["GET"])
def get_post(post_id):
    conn = get_db()
    try:
        row = conn.execute(
            """
            SELECT p.*,
                   (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id) AS reply_count
            FROM posts p
            WHERE p.id = ?
            """,
            (post_id,),
        ).fetchone()
        if row is None:
            return jsonify({"error": "帖子不存在"}), 404
        return jsonify(_row_to_dict(row, row["reply_count"]))
    finally:
        conn.close()


# ============================ 评论 ============================
@app.route("/api/posts/<int:post_id>/comments", methods=["GET"])
def list_comments(post_id):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM comments WHERE post_id = ? ORDER BY id ASC",
            (post_id,),
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        conn.close()


@app.route("/api/posts/<int:post_id>/comments", methods=["POST"])
def create_comment(post_id):
    data = request.get_json(silent=True) or {}
    content = (data.get("content") or "").strip()
    author = (data.get("author") or "匿名同学").strip()
    if not content:
        return jsonify({"error": "内容不能为空"}), 400
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO comments (post_id, author, content) VALUES (?, ?, ?)",
            (post_id, author, content),
        )
        conn.commit()
        return jsonify({
            "id": cur.lastrowid, "post_id": post_id, "author": author,
            "content": content, "likes": 0, "created_at": "刚刚"
        }), 201
    finally:
        conn.close()


# ============================ 动态标签 ============================
@app.route("/api/tags", methods=["GET"])
def list_tags():
    """返回所有帖子里出现过的标签（去重，按使用频率排序）。"""
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT tags FROM posts WHERE tags IS NOT NULL AND tags != ''"
        ).fetchall()
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


# ============================ 图片上传（base64） ============================
@app.route("/api/upload", methods=["POST"])
def upload_image():
    """接收 base64 图片，直接返回 data URL 给前端存到帖子里。"""
    data = request.get_json(silent=True) or {}
    image = (data.get("image") or "").strip()
    if not image:
        return jsonify({"error": "没有图片数据"}), 400
    if not image.startswith("data:image/"):
        return jsonify({"error": "图片格式不对"}), 400
    if len(image) > MAX_IMAGE_BYTES * 1.4:
        return jsonify({"error": "图片太大，请压缩到 2MB 以内"}), 400
    return jsonify({"url": image})


# 兼容老约定
app.add_url_rule("/posts", "list_posts_legacy", list_posts)
app.add_url_rule("/posts", "create_post_legacy", create_post, methods=["POST"])


# ============================ 前端静态文件 ============================
@app.route("/")
def home():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def frontend_files(path):
    return send_from_directory(FRONTEND_DIR, path)


def _migrate():
    """启动时自动补列 + 清理旧种子数据。"""
    conn = get_db()
    try:
        for table, cols in [
            ("posts", ["tags", "likes", "coins"]),
            ("comments", ["likes"]),
        ]:
            existing = [r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()]
            for col in cols:
                if col not in existing:
                    coltype = "TEXT DEFAULT ''" if col == "tags" else "INTEGER DEFAULT 0"
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {coltype}")
                    print(f"[迁移] 已给 {table} 表加上 {col} 列")
        conn.commit()

        # 一次性清理：删掉旧版预置的种子帖子
        seed_titles = (
            "欢迎来到 YWIES 论坛",
            "CCA 招新｜机器人组还差一个机械臂手",
            "三楼食堂今天的麻辣香锅绝了",
            "有人来换越狱牌吗",
            "距离阿哈出世还有最后1天",
        )
        placeholders = ",".join("?" for _ in seed_titles)
        deleted = conn.execute(
            f"DELETE FROM posts WHERE title IN ({placeholders})", seed_titles
        ).rowcount
        if deleted:
            conn.commit()
            print(f"[迁移] 已清理 {deleted} 条旧种子测试帖子")
    finally:
        conn.close()


if __name__ == "__main__":
    if not os.path.exists(DB_PATH):
        print("[提示] 数据库不存在，正在自动初始化...")
        from db_init import create_tables
        create_tables()
    _migrate()
    app.run(host="0.0.0.0", port=5000, debug=True)
