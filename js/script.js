// ============================================
// 首页逻辑：极简 BBS 列表 + 详情弹窗 + 发帖弹窗
// ============================================

const API = '/api/posts';

let allPosts = [];
let currentTab = 'latest';
let currentBoard = 'all';
let publishBoard = 'general';
let mdPreviewActive = false;
let mdPreviewTimer = null;
let mdPreviewRequest = 0;
let tripleSuppressClickUntil = 0;
let triplePressState = null;
let tripleToastTimer = null;
let detailReturnScrollY = null;
let scrollRestoreTarget = null;
let scrollRestoreDeadline = 0;
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
let commentSubmitting = false;
let readsSyncing = false;
let followingUsers = new Set();
let profileMasonryRaf = null;
let mentionTimer = null;
let mentionRequestId = 0;
let mentionItems = [];
let mentionActiveIndex = 0;

function T(key, vars) {
    return window.I18n ? I18n.t(key, vars) : key;
}

const K_READ = 'ywies_read';
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
    bindBoards();
    bindSearch();
    bindBell();
    bindDetailModal();
    bindPostModal();
    bindProfileModal();
    bindMessages();
    bindImageViewer();

    // 帖子优先加载；次要请求错开，减少同时抢数据库连接
    fetchPosts();
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
        if (!document.hidden) {
            if (!allPosts.length || postsLoadFailed) fetchPosts();
            syncReads();
            syncFollowing();
            refreshBellDot();
            refreshMsgDot();
        }
    });
    window.addEventListener('pageshow', function (e) {
        if (e.persisted) fetchPosts();
    });
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', refreshSite);
    window.addEventListener('resize', function () { scheduleMasonry(); scheduleProfileMasonry(); });
    window.addEventListener('load', scheduleMasonry);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(scheduleMasonry);
    document.addEventListener('i18n:change', function () {
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
        await Promise.all([fetchPosts(), fetchConfig(), refreshBellDot(), refreshMsgDot(), syncReads(), syncFollowing()]);
    } catch (e) {}
    setTimeout(function () { btn.classList.remove('spinning'); }, 400);
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initAuth() {
    const logged = Auth.isLoggedIn();
    followingUsers = new Set(getFollowing());
    updateCoinBalance();
    updateHeaderAvatar();
    const me = document.getElementById('meBtn');
    if (me) {
        me.addEventListener('click', function () {
            if (Auth.isLoggedIn() && Auth.user && Auth.user.username) {
                openProfile(Auth.user.username);
            } else {
                window.location.href = 'login.html';
            }
        });
    }
    if (logged) {
        refreshMe();
        syncReads();
        syncFollowing();
    }
}

function doLogout() {
    const token = Auth.token;
    Auth.logout();
    if (token) {
        fetch('/api/logout', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token },
            keepalive: true
        }).catch(function () {});
    }
    window.location.reload();
}

function updateCoinBalance() {
    const el = document.getElementById('coinBalance');
    const num = document.getElementById('coinBalanceNum');
    if (!el || !num) return;
    if (!Auth.isLoggedIn()) {
        el.hidden = true;
        return;
    }
    el.hidden = false;
    num.textContent = (Auth.user && Auth.user.coins !== undefined && Auth.user.coins !== null)
        ? Auth.user.coins : 0;
}

async function refreshMe() {
    if (!Auth.isLoggedIn()) { updateCoinBalance(); return; }
    try {
        const res = await Auth.get('/api/me');
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.user) {
            Auth.user = data.user;
            Auth.save(Auth.token, Auth.user);
            updateCoinBalance();
            updateHeaderAvatar();
        }
    } catch (e) {}
}

async function syncReads() {
    if (!Auth.isLoggedIn() || readsSyncing) return;
    readsSyncing = true;
    try {
        const res = await Auth.get('/api/reads');
        if (!res.ok) return;
        const data = await res.json();
        const server = Array.isArray(data.posts) ? data.posts.slice() : [];
        const local = getRead();
        const missing = local.filter(function (id) { return server.indexOf(id) === -1; });
        if (missing.length) {
            await Auth.post('/api/reads/sync', { posts: missing });
            missing.forEach(function (id) { if (server.indexOf(id) === -1) server.push(id); });
        }
        localStorage.setItem(K_READ, JSON.stringify(server));
        render();
    } catch (e) {
    } finally {
        readsSyncing = false;
    }
}

function updateHeaderAvatar() {
    const btn = document.getElementById('meBtn');
    if (!btn) return;
    const avatar = Auth.isLoggedIn() && Auth.user ? (Auth.user.avatar || '') : '';
    btn.innerHTML = avatar
        ? '<img src="' + escapeHtml(avatar) + '" alt="">'
        : '<svg class="icon" aria-hidden="true"><use href="#i-user"></use></svg>';
    btn.title = T('myProfile');
}

