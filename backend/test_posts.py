# test_posts.py
# CCA 校园发帖平台：测试帖子表
# 功能：测试「插入一条帖子」和「查询所有帖子」两条最基本的读写操作。
# 用法：先运行 db_init.py 建表，再运行本脚本。python3 test_posts.py

import os
import sqlite3

# 数据库文件路径（和 db_init.py 保持同一个常量）
DB_PATH = os.path.join(os.path.dirname(__file__), "school_posts.db")


def insert_post(title, content, author="测试用户"):
    """向 posts 表插入一条帖子，返回新帖子的 id。"""
    conn = sqlite3.connect(DB_PATH)
    try:
        cur = conn.execute(
            "INSERT INTO posts (title, content, author) VALUES (?, ?, ?)",
            (title, content, author),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def get_all_posts():
    """查询所有帖子，按 id 升序返回，每一条是字典。"""
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT id, title, content, author, created_at "
            "FROM posts ORDER BY id"
        ).fetchall()
        return [dict(row) for row in rows]
    finally:
        conn.close()


if __name__ == "__main__":
    # 1. 插入一条帖子
    new_id = insert_post("我的第一条帖子", "这是用 Python 脚本插入的测试内容。")
    print("插入成功，新帖子 id =", new_id)

    # 2. 查询所有帖子
    posts = get_all_posts()
    print("当前所有帖子：")
    for p in posts:
        print(f"  [{p['id']}] {p['title']} - 作者: {p['author']} ({p['created_at']})")
        print(f"        内容: {p['content']}")
