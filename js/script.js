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
let replyTarget = null;
let expandedReplyThreads = {};
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

function T(key, vars) {
    return window.I18n ? I18n.t(key, vars) : key;
}

const K_READ = 'ywies_read';
const K_BOOKMARK = 'ywies_bookmarked';
const K_FOLLOW = 'ywies_following';
const K_LIKED = 'ywies_liked';
const K_COINED = 'ywies_coined';
const K_COMMENT_LIKED = 'ywies_comment_liked';
const K_AUTHOR = 'ywies_author';
const K_POSTS_CACHE = 'ywies_posts_cache_v3';

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
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshSite);
    window.addEventListener('resize', scheduleMasonry);
    window.addEventListener('load', scheduleMasonry);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleMasonry);
    document.addEventListener('i18n:change', function () {
        renderTags(allTags);
        render();
        renderTagPicker();
        fetchConfig();
        if (currentPost) renderDetail();
    });
});

async function refreshSite() {
    const btn = document.getElementById('refreshBtn');
    if (!btn || btn.classList.contains('spinning')) return;
    btn.classList.add('spinning');
    try {
        await Promise.all([fetchPosts(), fetchTags(), fetchConfig(), refreshBellDot(), refreshMsgDot()]);
    } catch (e) {}
    setTimeout(function () { btn.classList.remove('spinning'); }, 400);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initAuth() {
    const logged = Auth.isLoggedIn();
    document.getElementById('loginBtn').hidden = logged;
    document.getElementById('registerBtn').hidden = logged;
    document.getElementById('userArea').hidden = !logged;
    if (logged) {
        const nameEl = document.getElementById('userName');
        nameEl.textContent = Auth.user.username;
        nameEl.title = T('profileView');
        nameEl.addEventListener('click', function () {
            if (Auth.user) openProfile(Auth.user.username);
        });
        document.getElementById('adminBtn').hidden = !Auth.isAdmin();
    }
    document.getElementById('logoutBtn').addEventListener('click', function () {
        const token = Auth.token;
        Auth.logout();
        if (token) {
            // 只注销当前设备，其他设备登录态保留
            fetch('/api/logout', {
                method: 'POST',
                headers: { 'Authorization': 'Bearer ' + token },
                keepalive: true
            }).catch(function () {});
        }
        location.reload();
    });
}

async function fetchPosts() {
    if (postsLoading) return;
    postsLoading = true;
    if (!allPosts.length) showPostsLoading();
    let controller = null;
    let timer = null;
    if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        timer = setTimeout(function () { controller.abort(); }, 60000);
    }
    try {
        const opts = { cache: 'no-store' };
        if (controller) opts.signal = controller.signal;
        const res = await Auth.get(API, opts);
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
        if (timer) clearTimeout(timer);
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
                created_at: p.created_at || '',
                created_at_zh: p.created_at_zh || '',
                created_at_en: p.created_at_en || ''
            };
        });
        localStorage.setItem(K_POSTS_CACHE, JSON.stringify(slim));
    } catch (e) {}
}

function showPostsLoading() {
    const empty = document.getElementById('emptyState');
    if (!empty) return;
    empty.classList.remove('retry');
    empty.textContent = T('loadingPosts');
    empty.hidden = false;
}

