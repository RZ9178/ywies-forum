// ============================================
// 首页逻辑：极简 BBS 列表 + 详情弹窗 + 发帖弹窗
// ============================================

const API = '/api/posts';
const TAGS_API = '/api/tags';

let allPosts = [];
let allTags = [];
let currentTab = 'latest';
let currentTag = '';
let searchQuery = '';
let currentPost = null;
let allComments = [];
let commentSort = 'earliest';
let selectedTags = [];
let uploadedImages = [];
let maxPostImages = 9;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MAX_EDGE = 1600;
const IMAGE_KEEP_BYTES = 600 * 1024;
const IMAGE_TARGET_BYTES = 1.5 * 1024 * 1024;
let imageProcessing = false;
let imageTaskId = 0;
let detailImages = [];
let detailImageIndex = 0;
let viewerImages = [];
let viewerIndex = 0;
let viewerDownloadName = 'image.jpg';

const K_READ = 'ywies_read';
const K_BOOKMARK = 'ywies_bookmarked';
const K_FOLLOW = 'ywies_following';
const K_LIKED = 'ywies_liked';
const K_COINED = 'ywies_coined';
const K_AUTHOR = 'ywies_author';

window.addEventListener('DOMContentLoaded', function () {
    initAuth();
    refreshBellDot();
    fetchConfig();
    fetchPosts();
    fetchTags();
    bindTabs();
    bindSearch();
    bindBell();
    bindDetailModal();
    bindPostModal();
    bindImageViewer();
});

function initAuth() {
    const logged = Auth.isLoggedIn();
    document.getElementById('loginBtn').hidden = logged;
    document.getElementById('registerBtn').hidden = logged;
    document.getElementById('userArea').hidden = !logged;
    if (logged) {
        document.getElementById('userName').textContent = Auth.user.username;
        document.getElementById('adminBtn').hidden = !Auth.isAdmin();
    }
    document.getElementById('logoutBtn').addEventListener('click', function () {
        Auth.logout();
        location.reload();
    });
}

async function fetchPosts() {
    try {
        const res = await Auth.get(API);
        allPosts = await res.json();
    } catch (e) {
        allPosts = [];
    }
    render();
}

