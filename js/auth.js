// auth.js - 登录态管理（所有页面共享）
const Auth = {
    token: localStorage.getItem('ywies_token') || '',
    user: JSON.parse(localStorage.getItem('ywies_user') || 'null'),

    save(token, user) {
        this.token = token;
        this.user = user;
        localStorage.setItem('ywies_token', token);
        localStorage.setItem('ywies_user', JSON.stringify(user));
    },
    logout() {
        this.token = '';
        this.user = null;
        localStorage.removeItem('ywies_token');
        localStorage.removeItem('ywies_user');
    },
    isLoggedIn() { return !!this.token; },
    isAdmin() { return !!(this.user && this.user.is_admin); },

    async fetch(url, options = {}) {
        const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
        if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
        const res = await fetch(url, Object.assign({}, options, { headers: headers }));
        if (res.status === 401) {
            this.logout();
            window.location.href = 'login.html';
            throw new Error('未登录');
        }
        return res;
    },

    async get(url) { return this.fetch(url, { method: 'GET' }); },
    async post(url, body) { return this.fetch(url, { method: 'POST', body: JSON.stringify(body || {}) }); },
    async del(url) { return this.fetch(url, { method: 'DELETE' }); },
};
