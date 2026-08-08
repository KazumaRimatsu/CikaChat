/* KnockChat 主题系统 v1.1
 *
 * 模块化主题状态管理，按职责分离：
 *   1) 主题配置（config）：内置主题定义、主题文件校验规则、变量命名空间白名单
 *   2) 状态管理（state）：当前激活主题、已导入的自定义主题列表（内存态）
 *   3) 持久化（persist）：localStorage 读写，程序重启后自动恢复上次使用的主题
 *   4) 样式注入（inject）：将主题变量写入 <style> 并挂载到 <html>，实时切换无需刷新
 *
 * 使用方式：
 *   ThemeManager.init()                  启动时恢复上次使用的主题（脚本加载时自动执行）
 *   ThemeManager.list()                  获取全部主题（内置 + 自定义，含预览色）
 *   ThemeManager.getTheme(id)            按 id 获取主题
 *   ThemeManager.activate(id)            应用并持久化（正式生效）
 *   ThemeManager.preview(id)             应用但不持久化（预览，用于切换前查看效果）
 *   ThemeManager.removeTheme(id)         删除已导入的自定义主题
 *   ThemeManager.importTheme(obj)        校验并导入主题配置，返回 {ok,theme} 或 {ok:false,error}
 *   ThemeManager.importThemeFromFile(f)  从本地 JSON 文件导入主题（Promise）
 *   ThemeManager.buildThemeFileSample()  生成主题文件样板（可下载为模板）
 *   ThemeManager.onChange = fn           主题正式生效/删除后回调（用于同步设置页 UI）
 *
 * 主题文件格式、完整变量清单与扩展规范见 docs/theme-guide.md 与 themes/sample.theme.json
 */
