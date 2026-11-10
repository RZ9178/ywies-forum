// ============================================
// 首页逻辑：极简 BBS 列表 + 详情弹窗 + 发帖弹窗
// ============================================

const API = 'http://127.0.0.1:5000/api/posts';
const TAGS_API = 'http://127.0.0.1:5000/api/tags';

let allPosts = [];
let allTags = [];
let currentTab = 'latest';
let currentTag = '';
let searchQuery = '';
let currentPost = null;
let allComments = [];
let commentSort = 'earliest';
let selectedTags = [];
let uploadedImage = '';

const K_READ = 'ywies_read';
const K_BOOKMARK = 'ywies_bookmarked';
const K_FOLLOW = 'ywies_following';
const K_LIKED = 'ywies_liked';
const K_COINED = 'ywies_coined';
const K_AUTHOR = 'ywies_author';

window.addEventListener('DOMContentLoaded', function () {
    fetchPosts();
    fetchTags();
    bindTabs();
    bindSearch();
    bindBell();
    bindDetailModal();
    bindPostModal();
});

async function fetchPosts() {
    try {
        const res = await fetch(API);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        allPosts = await res.json();
    } catch (e) {
        console.warn('[首页] 拉取失败：', e.message);
        allPosts = [];
    }
    render();
}

async function fetchTags() {
    try {
        const res = await fetch(TAGS_API);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        allTags = await res.json();
    } catch (e) { allTags = []; }
    renderTagBar();
}

// ---------- 标签栏 ----------
function renderTagBar() {
    const bar = document.getElementById('tagBar');
    let html = '<button class="tag-pill' + (currentTag === '' ? ' active' : '') + '" data-tag="">全部</button>';
    allTags.forEach(function (t) {
        const name = t.name;
        html += '<button class="tag-pill' + (currentTag === name ? ' active' : '') + '" data-tag="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
    });
    bar.innerHTML = html;
    bar.querySelectorAll('.tag-pill').forEach(function (pill) {
        pill.addEventListener('click', function () {
            currentTag = pill.getAttribute('data-tag');
            renderTagBar();
            render();
        });
    });
}

// ---------- 列表渲染 ----------
function render() {
    let list = allPosts.slice();
    if (currentTag) list = list.filter(function (p) { return (p.tags || '').includes(currentTag); });
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter(function (p) {
            return (p.title || '').toLowerCase().includes(q) ||
                   (p.content || '').toLowerCase().includes(q) ||
                   (p.author || '').toLowerCase().includes(q);
        });
    }
    if (currentTab === 'latest' || currentTab === 'all') list.sort(function (a, b) { return b.id - a.id; });
    else if (currentTab === 'hot') list.sort(function (a, b) { return (b.views || 0) - (a.views || 0); });
    else if (currentTab === 'unread') {
        const read = getRead();
        list = list.filter(function (p) { return read.indexOf(p.id) === -1; })
                   .sort(function (a, b) { return b.id - a.id; });
    } else if (currentTab === 'followed') {
        const following = getFollowing();
        list = list.filter(function (p) { return following.indexOf(p.author) !== -1; });
    } else if (currentTab === 'bookmarked') {
        const bm = getBookmarks();
        list = list.filter(function (p) { return bm.indexOf(p.id) !== -1; });
    }
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
        const firstTag = (p.tags || '').split(',')[0].trim();

        row.innerHTML =
            '<span class="' + (isRead ? 'read-dot' : 'unread-dot') + '"></span>' +
            '<div class="col-main">' +
                '<span class="post-title">' + escapeHtml(p.title || '无标题') + '</span>' +
                (firstTag ? '<span class="post-tag">' + escapeHtml(firstTag) + '</span>' : '') +
                (p.image ? '<span class="post-img-icon">🖼</span>' : '') +
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
        if (authorLink) authorLink.addEventListener('click', function (e) {
            e.stopPropagation();
            alert('用户：' + this.getAttribute('data-author') + '\n（用户主页正在建设中）');
        });
        wrap.appendChild(row);
    });
}

// ---------- Tab / 搜索 / 通知 ----------
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
function renderNotifs() {
    const list = document.getElementById('notifList');
    const notifs = [
        { title: '欢迎来到 YWIES 论坛', text: '这里是我们学校自己的校园论坛，欢迎发帖交流。', time: '2026-11-10' },
        { title: '举报处理回执', text: '你举报的帖子已处理完毕。', time: '2026-11-09' },
        { title: '系统通知', text: '论坛 1.0 版本上线，如有 bug 请联系学生会。', time: '2026-11-08' }
    ];
    list.innerHTML = notifs.map(function (n) {
        return '<div class="notif-item"><div class="notif-title">' + escapeHtml(n.title) + '</div>' +
               '<div class="notif-text">' + escapeHtml(n.text) + '</div>' +
               '<div class="notif-time">' + escapeHtml(n.time) + '</div></div>';
    }).join('');
}

