// ============================================
// 帖子详情页逻辑：根据 URL 里的 id，拉单条帖子
// 后端接口：GET http://127.0.0.1:5000/api/posts/<id>
// ============================================

const API = '/api/posts';

window.addEventListener('DOMContentLoaded', fetchDetail);

async function fetchDetail() {
    const urlParams = new URLSearchParams(window.location.search);
    const postId = urlParams.get('id');

    if (!postId) {
        document.getElementById('detail-title').textContent = '帖子不存在';
        document.getElementById('detail-content').textContent = '没有找到这篇帖子的 id';
        return;
    }

    try {
        const response = await fetch(API + '/' + postId);
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const post = await response.json();
        renderDetail(post);
    } catch (error) {
        console.warn('[详情页] 拉取失败，显示占位数据：', error.message);
        renderDetail({
            title: '帖子不存在',
            content: '没有找到第 ' + postId + ' 条帖子（后端接口可能还没起）'
        });
    }
}

function renderDetail(post) {
    document.getElementById('detail-title').textContent = post.title || '无标题';
    const meta = document.getElementById('detail-meta');
    const tags = post.tags ? '[' + post.tags + '] ' : '';
    meta.textContent = tags + (post.author || '匿名') + ' · 浏览 ' + (post.views || 0) + ' · 回复 ' + (post.replies || 0) + ' · ' + (post.created_at || '');
    document.getElementById('detail-content').textContent = post.content || '暂无内容';
}
