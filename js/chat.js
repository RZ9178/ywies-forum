// ============================================
// AI 聊天窗口 - 基础交互
// 注意：真正调用后端 /chat 的逻辑等后端好了再加
// ============================================

const chatToggleBtn = document.getElementById('chatToggleBtn');
const chatPanel = document.getElementById('chatPanel');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');
const chatMessages = document.getElementById('chatMessages');

// 点右下角按钮 → 打开/关闭聊天窗口
chatToggleBtn.addEventListener('click', function() {
    chatPanel.classList.toggle('open');
});

// 点关闭按钮 → 关闭聊天窗口
function closeChat() {
    chatPanel.classList.remove('open');
}

// 点发送按钮
chatSendBtn.addEventListener('click', sendMessage);

// 按回车也能发送
chatInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    // 把用户消息显示在右边
    addMessage(text, 'user');
    chatInput.value = '';

    // TODO: 等后端好了，把下面这段假回复换成真正的 fetch 调用
    // 后端接口地址：POST /chat
    // 发出去的格式（找后端组确认）：{"message": "...", "role": "study"}
    // 返回的格式（找后端组确认）：{"reply": "..."}
    setTimeout(function() {
        addMessage('（AI回复即将接入，等后端组做好接口就能用了）', 'ai');
    }, 500);
}

// 往聊天框里加一条消息
function addMessage(text, type) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'chat-msg ' + type;
    msgDiv.innerHTML = '<div class="bubble"></div>';
    msgDiv.querySelector('.bubble').textContent = text;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}
