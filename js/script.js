// ============================================
// 首页逻辑：从 Flask 后端拉帖子列表，渲染成绳网风瀑布流卡片
// 后端接口：GET http://127.0.0.1:5000/api/posts
// ============================================

const API = 'http://127.0.0.1:5000/api/posts';

window.addEventListener('DOMContentLoaded', function () {
    fetchPosts();
    bindFilterTabs();
});

async function fetchPosts() {
    const list = document.getElementById('post-list');
    try {
        const res = await fetch(API);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        // 后端可能直接返回数组，也可能包一层 {posts:[...]} 或 {data:[...]}
        const posts = Array.isArray(data) ? data : (data.posts || data.data || []);
        renderPosts(posts);
    } catch (e) {
        console.warn('[首页] 拉取 /api/posts 失败，使用示例数据：', e.message);
        renderPosts(SAMPLE_POSTS);
    }
}

function renderPosts(posts) {
    const list = document.getElementById('post-list');
    list.innerHTML = '';
    if (!posts || !posts.length) {
        document.getElementById('empty-state').hidden = false;
        return;
    }
    posts.forEach(function (p) {
        list.appendChild(createCard(p));
    });
}

// 后端字段名不确定，这里做一层兼容：依次尝试多个可能的 key
function pick(obj, keys, fallback) {
    for (let i = 0; i < keys.length; i++) {
        const v = obj[keys[i]];
        if (v !== undefined && v !== null && v !== '') return v;
    }
    return fallback;
}

const AVATAR_COLORS = ['#c6dd4e', '#6ec6ff', '#ff9ec6', '#ffd46e', '#9ad6c0', '#c9a8ff'];

function createCard(p) {
    const id       = pick(p, ['id', '_id', 'post_id'], 0);
    const author    = pick(p, ['author', 'username', 'nickname', 'name', 'user_name'], '匿名同学');
    const avatarUrl = pick(p, ['avatar', 'avatar_url', 'user_avatar', 'head_url'], '');
    const image     = pick(p, ['image', 'image_url', 'pic', 'cover', 'imageUrl', 'img'], '');
    const title     = pick(p, ['title'], '');
    const text      = pick(p, ['content', 'text', 'body', 'description'], '');
    const views     = pick(p, ['views', 'view_count', 'views_count', 'read_count'], 0);
    const replies   = pick(p, ['replies', 'reply_count', 'comments', 'comment_count'], 0);

    const card = document.createElement('article');
    card.className = 'post-card' + (image ? '' : ' no-media');
    card.addEventListener('click', function () {
        // 预留详情页入口
        window.location.href = 'detail.html?id=' + id;
    });

    // 浏览量角标
    const viewsEl = document.createElement('div');
    viewsEl.className = 'card-views';
    viewsEl.innerHTML = '<span>👁</span><span>' + formatNum(views) + '</span>';
    card.appendChild(viewsEl);

    // 配图（可选）
    if (image) {
        const media = document.createElement('div');
        media.className = 'card-media';
        const img = document.createElement('img');
        img.src = image;
        img.alt = '';
        img.loading = 'lazy';
        // 图片挂了就自动降级成无图卡片，避免头像被拉空
        img.onerror = function () {
            media.remove();
            card.classList.add('no-media');
        };
        media.appendChild(img);
        card.appendChild(media);
    }

    // 作者行
    const authorRow = document.createElement('div');
    authorRow.className = 'card-author';
    let avatarHtml;
    if (avatarUrl) {
        avatarHtml = '<div class="avatar"><img src="' + avatarUrl + '" alt=""></div>';
    } else {
        const color = AVATAR_COLORS[Math.abs(hashCode(author)) % AVATAR_COLORS.length];
        avatarHtml = '<div class="avatar" style="background:' + color + ';color:#1a1a10;">'
                   + escapeHtml(author.charAt(0).toUpperCase()) + '</div>';
    }
    authorRow.innerHTML = avatarHtml + '<span class="author-name">' + escapeHtml(author) + '</span>';
    card.appendChild(authorRow);

    // 正文预览
    const body = document.createElement('div');
    body.className = 'card-body';
    const textEl = document.createElement('p');
    textEl.className = 'card-text';
    const fullText = title ? (title + (text ? '\n' + text : '')) : text;
    textEl.textContent = fullText || '（无内容）';
    body.appendChild(textEl);

    // 回复数
    if (Number(replies) > 0) {
        const r = document.createElement('div');
        r.className = 'card-replies';
        r.innerHTML = '<span>💬</span><span>' + formatNum(replies) + '</span>';
        body.appendChild(r);
    }

    card.appendChild(body);
    return card;
}

function formatNum(n) {
    n = Number(n) || 0;
    if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
    if (n >= 1000)  return (n / 1000).toFixed(1) + 'k';
    return String(n);
}

function hashCode(s) {
    let h = 0;
    s = String(s);
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return h;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// 筛选标签：先做视觉切换，真实过滤以后再做
function bindFilterTabs() {
    document.querySelectorAll('.filter-pill').forEach(function (btn) {
        btn.addEventListener('click', function () {
            document.querySelectorAll('.filter-pill').forEach(function (b) {
                b.classList.remove('active');
            });
            btn.classList.add('active');
        });
    });
}

// 后端没通时的示例数据，保证 UI 不是空的
const SAMPLE_POSTS = [
    {
        id: 1,
        author: 'AAA小雷音寺住持',
        title: '有人来换越狱牌吗',
        content: '有三张多的可以换',
        views: 11,
        replies: 0
    },
    {
        id: 2,
        author: '绳网用户11451415',
        image: 'https://picsum.photos/seed/shipdeck/600/720',
        content: '这个绳网人均每天至少一个善善~（1/100）百人善楼',
        views: 263,
        replies: 3
    },
    {
        id: 3,
        author: '新艾利都治安局青衣',
        content: '你举报的委托《刚来，这里就是暗网吗》已处理完毕，感谢你维护绳网环境！处理备注：已通知发帖人处理。\n\n额，跟没有处理一样\n我没招了',
        views: 44,
        replies: 5
    },
    {
        id: 4,
        author: '千早愛音',
        image: 'https://picsum.photos/seed/keyan/600/520',
        title: '爱素 1~2 [繁中]',
        content: 'https://drive.google.com/file/d/1XwoacpqhU8T3Db1T...',
        views: 16,
        replies: 1
    },
    {
        id: 5,
        author: '娶小光师姐回家',
        content: '每日一水\nrt，依旧没有图',
        views: 10,
        replies: 2
    },
    {
        id: 6,
        author: 'AAA反舌鸟神秘金',
        image: 'https://picsum.photos/seed/gachavictory/600/640',
        content: '贝果计划第一次破千万喵',
        views: 12,
        replies: 1
    },
    {
        id: 7,
        author: 'YWIES路人甲',
        content: 'CCA 招新有没有一起组队做机器人的？我们还差一个机械臂手，有兴趣的同学评论区扣 1',
        views: 88,
        replies: 14
    },
    {
        id: 8,
        author: '食堂常客',
        image: 'https://picsum.photos/seed/canteen/600/480',
        title: '三楼今天的麻辣香锅绝了',
        content: '推荐加牛肉和藕片，排队大概 15 分钟，亲测不踩雷',
        views: 156,
        replies: 9
    }
];
