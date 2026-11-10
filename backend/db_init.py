# db_init.py
# CCA 校园发帖平台：初始化数据库
# 功能：执行 schema.sql 里的建表语句，并确认 users / posts / comments 三张表真的建出来了。
# 用法：python3 db_init.py

import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(__file__), "school_posts.db")
SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema.sql")


def create_tables():
    """读取 schema.sql 并执行建表语句。"""
    conn = sqlite3.connect(DB_PATH)
    try:
        with open(SCHEMA_PATH, "r", encoding="utf-8") as f:
            schema_sql = f.read()
        conn.executescript(schema_sql)
        conn.commit()
    finally:
        conn.close()


def list_tables():
    conn = sqlite3.connect(DB_PATH)
    try:
        rows = conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        return [row[0] for row in rows]
    finally:
        conn.close()


if __name__ == "__main__":
    create_tables()
    tables = list_tables()
    print("建表完成，当前数据库中的表：", tables)

    expected = ["users", "posts", "comments"]
    missing = [t for t in expected if t not in tables]
    if missing:
        print("缺少表：", missing)
    else:
        print("OK：users / posts / comments 三张表已全部创建")