async function syncFollowing() {
    if (!Auth.isLoggedIn()) return;
    try {
        const res = await Auth.get('/api/follows');
        if (!res.ok) return;
        const data = await res.json();
        followingUsers = new Set(Array.isArray(data.following) ? data.following : []);
        localStorage.setItem(K_FOLLOW, JSON.stringify(Array.from(followingUsers)));
        if (currentTab === 'followed') render();
    } catch (e) {}
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
                board: p.board || 'general',
                kind: p.kind || 'post',
                format: p.format || 'plain',
                music_artist: p.music_artist || '',
                music_url: p.music_url || '',
                poll: p.poll || null,
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

function normalizeTag(tag) {
    return String(tag == null ? '' : tag).trim().replace(/^#+/, '').trim();
}

function boardLabel(board) {
    const map = {
        general: 'boardGeneral', study: 'boardStudy', music: 'boardMusic',
        poll: 'boardPoll', share: 'boardShare'
    };
    return T(map[board] || 'boardGeneral');
}

function boardPill(board) {
    board = board || 'general';
    return '<span class="board-pill ' + escapeHtml(board) + '">' + escapeHtml(boardLabel(board)) + '</span>';
}

function avatarMarkup(url, name, className) {
    const initial = String(name || '?').trim().slice(0, 1).toUpperCase() || '?';
    if (url) {
        return '<span class="' + className + '"><img src="' + escapeHtml(url) + '" alt=""></span>';
    }
    return '<span class="' + className + '"><span class="avatar-initial">' + escapeHtml(initial) + '</span></span>';
}

function getPostTags(post) {
    const seen = [];
    String((post && post.tags) || '').split(',').forEach(function (t) {
        const name = normalizeTag(t);
        if (name && seen.indexOf(name) === -1) seen.push(name);
    });
    return seen;
}

function applyTagFilter(tag) {
    const name = normalizeTag(tag);
    currentTag = '';
    currentTab = 'latest';
    searchQuery = name ? '#' + name : '';
    const search = document.getElementById('searchInput');
    if (search) search.value = searchQuery;
    document.querySelectorAll('.tab').forEach(function (t) {
        t.classList.toggle('active', t.getAttribute('data-tab') === 'latest');
    });
    if (!document.getElementById('detailModal').hidden) closeDetail();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------- 列表渲染 ----------
function hotScore(post) {
    return (Number(post.coins) || 0) * 0.35 +
        (Number(post.likes) || 0) * 0.30 +
        (Number(post.bookmark_count) || 0) * 0.25 +
        (Number(post.views) || 0) * 0.10;
}

function hotRank(list) {
    const pins = list.filter(function (p) { return p.is_pinned; })
        .sort(function (a, b) {
            return (Number(b.pin_order) || 0) - (Number(a.pin_order) || 0) || b.id - a.id;
        });
    const rest = list.filter(function (p) { return !p.is_pinned; });
    let latestComment = null;
    rest.forEach(function (p) {
        if (!p.last_comment_at) return;
        if (!latestComment || p.last_comment_at > latestComment.last_comment_at ||
            (p.last_comment_at === latestComment.last_comment_at && p.id > latestComment.id)) {
            latestComment = p;
        }
    });
    const others = rest.filter(function (p) { return p !== latestComment; });
    others.sort(function (a, b) {
        const diff = hotScore(b) - hotScore(a);
        if (Math.abs(diff) > 0.000001) return diff;
        return b.id - a.id;
    });
    return pins.concat(latestComment ? [latestComment] : [], others);
}

function render() {
    let list = allPosts.slice();
    if (currentTag) {
        list = list.filter(function (p) { return getPostTags(p).indexOf(currentTag) !== -1; });
    }
    if (searchQuery) {
        const q = normalizeTag(searchQuery).toLowerCase();
        list = list.filter(function (p) {
            return (p.title || '').toLowerCase().includes(q) ||
                   (p.content || '').toLowerCase().includes(q) ||
                   (p.author || '').toLowerCase().includes(q) ||
                   getPostTags(p).join(' ').toLowerCase().includes(q);
        });
    }
    if (currentBoard !== 'all') {
        list = list.filter(function (p) { return (p.board || 'general') === currentBoard; });
    }
    const pinSort = function (a, b) {
        return (Number(b.pin_order) || 0) - (Number(a.pin_order) || 0) || b.id - a.id;
    };
    if (currentTab === 'latest') {
        list.sort(function (a, b) { return b.id - a.id; });
        const pins = list.filter(function (p) { return p.is_pinned; }).sort(pinSort);
        list = pins.concat(list.filter(function (p) { return !p.is_pinned; }));
    } else if (currentTab === 'hot') {
        list = hotRank(list);
    } else if (currentTab === 'unread') {
        const read = getRead();
        list = list.filter(function (p) { return read.indexOf(p.id) === -1; })
                   .sort(function (a, b) { return b.id - a.id; });
    } else if (currentTab === 'followed') {
        list = list.filter(function (p) { return followingUsers.has(p.author); })
                   .sort(function (a, b) { return b.id - a.id; });
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
        const postImages = getPostImages(p);
        const cover = postImages[0] || '';
        const tags = getPostTags(p);
        const tagsHtml = tags.length
            ? '<div class="card-tags">' + tags.map(function (t) {
                return '<button type="button" class="card-tag-chip" data-tag="' + escapeHtml(t) + '">#' + escapeHtml(t) + '</button>';
            }).join('') + '</div>'
            : '';

        const excerpt = (p.content || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const boardHtml = '<div class="card-board">' + boardPill(p.board) + '</div>';
        const kindClass = p.kind === 'poll' ? 'card-kind-poll ' : (p.kind === 'note' ? 'card-kind-note ' : (p.kind === 'music' ? 'card-kind-music ' : ''));
        const musicHtml = p.kind === 'music' ? ('<div class="music-card-preview"><svg class="icon" aria-hidden="true"><use href="#i-music"></use></svg>' +
            escapeHtml(p.music_artist || '') + '</div>') : '';
        const pollHtml = (p.kind === 'poll' && p.poll) ? ('<div class="poll-preview">' +
            p.poll.options.map(function (o) {
                return '<div class="poll-preview-row"><span class="poll-preview-label">' + escapeHtml(o.text) +
                    '</span><span class="poll-preview-bar"><i style="width:' +
                    Math.max(0, Math.min(100, o.percent || 0)) + '%"></i></span><span class="poll-preview-count">' +
                    (o.count || 0) + '</span></div>';
            }).join('') + '</div>') : '';
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
            card.className = 'post-card ' + kindClass + (isRead ? 'is-read' : 'is-unread');
            card.innerHTML =
                '<div class="card-cover">' +
                    '<img src="' + escapeHtml(cover) + '" alt="" decoding="async">' +
                '</div>' +
                '<div class="card-body">' +
                    boardHtml +
                    '<h3 class="card-title">' + escapeHtml(p.title || T('untitled')) + '</h3>' +
                    tagsHtml + musicHtml + pollHtml +
                    metaHtml +
                '</div>';
        } else {
            card.className = 'post-card no-cover ' + kindClass + (isRead ? 'is-read' : 'is-unread');
            card.innerHTML =
                '<div class="card-body">' +
                    boardHtml +
                    '<h3 class="card-title">' + escapeHtml(p.title || T('untitled')) + '</h3>' +
                    tagsHtml +
                    (excerpt ? '<p class="card-excerpt">' + escapeHtml(excerpt) + '</p>' : '') +
                    musicHtml + pollHtml +
                    metaHtml +
                '</div>';
        }
        if (postImages.length > 1) {
            const countBadge = document.createElement('span');
            countBadge.className = 'card-image-count';
            countBadge.textContent = postImages.length;
            const coverBox = card.querySelector('.card-cover');
            if (coverBox) coverBox.appendChild(countBadge);
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
            if (e.target.closest('.card-author') || e.target.closest('.card-tag-chip')) return;
            openDetail(p.id);
        });
        card.addEventListener('keydown', function (e) {
            if (e.target !== card) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                openDetail(p.id);
            }
        });
        card.querySelectorAll('.card-tag-chip').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                applyTagFilter(this.getAttribute('data-tag'));
            });
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
function bindBoards() {
    const bar = document.getElementById('boardBar');
    if (!bar) return;
    bar.querySelectorAll('.board-chip').forEach(function (btn) {
        btn.addEventListener('click', function () {
            currentBoard = this.getAttribute('data-board') || 'all';
            bar.querySelectorAll('.board-chip').forEach(function (b) {
                b.classList.toggle('active', b === btn);
            });
            render();
            window.scrollTo({ top: 0, behavior: 'smooth' });
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
        updateUnreadBadge(document.getElementById('bellDot'), 0);
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
        const postId = Number(n.post_id) || 0;
        return '<div class="notif-item' + (postId ? ' clickable' : '') + '"' +
               (postId ? ' data-post-id="' + postId + '" role="button" tabindex="0"' : '') +
               (n.is_read ? ' style="opacity:0.55;"' : '') + '>' +
               '<div class="notif-title">' + escapeHtml(n.title) + '</div>' +
               '<div class="notif-text">' + escapeHtml(n.text) + '</div>' +
               '<div class="notif-time">' + escapeHtml(formatTime(n)) + '</div>' +
               (postId ? '<span class="notif-go">›</span>' : '') + '</div>';
    }).join('');
    list.querySelectorAll('.notif-item[data-post-id]').forEach(function (el) {
        const go = function () {
            const pid = Number(el.getAttribute('data-post-id'));
            if (!pid) return;
            document.getElementById('notifModal').hidden = true;
            openDetail(pid);
        };
        el.addEventListener('click', go);
        el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });
    });
}
function updateUnreadBadge(dot, count) {
    if (!dot) return;
    count = Math.max(0, Number(count) || 0);
    if (!count) {
        dot.hidden = true;
        dot.textContent = '';
        return;
    }
    dot.textContent = count > 99 ? '99+' : String(count);
    dot.hidden = false;
}

async function refreshBellDot() {
    const dot = document.getElementById('bellDot');
    if (!Auth.isLoggedIn()) {
        updateUnreadBadge(dot, 0);
        return;
    }
    try {
        const res = await Auth.get('/api/notifs');
        if (!res.ok) { updateUnreadBadge(dot, 0); return; }
        const data = await res.json();
        updateUnreadBadge(dot, data.unread || 0);
    } catch (e) {
        updateUnreadBadge(dot, 0);
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
            const val = normalizeTag(this.value);
            if (val && selectedTags.indexOf(val) === -1) {
                selectedTags.push(val);
                this.value = '';
                renderTagPicker();
            }
        }
    });

    document.getElementById('submitPostBtn').addEventListener('click', submitPost);
    document.querySelectorAll('[data-publish-board]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            choosePublishBoard(this.getAttribute('data-publish-board'));
        });
    });
    document.getElementById('publishBack').addEventListener('click', function () {
        document.getElementById('publishForm').hidden = true;
        document.getElementById('publishChooser').hidden = false;
    });
    document.getElementById('pollAddOption').addEventListener('click', function () {
        addPollOption('');
    });
    document.querySelectorAll('[data-md]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            insertMarkdown(this.getAttribute('data-md'));
        });
    });
    document.getElementById('mdPreviewBtn').addEventListener('click', toggleMarkdownPreview);
    document.getElementById('postContent').addEventListener('input', scheduleMarkdownPreview);
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
    document.getElementById('musicArtist').value = '';
    document.getElementById('musicUrl').value = '';
    document.getElementById('postImage').value = '';
    mdPreviewActive = false;
    document.getElementById('mdPreview').hidden = true;
    document.getElementById('postContent').hidden = false;
    document.getElementById('mdPreviewBtn').textContent = T('mdPreview');
    document.getElementById('newTagInput').value = '';
    selectedTags = [];
    imageTaskId++;
    imageProcessing = false;
    uploadedImages = [];
    renderImagePreviews();
    setUploadHint('');
    document.getElementById('uploadPlaceholder').style.display = '';
    renderTagPicker();
    publishBoard = 'general';
    document.getElementById('publishChooser').hidden = false;
    document.getElementById('publishForm').hidden = true;
    document.getElementById('postModal').hidden = false;
    document.body.style.overflow = 'hidden';
}

function closePostModal() {
    document.getElementById('postModal').hidden = true;
    document.body.style.overflow = '';
}

function addPollOption(value) {
    const box = document.getElementById('pollOptions');
    const rows = box.querySelectorAll('.poll-option-row');
    if (rows.length >= 6) { alert(T('pollMaxOptions')); return; }
    const row = document.createElement('div');
    row.className = 'poll-option-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.value = value || '';
    input.placeholder = T('pollOptionPlaceholder', { n: rows.length + 1 });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'poll-option-remove';
    remove.textContent = '×';
    remove.addEventListener('click', function () {
        if (box.querySelectorAll('.poll-option-row').length <= 2) return;
        row.remove();
        syncPollOptions();
    });
    row.appendChild(input);
    row.appendChild(remove);
    box.appendChild(row);
    syncPollOptions();
}

function syncPollOptions() {
    const box = document.getElementById('pollOptions');
    const rows = box.querySelectorAll('.poll-option-row');
    rows.forEach(function (row, i) {
        const input = row.querySelector('input');
        if (input) input.placeholder = T('pollOptionPlaceholder', { n: i + 1 });
        const remove = row.querySelector('.poll-option-remove');
        if (remove) remove.disabled = rows.length <= 2;
    });
    document.getElementById('pollAddOption').disabled = rows.length >= 6;
}

function choosePublishBoard(board) {
    publishBoard = board || 'general';
    document.getElementById('publishChooser').hidden = true;
    document.getElementById('publishForm').hidden = false;
    document.getElementById('publishBoardLabel').textContent = boardLabel(publishBoard);
    const isPoll = publishBoard === 'poll';
    const isNote = publishBoard === 'study' || publishBoard === 'share';
    const isMusic = publishBoard === 'music';

    mdPreviewActive = false;
    clearTimeout(mdPreviewTimer);
    document.getElementById('mdPreview').hidden = true;
    document.getElementById('postContent').hidden = false;
    document.getElementById('mdPreviewBtn').textContent = T('mdPreview');
    document.getElementById('mdToolbar').hidden = !isNote;
    document.getElementById('mdPreviewBtn').hidden = !isNote;
    document.getElementById('mdHint').hidden = !isNote;
    document.getElementById('musicFields').hidden = !isMusic;
    document.getElementById('postContent').rows = isNote ? 9 : 5;

    let titleKey = 'postTitleLabel';
    let contentKey = 'postContentLabel';
    let titlePh = 'postTitlePlaceholder';
    let contentPh = 'postContentPlaceholder';
    if (isPoll) {
        titleKey = 'pollQuestionLabel'; contentKey = 'pollDescriptionLabel';
        titlePh = 'pollQuestionPlaceholder'; contentPh = 'pollDescriptionPlaceholder';
    } else if (isMusic) {
        titleKey = 'musicTitleLabel'; contentKey = 'musicContentLabel';
        titlePh = 'postTitlePlaceholder'; contentPh = 'musicContentPlaceholder';
    } else if (isNote) {
        titleKey = 'noteTitleLabel'; contentKey = 'noteContentLabel';
        titlePh = 'postTitlePlaceholder'; contentPh = 'noteContentPlaceholder';
    }
    document.getElementById('postTitleLabel').textContent = T(titleKey);
    document.getElementById('postTitle').placeholder = T(titlePh);
    document.getElementById('postContentLabel').textContent = T(contentKey);
    document.getElementById('postContent').placeholder = T(contentPh);

    document.getElementById('pollFields').hidden = !isPoll;
    document.getElementById('imageGroup').hidden = isPoll;
    document.getElementById('tagGroup').hidden = isPoll;
    const note = document.getElementById('publishBoardNote');
    let noteText = '';
    if (isNote) noteText = T('publishMarkdownHint');
    else if (isMusic) noteText = T('musicHint');
    note.textContent = noteText;
    note.hidden = !noteText;
    document.getElementById('submitPostBtn').textContent = T('postSubmit');
    if (isPoll) {
        const box = document.getElementById('pollOptions');
        box.innerHTML = '';
        addPollOption('');
        addPollOption('');
    }
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
    // 不展示历史标签/别人用过的标签，只展示本次发布已经添加的标签。
    if (!selectedTags.length) {
        picker.innerHTML = '<span style="color:var(--text-dim);font-size:13px;">' + T('postNoTags') + '</span>';
        return;
    }
    picker.innerHTML = selectedTags.map(function (name) {
        return '<span class="tag-option selected" data-tag="' + escapeHtml(name) + '">#' + escapeHtml(name) + '</span>';
    }).join('');
    picker.querySelectorAll('.tag-option').forEach(function (el) {
        el.addEventListener('click', function () {
            const name = el.getAttribute('data-tag');
            const idx = selectedTags.indexOf(name);
            if (idx !== -1) selectedTags.splice(idx, 1);
            renderTagPicker();
        });
    });
}

