// ============================================
// 中英切换：只翻译界面，不翻译帖子/评论正文
// ============================================
(function () {
    var DICT = {
        pageTitle: { zh: 'YWIES 论坛', en: 'YWIES Forum' },
        loginPageTitle: { zh: '登录 - YWIES 论坛', en: 'Log in - YWIES Forum' },
        registerPageTitle: { zh: '注册 - YWIES 论坛', en: 'Sign up - YWIES Forum' },
        appName: { zh: 'YWIES 论坛', en: 'YWIES Forum' },
        searchPlaceholder: { zh: '搜索帖子...', en: 'Search posts...' },
        notificationsTitle: { zh: '通知', en: 'Notifications' },
        notificationsCenter: { zh: '通知中心', en: 'Notifications' },
        messagesTitle: { zh: '消息', en: 'Messages' },
        myProfile: { zh: '我的', en: 'My profile' },
        newPost: { zh: '发布', en: 'Publish' },
        login: { zh: '登录', en: 'Log in' },
        register: { zh: '注册', en: 'Sign up' },
        admin: { zh: '后台', en: 'Admin' },
        logout: { zh: '退出', en: 'Log out' },
        languageToggle: { zh: '切换语言', en: 'Switch language' },

        tabLatest: { zh: '最新', en: 'Latest' },
        tabHot: { zh: '热门', en: 'Hot' },
        tabUnread: { zh: '未看', en: 'Unread' },
        tabFollowed: { zh: '关注', en: 'Following' },
        tabBookmarked: { zh: '收藏', en: 'Saved' },
        tabAll: { zh: '全部', en: 'All' },
        all: { zh: '全部', en: 'All' },

        listTitle: { zh: '标题', en: 'Title' },
        listAuthor: { zh: '作者', en: 'Author' },
        listReplies: { zh: '回复', en: 'Replies' },
        listViews: { zh: '浏览', en: 'Views' },
        listTime: { zh: '最后回复', en: 'Last reply' },

        emptyPosts: { zh: '这里还没有帖子，点右上角「发帖」发第一条吧', en: 'No posts yet. Click “New Post” in the top right to start.' },
        emptyFiltered: { zh: '没有找到符合条件的帖子', en: 'No posts match your filters.' },
        loadingPosts: { zh: '帖子加载中...', en: 'Loading posts...' },
        loadFailedRetry: { zh: '帖子加载失败，点这里重试', en: 'Failed to load posts. Click to retry.' },
        anonymous: { zh: '匿名', en: 'Anonymous' },
        untitled: { zh: '无标题', en: 'Untitled' },
        tooltipLike: { zh: '点赞', en: 'Likes' },
        tooltipViews: { zh: '浏览', en: 'Views' },
        tooltipReplies: { zh: '回复', en: 'Replies' },
        tooltipUnread: { zh: '未读', en: 'Unread' },
        profileView: { zh: '查看我的主页', en: 'View my profile' },

        notifLogin: { zh: '请先登录再查看通知', en: 'Please log in to view notifications.' },
        notifLoading: { zh: '加载中...', en: 'Loading...' },
        notifFailed: { zh: '通知加载失败', en: 'Failed to load notifications.' },
        notifEmpty: { zh: '暂无通知', en: 'No notifications yet.' },

        profileTitle: { zh: '用户主页', en: 'Profile' },
        profileLoading: { zh: '加载中...', en: 'Loading...' },
        profileFailed: { zh: '用户主页加载失败', en: 'Failed to load profile.' },
        profileAdmin: { zh: '管理员', en: 'Admin' },
        profileMessage: { zh: '私信', en: 'Message' },
        profilePostsJoined: { zh: '{n} 帖 · 加入于 {date}', en: '{n} posts · Joined {date}' },
        profileNoPosts: { zh: '还没有发过帖子', en: 'No posts yet.' },
        profileRecent: { zh: '最近发帖', en: 'Recent posts' },
        profileUnknown: { zh: '未知用户', en: 'Unknown user' },

        msgLoading: { zh: '加载中...', en: 'Loading...' },
        msgFailed: { zh: '私信加载失败', en: 'Failed to load messages.' },
        msgEmpty: { zh: '还没有私信。点开别人的主页，发第一条吧。', en: 'No messages yet. Open someone’s profile and say hi.' },
        msgWith: { zh: '与 {name} 的私信', en: 'Messages with {name}' },
        msgBack: { zh: '‹ 返回私信列表', en: '‹ Back to messages' },
        msgThreadEmpty: { zh: '还没有消息，打个招呼吧。', en: 'No messages yet. Say hi!' },
        msgPlaceholder: { zh: '输入私信...', en: 'Type a message...' },
        send: { zh: '发送', en: 'Send' },

        postModalTitle: { zh: '发布新帖子', en: 'New Post' },
        postAuthorLabel: { zh: '发布身份', en: 'Posting as' },
        postAuthorTitle: { zh: '以当前登录账号发布', en: 'Posting with your account' },
        postTitleLabel: { zh: '标题', en: 'Title' },
        postTitlePlaceholder: { zh: '给帖子起个标题...', en: 'Give your post a title...' },
        postContentLabel: { zh: '正文', en: 'Content' },
        postContentPlaceholder: { zh: '想说点什么...', en: 'What’s on your mind...' },
        postImageLabel: { zh: '图片（可选，单张 ≤10MB）', en: 'Images (optional, max 10MB each)' },
        postImageLabelLevel: { zh: '图片（可选，Lv.{level} 最多 {n} 张，单张 ≤10MB）', en: 'Images (optional, Lv.{level} up to {n}, max 10MB each)' },
        postUploadPlaceholder: { zh: '点击或拖拽上传图片（自动压缩）', en: 'Click or drag to upload (auto-compressed)' },
        postImageNotConfigured: { zh: '图片上传暂未配置，可先发纯文字', en: 'Image upload isn’t configured. You can post text only.' },
        postTagsLabel: { zh: '标签', en: 'Tags' },
        postNewTagPlaceholder: { zh: '输入新标签，回车添加', en: 'Type a new tag and press Enter' },
        postNoTags: { zh: '暂无标签，在下方输入框输入新标签', en: 'No tags yet. Add one below.' },
        postSubmit: { zh: '发布帖子', en: 'Publish' },
        postPublishing: { zh: '发布中...', en: 'Publishing...' },

        detailClose: { zh: '关闭', en: 'Close' },
        comments: { zh: '评论', en: 'Comments' },
        sortEarliest: { zh: '最早', en: 'Earliest' },
        sortLatest: { zh: '最新', en: 'Latest' },
        replying: { zh: '正在回复', en: 'Replying to' },
        cancel: { zh: '取消', en: 'Cancel' },
        commentAsTitle: { zh: '以当前登录账号评论', en: 'Commenting with your account' },
        commentPlaceholder: { zh: '说点什么...', en: 'Say something...' },
        like: { zh: '点赞', en: 'Like' },
        coin: { zh: '硬币', en: 'Coin' },
        bookmark: { zh: '收藏', en: 'Save' },
        more: { zh: '更多', en: 'More' },
        delete: { zh: '删除', en: 'Delete' },
        report: { zh: '举报', en: 'Report' },
        prevImage: { zh: '上一张', en: 'Previous' },
        nextImage: { zh: '下一张', en: 'Next' },
        downloadImage: { zh: '下载图片', en: 'Download image' },
        imageAlt: { zh: '帖子图片', en: 'Post image' },
        remove: { zh: '移除', en: 'Remove' },
        imageNumber: { zh: '第 {n} 张', en: 'Image {n}' },

        commentsEmpty: { zh: '还没有评论，来说点什么吧', en: 'No comments yet. Be the first!' },
        op: { zh: '楼主', en: 'OP' },
        reply: { zh: '回复', en: 'Reply' },
        deleteShort: { zh: '删', en: 'Del' },
        replyTo: { zh: '回复 @{name}', en: 'Reply to @{name}' },
        showMoreReplies: { zh: '展开其余 {n} 条回复', en: 'Show {n} more replies' },
        collapseReplies: { zh: '收起回复', en: 'Hide replies' },
        deleteCommentConfirm: { zh: '删除这条评论？', en: 'Delete this comment?' },
        deleteCommentRepliesConfirm: { zh: '删除这条评论？其下 {n} 条回复也会一起删除', en: 'Delete this comment and its {n} replies?' },
        reportSoon: { zh: '举报功能还在开发中，之后开放', en: 'Reporting is coming soon.' },
        deletePostConfirm: { zh: '确定删除这条帖子？', en: 'Delete this post?' },

        loginToLike: { zh: '请先登录再点赞', en: 'Please log in to like posts.' },
        loginToCoin: { zh: '请先登录再投硬币', en: 'Please log in to give coins.' },
        loginToPost: { zh: '请先登录再发帖', en: 'Please log in to post.' },
        loginToComment: { zh: '请先登录再评论', en: 'Please log in to comment.' },
        loginToReply: { zh: '请先登录再回复', en: 'Please log in to reply.' },
        loginToNotifs: { zh: '请先登录再查看通知', en: 'Please log in to view notifications.' },
        loginToMessages: { zh: '请先登录再查看私信', en: 'Please log in to view messages.' },
        coinModalTitle: { zh: '投币', en: 'Give coins' },
        coinChoose: { zh: '选择投币数量', en: 'Choose how many coins' },
        coinOne: { zh: '1 币', en: '1 coin' },
        coinTwo: { zh: '2 币', en: '2 coins' },
        coinOwn: { zh: '不能给自己的帖子投币', en: 'You can’t coin your own post.' },
        coinBalanceTitle: { zh: '硬币余额', en: 'Coin balance' },
        coinNotEnough: { zh: '硬币不足', en: 'Not enough coins.' },
        coinTitle: { zh: '硬币', en: 'Coin' },
        coinedTitle: { zh: '已投币', en: 'Coined' },
        likeFailed: { zh: '点赞失败', en: 'Failed to like.' },
        coinFailed: { zh: '投币失败', en: 'Failed to give coin.' },
        commentFailed: { zh: '评论失败', en: 'Failed to comment.' },
        deleteFailed: { zh: '删除失败', en: 'Failed to delete.' },
        sendFailed: { zh: '发送失败', en: 'Failed to send.' },
        enterTitle: { zh: '请输入标题', en: 'Please enter a title.' },
        enterContent: { zh: '请输入内容', en: 'Please enter some content.' },
        uploadPending: { zh: '图片还在上传，请稍候', en: 'Images are still uploading. Please wait.' },
        maxImages: { zh: '最多上传 {n} 张图片', en: 'You can upload up to {n} images.' },
        maxImagesIgnored: { zh: '最多上传 {n} 张，已忽略多出的 {extra} 张', en: 'Up to {n} images; ignored {extra} extra.' },
        imageOnly: { zh: '请上传图片文件', en: 'Please upload image files.' },
        imageTooLarge: { zh: '图片不能超过 10MB：{name}', en: 'Images must be under 10MB: {name}' },
        uploadFailed: { zh: '图片上传失败：{error}', en: 'Image upload failed: {error}' },
        publishFailed: { zh: '发布失败：{error}', en: 'Failed to publish: {error}' },
        uploadProcessing: { zh: '正在处理第 {i} / {n} 张...', en: 'Processing {i} / {n}...' },
        uploadUploading: { zh: '正在上传第 {i} / {n} 张...', en: 'Uploading {i} / {n}...' },
        uploadedCount: { zh: '已上传 {i} / {n} 张', en: 'Uploaded {i} / {n}' },
        fillBoth: { zh: '请填昵称和密码', en: 'Please enter your nickname and password.' },
        loginFailed: { zh: '登录失败', en: 'Log in failed.' },
        registerFailed: { zh: '注册失败', en: 'Sign up failed.' },

        timeJustNow: { zh: '刚刚', en: 'Just now' },
        timeMinutes: { zh: '{n} 分钟前', en: '{n} min ago' },
        timeHours: { zh: '{n} 小时前', en: '{n} hr ago' },
        timeYesterday: { zh: '昨天', en: 'Yesterday' },
        timeDays: { zh: '{n} 天前', en: '{n} days ago' },

        chatTitle: { zh: '耀耀', en: 'Yao Yao' },
        chatWelcome: { zh: '你好！我是耀耀，有什么可以帮你的？', en: 'Hi! I’m Yao Yao. How can I help?' },
        chatPlaceholder: { zh: '输入消息...', en: 'Type a message...' },
        chatSend: { zh: '发送', en: 'Send' },
        chatOpen: { zh: '和耀耀聊天', en: 'Chat with Yao Yao' },
        chatSoon: { zh: '（AI回复即将接入，等后端组做好接口就能用了）', en: '(AI replies are coming soon — we’re still wiring up the backend.)' },
        refreshTitle: { zh: '刷新帖子', en: 'Refresh posts' },

        authLoginTitle: { zh: '登录', en: 'Log in' },
        authRegisterTitle: { zh: '注册新账号', en: 'Create an account' },
        nickname: { zh: '昵称', en: 'Nickname' },
        nicknamePlaceholder: { zh: '你的昵称', en: 'Your nickname' },
        password: { zh: '密码', en: 'Password' },
        passwordPlaceholder: { zh: '密码', en: 'Password' },
        passwordMinLabel: { zh: '密码（至少 6 位）', en: 'Password (at least 6 characters)' },
        loginButton: { zh: '登录', en: 'Log in' },
        registerButton: { zh: '注册', en: 'Sign up' },
        noAccount: { zh: '还没有账号？', en: 'No account yet?' },
        signUpLink: { zh: '注册一个', en: 'Sign up' },
        haveAccount: { zh: '已有账号？', en: 'Already have an account?' },
        loginLink: { zh: '直接登录', en: 'Log in' },
        regNamePlaceholder: { zh: '给自己起个昵称', en: 'Choose a nickname' },
        regPasswordPlaceholder: { zh: '设置密码', en: 'Set a password' }
    };

    var lang = 'zh';
    try { lang = localStorage.getItem('ywies_lang') === 'en' ? 'en' : 'zh'; } catch (e) {}

    function t(key, vars) {
        var entry = DICT[key];
        var text = entry ? (entry[lang] || entry.zh) : key;
        if (vars) {
            Object.keys(vars).forEach(function (k) {
                text = text.split('{' + k + '}').join(String(vars[k]));
            });
        }
        return text;
    }

    function updateToggles() {
        document.querySelectorAll('.js-lang-toggle').forEach(function (btn) {
            btn.textContent = lang === 'zh' ? 'EN' : '中';
            btn.title = t('languageToggle');
            btn.setAttribute('aria-label', t('languageToggle'));
        });
    }

    function apply(root) {
        root = root || document;
        root.querySelectorAll('[data-i18n]').forEach(function (el) {
            var key = el.getAttribute('data-i18n');
            if (DICT[key]) el.textContent = t(key);
        });
        root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
            var key = el.getAttribute('data-i18n-placeholder');
            if (DICT[key]) el.placeholder = t(key);
        });
        root.querySelectorAll('[data-i18n-title]').forEach(function (el) {
            var key = el.getAttribute('data-i18n-title');
            if (DICT[key]) el.title = t(key);
        });
        root.querySelectorAll('[data-i18n-aria]').forEach(function (el) {
            var key = el.getAttribute('data-i18n-aria');
            if (DICT[key]) el.setAttribute('aria-label', t(key));
        });
        document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
        if (document.body) document.body.classList.toggle('lang-en', lang === 'en');
        var headerLang = document.getElementById('langBtn');
        if (headerLang) headerLang.setAttribute('data-lang', lang);
        var pageKey = document.body && document.body.getAttribute('data-page-title');
        document.title = t(pageKey || 'pageTitle');
        updateToggles();
    }

    function setLang(next) {
        lang = next === 'en' ? 'en' : 'zh';
        try { localStorage.setItem('ywies_lang', lang); } catch (e) {}
        apply();
        document.dispatchEvent(new CustomEvent('i18n:change', { detail: { lang: lang } }));
    }

    function toggle() { setLang(lang === 'zh' ? 'en' : 'zh'); }

    document.querySelectorAll('.js-lang-toggle').forEach(function (btn) {
        btn.addEventListener('click', toggle);
    });
    var headerLang = document.getElementById('langBtn');
    if (headerLang) headerLang.addEventListener('click', toggle);
    apply();
    window.I18n = {
        t: t,
        apply: apply,
        setLang: setLang,
        toggle: toggle,
        get lang() { return lang; },
        dict: DICT
    };
})();