// ---------- 发帖弹窗 ----------
function bindPostModal() {
    document.getElementById('openPostBtn').addEventListener('click', openPostModal);
    document.getElementById('postClose').addEventListener('click', closePostModal);
    document.getElementById('postModal').addEventListener('click', function (e) {
        if (e.target === this) closePostModal();
    });

    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('postImage');
    uploadArea.addEventListener('click', function () { fileInput.click(); });
    uploadArea.addEventListener('dragover', function (e) { e.preventDefault(); });
    uploadArea.addEventListener('drop', function (e) {
        e.preventDefault();
        if (e.dataTransfer.files.length) handleImageFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', function () {
        if (this.files.length) handleImageFile(this.files[0]);
    });

    document.getElementById('newTagInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            const val = this.value.trim();
            if (val && selectedTags.indexOf(val) === -1) {
                selectedTags.push(val);
                this.value = '';
                renderTagPicker();
            }
        }
    });

    document.getElementById('submitPostBtn').addEventListener('click', submitPost);
}

function openPostModal() {
    document.getElementById('postAuthor').value = localStorage.getItem(K_AUTHOR) || '';
    document.getElementById('postTitle').value = '';
    document.getElementById('postContent').value = '';
    document.getElementById('postImage').value = '';
    document.getElementById('newTagInput').value = '';
    selectedTags = [];
    uploadedImage = '';
    document.getElementById('imagePreview').hidden = true;
    document.getElementById('uploadPlaceholder').style.display = '';
    renderTagPicker();
    document.getElementById('postModal').hidden = false;
    document.body.style.overflow = 'hidden';
}

function closePostModal() {
    document.getElementById('postModal').hidden = true;
    document.body.style.overflow = '';
}

function handleImageFile(file) {
    if (!file.type.startsWith('image/')) { alert('请上传图片文件'); return; }
    if (file.size > 2 * 1024 * 1024) { alert('图片太大，请压缩到 2MB 以内'); return; }
    const reader = new FileReader();
    reader.onload = function (e) {
        uploadedImage = e.target.result;
        const preview = document.getElementById('imagePreview');
        preview.src = uploadedImage;
        preview.hidden = false;
        document.getElementById('uploadPlaceholder').style.display = 'none';
    };
    reader.readAsDataURL(file);
}

function renderTagPicker() {
    const picker = document.getElementById('tagPicker');
    let html = '';
    allTags.forEach(function (t) {
        const name = t.name;
        const sel = selectedTags.indexOf(name) !== -1;
        html += '<span class="tag-option' + (sel ? ' selected' : '') + '" data-tag="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>';
    });
    selectedTags.forEach(function (name) {
        if (!allTags.find(function (t) { return t.name === name; })) {
            html += '<span class="tag-option selected" data-tag="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>';
        }
    });
    if (!allTags.length && !selectedTags.length) {
        html = '<span style="color:#6b6b76;font-size:13px;">暂无标签，在下方输入框输入新标签</span>';
    }
    picker.innerHTML = html;
    picker.querySelectorAll('.tag-option').forEach(function (el) {
        el.addEventListener('click', function () {
            const name = el.getAttribute('data-tag');
            const idx = selectedTags.indexOf(name);
            if (idx === -1) selectedTags.push(name); else selectedTags.splice(idx, 1);
            renderTagPicker();
        });
    });
}

async function submitPost() {
    const title = document.getElementById('postTitle').value.trim();
    const content = document.getElementById('postContent').value.trim();
    const author = document.getElementById('postAuthor').value.trim() || '匿名同学';

    if (!title) { alert('请输入标题'); return; }
    if (!content) { alert('请输入内容'); return; }

    localStorage.setItem(K_AUTHOR, author);

    const btn = document.getElementById('submitPostBtn');
    btn.disabled = true;
    btn.textContent = '发布中...';

    try {
        const res = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: title, content: content, author: author,
                tags: selectedTags.join(','), image: uploadedImage
            })
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || '发布失败');
        }
        closePostModal();
        await fetchPosts();
        await fetchTags();
    } catch (e) {
        alert('发布失败：' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '发布帖子';
    }
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
    } catch (e) { return; }
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
    document.getElementById('commentAuthor').value = localStorage.getItem(K_AUTHOR) || '';
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
    const authorInput = document.getElementById('commentAuthor');
    const text = input.value.trim();
    const author = authorInput.value.trim() || '匿名同学';
    if (!text || !currentPost) return;
    localStorage.setItem(K_AUTHOR, author);
    try {
        await fetch(API + '/' + currentPost.id + '/comments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: text, author: author })
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
    const liked = getLiked(), coined = getCoined(), bm = getBookmarks();
    document.getElementById('footerLikeCount').textContent = currentPost.likes || 0;
    document.getElementById('footerCoinCount').textContent = currentPost.coins || 0;
    document.getElementById('footerStarCount').textContent = bm.indexOf(currentPost.id) !== -1 ? 1 : 0;
    document.getElementById('footerLike').classList.toggle('active', liked.indexOf(currentPost.id) !== -1);
    document.getElementById('footerCoin').classList.toggle('active', coined.indexOf(currentPost.id) !== -1);
    document.getElementById('footerStar').classList.toggle('active', bm.indexOf(currentPost.id) !== -1);
}

// ---------- localStorage ----------
function getRead() { try { return JSON.parse(localStorage.getItem(K_READ) || '[]'); } catch (e) { return []; } }
function markRead(id) { const r = getRead(); if (r.indexOf(id) === -1) { r.push(id); localStorage.setItem(K_READ, JSON.stringify(r)); } }
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