function setMarkdownEditing() {
    mdPreviewActive = false;
    document.getElementById('mdPreview').hidden = true;
    document.getElementById('postContent').hidden = false;
    document.getElementById('mdPreviewBtn').textContent = T('mdPreview');
}

function insertMarkdown(action) {
    const ta = document.getElementById('postContent');
    if (!ta) return;
    setMarkdownEditing();
    const start = ta.selectionStart || 0;
    const end = ta.selectionEnd || 0;
    const selected = ta.value.slice(start, end);
    let insert = '';
    let cursorStart = 0;
    let cursorEnd = 0;
    if (action === 'bold') {
        insert = '**' + (selected || '加粗文字') + '**';
        cursorStart = 2; cursorEnd = insert.length - 2;
    } else if (action === 'italic') {
        insert = '*' + (selected || '斜体文字') + '*';
        cursorStart = 1; cursorEnd = insert.length - 1;
    } else if (action === 'heading') {
        insert = '## ' + (selected || '小标题');
    } else if (action === 'list') {
        insert = '- ' + (selected || '列表项');
    } else if (action === 'quote') {
        insert = '> ' + (selected || '引用');
    } else if (action === 'code') {
        insert = '\n```\n' + (selected || '// code') + '\n```\n';
        cursorStart = 5; cursorEnd = insert.length - 5;
    } else if (action === 'link') {
        const url = prompt('链接地址（https://...）');
        if (!url) return;
        insert = '[' + (selected || '链接文字') + '](' + url.trim() + ')';
    } else if (action === 'image') {
        const url = prompt('图片地址（https://...）');
        if (!url) return;
        insert = '![' + (selected || '图片') + '](' + url.trim() + ')';
    } else {
        return;
    }
    ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
    const pos = start + (cursorStart || insert.length);
    ta.focus();
    ta.setSelectionRange(pos, start + (cursorEnd || insert.length));
    scheduleMarkdownPreview();
}

function toggleMarkdownPreview() {
    if (mdPreviewActive) {
        setMarkdownEditing();
        return;
    }
    mdPreviewActive = true;
    document.getElementById('postContent').hidden = true;
    document.getElementById('mdPreview').hidden = false;
    document.getElementById('mdPreviewBtn').textContent = T('mdEdit');
    updateMarkdownPreview();
}

function scheduleMarkdownPreview() {
    if (!mdPreviewActive) return;
    clearTimeout(mdPreviewTimer);
    mdPreviewTimer = setTimeout(updateMarkdownPreview, 220);
}

async function updateMarkdownPreview() {
    if (!mdPreviewActive) return;
    const content = document.getElementById('postContent').value;
    const box = document.getElementById('mdPreview');
    if (!content.trim()) {
        box.innerHTML = '<div class="md-preview-empty">' + T('mdPreviewEmpty') + '</div>';
        return;
    }
    const requestId = ++mdPreviewRequest;
    try {
        const res = await Auth.post('/api/markdown/preview', { content: content });
        if (requestId !== mdPreviewRequest) return;
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (requestId !== mdPreviewRequest || !mdPreviewActive) return;
        box.innerHTML = data.html || '';
        attachCodeCopy(box);
    } catch (e) {
        if (requestId === mdPreviewRequest) {
            box.innerHTML = '<div class="md-preview-empty">' + T('previewFailed') + '</div>';
        }
    }
}

function attachCodeCopy(container) {
    if (!container) return;
    container.querySelectorAll('pre').forEach(function (pre) {
        if (pre.querySelector('.code-copy')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'code-copy';
        btn.textContent = T('codeCopy');
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const code = pre.querySelector('code');
            copyToClipboard((code || pre).textContent || '');
            btn.textContent = T('codeCopied');
            setTimeout(function () { btn.textContent = T('codeCopy'); }, 1200);
        });
        pre.appendChild(btn);
    });
}

function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () {});
        return;
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
}

async function submitPost() {
    const title = document.getElementById('postTitle').value.trim();
    const content = document.getElementById('postContent').value.trim();
    const isPoll = publishBoard === 'poll';
    const isNote = publishBoard === 'study' || publishBoard === 'share';
    const isMusic = publishBoard === 'music';
    if (!title) { alert(T('enterTitle')); return; }
    if (isNote && !content) { alert(T('enterContent')); return; }
    if (!isPoll && !isNote && !isMusic && !content) { alert(T('enterContent')); return; }
    if (!isPoll && imageProcessing) { alert(T('uploadPending')); return; }
    if (isMusic) {
        if (!document.getElementById('musicArtist').value.trim()) { alert(T('musicArtistRequired')); return; }
        const musicUrl = document.getElementById('musicUrl').value.trim();
        if (!/^https?:\/\//i.test(musicUrl)) { alert(T('musicLinkFailed')); return; }
    }

    let pollOptions = [];
    if (isPoll) {
        document.querySelectorAll('#pollOptions .poll-option-row input').forEach(function (input) {
            const val = input.value.trim();
            if (val && pollOptions.indexOf(val) === -1) pollOptions.push(val);
        });
        if (pollOptions.length < 2) { alert(T('pollMinOptions')); return; }
        if (pollOptions.length > 6) { alert(T('pollMaxOptions')); return; }
    }

    const btn = document.getElementById('submitPostBtn');
    btn.disabled = true;
    btn.textContent = T('postPublishing');

    try {
        const body = {
            title: title,
            content: content,
            board: publishBoard,
            kind: isPoll ? 'poll' : (isNote ? 'note' : (isMusic ? 'music' : 'post')),
            tags: isPoll ? '' : selectedTags.join(','),
            images: isPoll ? [] : uploadedImages,
            music_artist: isMusic ? document.getElementById('musicArtist').value.trim() : '',
            music_url: isMusic ? document.getElementById('musicUrl').value.trim() : ''
        };
        if (isPoll) body.poll_options = pollOptions;
        const res = await Auth.post(API, body);
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || T('publishFailed', { error: '' }));
        }
        closePostModal();
        currentTab = 'latest';
        currentBoard = publishBoard;
        document.querySelectorAll('.tab').forEach(function (t) {
            t.classList.toggle('active', t.getAttribute('data-tab') === 'latest');
        });
        document.querySelectorAll('.board-chip').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-board') === currentBoard);
        });
        await fetchConfig();
        await fetchPosts();
    } catch (e) {
        alert(T('publishFailed', { error: e.message }));
    } finally {
        btn.disabled = false;
        btn.textContent = T('postSubmit');
    }
}

function showTripleToast(message, isError) {
    const el = document.getElementById('tripleToast');
    if (!el) return;
    el.textContent = message;
    el.className = 'triple-toast' + (isError ? ' error' : ' success');
    el.hidden = false;
    clearTimeout(tripleToastTimer);
    tripleToastTimer = setTimeout(function () { el.hidden = true; }, 2800);
}

function cancelTriplePress() {
    if (triplePressState && triplePressState.cancel) triplePressState.cancel();
}

function bindTripleLike() {
    const btn = document.getElementById('footerLike');
    const ring = document.getElementById('likeRing');
    if (!btn || !ring) return;
    const circle = ring.querySelector('circle');
    const DURATION = 800;
    const CIRC = 106.81;
    let holding = false;
    let raf = null;
    let holdTimer = null;
    let startTime = 0;
    let startX = 0;
    let startY = 0;

    function reset() {
        holding = false;
        if (raf) { cancelAnimationFrame(raf); raf = null; }
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        ring.classList.remove('active');
        if (circle) circle.style.strokeDashoffset = String(CIRC);
    }

    function cancel() {
        reset();
    }

    triplePressState = { cancel: cancel };

    function loop(now) {
        if (!holding) return;
        const progress = Math.min(1, (now - startTime) / DURATION);
        if (circle) circle.style.strokeDashoffset = String(CIRC * (1 - progress));
        if (progress >= 1) {
            holding = false;
            raf = null;
            tripleSuppressClickUntil = Date.now() + 1100;
            ring.classList.remove('active');
            setTimeout(reset, 320);
            performTriple();
            return;
        }
        raf = requestAnimationFrame(loop);
    }

    function beginRing() {
        if (!holding) return;
        holdTimer = null;
        startTime = performance.now();
        if (circle) circle.style.strokeDashoffset = String(CIRC);
        ring.classList.add('active');
        raf = requestAnimationFrame(loop);
    }

    function start(e) {
        if (!currentPost || !Auth.isLoggedIn()) return;
        if (e.button !== undefined && e.button !== 0) return;
        if (holding) return;
        holding = true;
        startX = e.clientX || 0;
        startY = e.clientY || 0;
        // 点按不出现圆环；按住约 0.2 秒后才开始画圈
        holdTimer = setTimeout(beginRing, 200);
    }

    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', function () { if (holding) cancel(); });
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('pointerleave', function () { if (holding) cancel(); });
    btn.addEventListener('pointermove', function (e) {
        if (!holding) return;
        const dx = (e.clientX || 0) - startX;
        const dy = (e.clientY || 0) - startY;
        if (Math.sqrt(dx * dx + dy * dy) > 18) cancel();
    });
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
}

