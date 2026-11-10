# YWIES 校园论坛 - 后端

Flask + SQLite，单端口 5000。

## 文件说明

| 文件 | 作用 |
|------|------|
| `app.py` | Flask 主程序，所有接口 |
| `db_init.py` | 第一次跑之前执行：建库建表 + 塞种子数据 |
| `schema.sql` | 建表语句（被 db_init.py 读取） |
| `ai_client.py` | AI 组对接入口，当前是占位实现 |
| `test_posts.py` | 后端组自己的 SQLite 读写测试脚本 |
| `school_posts.db` | SQLite 数据库文件（跑过 db_init.py 后生成） |

## 怎么跑

```bash
cd backend
pip install flask          # 第一次装依赖
python3 db_init.py         # 第一次初始化数据库
python3 app.py             # 启动，看到 Running on http://127.0.0.1:5000 就成
```

然后浏览器开 `http://127.0.0.1:8765/index.html`（前端静态服务）或直接用 Flask 同目录的 HTML。

## 接口清单

### GET /api/posts
返回全部帖子（新的在前），数组：
```json
[
  {
    "id": 1,
    "title": "欢迎来到 YWIES 论坛",
    "content": "正文...",
    "author": "论坛管理员",
    "image": "",
    "views": 128,
    "replies": 2,
    "created_at": "2026-11-10 03:06:20"
  }
]
```

### POST /api/posts
发新帖，body：`{"title": "...", "content": "..."}`
返回新建的帖子对象（201）。

### GET /api/posts/<id>
单条帖子详情，404 表示不存在。

### POST /chat
AI 对话（AI 组对接），body：`{"message": "...", "role": "校园助手"}`

## 数据库表

- `users` — 用户（结构预留，登录以后做）
- `posts` — 帖子：id / title / content / author / image_url / views / created_at
- `comments` — 评论：id / post_id / author / content / created_at
  （前端卡片上的"回复数"就是对 comments 表 COUNT 出来的）

## 想清空数据重来？

```bash
rm school_posts.db
python3 db_init.py
```
