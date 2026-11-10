// ============================================
// 首页逻辑：极简 BBS 列表 + 详情弹窗
// ============================================

const API = 'http://127.0.0.1:5000/api/posts';

let allPosts = [];
let currentTab = 'latest';
let currentTag = '';
let searchQuery = '';
let currentPost = null;       // 弹窗里正在看的帖子
let allComments = [];          // 当前帖子的全部评论
let commentSort = 'earliest';  // earliest | latest

// localStorage 键
const K_READ = 'ywies_read';
const K_BOOKMARK = 'ywies_bookmarked';
const K_FOLLOW = 'ywies_following';
const K_LIKED = 'ywies_liked';
const K_COINED = 'ywies_coined';

window.addEventListener('DOMContentLoaded', function () {
    fetchPosts();
    bindTabs();
    bindTags();
    bindSearch();
    bindBell();
    bindDetailModal();
});

async function fetchPosts() {
    try {
        const res = await fetch(API);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        allPosts = Array.isArray(data) ? data : (data.posts || data.data || []);
    } catch (e) {
        console.warn('[首页] 拉取失败，使用示例数据：', e.message);
        allPosts = [];
    }
    render();
}

// ---------- 列表渲染 ----------
function render() {
    let list = allPosts.slice();

    if (currentTag) {
        list = list.filter(function (p) {
            return (p.tags || '').includes(currentTag);
        });
    }
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter(function (p) {
            return (p.title || '').toLowerCase().includes(q) ||
                   (p.content || '').toLowerCase().includes(q) ||
                   (p.author || '').toLowerCase().includes(q);
        });
    }

    if (currentTab === 'latest') list.sort(function (a, b) { return b.id - a.id; });
    else if (currentTab === 'hot') list.sort(function (a, b) { return (b.views || 0) - (a.views || 0); });
    else if (currentTab === 'unread') {
        const read = getRead();
        list = list.filter(function (p) { return read.indexOf(p.id) === -1; });
        list.sort(function (a, b) { return b.id - a.id; });
    } else if (currentTab === 'followed') {
        const following = getFollowing();
        list = list.filter(function (p) { return following.indexOf(p.author) !== -1; });
    } else if (currentTab === 'bookmarked') {
        const bm = getBookmarks();
        list = list.filter(function (p) { return bm.indexOf(p.id) !== -1; });
    } else if (currentTab === 'all') list.sort(function (a, b) { return b.id - a.id; });

    renderList(list);
}

function renderList(list) {
    const wrap = document.getElementById('postList');
    const empty = document.getElementById('emptyState');
    wrap.innerHTML = '';
    if (!list.length) { empty.hidden = false; return; }
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

        row.addEventListener('click', function (e) {
            if (e.target.classList.contains('star-btn')) return;
            if (e.target.tagName === 'A') return;
            markRead(p.id);
            openDetail(p.id);
        });

        row.querySelector('.star-btn').addEventListener('click', function (e) {
            e.stopPropagation();
            toggleBookmark(p.id);
        });

        const authorLink = row.querySelector('.col-author a');
        if (authorLink) {
            authorLink.addEventListener('click', function (e) {
                e.stopPropagation();
                const name = this.getAttribute('data-author');
                alert('用户：' + name + '\n（用户主页正在建设中）');
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
        { title: '欢迎来到 YWIES 论坛', text: '这里是我们学校自己的校园论坛，欢迎发帖交流。', time: '2026-11-10' },
        { title: '举报处理回执', text: '你举报的帖子已处理完毕。', time: '2026-11-09' },
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

// ---------- 详情弹窗 ----------
function bindDetailModal() {
    document.getElementById('detailClose').addEventListener('click', closeDetail);
    document.getElementById('detailModal').addEventListener('click', function (e) {
        if (e.target === this) closeDetail();
    });
    document.querySelectorAll('.sort-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            document.querySelectorAll('.sort-btn').forEach(function (b) { b.classList.remove('active'); });
            btn.classList.add('active');
            commentSort = btn.getAttribute('data-sort');
            renderComments();
        });
    });
    document.getElementById('footerLike').addEventListener('click', function () {
        if (!currentPost) return;
        const liked = getLiked();
        const idx = liked.indexOf(currentPost.id);
        if (idx === -1) { liked.push(currentPost.id); currentPost.likes = (currentPost.likes || 0) + 1; }
        else { liked.splice(idx, 1); currentPost.likes = (currentPost.likes || 0) - 1; }
        localStorage.setItem(K_LIKED, JSON.stringify(liked));
        updateFooterButtons();
    });
    document.getElementById('footerCoin').addEventListener('click', function () {
        if (!currentPost) return;
        const coined = getCoined();
        const idx = coined.indexOf(currentPost.id);
        if (idx === -1) { coined.push(currentPost.id); currentPost.coins = (currentPost.coins || 0) + 1; }
        else { coined.splice(idx, 1); currentPost.coins = (currentPost.coins || 0) - 1; }
        localStorage.setItem(K_COINED, JSON.stringify(coined));
        updateFooterButtons();
    });
    document.getElementById('footerStar').addEventListener('click', function () {
        if (!currentPost) return;
        toggleBookmark(currentPost.id);
        updateFooterButtons();
    });
    document.getElementById('commentInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') submitComment();
    });
}

