-- schema.sql
-- CCA 校园发帖平台：建表语句
-- 由 db_init.py 读取执行，建出 users / posts / comments 三张表

-- 若已存在则先删（开发阶段方便重来；正式上线不要 DROP）
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS users;

-- 用户表（先建结构，登录功能以后再做）
CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 帖子表：author 先存字符串昵称，以后接 users 表再改成外键
CREATE TABLE posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    author      TEXT NOT NULL DEFAULT '匿名同学',
    tags        TEXT DEFAULT '',
    image_url   TEXT DEFAULT '',
    views       INTEGER NOT NULL DEFAULT 0,
    likes       INTEGER NOT NULL DEFAULT 0,
    coins       INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 评论表：replies 数通过 SELECT(*) FROM comments WHERE post_id=? 算出
CREATE TABLE comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL,
    author      TEXT NOT NULL DEFAULT '匿名同学',
    content     TEXT NOT NULL,
    likes       INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- 默认只建一个 demo 用户，不预置任何帖子和评论
INSERT INTO users (username, password) VALUES
    ('demo', 'demo123');