function showPostsError() {
    const empty = document.getElementById('emptyState');
    if (!empty) return;
    empty.classList.add('retry');
    empty.textContent = T('loadFailedRetry');
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
    let html = '<button class="tag-pill' + (currentTag === '' ? ' active' : '') + '" data-tag="">' + T('all') + '</button>';
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
    wrap.classList.remove('masonry');
    wrap.style.height = '';
    wrap.innerHTML = '';
    if (!list.length) {
        if (!allPosts.length && postsLoadFailed) { showPostsError(); return; }
        if (!allPosts.length && postsLoading) { showPostsLoading(); return; }
        empty.classList.remove('retry');
        empty.textContent = (searchQuery || currentTag)
            ? T('emptyFiltered')
            : T('emptyPosts');
        empty.hidden = false;
        wrap.classList.remove('masonry');
        wrap.style.height = '';
        return;
    }
    empty.hidden = true;

    const read = getRead();

    list.forEach(function (p) {
        const isRead = read.indexOf(p.id) !== -1;
        const firstTag = (p.tags || '').split(',')[0].trim();
        const cover = getPostImages(p)[0] || '';

        const excerpt = (p.content || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const metaHtml = '<div class="card-meta">' +
                '<a class="card-author" href="javascript:void(0)" data-author="' + escapeHtml(p.author) + '">' + escapeHtml(p.author || T('anonymous')) + '</a>' +
                '<span class="card-time">' + formatTime(p) + '</span>' +
            '</div>' +
            '<div class="card-stats">' +
                '<span title="' + T('tooltipLike') + '"><svg class="icon" aria-hidden="true"><use href="#i-like"></use></svg>' + (p.likes || 0) + '</span>' +
                '<span title="' + T('tooltipViews') + '"><svg class="icon" aria-hidden="true"><use href="#i-eye"></use></svg>' + (p.views || 0) + '</span>' +
                '<span title="' + T('tooltipReplies') + '"><svg class="icon" aria-hidden="true"><use href="#i-reply"></use></svg>' + (p.replies || 0) + '</span>' +
            '</div>';

        const card = document.createElement('article');
        card.setAttribute('data-id', p.id);
        card.tabIndex = 0;
        card.setAttribute('role', 'link');
        if (cover) {
            card.className = 'post-card' + (isRead ? ' is-read' : '');
            card.innerHTML =
                '<div class="card-cover">' +
                    '<img src="' + escapeHtml(cover) + '" alt="" decoding="async">' +
                    ( !isRead ? '<span class="card-unread" title="' + T('tooltipUnread') + '"></span>' : '') +
                    (firstTag ? '<span class="post-tag card-tag">' + escapeHtml(firstTag) + '</span>' : '') +
                '</div>' +
                '<div class="card-body">' +
                    '<h3 class="card-title">' + escapeHtml(p.title || T('untitled')) + '</h3>' +
                    metaHtml +
                '</div>';
        } else {
            card.className = 'post-card no-cover' + (isRead ? ' is-read' : '');
            card.innerHTML =
                '<div class="card-body">' +
                    '<div class="card-text-top">' +
                        ( !isRead ? '<span class="card-unread-inline" title="' + T('tooltipUnread') + '"></span>' : '') +
                        (firstTag ? '<span class="post-tag card-tag card-tag-inline">' + escapeHtml(firstTag) + '</span>' : '') +
                    '</div>' +
                    '<h3 class="card-title">' + escapeHtml(p.title || T('untitled')) + '</h3>' +
                    (excerpt ? '<p class="card-excerpt">' + escapeHtml(excerpt) + '</p>' : '') +
                    metaHtml +
                '</div>';
        }

        const img = card.querySelector('.card-cover img');
        if (img) {
            img.addEventListener('load', scheduleMasonry);
            img.addEventListener('error', function () {
                this.remove();
                const box = card.querySelector('.card-cover');
                if (box) box.classList.add('no-image');
                scheduleMasonry();
            });
            if (img.complete && img.naturalWidth) scheduleMasonry();
        }

        card.addEventListener('click', function (e) {
            if (e.target.closest('.card-author')) return;
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
        const authorLink = card.querySelector('.card-author');
        if (authorLink) authorLink.addEventListener('click', function (e) {
            e.stopPropagation();
            openProfile(this.getAttribute('data-author'));
        });
        wrap.appendChild(card);
    });
    scheduleMasonry();
}

let masonryRaf = null;

function scheduleMasonry() {
    if (masonryRaf) return;
    masonryRaf = requestAnimationFrame(function () {
        masonryRaf = null;
        layoutMasonry();
    });
}

function layoutMasonry() {
    const grid = document.getElementById('postList');
    if (!grid) return;
    const cards = Array.prototype.slice.call(grid.children);
    if (!cards.length) {
        grid.classList.remove('masonry');
        grid.style.height = '';
        return;
    }
    const width = grid.clientWidth;
    if (!width) return;
    grid.classList.add('masonry');
    const vw = window.innerWidth;
    const cols = vw <= 760 ? 2 : (vw <= 1300 ? 4 : 5);
    const gap = cols === 2 ? 10 : 14;
    const colWidth = (width - gap * (cols - 1)) / cols;
    const heights = new Array(cols).fill(0);
    cards.forEach(function (card) {
        card.style.position = 'absolute';
        card.style.width = colWidth + 'px';
        let col = 0;
        for (let i = 1; i < cols; i++) {
            if (heights[i] < heights[col]) col = i;
        }
        card.style.transform = 'translate3d(' + (col * (colWidth + gap)) + 'px, ' + heights[col] + 'px, 0)';
        heights[col] += card.offsetHeight + gap;
    });
    grid.style.height = (Math.max.apply(null, heights) - gap) + 'px';
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
            alert(T('loginToNotifs'));
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
        list.innerHTML = '<div class="notif-item"><div class="notif-text">' + T('notifLogin') + '</div></div>';
        return;
    }
    list.innerHTML = '<div class="notif-item"><div class="notif-text">' + T('notifLoading') + '</div></div>';
    let data;
    try {
        const res = await Auth.get('/api/notifs');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
    } catch (e) {
        list.innerHTML = '<div class="notif-item"><div class="notif-text">' + T('notifFailed') + '</div></div>';
        return;
    }
    const notifs = data.notifs || [];
    if (!notifs.length) {
        list.innerHTML = '<div class="notif-item"><div class="notif-text">' + T('notifEmpty') + '</div></div>';
        return;
    }
    list.innerHTML = notifs.map(function (n) {
        // 已读的通知整体淡化，和未读区分开
        return '<div class="notif-item"' + (n.is_read ? ' style="opacity:0.55;"' : '') + '>' +
               '<div class="notif-title">' + escapeHtml(n.title) + '</div>' +
               '<div class="notif-text">' + escapeHtml(n.text) + '</div>' +
               '<div class="notif-time">' + escapeHtml(formatTime(n)) + '</div></div>';
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
        alert(T('loginToPost'));
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
    if (imageProcessing) { alert(T('uploadPending')); return; }
    const room = maxPostImages - uploadedImages.length;
    if (room <= 0) {
        alert(T('maxImages', { n: maxPostImages }));
        return;
    }
    if (files.length > room) {
        alert(T('maxImagesIgnored', { n: maxPostImages, extra: files.length - room }));
    }
    const todo = files.slice(0, room);
    const taskId = imageTaskId;
    imageProcessing = true;
    for (let i = 0; i < todo.length; i++) {
        if (taskId !== imageTaskId) break;
        const file = todo[i];
        if (!file.type || !file.type.startsWith('image/')) { alert(T('imageOnly')); continue; }
        if (file.size > MAX_IMAGE_BYTES) { alert(T('imageTooLarge', { name: file.name || '' })); continue; }
        setUploadHint(T('uploadProcessing', { i: i + 1, n: todo.length }));
        try {
            const blob = await prepareImageBlob(file);
            if (taskId !== imageTaskId) break;
            setUploadHint(T('uploadUploading', { i: i + 1, n: todo.length }));
            const url = await uploadImageBlob(blob, file.name);
            if (taskId !== imageTaskId) break;
            if (uploadedImages.length >= maxPostImages) break;
            uploadedImages.push(url);
            renderImagePreviews();
        } catch (e) {
            if (taskId !== imageTaskId) break;
            alert(T('uploadFailed', { error: e.message }));
        }
    }
    if (taskId === imageTaskId) {
        imageProcessing = false;
        setUploadHint(uploadedImages.length ? T('uploadedCount', { i: uploadedImages.length, n: maxPostImages }) : '');
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
            '<button type="button" class="image-remove" data-i="' + i + '" title="' + T('remove') + '">×</button>' +
        '</div>';
    }).join('');
    wrap.querySelectorAll('.image-remove').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            uploadedImages.splice(Number(this.getAttribute('data-i')), 1);
            renderImagePreviews();
            setUploadHint(uploadedImages.length ? T('uploadedCount', { i: uploadedImages.length, n: maxPostImages }) : '');
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
                label.textContent = T('postImageLabelLevel', { level: cfg.level || 1, n: maxPostImages });
            }
        }
        const ph = document.getElementById('uploadPlaceholder');
        if (ph && cfg && cfg.upload_enabled === false) {
            ph.textContent = T('postImageNotConfigured');
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
        html = '<span style="color:var(--text-dim);font-size:13px;">' + T('postNoTags') + '</span>';
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
    if (!title) { alert(T('enterTitle')); return; }
    if (!content) { alert(T('enterContent')); return; }
    if (imageProcessing) { alert(T('uploadPending')); return; }

    const btn = document.getElementById('submitPostBtn');
    btn.disabled = true;
    btn.textContent = T('postPublishing');

    try {
        const res = await Auth.post(API, {
            title: title, content: content,
            tags: selectedTags.join(','), images: uploadedImages
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || T('publishFailed', { error: '' }));
        }
        closePostModal();
        await fetchConfig();
        await fetchPosts();
        await fetchTags();
    } catch (e) {
        alert(T('publishFailed', { error: e.message }));
    } finally {
        btn.disabled = false;
        btn.textContent = T('postSubmit');
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
            alert(T('loginToLike'));
            window.location.href = 'login.html';
            return;
        }
        // 以服务端 liked 为准；本地记录只作为旧接口兜底
        const likedBefore = currentPost.liked !== undefined
            ? !!currentPost.liked
            : (getLiked().indexOf(currentPost.id) !== -1);
        const on = !likedBefore;
        btn.disabled = true;
        try {
            const res = await Auth.post(API + '/' + currentPost.id + '/like', { on: on });
            if (!res.ok) {
                const err = await res.json().catch(function () { return {}; });
                throw new Error(err.error || T('likeFailed'));
            }
            const data = await res.json();
            currentPost.likes = data.likes;
            currentPost.liked = (typeof data.liked === 'boolean') ? data.liked : on;
            const inList = allPosts.find(function (x) { return x.id === currentPost.id; });
            if (inList) { inList.likes = currentPost.likes; inList.liked = currentPost.liked; }
            const liked = getLiked();
            const idx = liked.indexOf(currentPost.id);
            if (currentPost.liked && idx === -1) liked.push(currentPost.id);
            if (!currentPost.liked && idx !== -1) liked.splice(idx, 1);
            localStorage.setItem(K_LIKED, JSON.stringify(liked));
            updateFooterButtons();
        } catch (e) {
            alert(T('likeFailed') + ' ' + e.message);
        } finally {
            btn.disabled = false;
        }
    });
    document.getElementById('footerCoin').addEventListener('click', function () {
        if (!currentPost || this.disabled) return;
        if (!Auth.isLoggedIn()) {
            alert(T('loginToCoin'));
            window.location.href = 'login.html';
            return;
        }
        if (Auth.user && currentPost.author === Auth.user.username) return;
        const alreadyCoined = currentPost.coined !== undefined
            ? !!currentPost.coined
            : (getCoined().indexOf(currentPost.id) !== -1);
        if (alreadyCoined) return;
        openCoinModal();
    });
    document.getElementById('footerStar').addEventListener('click', function () {
        if (!currentPost) return;
        toggleBookmark(currentPost.id);
        updateFooterButtons();
    });
    document.getElementById('replyCancel').addEventListener('click', resetReplyTarget);
    document.getElementById('commentInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing) submitComment();
    });
    const moreBtn = document.getElementById('footerMore');
    const moreMenu = document.getElementById('detailMoreMenu');
    const moreDelete = document.getElementById('moreDelete');
    const moreReport = document.getElementById('moreReport');
    if (moreBtn && moreMenu && moreDelete && moreReport) {
        moreBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!currentPost) return;
            const canDelete = Auth.isLoggedIn() && (Auth.isAdmin() || Auth.user.username === currentPost.author);
            moreDelete.hidden = !canDelete;
            moreReport.hidden = canDelete;
            const willOpen = moreMenu.hidden;
            moreMenu.hidden = !willOpen;
            moreBtn.setAttribute('aria-expanded', String(willOpen));
        });
        moreDelete.addEventListener('click', function () {
            closeDetailMoreMenu();
            deleteCurrentPost();
        });
        moreReport.addEventListener('click', function () {
            closeDetailMoreMenu();
            alert(T('reportSoon'));
        });
        document.addEventListener('click', function (e) {
            if (moreMenu.hidden) return;
            if (moreMenu.contains(e.target) || e.target === moreBtn) return;
            closeDetailMoreMenu();
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closeDetailMoreMenu();
        });
    }
    const coinModal = document.getElementById('coinModal');
    if (coinModal) {
        document.getElementById('coinClose').addEventListener('click', closeCoinModal);
        document.getElementById('coinCancel').addEventListener('click', closeCoinModal);
        coinModal.addEventListener('click', function (e) {
            if (e.target === this) closeCoinModal();
        });
        document.querySelectorAll('.coin-option').forEach(function (btn) {
            btn.addEventListener('click', function () {
                giveCoin(Number(this.getAttribute('data-amount')));
            });
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && !coinModal.hidden) closeCoinModal();
        });
    }
}