async function fetchTags() {
    try {
        const res = await Auth.get(TAGS_API);
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
    document.getElementById('bellBtn').addEventListener('click', async function () {
        // 未登录绝不请求 /api/notifs：Auth 收到 401 会把匿名访客踢去登录页
        if (!Auth.isLoggedIn()) {
            alert('请先登录再查看通知');
            return;
        }
        document.getElementById('notifModal').hidden = false;
        await renderNotifs();
        try {
            await Auth.post('/api/notifs/read', {});
        } catch (e) {}
        document.getElementById('bellDot').hidden = true;
    });
    document.getElementById('notifClose').addEventListener('click', function () {
        document.getElementById('notifModal').hidden = true;
    });
    document.getElementById('notifModal').addEventListener('click', function (e) {
        if (e.target === this) this.hidden = true;
    });
}
async function renderNotifs() {
    const list = document.getElementById('notifList');
    if (!Auth.isLoggedIn()) {
        list.innerHTML = '<div class="notif-item"><div class="notif-text">请先登录后查看通知</div></div>';
        return;
    }
    list.innerHTML = '<div class="notif-item"><div class="notif-text">加载中...</div></div>';
    let data;
    try {
        const res = await Auth.get('/api/notifs');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
    } catch (e) {
        list.innerHTML = '<div class="notif-item"><div class="notif-text">通知加载失败</div></div>';
        return;
    }
    const notifs = data.notifs || [];
    if (!notifs.length) {
        list.innerHTML = '<div class="notif-item"><div class="notif-text">暂无通知</div></div>';
        return;
    }
    list.innerHTML = notifs.map(function (n) {
        // 已读的通知整体淡化，和未读区分开
        return '<div class="notif-item"' + (n.is_read ? ' style="opacity:0.55;"' : '') + '>' +
               '<div class="notif-title">' + escapeHtml(n.title) + '</div>' +
               '<div class="notif-text">' + escapeHtml(n.text) + '</div>' +
               '<div class="notif-time">' + escapeHtml(formatTime(n.created_at)) + '</div></div>';
    }).join('');
}
async function refreshBellDot() {
    const dot = document.getElementById('bellDot');
    if (!Auth.isLoggedIn()) {
        dot.hidden = true;
        return;
    }
    try {
        const res = await Auth.get('/api/notifs');
        if (!res.ok) { dot.hidden = true; return; }
        const data = await res.json();
        dot.hidden = !(data.unread > 0);
    } catch (e) {
        dot.hidden = true;
    }
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
        if (e.dataTransfer.files.length) handleImageFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', function () {
        if (this.files.length) handleImageFiles(this.files);
        this.value = '';
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
    if (!Auth.isLoggedIn()) {
        alert('请先登录再发帖');
        window.location.href = 'login.html';
        return;
    }
    document.getElementById('postAuthor').value = Auth.user.username || '';
    document.getElementById('postTitle').value = '';
    document.getElementById('postContent').value = '';
    document.getElementById('postImage').value = '';
    document.getElementById('newTagInput').value = '';
    selectedTags = [];
    imageTaskId++;
    imageProcessing = false;
    uploadedImages = [];
    renderImagePreviews();
    setUploadHint('');
    document.getElementById('uploadPlaceholder').style.display = '';
    renderTagPicker();
    document.getElementById('postModal').hidden = false;
    document.body.style.overflow = 'hidden';
}

function closePostModal() {
    document.getElementById('postModal').hidden = true;
    document.body.style.overflow = '';
}

async function handleImageFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    const room = maxPostImages - uploadedImages.length;
    if (room <= 0) {
        alert('最多上传 ' + maxPostImages + ' 张图片');
        return;
    }
    if (files.length > room) {
        alert('最多上传 ' + maxPostImages + ' 张，已忽略多出的 ' + (files.length - room) + ' 张');
    }
    const todo = files.slice(0, room);
    const taskId = imageTaskId;
    imageProcessing = true;
    for (let i = 0; i < todo.length; i++) {
        if (taskId !== imageTaskId) break;
        const file = todo[i];
        if (!file.type || !file.type.startsWith('image/')) { alert('请上传图片文件'); continue; }
        if (file.size > MAX_IMAGE_BYTES) { alert('图片不能超过 10MB：' + (file.name || '')); continue; }
        setUploadHint('正在处理第 ' + (i + 1) + ' / ' + todo.length + ' 张...');
        try {
            const blob = await prepareImageBlob(file);
            if (taskId !== imageTaskId) break;
            setUploadHint('正在上传第 ' + (i + 1) + ' / ' + todo.length + ' 张...');
            const url = await uploadImageBlob(blob, file.name);
            if (taskId !== imageTaskId) break;
            uploadedImages.push(url);
            renderImagePreviews();
        } catch (e) {
            if (taskId !== imageTaskId) break;
            alert('图片上传失败：' + e.message);
        }
    }
    if (taskId === imageTaskId) {
        imageProcessing = false;
        setUploadHint(uploadedImages.length ? ('已上传 ' + uploadedImages.length + ' / ' + maxPostImages + ' 张') : '');
    }
}

function prepareImageBlob(file) {
    return new Promise(function (resolve, reject) {
        const reader = new FileReader();
        reader.onerror = function () { reject(new Error('读取图片失败')); };
        reader.onload = function (e) {
            loadImage(e.target.result).then(function (img) {
                const w0 = img.naturalWidth || 0;
                const h0 = img.naturalHeight || 0;
                const edge = Math.max(w0, h0);
                // 取不到尺寸（极少数 SVG 等）或本身够小：直接上传原文件
                if (!edge || (file.size <= IMAGE_KEEP_BYTES && edge <= IMAGE_MAX_EDGE)) {
                    resolve(file);
                    return;
                }
                compressImage(img).then(resolve).catch(reject);
            }).catch(function () { reject(new Error('图片读取失败')); });
        };
        reader.readAsDataURL(file);
    });
}

