/* KnockChat 云端设置同步模块 v1.0
 *
 * 将适合跨设备云同步的用户设置（通知、屏蔽词、外观主题/字体、AI 模型/翻译设置含 API Key）
 * 加密后同步到服务端 users/<uid>.json 的 cloud_settings 字段，云端为权威。
 *
 * 安全模型：
 *   - 云端密钥由「账号级随机盐 + 客户端密码预哈希」经 PBKDF2-HMAC-SHA256（10 万次迭代）
 *     AES-GCM 派生，整个设置包加密后上传；服务端只见密文，无法解读。
 *   - 账号级盐明文随包存储（盐无需保密，仅防彩虹表）；换设备登录后凭密码即可重建密钥。
 *
 * 同步范围（云端为权威，登录后拉取覆盖本地）：
 *   - 应用设置：主题/主题色/字体/字号/字重/通知设置（_userSettingsCache 子集）
 *   - 屏蔽词设置（mjchat_blockword_settings）
 *   - AI 模型/翻译设置（cika_ai_model_settings / cika_ai_translate_settings，含 API Key）
 * 不同步（设备本地数据）：未读状态、已关闭横幅列表、自定义主题定义（仅同步当前激活主题 id）、
 * 私聊会话与聊天记录缓存。
 *
 * 触发时机：
 *   - 登录/会话恢复后：storage.js initUserSettings 末尾调用 CloudSync.onLocalSettingsReady() 拉取并应用；
 *   - 本地设置变更：syncSettingsToEncryptedStore / saveAIModelSettings / saveAITranslateSettings /
 *     saveBlockwordSettings 统一调用 notifyCloudSettingsChanged()，此处防抖推送（指纹去重）。
 *
 * 修改密码说明：云端密文用旧密码派生密钥加密，改密后无法解密；此时以当前设备本地设置为准
 * 重新生成盐并加密上传（旧云端密文对新密码不可读，等同丢弃）。
 */
