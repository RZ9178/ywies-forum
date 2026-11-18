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
let maxPostImages = 3;
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
let currentChatUser = '';
let messageLockedBody = false;

const K_READ = 'ywies_read';
const K_BOOKMARK = 'ywies_bookmarked';
const K_FOLLOW = 'ywies_following';
const K_LIKED = 'ywies_liked';
const K_COINED = 'ywies_coined';
const K_AUTHOR = 'ywies_author';
const K_POSTS_CACHE = 'ywies_posts_cache_v2';

let postsLoading = false;
let postsLoadFailed = false;
let postsRetryCount = 0;
let postsRetryTimer = null;

window.addEventListener('DOMContentLoaded', function () {
    initAuth();
    const hadCache = loadPostsCache();
    if (hadCache) render();
    bindTabs();
    bindSearch();
    bindBell();
    bindDetailModal();
    bindPostModal();
    bindProfileModal();
    bindMessages();
    bindImageViewer();

    // 帖子优先加载；次要请求错开，减少同时抢数据库连接
    fetchPosts();
    setTimeout(fetchTags, 150);
    setTimeout(function () {
        refreshBellDot();
        refreshMsgDot();
        fetchConfig();
    }, 600);

    document.getElementById('emptyState').addEventListener('click', function () {
        if (postsLoadFailed) {
            postsRetryCount = 0;
            fetchPosts();
        }
    });
    window.addEventListener('online', function () {
        if (!allPosts.length || postsLoadFailed) fetchPosts();
    });
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && (!allPosts.length || postsLoadFailed)) fetchPosts();
    });
    window.addEventListener('pageshow', function (e) {
        if (e.persisted) fetchPosts();
    });
});

function initAuth() {
    const logged = Auth.isLoggedIn();
    document.getElementById('loginBtn').hidden = logged;
    document.getElementById('registerBtn').hidden = logged;
    document.getElementById('userArea').hidden = !logged;
    if (logged) {
        const nameEl = document.getElementById('userName');
        nameEl.textContent = Auth.user.username;
        nameEl.title = '查看我的主页';
        nameEl.addEventListener('click', function () {
            if (Auth.user) openProfile(Auth.user.username);
        });
        document.getElementById('adminBtn').hidden = !Auth.isAdmin();
    }
    document.getElementById('logoutBtn').addEventListener('click', function () {
        Auth.logout();
        location.reload();
    });
}

async function fetchPosts() {
    if (postsLoading) return;
    postsLoading = true;
    if (!allPosts.length) showPostsLoading();
    try {
        const res = await Auth.get(API);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('返回数据格式不对');
        allPosts = data;
        postsLoadFailed = false;
        postsRetryCount = 0;
        if (postsRetryTimer) { clearTimeout(postsRetryTimer); postsRetryTimer = null; }
        savePostsCache(data);
        const empty = document.getElementById('emptyState');
        if (empty) empty.classList.remove('retry');
        render();
    } catch (e) {
        postsLoadFailed = true;
        if (!allPosts.length) showPostsError();
        schedulePostsRetry();
    } finally {
        postsLoading = false;
    }
}

function loadPostsCache() {
    try {
        const raw = localStorage.getItem(K_POSTS_CACHE);
        if (!raw) return false;
        const data = JSON.parse(raw);
        if (!Array.isArray(data) || !data.length) return false;
        allPosts = data;
        return true;
    } catch (e) {
        return false;
    }
}

function savePostsCache(list) {
    try {
        const slim = list.slice(0, 50).map(function (p) {
            return {
                id: p.id,
                title: p.title || '',
                content: (p.content || '').slice(0, 500),
                author: p.author || '',
                tags: p.tags || '',
                image: (p.image && p.image.slice(0, 5).toLowerCase() !== 'data:') ? p.image : '',
                images: (p.images || []).filter(function (u) {
                    return u && u.slice(0, 5).toLowerCase() !== 'data:';
                }),
                has_image: !!(p.has_image || p.image || (p.images && p.images.length)),
                views: p.views || 0,
                likes: p.likes || 0,
                coins: p.coins || 0,
                replies: p.replies || 0,
                created_at: p.created_at || ''
            };
        });
        localStorage.setItem(K_POSTS_CACHE, JSON.stringify(slim));
    } catch (e) {}
}