function compressImage(img) {
    const attempts = [
        { edge: 1600, quality: 0.82 },
        { edge: 1600, quality: 0.72 },
        { edge: 1600, quality: 0.62 },
        { edge: 1280, quality: 0.7 }
    ];
    let i = 0;
    let last = null;
    function step() {
        if (i >= attempts.length) return Promise.resolve(last);
        const a = attempts[i++];
        return canvasToBlob(img, a.edge, a.quality).then(function (blob) {
            if (!blob) throw new Error('浏览器不支持图片压缩');
            last = blob;
            if (blob.size <= IMAGE_TARGET_BYTES) return blob;
            return step();
        });
    }
    return step().then(function (blob) {
        if (!blob) throw new Error('图片压缩失败');
        return blob;
    });
}

function canvasToBlob(img, maxEdge, quality) {
    return new Promise(function (resolve) {
        const w0 = img.naturalWidth || img.width;
        const h0 = img.naturalHeight || img.height;
        const scale = Math.min(1, maxEdge / Math.max(w0, h0));
        const w = Math.max(1, Math.round(w0 * scale));
        const h = Math.max(1, Math.round(h0 * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        // 透明 PNG 转 JPEG 时铺白底，避免透明区域变黑
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        if (canvas.toBlob) canvas.toBlob(resolve, 'image/jpeg', quality);
        else resolve(null);
    });
}

function loadImage(src) {
    return new Promise(function (resolve, reject) {
        const img = new Image();
        img.onload = function () { resolve(img); };
        img.onerror = reject;
        img.src = src;
    });
}

async function uploadImageBlob(blob, originalName) {
    let ext = 'jpg';
    if (blob.type === 'image/png') ext = 'png';
    else if (blob.type === 'image/webp') ext = 'webp';
    else if (blob.type === 'image/gif') ext = 'gif';
    const base = (originalName || 'image').replace(/\.[^.]+$/, '') || 'image';
    const fd = new FormData();
    fd.append('file', blob, base + '.' + ext);
    const res = await Auth.upload('/api/upload', fd);
    if (!res.ok) {
        let msg = '上传失败';
        try {
            const data = await res.json();
            msg = data.error || msg;
        } catch (e) {}
        throw new Error(msg);
    }
    const data = await res.json();
    if (!data.url) throw new Error('上传失败');
    return data.url;
}

function renderImagePreviews() {
    const wrap = document.getElementById('imagePreviewList');
    if (!wrap) return;
    wrap.innerHTML = uploadedImages.map(function (u, i) {
        return '<div class="image-preview-item">' +
            '<img src="' + escapeHtml(u) + '" alt="图片 ' + (i + 1) + '">' +
            '<button type="button" class="image-remove" data-i="' + i + '" title="移除">×</button>' +
        '</div>';
    }).join('');
    wrap.querySelectorAll('.image-remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            uploadedImages.splice(Number(this.getAttribute('data-i')), 1);
            renderImagePreviews();
            setUploadHint(uploadedImages.length ? ('已上传 ' + uploadedImages.length + ' / ' + maxPostImages + ' 张') : '');
        });
    });
}

function setUploadHint(text) {
    const el = document.getElementById('uploadHint');
    if (el) el.textContent = text || '';
}

