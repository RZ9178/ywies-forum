// admin.js - 管理后台
(function () {
    'use strict';

    if (!Auth.isLoggedIn()) {
        window.location.replace('login.html');
        return;
    }

    const PAGE_SIZE = 50;
    const state = {
        view: 'overview',
        stats: { users: 0, posts: 0, comments: 0, admins: 0, coins: 0 },
        posts: [],
        pins: [],
        postTotal: 0,
        postPage: 0,
        postQuery: '',
        postFilter: 'all',
        users: [],
        userTotal: 0,
        userPage: 0,
        userQuery: '',
        userFilter: 'all',
        audit: { posts: [], comments: [], deletions: [] },
        auditTab: 'comments',
        confirmResolve: null,
    };

    const BOARD_NAMES = { general: '灌水', study: '学习', music: '音乐', poll: '投票', share: '分享' };
    const VIEW_TITLES = {
        overview: ['概览', '论坛运营数据与最近动态'],
        posts: ['帖子管理', '查看、搜索和删除帖子'],
        users: ['用户管理', '管理账号、管理员权限与密码'],
        audit: ['内容审查', '精确时间、评论、帖子与删除快照'],
    };

    function $(id) { return document.getElementById(id); }

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function formatExact(value) {
        if (!value) return '-';
        const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!m) return String(value);
        const pad = function (n) { return String(n).padStart(2, '0'); };
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
        if (isNaN(d.getTime())) return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
            pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    function truncate(text, n) {
        text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
        return text.length > n ? text.slice(0, n) + '…' : text;
    }

    function initials(name) {
        const s = String(name || '?').trim();
        return s ? s.slice(0, 1).toUpperCase() : '?';
    }

    function avatarHtml(user, extraClass) {
        const cls = 'admin-avatar' + (extraClass ? ' ' + extraClass : '');
        if (user && user.avatar) {
            return '<span class="' + cls + '"><img src="' + escapeHtml(user.avatar) + '" alt=""></span>';
        }
        return '<span class="' + cls + '">' + escapeHtml(initials(user && (user.display_name || user.username))) + '</span>';
    }

    function tagsHtml(tags) {
        const list = String(tags || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
        return list.map(function (t) { return '<span class="admin-tag">#' + escapeHtml(t) + '</span>'; }).join(' ');
    }

    function debounce(fn, wait) {
        let timer = null;
        return function () {
            const args = arguments;
            const ctx = this;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(ctx, args); }, wait);
        };
    }

    async function apiGet(url) {
        const res = await Auth.get(url);
        if (!res.ok) {
            let msg = '加载失败';
            try { msg = (await res.json()).error || msg; } catch (e) {}
            throw new Error(msg);
        }
        return res.json();
    }

    async function apiPost(url, body) {
        const res = await Auth.post(url, body);
        if (!res.ok) {
            let msg = '操作失败';
            try { msg = (await res.json()).error || msg; } catch (e) {}
            throw new Error(msg);
        }
        return res.json();
    }

    async function apiDelete(url) {
        const res = await Auth.del(url);
        if (!res.ok) {
            let msg = '删除失败';
            try { msg = (await res.json()).error || msg; } catch (e) {}
            throw new Error(msg);
        }
        return res.json();
    }

    let toastTimer = null;
    function toast(message, type) {
        const el = $('adminToast');
        if (!el) return;
        el.textContent = message;
        el.className = 'admin-toast ' + (type || '');
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
    }

    function setWho() {
        const u = Auth.user || {};
        const el = $('adminWho');
        if (!el) return;
        el.innerHTML = avatarHtml(u) + '<span class="admin-who-name">' + escapeHtml(u.display_name || u.username || '管理员') + '</span>' +
            '<span class="admin-badge admin">管理员</span>';
    }

    function switchView(view, updateHash) {
        if (!VIEW_TITLES[view]) view = 'overview';
        state.view = view;
        document.querySelectorAll('.admin-view').forEach(function (section) {
            section.hidden = section.getAttribute('data-view') !== view;
        });
        document.querySelectorAll('.admin-nav-item').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-view') === view);
        });
        const title = VIEW_TITLES[view];
        $('adminTitle').textContent = title[0];
        $('adminSubtitle').textContent = title[1];
        if (updateHash !== false) {
            try { history.replaceState(null, '', '#' + view); } catch (e) {}
        }
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function renderStats() {
        const s = state.stats;
        $('adminStatUsers').textContent = s.users == null ? '-' : s.users;
        $('adminStatPosts').textContent = s.posts == null ? '-' : s.posts;
        $('adminStatComments').textContent = s.comments == null ? '-' : s.comments;
        $('adminStatAdmins').textContent = s.admins == null ? '-' : s.admins;
        $('adminStatCoins').textContent = s.coins == null ? '-' : s.coins;
        $('adminNavPosts').textContent = s.posts == null ? '0' : s.posts;
        $('adminNavUsers').textContent = s.users == null ? '0' : s.users;
    }

    function renderOverview() {
        const posts = state.posts.slice(0, 6);
        const recentPosts = $('adminRecentPosts');
        if (!posts.length) {
            recentPosts.innerHTML = '<div class="admin-mini-empty">还没有帖子</div>';
        } else {
            recentPosts.innerHTML = posts.map(function (p) {
                return '<div class="admin-mini-row" data-open-post="' + p.id + '">' +
                    '<div class="admin-mini-main">' +
                        '<div class="admin-mini-title">' + escapeHtml(p.title || '无标题') + '</div>' +
                        '<div class="admin-mini-meta">' + escapeHtml(p.author) + ' · ' + formatExact(p.created_at) + '</div>' +
                    '</div><span class="admin-mini-arrow">›</span></div>';
            }).join('');
        }
        const users = state.users.slice(0, 6);
        const recentUsers = $('adminRecentUsers');
        if (!users.length) {
            recentUsers.innerHTML = '<div class="admin-mini-empty">还没有用户</div>';
        } else {
            recentUsers.innerHTML = users.map(function (u) {
                return '<div class="admin-mini-row" data-open-user="' + escapeHtml(u.username) + '">' +
                    avatarHtml(u) +
                    '<div class="admin-mini-main"><div class="admin-mini-title">' + escapeHtml(u.display_name || u.username) +
                        (u.is_admin ? ' <span class="admin-badge admin">管理员</span>' : '') + '</div>' +
                        '<div class="admin-mini-meta">@' + escapeHtml(u.username) + ' · ' + formatExact(u.created_at) + '</div>' +
                    '</div><span class="admin-mini-arrow">›</span></div>';
            }).join('');
        }
    }

    function filteredPosts() {
        if (state.postFilter === 'image') {
            return state.posts.filter(function (p) { return p.image_url || p.images; });
        }
        if (state.postFilter === 'text') {
            return state.posts.filter(function (p) { return !p.image_url && !p.images; });
        }
        return state.posts;
    }

    function renderPosts() {
        const list = $('adminPostList');
        const posts = filteredPosts();
        const pinnedIds = new Set((state.pins || []).map(function (p) { return p.post_id; }));
        $('adminPostCount').textContent = posts.length + (state.postTotal > posts.length ? ' / ' + state.postTotal : '') + ' 条';
        if (!posts.length) {
            list.innerHTML = '<div class="admin-empty">没有符合条件的帖子</div>';
        } else {
            list.innerHTML = posts.map(function (p) {
                return '<div class="admin-item">' +
                    '<div class="admin-item-main">' +
                        '<div class="admin-item-title">' + escapeHtml(p.title || '无标题') +
                            ' <span class="admin-badge user">' + escapeHtml(BOARD_NAMES[p.board] || '灌水') + '</span>' +
                            (p.kind === 'poll' ? ' <span class="admin-badge image">投票</span>' : '') +
                            (p.image_url || p.images ? ' <span class="admin-badge image">图片</span>' : '') + '</div>' +
                        '<div class="admin-item-meta">#' + p.id + ' · <b>' + escapeHtml(p.author) + '</b> · ' + formatExact(p.created_at) + '</div>' +
                        '<div class="admin-item-excerpt">' + escapeHtml(truncate(p.content, 180)) + '</div>' +
                        '<div class="admin-item-stats">' +
                            '<span><svg class="admin-ico"><use href="#adm-eye"></use></svg>' + (p.views || 0) + '</span>' +
                            '<span>♥ ' + (p.likes || 0) + '</span>' +
                            '<span>◈ ' + (p.coins || 0) + '</span>' +
                            '<span>评论 ' + (p.replies || 0) + '</span>' +
                            (p.tags ? '<span>' + tagsHtml(p.tags) + '</span>' : '') +
                        '</div>' +
                    '</div>' +
                    '<div class="admin-actions">' +
                        '<button type="button" class="admin-btn sm" data-action="view-post" data-id="' + p.id + '">查看</button>' +
                        '<button type="button" class="admin-btn sm" data-action="pin-post" data-id="' + p.id + '"' +
                            (!pinnedIds.has(p.id) && (state.pins || []).length >= 3 ? ' disabled' : '') + '>' +
                            (pinnedIds.has(p.id) ? '取消置顶' : '置顶') + '</button>' +
                        '<button type="button" class="admin-btn sm danger" data-action="delete-post" data-id="' + p.id + '">删除</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        }
        const pages = Math.max(1, Math.ceil(state.postTotal / PAGE_SIZE));
        $('adminPostPage').textContent = (state.postPage + 1) + ' / ' + pages;
        $('adminPostPrev').disabled = state.postPage <= 0;
        $('adminPostNext').disabled = state.postPage + 1 >= pages;
    }

    function renderUsers() {
        const list = $('adminUserList');
        let users = state.users;
        if (state.userFilter === 'admin') users = users.filter(function (u) { return u.is_admin; });
        if (state.userFilter === 'normal') users = users.filter(function (u) { return !u.is_admin; });
        $('adminUserCount').textContent = users.length + (state.userTotal > users.length ? ' / ' + state.userTotal : '') + ' 个用户';
        if (!users.length) {
            list.innerHTML = '<div class="admin-empty">没有符合条件的用户</div>';
        } else {
            list.innerHTML = users.map(function (u) {
                const self = Auth.user && u.id === Auth.user.id;
                return '<div class="admin-item">' +
                    '<div class="admin-user-cell">' +
                        avatarHtml(u, 'lg') +
                        '<div class="admin-user-info">' +
                            '<div class="admin-user-name">' + escapeHtml(u.display_name || u.username) +
                                (u.is_admin ? ' <span class="admin-badge admin">管理员</span>' : '') +
                                (self ? ' <span class="admin-badge self">当前账号</span>' : '') + '</div>' +
                            '<div class="admin-user-sub">@' + escapeHtml(u.username) + ' · ' + escapeHtml(u.email || '无邮箱') + '</div>' +
                            '<div class="admin-user-nums"><span>帖子 <b>' + (u.post_count || 0) + '</b></span>' +
                                '<span>评论 <b>' + (u.comment_count || 0) + '</b></span>' +
                                '<span>硬币 <b>' + (u.coins || 0) + '</b></span>' +
                                '<span>注册 ' + formatExact(u.created_at) + '</span></div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="admin-actions">' +
                        '<button type="button" class="admin-btn sm" data-action="view-user" data-username="' + escapeHtml(u.username) + '">查看</button>' +
                        '<button type="button" class="admin-btn sm" data-action="role-user" data-id="' + u.id + '"' + (self ? ' disabled' : '') + '>' +
                            (u.is_admin ? '取消管理员' : '设为管理员') + '</button>' +
                        '<button type="button" class="admin-btn sm" data-action="reset-user" data-id="' + u.id + '"' + (self ? ' disabled' : '') + '>重置密码</button>' +
                        '<button type="button" class="admin-btn sm danger" data-action="delete-user" data-id="' + u.id + '"' + (self ? ' disabled' : '') + '>删除</button>' +
                    '</div>' +
                '</div>';
            }).join('');
        }
        const pages = Math.max(1, Math.ceil(state.userTotal / PAGE_SIZE));
        $('adminUserPage').textContent = (state.userPage + 1) + ' / ' + pages;
        $('adminUserPrev').disabled = state.userPage <= 0;
        $('adminUserNext').disabled = state.userPage + 1 >= pages;
    }

    function renderAudit() {
        const wrap = $('adminAuditList');
        const d = state.audit;
        if (state.auditTab === 'comments') {
            const rows = d.comments || [];
            wrap.innerHTML = rows.length ? rows.map(function (c) {
                return '<div class="admin-audit-item">' +
                    '<div class="admin-audit-head">#' + c.id + ' · <span class="admin-audit-actor">' + escapeHtml(c.author) + '</span>' +
                        ' · ' + formatExact(c.created_at) + ' · 帖子 ' + escapeHtml(c.post_title || '（已删除）') + ' #' + c.post_id + '</div>' +
                    (c.reply_to ? '<div class="admin-item-meta">回复 @' + escapeHtml(c.reply_to) + '</div>' : '') +
                    '<div class="admin-audit-content">' + escapeHtml(c.content) + '</div>' +
                '</div>';
            }).join('') : '<div class="admin-empty">暂无评论</div>';
        } else if (state.auditTab === 'posts') {
            const rows = d.posts || [];
            wrap.innerHTML = rows.length ? rows.map(function (p) {
                return '<div class="admin-audit-item">' +
                    '<div class="admin-audit-head">#' + p.id + ' · ' + escapeHtml(p.title) + '</div>' +
                    '<div class="admin-item-meta">' + escapeHtml(p.author) + ' · ' + formatExact(p.created_at) +
                        ' · ' + (p.replies || 0) + ' 评论 · ' + (p.views || 0) + ' 浏览 · ' + (p.likes || 0) + ' 赞</div>' +
                '</div>';
            }).join('') : '<div class="admin-empty">暂无帖子</div>';
        } else {
            const rows = d.deletions || [];
            const names = { delete_post: '删除帖子', delete_comment: '删除评论', delete_user: '删除账号', set_admin: '修改管理员', reset_password: '重置密码', pin_post: '置顶帖子', unpin_post: '取消置顶', pin_comment: '置顶评论', unpin_comment: '取消置顶评论' };
            wrap.innerHTML = rows.length ? rows.map(function (x) {
                let content = x.content || '';
                try { content = JSON.stringify(JSON.parse(content), null, 2); } catch (e) {}
                return '<div class="admin-audit-item">' +
                    '<div class="admin-audit-head">' + escapeHtml(names[x.action] || x.action) +
                        ' · 操作人 <span class="admin-audit-actor">' + escapeHtml(x.actor) + '</span> · ' + formatExact(x.created_at) + '</div>' +
                    '<div class="admin-item-meta">目标：' + escapeHtml(x.target_type) + ' #' + x.target_id +
                        (x.post_id ? ' · 帖子 #' + x.post_id : '') + '</div>' +
                    '<details><summary>查看内容快照</summary><pre>' + escapeHtml(content) + '</pre></details>' +
                '</div>';
            }).join('') : '<div class="admin-empty">暂无删除记录</div>';
        }
    }

    function renderPins() {
        const wrap = $('adminPinList');
        const pins = state.pins || [];
        $('adminPinCount').textContent = pins.length + ' / 3';
        if (!pins.length) {
            wrap.innerHTML = '<div class="admin-empty">还没有置顶帖子</div>';
            return;
        }
        wrap.innerHTML = pins.map(function (p) {
            return '<div class="admin-item">' +
                '<div class="admin-item-main">' +
                    '<div class="admin-item-title">' + escapeHtml(p.title || '无标题') +
                        ' <span class="admin-badge image">置顶</span></div>' +
                    '<div class="admin-item-meta">#' + p.post_id + ' · ' + escapeHtml(p.author) +
                        ' · 置顶人 ' + escapeHtml(p.pinned_by) + ' · ' + formatExact(p.pinned_at) + '</div>' +
                '</div>' +
                '<div class="admin-actions">' +
                    '<button type="button" class="admin-btn sm" data-action="view-pin" data-id="' + p.post_id + '">查看</button>' +
                    '<button type="button" class="admin-btn sm danger" data-action="unpin" data-id="' + p.post_id + '">取消置顶</button>' +
                '</div>' +
            '</div>';
        }).join('');
    }

    async function loadPins() {
        const data = await apiGet('/api/admin/pins');
        state.pins = data.pins || [];
        renderPins();
        renderPosts();
    }

    async function pinPost(id, on) {
        try {
            await apiPost('/api/admin/posts/' + id + '/pin', { on: on });
            toast(on ? '已置顶' : '已取消置顶', 'success');
            await Promise.all([loadPins(), loadPosts(), loadAudit()]);
        } catch (e) {
            toast(e.message || '操作失败', 'error');
        }
    }

    async function loadStats() {
        const data = await apiGet('/api/admin/stats');
        state.stats = data;
        renderStats();
    }

    async function loadPosts() {
        $('adminPostList').innerHTML = '<div class="admin-loading">加载中...</div>';
        const url = '/api/admin/posts?q=' + encodeURIComponent(state.postQuery) +
            '&limit=' + PAGE_SIZE + '&offset=' + (state.postPage * PAGE_SIZE);
        const data = await apiGet(url);
        state.posts = data.posts || [];
        state.postTotal = data.total || 0;
        if (state.postPage > 0 && state.posts.length === 0 && state.postTotal > 0) {
            state.postPage = Math.max(0, Math.ceil(state.postTotal / PAGE_SIZE) - 1);
            return loadPosts();
        }
        renderPosts();
        renderOverview();
    }

    async function loadUsers() {
        $('adminUserList').innerHTML = '<div class="admin-loading">加载中...</div>';
        const url = '/api/admin/users?q=' + encodeURIComponent(state.userQuery) +
            '&limit=' + PAGE_SIZE + '&offset=' + (state.userPage * PAGE_SIZE);
        const data = await apiGet(url);
        state.users = data.users || [];
        state.userTotal = data.total || 0;
        if (state.userPage > 0 && state.users.length === 0 && state.userTotal > 0) {
            state.userPage = Math.max(0, Math.ceil(state.userTotal / PAGE_SIZE) - 1);
            return loadUsers();
        }
        renderUsers();
        renderOverview();
    }

    async function loadAudit() {
        $('adminAuditList').innerHTML = '<div class="admin-loading">加载中...</div>';
        state.audit = await apiGet('/api/admin/audit');
        renderAudit();
    }

    async function loadAll() {
        const btn = $('adminRefresh');
        btn.disabled = true;
        try {
            await Promise.all([loadStats(), loadPins(), loadPosts(), loadUsers(), loadAudit()]);
            renderOverview();
        } catch (e) {
            toast(e.message || '加载失败', 'error');
        } finally {
            btn.disabled = false;
        }
    }

    async function openPostDetail(id) {
        $('adminDetailTitle').textContent = '帖子详情';
        $('adminDetailBody').innerHTML = '<div class="admin-loading">加载中...</div>';
        $('adminDetailFoot').hidden = true;
        $('adminDetailMask').hidden = false;
        try {
            const results = await Promise.all([
                apiGet('/api/posts/' + id),
                apiGet('/api/posts/' + id + '/comments')
            ]);
            const p = results[0];
            const comments = Array.isArray(results[1]) ? results[1] : [];
            const images = Array.isArray(p.images) ? p.images : [];
            const imageHtml = images.length
                ? '<div class="admin-preview-images">' + images.map(function (url) {
                    return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener"><img src="' + escapeHtml(url) + '" alt=""></a>';
                }).join('') + '</div>'
                : '';
            const commentHtml = comments.length ? comments.slice(0, 30).map(function (c) {
                return '<div class="admin-preview-comment"><b>' + escapeHtml(c.author) + '</b> · ' + formatExact(c.created_at) +
                    (c.reply_to ? ' · 回复 @' + escapeHtml(c.reply_to) : '') +
                    '<div>' + escapeHtml(c.content) + '</div></div>';
            }).join('') : '<div class="admin-empty">暂无评论</div>';
            $('adminDetailTitle').textContent = '帖子 #' + p.id;
            $('adminDetailBody').innerHTML =
                '<div class="admin-preview-title">' + escapeHtml(p.title || '无标题') + '</div>' +
                '<div class="admin-preview-meta">' + escapeHtml(BOARD_NAMES[p.board] || '') + ' · 作者 ' + escapeHtml(p.author) + ' · ' + formatExact(p.created_at) +
                    ' · ' + (p.views || 0) + ' 浏览 · ' + (p.likes || 0) + ' 赞 · ' + (p.coins || 0) + ' 币</div>' +
                (p.tags ? '<div style="margin-top:8px;">' + tagsHtml(p.tags) + '</div>' : '') +
                '<div class="admin-preview-content">' + escapeHtml(p.content || '') + '</div>' + imageHtml +
                '<div class="admin-preview-comments"><h3>评论（' + comments.length + '）</h3>' + commentHtml + '</div>';
            $('adminDetailFoot').hidden = false;
            $('adminDetailFoot').innerHTML =
                '<button type="button" class="admin-btn danger" id="adminPreviewDelete">删除帖子</button>' +
                '<button type="button" class="admin-btn" data-close-detail="1">关闭</button>';
            $('adminPreviewDelete').addEventListener('click', function () {
                deletePost(p.id, p.title);
            });
            $('adminDetailFoot').querySelector('[data-close-detail]').addEventListener('click', closeDetail);
        } catch (e) {
            $('adminDetailBody').innerHTML = '<div class="admin-empty">加载失败：' + escapeHtml(e.message) + '</div>';
        }
    }

    async function openUserDetail(username) {
        const cached = state.users.filter(function (u) { return u.username === username; })[0] || {};
        $('adminDetailTitle').textContent = '用户详情';
        $('adminDetailBody').innerHTML = '<div class="admin-loading">加载中...</div>';
        $('adminDetailFoot').hidden = true;
        $('adminDetailMask').hidden = false;
        try {
            const data = await apiGet('/api/users/' + encodeURIComponent(username));
            const u = data.user || {};
            const posts = data.posts || [];
            const postHtml = posts.length ? posts.slice(0, 12).map(function (p) {
                return '<div class="admin-profile-post"><span>#' + p.id + '</span><span>' + escapeHtml(p.title) + '</span></div>';
            }).join('') : '<div class="admin-empty">还没有帖子</div>';
            $('adminDetailTitle').textContent = u.display_name || u.username;
            $('adminDetailBody').innerHTML =
                '<div class="admin-profile-head">' + avatarHtml(u, 'lg') +
                    '<div><div class="admin-profile-name">' + escapeHtml(u.display_name || u.username) +
                        (u.is_admin ? ' <span class="admin-badge admin">管理员</span>' : '') + '</div>' +
                        '<div class="admin-profile-sub">@' + escapeHtml(u.username) + (cached.email ? ' · ' + escapeHtml(cached.email) : '') + '</div></div>' +
                '</div>' +
                '<div class="admin-profile-stats">' +
                    '<div class="admin-profile-stat"><b>' + (u.post_count || 0) + '</b><span>帖子</span></div>' +
                    '<div class="admin-profile-stat"><b>' + (u.comments_count || 0) + '</b><span>评论</span></div>' +
                    '<div class="admin-profile-stat"><b>' + (u.likes_total || 0) + '</b><span>获赞</span></div>' +
                    '<div class="admin-profile-stat"><b>' + (cached.coins || 0) + '</b><span>硬币</span></div>' +
                '</div>' +
                '<div class="admin-profile-bio">' + escapeHtml(u.bio || '暂无简介') + '</div>' +
                '<div class="admin-profile-posts"><h3 style="font-size:12px;font-weight:800;margin-bottom:6px;">最近作品</h3>' + postHtml + '</div>';
            $('adminDetailFoot').hidden = false;
            $('adminDetailFoot').innerHTML =
                '<button type="button" class="admin-btn" data-close-detail="1">关闭</button>';
            $('adminDetailFoot').querySelector('[data-close-detail]').addEventListener('click', closeDetail);
        } catch (e) {
            $('adminDetailBody').innerHTML = '<div class="admin-empty">加载失败：' + escapeHtml(e.message) + '</div>';
        }
    }

    function closeDetail() {
        $('adminDetailMask').hidden = true;
        $('adminDetailFoot').hidden = true;
        $('adminDetailFoot').innerHTML = '';
        $('adminDetailBody').innerHTML = '';
        $('adminDetailTitle').textContent = '详情';
    }

    function askConfirm(title, message, confirmText) {
        return new Promise(function (resolve) {
            state.confirmResolve = resolve;
            $('adminConfirmTitle').textContent = title;
            $('adminConfirmText').textContent = message;
            $('adminConfirmYes').textContent = confirmText || '确认';
            $('adminConfirmMask').hidden = false;
        });
    }

    function closeConfirm(result) {
        $('adminConfirmMask').hidden = true;
        const resolve = state.confirmResolve;
        state.confirmResolve = null;
        if (resolve) resolve(!!result);
    }

    async function deletePost(id, title) {
        const ok = await askConfirm('删除帖子', '确定删除《' + (title || '无标题') + '》？帖子下所有评论也会一起删除，并写入删除快照。', '删除');
        if (!ok) return;
        try {
            await apiDelete('/api/posts/' + id);
            toast('帖子已删除', 'success');
            closeDetail();
            await Promise.all([loadStats(), loadPosts(), loadAudit()]);
        } catch (e) {
            toast(e.message || '删除失败', 'error');
        }
    }

    async function deleteUser(id, username) {
        const ok = await askConfirm('删除账号', '确定删除账号 @' + username + '？该用户的帖子、评论、私信、关注等数据会一起删除，并写入删除快照。', '删除账号');
        if (!ok) return;
        try {
            await apiDelete('/api/admin/users/' + id);
            toast('账号已删除', 'success');
            await Promise.all([loadStats(), loadUsers(), loadPosts(), loadAudit()]);
        } catch (e) {
            toast(e.message || '删除失败', 'error');
        }
    }

    async function changeRole(id, username, isAdmin) {
        const next = !isAdmin;
        const ok = await askConfirm(
            next ? '设为管理员' : '取消管理员',
            next ? '确定把 @' + username + ' 设为管理员？对方重新登录后可以进入后台。' :
                   '确定取消 @' + username + ' 的管理员权限？',
            next ? '设为管理员' : '取消管理员'
        );
        if (!ok) return;
        try {
            await apiPost('/api/admin/users/' + id + '/role', { is_admin: next });
            toast(next ? '已设为管理员' : '已取消管理员', 'success');
            await Promise.all([loadUsers(), loadStats(), loadAudit()]);
        } catch (e) {
            toast(e.message || '操作失败', 'error');
        }
    }

    async function resetPassword(id, username) {
        const ok = await askConfirm(
            '重置密码',
            '确定重置 @' + username + ' 的密码？对方所有设备的登录状态会立即失效。',
            '重置密码'
        );
        if (!ok) return;
        try {
            const data = await apiPost('/api/admin/users/' + id + '/reset-password', {});
            $('adminDetailTitle').textContent = '新的临时密码';
            $('adminDetailBody').innerHTML =
                '<p class="admin-confirm-text">请把下面的临时密码安全地发给 @' + escapeHtml(username) +
                '。关闭弹窗后将无法再次查看，对方登录后请尽快修改。</p>' +
                '<div class="admin-password-box"><code id="adminPasswordValue">' + escapeHtml(data.password) + '</code></div>' +
                '<p class="admin-item-meta">该用户所有设备已退出登录。</p>';
            $('adminDetailFoot').hidden = false;
            $('adminDetailFoot').innerHTML =
                '<button type="button" class="admin-btn primary" id="adminCopyPassword">复制密码</button>' +
                '<button type="button" class="admin-btn" data-close-detail="1">关闭</button>';
            $('adminDetailMask').hidden = false;
            $('adminCopyPassword').addEventListener('click', function () {
                copyText(data.password);
                toast('密码已复制', 'success');
            });
            $('adminDetailFoot').querySelector('[data-close-detail]').addEventListener('click', closeDetail);
            await loadAudit();
        } catch (e) {
            toast(e.message || '重置失败', 'error');
        }
    }

    function copyText(text) {
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

    function bindEvents() {
        document.querySelectorAll('[data-view]').forEach(function (btn) {
            btn.addEventListener('click', function () { switchView(this.getAttribute('data-view')); });
        });
        $('adminLogout').addEventListener('click', function () {
            Auth.logout();
            window.location.href = 'login.html';
        });
        $('adminRefresh').addEventListener('click', loadAll);
        $('adminDetailClose').addEventListener('click', closeDetail);
        $('adminDetailMask').addEventListener('click', function (e) { if (e.target === this) closeDetail(); });
        $('adminConfirmClose').addEventListener('click', function () { closeConfirm(false); });
        $('adminConfirmNo').addEventListener('click', function () { closeConfirm(false); });
        $('adminConfirmYes').addEventListener('click', function () { closeConfirm(true); });
        $('adminConfirmMask').addEventListener('click', function (e) { if (e.target === this) closeConfirm(false); });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (!$('adminConfirmMask').hidden) { closeConfirm(false); return; }
            if (!$('adminDetailMask').hidden) { closeDetail(); return; }
        });

        const searchPosts = debounce(function () {
            state.postQuery = $('adminPostSearch').value.trim();
            state.postPage = 0;
            loadPosts().catch(function (e) { toast(e.message, 'error'); });
        }, 260);
        $('adminPostSearch').addEventListener('input', searchPosts);

        $('adminPostFilter').addEventListener('click', function (e) {
            const btn = e.target.closest('[data-filter]');
            if (!btn) return;
            state.postFilter = btn.getAttribute('data-filter');
            this.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
            renderPosts();
        });
        $('adminPostPrev').addEventListener('click', function () {
            if (state.postPage <= 0) return;
            state.postPage -= 1;
            loadPosts().catch(function (e) { toast(e.message, 'error'); });
        });
        $('adminPostNext').addEventListener('click', function () {
            state.postPage += 1;
            loadPosts().catch(function (e) { toast(e.message, 'error'); });
        });
        $('adminPostList').addEventListener('click', function (e) {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = Number(btn.getAttribute('data-id'));
            const post = state.posts.filter(function (p) { return p.id === id; })[0] || {};
            if (btn.getAttribute('data-action') === 'view-post') openPostDetail(id);
            if (btn.getAttribute('data-action') === 'delete-post') deletePost(id, post.title);
            if (btn.getAttribute('data-action') === 'pin-post') pinPost(id, !(state.pins || []).some(function (x) { return x.post_id === id; }));
        });
        $('adminRecentPosts').addEventListener('click', function (e) {
            const row = e.target.closest('[data-open-post]');
            if (row) openPostDetail(Number(row.getAttribute('data-open-post')));
        });

        const searchUsers = debounce(function () {
            state.userQuery = $('adminUserSearch').value.trim();
            state.userPage = 0;
            loadUsers().catch(function (e) { toast(e.message, 'error'); });
        }, 260);
        $('adminUserSearch').addEventListener('input', searchUsers);
        $('adminUserFilter').addEventListener('click', function (e) {
            const btn = e.target.closest('[data-filter]');
            if (!btn) return;
            state.userFilter = btn.getAttribute('data-filter');
            this.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
            renderUsers();
        });
        $('adminUserPrev').addEventListener('click', function () {
            if (state.userPage <= 0) return;
            state.userPage -= 1;
            loadUsers().catch(function (e) { toast(e.message, 'error'); });
        });
        $('adminUserNext').addEventListener('click', function () {
            state.userPage += 1;
            loadUsers().catch(function (e) { toast(e.message, 'error'); });
        });
        $('adminUserList').addEventListener('click', function (e) {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = Number(btn.getAttribute('data-id'));
            const username = btn.getAttribute('data-username');
            const user = state.users.filter(function (u) { return u.id === id; })[0] || {};
            const action = btn.getAttribute('data-action');
            if (action === 'view-user') openUserDetail(username);
            if (action === 'role-user') changeRole(id, user.username, !!user.is_admin);
            if (action === 'reset-user') resetPassword(id, user.username);
            if (action === 'delete-user') deleteUser(id, user.username);
        });
        $('adminRecentUsers').addEventListener('click', function (e) {
            const row = e.target.closest('[data-open-user]');
            if (row) openUserDetail(row.getAttribute('data-open-user'));
        });

        $('adminPinList').addEventListener('click', function (e) {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const id = Number(btn.getAttribute('data-id'));
            if (btn.getAttribute('data-action') === 'view-pin') openPostDetail(id);
            if (btn.getAttribute('data-action') === 'unpin') pinPost(id, false);
        });

        $('adminAuditTabs').addEventListener('click', function (e) {
            const btn = e.target.closest('[data-audit]');
            if (!btn) return;
            state.auditTab = btn.getAttribute('data-audit');
            this.querySelectorAll('.admin-tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
            renderAudit();
        });
    }

    function init() {
        setWho();
        bindEvents();
        const hash = (window.location.hash || '').replace('#', '');
        switchView(VIEW_TITLES[hash] ? hash : 'overview', false);
        loadAll();
    }

    async function boot() {
        try {
            // 后台权限以服务端为准，避免本地缓存的 is_admin 过期
            const res = await Auth.get('/api/me');
            if (res.ok) {
                const data = await res.json();
                if (data.user) {
                    Auth.user = data.user;
                    Auth.save(Auth.token, Auth.user);
                }
            }
        } catch (e) {}
        if (!Auth.isAdmin()) {
            window.location.replace('index.html');
            return;
        }
        init();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