function showPostsLoading() {
    const empty = document.getElementById('emptyState');
    if (!empty) return;
    empty.classList.remove('retry');
    empty.textContent = '帖子加载中...';
    empty.hidden = false;
}

function showPostsError() {
    const empty = document.getElementById('emptyState');
    if (!empty) return;
    empty.classList.add('retry');
    empty.textContent = '帖子加载失败，点这里重试';
    empty.hidden = false;
}

function schedulePostsRetry() {
    if (postsRetryTimer || postsRetryCount >= 4) return;
    const delays = [2000, 5000, 10000, 20000];
    const delay = delays[postsRetryCount++];
    postsRetryTimer = setTimeout(function () {
        postsRetryTimer = null;
        fetchPosts();
    }, delay);
}

async function fetchTags() {
    try {
        const res = await Auth.get(TAGS_API);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (Array.isArray(data)) allTags = data;
    } catch (e) {}
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
    if (!list.length) {
        if (!allPosts.length && postsLoadFailed) { showPostsError(); return; }
        if (!allPosts.length && postsLoading) { showPostsLoading(); return; }
        empty.classList.remove('retry');
        empty.textContent = (searchQuery || currentTag)
            ? '没有找到符合条件的帖子'
            : '这里还没有帖子，点右上角「发帖」发第一条吧';
        empty.hidden = false;
        return;
    }
    empty.hidden = true;

    const read = getRead();
    const bm = getBookmarks();

    list.forEach(function (p) {
        const isRead = read.indexOf(p.id) !== -1;
        const isBm = bm.indexOf(p.id) !== -1;
        const firstTag = (p.tags || '').split(',')[0].trim();
        const cover = getPostImages(p)[0] || '';

        const card = document.createElement('article');
        card.className = 'post-card' + (isRead ? ' is-read' : '');
        card.setAttribute('data-id', p.id);
        card.tabIndex = 0;
        card.setAttribute('role', 'link');
        card.innerHTML =
            '<div class="card-cover' + (cover ? '' : ' no-image') + '">' +
                (cover ? '<img src="' + escapeHtml(cover) + '" alt="" loading="lazy" decoding="async">' : '') +
                '<svg class="icon card-cover-icon" aria-hidden="true"><use href="#i-image"></use></svg>' +
                (!isRead ? '<span class="card-unread" title="未读"></span>' : '') +
                '<button class="star-btn card-star' + (isBm ? ' starred' : '') + '" data-id="' + p.id + '" title="收藏" aria-label="收藏">' +
                    '<svg class="icon" aria-hidden="true"><use href="#i-star"></use></svg>' +
                '</button>' +
                (firstTag ? '<span class="post-tag card-tag">' + escapeHtml(firstTag) + '</span>' : '') +
            '</div>' +
            '<div class="card-body">' +
                '<h3 class="card-title">' + escapeHtml(p.title || '无标题') + '</h3>' +
                '<div class="card-meta">' +
                    '<a class="card-author" href="javascript:void(0)" data-author="' + escapeHtml(p.author) + '">' + escapeHtml(p.author || '匿名') + '</a>' +
                    '<span class="card-time">' + formatTime(p.created_at) + '</span>' +
                '</div>' +
                '<div class="card-stats">' +
                    '<span title="点赞"><svg class="icon" aria-hidden="true"><use href="#i-like"></use></svg>' + (p.likes || 0) + '</span>' +
                    '<span title="浏览"><svg class="icon" aria-hidden="true"><use href="#i-eye"></use></svg>' + (p.views || 0) + '</span>' +
                    '<span title="回复"><svg class="icon" aria-hidden="true"><use href="#i-reply"></use></svg>' + (p.replies || 0) + '</span>' +
                '</div>' +
            '</div>';

        const img = card.querySelector('.card-cover img');
        if (img) {
            img.addEventListener('error', function () {
                this.remove();
                const box = card.querySelector('.card-cover');
                if (box) box.classList.add('no-image');
            });
        }

        card.addEventListener('click', function (e) {
            if (e.target.closest('.star-btn') || e.target.closest('.card-author')) return;
            markRead(p.id);
            openDetail(p.id);
        });
        card.addEventListener('keydown', function (e) {
            if (e.target !== card) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                markRead(p.id);
                openDetail(p.id);
            }
        });
        const star = card.querySelector('.card-star');
        if (star) star.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleBookmark(p.id);
        });
        const authorLink = card.querySelector('.card-author');
        if (authorLink) authorLink.addEventListener('click', function (e) {
            e.stopPropagation();
            openProfile(this.getAttribute('data-author'));
        });
        wrap.appendChild(card);
    });
}