async function performTriple() {
    if (!currentPost || !Auth.isLoggedIn()) return;
    const post = currentPost;
    const own = !!(Auth.user && post.author === Auth.user.username);
    const needLike = !post.liked;
    const needBookmark = !post.bookmarked;
    const needCoin = !own && !post.coined;
    const jobs = [];
    if (needLike) {
        jobs.push(Auth.post(API + '/' + post.id + '/like', { on: true }).then(async function (res) {
            if (!res.ok) {
                const err = await res.json().catch(function () { return {}; });
                throw new Error(err.error || T('likeFailed'));
            }
            const data = await res.json();
            post.likes = data.likes;
            post.liked = (typeof data.liked === 'boolean') ? data.liked : true;
            const inList = allPosts.find(function (x) { return x.id === post.id; });
            if (inList) { inList.likes = post.likes; inList.liked = post.liked; }
            const liked = getLiked();
            if (liked.indexOf(post.id) === -1) liked.push(post.id);
            localStorage.setItem(K_LIKED, JSON.stringify(liked));
        }));
    }
    if (needBookmark) {
        jobs.push(Auth.post(API + '/' + post.id + '/bookmark', { on: true }).then(async function (res) {
            if (!res.ok) {
                const err = await res.json().catch(function () { return {}; });
                throw new Error(err.error || T('bookmarkFailed'));
            }
            const data = await res.json();
            const wasBookmarked = !!post.bookmarked;
            post.bookmarked = !!data.bookmarked;
            if (post.bookmarked !== wasBookmarked) {
                post.bookmark_count = Math.max(0, (Number(post.bookmark_count) || 0) + (post.bookmarked ? 1 : -1));
            }
            const inList = allPosts.find(function (x) { return x.id === post.id; });
            if (inList) {
                inList.bookmarked = post.bookmarked;
                inList.bookmark_count = post.bookmark_count;
            }
        }));
    }
    if (needCoin) {
        const balance = (Auth.user && typeof Auth.user.coins === 'number') ? Auth.user.coins : 2;
        const preferred = balance >= 2 ? 2 : 1;
        async function giveCoin(amount) {
            const res = await Auth.post(API + '/' + post.id + '/coin', { on: true, amount: amount });
            if (!res.ok) {
                const err = await res.json().catch(function () { return {}; });
                const error = new Error(err.error || T('coinFailed'));
                error.amount = amount;
                throw error;
            }
            const data = await res.json();
            post.coins = data.coins;
            post.coined = true;
            post.coin_amount = data.amount;
            if (Auth.user && typeof data.balance === 'number') {
                Auth.user.coins = data.balance;
                Auth.save(Auth.token, Auth.user);
            }
            updateCoinBalance();
            const inList = allPosts.find(function (x) { return x.id === post.id; });
            if (inList) { inList.coins = post.coins; inList.coined = true; }
        }
        jobs.push((async function () {
            try {
                await giveCoin(preferred);
            } catch (e) {
                // 余额刚好不足 2 币时自动降为 1 币
                if (preferred === 2 && e.amount === 2 && /硬币不足|not enough/i.test(e.message)) {
                    await giveCoin(1);
                } else {
                    throw e;
                }
            }
        })());
    }
    if (!jobs.length) {
        showTripleToast(T('tripleAlready'));
        return;
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.filter(function (r) { return r.status === 'rejected'; });
    updateFooterButtons();
    if (failed.length) {
        showTripleToast(failed[0].reason && failed[0].reason.message ? failed[0].reason.message : T('triplePartial'), true);
    } else {
        showTripleToast(own ? T('tripleOwnDone') : T('tripleDone'));
    }
}

// ---------- 详情弹窗 ----------
function bindDetailModal() {
    document.getElementById('detailClose').addEventListener('click', closeDetail);
    document.querySelector('.detail-author').addEventListener('click', function () {
        if (currentPost && currentPost.author) {
            const author = currentPost.author;
            closeDetail();
            openProfile(author);
        }
    });
    document.getElementById('detailImg').addEventListener('click', function (e) {
        if (e.target.tagName === 'IMG') openImageViewer(detailImages, detailImageIndex);
    });
    document.getElementById('detailGalleryPrev').addEventListener('click', function () {
        if (detailImages.length <= 1) return;
        detailImageIndex = (detailImageIndex - 1 + detailImages.length) % detailImages.length;
        renderDetailImages();
    });
    document.getElementById('detailGalleryNext').addEventListener('click', function () {
        if (detailImages.length <= 1) return;
        detailImageIndex = (detailImageIndex + 1) % detailImages.length;
        renderDetailImages();
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
        if (Date.now() < tripleSuppressClickUntil) return;
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
            bounceFooterIcon('footerLike');
        } catch (e) {
            alert(T('likeFailed') + ' ' + e.message);
        } finally {
            btn.disabled = false;
        }
    });
    bindTripleLike();

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
    document.getElementById('footerStar').addEventListener('click', async function () {
        if (!currentPost) return;
        if (!Auth.isLoggedIn()) {
            alert(T('bookmarkLogin'));
            window.location.href = 'login.html';
            return;
        }
        const btn = this;
        if (btn.disabled) return;
        btn.disabled = true;
        try {
            const on = !currentPost.bookmarked;
            const res = await Auth.post('/api/posts/' + currentPost.id + '/bookmark', { on: on });
            if (!res.ok) {
                const err = await res.json().catch(function () { return {}; });
                throw new Error(err.error || T('bookmarkFailed'));
            }
            const data = await res.json();
            const wasBookmarked = !!currentPost.bookmarked;
            currentPost.bookmarked = !!data.bookmarked;
            if (currentPost.bookmarked !== wasBookmarked) {
                currentPost.bookmark_count = Math.max(0, (Number(currentPost.bookmark_count) || 0) + (currentPost.bookmarked ? 1 : -1));
            }
            const inList = allPosts.find(function (x) { return x.id === currentPost.id; });
            if (inList) {
                inList.bookmarked = currentPost.bookmarked;
                inList.bookmark_count = currentPost.bookmark_count;
            }
            updateFooterButtons();
            bounceFooterIcon('footerStar');
        } catch (e) {
            alert(T('bookmarkFailed') + ' ' + e.message);
        } finally {
            btn.disabled = false;
        }
    });
    document.getElementById('replyCancel').addEventListener('click', resetReplyTarget);
    const commentInput = document.getElementById('commentInput');
    commentInput.addEventListener('input', scheduleMentionSearch);
    commentInput.addEventListener('blur', function () {
        setTimeout(hideMentionBox, 150);
    });
    commentInput.addEventListener('keydown', function (e) {
        if (handleMentionKeydown(e)) return;
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
    const balance = (Auth.user && typeof Auth.user.coins === 'number') ? Auth.user.coins : 0;
    if (balance < 1) {
        alert(T('coinNotEnough'));
        return;
    }
    document.querySelectorAll('.coin-option').forEach(function (b) {
        b.disabled = Number(b.getAttribute('data-amount')) > balance;
    });
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
        if (typeof data.balance === 'number' && Auth.user) {
            Auth.user.coins = data.balance;
            Auth.save(Auth.token, Auth.user);
            updateCoinBalance();
        }
        const coined = getCoined();
        if (coined.indexOf(currentPost.id) === -1) coined.push(currentPost.id);
        localStorage.setItem(K_COINED, JSON.stringify(coined));
        closeCoinModal();
        updateFooterButtons();
        bounceFooterIcon('footerCoin');
    } catch (e) {
        options.forEach(function (b) { b.disabled = false; });
        alert(T('coinFailed') + ' ' + e.message);
    }
}

function startScrollRestore(y) {
    scrollRestoreTarget = Math.max(0, Number(y) || 0);
    scrollRestoreDeadline = performance.now() + 5000;
    tryRestoreScrollAfterClose();
    requestAnimationFrame(tryRestoreScrollAfterClose);
    setTimeout(tryRestoreScrollAfterClose, 80);
    setTimeout(tryRestoreScrollAfterClose, 260);
    setTimeout(tryRestoreScrollAfterClose, 700);
    setTimeout(tryRestoreScrollAfterClose, 1500);
    setTimeout(tryRestoreScrollAfterClose, 3000);
}

function tryRestoreScrollAfterClose() {
    if (scrollRestoreTarget === null) return;
    if (performance.now() > scrollRestoreDeadline) {
        scrollRestoreTarget = null;
        return;
    }
    const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const target = Math.min(scrollRestoreTarget, maxY);
    window.scrollTo(0, target);
    if (maxY >= scrollRestoreTarget && Math.abs(window.scrollY - scrollRestoreTarget) <= 2) {
        scrollRestoreTarget = null;
    }
}

async function openDetail(postId) {
    const profileOpen = document.getElementById('profilePage') && !document.getElementById('profilePage').hidden;
    if (!profileOpen) detailReturnScrollY = window.scrollY;
    try {
        const res = await Auth.get(API + '/' + postId);
        currentPost = await res.json();
        const inList = allPosts.find(function (x) { return x.id === currentPost.id; });
        if (inList) Object.assign(inList, currentPost);
        markRead(postId);
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
    const returnScrollY = detailReturnScrollY;
    detailReturnScrollY = null;
    cancelTriplePress();
    hideMentionBox();
    closeImageViewer();
    closeDetailMoreMenu();
    closeCoinModal();
    resetReplyTarget();
    expandedReplyThreads = {};
    document.getElementById('detailModal').hidden = true;
    const profilePage = document.getElementById('profilePage');
    if (!profilePage || profilePage.hidden) document.body.style.overflow = '';
    currentPost = null;
    allComments = [];
    render();
    if (profilePage && !profilePage.hidden) {
        if (currentProfileTab === 'likes' || currentProfileTab === 'bookmarks') {
            profileSavedCache[currentProfileTab] = null;
            selectProfileTab(currentProfileTab);
        }
    } else if (returnScrollY !== null) {
        startScrollRestore(returnScrollY);
    }
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
    const detailAvatar = document.getElementById('detailAvatar');
    if (detailAvatar) detailAvatar.innerHTML = avatarMarkup(p.author_avatar, p.author, 'avatar-inner');
    document.getElementById('detailLikes').textContent = '♥ ' + (p.likes || 0);
    document.getElementById('detailTitle').textContent = p.title || T('untitled');
    const detailBoard = document.getElementById('detailBoard');
    if (detailBoard) {
        detailBoard.innerHTML = boardPill(p.board);
        detailBoard.hidden = false;
    }
    renderPoll(p);
    const detailTags = document.getElementById('detailTags');
    const tags = getPostTags(p);
    if (detailTags) {
        detailTags.innerHTML = tags.map(function (t) {
            return '<button type="button" class="detail-tag" data-tag="' + escapeHtml(t) + '">#' + escapeHtml(t) + '</button>';
        }).join('');
        detailTags.hidden = !tags.length;
        detailTags.querySelectorAll('.detail-tag').forEach(function (btn) {
            btn.addEventListener('click', function () {
                applyTagFilter(this.getAttribute('data-tag'));
            });
        });
    }
    const contentBox = document.getElementById('detailContent');
    contentBox.innerHTML = (p.format === 'markdown' && p.content_html)
        ? p.content_html
        : linkify(p.content || '');
    attachCodeCopy(contentBox);
    renderMusic(p);
    document.getElementById('detailTime').textContent = formatTime(p);
    document.getElementById('commentCount').textContent = allComments.length;
    // 登录后显示用户名
    document.getElementById('commentAuthor').value = Auth.isLoggedIn() ? Auth.user.username : '';
    closeDetailMoreMenu();
    renderComments();
    // 打开详情时直接显示当前数量，不播放跨帖子滚动动画
    const likeCountEl = document.getElementById('footerLikeCount');
    const coinCountEl = document.getElementById('footerCoinCount');
    const starCountEl = document.getElementById('footerStarCount');
    if (likeCountEl) { likeCountEl.textContent = String(p.likes || 0); likeCountEl.dataset.count = String(p.likes || 0); }
    if (coinCountEl) { coinCountEl.textContent = String(p.coins || 0); coinCountEl.dataset.count = String(p.coins || 0); }
    if (starCountEl) { starCountEl.textContent = p.bookmarked ? '1' : '0'; starCountEl.dataset.count = p.bookmarked ? '1' : '0'; }
    updateFooterButtons();
}

function renderMusic(p) {
    const box = document.getElementById('detailMusic');
    if (!box) return;
    if (!p || p.kind !== 'music' || !p.music_url) {
        box.hidden = true;
        box.innerHTML = '';
        return;
    }
    box.hidden = false;
    box.innerHTML =
        '<span class="music-icon"><svg class="icon" aria-hidden="true"><use href="#i-music"></use></svg></span>' +
        '<div class="music-info"><div class="music-title">' + escapeHtml(p.title || '') + '</div>' +
            '<div class="music-artist">' + escapeHtml(p.music_artist || '') + '</div>' +
            '<a class="music-link" href="' + escapeHtml(p.music_url) + '" target="_blank" rel="noopener noreferrer">' +
                T('musicOpenLink') + ' ↗</a></div>';
}

function renderPoll(p) {
    const box = document.getElementById('detailPoll');
    if (!box) return;
    if (!p || p.kind !== 'poll' || !p.poll) {
        box.hidden = true;
        box.innerHTML = '';
        return;
    }
    const poll = p.poll;
    const voted = !!poll.my_option_id;
    box.hidden = false;
    box.innerHTML = poll.options.map(function (o) {
        const pct = Math.max(0, Math.min(100, o.percent || 0));
        return '<button type="button" class="poll-option' + (poll.my_option_id === o.id ? ' voted' : '') +
            '" data-poll-option="' + o.id + '"' + (voted || poll.closed ? ' disabled' : '') + '>' +
            '<span class="poll-bar" style="width:' + pct + '%"></span>' +
            '<span class="poll-label">' + escapeHtml(o.text) + '</span>' +
            '<span class="poll-count">' + (o.count || 0) + ' · ' + pct + '%</span>' +
        '</button>';
    }).join('') +
    '<div class="poll-meta">' + T('pollTotalVotes', { n: poll.total || 0 }) +
        (poll.closed ? ' · ' + T('pollClosed') : '') +
        (voted ? ' · <span class="poll-voted-note">' + T('pollVoted') + '</span>' : '') + '</div>';
    box.querySelectorAll('[data-poll-option]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            votePoll(Number(this.getAttribute('data-poll-option')));
        });
    });
}

