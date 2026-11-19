# YWIES Forum

面向 YWIES 校内学生的轻量文字论坛：校园生活、社团组队、物品交换、闲聊灌水。

- 线上：https://ywies-forum.onrender.com
- 前端：原生 HTML / CSS / JavaScript，无构建工具
- 后端：Flask 3（`backend/app.py`），SQLite / PostgreSQL 双兼容
- 数据库：线上 Supabase PostgreSQL；未设置 `DATABASE_URL` 时使用本地 `backend/school_posts.db`

## 本地运行

```bash
cd backend
pip install -r requirements.txt
python3 db_init.py     # 首次建本地 SQLite
python3 app.py         # http://127.0.0.1:5000
```

## 目录

```
index.html / login.html / register.html / admin.html   页面
style.css                                              全部样式（颜色走 :root 变量）
js/auth.js / js/script.js                              登录态、首页与详情弹窗逻辑
backend/app.py                                         全部 API、鉴权与 _migrate()
backend/schema.sql / db_init.py                        本地 SQLite 建表
detail.html / post.html / js/detail.js / js/post.js    历史遗留页面，首页不使用
```

## 环境变量（Render → Environment）

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | Supabase PostgreSQL 连接串；不配则走本地 SQLite |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 管理员账号，服务启动时同步 |
| `SMTP_HOST/PORT/USER/PASS` | 邮件验证码备用能力，当前注册流程不使用 |
| `SUPABASE_URL` | Supabase 项目地址（`https://xxxx.supabase.co`） |
| `SUPABASE_SERVICE_KEY` | Supabase 服务端密钥（secret / service_role），只配在 Render |
| `SUPABASE_BUCKET` | 图片存储桶名（当前为 `Ywies`，Public 读） |

**任何密钥、连接串、授权码都不要提交进仓库或在对话里明文出现。**

## 图片

- 前端选择图片后自动压缩（最长边 1600px，JPEG，单张 ≤10MB），逐张上传到 Supabase Storage，帖子只存公开 URL
- `posts.image_url` 存封面（第一张），`posts.images` 存 JSON 数组；老帖只有 `image_url` 时接口自动回退成单图数组
- `POST /api/upload`（登录）接收 multipart `file`，返回 `{"url": "..."}`
- `GET /api/config` 返回 `max_post_images`（当前 9）与上传是否可用
- 图片删除暂不联动 Storage，删帖只删记录；后续可做清理任务

## 等级与图片张数

- 等级 → 单帖最多图片：Lv1 3 张 / Lv2 5 张 / Lv3 7 张 / Lv4 9 张
- 按发帖数升级：0 帖 Lv1、3 帖 Lv2、10 帖 Lv3、30 帖 Lv4；管理员固定 Lv4
- 唯一真源：`backend/app.py` 的 `LEVEL_IMAGE_LIMITS` / `LEVEL_POST_THRESHOLDS`
- `/api/config` 按当前登录用户返回 `level` 与 `max_post_images`

## 点赞与投币

- 帖子点赞：`post_likes` 按账号去重，可点赞/取消，换设备状态一致
- 帖子投币：`post_coins` 按账号去重，投出后不能撤回（接口拒绝 `on:false`，按钮禁用）
- 首次升级会清零没有账号归属的历史帖子点赞/投币计数

## 私信

- `messages` 表：sender / receiver / content / is_read / created_at
- `GET /api/messages`：会话列表（含未读数）
- `GET /api/messages/<username>`：与某人的最近 200 条，读取时把对方发来的标为已读
- `POST /api/messages/<username>`：发送，最多 1000 字，同时给对方写一条通知
- 只能看到自己参与的会话；不能给自己发

## Render 免费实例休眠

- Render Free 闲置约 15 分钟会休眠，下次访问会显示 “APPLICATION LOADING”，冷启动约 20–50 秒
- 想彻底消除：升级 Render Starter（常驻实例）
- 免费方案：用 UptimeRobot 等外部监控每 5 分钟请求一次 `/api/health`，保持实例与 Supabase 活跃
- 注意免费额度约 750 实例小时/月，24/7 运行约 744 小时，不要超额

## 登录态与刷新

- 登录使用 `sessions` 表，同一账号可多设备同时在线，每个 token 独立有效 30 天
- 升级时旧 `users.token` 会自动迁入 `sessions`；退出只注销当前设备
- 首页左下角「刷新」按钮为站内刷新：重新拉帖子/标签/通知/私信，不调用浏览器刷新

## 性能与加载

- 列表/详情接口不再返回 base64 图片；历史图片走 `/media/posts/<id>`，浏览器强缓存
- 首页把最近 50 帖缓存到 localStorage，先渲染缓存再后台刷新；失败自动重试（2s/5s/10s/20s），60 秒超时
- API 响应 `Cache-Control: no-store`，HTML `no-cache`，避免平板缓存旧空列表

## 评论

- 支持评论点赞：`POST /api/posts/<id>/comments/<cid>/like`，按账号去重（`comment_likes` 表），换设备状态一致
- 支持一层回复：回复的回复会归到最上层评论下，并显示「回复 @某人」
- 删除根评论会级联删除其下回复
- 回复会通知被回复的人（与帖子作者通知去重）
- 首次升级会清零没有账号归属的历史评论点赞计数

## 部署

Render Web Service，`main` 分支 push 后自动构建部署：

- Build：`pip install -r backend/requirements.txt`
- Start：`cd backend && python app.py`
- 生产模式：未设置 `FLASK_DEBUG` 时由 **Waitress** 多线程 WSGI 承载（6 线程），不使用 Flask/Werkzeug 开发服务器
- 自检：`GET /api/health` 返回当前 commit 与数据库类型（不暴露密钥）

Free 套餐闲置约 15 分钟休眠，冷启动可能需要 50 秒以上；线上数据落在 Supabase，不依赖本地 SQLite 文件。

## 维护约定

- 颜色统一用 `style.css` 顶部的 `:root` 变量，不在组件里写死色值
- 新增表/列写在 `backend/app.py` 的 `_migrate()` 里，SQLite 与 PostgreSQL 都能跑
- 密码只存哈希；接口错误统一 `{"error": "..."}`；前端请求走 `js/auth.js`