// ---------- Tab / 搜索 / 通知 ----------
function bindTabs() {
    document.querySelectorAll('.tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
            tab.classList.add('active');
            currentTab = tab.getAttribute('data-tab');
            if (!allPosts.length && !postsLoading) fetchPosts();
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
    if (imageProcessing) { alert('图片还在上传，请稍候'); return; }
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
            if (uploadedImages.length >= maxPostImages) break;
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
        const res = await Auth.get('/api/config');
        if (!res.ok) return;
        const cfg = await res.json();
        if (cfg && cfg.max_post_images) {
            maxPostImages = cfg.max_post_images;
            const label = document.getElementById('imageLabel');
            if (label) {
                label.textContent = '图片（可选，Lv.' + (cfg.level || 1) + ' 最多 ' + maxPostImages + ' 张，单张 ≤10MB）';
            }
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
        html = '<span style="color:var(--text-dim);font-size:13px;">暂无标签，在下方输入框输入新标签</span>';
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
        await fetchConfig();
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
    document.querySelector('.detail-author').addEventListener('click', function () {
        if (currentPost && currentPost.author) openProfile(currentPost.author);
    });
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
        list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">还没有评论，来说点什么吧</div>';
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
    box.innerHTML = '<img src="' + escapeHtml(detailImages[detailImageIndex]) + '" alt="帖子图片" decoding="async">';
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
            '<img src="' + escapeHtml(u) + '" alt="" loading="lazy" decoding="async"></button>';
    }).join('');
    thumbs.querySelectorAll('.detail-thumb').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            detailImageIndex = Number(this.getAttribute('data-i'));
            renderDetailImages();
        });
    });
}

let profileLockedBody = false;

function bindProfileModal() {
    const modal = document.getElementById('profileModal');
    if (!modal) return;
    document.getElementById('profileClose').addEventListener('click', closeProfile);
    modal.addEventListener('click', function (e) {
        if (e.target === this) closeProfile();
    });
}

async function openProfile(username) {
    const modal = document.getElementById('profileModal');
    const body = document.getElementById('profileBody');
    if (!modal || !body || !username) return;
    if (modal.hidden) {
        profileLockedBody = document.body.style.overflow !== 'hidden';
        if (profileLockedBody) document.body.style.overflow = 'hidden';
    }
    modal.hidden = false;
    body.innerHTML = '<div class="profile-empty">加载中...</div>';
    try {
        const res = await Auth.get('/api/users/' + encodeURIComponent(username));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        renderProfile(data);
    } catch (e) {
        body.innerHTML = '<div class="profile-empty">用户主页加载失败</div>';
    }
}

function closeProfile() {
    const modal = document.getElementById('profileModal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    if (profileLockedBody) {
        document.body.style.overflow = '';
        profileLockedBody = false;
    }
}