(function (global) {
    'use strict';

    // ============================================================
    // 常量与白名单
    // ============================================================
    var STORAGE_KEY = LS_KEYS.THEME_STORE;
    var STYLE_ID = 'cika-custom-theme-style';
    var THEME_TYPE = '#theme#';
    var APP_TAG = 'com.cika.chatapp';
    var SCHEMA_VERSION = 1;
    var MAX_CUSTOM_THEMES = 64;
    var MAX_VARIABLES = 128;
    var MAX_VAR_VALUE_LEN = 256;
    var MAX_FILE_SIZE = 512 * 1024; // 512KB

    // 主题变量命名空间白名单：自定义主题允许覆盖的 CSS 变量前缀。
    // 后续新增 CSS 变量时，只要遵循以下前缀即可被主题扩展识别，无需改动本文件。
    var VAR_PREFIXES = ['--md-', '--font-', '--space-', '--radius-', '--shadow-'];

    // 内置主题：id 与 <html data-theme="..."> 一一对应
    var BUILTIN_THEMES = [
        { id: 'dark',  name: '暗黑模式', base: 'dark',  builtin: true, description: '默认暗色主题' },
        { id: 'light', name: '明亮模式', base: 'light', builtin: true, description: '默认亮色主题' }
    ];

    // 内置主题预览色（未自定义时用于设置页卡片缩略图）
    var BUILTIN_PREVIEW = {
        dark:  { background: '#1A1C1E', surface: '#262A2C', primary: '#A0CAFD', onSurface: '#E2E2E5' },
        light: { background: '#FDFCFF', surface: '#EDEEF1', primary: '#1976D2', onSurface: '#1A1C1E' }
    };

    // ============================================================
    // 状态
    // ============================================================
    var state = { version: SCHEMA_VERSION, activeThemeId: 'dark', themes: [] };
    var styleEl = null;

    // ============================================================
    // 工具函数
    // ============================================================
    function storage() {
        try { return global.localStorage; } catch (e) { return null; }
    }

    function safeParse(text) {
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    function findTheme(id) {
        if (!id) return null;
        for (var i = 0; i < BUILTIN_THEMES.length; i++) {
            if (BUILTIN_THEMES[i].id === id) return BUILTIN_THEMES[i];
        }
        for (var j = 0; j < state.themes.length; j++) {
            if (state.themes[j].id === id) return state.themes[j];
        }
        return null;
    }

    function isBuiltin(id) {
        for (var i = 0; i < BUILTIN_THEMES.length; i++) {
            if (BUILTIN_THEMES[i].id === id) return true;
        }
        return false;
    }

    // 主题卡片数据：附加预览色（未定义的变量回退到 base 内置主题的默认值）
    function withPreview(theme) {
        var base = BUILTIN_PREVIEW[theme.base] || BUILTIN_PREVIEW.dark;
        var v = theme.variables || {};
        return {
            id: theme.id,
            name: theme.name,
            builtin: !!theme.builtin,
            base: theme.base,
            description: theme.description || '',
            preview: {
                background: v['--md-background'] || base.background,
                surface: v['--md-surface'] || base.surface,
                primary: v['--md-primary'] || base.primary,
                onSurface: v['--md-on-surface'] || base.onSurface
            }
        };
    }

    // ============================================================
    // 持久化：localStorage
    // ============================================================
    function loadState() {
        var s = storage();
        if (!s) return;
        try {
            var raw = s.getItem(STORAGE_KEY);
            if (!raw) return;
            var data = safeParse(raw);
            if (!data || typeof data !== 'object') return;
            if (Array.isArray(data.themes)) {
                state.themes = [];
                for (var i = 0; i < data.themes.length; i++) {
                    var t = normalizeTheme(data.themes[i]);
                    if (t && !isBuiltin(t.id)) state.themes.push(t);
                }
            }
            if (typeof data.activeThemeId === 'string' && findTheme(data.activeThemeId)) {
                state.activeThemeId = data.activeThemeId;
            }
        } catch (e) { /* 数据损坏时保持默认 */ }
    }

    function saveState() {
        var s = storage();
        if (!s) return;
        try {
            s.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (e) { /* 存储不可用时静默 */ }
    }

    // ============================================================
    // 主题配置校验与规范化
    // ============================================================
    function isValidVarKey(key) {
        if (typeof key !== 'string' || !key) return false;
        for (var i = 0; i < VAR_PREFIXES.length; i++) {
            if (key.indexOf(VAR_PREFIXES[i]) === 0) return true;
        }
        return false;
    }

    function normalizeVariables(vars) {
        var keys = Object.keys(vars);
        if (keys.length === 0 || keys.length > MAX_VARIABLES) return null;
        var out = {};
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (!isValidVarKey(k)) return null;
            var v = vars[k];
            if (typeof v !== 'string' || !v || v.length > MAX_VAR_VALUE_LEN) return null;
            out[k] = v;
        }
        return out;
    }

    function normalizeTheme(raw) {
        if (!raw || typeof raw !== 'object') return null;
        if (raw.type !== THEME_TYPE) return null;
        if (typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.id)) return null;
        if (typeof raw.name !== 'string' || !raw.name || raw.name.length > 40) return null;
        if (raw.base !== 'dark' && raw.base !== 'light') return null;
        if (!raw.variables || typeof raw.variables !== 'object') return null;
        var vars = normalizeVariables(raw.variables);
        if (!vars) return null;
        return {
            type: THEME_TYPE,
            app: raw.app || APP_TAG,
            version: raw.version || SCHEMA_VERSION,
            id: raw.id,
            name: raw.name,
            base: raw.base,
            description: (typeof raw.description === 'string') ? raw.description.slice(0, 120) : '',
            variables: vars
        };
    }

    // ============================================================
    // 样式注入：生成/更新 <style>，实时切换无需刷新
    // ============================================================
    function ensureStyleEl() {
        if (styleEl) return styleEl;
        try {
            styleEl = document.createElement('style');
            styleEl.id = STYLE_ID;
            (document.head || document.documentElement).appendChild(styleEl);
        } catch (e) {
            styleEl = null;
        }
        return styleEl;
    }

    // 自定义主题只注入“增量变量”：未覆盖的变量继承 base 内置主题（data-theme）的值
    function buildCss(theme) {
        var lines = ['html[data-custom-theme] {'];
        var keys = Object.keys(theme.variables);
        for (var i = 0; i < keys.length; i++) {
            lines.push('  ' + keys[i] + ': ' + theme.variables[keys[i]] + ';');
        }
        lines.push('}');
        return lines.join('\n');
    }

    // commit=true 表示正式生效（持久化 + 回调）；false 表示预览
    function applyTheme(theme, commit) {
        if (!theme) return false;
        var isCustom = !theme.builtin;
        try {
            var root = document.documentElement;
            if (isCustom) {
                // :root 默认为 light，仅 base='dark' 时需设置 data-theme
                if (theme.base === 'dark') {
                    root.setAttribute('data-theme', 'dark');
                } else {
                    root.removeAttribute('data-theme');
                }
                root.setAttribute('data-custom-theme', theme.id);
                var el = ensureStyleEl();
                if (el) el.textContent = buildCss(theme);
            } else {
                // 内置主题：:root 默认 light，dark 需显式设置
                if (theme.id === 'dark') {
                    root.setAttribute('data-theme', 'dark');
                } else {
                    root.removeAttribute('data-theme');
                }
                root.removeAttribute('data-custom-theme');
                if (styleEl) styleEl.textContent = '';
            }
        } catch (e) {
            return false;
        }
        if (commit) {
            state.activeThemeId = theme.id;
            saveState();
            notify();
        }
        return true;
    }

    function notify() {
        if (typeof api.onChange === 'function') {
            try { api.onChange(); } catch (e) { /* 回调异常不影响主题切换 */ }
        }
    }

    // ============================================================
    // 对外 API
    // ============================================================
    var api = {
        STORAGE_KEY: STORAGE_KEY,
        THEME_TYPE: THEME_TYPE,
        BUILTIN_IDS: ['dark', 'light'],

        // 启动恢复：从 localStorage 读取并应用上次使用的主题
        init: function () {
            loadState();
            applyTheme(findTheme(state.activeThemeId) || findTheme('dark'), false);
            notify();
        },

        // 全部主题（内置 + 自定义），带预览色
        list: function () {
            var out = [];
            for (var i = 0; i < BUILTIN_THEMES.length; i++) {
                var b = BUILTIN_THEMES[i];
                out.push(withPreview({
                    id: b.id, name: b.name, base: b.base, builtin: true, description: b.description
                }));
            }
            for (var j = 0; j < state.themes.length; j++) {
                out.push(withPreview(state.themes[j]));
            }
            return out;
        },

        getTheme: function (id) { return findTheme(id); },

        getActiveThemeId: function () { return state.activeThemeId; },

        // 是否处于自定义主题（自定义主题生效时，内置明亮/暗黑切换失效）
        isCustomThemeActive: function () {
            try { return document.documentElement.hasAttribute('data-custom-theme'); } catch (e) { return false; }
        },

        // 应用并持久化（正式生效）；id 无效时回退暗黑模式
        activate: function (id) {
            var theme = findTheme(id) || findTheme('dark');
            return applyTheme(theme, true);
        },

        // 应用但不持久化（预览）
        preview: function (id) {
            var theme = findTheme(id);
            if (!theme) return false;
            return applyTheme(theme, false);
        },

        // 校验并导入主题配置；id 冲突时自动追加后缀
        importTheme: function (raw) {
            var theme = normalizeTheme(raw);
            if (!theme) {
                return { ok: false, error: '主题文件格式不正确' };
            }
            if (isBuiltin(theme.id)) {
                return { ok: false, error: '主题 id 与内置主题冲突：' + theme.id };
            }
            var finalId = theme.id;
            var n = 2;
            while (findTheme(finalId)) {
                finalId = theme.id + '-' + n;
                n++;
            }
            if (n > 2) theme.id = finalId;
            if (state.themes.length >= MAX_CUSTOM_THEMES) {
                return { ok: false, error: '自定义主题数量已达上限（' + MAX_CUSTOM_THEMES + '）' };
            }
            state.themes.push(theme);
            saveState();
            return { ok: true, theme: withPreview(theme) };
        },

        // 从本地 JSON 文件导入主题
        importThemeFromFile: function (file) {
            return new Promise(function (resolve) {
                if (!file) { resolve({ ok: false, error: '未选择文件' }); return; }
                if (file.size > MAX_FILE_SIZE) {
                    resolve({ ok: false, error: '主题文件超过大小限制（512KB）' });
                    return;
                }
                var reader = new FileReader();
                reader.onload = function () {
                    var data = safeParse(String(reader.result || ''));
                    if (!data) {
                        resolve({ ok: false, error: '主题文件解析失败：不是有效的 JSON' });
                        return;
                    }
                    resolve(api.importTheme(data));
                };
                reader.onerror = function () {
                    resolve({ ok: false, error: '主题文件读取失败' });
                };
                reader.readAsText(file);
            });
        },

        // 删除自定义主题；若删除的是当前主题则回退到暗黑模式
        removeTheme: function (id) {
            if (isBuiltin(id)) return false;
            var idx = -1;
            for (var i = 0; i < state.themes.length; i++) {
                if (state.themes[i].id === id) { idx = i; break; }
            }
            if (idx < 0) return false;
            state.themes.splice(idx, 1);
            saveState();
            if (state.activeThemeId === id) {
                applyTheme(findTheme('dark'), true);
            }
            return true;
        },

        // 生成主题文件样板（新主题可基于此模板修改）
        buildThemeFileSample: function () {
            return {
                type: THEME_TYPE,
                app: APP_TAG,
                version: SCHEMA_VERSION,
                id: 'my-theme',
                name: '我的主题',
                base: 'dark',
                description: '基于暗黑模式的自定义主题示例',
                variables: {
                    '--md-primary': '#A0CAFD',
                    '--md-primary-container': 'rgba(160, 202, 253, 0.12)',
                    '--md-on-primary': '#003258',
                    '--md-background': '#1A1C1E',
                    '--md-surface': '#262A2C',
                    '--md-surface-container': '#2B2F31',
                    '--md-surface-container-high': '#35393B',
                    '--md-on-background': '#E2E2E5',
                    '--md-on-surface': '#E2E2E5',
                    '--md-on-surface-variant': 'rgba(226, 226, 229, 0.70)',
                    '--md-outline': 'rgba(226, 226, 229, 0.30)',
                    '--md-error': '#FFB4AB',
                    '--md-success': '#81C784',
                    '--md-link': '#A0CAFD'
                }
            };
        },

        onChange: null
    };

    global.ThemeManager = api;

    // 自动初始化：脚本位于 body 尾部，DOM 已就绪，直接恢复上次使用的主题
    try {
        api.init();
    } catch (e) {
        // 初始化失败时保持默认暗黑，不影响其他功能
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
