(function () {
    var params = new URLSearchParams(window.location.search);
    var name = params.get('font');
    if (!name) return;

    var SYSTEM = '"InterKnot Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
    var fonts = {
        system: { label: '系统默认', stack: SYSTEM },
        misans: {
            label: 'MiSans',
            css: 'https://cdn.jsdelivr.net/npm/misans@5.0.0/lib/Normal/MiSansVF.min.css',
            stack: '"MiSans VF", "MiSans", ' + SYSTEM
        },
        harmony: {
            label: 'HarmonyOS Sans',
            css: 'https://cdn.jsdelivr.net/npm/@1adybug/harmonyos-sans@0.1.1/index.css',
            stack: '"HarmonyOS Sans", ' + SYSTEM
        },
        wenkai: {
            label: '霞鹜文楷',
            css: 'https://cdn.jsdelivr.net/npm/@hanzi.pro/webfonts-lxgw-wenkai@0.1.0/swap.css',
            stack: '"LXGW WenKai", ' + SYSTEM
        }
    };
    var conf = fonts[name];
    if (!conf) return;

    if (conf.css) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = conf.css;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
    }
    document.documentElement.style.setProperty('--font-sans', conf.stack);
    document.documentElement.setAttribute('data-font-preview', name);

    var badge = document.createElement('div');
    badge.className = 'font-preview-badge';
    var label = document.createElement('span');
    label.textContent = '字体预览';
    var select = document.createElement('select');
    select.setAttribute('aria-label', '切换预览字体');
    Object.keys(fonts).forEach(function (key) {
        var opt = document.createElement('option');
        opt.value = key;
        opt.textContent = fonts[key].label;
        if (key === name) opt.selected = true;
        select.appendChild(opt);
    });
    select.addEventListener('change', function () {
        var url = new URL(window.location.href);
        url.searchParams.set('font', select.value);
        window.location.href = url.toString();
    });
    badge.appendChild(label);
    badge.appendChild(select);
    document.body.appendChild(badge);
})();