function renderProfile(data) {
    const body = document.getElementById('profileBody');
    const u = data.user || {};
    const posts = data.posts || [];
    const initial = (u.username || '?').slice(0, 1);
    let html = '<div class="profile-head">' +
        '<div class="profile-avatar">' + escapeHtml(initial) + '</div>' +
        '<div class="profile-head-info">' +
            '<div class="profile-name">' + escapeHtml(u.username || '未知用户') +
                (u.is_admin ? '<span class="profile-badge">管理员</span>' : '') +
                (u.username !== (Auth.user && Auth.user.username)
                    ? '<button type="button" class="profile-msg" data-user="' + escapeHtml(u.username) + '">私信</button>'
                    : '') + '</div>' +
            '<div class="profile-meta">Lv.' + (u.level || 1) + ' · ' + (u.post_count || 0) +
                ' 帖 · 加入于 ' + formatTime(u.created_at) + '</div>' +
        '</div>' +
    '</div>';
    if (!posts.length) {
        html += '<div class="profile-empty">还没有发过帖子</div>';
    } else {
        html += '<div class="profile-section-title">最近发帖</div><div class="profile-posts">';
        posts.forEach(function (p) {
            const cover = getPostImages(p)[0] || '';
            html += '<div class="profile-post" data-id="' + p.id + '">' +
                '<div class="profile-post-thumb">' +
                    (cover ? '<img src="' + escapeHtml(cover) + '" alt="" loading="lazy" decoding="async">'
                           : '<svg class="icon" aria-hidden="true"><use href="#i-image"></use></svg>') +
                '</div>' +
                '<div class="profile-post-main">' +
                    '<div class="profile-post-title">' + escapeHtml(p.title || '无标题') + '</div>' +
                    '<div class="profile-post-meta">' +
                        '<svg class="icon" aria-hidden="true"><use href="#i-like"></use></svg>' + (p.likes || 0) +
                        '<svg class="icon" aria-hidden="true"><use href="#i-eye"></use></svg>' + (p.views || 0) +
                        '<svg class="icon" aria-hidden="true"><use href="#i-reply"></use></svg>' + (p.replies || 0) +
                        '<span class="profile-post-time">' + formatTime(p.created_at) + '</span>' +
                    '</div>' +
                '</div>' +
            '</div>';
        });
        html += '</div>';
    }
    body.innerHTML = html;
    body.querySelectorAll('.profile-post').forEach(function (el) {
        el.addEventListener('click', function () {
            closeProfile();
            openDetail(Number(this.getAttribute('data-id')));
        });
    });
    const pm = body.querySelector('.profile-msg');
    if (pm) pm.addEventListener('click', function (e) {
        e.stopPropagation();
        const peer = this.getAttribute('data-user');
        closeProfile();
        openMessageThread(peer);
    });
}

function bindMessages() {
    const modal = document.getElementById('messageModal');
    if (!modal) return;
    const closeBtn = document.getElementById('messageClose');
    document.getElementById('msgBtn').addEventListener('click', function () {
        openMessageInbox();
    });
    closeBtn.addEventListener('click', closeMessages);
    modal.addEventListener('click', function (e) {
        if (e.target === this) closeMessages();
    });
    document.getElementById('messageSend').addEventListener('click', sendMessage);
    document.getElementById('messageInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
    });
}

function updateMsgDot(show) {
    const dot = document.getElementById('msgDot');
    if (dot) dot.hidden = !show;
}

async function refreshMsgDot() {
    const dot = document.getElementById('msgDot');
    if (!dot) return;
    if (!Auth.isLoggedIn()) { dot.hidden = true; return; }
    try {
        const res = await Auth.get('/api/messages');
        if (!res.ok) { dot.hidden = true; return; }
        const data = await res.json();
        dot.hidden = !(data.unread > 0);
    } catch (e) {
        dot.hidden = true;
    }
}

async function openMessageInbox() {
    if (!Auth.isLoggedIn()) {
        alert('请先登录再查看私信');
        window.location.href = 'login.html';
        return;
    }
    const modal = document.getElementById('messageModal');
    if (!modal) return;
    if (modal.hidden) {
        messageLockedBody = document.body.style.overflow !== 'hidden';
        if (messageLockedBody) document.body.style.overflow = 'hidden';
    }
    modal.hidden = false;
    currentChatUser = '';
    document.getElementById('messageTitle').textContent = '私信';
    document.getElementById('messageCompose').hidden = true;
    const body = document.getElementById('messageBody');
    body.innerHTML = '<div class="message-empty">加载中...</div>';
    try {
        const res = await Auth.get('/api/messages');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        renderInbox(data);
        updateMsgDot((data.unread || 0) > 0);
    } catch (e) {
        body.innerHTML = '<div class="message-empty">私信加载失败</div>';
    }
}