async function votePoll(optionId) {
    if (!currentPost || !currentPost.poll || !optionId) return;
    if (!Auth.isLoggedIn()) {
        alert(T('pollVoteLogin'));
        window.location.href = 'login.html';
        return;
    }
    const box = document.getElementById('detailPoll');
    if (box) box.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
        const res = await Auth.post('/api/posts/' + currentPost.id + '/vote', { option_id: optionId });
        if (!res.ok) {
            const err = await res.json().catch(function () { return {}; });
            throw new Error(err.error || T('pollVoteFailed'));
        }
        const data = await res.json();
        currentPost.poll = data.poll;
        const listItem = allPosts.filter(function (p) { return p.id === currentPost.id; })[0];
        if (listItem) listItem.poll = data.poll;
        renderPoll(currentPost);
    } catch (e) {
        alert(T('pollVoteFailed') + ' ' + e.message);
        renderPoll(currentPost);
    }
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
            avatarMarkup(c.author_avatar, c.author, 'comment-avatar' + (isReply ? ' small' : '')) +
            '<span class="comment-name">' + escapeHtml(c.author) + '</span>' +
            (isAuthor ? '<span class="comment-author-tag">' + T('op') + '</span>' : '') +
            (isReply && c.reply_to ? '<span class="comment-reply-to">' + escapeHtml(T('replyTo', { name: c.reply_to })) + '</span>' : '') +
            (!isReply ? '<span class="comment-floor">' + (opts.floor || 0) + 'F</span>' : '') +
            (canDel ? '<button class="comment-del" data-cid="' + c.id + '" title="' + T('delete') + '">' + T('deleteShort') + '</button>' : '') +
        '</div>' +
        '<div class="comment-text">' + linkify(c.content) + '</div>' +
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

function mentionToken() {
    const input = document.getElementById('commentInput');
    if (!input) return null;
    const pos = input.selectionStart || 0;
    const before = input.value.slice(0, pos);
    const at = before.lastIndexOf('@');
    if (at === -1) return null;
    const query = before.slice(at + 1);
    if (query.length > 30 || /[\s@]/.test(query) || /[，。！？、,.!?;:：；]/.test(query)) return null;
    return { query: query, start: at };
}

function scheduleMentionSearch() {
    const token = mentionToken();
    if (!token) { hideMentionBox(); return; }
    clearTimeout(mentionTimer);
    mentionTimer = setTimeout(function () { loadMentionSuggestions(token.query); }, 140);
}

async function loadMentionSuggestions(query) {
    const requestId = ++mentionRequestId;
    try {
        const res = await Auth.get('/api/users/search?q=' + encodeURIComponent(query));
        if (!res.ok) return;
        const users = await res.json();
        if (requestId !== mentionRequestId) return;
        const current = mentionToken();
        if (!current || current.query !== query) return;
        renderMentionBox(Array.isArray(users) ? users : []);
    } catch (e) {
        hideMentionBox();
    }
}

function renderMentionBox(users) {
    const box = document.getElementById('mentionBox');
    if (!box) return;
    mentionItems = users;
    mentionActiveIndex = 0;
    if (!users.length) { hideMentionBox(); return; }
    box.innerHTML = users.map(function (u, i) {
        return '<button type="button" class="mention-item' + (i === 0 ? ' active' : '') + '" data-username="' + escapeHtml(u.username) + '">' +
            '<span class="mention-avatar">' +
                (u.avatar ? '<img src="' + escapeHtml(u.avatar) + '" alt="">'
                          : '<svg class="icon" aria-hidden="true"><use href="#i-user"></use></svg>') +
            '</span>' +
            '<span><span class="mention-name">' + escapeHtml(u.display_name || u.username) + '</span>' +
                '<span class="mention-handle">@' + escapeHtml(u.username) + '</span></span>' +
        '</button>';
    }).join('');
    box.hidden = false;
    box.querySelectorAll('.mention-item').forEach(function (btn) {
        btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
        btn.addEventListener('click', function () {
            insertMention(this.getAttribute('data-username'));
        });
    });
}

function hideMentionBox() {
    mentionRequestId++;
    const box = document.getElementById('mentionBox');
    if (box) { box.hidden = true; box.innerHTML = ''; }
    mentionItems = [];
    mentionActiveIndex = 0;
}

function setMentionActive(index) {
    if (!mentionItems.length) return;
    mentionActiveIndex = (index + mentionItems.length) % mentionItems.length;
    const box = document.getElementById('mentionBox');
    box.querySelectorAll('.mention-item').forEach(function (el, i) {
        el.classList.toggle('active', i === mentionActiveIndex);
        if (i === mentionActiveIndex) el.scrollIntoView({ block: 'nearest' });
    });
}

function insertMention(username) {
    if (!username) return;
    const input = document.getElementById('commentInput');
    const token = mentionToken();
    if (!input || !token) { hideMentionBox(); return; }
    const pos = input.selectionStart || 0;
    const after = input.value.slice(pos);
    const replacement = '@' + username + ' ';
    input.value = input.value.slice(0, token.start) + replacement + after;
    const newPos = token.start + replacement.length;
    input.focus();
    input.setSelectionRange(newPos, newPos);
    hideMentionBox();
}

function handleMentionKeydown(e) {
    const box = document.getElementById('mentionBox');
    if (!box || box.hidden || !mentionItems.length) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionActive(mentionActiveIndex + 1); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setMentionActive(mentionActiveIndex - 1); return true; }
    if (e.key === 'Escape') { e.preventDefault(); hideMentionBox(); return true; }
    if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        insertMention(mentionItems[mentionActiveIndex].username);
        return true;
    }
    return false;
}

