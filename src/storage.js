/* CikaChat 存储与加密：SHA-256 加密、用户加密配置存取、未读/会话状态持久化 */

        function getUnreadState() {
            // Read from encrypted settings cache
            if (_userSettingsCache && _userSettingsCache.unread) {
                return _userSettingsCache.unread;
            }
            return { publicLastRead: null, privateLastRead: {} };
        }
        function saveUnreadState(state) {
            // Update encrypted settings cache
            if (_userSettingsCache) {
                _userSettingsCache.unread = state;
                syncSettingsToEncryptedStore();
            }
        }
        function markPublicRead(timestamp) {
            const state = getUnreadState();
            state.publicLastRead = timestamp || new Date().toISOString();
            saveUnreadState(state);
        }
        function markPrivateRead(sessionId, timestamp) {
            const state = getUnreadState();
            state.privateLastRead[sessionId] = timestamp || new Date().toISOString();
            saveUnreadState(state);
        }
        function restoreUnreadCounts() {
            const state = getUnreadState();
            const pubLastRead = state.publicLastRead;
            publicUnread = 0;
            // 群聊免打扰开启时不恢复红点
            if (typeof _mutePublic !== 'undefined' && _mutePublic) return;
            if (pubLastRead) {
                publicMessages.forEach(m => {
                    if (!m.is_system && m.sender !== currentUser && new Date(m.created_at) > new Date(pubLastRead)) {
                        publicUnread++;
                    }
                });
            } else {
                publicMessages.forEach(m => {
                    if (!m.is_system && m.sender !== currentUser) publicUnread++;
                });
            }
            privateUnreadCounts = {};
        }
        function restorePrivateUnreadFromSessions() {
            const state = getUnreadState();
            privateUnreadCounts = {};
            if (window.privateSessions) {
                window.privateSessions.forEach(s => {
                    // 私聊免打扰开启的会话不恢复红点
                    if (_mutePerPrivateSession && _mutePerPrivateSession[s.id]) return;
                    const lastRead = state.privateLastRead[s.id];
                    if (lastRead && s.updated_at) {
                        if (new Date(s.updated_at) > new Date(lastRead)) {
                            countUnreadPrivateMessages(s.id, lastRead);
                        }
                    } else if (!lastRead) {
                        if (s.last_message) {
                            countUnreadPrivateMessages(s.id, null);
                        }
                    }
                });
            }
        }
        async function hashPassword(password) {
            // SECURITY MODEL (Defense in Depth):
            // 1. Client side: SHA-256(password + salt) as a transport hash
            //    This is NOT the final stored hash. It prevents raw passwords
            //    from being sent over the network even though HTTPS is used.
            // 2. Server side: bcrypt(client_hash) is stored in the database.
            //    The server-side verify_login_secure() function applies bcrypt
            //    using PostgreSQL's crypt() + gen_salt('bf', 10).
            // Legacy users with plain SHA-256 hashes are auto-upgraded to
            // bcrypt on their next login (see verify_login_secure SQL).
            //
            // The SHA-256 here is intentional and secure because:
            // - The actual password storage is bcrypt (cost factor 10)
            // - SHA-256 is only a client-side pre-hash transport layer
            // - Changing this would invalidate all existing user passwords

            // Use crypto.subtle if available (modern browsers)
            if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
                var encoder = new TextEncoder();
                var data = encoder.encode(SALT + password + SALT);
                var hashBuffer = await crypto.subtle.digest('SHA-256', data);
                var hashArray = new Uint8Array(hashBuffer);
                var result = '';
                for (var i = 0; i < hashArray.length; i++) {
                    var hex = hashArray[i].toString(16);
                    result += hex.length === 1 ? '0' + hex : hex;
                }
                return result;
            }
            // Fallback: pure JS SHA-256 implementation for old WebViews
            return sha256Pure(SALT + password + SALT);
        }

        // ============================================
        // User Settings Encryption (AES-GCM)
        // Encrypts per-user local settings with password hash as key.
        // Supports multiple users on the same device.
        // ============================================

        // Convert hex string to Uint8Array bytes
        function hexToBytes(hex) {
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < bytes.length; i++) {
                bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
            }
            return bytes;
        }

        // Derive AES-GCM encryption key from password hash (hex string)
        async function deriveEncryptionKey(passwordHash) {
            const keyBytes = hexToBytes(passwordHash);
            return await crypto.subtle.importKey(
                'raw', keyBytes, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
            );
        }

        // Encrypt plaintext string with AES-GCM. Returns {iv, data} as base64 strings.
        async function encryptData(key, plaintext) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encoded = new TextEncoder().encode(plaintext);
            const ciphertext = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv }, key, encoded
            );
            return {
                iv: btoa(String.fromCharCode(...iv)),
                data: btoa(String.fromCharCode(...new Uint8Array(ciphertext)))
            };
        }

        // Decrypt AES-GCM encrypted data. Returns plaintext string.
        async function decryptData(key, ivBase64, dataBase64) {
            const iv = new Uint8Array(atob(ivBase64).split('').map(c => c.charCodeAt(0)));
            const ciphertext = new Uint8Array(atob(dataBase64).split('').map(c => c.charCodeAt(0)));
            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv }, key, ciphertext
            );
            return new TextDecoder().decode(decrypted);
        }

        // In-memory cache: holds decrypted settings for the current user
        let _userSettingsCache = null;
        let _encryptionKey = null;
        // AI 设置解密缓存（模型/翻译），登录时从加密存储加载
        let _aiSettingsCache = null;

        // Load the raw per-user configs object from localStorage
        function loadAllUserConfigs() {
            try {
                const raw = localStorage.getItem('mjchat_user_configs');
                return raw ? JSON.parse(raw) : {};
            } catch (e) { return {}; }
        }

        // Save the raw per-user configs object to localStorage
        function saveAllUserConfigs(configs) {
            try { localStorage.setItem('mjchat_user_configs', JSON.stringify(configs)); } catch (e) {}
        }

        // Initialize user settings: derive key, decrypt config, migrate old data if needed
        async function initUserSettings(passwordHash, username) {
            // Derive encryption key from password hash
            _encryptionKey = await deriveEncryptionKey(passwordHash);

            const allConfigs = loadAllUserConfigs();
            let userConfig = null;

            if (allConfigs[username]) {
                // Decrypt existing config for this user
                try {
                    const encrypted = allConfigs[username];
                    const plaintext = await decryptData(_encryptionKey, encrypted.iv, encrypted.data);
                    userConfig = JSON.parse(plaintext);
                } catch (e) {
                    // Decryption failed (wrong password or corrupted data) - start fresh
                    console.warn('Failed to decrypt settings for', username, '- starting fresh');
                }
            }

            let wasMigrated = false;
            if (!userConfig) {
                // No encrypted config yet - migrate from old localStorage keys (one-time)
                userConfig = {
                    theme: localStorage.getItem('mjchat_theme') || 'dark',
                    themeColor: localStorage.getItem('mjchat_theme_color') || '',
                    unread: { publicLastRead: null, privateLastRead: {} },
                    dismissedPrivacyBanners: [],
                    notify: Object.assign({}, DEFAULT_NOTIFY),
                    version: 1
                };
                wasMigrated = true;
                // Migrate old unread state if it exists
                try {
                    const oldUnread = JSON.parse(localStorage.getItem('mjchat_unread'));
                    if (oldUnread) {
                        userConfig.unread = oldUnread;
                    }
                } catch (e) {}
                // Migrate old dismissed banners
                try {
                    const oldBanners = JSON.parse(localStorage.getItem('dismissedPrivacyBanners'));
                    if (oldBanners) {
                        userConfig.dismissedPrivacyBanners = oldBanners;
                    }
                } catch (e) {}
                // Delete old unencrypted data after migration
                try { localStorage.removeItem('mjchat_theme'); } catch (e) {}
                try { localStorage.removeItem('mjchat_theme_color'); } catch (e) {}
                try { localStorage.removeItem('mjchat_unread'); } catch (e) {}
                try { localStorage.removeItem('dismissedPrivacyBanners'); } catch (e) {}
            }

            // Cache decrypted settings in memory
            _userSettingsCache = userConfig;

            // v057 修复：迁移/新建出的配置立即加密落盘，
            // 否则下次启动解不到配置，设置（主题色、通知等）会退回默认
            if (wasMigrated) {
                await syncSettingsToEncryptedStore();
            }

            // Migrate: ensure notify settings exist for existing users
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
                await syncSettingsToEncryptedStore();
            }

            // Apply settings immediately
            applyUserSettings();

            // 解密 AI 设置（模型/翻译）到内存缓存
            await loadAISettingsToCache();
        }

        // Apply cached settings to the app state
        function applyUserSettings() {
            if (!_userSettingsCache) return;

            // Apply theme
            const theme = _userSettingsCache.theme || 'dark';
            document.documentElement.setAttribute('data-theme', theme);
            updateThemeLabel();

            // Apply theme color
            if (_userSettingsCache.themeColor) {
                applyThemeColor(_userSettingsCache.themeColor);
                const picker = document.getElementById('themeColorPicker');
                if (picker) picker.value = _userSettingsCache.themeColor;
            }

            // Apply dismissed banners
            dismissedPrivacyBanners = new Set(_userSettingsCache.dismissedPrivacyBanners || []);

            // Apply notification settings to settings page UI
            refreshNotifySettingsUI();
        }

        // Sync in-memory settings to encrypted localStorage
        async function syncSettingsToEncryptedStore() {
            if (!_encryptionKey || !_userSettingsCache || !currentUser) return;
            try {
                const allConfigs = loadAllUserConfigs();
                const plaintext = JSON.stringify(_userSettingsCache);
                const encrypted = await encryptData(_encryptionKey, plaintext);
                allConfigs[currentUser] = encrypted;
                saveAllUserConfigs(allConfigs);
            } catch (e) {
                console.warn('Failed to sync encrypted settings:', e);
            }
        }

        // Clear encryption key and settings cache from memory
        function clearEncryptionKey() {
            _encryptionKey = null;
            _userSettingsCache = null;
            _aiSettingsCache = null;
        }

        // ============================================
        // AI 设置加密存取（模型/翻译，含 API Key）
        // 与用户设置共用 AES-GCM 密钥；旧版明文在下次登录时自动迁移为加密格式
        // ============================================

        // 读取并解密单个 AI 设置键；旧版明文数据自动加密迁移
        async function decryptAISettingsValue(key, raw) {
            if (!raw) return null;
            let obj = null;
            try { obj = JSON.parse(raw); } catch (e) { return null; }
            if (obj && typeof obj === 'object' && obj.iv && obj.data) {
                // 已是加密格式
                if (!_encryptionKey) return null;
                try {
                    const plain = await decryptData(_encryptionKey, obj.iv, obj.data);
                    return JSON.parse(plain);
                } catch (e) { return null; }
            }
            // 旧版明文：用当前密钥加密迁移
            if (_encryptionKey) {
                try {
                    const enc = await encryptData(_encryptionKey, JSON.stringify(obj));
                    localStorage.setItem(key, JSON.stringify(enc));
                } catch (e) {}
            }
            return obj;
        }

        // 加密写入单个 AI 设置键；密钥未就绪时降级为明文（下次登录自动迁移）
        async function encryptAISettingsValue(key, obj) {
            if (obj === null || obj === undefined) { localStorage.removeItem(key); return; }
            const json = JSON.stringify(obj);
            if (_encryptionKey) {
                try {
                    const enc = await encryptData(_encryptionKey, json);
                    localStorage.setItem(key, JSON.stringify(enc));
                    return;
                } catch (e) {}
            }
            localStorage.setItem(key, json);
        }

        // 登录时解密全部 AI 设置到内存缓存
        async function loadAISettingsToCache() {
            _aiSettingsCache = {
                model: await decryptAISettingsValue('cika_ai_model_settings', localStorage.getItem('cika_ai_model_settings')),
                translate: await decryptAISettingsValue('cika_ai_translate_settings', localStorage.getItem('cika_ai_translate_settings'))
            };
        }

        // 同步读取已解密的 AI 模型设置
        function getAIModelSettings() {
            return _aiSettingsCache ? _aiSettingsCache.model : null;
        }

        // 同步读取已解密的 AI 翻译设置
        function getAITranslateSettings() {
            return _aiSettingsCache ? _aiSettingsCache.translate : null;
        }

        // 保存 AI 模型设置（更新缓存 + 加密落盘）
        async function saveAIModelSettings(settings) {
            if (!_aiSettingsCache) _aiSettingsCache = { model: null, translate: null };
            _aiSettingsCache.model = settings || null;
            await encryptAISettingsValue('cika_ai_model_settings', _aiSettingsCache.model);
        }

        // 保存 AI 翻译设置（更新缓存 + 加密落盘）
        async function saveAITranslateSettings(settings) {
            if (!_aiSettingsCache) _aiSettingsCache = { model: null, translate: null };
            _aiSettingsCache.translate = settings || null;
            await encryptAISettingsValue('cika_ai_translate_settings', _aiSettingsCache.translate);
        }

        // ============================================
        // 设置导入导出
        // ============================================

        // 导出设置：应用设置（主题/通知等）+ AI 设置（含 API Key）打包为 JSON 文件
        function exportSettings() {
            if (!_userSettingsCache) { showSnackbar('设置尚未加载'); return; }
            const userSettings = Object.assign({}, _userSettingsCache);
            delete userSettings.unread; // 未读状态属设备临时数据，不随设置迁移
            const data = {
                app: 'com.cika.chatapp',
                type: '#settings#',
                version: "26.8.305",
                exportedAt: new Date().toISOString(),
                user: currentUser || '',
                settings: {
                    user: userSettings,
                    aiModel: getAIModelSettings() || null,
                    aiTranslate: getAITranslateSettings() || null
                }
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'com.cika.chatapp:backup-' + new Date().toISOString().slice(0, 10) + '.json';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
            showSnackbar('设置已导出，文件包含 AI API Key，请妥善保管');
        }

        // 导入设置：选择 JSON 文件并确认后恢复设置
        function importSettings() {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.onchange = function() {
                const file = input.files && input.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = function() {
                    let data = null;
                    try {
                        data = JSON.parse(reader.result);
                    } catch (e) { showSnackbar('导入失败: 文件解析错误'); return; }
                    if (!data || data.type !== '#settings#' || !data.settings) {
                        showSnackbar('导入失败: 不是有效的 CikaChat 设置文件');
                        return;
                    }
                    showConfirm('导入设置', '导入后将覆盖当前的主题、通知与 AI 设置，是否继续？', function() {
                        applyImportedSettings(data.settings);
                    });
                };
                reader.readAsText(file);
            };
            input.click();
        }

        // 应用导入的设置：写入加密存储与 localStorage 并立即生效
        async function applyImportedSettings(settings) {
            if (settings.user && typeof settings.user === 'object') {
                _userSettingsCache = Object.assign({}, _userSettingsCache, settings.user);
                if (!_userSettingsCache.notify) _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
                syncSettingsToEncryptedStore();
                applyUserSettings();
            }
            if (settings.aiModel) {
                await saveAIModelSettings(settings.aiModel);
            }
            if (settings.aiTranslate) {
                await saveAITranslateSettings(settings.aiTranslate);
            }
            showSnackbar('设置导入成功');
        }

        // ============================================
        // Notification Sound Settings
        // ============================================

        function sha256Pure(message) {
            function rotr(n, x) { return (x >>> n) | (x << (32 - n)); }
            var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
            var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
                     0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
                     0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
                     0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
                     0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
                     0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
                     0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
                     0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
            // Convert message to byte array (UTF-8)
            var bytes = [];
            for (var i = 0; i < message.length; i++) {
                var c = message.charCodeAt(i);
                if (c < 128) { bytes.push(c); }
                else if (c < 2048) { bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F)); }
                else { bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
            }
            // Padding
            var bitLen = bytes.length * 8;
            bytes.push(0x80);
            while (bytes.length % 64 !== 56) bytes.push(0);
            // Append length as 64-bit big-endian
            for (var b = 56; b >= 0; b -= 8) bytes.push((bitLen >>> b) & 0xFF);
            // Process blocks
            for (var off = 0; off < bytes.length; off += 64) {
                var W = [];
                for (var t = 0; t < 16; t++) {
                    W[t] = (bytes[off + t*4] << 24) | (bytes[off + t*4 + 1] << 16) | (bytes[off + t*4 + 2] << 8) | bytes[off + t*4 + 3];
                }
                for (var t2 = 16; t2 < 64; t2++) {
                    var s0 = rotr(7, W[t2-15]) ^ rotr(18, W[t2-15]) ^ (W[t2-15] >>> 3);
                    var s1 = rotr(17, W[t2-2]) ^ rotr(19, W[t2-2]) ^ (W[t2-2] >>> 10);
                    W[t2] = (W[t2-16] + s0 + W[t2-7] + s1) | 0;
                }
                var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
                for (var t3 = 0; t3 < 64; t3++) {
                    var S1 = rotr(6, e) ^ rotr(11, e) ^ rotr(25, e);
                    var ch = (e & f) ^ (~e & g);
                    var temp1 = (h + S1 + ch + K[t3] + W[t3]) | 0;
                    var S0 = rotr(2, a) ^ rotr(13, a) ^ rotr(22, a);
                    var maj = (a & b) ^ (a & c) ^ (b & c);
                    var temp2 = (S0 + maj) | 0;
                    h=g; g=f; f=e; e=(d + temp1)|0; d=c; c=b; b=a; a=(temp1 + temp2)|0;
                }
                H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
                H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
            }
            var hex = '';
            for (var hi = 0; hi < 8; hi++) {
                var h = H[hi];
                hex += ((h >>> 28) & 0xF).toString(16);
                hex += ((h >>> 24) & 0xF).toString(16);
                hex += ((h >>> 20) & 0xF).toString(16);
                hex += ((h >>> 16) & 0xF).toString(16);
                hex += ((h >>> 12) & 0xF).toString(16);
                hex += ((h >>> 8) & 0xF).toString(16);
                hex += ((h >>> 4) & 0xF).toString(16);
                hex += (h & 0xF).toString(16);
            }
            return hex;
        }

        // v043: API Key 加盐哈希，用于客户端预混淆
        async function hashApiKey(apiKey) {
            // 复用与 hashPassword 同样的 SHA-256 预哈希逻辑
            // 服务端再用 bcrypt 加固存储，是多层防御（Defense in Depth）
            if (typeof crypto !== 'undefined' && crypto.subtle && typeof TextEncoder !== 'undefined') {
                const encoder = new TextEncoder();
                const data = encoder.encode('agentkey:' + apiKey + ':' + SALT);
                const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                const hashArray = new Uint8Array(hashBuffer);
                let result = '';
                for (let i = 0; i < hashArray.length; i++) {
                    const hex = hashArray[i].toString(16);
                    result += hex.length === 1 ? '0' + hex : hex;
                }
                return result;
            }
            return sha256Pure('agentkey:' + apiKey + ':' + SALT);
        }