async function fetchConfig() {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) return;
        const cfg = await res.json();
        if (cfg && cfg.max_post_images) {
            maxPostImages = cfg.max_post_images;
            const label = document.getElementById('imageLabel');
            if (label) label.textContent = '图片（可选，最多 ' + maxPostImages + ' 张，单张 ≤10MB）';
        }
        const ph = document.getElementById('uploadPlaceholder');
        if (ph && cfg && cfg.upload_enabled === false) {
            ph.textContent = '图片上传暂未配置，可先发纯文字';
        }
    } catch (e) {}
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
    if (!title) { alert('请输入标题'); return; }
    if (!content) { alert('请输入内容'); return; }
    if (imageProcessing) { alert('图片还在上传，请稍候'); return; }

    const btn = document.getElementById('submitPostBtn');
    btn.disabled = true;
    btn.textContent = '发布中...';

    try {
        const res = await Auth.post(API, {
            title: title, content: content,
            tags: selectedTags.join(','), images: uploadedImages
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
    document.getElementById('detailImg').addEventListener('click', function (e) {
        if (e.target.tagName === 'IMG') openImageViewer(detailImages, detailImageIndex);
    });
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
    document.getElementById('footerLike').addEventListener('click', async function () {
        if (!currentPost) return;
        const btn = this;
        if (btn.disabled) return;
        if (!Auth.isLoggedIn()) {
            alert('请先登录再点赞');
            window.location.href = 'login.html';
            return;
        }
        // 本地记录决定这次是「赞」还是「取消赞」；计数以服务端返回为准
        const on = getLiked().indexOf(currentPost.id) === -1;
        btn.disabled = true;
        try {
            const res = await Auth.post(API + '/' + currentPost.id + '/like', { on: on });
            if (!res.ok) {
                const err = await res.json().catch(function () { return {}; });
                throw new Error(err.error || '点赞失败');
            }
            const data = await res.json();
            currentPost.likes = data.likes;
            const liked = getLiked();
            const idx = liked.indexOf(currentPost.id);
            if (on && idx === -1) liked.push(currentPost.id);
            if (!on && idx !== -1) liked.splice(idx, 1);
            localStorage.setItem(K_LIKED, JSON.stringify(liked));
            updateFooterButtons();
        } catch (e) {
            alert('点赞失败：' + e.message);
        } finally {
            btn.disabled = false;
        }
    });
    document.getElementById('footerCoin').addEventListener('click', async function () {
        if (!currentPost) return;
        const btn = this;
        if (btn.disabled) return;
        if (!Auth.isLoggedIn()) {
            alert('请先登录再投硬币');
            window.location.href = 'login.html';
            return;
        }
        const on = getCoined().indexOf(currentPost.id) === -1;
        btn.disabled = true;
        try {
            const res = await Auth.post(API + '/' + currentPost.id + '/coin', { on: on });
            if (!res.ok) {
                const err = await res.json().catch(function () { return {}; });
                throw new Error(err.error || '投币失败');
            }
            const data = await res.json();
            currentPost.coins = data.coins;
            const coined = getCoined();
            const idx = coined.indexOf(currentPost.id);
            if (on && idx === -1) coined.push(currentPost.id);
            if (!on && idx !== -1) coined.splice(idx, 1);
            localStorage.setItem(K_COINED, JSON.stringify(coined));
            updateFooterButtons();
        } catch (e) {
            alert('投币失败：' + e.message);
        } finally {
            btn.disabled = false;
        }
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
        const res = await Auth.get(API + '/' + postId);
        currentPost = await res.json();
    } catch (e) { return; }
    try {
        const res = await Auth.get(API + '/' + postId + '/comments');
        allComments = res.ok ? await res.json() : [];
    } catch (e) { allComments = []; }

    renderDetail();
    document.getElementById('detailModal').hidden = false;
    document.body.style.overflow = 'hidden';
}

function closeDetail() {
    closeImageViewer();
    document.getElementById('detailModal').hidden = true;
    document.body.style.overflow = '';
    currentPost = null;
    allComments = [];
    render();
}

function renderDetail() {
    const p = currentPost;
    detailImages = getPostImages(p);
    detailImageIndex = 0;
    renderDetailImages();
    document.getElementById('detailAuthorName').textContent = p.author || '匿名';
    document.getElementById('detailLikes').textContent = '♥ ' + (p.likes || 0);
    document.getElementById('detailTitle').textContent = p.title || '无标题';
    document.getElementById('detailContent').textContent = p.content || '';
    document.getElementById('detailTime').textContent = formatTime(p.created_at);
    document.getElementById('commentCount').textContent = allComments.length;
    // 登录后显示用户名
    document.getElementById('commentAuthor').value = Auth.isLoggedIn() ? Auth.user.username : '';
    // 删除帖子按钮：管理员或楼主
    let delBtn = document.getElementById('detailDeletePost');
    if (!delBtn) {
        delBtn = document.createElement('button');
        delBtn.id = 'detailDeletePost';
        delBtn.className = 'footer-btn btn-danger';
        delBtn.textContent = '删除帖子';
        delBtn.addEventListener('click', deleteCurrentPost);
        document.querySelector('.detail-footer').insertBefore(delBtn, document.getElementById('footerLike'));
    }
    const canDelete = Auth.isLoggedIn() && (Auth.isAdmin() || Auth.user.username === p.author);
    delBtn.style.display = canDelete ? '' : 'none';
    renderComments();
    updateFooterButtons();
}

async function deleteCurrentPost() {
    if (!currentPost) return;
    if (!confirm('确定删除这条帖子？')) return;
    try {
        await Auth.del(API + '/' + currentPost.id);
        closeDetail();
        await fetchPosts();
    } catch (e) { alert('删除失败：' + e.message); }
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
    const me = Auth.isLoggedIn() ? Auth.user.username : '';
    const isAdmin = Auth.isAdmin();
    list.innerHTML = sorted.map(function (c, i) {
        const floor = commentSort === 'earliest' ? (i + 1) : (sorted.length - i);
        const isAuthor = c.author === author;
        const canDel = isAdmin || c.author === me;
        return '<div class="comment-item">' +
            '<div class="comment-head">' +
                '<div class="comment-avatar"></div>' +
                '<span class="comment-name">' + escapeHtml(c.author) + '</span>' +
                (isAuthor ? '<span class="comment-author-tag">楼主</span>' : '') +
                '<span class="comment-floor">' + floor + 'F</span>' +
                (canDel ? '<button class="comment-del" data-cid="' + c.id + '">删</button>' : '') +
            '</div>' +
            '<div class="comment-text">' + escapeHtml(c.content) + '</div>' +
            '<div class="comment-time">' + formatTime(c.created_at) + '</div>' +
        '</div>';
    }).join('');
    // 绑定删除评论
    list.querySelectorAll('.comment-del').forEach(function (btn) {
        btn.addEventListener('click', async function () {
            if (!confirm('删除这条评论？')) return;
            try {
                await Auth.del(API + '/' + currentPost.id + '/comments/' + btn.getAttribute('data-cid'));
                const res = await Auth.get(API + '/' + currentPost.id + '/comments');
                allComments = res.ok ? await res.json() : allComments;
                document.getElementById('commentCount').textContent = allComments.length;
                renderComments();
            } catch (e) { alert('删除失败：' + e.message); }
        });
    });
}

async function submitComment() {
    if (!Auth.isLoggedIn()) {
        alert('请先登录再评论');
        window.location.href = 'login.html';
        return;
    }
    const input = document.getElementById('commentInput');
    const text = input.value.trim();
    if (!text || !currentPost) return;
    try {
        const res = await Auth.post(API + '/' + currentPost.id + '/comments', { content: text });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || '评论失败');
        }
        input.value = '';
        const res2 = await Auth.get(API + '/' + currentPost.id + '/comments');
        allComments = res2.ok ? await res2.json() : allComments;
        document.getElementById('commentCount').textContent = allComments.length;
        renderComments();
    } catch (e) { alert('评论失败：' + e.message); }
}

function getPostImages(post) {
    if (post && Array.isArray(post.images) && post.images.length) return post.images.slice();
    if (post && post.image) return [post.image];
    return [];
}

function renderDetailImages() {
    const box = document.getElementById('detailImg');
    const thumbs = document.getElementById('detailThumbs');
    if (!detailImages.length) {
        box.innerHTML = '';
        if (thumbs) { thumbs.hidden = true; thumbs.innerHTML = ''; }
        return;
    }
    if (detailImageIndex >= detailImages.length) detailImageIndex = 0;
    box.innerHTML = '<img src="' + escapeHtml(detailImages[detailImageIndex]) + '" alt="帖子图片">';
    if (!thumbs) return;
    if (detailImages.length <= 1) {
        thumbs.hidden = true;
        thumbs.innerHTML = '';
        return;
    }
    thumbs.hidden = false;
    thumbs.innerHTML = detailImages.map(function (u, i) {
        return '<button type="button" class="detail-thumb' + (i === detailImageIndex ? ' active' : '') +
            '" data-i="' + i + '" title="第 ' + (i + 1) + ' 张">' +
            '<img src="' + escapeHtml(u) + '" alt=""></button>';
    }).join('');
    thumbs.querySelectorAll('.detail-thumb').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            detailImageIndex = Number(this.getAttribute('data-i'));
            renderDetailImages();
        });
    });
}