async function submitComment() {
    if (commentSubmitting) return;
    if (!Auth.isLoggedIn()) {
        alert(T('loginToComment'));
        window.location.href = 'login.html';
        return;
    }
    const input = document.getElementById('commentInput');
    const text = input.value.trim();
    if (!text || !currentPost) return;
    hideMentionBox();
    commentSubmitting = true;
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
        const now = new Date();
        const stamp = now.toISOString().slice(0, 19).replace('T', ' ');
        currentPost.replies = (Number(currentPost.replies) || 0) + 1;
        currentPost.last_comment_at = stamp;
        const inList = allPosts.find(function (x) { return x.id === currentPost.id; });
        if (inList) {
            inList.replies = currentPost.replies;
            inList.last_comment_at = stamp;
        }
        const list = document.getElementById('commentsList');
        if (list) list.scrollTop = commentSort === 'latest' ? 0 : list.scrollHeight;
    } catch (e) {
        alert(T('commentFailed') + ' ' + e.message);
    } finally {
        commentSubmitting = false;
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
    const nav = document.getElementById('detailGalleryNav');
    const count = document.getElementById('detailGalleryCount');
    if (!detailImages.length) {
        box.innerHTML = '';
        if (thumbs) { thumbs.hidden = true; thumbs.innerHTML = ''; }
        if (nav) nav.hidden = true;
        return;
    }
    if (detailImageIndex >= detailImages.length) detailImageIndex = 0;
    box.innerHTML = '<img src="' + escapeHtml(detailImages[detailImageIndex]) + '" alt="' + T('imageAlt') + '" decoding="async">';
    if (nav && count) {
        nav.hidden = detailImages.length <= 1;
        count.textContent = (detailImageIndex + 1) + ' / ' + detailImages.length;
    }
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

let currentProfileData = null;
let currentProfileUsername = '';
let currentConnectionsType = 'following';
let currentConnectionsUsername = '';
let profileEditAvatar = '';
let profileEditBanner = '';
let profileEditSaving = false;
let currentProfileTab = 'works';
let profileSavedCache = { likes: null, bookmarks: null };
let connectionsRequestId = 0;

function bindProfileModal() {
    const page = document.getElementById('profilePage');
    if (!page) return;
    document.getElementById('profileBack').addEventListener('click', closeProfile);
    document.getElementById('profileLogoutBtn').addEventListener('click', doLogout);
    document.getElementById('profileLangBtn').addEventListener('click', function () {
        I18n.toggle();
        if (currentProfileData) renderProfile(currentProfileData);
    });
    document.getElementById('profileEditPen').addEventListener('click', openProfileEdit);
    document.getElementById('profileEditClose').addEventListener('click', closeProfileEdit);
    document.getElementById('profileEditCancel').addEventListener('click', closeProfileEdit);
    document.getElementById('profileEditSave').addEventListener('click', saveProfileEdit);
    document.getElementById('editAvatarFile').addEventListener('change', function () {
        const file = this.files && this.files[0];
        this.value = '';
        if (file) handleProfileImage('avatar', file);
    });
    document.getElementById('editBannerFile').addEventListener('change', function () {
        const file = this.files && this.files[0];
        this.value = '';
        if (file) handleProfileImage('banner', file);
    });
    document.getElementById('editAvatarClear').addEventListener('click', function () {
        profileEditAvatar = '';
        renderProfileEditMedia();
    });
    document.getElementById('editBannerClear').addEventListener('click', function () {
        profileEditBanner = '';
        renderProfileEditMedia();
    });
    document.getElementById('profileEditModal').addEventListener('click', function (e) {
        if (e.target === this) closeProfileEdit();
    });
    document.getElementById('connectionsClose').addEventListener('click', closeConnections);
    document.getElementById('connectionsModal').addEventListener('click', function (e) {
        if (e.target === this) closeConnections();
    });
    document.querySelectorAll('.connections-tab').forEach(function (btn) {
        btn.addEventListener('click', function () {
            currentConnectionsType = this.getAttribute('data-type');
            document.querySelectorAll('.connections-tab').forEach(function (b) {
                b.classList.toggle('active', b === btn);
            });
            loadConnections();
        });
    });
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        if (!document.getElementById('profileEditModal').hidden) { closeProfileEdit(); return; }
        if (!document.getElementById('connectionsModal').hidden) { closeConnections(); return; }
        if (!page.hidden && document.getElementById('detailModal').hidden) closeProfile();
    });
}

async function openProfile(username) {
    if (!username) return;
    const page = document.getElementById('profilePage');
    if (!page) return;
    currentProfileUsername = username;
    currentProfileTab = 'works';
    profileSavedCache = { likes: null, bookmarks: null };
    page.hidden = false;
    page.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    document.getElementById('profileName').textContent = T('profileLoading');
    document.getElementById('profileStats').innerHTML = '';
    document.getElementById('profileBio').textContent = '';
    document.getElementById('profileHeroActions').innerHTML = '';
    document.getElementById('profileWorks').innerHTML = '';
    document.getElementById('profileWorksCount').textContent = '0';
    document.getElementById('profileWorks').style.height = '';
    document.getElementById('profileWorks').classList.remove('masonry');
    document.getElementById('profileEditPen').hidden = true;
    document.getElementById('profileToolbar').hidden = true;
    document.getElementById('profileHeroBg').style.backgroundImage = '';
    try {
        const res = await Auth.get('/api/users/' + encodeURIComponent(username));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        currentProfileData = await res.json();
        renderProfile(currentProfileData);
        requestAnimationFrame(scheduleProfileMasonry);
    } catch (e) {
        document.getElementById('profileName').textContent = T('profileFailed');
        document.getElementById('profileBio').textContent = '';
    }
}

function closeProfile() {
    const page = document.getElementById('profilePage');
    if (!page || page.hidden) return;
    closeProfileEdit();
    closeConnections();
    page.hidden = true;
    document.body.style.overflow = '';
    currentProfileData = null;
    currentProfileUsername = '';
    document.title = T('pageTitle');
}

function formatCount(n) {
    n = Math.max(0, Number(n) || 0);
    if (n < 1000) return String(n);
    const v = Math.round(n / 100) / 10;
    return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + 'k';
}

function renderProfile(data) {
    const u = data.user || {};
    const posts = data.posts || [];
    const isMe = !!u.is_self || !!(Auth.user && u.username === Auth.user.username);
    const name = u.display_name || u.username || T('profileUnknown');
    if (u.username) currentProfileUsername = u.username;

    const avatar = document.getElementById('profileAvatar');
    avatar.innerHTML = u.avatar
        ? '<img src="' + escapeHtml(u.avatar) + '" alt="">'
        : '<svg class="icon" aria-hidden="true"><use href="#i-user"></use></svg>';
    const heroBg = document.getElementById('profileHeroBg');
    heroBg.style.backgroundImage = u.banner ? 'url(' + JSON.stringify(u.banner) + ')' : '';

    document.getElementById('profileName').textContent = name;
    document.getElementById('profileBio').textContent = u.bio || T('profileNoBio');
    document.getElementById('profileEditPen').hidden = !isMe;
    document.getElementById('profileToolbar').hidden = !isMe;
    document.getElementById('profileAdminLink').hidden = !(isMe && u.is_admin);
    document.getElementById('profileLangBtn').textContent = (I18n.lang === 'en' ? '中文' : 'English');
    document.getElementById('profileBack').title = T('profileBack');

    const stats = document.getElementById('profileStats');
    stats.innerHTML =
        '<div class="profile-stat"><b>' + formatCount(u.comments_count) + '</b><span>' + T('profileComments') + '</span></div>' +
        '<div class="profile-stat"><b>' + formatCount(u.likes_total) + '</b><span>' + T('profileLikes') + '</span></div>' +
        '<button type="button" class="profile-stat clickable" data-connections="following"><b>' + formatCount(u.following_count) + '</b><span>' + T('profileFollowing') + '</span></button>' +
        '<button type="button" class="profile-stat clickable" data-connections="followers"><b>' + formatCount(u.followers_count) + '</b><span>' + T('profileFollowers') + '</span></button>';
    stats.querySelectorAll('[data-connections]').forEach(function (btn) {
        btn.addEventListener('click', function () {
            openConnections(currentProfileUsername, this.getAttribute('data-connections'));
        });
    });

    const actions = document.getElementById('profileHeroActions');
    if (!isMe) {
        actions.innerHTML =
            '<button type="button" class="' + (u.is_following ? 'btn' : 'btn-post') + '" id="profileFollowBtn">' +
                (u.is_following ? T('profileFollowingBtn') : T('profileFollow')) +
            '</button>' +
            '<button type="button" class="btn" id="profileMsgBtn">' + T('profileMessage') + '</button>';
        const followBtn = document.getElementById('profileFollowBtn');
        if (followBtn) followBtn.addEventListener('click', toggleProfileFollow);
        const msgBtn = document.getElementById('profileMsgBtn');
        if (msgBtn) msgBtn.addEventListener('click', function () {
            if (!Auth.isLoggedIn()) {
                alert(T('loginToMessages'));
                window.location.href = 'login.html';
                return;
            }
            openMessageThread(u.username);
        });
    } else {
        actions.innerHTML = '';
    }

    document.getElementById('profileWorksCount').textContent = u.post_count || posts.length;
    setupProfileTabs(u, posts, isMe);
    document.title = name + ' - ' + T('appName');
}

function setupProfileTabs(u, posts, isMe) {
    const likesTab = document.getElementById('profileLikesTab');
    const bookmarksTab = document.getElementById('profileBookmarksTab');
    const likeVisible = isMe || !!u.likes_public;
    const bookmarkVisible = isMe || !!u.bookmarks_public;
    likesTab.hidden = !likeVisible;
    bookmarksTab.hidden = !bookmarkVisible;
    likesTab.classList.toggle('private', isMe && !u.likes_public);
    bookmarksTab.classList.toggle('private', isMe && !u.bookmarks_public);
    document.getElementById('profileLikesCount').textContent = u.liked_count == null ? '—' : u.liked_count;
    document.getElementById('profileBookmarksCount').textContent = u.bookmarked_count == null ? '—' : u.bookmarked_count;
    if (currentProfileTab === 'likes' && !likeVisible) currentProfileTab = 'works';
    if (currentProfileTab === 'bookmarks' && !bookmarkVisible) currentProfileTab = 'works';
    document.querySelectorAll('#profileTabs .profile-tab').forEach(function (btn) {
        btn.onclick = function () {
            const tab = this.getAttribute('data-ptab');
            if (tab === 'likes' && !likeVisible) return;
            if (tab === 'bookmarks' && !bookmarkVisible) return;
            selectProfileTab(tab);
        };
    });
    selectProfileTab(currentProfileTab);
}