function openCoinModal() {
    const modal = document.getElementById('coinModal');
    if (!modal) return;
    document.querySelectorAll('.coin-option').forEach(function (b) { b.disabled = false; });
    modal.hidden = false;
}

function closeCoinModal() {
    const modal = document.getElementById('coinModal');
    if (modal) modal.hidden = true;
}

async function giveCoin(amount) {
    if (!currentPost || (amount !== 1 && amount !== 2)) return;
    const modal = document.getElementById('coinModal');
    if (!modal || modal.hidden) return;
    const options = Array.prototype.slice.call(modal.querySelectorAll('.coin-option'));
    options.forEach(function (b) { b.disabled = true; });
    try {
        const res = await Auth.post(API + '/' + currentPost.id + '/coin', { on: true, amount: amount });
        if (!res.ok) {
            const err = await res.json().catch(function () { return {}; });
            throw new Error(err.error || T('coinFailed'));
        }
        const data = await res.json();
        currentPost.coins = data.coins;
        currentPost.coined = (typeof data.coined === 'boolean') ? data.coined : true;
        const coined = getCoined();
        if (coined.indexOf(currentPost.id) === -1) coined.push(currentPost.id);
        localStorage.setItem(K_COINED, JSON.stringify(coined));
        closeCoinModal();
        updateFooterButtons();
    } catch (e) {
        options.forEach(function (b) { b.disabled = false; });
        alert(T('coinFailed') + ' ' + e.message);
    }
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

function closeDetailMoreMenu() {
    const menu = document.getElementById('detailMoreMenu');
    const btn = document.getElementById('footerMore');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

function closeDetail() {
    closeImageViewer();
    closeDetailMoreMenu();
    closeCoinModal();
    resetReplyTarget();
    expandedReplyThreads = {};
    document.getElementById('detailModal').hidden = true;
    document.body.style.overflow = '';
    currentPost = null;
    allComments = [];
    render();
}

function renderDetail() {
    const p = currentPost;
    resetReplyTarget();
    expandedReplyThreads = {};
    detailImages = getPostImages(p);
    detailImageIndex = 0;
    renderDetailImages();
    const detailGrid = document.querySelector('.detail-grid');
    if (detailGrid) detailGrid.classList.toggle('no-image', !detailImages.length);
    document.getElementById('detailAuthorName').textContent = p.author || T('anonymous');
    document.getElementById('detailLikes').textContent = '♥ ' + (p.likes || 0);
    document.getElementById('detailTitle').textContent = p.title || T('untitled');
    document.getElementById('detailContent').textContent = p.content || '';
    document.getElementById('detailTime').textContent = formatTime(p);
    document.getElementById('commentCount').textContent = allComments.length;
    // 登录后显示用户名
    document.getElementById('commentAuthor').value = Auth.isLoggedIn() ? Auth.user.username : '';
    closeDetailMoreMenu();
    renderComments();
    updateFooterButtons();
}

async function deleteCurrentPost() {
    if (!currentPost) return;
    if (!confirm(T('deletePostConfirm'))) return;
    try {
        await Auth.del(API + '/' + currentPost.id);
        closeDetail();
        await fetchPosts();
    } catch (e) { alert(T('deleteFailed') + ' ' + e.message); }
}

function getCommentLiked() {
    try {
        return JSON.parse(localStorage.getItem(K_COMMENT_LIKED) || '[]');
    } catch (e) {
        return [];
    }
}

function resetReplyTarget() {
    replyTarget = null;
    const bar = document.getElementById('replyBar');
    if (bar) bar.hidden = true;
    const input = document.getElementById('commentInput');
    if (input) input.placeholder = T('commentPlaceholder');
}

function startReply(comment) {
    if (!Auth.isLoggedIn()) {
        alert(T('loginToReply'));
        window.location.href = 'login.html';
        return;
    }
    replyTarget = { id: comment.id, author: comment.author };
    const bar = document.getElementById('replyBar');
    const name = document.getElementById('replyName');
    const input = document.getElementById('commentInput');
    if (bar) bar.hidden = false;
    if (name) name.textContent = comment.author || '';
    if (input) {
        input.placeholder = T('replyTo', { name: comment.author || '' }) + '...';
        input.focus();
    }
}

function commentHtml(c, opts) {
    opts = opts || {};
    const postAuthor = currentPost ? currentPost.author : '';
    const me = Auth.isLoggedIn() ? Auth.user.username : '';
    const isAdmin = Auth.isAdmin();
    const isReply = !!opts.isReply;
    const isAuthor = c.author === postAuthor;
    const canDel = isAdmin || c.author === me;
    const liked = c.liked !== undefined ? !!c.liked : (getCommentLiked().indexOf(c.id) !== -1);
    return '<div class="comment-item' + (isReply ? ' comment-reply' : '') + '" data-cid="' + c.id + '">' +
        '<div class="comment-head">' +
            '<div class="comment-avatar' + (isReply ? ' small' : '') + '"></div>' +
            '<span class="comment-name">' + escapeHtml(c.author) + '</span>' +
            (isAuthor ? '<span class="comment-author-tag">' + T('op') + '</span>' : '') +
            (isReply && c.reply_to ? '<span class="comment-reply-to">' + escapeHtml(T('replyTo', { name: c.reply_to })) + '</span>' : '') +
            (!isReply ? '<span class="comment-floor">' + (opts.floor || 0) + 'F</span>' : '') +
            (canDel ? '<button class="comment-del" data-cid="' + c.id + '" title="' + T('delete') + '">' + T('deleteShort') + '</button>' : '') +
        '</div>' +
        '<div class="comment-text">' + escapeHtml(c.content) + '</div>' +
        '<div class="comment-actions">' +
            '<button type="button" class="comment-action comment-like' + (liked ? ' active' : '') + '" data-cid="' + c.id + '" title="' + T('like') + '">' +
                '<svg class="icon icon-heart" aria-hidden="true"><use href="#i-like"></use></svg><span>' + (c.likes || 0) + '</span>' +
            '</button>' +
            '<button type="button" class="comment-action comment-reply-btn" data-cid="' + c.id + '" title="' + T('reply') + '">' +
                '<svg class="icon" aria-hidden="true"><use href="#i-reply"></use></svg>' + T('reply') +
            '</button>' +
            '<span class="comment-time">' + formatTime(c) + '</span>' +
        '</div>' +
    '</div>';
}

function renderComments() {
    const list = document.getElementById('commentsList');
    if (!allComments.length) {
        list.innerHTML = '<div style="color:var(--text-dim);font-size:13px;padding:20px 0;text-align:center;">' + T('commentsEmpty') + '</div>';
        return;
    }
    const byId = {};
    allComments.forEach(function (c) { byId[c.id] = c; });
    const roots = allComments.filter(function (c) {
        return !c.parent_id || !byId[c.parent_id];
    }).sort(function (a, b) { return a.id - b.id; });
    const floorMap = {};
    roots.forEach(function (c, i) { floorMap[c.id] = i + 1; });
    const children = {};
    allComments.forEach(function (c) {
        if (!c.parent_id || !byId[c.parent_id]) return;
        (children[c.parent_id] = children[c.parent_id] || []).push(c);
    });
    Object.keys(children).forEach(function (k) {
        children[k].sort(function (a, b) { return a.id - b.id; });
    });
    const ordered = commentSort === 'latest' ? roots.slice().reverse() : roots;
    list.innerHTML = ordered.map(function (root) {
        const replies = children[root.id] || [];
        let html = commentHtml(root, { floor: floorMap[root.id] });
        if (replies.length) {
            const expanded = !!expandedReplyThreads[root.id];
            const shown = expanded ? replies : replies.slice(0, 1);
            html += '<div class="comment-replies">' +
                shown.map(function (r) {
                    return commentHtml(r, { isReply: true });
                }).join('');
            if (replies.length > 1) {
                html += '<button type="button" class="comment-replies-toggle" data-root="' + root.id + '">' +
                    (expanded ? T('collapseReplies') : T('showMoreReplies', { n: replies.length - 1 })) +
                '</button>';
            }
            html += '</div>';
        }
        return html;
    }).join('');
    bindCommentActions();
}

function bindCommentActions() {
    const list = document.getElementById('commentsList');
    list.querySelectorAll('.comment-del').forEach(function (btn) {
        btn.addEventListener('click', async function () {
            const cid = Number(this.getAttribute('data-cid'));
            const replies = allComments.filter(function (c) { return c.parent_id === cid; });
            const msg = replies.length
                ? T('deleteCommentRepliesConfirm', { n: replies.length })
                : T('deleteCommentConfirm');
            if (!confirm(msg)) return;
            try {
                await Auth.del(API + '/' + currentPost.id + '/comments/' + cid);
                await reloadComments();
            } catch (e) {
                alert(T('deleteFailed') + ' ' + e.message);
            }
        });
    });
    list.querySelectorAll('.comment-like').forEach(function (btn) {
        btn.addEventListener('click', async function () {
            if (!Auth.isLoggedIn()) {
                alert(T('loginToLike'));
                window.location.href = 'login.html';
                return;
            }
            const cid = Number(this.getAttribute('data-cid'));
            const c = allComments.find(function (x) { return x.id === cid; });
            if (!c || this.disabled) return;
            const currentlyLiked = c.liked !== undefined
                ? !!c.liked
                : (getCommentLiked().indexOf(cid) !== -1);
            const on = !currentlyLiked;
            this.disabled = true;
            try {
                const res = await Auth.post(API + '/' + currentPost.id + '/comments/' + cid + '/like', { on: on });
                if (!res.ok) {
                    const err = await res.json().catch(function () { return {}; });
                    throw new Error(err.error || T('likeFailed'));
                }
                const data = await res.json();
                c.likes = data.likes;
                c.liked = (typeof data.liked === 'boolean') ? data.liked : on;
                const liked = getCommentLiked();
                const idx = liked.indexOf(cid);
                if (c.liked && idx === -1) liked.push(cid);
                if (!c.liked && idx !== -1) liked.splice(idx, 1);
                localStorage.setItem(K_COMMENT_LIKED, JSON.stringify(liked));
                this.classList.toggle('active', c.liked);
                const span = this.querySelector('span');
                if (span) span.textContent = data.likes;
            } catch (e) {
                alert(T('likeFailed') + ' ' + e.message);
            } finally {
                this.disabled = false;
            }
        });
    });
    list.querySelectorAll('.comment-replies-toggle').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const rid = Number(this.getAttribute('data-root'));
            if (expandedReplyThreads[rid]) delete expandedReplyThreads[rid];
            else expandedReplyThreads[rid] = true;
            const scrollTop = list.scrollTop;
            renderComments();
            list.scrollTop = scrollTop;
        });
    });
    list.querySelectorAll('.comment-reply-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            const cid = Number(this.getAttribute('data-cid'));
            const c = allComments.find(function (x) { return x.id === cid; });
            if (c) startReply(c);
        });
    });
}

