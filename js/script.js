// ============================================
// 首页逻辑：极简 BBS 列表
// 后端：GET /api/posts
// ============================================

const API = 'http://127.0.0.1:5000/api/posts';

let allPosts = [];
let currentTab = 'latest';
let currentTag = '';
let searchQuery = '';

// localStorage 键
const K_READ = 'ywies_read';
const K_BOOKMARK = 'ywies_bookmarked';
const K_FOLLOW = 'ywies_following';

window.addEventListener('DOMContentLoaded', function () {
    fetchPosts();
    bindTabs();
    bindTags();
    bindSearch();
    bindBell();
});

async function fetchPosts() {
    try {
        const res = await fetch(API);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        allPosts = Array.isArray(data) ? data : (data.posts || data.data || []);
    } catch (e) {
        console.warn('[首页] 拉取失败，使用示例数据：', e.message);
        allPosts = SAMPLE_POSTS;
    }
    render();
}

// ---------- 渲染 ----------
function render() {
    let list = allPosts.slice();

    // 标签筛选
    if (currentTag) {
        list = list.filter(function (p) {
            return (p.tags || '').includes(currentTag);
        });
    }

    // 搜索
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter(function (p) {
            return (p.title || '').toLowerCase().includes(q) ||
                   (p.content || '').toLowerCase().includes(q) ||
                   (p.author || '').toLowerCase().includes(q);
        });
    }

    // Tab 排序/过滤
    if (currentTab === 'latest') {
        list.sort(function (a, b) { return b.id - a.id; });
    } else if (currentTab === 'hot') {
        list.sort(function (a, b) { return (b.views || 0) - (a.views || 0); });
    } else if (currentTab === 'unread') {
        const read = getRead();
        list = list.filter(function (p) { return read.indexOf(p.id) === -1; });
        list.sort(function (a, b) { return b.id - a.id; });
    } else if (currentTab === 'followed') {
        const following = getFollowing();
        list = list.filter(function (p) { return following.indexOf(p.author) !== -1; });
    } else if (currentTab === 'bookmarked') {
        const bm = getBookmarks();
        list = list.filter(function (p) { return bm.indexOf(p.id) !== -1; });
    }
    // all = 不过滤，按 id 倒序
    if (currentTab === 'all') {
        list.sort(function (a, b) { return b.id - a.id; });
    }

    renderList(list);
}

function renderList(list) {
    const wrap = document.getElementById('postList');
    const empty = document.getElementById('emptyState');
    wrap.innerHTML = '';

    if (!list.length) {
        empty.hidden = false;
        return;
    }
    empty.hidden = true;

    const read = getRead();
    const bm = getBookmarks();

    list.forEach(function (p) {
        const row = document.createElement('div');
        row.className = 'post-row';

        const isRead = read.indexOf(p.id) !== -1;
        const isBm = bm.indexOf(p.id) !== -1;

        row.innerHTML =
            '<span class="' + (isRead ? 'read-dot' : 'unread-dot') + '"></span>' +
            '<div class="col-main">' +
                '<span class="post-title">' + escapeHtml(p.title || '无标题') + '</span>' +
                (p.tags ? '<span class="post-tag">' + escapeHtml(p.tags.split(',')[0]) + '</span>' : '') +
            '</div>' +
            '<span class="col-author"><a href="javascript:void(0)" data-author="' + escapeHtml(p.author) + '">' + escapeHtml(p.author || '匿名') + '</a></span>' +
            '<span class="col-replies">' + (p.replies || 0) + '</span>' +
            '<span class="col-views">' + (p.views || 0) + '</span>' +
            '<span class="col-time">' + formatTime(p.created_at) + '</span>' +
            '<button class="star-btn' + (isBm ? ' starred' : '') + '" data-id="' + p.id + '" title="收藏">' + (isBm ? '★' : '☆') + '</button>';

        // 点击整行 → 详情页，标记已读
        row.addEventListener('click', function (e) {
            if (e.target.classList.contains('star-btn')) return;
            if (e.target.tagName === 'A') return;
            markRead(p.id);
            window.location.href = 'detail.html?id=' + p.id;
        });

        // 收藏
        row.querySelector('.star-btn').addEventListener('click', function (e) {
            e.stopPropagation();
            toggleBookmark(p.id);
        });

        // 作者名 → 用户主页（简单 alert，以后再做独立页面）
        const authorLink = row.querySelector('.col-author a');
        if (authorLink) {
            authorLink.addEventListener('click', function (e) {
                e.stopPropagation();
                const name = this.getAttribute('data-author');
                alert('用户：' + name + '\n（用户主页正在建设中，以后可查看该用户所有帖子）');
            });
        }

        wrap.appendChild(row);
    });
}

