/* CikaChat 应用字体设置 v1.0
 *
 * 应用级字体选择，与主题系统完全解耦（「不向自定义主题开放」）：
 *   1) 生效方式：在 <html> 内联样式写入 --app-font-family。
 *      --app-* 命名空间不在主题白名单（--md- / --font- / --space- / --radius- / --shadow-）内，
 *      因此自定义主题文件永远无法覆盖用户选择的字体；body 通过
 *      font-family: var(--app-font-family, var(--md-font-family)) 层叠引用。
 *   2) 「系统默认」不写入变量：回退到 --md-font-family（跟随主题/系统字体）。
 *   3) 仅本地持久化（localStorage），不随用户设置同步到服务端。
 *
 * 使用方式：
 *   FontManager.init()                  启动时恢复上次选择的字体（脚本加载时自动执行）
 *   FontManager.list()                  全部预设字体（含展示名与字体族）
 *   FontManager.getFont(id)             按 id 获取字体
 *   FontManager.getActiveFontId()       当前生效字体 id
 *   FontManager.preview(id)             应用但不持久化（预览）
 *   FontManager.activate(id)            应用并持久化（正式生效）
 *   FontManager.onChange = fn           字体正式生效后回调（用于同步设置页 UI）
 */
(function (global) {
    'use strict';

    // ============================================================
    // 常量与预设字体列表
    // ============================================================
    var STORAGE_KEY = 'cika_font_store_v1';
    var FONT_VAR = '--app-font-family';
    var SCALE_VAR = '--app-font-scale';
    var WEIGHT_NORMAL_VAR = '--app-font-weight-normal';
    var WEIGHT_MEDIUM_VAR = '--app-font-weight-medium';
    var WEIGHT_BOLD_VAR = '--app-font-weight-bold';

    // 预设字体：family 为 null 表示「系统默认」（回退主题字体，不写入变量）
    var BUILTIN_FONTS = [
        { id: 'default',   name: '系统默认', family: null, note: '跟随主题/系统字体' },
        { id: 'roboto',    name: 'Roboto', family: "'Roboto', -apple-system, 'Segoe UI', sans-serif", note: '无衬线（默认风格）' },
        { id: 'msyh',      name: '微软雅黑', family: "'Microsoft YaHei', 'PingFang SC', sans-serif", note: 'Windows 黑体' },
        { id: 'pingfang',  name: '苹方', family: "'PingFang SC', 'Microsoft YaHei', sans-serif", note: 'macOS / iOS 系统字体' },
        { id: 'noto-sans', name: 'Noto Sans SC', family: "'Noto Sans SC', 'Source Han Sans SC', 'Microsoft YaHei', sans-serif", note: '思源黑体' },
        { id: 'dengxian',  name: '等线', family: "'DengXian', 'Microsoft YaHei', sans-serif", note: 'Windows 等线' },
        { id: 'serif',     name: '衬线体', family: "Georgia, 'Times New Roman', 'Songti SC', serif", note: '宋体 / 衬线风格' },
        { id: 'mono',      name: '等宽字体', family: "'JetBrains Mono', Consolas, 'Courier New', monospace", note: '代码等宽风格' }
    ];

    var BUILTIN_SCALES = [
        { id: 'default', name: '默认', scale: null, note: '100%' },
        { id: 'sm', name: '小', scale: 0.9, note: '90%' },
        { id: 'md', name: '标准', scale: 1, note: '100%' },
        { id: 'lg', name: '大', scale: 1.1, note: '110%' },
        { id: 'xl', name: '特大', scale: 1.2, note: '120%' }
    ];

    var BUILTIN_WEIGHTS = [
        { id: 'default', name: '默认', normal: null, medium: null, bold: null, note: '跟随主题' },
        { id: 'light', name: '偏细', normal: 350, medium: 450, bold: 600, note: '更轻' },
        { id: 'md', name: '标准', normal: 400, medium: 500, bold: 700, note: '推荐' },
        { id: 'strong', name: '偏粗', normal: 450, medium: 600, bold: 800, note: '更醒目' }
    ];

    // ============================================================
    // 状态
    // ============================================================
    var state = { version: 1, activeFontId: 'default', activeScaleId: 'default', activeWeightId: 'default' };
    var stateLoaded = false;

    // ============================================================
    // 工具函数
    // ============================================================
    function storage() {
        try { return global.localStorage; } catch (e) { return null; }
    }

    function safeParse(text) {
        try { return JSON.parse(text); } catch (e) { return null; }
    }

    function findFont(id) {
        if (!id) return null;
        for (var i = 0; i < BUILTIN_FONTS.length; i++) {
            if (BUILTIN_FONTS[i].id === id) return BUILTIN_FONTS[i];
        }
        return null;
    }

    function findScale(id) {
        if (!id) return null;
        for (var i = 0; i < BUILTIN_SCALES.length; i++) {
            if (BUILTIN_SCALES[i].id === id) return BUILTIN_SCALES[i];
        }
        return null;
    }

    function findWeight(id) {
        if (!id) return null;
        for (var i = 0; i < BUILTIN_WEIGHTS.length; i++) {
            if (BUILTIN_WEIGHTS[i].id === id) return BUILTIN_WEIGHTS[i];
        }
        return null;
    }

    // ============================================================
    // 持久化：localStorage（仅本地，不同步服务端）
    // ============================================================
    function loadState() {
        if (stateLoaded) return;
        stateLoaded = true;
        var s = storage();
        if (!s) return;
        try {
            var raw = s.getItem(STORAGE_KEY);
            if (!raw) return;
            var data = safeParse(raw);
            if (!data || typeof data !== 'object') return;
            if (typeof data.activeFontId === 'string' && findFont(data.activeFontId)) {
                state.activeFontId = data.activeFontId;
            }
            if (typeof data.activeScaleId === 'string' && findScale(data.activeScaleId)) {
                state.activeScaleId = data.activeScaleId;
            }
            if (typeof data.activeWeightId === 'string' && findWeight(data.activeWeightId)) {
                state.activeWeightId = data.activeWeightId;
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
    // 样式注入：--app-font-family 仅写 <html> 内联样式
    // ============================================================
    // commit=true 表示正式生效（持久化 + 回调）；false 表示预览
    function applyFont(font, commit) {
        if (!font) return false;
        try {
            var root = document.documentElement;
            if (font.family) {
                root.style.setProperty(FONT_VAR, font.family);
            } else {
                // 系统默认：移除变量，body 回退到 --md-font-family（主题字体）
                root.style.removeProperty(FONT_VAR);
            }
        } catch (e) {
            return false;
        }
        if (commit) {
            state.activeFontId = font.id;
            saveState();
            notify();
        }
        return true;
    }

    function notify() {
        if (typeof api.onChange === 'function') {
            try { api.onChange(); } catch (e) { /* 回调异常不影响字体切换 */ }
        }
    }

    function notifyTypography() {
        if (typeof typographyApi.onChange === 'function') {
            try { typographyApi.onChange(); } catch (e) {}
        }
    }

    function applyScale(item, commit) {
        if (!item) return false;
        try {
            var root = document.documentElement;
            if (typeof item.scale === 'number') {
                root.style.setProperty(SCALE_VAR, String(item.scale));
            } else {
                root.style.removeProperty(SCALE_VAR);
            }
        } catch (e) {
            return false;
        }
        if (commit) {
            state.activeScaleId = item.id;
            saveState();
            notifyTypography();
        }
        return true;
    }

    function applyWeight(item, commit) {
        if (!item) return false;
        try {
            var root = document.documentElement;
            if (typeof item.normal === 'number') root.style.setProperty(WEIGHT_NORMAL_VAR, String(item.normal));
            else root.style.removeProperty(WEIGHT_NORMAL_VAR);
            if (typeof item.medium === 'number') root.style.setProperty(WEIGHT_MEDIUM_VAR, String(item.medium));
            else root.style.removeProperty(WEIGHT_MEDIUM_VAR);
            if (typeof item.bold === 'number') root.style.setProperty(WEIGHT_BOLD_VAR, String(item.bold));
            else root.style.removeProperty(WEIGHT_BOLD_VAR);
        } catch (e) {
            return false;
        }
        if (commit) {
            state.activeWeightId = item.id;
            saveState();
            notifyTypography();
        }
        return true;
    }

    // ============================================================
    // 对外 API
    // ============================================================
    var api = {
        STORAGE_KEY: STORAGE_KEY,
        FONT_VAR: FONT_VAR,

        // 启动恢复：从 localStorage 读取并应用上次选择的字体
        init: function () {
            loadState();
            applyFont(findFont(state.activeFontId) || findFont('default'), false);
            notify();
        },

        // 全部预设字体
        list: function () {
            return BUILTIN_FONTS.slice();
        },

        getFont: function (id) { return findFont(id); },

        getActiveFontId: function () { return state.activeFontId; },

        // 应用并持久化（正式生效）；id 无效时回退系统默认
        activate: function (id) {
            var font = findFont(id) || findFont('default');
            return applyFont(font, true);
        },

        // 应用但不持久化（预览）
        preview: function (id) {
            var font = findFont(id);
            if (!font) return false;
            return applyFont(font, false);
        },

        onChange: null
    };

    var typographyApi = {
        STORAGE_KEY: STORAGE_KEY,
        SCALE_VAR: SCALE_VAR,
        WEIGHT_NORMAL_VAR: WEIGHT_NORMAL_VAR,
        WEIGHT_MEDIUM_VAR: WEIGHT_MEDIUM_VAR,
        WEIGHT_BOLD_VAR: WEIGHT_BOLD_VAR,

        init: function () {
            loadState();
            applyScale(findScale(state.activeScaleId) || findScale('default'), false);
            applyWeight(findWeight(state.activeWeightId) || findWeight('default'), false);
            notifyTypography();
        },

        listScales: function () { return BUILTIN_SCALES.slice(); },
        getScale: function (id) { return findScale(id); },
        getActiveScaleId: function () { return state.activeScaleId; },
        activateScale: function (id) {
            var item = findScale(id) || findScale('default');
            return applyScale(item, true);
        },
        previewScale: function (id) {
            var item = findScale(id);
            if (!item) return false;
            return applyScale(item, false);
        },

        listWeights: function () { return BUILTIN_WEIGHTS.slice(); },
        getWeight: function (id) { return findWeight(id); },
        getActiveWeightId: function () { return state.activeWeightId; },
        activateWeight: function (id) {
            var item = findWeight(id) || findWeight('default');
            return applyWeight(item, true);
        },
        previewWeight: function (id) {
            var item = findWeight(id);
            if (!item) return false;
            return applyWeight(item, false);
        },

        onChange: null
    };

    global.FontManager = api;
    global.TypographyManager = typographyApi;

    // 自动初始化：脚本位于 body 尾部，DOM 已就绪，直接恢复上次选择的字体
    try {
        api.init();
        typographyApi.init();
    } catch (e) {
        // 初始化失败时保持系统默认，不影响其他功能
    }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
