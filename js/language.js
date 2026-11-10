// ============================================
// 中英语言切换
// ============================================

// 语言字典：key是data-i18n的值，value是{中文, 英文}
const i18n = {
    appName: {
        zh: 'YWIES论坛',
        en: 'YWIES Forum'
    },
    newPost: {
        zh: '发帖',
        en: 'New Post'
    },
    backHome: {
        zh: '返回首页',
        en: 'Back'
    },
    langBtn: {
        zh: 'EN/中',
        en: '中/EN'
    },
    welcomePostTitle: {
        zh: '欢迎来到YWIES论坛',
        en: 'Welcome to YWIES Forum'
    },
    welcomePostContent: {
        zh: '这里是我们学校自己的校园论坛，大家可以在这里发帖交流。\n\nAI聊天助手也已经上线，右下角就能找到。',
        en: 'This is our school\'s own campus forum. You can post and communicate here.\n\nThe AI chat assistant is also online. Find it in the bottom right corner.'
    },
    welcomePostContentShort: {
        zh: '这里是我们学校自己的校园论坛，大家可以在这里发帖交流。',
        en: 'This is our school\'s own campus forum. You can post and communicate here.'
    },
    devLogShort: {
        zh: '1.0版本 · 功能持续完善中',
        en: 'Version 1.0 · Features improving'
    },
    devLogTitle: {
        zh: '开发进度日志',
        en: 'Development Log'
    },
    devLogContent: {
        zh: '目前是1.0开发版本，功能持续完善中。\n\n10月26日：完成首页页面和基础样式\n10月27日：完成发帖页、帖子详情页、AI聊天窗口界面',
        en: 'Currently at version 1.0. Features are being continuously improved.\n\nOct 26: Completed homepage and basic styles\nOct 27: Completed new post page, post detail page, AI chat window UI'
    },
    postPageTitle: {
        zh: '发布新帖子',
        en: 'Create New Post'
    },
    titleLabel: {
        zh: '标题',
        en: 'Title'
    },
    titlePlaceholder: {
        zh: '给帖子起个标题...',
        en: 'Give your post a title...'
    },
    contentLabel: {
        zh: '内容',
        en: 'Content'
    },
    contentPlaceholder: {
        zh: '想说点什么...',
        en: 'What do you want to say...'
    },
    submitBtn: {
        zh: '发布帖子',
        en: 'Publish'
    },
    chatTitle: {
        zh: '耀耀',
        en: 'Yao Yao'
    },
    chatWelcome: {
        zh: '你好！我是耀耀，有什么可以帮你的？',
        en: 'Hi! I am Yao Yao. How can I help you?'
    },
    chatPlaceholder: {
        zh: '输入消息...',
        en: 'Type a message...'
    },
    sendBtn: {
        zh: '发送',
        en: 'Send'
    }
};

// 当前语言，默认中文
let currentLang = 'zh';

// 切换语言
function toggleLang() {
    currentLang = currentLang === 'zh' ? 'en' : 'zh';
    applyLanguage();
}

// 应用语言到页面上所有带 data-i18n 的元素
function applyLanguage() {
    // 遍历所有带 data-i18n 属性的元素
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
        const key = el.getAttribute('data-i18n');
        if (i18n[key]) {
            el.textContent = i18n[key][currentLang];
        }
    });

    // 单独处理输入框的 placeholder
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
        const key = el.getAttribute('data-i18n-placeholder');
        if (i18n[key]) {
            el.placeholder = i18n[key][currentLang];
        }
    });
}
