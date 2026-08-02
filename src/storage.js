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

            // Migrate: ensure notify settings exist for existing users
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
                await syncSettingsToEncryptedStore();
            }

            // Apply settings immediately
            applyUserSettings();
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