async function reloadComments() {
    if (!currentPost) return;
    try {
        const res = await Auth.get(API + '/' + currentPost.id + '/comments');
        if (res.ok) allComments = await res.json();
    } catch (e) {}
    if (replyTarget && !allComments.some(function (c) { return c.id === replyTarget.id; })) {
        resetReplyTarget();
    }
    document.getElementById('commentCount').textContent = allComments.length;
    renderComments();
}

async function submitComment() {
    if (!Auth.isLoggedIn()) {
        alert(T('loginToComment'));
        window.location.href = 'login.html';
        return;
    }
    const input = document.getElementById('commentInput');
    const text = input.value.trim();
    if (!text || !currentPost) return;
    const payload = { content: text };
    let rootToExpand = 0;
    if (replyTarget) {
        payload.parent_id = replyTarget.id;
        const target = allComments.find(function (c) { return c.id === replyTarget.id; });
        rootToExpand = target ? (target.parent_id || target.id) : replyTarget.id;
    }
    try {
        const res = await Auth.post(API + '/' + currentPost.id + '/comments', payload);
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || T('commentFailed'));
        }
        input.value = '';
        resetReplyTarget();
        if (rootToExpand) expandedReplyThreads[rootToExpand] = true;
        await reloadComments();
        const list = document.getElementById('commentsList');
        if (list) list.scrollTop = commentSort === 'latest' ? 0 : list.scrollHeight;
    } catch (e) {
        alert(T('commentFailed') + ' ' + e.message);
    }
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
    box.innerHTML = '<img src="' + escapeHtml(detailImages[detailImageIndex]) + '" alt="' + T('imageAlt') + '" decoding="async">';
    if (!thumbs) return;
    if (detailImages.length <= 1) {
        thumbs.hidden = true;
        thumbs.innerHTML = '';
        return;
    }
    thumbs.hidden = false;
    thumbs.innerHTML = detailImages.map(function (u, i) {
        return '<button type="button" class="detail-thumb' + (i === detailImageIndex ? ' active' : '') +
            '" data-i="' + i + '" title="' + T('imageNumber', { n: i + 1 }) + '">' +
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
    body.innerHTML = '<div class="profile-empty">' + T('profileLoading') + '</div>';
    try {
        const res = await Auth.get('/api/users/' + encodeURIComponent(username));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        renderProfile(data);
    } catch (e) {
        body.innerHTML = '<div class="profile-empty">' + T('profileFailed') + '</div>';
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
            '<div class="profile-name">' + escapeHtml(u.username || T('profileUnknown')) +
                (u.is_admin ? '<span class="profile-badge">' + T('profileAdmin') + '</span>' : '') +
                (u.username !== (Auth.user && Auth.user.username)
                    ? '<button type="button" class="profile-msg" data-user="' + escapeHtml(u.username) + '">' + T('profileMessage') + '</button>'
                    : '') + '</div>' +
            '<div class="profile-meta">Lv.' + (u.level || 1) + ' · ' +
                T('profilePostsJoined', { n: (u.post_count || 0), date: formatTime(u) }) + '</div>' +
        '</div>' +
    '</div>';
    if (!posts.length) {
        html += '<div class="profile-empty">' + T('profileNoPosts') + '</div>';
    } else {
        html += '<div class="profile-section-title">' + T('profileRecent') + '</div><div class="profile-posts">';
        posts.forEach(function (p) {
            const cover = getPostImages(p)[0] || '';
            html += '<div class="profile-post" data-id="' + p.id + '">' +
                '<div class="profile-post-thumb">' +
                    (cover ? '<img src="' + escapeHtml(cover) + '" alt="" loading="lazy" decoding="async">'
                           : '<svg class="icon" aria-hidden="true"><use href="#i-image"></use></svg>') +
                '</div>' +
                '<div class="profile-post-main">' +
                    '<div class="profile-post-title">' + escapeHtml(p.title || T('untitled')) + '</div>' +
                    '<div class="profile-post-meta">' +
                        '<svg class="icon" aria-hidden="true"><use href="#i-like"></use></svg>' + (p.likes || 0) +
                        '<svg class="icon" aria-hidden="true"><use href="#i-eye"></use></svg>' + (p.views || 0) +
                        '<svg class="icon" aria-hidden="true"><use href="#i-reply"></use></svg>' + (p.replies || 0) +
                        '<span class="profile-post-time">' + formatTime(p) + '</span>' +
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
        alert(T('loginToMessages'));
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
    document.getElementById('messageTitle').textContent = T('messagesTitle');
    document.getElementById('messageCompose').hidden = true;
    const body = document.getElementById('messageBody');
    body.innerHTML = '<div class="message-empty">' + T('msgLoading') + '</div>';
    try {
        const res = await Auth.get('/api/messages');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        renderInbox(data);
        updateMsgDot((data.unread || 0) > 0);
    } catch (e) {
        body.innerHTML = '<div class="message-empty">' + T('msgFailed') + '</div>';
    }
}

function renderInbox(data) {
    const body = document.getElementById('messageBody');
    const list = data.conversations || [];
    if (!list.length) {
        body.innerHTML = '<div class="message-empty">' + T('msgEmpty') + '</div>';
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
            '<span class="conv-time">' + formatTime(c, 'time') + '</span>' +
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
        alert(T('loginToMessages'));
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
    document.getElementById('messageTitle').textContent = T('msgWith', { name: username });
    const body = document.getElementById('messageBody');
    body.innerHTML = '<div class="message-empty">' + T('msgLoading') + '</div>';
    try {
        const res = await Auth.get('/api/messages/' + encodeURIComponent(username));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        renderThread(data);
        document.getElementById('messageCompose').hidden = false;
        refreshMsgDot();
    } catch (e) {
        body.innerHTML = '<div class="message-empty">' + T('msgFailed') + '</div>';
        document.getElementById('messageCompose').hidden = true;
    }
}

function renderThread(data) {
    const body = document.getElementById('messageBody');
    const msgs = data.messages || [];
    let html = '<button type="button" class="msg-back" id="msgBack">' + T('msgBack') + '</button>';
    if (!msgs.length) {
        html += '<div class="message-empty">' + T('msgThreadEmpty') + '</div>';
    } else {
        html += '<div class="msg-thread">' + msgs.map(function (m) {
            const mine = Auth.user && m.sender === Auth.user.username;
            return '<div class="msg-row ' + (mine ? 'me' : 'peer') + '">' +
                '<div class="msg-bubble">' + escapeHtml(m.content) + '</div>' +
                '<div class="msg-time">' + formatTime(m) + '</div>' +
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
            throw new Error(err.error || T('sendFailed'));
        }
        input.value = '';
        await openMessageThread(currentChatUser);
    } catch (e) {
        alert(T('sendFailed') + ' ' + e.message);
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
    img.alt = (currentPost && currentPost.title) ? currentPost.title : T('imageAlt');
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
    const bm = getBookmarks();
    const liked = currentPost.liked !== undefined
        ? !!currentPost.liked
        : (getLiked().indexOf(currentPost.id) !== -1);
    const coined = currentPost.coined !== undefined
        ? !!currentPost.coined
        : (getCoined().indexOf(currentPost.id) !== -1);
    document.getElementById('footerLikeCount').textContent = currentPost.likes || 0;
    document.getElementById('footerCoinCount').textContent = currentPost.coins || 0;
    document.getElementById('footerStarCount').textContent = bm.indexOf(currentPost.id) !== -1 ? 1 : 0;
    const likeBtn = document.getElementById('footerLike');
    const coinBtn = document.getElementById('footerCoin');
    const isOwn = !!(Auth.isLoggedIn() && Auth.user && currentPost.author === Auth.user.username);
    likeBtn.classList.toggle('active', liked);
    coinBtn.classList.toggle('active', coined);
    coinBtn.disabled = coined || isOwn;
    coinBtn.classList.toggle('coin-own', isOwn);
    coinBtn.title = isOwn ? T('coinOwn') : (coined ? T('coinedTitle') : T('coinTitle'));
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

function parseUtc(t) {
    const m = String(t || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    return isNaN(d.getTime()) ? null : d;
}

function relativeTime(t) {
    const d = parseUtc(t);
    if (!d) return '-';
    const lang = (window.I18n && I18n.lang === 'en') ? 'en' : 'zh';
    const diff = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (diff < 60) return lang === 'en' ? 'Just now' : '刚刚';
    if (diff < 3600) {
        const n = Math.floor(diff / 60);
        return lang === 'en' ? n + ' min ago' : n + '分钟前';
    }
    if (diff < 86400) {
        const n = Math.floor(diff / 3600);
        return lang === 'en' ? n + ' hr ago' : n + '小时前';
    }
    if (diff < 30 * 86400) {
        const n = Math.floor(diff / 86400);
        return lang === 'en' ? n + (n === 1 ? ' day ago' : ' days ago') : n + '天前';
    }
    const now = new Date();
    if (d.getFullYear() !== now.getFullYear()) {
        return lang === 'en'
            ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
            : d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }
    return lang === 'en'
        ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function formatExactTime(t) {
    const d = parseUtc(t);
    if (!d) return t || '-';
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function formatTime(obj, key) {
    key = key || 'created_at';
    if (!obj) return '-';
    if (typeof obj === 'string') return relativeTime(obj);
    if (Auth.isAdmin() && obj[key]) return formatExactTime(obj[key]);
    const lang = (window.I18n && I18n.lang === 'en') ? 'en' : 'zh';
    return obj[key + '_' + lang] || relativeTime(obj[key]) || '-';
}
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