function renderInbox(data) {
    const body = document.getElementById('messageBody');
    const list = data.conversations || [];
    if (!list.length) {
        body.innerHTML = '<div class="message-empty">还没有私信。点开别人的主页，发第一条吧。</div>';
        return;
    }
    body.innerHTML = list.map(function (c) {
        const initial = (c.peer || '?').slice(0, 1);
        return '<button type="button" class="conv-item" data-peer="' + escapeHtml(c.peer) + '">' +
            '<span class="conv-avatar">' + escapeHtml(initial) + '</span>' +
            '<span class="conv-main">' +
                '<span class="conv-name">' + escapeHtml(c.peer) +
                    (c.unread > 0 ? '<span class="conv-unread">' + c.unread + '</span>' : '') + '</span>' +
                '<span class="conv-last">' + escapeHtml(c.last || '') + '</span>' +
            '</span>' +
            '<span class="conv-time">' + formatTime(c.time) + '</span>' +
        '</button>';
    }).join('');
    body.querySelectorAll('.conv-item').forEach(function (el) {
        el.addEventListener('click', function () {
            openMessageThread(this.getAttribute('data-peer'));
        });
    });
}

async function openMessageThread(username) {
    if (!Auth.isLoggedIn()) {
        alert('请先登录再查看私信');
        window.location.href = 'login.html';
        return;
    }
    if (!username) return;
    const modal = document.getElementById('messageModal');
    if (!modal) return;
    if (modal.hidden) {
        messageLockedBody = document.body.style.overflow !== 'hidden';
        if (messageLockedBody) document.body.style.overflow = 'hidden';
    }
    modal.hidden = false;
    currentChatUser = username;
    document.getElementById('messageTitle').textContent = '与 ' + username + ' 的私信';
    const body = document.getElementById('messageBody');
    body.innerHTML = '<div class="message-empty">加载中...</div>';
    try {
        const res = await Auth.get('/api/messages/' + encodeURIComponent(username));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        renderThread(data);
        document.getElementById('messageCompose').hidden = false;
        refreshMsgDot();
    } catch (e) {
        body.innerHTML = '<div class="message-empty">私信加载失败</div>';
        document.getElementById('messageCompose').hidden = true;
    }
}

function renderThread(data) {
    const body = document.getElementById('messageBody');
    const msgs = data.messages || [];
    let html = '<button type="button" class="msg-back" id="msgBack">‹ 返回私信列表</button>';
    if (!msgs.length) {
        html += '<div class="message-empty">还没有消息，打个招呼吧。</div>';
    } else {
        html += '<div class="msg-thread">' + msgs.map(function (m) {
            const mine = Auth.user && m.sender === Auth.user.username;
            return '<div class="msg-row ' + (mine ? 'me' : 'peer') + '">' +
                '<div class="msg-bubble">' + escapeHtml(m.content) + '</div>' +
                '<div class="msg-time">' + formatTime(m.created_at) + '</div>' +
            '</div>';
        }).join('') + '</div>';
    }
    body.innerHTML = html;
    const back = document.getElementById('msgBack');
    if (back) back.addEventListener('click', openMessageInbox);
    body.scrollTop = body.scrollHeight;
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const btn = document.getElementById('messageSend');
    if (!input || !btn || !currentChatUser) return;
    const text = input.value.trim();
    if (!text) return;
    if (btn.disabled) return;
    btn.disabled = true;
    try {
        const res = await Auth.post('/api/messages/' + encodeURIComponent(currentChatUser), { content: text });
        if (!res.ok) {
            const err = await res.json().catch(function () { return {}; });
            throw new Error(err.error || '发送失败');
        }
        input.value = '';
        await openMessageThread(currentChatUser);
    } catch (e) {
        alert('发送失败：' + e.message);
    } finally {
        btn.disabled = false;
    }
}

function closeMessages() {
    const modal = document.getElementById('messageModal');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    currentChatUser = '';
    const compose = document.getElementById('messageCompose');
    if (compose) compose.hidden = true;
    if (messageLockedBody) {
        document.body.style.overflow = '';
        messageLockedBody = false;
    }
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
        const type = (blob.type || '').toLowerCase();
        const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
        if (extMap[type]) name = name.replace(/\.[^.]+$/, '') + '.' + extMap[type];
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