async function openDetail(postId) {
    try {
        const res = await fetch(API + '/' + postId);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        currentPost = await res.json();
    } catch (e) {
        console.warn('[详情] 拉取失败', e);
        return;
    }
    try {
        const res = await fetch(API + '/' + postId + '/comments');
        allComments = res.ok ? await res.json() : [];
    } catch (e) { allComments = []; }

    renderDetail();
    document.getElementById('detailModal').hidden = false;
    document.body.style.overflow = 'hidden';
}

function closeDetail() {
    document.getElementById('detailModal').hidden = true;
    document.body.style.overflow = '';
    currentPost = null;
    allComments = [];
    render();
}

function renderDetail() {
    const p = currentPost;
    const imgEl = document.getElementById('detailImg');
    if (p.image) imgEl.innerHTML = '<img src="' + escapeHtml(p.image) + '">';
    else imgEl.innerHTML = '';
    document.getElementById('detailAuthorName').textContent = p.author || '匿名';
    document.getElementById('detailLikes').textContent = '♥ ' + (p.likes || 0);
    document.getElementById('detailTitle').textContent = p.title || '无标题';
    document.getElementById('detailContent').textContent = p.content || '';
    document.getElementById('detailTime').textContent = formatTime(p.created_at);
    document.getElementById('commentCount').textContent = allComments.length;
    renderComments();
    updateFooterButtons();
}

function renderComments() {
    const list = document.getElementById('commentsList');
    const sorted = allComments.slice();
    if (commentSort === 'latest') sorted.reverse();
    if (!sorted.length) {
        list.innerHTML = '<div style="color:#6b6b76;font-size:13px;padding:20px 0;text-align:center;">还没有评论，来说点什么吧</div>';
        return;
    }
    const author = currentPost ? currentPost.author : '';
    list.innerHTML = sorted.map(function (c, i) {
        const floor = commentSort === 'earliest' ? (i + 1) : (sorted.length - i);
        const isAuthor = c.author === author;
        return '<div class="comment-item">' +
            '<div class="comment-head">' +
                '<div class="comment-avatar"></div>' +
                '<span class="comment-name">' + escapeHtml(c.author) + '</span>' +
                (isAuthor ? '<span class="comment-author-tag">楼主</span>' : '') +
                '<span class="comment-floor">' + floor + 'F</span>' +
            '</div>' +
            '<div class="comment-text">' + escapeHtml(c.content) + '</div>' +
            '<div class="comment-time">' + formatTime(c.created_at) + '</div>' +
        '</div>';
    }).join('');
}

async function submitComment() {
    const input = document.getElementById('commentInput');
    const text = input.value.trim();
    if (!text || !currentPost) return;
    try {
        await fetch(API + '/' + currentPost.id + '/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: text, author: '匿名同学' })
        });
        input.value = '';
        const res = await fetch(API + '/' + currentPost.id + '/comments');
        allComments = res.ok ? await res.json() : allComments;
        document.getElementById('commentCount').textContent = allComments.length;
        renderComments();
    } catch (e) {
        console.warn('[评论] 提交失败', e);
    }
}

function updateFooterButtons() {
    if (!currentPost) return;
    const liked = getLiked();
    const coined = getCoined();
    const bm = getBookmarks();
    document.getElementById('footerLikeCount').textContent = currentPost.likes || 0;
    document.getElementById('footerCoinCount').textContent = currentPost.coins || 0;
    document.getElementById('footerStarCount').textContent = bm.indexOf(currentPost.id) !== -1 ? 1 : 0;
    document.getElementById('footerLike').classList.toggle('active', liked.indexOf(currentPost.id) !== -1);
    document.getElementById('footerCoin').classList.toggle('active', coined.indexOf(currentPost.id) !== -1);
    document.getElementById('footerStar').classList.toggle('active', bm.indexOf(currentPost.id) !== -1);
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
function getLiked() { try { return JSON.parse(localStorage.getItem(K_LIKED) || '[]'); } catch (e) { return []; } }
function getCoined() { try { return JSON.parse(localStorage.getItem(K_COINED) || '[]'); } catch (e) { return []; } }

// ---------- 工具 ----------
function formatTime(t) {
    if (!t) return '-';
    const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return t;
    return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
}
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