function bindImageViewer() {
    const viewer = document.getElementById('imageViewer');
    if (!viewer) return;
    document.getElementById('imageViewerClose').addEventListener('click', closeImageViewer);
    document.getElementById('imageViewerPrev').addEventListener('click', function (e) {
        e.stopPropagation();
        viewerStep(-1);
    });
    document.getElementById('imageViewerNext').addEventListener('click', function (e) {
        e.stopPropagation();
        viewerStep(1);
    });
    document.getElementById('imageViewerDownload').addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        downloadViewerImage();
    });
    viewer.addEventListener('click', function (e) {
        if (e.target === viewer || e.target.id === 'imageViewerImg') closeImageViewer();
    });
    document.addEventListener('keydown', function (e) {
        if (viewer.hidden) return;
        if (e.key === 'Escape') closeImageViewer();
        else if (e.key === 'ArrowLeft') { e.preventDefault(); viewerStep(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); viewerStep(1); }
    });
}

function openImageViewer(images, index) {
    const viewer = document.getElementById('imageViewer');
    if (!viewer) return;
    const imgs = (images && images.length) ? images : getPostImages(currentPost);
    if (!imgs.length) return;
    viewerImages = imgs.slice();
    viewerIndex = Math.max(0, Math.min(index || 0, viewerImages.length - 1));
    viewer.hidden = false;
    renderViewerImage();
}

