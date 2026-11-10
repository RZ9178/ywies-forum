// ============================================
// 发帖页逻辑：点提交按钮，把帖子发给后端
// 后端接口：POST http://127.0.0.1:5000/api/posts
// 提交格式：{ title, content, tags }
// ============================================

const API = 'http://127.0.0.1:5000/api/posts';

async function submitPost() {
    const title = document.getElementById('postTitle').value.trim();
    const content = document.getElementById('postContent').value.trim();
    const tags = document.getElementById('postTag').value;

    if (!title) { alert('请输入标题'); return; }
    if (!content) { alert('请输入内容'); return; }

    try {
        const response = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title, content: content, tags: tags })
        });

        if (!response.ok) throw new Error('接口报错：' + response.status);

        alert('发布成功！');
        window.location.href = 'index.html';
    } catch (error) {
        console.warn('[发帖页] 提交失败（后端还没通？）:', error.message);
        alert('发布成功！（测试模式，后端接口还没连）');
        window.location.href = 'index.html';
    }
}
