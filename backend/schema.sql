-- schema.sql
-- CCA 校园发帖平台：建表语句

DROP TABLE IF EXISTS poll_votes;
DROP TABLE IF EXISTS poll_options;
DROP TABLE IF EXISTS polls;
DROP TABLE IF EXISTS bookmarks;
DROP TABLE IF EXISTS follows;
DROP TABLE IF EXISTS post_reads;
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS post_coins;
DROP TABLE IF EXISTS post_likes;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS comment_likes;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS notifs;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS posts;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL UNIQUE,
    username    TEXT NOT NULL,
    password    TEXT NOT NULL,
    is_admin    INTEGER NOT NULL DEFAULT 0,
    coins       INTEGER NOT NULL DEFAULT 10,
    last_daily_coin TEXT DEFAULT '',
    display_name TEXT DEFAULT '',
    bio         TEXT DEFAULT '',
    avatar      TEXT DEFAULT '',
    banner      TEXT DEFAULT '',
    likes_public INTEGER DEFAULT 0,
    bookmarks_public INTEGER DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE posts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    author      TEXT NOT NULL DEFAULT '匿名同学',
    tags        TEXT DEFAULT '',
    image_url   TEXT DEFAULT '',
    images      TEXT DEFAULT '',
    board       TEXT DEFAULT 'general',
    kind        TEXT DEFAULT 'post',
    format      TEXT DEFAULT 'plain',
    views       INTEGER NOT NULL DEFAULT 0,
    likes       INTEGER NOT NULL DEFAULT 0,
    coins       INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL,
    author      TEXT NOT NULL DEFAULT '匿名同学',
    content     TEXT NOT NULL,
    likes       INTEGER NOT NULL DEFAULT 0,
    parent_id   INTEGER DEFAULT 0,
    reply_to    TEXT DEFAULT '',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

CREATE TABLE notifs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    text        TEXT NOT NULL DEFAULT '',
    post_id     INTEGER DEFAULT 0,
    is_read     INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sender      TEXT NOT NULL,
    receiver    TEXT NOT NULL,
    content     TEXT NOT NULL,
    is_read     INTEGER DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE comment_likes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id  INTEGER NOT NULL,
    username    TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (comment_id, username)
);

CREATE TABLE sessions (
    token       TEXT PRIMARY KEY,
    username    TEXT NOT NULL,
    expires     INTEGER NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE post_likes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL,
    username    TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (post_id, username)
);

CREATE TABLE post_coins (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL,
    username    TEXT NOT NULL,
    amount      INTEGER DEFAULT 1,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (post_id, username)
);

CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    action      TEXT NOT NULL,
    actor       TEXT DEFAULT '',
    target_type TEXT DEFAULT '',
    target_id   INTEGER DEFAULT 0,
    post_id     INTEGER DEFAULT 0,
    content     TEXT DEFAULT '',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE post_reads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL,
    username    TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (post_id, username)
);

CREATE TABLE follows (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    follower    TEXT NOT NULL,
    following   TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (follower, following)
);

CREATE TABLE bookmarks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    post_id     INTEGER NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (username, post_id)
);

CREATE TABLE polls (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL UNIQUE,
    question    TEXT DEFAULT '',
    closed      INTEGER DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE poll_options (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id     INTEGER NOT NULL,
    text        TEXT NOT NULL,
    position    INTEGER DEFAULT 0
);

CREATE TABLE poll_votes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id     INTEGER NOT NULL,
    option_id   INTEGER NOT NULL,
    username    TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (poll_id, username)
);