function viewerStep(delta) {
    if (viewerImages.length <= 1) return;
    viewerIndex = (viewerIndex + delta + viewerImages.length) % viewerImages.length;
    renderViewerImage();
}

function renderViewerImage() {
    const src = viewerImages[viewerIndex];
    if (!src) { closeImageViewer(); return; }
    const img = document.getElementById('imageViewerImg');
    const count = document.getElementById('imageViewerCount');
    const prev = document.getElementById('imageViewerPrev');
    const next = document.getElementById('imageViewerNext');
    if (!img || !count || !prev || !next) return;
    img.src = src;
    img.alt = (currentPost && currentPost.title) ? currentPost.title : '帖子图片';
    count.textContent = viewerImages.length > 1 ? (viewerIndex + 1) + ' / ' + viewerImages.length : '';
    prev.hidden = viewerImages.length <= 1;
    next.hidden = viewerImages.length <= 1;

    const link = document.getElementById('imageViewerDownload');
    const m = /^data:image\/([a-zA-Z0-9.+-]+)/i.exec(src);
    let ext = m ? m[1].toLowerCase() : 'jpg';
    if (!m) {
        const pathMatch = /\.([a-zA-Z0-9]+)$/.exec(src.split('?')[0]);
        if (pathMatch) ext = pathMatch[1].toLowerCase();
    }
    if (ext === 'jpeg') ext = 'jpg';
    const base = ((currentPost && currentPost.title) || 'image')
        .replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40) || 'image';
    const suffix = viewerImages.length > 1 ? '-' + (viewerIndex + 1) : '';
    viewerDownloadName = base + suffix + '.' + ext;
    link.setAttribute('href', src);
    link.setAttribute('download', viewerDownloadName);
    link.removeAttribute('target');
}

async function downloadViewerImage() {
    const src = viewerImages[viewerIndex];
    if (!src) return;
    const name = viewerDownloadName || 'image.jpg';
    try {
        // 跨域图片先取成 Blob，再用同源 objectURL 触发下载，避免 download 属性被忽略
        const res = await fetch(src);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 10000);
    } catch (e) {
        window.open(src, '_blank', 'noopener');
    }
}

function closeImageViewer() {
    const viewer = document.getElementById('imageViewer');
    if (!viewer || viewer.hidden) return;
    viewer.hidden = true;
    document.getElementById('imageViewerImg').src = '';
    document.getElementById('imageViewerDownload').removeAttribute('href');
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
    // 后端统一返回 UTC 的 "YYYY-MM-DD HH:MM:SS"，这里换算成本机时区显示
    const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
    if (!m) return t;
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
    if (isNaN(d.getTime())) return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
