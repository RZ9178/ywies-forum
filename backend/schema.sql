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
    image_url   TEXT DEFAULT '',
    views       INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 评论表：replies 数通过 SELECT COUNT(*) FROM comments WHERE post_id=? 算出
CREATE TABLE comments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id     INTEGER NOT NULL,
    author      TEXT NOT NULL DEFAULT '匿名同学',
    content     TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);

-- 塞几条种子数据，首页打开就有东西看
INSERT INTO users (username, password) VALUES
    ('demo', 'demo123');

INSERT INTO posts (title, content, author, image_url, views) VALUES
    ('欢迎来到 YWIES 论坛',
     '这是我们学校自己的校园论坛，大家可以在这里发帖交流、CCA 组队、约饭、换物～',
     '论坛管理员', '', 128),
    ('CCA 招新｜机器人组还差一个机械臂手',
     '下周招新，我们组还差一个负责机械臂的同学，有兴趣的评论区扣 1，技术栈不限，零基础也能教。',
     'RoboRay', '', 86),
    ('三楼食堂今天的麻辣香锅绝了',
     '推荐加牛肉和藕片，排队大概 15 分钟，亲测不踩雷。',
     '食堂常客', '', 210),
    ('有人来换越狱牌吗',
     '有三张多的可以换，私聊。',
     'AAA小雷音寺住持', '', 32);

INSERT INTO comments (post_id, author, content) VALUES
    (1, '路人甲', '前排支持！'),
    (1, 'Y23小明', '希望能加个匿名板块'),
    (2, '机器人小白', '扣 1，完全零基础能进吗？'),
    (3, '干饭人', '昨晚刚吃过，确实香'),
    (3, '辣度挑战王', '中辣就已经冒汗了，慎重');