function profileTabHint(tab, u, isMe) {
    const hint = document.getElementById('profileListHint');
    if (!hint) return;
    if (tab === 'likes' && isMe && !u.likes_public) {
        hint.textContent = T('profilePrivateHint');
        hint.hidden = false;
    } else if (tab === 'bookmarks' && isMe && !u.bookmarks_public) {
        hint.textContent = T('profilePrivateHint');
        hint.hidden = false;
    } else {
        hint.textContent = '';
        hint.hidden = true;
    }
}

function selectProfileTab(tab) {
    if (!currentProfileData || !currentProfileData.user) return;
    currentProfileTab = tab || 'works';
    document.querySelectorAll('#profileTabs .profile-tab').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-ptab') === currentProfileTab);
    });
    const u = currentProfileData.user;
    if (currentProfileTab === 'works') {
        profileTabHint('works', u, !!u.is_self);
        renderProfileWorks(currentProfileData.posts || [], 'profileNoWorks', false);
        return;
    }
    profileTabHint(currentProfileTab, u, !!u.is_self);
    const cached = profileSavedCache[currentProfileTab];
    if (cached) {
        renderProfileWorks(cached, currentProfileTab === 'likes' ? 'profileEmptyLikes' : 'profileEmptyBookmarks', true);
        return;
    }
    const grid = document.getElementById('profileWorks');
    grid.classList.remove('masonry');
    grid.style.height = '';
    grid.innerHTML = '<div class="profile-empty">' + T('profileLoading') + '</div>';
    loadProfileSaved(currentProfileTab);
}

async function loadProfileSaved(tab) {
    if (!currentProfileData || !currentProfileData.user) return;
    const username = currentProfileData.user.username;
    try {
        const res = await Auth.get('/api/users/' + encodeURIComponent(username) + '/' + tab);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        profileSavedCache[tab] = data.posts || [];
        if (currentProfileTab === tab) {
            renderProfileWorks(profileSavedCache[tab], tab === 'likes' ? 'profileEmptyLikes' : 'profileEmptyBookmarks', true);
        }
    } catch (e) {
        if (currentProfileTab === tab) {
            profileSavedCache[tab] = [];
            renderProfileWorks([], tab === 'likes' ? 'profileEmptyLikes' : 'profileEmptyBookmarks', true);
        }
    }
}

function renderProfileWorks(posts, emptyKey, showAuthor) {
    const grid = document.getElementById('profileWorks');
    grid.classList.remove('masonry');
    grid.style.height = '';
    grid.innerHTML = '';
    if (!posts.length) {
        grid.innerHTML = '<div class="profile-empty">' + T(emptyKey || 'profileNoWorks') + '</div>';
        return;
    }
    posts.forEach(function (p) {
        const postImages = getPostImages(p);
        const cover = postImages[0] || '';
        const tags = getPostTags(p);
        const tagsHtml = tags.length
            ? '<div class="card-tags">' + tags.map(function (t) {
                return '<span class="card-tag-chip">#' + escapeHtml(t) + '</span>';
            }).join('') + '</div>'
            : '';
        const boardHtml = '<div class="card-board">' + boardPill(p.board) + '</div>';
        const kindClass = p.kind === 'poll' ? ' card-kind-poll' : (p.kind === 'note' ? ' card-kind-note' : (p.kind === 'music' ? ' card-kind-music' : ''));
        const musicHtml = p.kind === 'music' ? ('<div class="music-card-preview"><svg class="icon" aria-hidden="true"><use href="#i-music"></use></svg>' +
            escapeHtml(p.music_artist || '') + '</div>') : '';
        const pollHtml = (p.kind === 'poll' && p.poll) ? ('<div class="poll-preview">' +
            p.poll.options.map(function (o) {
                return '<div class="poll-preview-row"><span class="poll-preview-label">' + escapeHtml(o.text) +
                    '</span><span class="poll-preview-bar"><i style="width:' +
                    Math.max(0, Math.min(100, o.percent || 0)) + '%"></i></span><span class="poll-preview-count">' +
                    (o.count || 0) + '</span></div>';
            }).join('') + '</div>') : '';
        const stats = '<div class="profile-work-stats">' +
            (showAuthor ? '<span>@' + escapeHtml(p.author || '') + '</span>' : '') +
            '<span><svg class="icon" aria-hidden="true"><use href="#i-like"></use></svg>' + (p.likes || 0) + '</span>' +
            '<span><svg class="icon" aria-hidden="true"><use href="#i-eye"></use></svg>' + (p.views || 0) + '</span>' +
            '<span><svg class="icon" aria-hidden="true"><use href="#i-reply"></use></svg>' + (p.replies || 0) + '</span>' +
            '<span>' + formatTime(p) + '</span>' +
        '</div>';
        const excerpt = (p.content || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        const card = document.createElement('article');
        card.className = 'post-card profile-work-card' + kindClass;
        card.setAttribute('data-id', p.id);
        card.tabIndex = 0;
        card.setAttribute('role', 'link');
        if (cover) {
            card.innerHTML =
                '<div class="card-cover"><img src="' + escapeHtml(cover) + '" alt="" decoding="async"></div>' +
                '<div class="card-body">' + boardHtml + '<h3 class="card-title">' + escapeHtml(p.title || T('untitled')) + '</h3>' +
                    tagsHtml + musicHtml + pollHtml + stats + '</div>';
        } else {
            card.innerHTML =
                '<div class="card-body">' + boardHtml + '<h3 class="card-title">' + escapeHtml(p.title || T('untitled')) + '</h3>' +
                    tagsHtml + (excerpt ? '<p class="card-excerpt">' + escapeHtml(excerpt) + '</p>' : '') + musicHtml + pollHtml + stats + '</div>';
        }
        if (postImages.length > 1) {
            const countBadge = document.createElement('span');
            countBadge.className = 'card-image-count';
            countBadge.textContent = postImages.length;
            const coverBox = card.querySelector('.card-cover');
            if (coverBox) coverBox.appendChild(countBadge);
        }
        const img = card.querySelector('.card-cover img');
        if (img) {
            img.addEventListener('load', scheduleProfileMasonry);
            if (img.complete && img.naturalWidth) scheduleProfileMasonry();
        }
        card.addEventListener('click', function () { openDetail(p.id); });
        card.addEventListener('keydown', function (e) {
            if (e.target !== card) return;
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(p.id); }
        });
        grid.appendChild(card);
    });
    scheduleProfileMasonry();
}

function scheduleProfileMasonry() {
    if (profileMasonryRaf) return;
    profileMasonryRaf = requestAnimationFrame(function () {
        profileMasonryRaf = null;
        layoutProfileMasonry();
    });
}

function layoutProfileMasonry() {
    const grid = document.getElementById('profileWorks');
    if (!grid || document.getElementById('profilePage').hidden) return;
    const cards = Array.prototype.slice.call(grid.children).filter(function (el) {
        return el.classList.contains('post-card');
    });
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
        for (let i = 1; i < cols; i++) if (heights[i] < heights[col]) col = i;
        card.style.transform = 'translate3d(' + (col * (colWidth + gap)) + 'px, ' + heights[col] + 'px, 0)';
        heights[col] += card.offsetHeight + gap;
    });
    grid.style.height = (Math.max.apply(null, heights) - gap) + 'px';
}

async function toggleProfileFollow() {
    if (!Auth.isLoggedIn()) {
        alert(T('profileLoginToFollow'));
        window.location.href = 'login.html';
        return;
    }
    if (!currentProfileData || !currentProfileData.user) return;
    const u = currentProfileData.user;
    const on = !u.is_following;
    const btn = document.getElementById('profileFollowBtn');
    if (btn) btn.disabled = true;
    try {
        const res = await Auth.post('/api/users/' + encodeURIComponent(u.username) + '/follow', { on: on });
        if (!res.ok) {
            const err = await res.json().catch(function () { return {}; });
            throw new Error(err.error || T('profileFollowFailed'));
        }
        const data = await res.json();
        u.is_following = !!data.is_following;
        u.following_count = data.following_count;
        u.followers_count = data.followers_count;
        if (u.is_following) followingUsers.add(u.username);
        else followingUsers.delete(u.username);
        localStorage.setItem(K_FOLLOW, JSON.stringify(Array.from(followingUsers)));
        if (currentTab === 'followed') render();
        renderProfile(currentProfileData);
    } catch (e) {
        alert(T('profileFollowFailed') + ' ' + e.message);
        if (btn) btn.disabled = false;
    }
}

function openConnections(username, type) {
    if (!username) return;
    currentConnectionsUsername = username;
    currentConnectionsType = type || 'following';
    document.getElementById('connectionsModal').hidden = false;
    document.querySelectorAll('.connections-tab').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-type') === currentConnectionsType);
    });
    document.getElementById('connectionsTitle').textContent =
        currentConnectionsType === 'followers' ? T('profileFollowers') : T('profileFollowing');
    loadConnections();
}

function closeConnections() {
    const modal = document.getElementById('connectionsModal');
    if (modal) modal.hidden = true;
}

async function loadConnections() {
    const list = document.getElementById('connectionsList');
    if (!list) return;
    const requestId = ++connectionsRequestId;
    list.innerHTML = '<div class="profile-empty">' + T('profileLoading') + '</div>';
    try {
        const res = await Auth.get('/api/users/' + encodeURIComponent(currentConnectionsUsername) +
            '/connections?type=' + encodeURIComponent(currentConnectionsType));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (requestId !== connectionsRequestId) return;
        const users = data.users || [];
        if (!users.length) {
            list.innerHTML = '<div class="profile-empty">' +
                (currentConnectionsType === 'followers' ? T('profileNoFollowers') : T('profileNoFollowing')) +
            '</div>';
            return;
        }
        list.innerHTML = users.map(function (u) {
            return '<button type="button" class="connection-item" data-username="' + escapeHtml(u.username) + '">' +
                '<span class="connection-avatar">' +
                    (u.avatar ? '<img src="' + escapeHtml(u.avatar) + '" alt="">'
                              : '<svg class="icon" aria-hidden="true"><use href="#i-user"></use></svg>') +
                '</span>' +
                '<span><span class="connection-name">' + escapeHtml(u.display_name || u.username) + '</span>' +
                    '<span class="connection-username">@' + escapeHtml(u.username) + '</span></span>' +
            '</button>';
        }).join('');
        list.querySelectorAll('.connection-item').forEach(function (btn) {
            btn.addEventListener('click', function () {
                closeConnections();
                openProfile(this.getAttribute('data-username'));
            });
        });
    } catch (e) {
        if (requestId !== connectionsRequestId) return;
        list.innerHTML = '<div class="profile-empty">' + T('profileConnectionsFailed') + '</div>';
    }
}

