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

## 管理后台

- 地址：`https://ywies-forum.onrender.com/admin.html`
- 管理员账号：`管理员`，也可以直接用管理员邮箱 `admin@ywies.local` 登录
- 密码由 Render 环境变量 `ADMIN_PASSWORD` 控制；设置后会把管理员密码同步成该值。没有设置时本地默认是 `admin123`，线上务必设置一个强密码
- 想把**个人账号**提升为管理员：在 Render 设置 `ADMIN_USERNAME=你的论坛昵称`，可选设置 `ADMIN_PASSWORD=新密码`，保存并重启服务
- 注意：注册账号时保存的是 `昵称@ywies.local` 形式的占位邮箱，不是真实邮箱；因此只设置 `ADMIN_EMAIL=真实邮箱` 不会自动匹配个人账号，请优先用 `ADMIN_USERNAME`
- 提升成功后需要退出再重新登录，`is_admin` 才会写进本地登录态
- 功能：
  - 概览：用户/帖子/评论/管理员/硬币统计，最近帖子与用户
  - 帖子管理：搜索标题/正文/作者、有图/纯文字筛选、分页、查看详情、删除（写入删除快照）
  - 用户管理：搜索昵称/用户名/邮箱、查看主页、设为/取消管理员、重置临时密码、删除账号
  - 内容审查：最近评论、最近帖子、删除快照；时间精确到秒
- 管理员不能取消自己的管理员权限，也不能重置/删除自己；至少保留一个管理员
- 重置用户密码会让该用户所有设备退出，并只显示一次临时密码
- 新设为管理员的账号需要重新登录后才会出现后台入口

## 环境变量（Render → Environment）

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | Supabase PostgreSQL 连接串；不配则走本地 SQLite |
| `ADMIN_USERNAME` | 要提升为管理员的论坛昵称（推荐，个人账号提权用这个） |
| `ADMIN_EMAIL` | 管理员邮箱；也可填论坛昵称/用户名匹配已有账号 |
| `ADMIN_PASSWORD` | 管理员密码；显式设置后会把指定管理员账号的密码同步成该值 |
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
- 帖子投币：`post_coins` 按账号去重，每次可选择投 1 币或 2 币；不能给自己的帖子投币；投出后不能撤回
- 硬币钱包：每个账号初始 10 币；每天首次登录/打开网站 +3 币（不发通知）；投币从余额扣除；顶部右上角显示余额
- 标签会显示在标题下方、正文之前（如 `#学习 #压力`），可以点击筛选，也可以直接用标签搜索
- 首次升级会清零没有账号归属的历史帖子点赞/投币计数

## 板块、发布选择器和投票

- 首页板块：全部 / 灌水 / 学习 / 音乐 / 投票 / 分享
- 点「发布」先选择作品类型，再进入对应表单
- 第一版：
  - 灌水、学习、分享、音乐都用普通文本表单；学习和分享的 Markdown、音乐外链放到下一版
  - 投票可创建 2–6 个选项，一人一票，显示票数和百分比
- 数据：`posts.board`（general/study/music/poll/share）、`posts.kind`（post/poll）、`posts.format`
- 投票表：`polls` / `poll_options` / `poll_votes`
- 投票以后可以放进学习/分享板块，`board` 和 `kind` 是分开的

## 收藏、点赞与个人主页

- 首页不再有「收藏」和「全部」Tab，保留：最新 / 热门 / 未看 / 关注
- 收藏改为服务端 `bookmarks` 表，跨设备同步
- 帖子详情的星标按钮可收藏/取消收藏
- 个人主页新增「作品 / 点赞 / 收藏」切换
- 用户可以分别设置是否公开自己的点赞列表和收藏列表；默认私密
- 公开后其他用户可在个人主页看到；私密时只有自己可见
- 迁移：`users.likes_public`、`users.bookmarks_public`

## Markdown 笔记 / 音乐 / 代码块 / 图集

- 学习、分享板块使用 Markdown 笔记：`kind=note`、`format=markdown`
- 发布表单提供工具栏：加粗、斜体、标题、列表、引用、代码块、链接、图片；支持编辑/预览
- Markdown 在后端用 `markdown` 渲染、`bleach` 清洗，禁止脚本和 `javascript:` 链接
- 代码块支持一键复制
- 音乐板块为结构化外链：歌曲名（标题）、歌手（`music_artist`）、外链（`music_url`），不上传音频；详情页显示外链按钮
- 多图帖显示图片数量角标，详情支持上一张/下一张、计数、缩略图和原图查看
- 后端依赖新增：`markdown`、`bleach`（见 `backend/requirements.txt`）

## 一键三连 / 未读数字 / 头像

- 帖子详情长按点赞按钮约 0.8 秒，点赞按钮外圈会顺时针画圆；画满后自动完成点赞、投币 2 币、收藏
- 自己的帖子只完成点赞和收藏，不能投币
- 已经点过赞/投过币/收藏过的项目不会重复执行；硬币不足时点赞和收藏仍会成功，并提示投币失败
- 通知和消息的未读提示改为带数字的橙色圆形角标，超过 99 显示 99+
- 帖子详情作者头像、评论/回复头像从 `users.avatar` 读取；没有头像时显示昵称首字
- 长按三连的投币金额固定为 2 币

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

## @提及与通知传送门

- 评论输入 `@` 会出现用户候选，可点击或方向键+回车插入；直接手打 `@用户名` 也会被识别
- 被 @ 的用户会收到通知，通知带 `post_id`
- 点赞、投币、评论、回复、@ 的通知都会带帖子 ID，点击通知可直接打开对应帖子
- 私信通知没有帖子传送门（`post_id = 0`）

## 个人主页

- 点击右上角头像或帖子作者进入整页个人主页
- 展示头像、昵称、评论/点赞/关注/粉丝、简介、作品瀑布流
- 关注/粉丝可打开列表弹窗并切换查看
- 自己的主页可点击昵称旁铅笔修改头像、昵称、简介和背景；图片上传到 Supabase
- 修改昵称会同步修改登录名，并更新历史帖子/评论署名、点赞、投币、已读、关注、私信、通知等记录
- 关注关系保存在 `follows` 表，“关注”Tab 按账号同步

## 已读/未看

- 已读状态保存在服务端 `post_reads`，同一账号换设备后「未看」也会同步
- 打开帖子详情即标记已读；本地缓存会在登录后与服务器合并
- 未读帖子在主页卡片上标题显示橙色，读过后恢复黑色

## 评论防重复

- 评论提交中会锁定，连续按回车只会发出一条；失败后自动解锁

## 时间显示与内容审查

- 普通用户只看到相对时间：刚刚、N 分钟前、N 小时前、1–29 天前；超过 29 天显示日期（如 `10月20日`），不显示几点几分
- 非管理员的 API 不再返回原始 `created_at`，只返回中英文相对时间字段，避免从接口里直接拿到精确时间
- 管理员登录后，帖子详情、评论、私信等会显示精确到秒的本地时间；后台新增「内容审查」和「删除记录」
- 删除帖子/评论时会把内容快照写入 `audit_log`，之后可以在后台查看，避免内容删掉后无法追溯
- 需要直接看原始数据时，用 Supabase Table Editor / SQL 查看 `posts`、`comments`、`users` 的 `created_at`（UTC）；只给负责团队开权限
- 增加管理员：在 Supabase SQL 里执行 `UPDATE users SET is_admin=1 WHERE username='用户名';`，重新登录后出现「后台」入口

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