(function (global) {
    'use strict';

    var CLOUD_VERSION = 1;
    var CLOUD_ITERATIONS = 100000;
    var PUSH_DEBOUNCE_MS = 1200;

    // 内存态
    var _cloudKey = null;          // 云端 AES-GCM 密钥（按需派生）
    var _cloudSalt = null;         // 账号级盐（明文随包存储）
    var _cloudIterations = CLOUD_ITERATIONS;
    var _lastPushedHash = null;    // 最近一次成功推送的可同步设置指纹
    var _pullInFlight = false;
    var _pushReady = false;        // 拉取流程结束、允许推送
    var _pushPending = false;      // 拉取/推送进行中时挂起的变更
    var _pushTimer = null;
    var _pushInFlight = false;

    // ============================================================
    // 工具函数
    // ============================================================
    function getSession() {
        try {
            const raw = localStorage.getItem(LS_KEYS.SESSION);
            if (!raw) return null;
            const s = JSON.parse(raw);
            if (!s || !s.username || !s.token) return null;
            return s;
        } catch (e) { return null; }
    }

    function hasCrypto() {
        return typeof crypto !== 'undefined' && !!crypto.subtle;
    }

    // 派生云端 AES-GCM 密钥（复用 storage.js 的 PBKDF2 派生实现）
    async function ensureCloudKey() {
        if (_cloudKey) return _cloudKey;
        const session = getSession();
        if (!session || !session.pwhash) return null;
        if (!_cloudSalt) return null; // 必须先有盐（拉取到或本地生成）
        _cloudKey = await _pbkdf2DeriveKey(session.pwhash, _cloudSalt, _cloudIterations);
        return _cloudKey;
    }

    // ============================================================
    // 收集本地可同步设置（明文）
    // ============================================================
    function collectAppSettings() {
        const c = (_userSettingsCache && typeof _userSettingsCache === 'object') ? _userSettingsCache : {};
        const out = {
            themeId: (global.ThemeManager && ThemeManager.getActiveThemeId) ? ThemeManager.getActiveThemeId() : (c.themeId || 'dark'),
            theme: (typeof c.theme === 'string') ? c.theme : null,
            themeColor: (typeof c.themeColor === 'string') ? c.themeColor : '',
            fontId: (global.FontManager && FontManager.getActiveFontId) ? FontManager.getActiveFontId() : (c.fontId || 'default'),
            fontScaleId: (global.TypographyManager && TypographyManager.getActiveScaleId) ? TypographyManager.getActiveScaleId() : (c.fontScaleId || 'default'),
            fontWeightId: (global.TypographyManager && TypographyManager.getActiveWeightId) ? TypographyManager.getActiveWeightId() : (c.fontWeightId || 'default'),
            notify: Object.assign({}, DEFAULT_NOTIFY, (c.notify || {}))
        };
        return out;
    }

    function collectBlockwordSettings() {
        try {
            if (typeof loadBlockwordSettings === 'function') {
                const s = loadBlockwordSettings();
                if (s) return s;
            }
        } catch (e) { /* 模块未就绪时返回 null */ }
        return null;
    }

    function collectAISettings() {
        return {
            model: (typeof getAIModelSettings === 'function') ? (getAIModelSettings() || null) : null,
            translate: (typeof getAITranslateSettings === 'function') ? (getAITranslateSettings() || null) : null
        };
    }

    // 可同步设置明文包
    function buildPlainPayload() {
        return {
            app: collectAppSettings(),
            blockword: collectBlockwordSettings(),
            ai: collectAISettings()
        };
    }

    // 可同步设置指纹：仅用于判断「是否有实际变化」，避免消息到达触发的 unread 落盘造成无效推送
    function hashOf(plain) {
        try {
            const s = JSON.stringify(plain);
            let h = 0;
            for (let i = 0; i < s.length; i++) {
                h = ((h << 5) - h + s.charCodeAt(i)) | 0;
            }
            return String(h);
        } catch (e) { return ''; }
    }

    // ============================================================
    // 推送（防抖 + 指纹去重 + 拉取期间挂起）
    // ============================================================
    function schedulePush() {
        if (!_pushReady || _pushInFlight || _pullInFlight) {
            _pushPending = true;
            return;
        }
        if (_pushTimer) clearTimeout(_pushTimer);
        _pushTimer = setTimeout(runPush, PUSH_DEBOUNCE_MS);
    }

    async function runPush() {
        _pushTimer = null;
        if (!_pushReady || _pullInFlight || _pushInFlight) return;
        if (!hasCrypto()) return;
        const session = getSession();
        if (!session || !session.pwhash || !currentUid) return;
        const plain = buildPlainPayload();
        const h = hashOf(plain);
        if (h === _lastPushedHash) return;
        _pushInFlight = true;
        try {
            if (!_cloudKey) {
                if (!_cloudSalt) {
                    _cloudSalt = _generateKeySalt();
                }
                _cloudKey = await ensureCloudKey();
            }
            if (!_cloudKey) return;
            const enc = await encryptData(_cloudKey, JSON.stringify(plain));
            const payload = {
                version: CLOUD_VERSION,
                salt: _cloudSalt,
                iterations: _cloudIterations,
                updated_at: new Date().toISOString(),
                iv: enc.iv,
                data: enc.data
            };
            const { data, error } = await s3.rpc('update_user_settings', {
                p_uid: currentUid,
                p_session_token: session.token,
                p_settings: payload
            });
            if (error || !data || data.success === false) {
                console.warn('[cloudsync] 推送失败:', (error && error.message) || (data && data.message) || 'unknown');
                return;
            }
            _lastPushedHash = h;
        } catch (e) {
            console.warn('[cloudsync] 推送异常:', e && e.message || e);
        } finally {
            _pushInFlight = false;
            // 推送期间又有变更被挂起时，重新调度（若刚失败，下次变更再触发）
            if (_pushPending) {
                _pushPending = false;
                schedulePush();
            }
        }
    }

    // ============================================================
    // 拉取（登录后由 storage.js 触发；云端为权威）
    // ============================================================
    async function pull() {
        if (_pullInFlight) return;
        const session = getSession();
        if (!session || !session.pwhash || !currentUid) return;
        if (!hasCrypto()) return;
        _pullInFlight = true;
        // true 表示「云端无数据或旧密文不可读」，拉取结束后需以本地设置为准上传（种子/改密重建）
        let needSeedPush = false;
        try {
            const { data, error } = await s3.rpc('get_user_settings', {
                p_uid: currentUid,
                p_session_token: session.token
            });
            if (error || !data || data.success === false) {
                console.warn('[cloudsync] 拉取失败:', (error && error.message) || (data && data.message) || 'unknown');
                return;
            }
            const cs = data.settings;
            if (cs && typeof cs === 'object' && cs.salt && cs.data && cs.iv) {
                _cloudSalt = cs.salt;
                _cloudIterations = (typeof cs.iterations === 'number' && cs.iterations > 0) ? cs.iterations : CLOUD_ITERATIONS;
                _cloudKey = null;
                let key = null;
                try {
                    key = await ensureCloudKey();
                } catch (e) { key = null; }
                if (!key) {
                    // 密码派生密钥失败（改密或数据损坏）：以本地设置为准重建
                    console.warn('[cloudsync] 云端设置解密失败，将以当前设备设置为准重新上传');
                    _cloudKey = null;
                    _cloudSalt = null;
                    needSeedPush = true;
                    return;
                }
                let plain = null;
                try {
                    const plainText = await decryptData(key, cs.iv, cs.data);
                    plain = JSON.parse(plainText);
                } catch (e) {
                    console.warn('[cloudsync] 云端设置解密失败，将以当前设备设置为准重新上传');
                    _cloudKey = null;
                    _cloudSalt = null;
                    needSeedPush = true;
                    return;
                }
                if (plain && typeof plain === 'object') {
                    await applyCloudPayload(plain);
                    _lastPushedHash = hashOf(buildPlainPayload());
                }
            } else {
                // 云端无数据（首次使用云同步）：以本地设置上传作为初始种子
                needSeedPush = true;
            }
        } catch (e) {
            console.warn('[cloudsync] 拉取异常:', e && e.message || e);
        } finally {
            _pullInFlight = false;
            _pushReady = true;
            if (needSeedPush || _pushPending) {
                _pushPending = false;
                schedulePush();
            }
        }
    }

    // 云端为权威：将云端设置覆盖到本地加密存储并立即生效
    async function applyCloudPayload(plain) {
        // 1) 应用设置（仅覆盖可同步字段，保留 unread 等设备本地数据）
        if (plain.app && typeof plain.app === 'object') {
            const app = plain.app;
            if (!_userSettingsCache || typeof _userSettingsCache !== 'object') {
                _userSettingsCache = {};
            }
            if (typeof app.themeId === 'string') _userSettingsCache.themeId = app.themeId;
            if (typeof app.theme === 'string') _userSettingsCache.theme = app.theme;
            if (typeof app.themeColor === 'string') _userSettingsCache.themeColor = app.themeColor;
            if (typeof app.fontId === 'string') _userSettingsCache.fontId = app.fontId;
            if (typeof app.fontScaleId === 'string') _userSettingsCache.fontScaleId = app.fontScaleId;
            if (typeof app.fontWeightId === 'string') _userSettingsCache.fontWeightId = app.fontWeightId;
            if (app.notify && typeof app.notify === 'object') {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY, app.notify);
            }
            if (typeof syncSettingsToEncryptedStore === 'function') {
                await syncSettingsToEncryptedStore();
            }
            if (typeof applyUserSettings === 'function') {
                applyUserSettings();
            }
        }
        // 2) 屏蔽词设置
        if (plain.blockword && typeof plain.blockword === 'object') {
            try {
                if (typeof saveBlockwordSettings === 'function') saveBlockwordSettings(plain.blockword);
            } catch (e) {}
            try {
                if (typeof updateBlockwordSettingsUI === 'function') updateBlockwordSettingsUI();
            } catch (e) {}
        }
        // 3) AI 设置（含 API Key）
        const ai = (plain.ai && typeof plain.ai === 'object') ? plain.ai : {};
        try {
            if (typeof saveAIModelSettings === 'function' && ai.model !== undefined) {
                await saveAIModelSettings(ai.model || null);
            }
        } catch (e) {}
        try {
            if (typeof saveAITranslateSettings === 'function' && ai.translate !== undefined) {
                await saveAITranslateSettings(ai.translate || null);
            }
        } catch (e) {}
    }

    // ============================================================
    // 对外 API
    // ============================================================
    global.CloudSync = {
        // 登录后本地设置就绪时调用（storage.js initUserSettings 末尾）：拉取云端设置并应用
        onLocalSettingsReady: function () {
            if (!hasCrypto()) return;
            _pushReady = false;
            _pushPending = false;
            _lastPushedHash = null;
            _cloudKey = null;
            _cloudSalt = null;
            pull();
        },
        // 本地设置变更时调用（防抖推送，指纹去重）
        onLocalSettingsChanged: function () {
            schedulePush();
        }
    };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