function openProfileEdit() {
    if (!currentProfileData || !currentProfileData.user) return;
    if (!Auth.user || currentProfileData.user.username !== Auth.user.username) return;
    const u = currentProfileData.user;
    profileEditAvatar = u.avatar || '';
    profileEditBanner = u.banner || '';
    document.getElementById('editDisplayName').value = u.display_name || u.username;
    document.getElementById('editBio').value = u.bio || '';
    document.getElementById('editLikesPublic').checked = !!u.likes_public;
    document.getElementById('editBookmarksPublic').checked = !!u.bookmarks_public;
    document.getElementById('editStatus').textContent = '';
    renderProfileEditMedia();
    document.getElementById('profileEditModal').hidden = false;
}

function closeProfileEdit() {
    const modal = document.getElementById('profileEditModal');
    if (modal) modal.hidden = true;
    profileEditSaving = false;
}

function renderProfileEditMedia() {
    const avatar = document.getElementById('editAvatarPreview');
    if (avatar) {
        avatar.innerHTML = profileEditAvatar
            ? '<img src="' + escapeHtml(profileEditAvatar) + '" alt="">'
            : '<svg class="icon" aria-hidden="true"><use href="#i-user"></use></svg>';
    }
    const banner = document.getElementById('editBannerPreview');
    if (banner) {
        banner.style.backgroundImage = profileEditBanner
            ? 'url(' + JSON.stringify(profileEditBanner) + ')'
            : '';
    }
}

async function handleProfileImage(kind, file) {
    const status = document.getElementById('editStatus');
    if (!file || !file.type || !file.type.startsWith('image/')) {
        alert(T('imageOnly'));
        return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
        alert(T('imageTooLarge', { name: file.name || '' }));
        return;
    }
    if (status) status.textContent = T('profileUploading');
    try {
        const blob = await prepareImageBlob(file);
        const url = await uploadImageBlob(blob, file.name);
        if (kind === 'avatar') profileEditAvatar = url;
        else profileEditBanner = url;
        renderProfileEditMedia();
        if (status) status.textContent = '';
    } catch (e) {
        if (status) status.textContent = T('profileUploadFailed');
        alert(T('profileUploadFailed') + ' ' + e.message);
    }
}

async function saveProfileEdit() {
    if (profileEditSaving || !currentProfileData) return;
    profileEditSaving = true;
    const btn = document.getElementById('profileEditSave');
    if (btn) btn.disabled = true;
    try {
        const displayName = document.getElementById('editDisplayName').value.trim();
        const bio = document.getElementById('editBio').value.trim();
        const res = await Auth.post('/api/me/profile', {
            display_name: displayName,
            bio: bio,
            avatar: profileEditAvatar,
            banner: profileEditBanner,
            likes_public: document.getElementById('editLikesPublic').checked,
            bookmarks_public: document.getElementById('editBookmarksPublic').checked
        });
        if (!res.ok) {
            const err = await res.json().catch(function () { return {}; });
            throw new Error(err.error || T('profileSaveFailed'));
        }
        const data = await res.json();
        const oldUsername = currentProfileData.user.username;
        currentProfileData.user.username = data.user.username;
        currentProfileData.user.display_name = data.user.display_name;
        currentProfileData.user.bio = data.user.bio;
        currentProfileData.user.avatar = data.user.avatar;
        currentProfileData.user.banner = data.user.banner;
        currentProfileData.user.likes_public = !!data.user.likes_public;
        currentProfileData.user.bookmarks_public = !!data.user.bookmarks_public;
        currentProfileUsername = data.user.username;
        if (Auth.user) {
            Auth.user.username = data.user.username;
            Auth.user.display_name = data.user.display_name;
            Auth.user.bio = data.user.bio;
            Auth.user.avatar = data.user.avatar;
            Auth.user.banner = data.user.banner;
            Auth.user.likes_public = data.user.likes_public;
            Auth.user.bookmarks_public = data.user.bookmarks_public;
            Auth.save(Auth.token, Auth.user);
        }
        if (oldUsername && oldUsername !== data.user.username) {
            // 昵称变了：刷新首页作者名，后续新帖也会用新昵称
            fetchPosts();
        }
        updateHeaderAvatar();
        const scroll = document.getElementById('profilePage').scrollTop;
        closeProfileEdit();
        renderProfile(currentProfileData);
        document.getElementById('profilePage').scrollTop = scroll;
    } catch (e) {
        alert(T('profileSaveFailed') + ' ' + e.message);
    } finally {
        profileEditSaving = false;
        if (btn) btn.disabled = false;
    }
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

function updateMsgDot(count) {
    updateUnreadBadge(document.getElementById('msgDot'), count);
}

async function refreshMsgDot() {
    const dot = document.getElementById('msgDot');
    if (!dot) return;
    if (!Auth.isLoggedIn()) { updateUnreadBadge(dot, 0); return; }
    try {
        const res = await Auth.get('/api/messages');
        if (!res.ok) { updateUnreadBadge(dot, 0); return; }
        const data = await res.json();
        updateUnreadBadge(dot, data.unread || 0);
    } catch (e) {
        updateUnreadBadge(dot, 0);
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
        updateMsgDot(data.unread || 0);
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

function bounceFooterIcon(id) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const icon = btn.querySelector('.icon');
    if (!icon) return;
    btn.classList.remove('icon-pop');
    void btn.offsetWidth;
    btn.classList.add('icon-pop');
    clearTimeout(btn._iconPopTimer);
    btn._iconPopTimer = setTimeout(function () { btn.classList.remove('icon-pop'); }, 420);
}

function makeRollWindow(oldText, newText, direction) {
    const win = document.createElement('span');
    win.className = 'digit-window';
    const oldSpan = document.createElement('span');
    oldSpan.className = 'digit digit-old ' + (direction > 0 ? 'roll-up' : 'roll-down');
    oldSpan.textContent = oldText;
    const newSpan = document.createElement('span');
    newSpan.className = 'digit digit-new ' + (direction > 0 ? 'roll-in-up' : 'roll-in-down');
    newSpan.textContent = newText;
    win.appendChild(oldSpan);
    win.appendChild(newSpan);
    return win;
}

function animateCount(el, value) {
    if (!el) return;
    const newText = String(Math.max(0, Number(value) || 0));
    const oldText = el.dataset.count != null ? el.dataset.count : (el.textContent || '0').trim();
    if (oldText === newText) {
        el.textContent = newText;
        el.dataset.count = newText;
        return;
    }
    el.classList.add('count-roll');
    el.dataset.count = newText;
    clearTimeout(el._countTimer);
    const direction = (Number(newText) || 0) >= (Number(oldText) || 0) ? 1 : -1;
    const numeric = /^\d+$/.test(oldText) && /^\d+$/.test(newText) && oldText.length === newText.length;
    el.innerHTML = '';
    if (!numeric) {
        el.appendChild(makeRollWindow(oldText, newText, direction));
    } else {
        for (let i = 0; i < newText.length; i++) {
            if (oldText[i] === newText[i]) {
                const stat = document.createElement('span');
                stat.className = 'digit-static';
                stat.textContent = newText[i];
                el.appendChild(stat);
            } else {
                el.appendChild(makeRollWindow(oldText[i], newText[i], direction));
            }
        }
    }
    el._countTimer = setTimeout(function () {
        el.textContent = newText;
        el.dataset.count = newText;
    }, 420);
}

function updateFooterButtons() {
    if (!currentPost) return;
    const liked = currentPost.liked !== undefined
        ? !!currentPost.liked
        : (getLiked().indexOf(currentPost.id) !== -1);
    const coined = currentPost.coined !== undefined
        ? !!currentPost.coined
        : (getCoined().indexOf(currentPost.id) !== -1);
    animateCount(document.getElementById('footerLikeCount'), currentPost.likes || 0);
    animateCount(document.getElementById('footerCoinCount'), currentPost.coins || 0);
    animateCount(document.getElementById('footerStarCount'), currentPost.bookmarked ? 1 : 0);
    const likeBtn = document.getElementById('footerLike');
    const coinBtn = document.getElementById('footerCoin');
    const isOwn = !!(Auth.isLoggedIn() && Auth.user && currentPost.author === Auth.user.username);
    likeBtn.classList.toggle('active', liked);
    coinBtn.classList.toggle('active', coined);
    coinBtn.disabled = coined || isOwn;
    coinBtn.classList.toggle('coin-own', isOwn);
    coinBtn.title = isOwn ? T('coinOwn') : (coined ? T('coinedTitle') : T('coinTitle'));
    document.getElementById('footerStar').classList.toggle('active', !!currentPost.bookmarked);
}

// ---------- localStorage ----------
function getRead() { try { return JSON.parse(localStorage.getItem(K_READ) || '[]'); } catch (e) { return []; } }
function markRead(id) {
    const r = getRead();
    if (r.indexOf(id) === -1) {
        r.push(id);
        localStorage.setItem(K_READ, JSON.stringify(r));
    }
    if (Auth.isLoggedIn()) {
        Auth.post('/api/posts/' + id + '/read').catch(function () {});
    }
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

function linkify(text) {
    const raw = String(text == null ? '' : text);
    const re = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
        out += escapeHtml(raw.slice(last, m.index));
        let url = m[0];
        let trailing = '';
        const tm = url.match(/[.,!?;:，。！？；：、)）\]】]+$/);
        if (tm) {
            trailing = tm[0];
            url = url.slice(0, -trailing.length);
        }
        if (!url) {
            out += escapeHtml(m[0]);
            last = re.lastIndex;
            continue;
        }
        const href = /^www\./i.test(url) ? 'https://' + url : url;
        out += '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' +
            escapeHtml(url) + '</a>' + escapeHtml(trailing);
        last = m.index + url.length;
        re.lastIndex = last;
    }
    out += escapeHtml(raw.slice(last));
    return out;
}