// ---------- 交互绑定 ----------
function bindTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
            tab.classList.add('active');
            currentTab = tab.getAttribute('data-tab');
            render();
        });
    });
}

function bindTags() {
    document.querySelectorAll('.tag-pill').forEach(function (pill) {
        pill.addEventListener('click', function () {
            document.querySelectorAll('.tag-pill').forEach(function (p) { p.classList.remove('active'); });
            pill.classList.add('active');
            currentTag = pill.getAttribute('data-tag');
            render();
        });
    });
}

function bindSearch() {
    document.getElementById('searchInput').addEventListener('input', function (e) {
        searchQuery = e.target.value.trim();
        render();
    });
}

function bindBell() {
    document.getElementById('bellBtn').addEventListener('click', function () {
        renderNotifs();
        document.getElementById('notifModal').hidden = false;
        document.getElementById('bellDot').hidden = true;
    });
    document.getElementById('notifClose').addEventListener('click', function () {
        document.getElementById('notifModal').hidden = true;
    });
    document.getElementById('notifModal').addEventListener('click', function (e) {
        if (e.target === this) this.hidden = true;
    });
}

// ---------- 通知 ----------
function renderNotifs() {
    const list = document.getElementById('notifList');
    const notifs = [
        { title: '欢迎来到 YWIES 论坛', text: '这里是我们学校自己的校园论坛，欢迎发帖交流、社团组队、物品交换。', time: '2026-11-10' },
        { title: '举报处理回执', text: '你举报的帖子已处理完毕，感谢你维护论坛环境。', time: '2026-11-09' },
        { title: '系统通知', text: '论坛 1.0 版本上线，如有 bug 请联系学生会。', time: '2026-11-08' }
    ];
    list.innerHTML = notifs.map(function (n) {
        return '<div class="notif-item">' +
            '<div class="notif-title">' + escapeHtml(n.title) + '</div>' +
            '<div class="notif-text">' + escapeHtml(n.text) + '</div>' +
            '<div class="notif-time">' + escapeHtml(n.time) + '</div>' +
        '</div>';
    }).join('');
}

// ---------- localStorage 工具 ----------
function getRead() { try { return JSON.parse(localStorage.getItem(K_READ) || '[]'); } catch (e) { return []; } }
function markRead(id) {
    const r = getRead();
    if (r.indexOf(id) === -1) { r.push(id); localStorage.setItem(K_READ, JSON.stringify(r)); }
}
function getBookmarks() { try { return JSON.parse(localStorage.getItem(K_BOOKMARK) || '[]'); } catch (e) { return []; } }
function toggleBookmark(id) {
    const bm = getBookmarks();
    const i = bm.indexOf(id);
    if (i === -1) bm.push(id); else bm.splice(i, 1);
    localStorage.setItem(K_BOOKMARK, JSON.stringify(bm));
    render();
}
function getFollowing() { try { return JSON.parse(localStorage.getItem(K_FOLLOW) || '[]'); } catch (e) { return []; } }

// ---------- 工具 ----------
function formatTime(t) {
    if (!t) return '-';
    // 2026-11-10 03:06:20 → 11-10 03:06
    const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return t;
    return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
}

function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

// 后端没通时的示例数据
const SAMPLE_POSTS = [
    { id: 4, title: '有人来换越狱牌吗', content: '有三张多的可以换', author: 'AAA小雷音寺住持', tags: '物品交换', views: 32, replies: 0, created_at: '2026-11-10 03:06:20' },
    { id: 3, title: '三楼食堂今天的麻辣香锅绝了', content: '推荐加牛肉和藕片，排队大概 15 分钟', author: '食堂常客', tags: '食堂', views: 210, replies: 2, created_at: '2026-11-10 03:06:20' },
    { id: 2, title: 'CCA 招新｜机器人组还差一个机械臂手', content: '下周招新，零基础也能教', author: 'RoboRay', tags: '社团招新', views: 86, replies: 1, created_at: '2026-11-10 03:06:20' },
    { id: 1, title: '欢迎来到 YWIES 论坛', content: '这里是我们学校自己的校园论坛', author: '论坛管理员', tags: '闲聊', views: 128, replies: 2, created_at: '2026-11-10 03:06:20' }
];
