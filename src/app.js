        const _d = function(s) { var k = 'mjchat2026'; var r = ''; try { var d = atob(s); for (var i = 0; i < d.length; i++) { r += String.fromCharCode(d.charCodeAt(i) ^ k.charCodeAt(i % k.length)); } } catch(e) { r = s; } return r; };
        const SUPABASE_URL = _d('BR4XGBJOHR9VTwQeGh0CF0JGWVgcHwIJCwBXVhxFGBoCCgAHVx5RWQ==');
        const SUPABASE_ANON_KEY = _d('Hgg8GBQWXllBXgwIDw0+JVtoWWkyGyBZCEJfd1p/DC8CGSICY29wUV8nBiosLQ==');
        const TABLE_USERS = 'chat_users';
        const TABLE_PUBLIC_MSG = 'chat_messages';
        const TABLE_PRIVATE_SESSIONS = 'private_sessions';
        const TABLE_PRIVATE_MSGS = 'private_messages';
        const TABLE_AGENTS = 'chat_agents';
        const TABLE_LOGIN_HISTORY = 'login_history';
        const STORAGE_BUCKET = 'chat-images';
        const CHANNEL_PUBLIC = 'chat-room-md';
        const HISTORY_LIMIT = 200;
        const MJCHAT_VERSION = 40;
        const APP_VERSION = '26.8.202';
        const SALT = 'mjchat_2026_salt_v1';
        const FORBIDDEN_WORDS = ['漫卷', 'MJ', 'system', 'System', 'SYSTEM', '管理员', '系统'];
        const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
        const COMPRESS_THRESHOLD = 1 * 1024 * 1024;
        const MAX_IMAGES_PER_MSG = 5;

        let sb = null;
        let currentUser = '';
        let isAdmin = false;
        let clientId = '';
        let publicChannel = null;
        let privateChannel = null;
        let isEntered = false;
        let publicMessages = [];
        let publicLastDateLabel = '';
        let privateMessages = [];
        let privateLastDateLabel = '';
        let privateSessionId = null;
        let privateOtherUser = '';
        let privateChatActive = false;
        let privateStatusInterval = null;
        let dismissedPrivacyBanners = new Set(JSON.parse(localStorage.getItem('dismissedPrivacyBanners') || '[]'));
        let onlineUsers = {};
        let confirmCallback = null;
        let replyTarget = null;
        let privateReplyTarget = null;
        let mediaRecorder = null,
            audioChunks = [],
            recordStartTime = null,
            recordTimerInterval = null;
        let privateMediaRecorder = null,
            privateAudioChunks = [],
            privateRecordStartTime = null,
            privateRecordTimerInterval = null;
        let activeAudio = null;
        let contextTarget = null;
        let lastPokeTime = 0;
        let currentAvatarUrl = '';
        let linkMode = 'public';

        let isUserScrolledUp = false;
        let scrollTimeout = null;
        let presenceSynced = false;
        let presenceReady = false;
        let privateUnreadCounts = {};
        let globalPrivateChannel = null;
        let publicUnread = 0;
        let privatePollTimer = null;
        // v040: Public chat polling timers for retry logic
        let _publicPollTimer = null;
        let _publicBackupPollTimer = null;
        let _publicRetryCount = 0;
        var _rateLimits = {};

        function checkRateLimit(action, maxCount, windowMs) {
            var now = Date.now();
            if (!_rateLimits[action]) _rateLimits[action] = [];
            _rateLimits[action] = _rateLimits[action].filter(function(t) { return now - t < windowMs; });
            if (_rateLimits[action].length >= maxCount) {
                return false;
            }
            _rateLimits[action].push(now);
            return true;
        }
        function rateLimitedAction(action, maxCount, windowMs, fn) {
            if (!checkRateLimit(action, maxCount, windowMs)) {
                showSnackbar('操作过于频繁，请稍后再试');
                return Promise.resolve(null);
            }
            return fn();
        }

        var _csrfToken = '';
        function getCsrfToken() {
            if (!_csrfToken) {
                _csrfToken = sessionStorage.getItem('mjchat_csrf') || '';
                if (!_csrfToken) {
                    var arr = new Uint8Array(32);
                    if (window.crypto && window.crypto.getRandomValues) {
                        window.crypto.getRandomValues(arr);
                    } else {
                        for (var i = 0; i < 32; i++) arr[i] = Math.floor(Math.random() * 256);
                    }
                    _csrfToken = Array.from(arr).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
                    sessionStorage.setItem('mjchat_csrf', _csrfToken);
                }
            }
            return _csrfToken;
        }

        // ============================================
        // Security Helper Functions (v030)
        // All sensitive operations must use these
        // ============================================

        function getSessionToken() {
            try {
                const session = JSON.parse(localStorage.getItem('mjchat_session'));
                return (session && session.token) ? session.token : '';
            } catch (e) { return ''; }
        }

        async function verifyAdminSession() {
            if (!currentUser) return false;
            try {
                const { data, error } = await sb.rpc('verify_admin_session', {
                    p_username: currentUser,
                    p_session_token: getSessionToken()
                });
                if (error) return false;
                return data && data.success === true;
            } catch (e) { return false; }
        }

        async function sendPublicMessageSecure(payload) {
            if (!checkRateLimit('send_msg', 30, 60000)) {
                return { success: false, message: '发送过于频繁，请稍后再试' };
            }
            const token = getSessionToken();
            if (!token) { return { success: false, message: '请重新登录' }; }
            try {
                const { data, error } = await sb.rpc('send_public_message_secure', {
                    p_username: currentUser,
                    p_session_token: token,
                    p_text: payload.text || '',
                    p_image_url: payload.image_url || null,
                    p_audio_url: payload.audio_url || null,
                    p_audio_dur: payload.audio_dur || null,
                    p_reply_to_id: payload.reply_to_id || null,
                    p_reply_content: payload.reply_content || null,
                    p_is_system: payload.is_system || false,
                    p_msg_version: payload.msg_version || MJCHAT_VERSION
                });
                if (error) return { success: false, message: error.message };
                return data || { success: false, message: '发送失败' };
            } catch (e) { return { success: false, message: e.message }; }
        }

        async function sendSystemMessageSecure(text) {
            const token = getSessionToken();
            if (!token) return { success: false };
            try {
                const { data, error } = await sb.rpc('send_public_message_secure', {
                    p_username: currentUser,
                    p_session_token: token,
                    p_text: text,
                    p_is_system: true,
                    p_msg_version: MJCHAT_VERSION
                });
                if (error) return { success: false };
                return data || { success: false };
            } catch (e) { return { success: false }; }
        }

        function getUnreadState() {
            try {
                const raw = localStorage.getItem('mjchat_unread');
                return raw ? JSON.parse(raw) : { publicLastRead: null, privateLastRead: {} };
            } catch (e) { return { publicLastRead: null, privateLastRead: {} }; }
        }
        function saveUnreadState(state) {
            try { localStorage.setItem('mjchat_unread', JSON.stringify(state)); } catch (e) {}
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
        async function countUnreadPrivateMessages(sessionId, lastReadTime) {
            try {
                let data = null;
                try {
                    const { data: rpcData, error } = await sb.rpc('get_private_messages', {
                        p_session_id: sessionId,
                        p_username: currentUser,
                        p_limit: 200
                    });
                    if (!error && rpcData) data = rpcData;
                } catch (e) {}
                if (!data || data.length === 0) return;
                let count = 0;
                if (lastReadTime) {
                    data.forEach(m => {
                        if (m.sender !== currentUser && new Date(m.created_at) > new Date(lastReadTime)) count++;
                    });
                } else {
                    data.forEach(m => {
                        if (m.sender !== currentUser) count++;
                    });
                }
                if (count > 0) {
                    privateUnreadCounts[sessionId] = count;
                    renderPrivateList();
                    updateBackBadge();
                }
            } catch (e) { /* ignore */ }
        }
        let userAvatarCache = {};
        let publicMsgPage = 0;
        let publicHasMore = true;
        let publicLoadingMore = false;
        let privateMsgPage = 0;
        let privateHasMore = true;
        let privateLoadingMore = false;
        const PAGE_SIZE = 200;

        function escapeHtml(t) { if (t == null) return ''; const d = document.createElement('div');
            d.textContent = String(t); return d.innerHTML; }

        function escapeAttr(t) { if (t == null) return ''; return String(t).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }

        function isSafeUrl(url) {
            if (!url || typeof url !== 'string') return false;
            const u = url.trim();
            // 与 cleanHtml 的 href 白名单保持一致，并显式排除 javascript:
            if (!/^(https?:|mailto:|tel:|#|\/)/i.test(u)) return false;
            if (/^javascript:/i.test(u)) return false;
            return true;
        }

        function sanitizeAvatarUrl(url) {
            if (!url || typeof url !== 'string') return '';
            const u = url.trim();
            if (!/^https?:\/\//i.test(u)) return '';
            return u.replace(/['"\\]/g, '');
        }

        function getMessagePreview(text) {
            if (!text) return '';
            if (text.startsWith('__RPL__')) {
                const m = text.match(/^__RPL__.*?__ENDRPL__/);
                if (m) text = text.substring(m[0].length);
            }
            if (text.startsWith('🎤 ')) return text.replace(/ → .*$/, '');
            if (text.startsWith('🔗 ')) return '[链接]';
            if (text.startsWith('📎 ')) {
                const m = text.match(/📎 (.*?) \(/);
                return m ? m[1] : text;
            }
            if (text.startsWith('🖼️ ')) return '[图片]';
            return text.length > 40 ? text.substring(0, 40) + '…' : text;
        }

        function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i);
                h |= 0; } return Math.abs(h); }

        function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 9); }

        function autoResize(el) { el.style.height = 'auto';
            el.style.height = Math.min(el.scrollHeight, 100) + 'px'; }

        let snackbarTimer = null;

        function showSnackbar(msg) {
            const ex = document.querySelector('.snackbar');
            if (ex) ex.remove();
            if (snackbarTimer) clearTimeout(snackbarTimer);
            const s = document.createElement('div');
            s.className = 'snackbar';
            s.textContent = msg;
            document.body.appendChild(s);
            snackbarTimer = setTimeout(() => {
                s.style.opacity = '0';
                s.style.transition = 'opacity 0.3s';
                setTimeout(() => s.remove(), 300);
            }, 3000);
        }

        function showGlobalLoading(text, sub) {
            const el = document.getElementById('globalLoading');
            el.classList.remove('hidden');
            if (text) el.querySelector('.loading-text').textContent = text;
            if (sub) el.querySelector('.loading-sub').textContent = sub;
        }

        function hideGlobalLoading() {
            document.getElementById('globalLoading').classList.add('hidden');
        }

        function updateLoadingText(text, sub) {
            const el = document.getElementById('globalLoading');
            if (text) el.querySelector('.loading-text').textContent = text;
            if (sub) el.querySelector('.loading-sub').textContent = sub;
        }

        function showEl(id, msg) {
            const el = document.getElementById(id);
            el.textContent = msg;
            el.classList.add('show');
        }

        function hideEl(id) {
            document.getElementById(id).classList.remove('show');
        }

        function isScrolledToBottom(el) {
            if (!el) return true;
            const threshold = 20;
            return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
        }

        function scrollToBottom(el) {
            if (!el) return;
            el.scrollTop = el.scrollHeight;
        }

        function updateScrollButton(messagesContainer) {
            const btn = messagesContainer.querySelector('.scroll-to-bottom-btn');
            if (!btn) return;
            if (isScrolledToBottom(messagesContainer)) {
                btn.classList.remove('show');
            } else {
                btn.classList.add('show');
            }
        }

        function setupScrollHandlers(messagesContainer) {
            if (!messagesContainer) return;
            const oldBtn = messagesContainer.querySelector('.scroll-to-bottom-btn');
            if (oldBtn) oldBtn.remove();

            const btn = document.createElement('button');
            btn.className = 'scroll-to-bottom-btn';
            btn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>';
            btn.title = '回到最新消息';
            btn.onclick = function(e) {
                e.stopPropagation();
                scrollToBottom(messagesContainer);
                isUserScrolledUp = false;
                updateScrollButton(messagesContainer);
                setTimeout(() => updateScrollButton(messagesContainer), 100);
            };
            messagesContainer.appendChild(btn);

            let topLoadTimer = null;
            messagesContainer.addEventListener('scroll', function() {
                if (isScrolledToBottom(messagesContainer)) {
                    isUserScrolledUp = false;
                } else {
                    isUserScrolledUp = true;
                }
                updateScrollButton(messagesContainer);
                if (messagesContainer.scrollTop <= 5) {
                    clearTimeout(topLoadTimer);
                    topLoadTimer = setTimeout(() => {
                        if (messagesContainer.id === 'publicMessages' && publicHasMore) {
                            loadMorePublicMessages();
                        } else if (messagesContainer.id === 'privateMessages' && privateHasMore && privateSessionId) {
                            loadMorePrivateMessages(privateSessionId);
                        }
                    }, 300);
                }
                clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(() => {
                    if (isScrolledToBottom(messagesContainer)) {
                        isUserScrolledUp = false;
                    }
                    updateScrollButton(messagesContainer);
                }, 500);
            });

            setTimeout(() => {
                scrollToBottom(messagesContainer);
                updateScrollButton(messagesContainer);
            }, 100);
        }

        function cleanHtml(html) {
            if (!html) return '';
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const body = doc.body;
            const allowedTags = ['b', 'i', 'u', 's', 'a', 'img', 'span', 'div', 'br', 'svg', 'path', 'audio', 'source',
                'button'
            ];
            const allowedAttrs = {
                'a': ['href', 'target', 'rel'],
                'img': ['src', 'alt', 'width', 'height'],
                'audio': ['src', 'controls'],
                'source': ['src', 'type'],
                'button': ['type']
            };

            function cleanNode(node) {
                if (node.nodeType === Node.TEXT_NODE) return node.cloneNode(true);
                if (node.nodeType !== Node.ELEMENT_NODE) return null;
                const tag = node.tagName.toLowerCase();
                if (!allowedTags.includes(tag)) return null;
                const newNode = document.createElement(tag);
                const allowed = allowedAttrs[tag] || [];
                for (const attr of allowed) {
                    if (node.hasAttribute(attr)) {
                        const val = node.getAttribute(attr);
                        if ((attr === 'href' || attr === 'src') && val.toLowerCase().startsWith('javascript:'))
                            continue;
                        if (attr === 'href' && !val.match(/^(https?:|mailto:|tel:|#|\/)/i)) continue;
                        newNode.setAttribute(attr, val);
                    }
                }
                for (const child of node.childNodes) {
                    const cleanChild = cleanNode(child);
                    if (cleanChild) newNode.appendChild(cleanChild);
                }
                return newNode;
            }
            let result = '';
            for (const child of body.childNodes) {
                const cleanChild = cleanNode(child);
                if (cleanChild) {
                    result += cleanChild.outerHTML || cleanChild.textContent || '';
                }
            }
            return result;
        }

        function isSafeUsername(username) {
            if (!username) return false;
            if (username.length > 15) return false;
            const cleaned = cleanHtml(username);
            return cleaned === username.trim();
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

        // Pure JavaScript SHA-256 implementation for old WebView compatibility
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

        function generateLocalNonce() {
            const arr = new Uint8Array(16);
            crypto.getRandomValues(arr);
            return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        async function recordLogin(username, ip) {
            try {
                await sb.from(TABLE_LOGIN_HISTORY).insert({
                    username: username,
                    login_time: new Date().toISOString(),
                    ip_address: ip || 'unknown'
                });
            } catch (e) { /* ignore */ }
        }

        async function getClientIP() {
            try {
                const res = await fetch('https://api.ipify.org?format=json');
                const data = await res.json();
                return data.ip;
            } catch (e) { return 'unknown'; }
        }

        function showLogin() {
            document.getElementById('registerScreen').classList.add('hidden');
            document.getElementById('loginScreen').classList.remove('hidden');
            hideEl('regError');
            hideEl('regSuccess');
            document.getElementById('authContainer').style.display = 'flex';
            document.getElementById('appContainer').style.display = 'none';
        }

        function showRegister() {
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('registerScreen').classList.remove('hidden');
            hideEl('loginError');
        }

        async function doRegister() {
            hideEl('regError');
            hideEl('regSuccess');
            const username = document.getElementById('regUsername').value.trim();
            const password = document.getElementById('regPassword').value;
            const password2 = document.getElementById('regPassword2').value;
            if (!username) return showEl('regError', '请输入用户名');
            if (username.length < 2) return showEl('regError', '用户名至少 2 个字符');
            if (username.length > 15) return showEl('regError', '用户名最多 15 个字符');
            for (const word of FORBIDDEN_WORDS) {
                if (username.includes(word)) {
                    return showEl('regError', '存在敏感词，请更换用户名');
                }
            }
            if (!isSafeUsername(username)) {
                return showEl('regError', '用户名包含不安全字符，请重新输入');
            }
            if (password.length < 6) return showEl('regError', '密码至少 6 个字符');
            if (password !== password2) return showEl('regError', '两次密码不一致');

            try {
                // v040: Try check_username_exists RPC first
                let usernameExists = false;
                try {
                    const { data: rpcData } = await sb.rpc('check_username_exists', { p_username: username });
                    if (rpcData && rpcData.exists) usernameExists = true;
                } catch (e) { /* RPC not found, fallback */ }
                if (!usernameExists) {
                    try {
                        const { data: rpcData } = await sb.rpc('get_user_profile', { p_username: username });
                        if (rpcData && rpcData.success !== false) usernameExists = true;
                    } catch (e) { /* RPC not found, fallback */ }
                }
                if (!usernameExists) {
                    const { data: existing } = await sb.from(TABLE_USERS).select('username').eq('username', username)
                        .maybeSingle();
                    if (existing) usernameExists = true;
                }
                if (usernameExists) return showEl('regError', '该用户名已被使用');

                const passwordHash = await hashPassword(password);
                let regError = null;
                let regSessionToken = null;
                try {
                    const { data: regData, error: rpcError } = await sb.rpc('register_user_secure', {
                        p_username: username,
                        p_password_hash: passwordHash
                    });
                    if (rpcError) {
                        regError = rpcError;
                    } else if (regData && regData.session_token) {
                        regSessionToken = regData.session_token;
                    }
                } catch (e) { regError = e; }

                if (regError) {
                    const { error } = await sb.rpc('register_user', {
                        p_username: username,
                        p_password_hash: passwordHash
                    });
                    if (error) {
                        if (error.message.includes('duplicate') || error.message.includes('unique')) return showEl(
                            'regError', '该用户名已被使用');
                        return showEl('regError', '注册失败: ' + error.message);
                    }
                }

                currentUser = username;
                isAdmin = false;
                const sessionToken = regSessionToken || generateLocalNonce();
                localStorage.setItem('mjchat_session', JSON.stringify({ username: username, token: sessionToken }));
                showEl('regSuccess', '注册成功！正在进入...');
                setTimeout(() => {
                    clearRegForm();
                    showGlobalLoading('登录中', '欢迎 ' + currentUser);
                    authorizeEnterApp();
                    enterApp();
                }, 1200);
            } catch (e) {
                showEl('regError', '注册失败，请重试');
            }
        }

        function clearRegForm() {
            document.getElementById('regUsername').value = '';
            document.getElementById('regPassword').value = '';
            document.getElementById('regPassword2').value = '';
        }

        async function doLogin() {
            hideEl('loginError');
            const username = document.getElementById('loginUsername').value.trim();
            const password = document.getElementById('loginPassword').value;
            if (!username) return showEl('loginError', '请输入用户名');
            if (!password) return showEl('loginError', '请输入密码');
            if (!checkRateLimit('login', 5, 60000)) {
                showEl('loginError', '登录尝试过于频繁，请1分钟后再试');
                return;
            }

            // v040: Check if Supabase client is available before attempting login
            if (!sb) {
                showEl('loginError', '连接服务失败，请刷新页面重试');
                return;
            }

            showGlobalLoading('登录中', '验证身份');

            // v040: Login timeout - abort if login takes too long
            var _loginTimedOut = false;
            var _loginTimeout = setTimeout(function() {
                _loginTimedOut = true;
                hideGlobalLoading();
                showEl('loginError', '登录超时，请检查网络后重试');
            }, 20000);

            try {
                const passwordHash = await hashPassword(password);
                let userData = null;
                let loginError = null;

                // v040: First attempt with secure rate-limited RPC
                try {
                    const { data: secureData, error: secureError } = await sb.rpc('verify_login_secure_rate_limited', {
                        p_username: username,
                        p_password_hash: passwordHash
                    });
                    if (!secureError && secureData) {
                        userData = secureData;
                    } else if (secureError) {
                        // 若限流 RPC 明确返回"过于频繁"，立即终止，
                        // 避免回退到无内置限流的 verify_login_secure / verify_login 绕过限流
                        const em = (secureError.message || '') + '';
                        if (/过于频繁|too many|rate.?limit|429/i.test(em)) {
                            clearTimeout(_loginTimeout);
                            hideGlobalLoading();
                            return showEl('loginError', secureError.message || '登录尝试过于频繁，请稍后再试');
                        }
                        loginError = secureError;
                    }
                } catch (e) {
                    // v040: Rate-limited RPC might not exist, fall through
                }

                // v040: Fallback to regular secure login
                if (!userData && loginError) {
                    try {
                        const { data: secureData, error: secureError } = await sb.rpc('verify_login_secure', {
                            p_username: username,
                            p_password_hash: passwordHash
                        });
                        if (!secureError && secureData) {
                            userData = secureData;
                            loginError = null;
                        } else if (secureError) {
                            loginError = secureError;
                        }
                    } catch (e) { loginError = e; }
                }

                // v040: If first attempts failed, try legacy RPC
                if (!userData && loginError) {
                    try {
                        const { data: legacyData, error: legacyError } = await sb.rpc('verify_login', {
                            p_username: username,
                            p_password_hash: passwordHash
                        });
                        if (!legacyError && legacyData) {
                            userData = legacyData;
                            loginError = null;
                        } else if (legacyError) {
                            loginError = legacyError;
                        }
                    } catch (e) {
                        // All RPC calls failed, keep the original loginError
                    }
                }

                // v040: Check if timeout occurred during RPC calls
                if (_loginTimedOut) return;

                if (loginError) {
                    clearTimeout(_loginTimeout);
                    hideGlobalLoading();
                    return showEl('loginError', '登录失败: ' + (loginError.message || loginError));
                }
                if (!userData || userData.success === false) {
                    clearTimeout(_loginTimeout);
                    hideGlobalLoading();
                    return showEl('loginError', (userData && userData.message) || '用户名或密码错误');
                }
                if (userData.banned) {
                    clearTimeout(_loginTimeout);
                    hideGlobalLoading();
                    return showEl('loginError', '您的账户已被封禁，无法登录');
                }
                currentUser = username;
                isAdmin = (userData.role === 'admin');
                currentAvatarUrl = userData.avatar_url || '';
                userAvatarCache[currentUser] = currentAvatarUrl;
                const sessionToken = userData.session_token || await hashPassword(passwordHash);
                localStorage.setItem('mjchat_session', JSON.stringify({ username: username, token: sessionToken }));
                document.getElementById('loginPassword').value = '';
                updateLoadingText('登录中', '欢迎 ' + currentUser);

                // v040: getClientIP with timeout - don't block login if IP fetch fails
                var ip = 'unknown';
                try {
                    ip = await Promise.race([
                        getClientIP(),
                        new Promise(function(resolve) { setTimeout(function() { resolve('unknown'); }, 3000); })
                    ]);
                } catch (e) { ip = 'unknown'; }

                // v040: recordLogin with timeout - don't block login if recording fails
                try {
                    await Promise.race([
                        recordLogin(username, ip),
                        new Promise(function(resolve) { setTimeout(resolve, 5000); })
                    ]);
                } catch (e) { /* ignore */ }

                // v040: Check if timeout occurred during post-login operations
                if (_loginTimedOut) return;

                clearTimeout(_loginTimeout);
                authorizeEnterApp();
                enterApp();
            } catch (e) {
                clearTimeout(_loginTimeout);
                hideGlobalLoading();
                if (!_loginTimedOut) {
                    showEl('loginError', '登录失败，请重试');
                }
            }
        }

        let _enterAppAuthorized = false;
        function authorizeEnterApp() { _enterAppAuthorized = true; }
        async function enterApp() {
            if (isEntered) return;
            if (!_enterAppAuthorized) {
                console.error('enterApp 未授权调用');
                showLogin();
                return;
            }
            // v040: Check if Supabase client is available
            if (!sb) {
                showLogin();
                showEl('loginError', '连接服务失败，请刷新页面重试');
                return;
            }
            _enterAppAuthorized = false;
            showGlobalLoading('连接中', '正在加载数据');
            document.getElementById('authContainer').style.display = 'none';
            document.getElementById('appContainer').style.display = 'flex';

            try {
                // v040: Make connectPublic non-blocking - if it fails or takes too long,
                // still enter app and retry public chat connection in background
                try {
                    // v040: Race connectPublic against a 20-second timeout
                    await Promise.race([
                        connectPublic(),
                        new Promise(function(_, reject) {
                            setTimeout(function() { reject(new Error('公聊连接超时')); }, 20000);
                        })
                    ]);
                } catch (pubErr) {
                    console.error('[enterApp] connectPublic failed, will retry:', pubErr);
                    // Don't block the entire app - continue with private chat
                }
                await loadPrivateSessions();
                setupGlobalPrivateListener();
                restoreUnreadCounts();
                restorePrivateUnreadFromSessions();
                updatePublicBadge();
                updateBackBadge();
                pageHistory = ['home'];
                document.getElementById('homePage').classList.add('active');
                document.getElementById('publicPage').classList.remove('active');
                document.getElementById('privatePage').classList.remove('active');
                document.getElementById('searchPage').classList.remove('active');
                isEntered = true;
                hideGlobalLoading();
                updateHomeMenu();
                updatePublicMenu();
                renderPrivateList();
                initEmojiPicker();
                initPrivateEmojiPicker();
                initInteractions();
                initPrivateInteractions();
                updatePublicEntry();
                updatePublicBadge();
                updateAllAvatars();

                const publicMessagesEl = document.getElementById('publicMessages');
                setupScrollHandlers(publicMessagesEl);

            } catch (err) {
                hideGlobalLoading();
                showLogin();
                showEl('loginError', '连接失败: ' + (err.message || '请检查网络'));
                console.error('enterApp error:', err);
            }
        }

        function updateAllAvatars() {
            loadUserAvatars(Object.keys(userAvatarCache).concat([currentUser])).then(() => {
                renderPrivateList();
                renderOnlineUsers();
                document.querySelectorAll('#publicMessages .msg-row .avatar').forEach(av => {
                    const sender = av.dataset.sender;
                    if (sender && userAvatarCache[sender]) {
                        av.style.backgroundImage = `url(${userAvatarCache[sender]})`;
                        av.textContent = '';
                    }
                });
                document.querySelectorAll('#privateMessages .msg-row .avatar').forEach(av => {
                    const sender = av.dataset.username;
                    if (sender && userAvatarCache[sender]) {
                        av.style.backgroundImage = `url(${userAvatarCache[sender]})`;
                        av.textContent = '';
                    }
                });
                updateHomeMenu();
                updatePublicMenu();
            });
        }

        async function loadUserAvatars(usernames) {
            const unique = [...new Set(usernames.filter(n => n && !userAvatarCache.hasOwnProperty(n)))];
            if (unique.length === 0) return;
            try {
                const { data, error } = await sb.from(TABLE_USERS)
                    .select('username, avatar_url')
                    .in('username', unique);
                if (!error && data) {
                    data.forEach(u => { userAvatarCache[u.username] = u.avatar_url || ''; });
                    unique.forEach(n => { if (!userAvatarCache.hasOwnProperty(n)) userAvatarCache[n] = ''; });
                } else if (error) {
                    for (const name of unique) {
                        try {
                            const { data: rpcData } = await sb.rpc('get_user_profile', { p_username: name });
                            if (rpcData && rpcData.success !== false) {
                                userAvatarCache[name] = rpcData.avatar_url || '';
                            } else {
                                userAvatarCache[name] = '';
                            }
                        } catch (e) {
                            userAvatarCache[name] = '';
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }

        function applyAvatarToElement(el, username) {
            if (!el || !username) return;
            const url = userAvatarCache[username];
            if (url) {
                el.style.backgroundImage = `url(${url})`;
                el.textContent = '';
            } else {
                el.style.backgroundImage = '';
                el.textContent = username.charAt(0).toUpperCase();
            }
        }

        let recentPrivateNotifications = {};

        function notifyPrivateMsg(sessionId, sender) {
            if (publicChannel) {
                publicChannel.send({
                    type: 'broadcast',
                    event: 'private_msg_notification',
                    payload: { session_id: sessionId, sender: sender, timestamp: Date.now() }
                });
            }
        }

        function handlePrivateNotification(sessionId, sender) {
            const mySessions = (window.privateSessions || []);
            const isMySession = mySessions.some(s => s.id === sessionId);
            if (!isMySession && sender !== currentUser) {
                loadPrivateSessions().then(() => {
                    const updated = (window.privateSessions || []);
                    if (updated.some(s => s.id === sessionId) && sender !== currentUser) {
                        incrementUnread(sessionId);
                    }
                });
                return;
            }
            if (privateChatActive && privateSessionId === sessionId) return;
            const now = Date.now();
            const key = sessionId + ':' + Math.floor(now / 3000);
            if (recentPrivateNotifications[key]) return;
            recentPrivateNotifications[key] = true;
            Object.keys(recentPrivateNotifications).forEach(k => {
                if (now - parseInt(k.split(':')[1]) * 3000 > 10000) delete recentPrivateNotifications[k];
            });
            loadPrivateSessions().then(() => {
                if (sender !== currentUser) {
                    incrementUnread(sessionId);
                }
            });
        }

        function setupGlobalPrivateListener() {
            if (globalPrivateChannel) {
                try { sb.removeChannel(globalPrivateChannel); } catch(e) {}
                globalPrivateChannel = null;
            }
            if (privatePollTimer) { clearInterval(privatePollTimer); privatePollTimer = null; }


            if (publicChannel) {
                publicChannel.on('broadcast', { event: 'private_msg_notification' }, (p) => {
                    try {
                        const data = p.payload;
                        if (!data || !data.session_id) return;
                        handlePrivateNotification(data.session_id, data.sender);
                    } catch (e) { /* ignore */ }
                });
                publicChannel.on('broadcast', { event: 'avatar_changed' }, (p) => {
                    const data = p.payload;
                    if (!data || !data.username) return;
                    userAvatarCache[data.username] = data.avatar_url || '';
                    const selName = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(data.username) : data.username.replace(/["\\]/g, '');
                    document.querySelectorAll('[data-sender="' + selName + '"]').forEach(el => {
                        applyAvatarToElement(el, data.username);
                    });
                    document.querySelectorAll('[data-username="' + selName + '"]').forEach(el => {
                        applyAvatarToElement(el, data.username);
                    });
                    renderPrivateList();
                    renderOnlineUsers();
                });
                publicChannel.on('broadcast', { event: 'session_deleted' }, (p) => {
                    try {
                        const data = p.payload;
                        if (!data || !data.session_id) return;
                        if (data.target === currentUser && privateSessionId === data.session_id && privateChatActive) {
                            showSnackbar(`${data.deleted_by} 删除了你们的聊天`);
                            leavePrivateChat();
                        }
                        window.privateSessions = (window.privateSessions || []).filter(s => s.id !== data.session_id);
                        renderPrivateList();
                    } catch (e) { /* ignore */ }
                });
            }

            privatePollTimer = setInterval(async () => {
                if (!sb || !currentUser) return;
                try {
                    const prev = window.privateSessions ?
                        window.privateSessions.map(s => s.id + ':' + (s.updated_at || '') + ':' + (s.last_message || '')) : [];
                    await loadPrivateSessions();
                    const curr = window.privateSessions ?
                        window.privateSessions.map(s => s.id + ':' + (s.updated_at || '') + ':' + (s.last_message || '')) : [];
                    if (JSON.stringify(prev) !== JSON.stringify(curr)) {
                        if (privateChatActive && privateSessionId) {
                            await loadPrivateMessages(privateSessionId);
                        }
                    }
                } catch (e) { /* ignore */ }
            }, 10000);
        }

        let recentSystemMsgs = {};

        function isGarbledText(text) {
            if (!text) return false;
            if (text.includes('\uFFFD')) return true;
            if (text.includes('锟斤拷')) return true;
            let rareCharCount = 0;
            let consecutiveRare = 0;
            let maxConsecutiveRare = 0;
            for (let i = 0; i < text.length; i++) {
                const c = text.charCodeAt(i);
                if (c >= 0x3400 && c <= 0x4DBF) {
                    rareCharCount++;
                    consecutiveRare++;
                    maxConsecutiveRare = Math.max(maxConsecutiveRare, consecutiveRare);
                } else if (c >= 0x4E00 && c <= 0x9FFF) {
                    consecutiveRare = 0;
                } else {
                    consecutiveRare = 0;
                }
                if (c >= 0x20000) {
                    rareCharCount++;
                    consecutiveRare++;
                    maxConsecutiveRare = Math.max(maxConsecutiveRare, consecutiveRare);
                }
            }
            if (rareCharCount > 3 || maxConsecutiveRare >= 2) return true;
            let uncommonCount = 0;
            const commonRange = /^[\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEFa-zA-Z0-9\s\u3001\u3002\uff0c\uff01\uff1f\uff1a\uff1b\u300a\u300b\u3010\u3011+\-_=!@#$%^&*(){}[\]|;:'",.<>?\/\\`~]*$/;
            if (!commonRange.test(text)) {
                for (let i = 0; i < text.length; i++) {
                    const c = text.charCodeAt(i);
                    if ((c >= 0x3040 && c <= 0x30FF) || (c >= 0x3400 && c <= 0x4DBF)) {
                        uncommonCount++;
                    }
                }
                if (uncommonCount > 2) return true;
            }
            return false;
        }

        async function broadcastSystemMsg(text) {
            if (!text || typeof text !== 'string') return;
            if (isGarbledText(text)) {
                console.warn('拦截到乱码系统消息，已阻止:', text);
                return;
            }
            const now = Date.now();
            if (recentSystemMsgs[text] && now - recentSystemMsgs[text] < 5000) return;
            recentSystemMsgs[text] = now;
            Object.keys(recentSystemMsgs).forEach(k => {
                if (now - recentSystemMsgs[k] > 10000) delete recentSystemMsgs[k];
            });
            try {
                const tenSecondsAgo = new Date(now - 10000).toISOString();
                const { data } = await sb.from(TABLE_PUBLIC_MSG)
                    .select('id')
                    .eq('sender', 'system')
                    .eq('text', text)
                    .gte('created_at', tenSecondsAgo)
                    .limit(1);
                if (data && data.length > 0) return;
            } catch (e) { /* query failed, continue */ }
            sendSystemMessageSecure(text).then(r => {
                if (r && r.success !== false) updatePublicEntry();
            }).catch(e => {});
        }

        async function connectPublic() {
            return new Promise((resolve, reject) => {
                let resolved = false;
                presenceSynced = false;
                presenceReady = false;
                loadPublicHistory()
                    .then(() => {
                        publicChannel = sb.channel(CHANNEL_PUBLIC, { config: { presence: { key: clientId } } });
                        publicChannel.on('postgres_changes', { event: 'INSERT', schema: 'public', table: TABLE_PUBLIC_MSG },
                            p => {
                                const msg = p.new;
                                handlePublicMessage(msg);
                                updatePublicEntry();
                                const container = document.getElementById('publicMessages');
                                if (!isUserScrolledUp && container) {
                                    scrollToBottom(container);
                                    updateScrollButton(container);
                                }
                            });
                        publicChannel.on('broadcast', { event: 'clear_messages' }, () => {
                            handlePublicCleared();
                            updatePublicEntry();
                        });
                        publicChannel.on('broadcast', { event: 'delete_message' }, p => {
                            handlePublicDeleted(p.payload.id);
                            updatePublicEntry();
                        });
                        publicChannel.on('broadcast', { event: 'user_banned' }, (p) => {
                            if (p.payload.username === currentUser) {
                                // 广播可被伪造：先向服务端核实封禁状态，核实失败(unknown)时回退为信任，避免功能失效
                                verifyServerAccountState(currentUser).then(state => {
                                    if (state === 'banned' || state === 'unknown') {
                                        showSnackbar('您已被封禁，即将下线');
                                        setTimeout(() => logout(), 2000);
                                    }
                                });
                            } else if (p.payload.initiator === currentUser) {
                                broadcastSystemMsg(`用户 ${p.payload.username} 已被封禁`);
                            }
                        });
                        publicChannel.on('broadcast', { event: 'user_deleted' }, (p) => {
                            const name = p.payload.username;
                            if (p.payload.forceLogout && name === currentUser) {
                                verifyServerAccountState(name).then(state => {
                                    if (state === 'deleted' || state === 'unknown') {
                                        showSnackbar('您的账号已注销，即将刷新');
                                        setTimeout(() => location.reload(), 1000);
                                    }
                                });
                            } else if (p.payload.initiator === currentUser) {
                                broadcastSystemMsg(`用户 ${name} 已注销`);
                            }
                            refreshPublicMessages();
                            updatePublicEntry();
                        });
                        publicChannel.on('broadcast', { event: 'force_logout' }, (p) => {
                            if (p.payload.username === currentUser) {
                                showSnackbar('您已被管理员强制下线');
                                setTimeout(() => logout(), 1000);
                            }
                        });
                        publicChannel
                            .on('presence', { event: 'sync' }, () => {
                                onlineUsers = publicChannel.presenceState();
                                renderOnlineUsers();
                                var onlineNames = [];
                                var vals = Object.values(onlineUsers);
                                for (var vi = 0; vi < vals.length; vi++) {
                                    var flatVals = vals[vi];
                                    if (Array.isArray(flatVals)) {
                                        for (var vj = 0; vj < flatVals.length; vj++) {
                                            if (flatVals[vj] && flatVals[vj].name) onlineNames.push(flatVals[vj].name);
                                        }
                                    }
                                }
                                loadUserAvatars(onlineNames).then(function() { renderOnlineUsers(); });
                                if (privateChatActive) updatePrivateChatStatus();
                                updatePrivateListStatusDots();
                                if (!presenceSynced) {
                                    presenceSynced = true;
                                    setTimeout(() => { presenceReady = true; }, 3000);
                                }
                            })
                            .subscribe(async (status) => {
                                if (status === 'SUBSCRIBED') {
                                    updatePublicConn(true);
                                    await publicChannel.track({ name: currentUser, online_at: new Date()
                                            .toISOString() });
                                    if (!resolved) {
                                        resolved = true;
                                        resolve();
                                    }
                                } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
                                    updatePublicConn(false);
                                    if (!resolved) {
                                        resolved = true;
                                        reject(new Error('公共频道订阅失败'));
                                    }
                                }
                            });
                        setTimeout(() => {
                            if (!resolved) {
                                resolved = true;
                                reject(new Error('连接超时，请检查网络'));
                            }
                        }, 15000);
                    })
                    .catch(err => {
                        if (!resolved) {
                            resolved = true;
                            reject(err);
                        }
                    });
            });
        }

        async function loadPublicHistory() {
            try {
                let result = await sb.from(TABLE_PUBLIC_MSG).select(
                        'id, sender, text, image_url, audio_url, audio_dur, msg_version, created_at, reply_to_id, reply_content, sender_deleted, is_system'
                        )
                    .order('created_at', { ascending: false }).limit(HISTORY_LIMIT);
                if (result.error && result.error.message && result.error.message.includes('reply_to_id')) {
                    result = await sb.from(TABLE_PUBLIC_MSG).select(
                            'id, sender, text, image_url, audio_url, audio_dur, msg_version, created_at, sender_deleted, is_system'
                            )
                        .order('created_at', { ascending: false }).limit(HISTORY_LIMIT);
                }
                if (result.error && result.error.message && result.error.message.includes('sender_deleted')) {
                    result = await sb.from(TABLE_PUBLIC_MSG).select(
                            'id, sender, text, image_url, audio_url, audio_dur, msg_version, created_at, is_system')
                        .order('created_at', { ascending: false }).limit(HISTORY_LIMIT);
                }
                if (result.error && result.error.message && result.error.message.includes('msg_version')) {
                    result = await sb.from(TABLE_PUBLIC_MSG).select(
                            'id, sender, text, image_url, audio_url, audio_dur, created_at, sender_deleted, is_system')
                        .order('created_at', { ascending: false }).limit(HISTORY_LIMIT);
                }
                if (result.error && result.error.message && result.error.message.includes('audio_url')) {
                    result = await sb.from(TABLE_PUBLIC_MSG).select(
                            'id, sender, text, image_url, msg_version, created_at, sender_deleted, is_system')
                        .order('created_at', { ascending: false }).limit(HISTORY_LIMIT);
                }
                if (result.error && result.error.message && result.error.message.includes('image_url')) {
                    result = await sb.from(TABLE_PUBLIC_MSG).select(
                            'id, sender, text, created_at, sender_deleted, is_system')
                        .order('created_at', { ascending: false }).limit(HISTORY_LIMIT);
                }
                const { data, error } = result;
                const el = document.querySelector('#publicMessages .system-msg');
                if (el) el.remove();
                if (error) {
                    console.error('loadPublicHistory error:', error);
                    addPublicSystemMsg('加载历史消息失败');
                    return;
                }
                if (!data || data.length === 0) {
                    publicHasMore = false;
                    return;
                }
                publicHasMore = data.length >= HISTORY_LIMIT;
                data.reverse().forEach(m => handlePublicMessage(m, true));
                const senders = [...new Set(data.map(m => m.sender).filter(s => s && s !== 'system'))];
                await loadUserAvatars(senders);
                document.querySelectorAll('#publicMessages .msg-row .avatar').forEach(av => {
                    const sender = av.dataset.sender;
                    if (sender && userAvatarCache[sender]) {
                        av.style.backgroundImage = `url(${userAvatarCache[sender]})`;
                        av.textContent = '';
                    }
                });
                const container = document.getElementById('publicMessages');
                if (container) {
                    setTimeout(() => {
                        scrollToBottom(container);
                        updateScrollButton(container);
                    }, 50);
                }
            } catch (e) {
                console.error('loadPublicHistory exception:', e);
            }
        }

        async function loadMorePublicMessages() {
            if (publicLoadingMore || publicMessages.length === 0) return;
            publicLoadingMore = true;
            showPublicLoadMore(true);
            try {
                const oldest = publicMessages[0].created_at;
                let result = await sb.from(TABLE_PUBLIC_MSG).select(
                        'id, sender, text, image_url, audio_url, audio_dur, msg_version, created_at, reply_to_id, reply_content, sender_deleted, is_system'
                    )
                    .lt('created_at', oldest)
                    .order('created_at', { ascending: false }).limit(PAGE_SIZE);
                if (result.error && result.error.message) {
                    for (const retryCols of [
                        'id, sender, text, image_url, audio_url, audio_dur, msg_version, created_at, sender_deleted, is_system',
                        'id, sender, text, image_url, audio_url, audio_dur, created_at, sender_deleted, is_system',
                        'id, sender, text, created_at, sender_deleted, is_system',
                        'id, sender, text, created_at, is_system'
                    ]) {
                        if (!result.error.message.includes('reply_to_id')) break;
                        result = await sb.from(TABLE_PUBLIC_MSG).select(retryCols)
                            .lt('created_at', oldest)
                            .order('created_at', { ascending: false }).limit(PAGE_SIZE);
                        if (!result.error) break;
                    }
                }
                const { data, error } = result;
                if (error || !data || data.length === 0) {
                    publicHasMore = false;
                    return;
                }
                const senders = [...new Set(data.map(m => m.sender).filter(s => s && s !== 'system'))];
                await loadUserAvatars(senders);
                const newMsgs = data.reverse().map(msg => ({
                    id: msg.id, sender: msg.sender, text: msg.text || '',
                    image_url: msg.image_url || null, audio_url: msg.audio_url || null,
                    audio_dur: msg.audio_dur || 0, msg_version: msg.msg_version || null,
                    created_at: msg.created_at, reply_to_id: msg.reply_to_id || null,
                    reply_content: msg.reply_content || null, sender_deleted: msg.sender_deleted || false,
                    is_system: msg.is_system || false
                }));
                const unique = newMsgs.filter(m => !publicMessages.some(e => e.id === m.id));
                const filtered = unique.filter(m => !(m.is_system && isGarbledText(m.text)));
                publicMessages = filtered.concat(publicMessages);
                const container = document.getElementById('publicMessages');
                const prevScrollHeight = container.scrollHeight;
                const prevScrollTop = container.scrollTop;
                container.innerHTML = '';
                publicLastDateLabel = '';
                publicMessages.forEach(m => renderPublicMessage(m));
                requestAnimationFrame(() => {
                    container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
                });
            } catch (e) {
                console.error('loadMorePublicMessages error:', e);
            } finally {
                publicLoadingMore = false;
                showPublicLoadMore(false);
            }
        }

        function showPublicLoadMore(show) {
            let indicator = document.getElementById('publicLoadMoreIndicator');
            if (show) {
                if (!indicator) {
                    indicator = document.createElement('div');
                    indicator.id = 'publicLoadMoreIndicator';
                    indicator.className = 'load-more-indicator';
                    indicator.innerHTML = '<div class="loading-spinner"><svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20"/></svg></div><span>正在加载更多消息...</span>';
                    const container = document.getElementById('publicMessages');
                    container.insertBefore(indicator, container.firstChild);
                }
                indicator.style.display = 'flex';
            } else {
                if (indicator) indicator.style.display = 'none';
            }
        }

        function handlePublicMessage(msg, isHistory = false) {
            if (publicMessages.some(m => m.id === msg.id)) return;
            if (msg.is_system && isGarbledText(msg.text)) return;
            if (msg.is_system && msg.text && (
                msg.text.includes('加入了MJChat') || msg.text.includes('离开了MJChat')
            )) return;
            const nm = {
                id: msg.id,
                sender: msg.sender,
                text: msg.text || '',
                image_url: msg.image_url || null,
                audio_url: msg.audio_url || null,
                audio_dur: msg.audio_dur || 0,
                msg_version: msg.msg_version || null,
                created_at: msg.created_at,
                reply_to_id: msg.reply_to_id || null,
                reply_content: msg.reply_content || null,
                sender_deleted: msg.sender_deleted || false,
                is_system: msg.is_system || false
            };
            publicMessages.push(nm);
            if (!userAvatarCache.hasOwnProperty(nm.sender) && !nm.is_system) {
                loadUserAvatars([nm.sender]).then(() => {
                    if (document.getElementById('publicPage').classList.contains('active')) {
                        document.querySelectorAll(`[data-sender="${nm.sender}"]`).forEach(el => {
                            applyAvatarToElement(el, nm.sender);
                        });
                    }
                });
            }
            if (document.getElementById('publicPage').classList.contains('active')) {
                renderPublicMessage(nm);
                if (!nm.is_system) {
                    markPublicRead(nm.created_at);
                }
            } else if (!isHistory && nm.sender !== currentUser && !nm.is_system) {
                publicUnread++;
                updatePublicBadge();
                updateBackBadge();
            }
        }

        function renderPublicMessage(msg) {
            const c = document.getElementById('publicMessages');
            const isOwn = msg.sender === currentUser;
            const isDeleted = msg.sender_deleted || false;
            const isSystem = msg.is_system || false;

            if (isSystem) {
                if (isGarbledText(msg.text)) {
                    return; // skip garbled messages
                }
                const d = document.createElement('div');
                d.className = 'system-msg';
                d.innerHTML = `<span>${escapeHtml(msg.text)}</span>`;
                c.appendChild(d);
                return;
            }

            const date = new Date(msg.created_at);
            const dl = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
            if (dl !== publicLastDateLabel) {
                publicLastDateLabel = dl;
                const s = document.createElement('div');
                s.className = 'date-divider';
                s.innerHTML = `<span>${dl}</span>`;
                c.appendChild(s);
            }
            const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            const ci = hashStr(msg.sender) % 8;
            let bubbleContent = '';
            let msgType = 'text';
            let linkUrl = null;
            let imageUrl = null;

            let replyHtml = '';
            if (msg.reply_to_id) {
                const repliedMsg = publicMessages.find(m => m.id === msg.reply_to_id);
                let replyPreviewContent = '';
                if (repliedMsg) {
                    const senderDisplay = repliedMsg.sender_deleted ? `[用户已注销] ${repliedMsg.sender}` : repliedMsg.sender;
                    let contentPreview = '';
                    if (repliedMsg.image_url) {
                        contentPreview = `<img src="${escapeAttr(repliedMsg.image_url)}" style="max-width:100px;max-height:100px;border-radius:4px;">`;
                    } else if (repliedMsg.audio_url) {
                        const dur = repliedMsg.audio_dur || 0;
                        const mins = String(Math.floor(dur / 60)).padStart(2, '0');
                        const secs = String(dur % 60).padStart(2, '0');
                        contentPreview = `[语音] ${mins}:${secs}`;
                    } else if (repliedMsg.text && repliedMsg.text.startsWith('🔗 ')) {
                        const linkMatch = repliedMsg.text.match(/🔗 (.*?) → (.*)/);
                        if (linkMatch) contentPreview = `[链接] ${escapeHtml(linkMatch[1])}`;
                        else contentPreview = escapeHtml(repliedMsg.text);
                    } else if (repliedMsg.text && repliedMsg.text.startsWith('📎 ')) {
                        const fileMatch = repliedMsg.text.match(/📎 (.*?) → (.*)/);
                        if (fileMatch) contentPreview = `[文件] ${escapeHtml(fileMatch[1])}`;
                        else contentPreview = escapeHtml(repliedMsg.text);
                    } else {
                        contentPreview = escapeHtml(repliedMsg.text);
                    }
                    replyPreviewContent =
                        `<span class="reply-sender">${escapeHtml(senderDisplay)}</span><br><span class="reply-content">${contentPreview}</span>`;
                } else {
                    replyPreviewContent = escapeHtml(msg.reply_content || '');
                }
                if (replyPreviewContent) {
                    replyHtml = `<div class="reply-preview-block" data-reply-id="${escapeAttr(msg.reply_to_id)}" onclick="jumpToMessage('${escapeAttr(msg.reply_to_id)}', 'public')">↩ ${replyPreviewContent}</div>`;
                }
            }

            if (msg.image_url) {
                imageUrl = msg.image_url;
                let imageUrls = [];
                if (msg.text && msg.text.startsWith('🖼️ ')) {
                    const matches = msg.text.match(/!\[.*?\]\((.*?)\)/g);
                    if (matches && matches.length > 0) {
                        imageUrls = matches.map(m => {
                            const match = m.match(/!\[.*?\]\((.*?)\)/);
                            return match ? match[1] : null;
                        }).filter(Boolean);
                    }
                }
                if (imageUrls.length > 1) {
                    bubbleContent = `<div class="image-grid">${imageUrls.map(url => `<img src="${escapeAttr(url)}" onclick="previewImage('${escapeAttr(url)}')" draggable="false" oncontextmenu="return false;">`).join('')}</div>`;
                    msgType = 'image';
                } else {
                    bubbleContent =
                        `<img src="${escapeAttr(msg.image_url)}" onclick="previewImage('${escapeAttr(msg.image_url)}')" draggable="false" oncontextmenu="return false;">`;
                    msgType = 'image';
                }
                if (msg.text && !msg.text.startsWith('🖼️ ')) {
                    bubbleContent += `<div style="margin-top:4px;">${cleanHtml(msg.text)}</div>`;
                }
            } else if (msg.audio_url) {
                const dur = msg.audio_dur || 0;
                const mins = String(Math.floor(dur / 60)).padStart(2, '0');
                const secs = String(dur % 60).padStart(2, '0');
                const durStr = `${mins}:${secs}`;
                const waveBars = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16 + 4)).map(h =>
                    `<div class="voice-wave" style="height:${h}px"></div>`).join('');
                bubbleContent =
                    `<div class="voice-msg-wrap" data-audio="${escapeAttr(msg.audio_url)}" data-dur="${dur}" onclick="toggleVoicePlay(this, event)"><button class="voice-play-btn"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button><div class="voice-waves">${waveBars}</div><span class="voice-dur">${durStr}</span></div>`;
                msgType = 'voice';
            } else {
                const marked = parseMarkedText(msg.text);
                if (marked && marked.type === 'voice') {
                    const dur = marked.duration || 0;
                    const mins = String(Math.floor(dur / 60)).padStart(2, '0');
                    const secs = String(dur % 60).padStart(2, '0');
                    const durStr = `${mins}:${secs}`;
                    const waveBars = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16 + 4)).map(h =>
                        `<div class="voice-wave" style="height:${h}px"></div>`).join('');
                    if (marked.url) {
                        bubbleContent =
                            `<div class="voice-msg-wrap" data-audio="${escapeAttr(marked.url)}" data-dur="${dur}" onclick="toggleVoicePlay(this, event)"><button class="voice-play-btn"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button><div class="voice-waves">${waveBars}</div><span class="voice-dur">${durStr}</span></div>`;
                    } else {
                        bubbleContent = `<div class="voice-msg-wrap"><span class="voice-dur">${durStr}</span><span style="font-size:0.75rem;color:var(--md-on-surface-dim);margin-left:8px;">请升级到最新版本播放</span></div>`;
                    }
                    msgType = 'voice';
                } else if (marked && marked.type === 'link') {
                    linkUrl = marked.url;
                    bubbleContent =
                        `<a href="${escapeAttr(marked.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(marked.displayText)}</a>`;
                    msgType = 'link';
                } else if (marked && marked.type === 'file') {
                    if (isImageFile(marked.fileInfo)) {
                        const fileParts = marked.fileInfo.match(/^(.*?)\s*\(([\d.]+)\s*KB\)$/);
                        const fileName = fileParts ? fileParts[1] : marked.fileInfo;
                        bubbleContent = `<img src="${escapeAttr(marked.url)}" alt="${escapeAttr(fileName)}" loading="lazy" style="max-width:280px;max-height:280px;border-radius:12px;cursor:pointer;" onclick="viewImage('${escapeAttr(marked.url)}')">`;
                        msgType = 'image';
                        imageUrl = marked.url;
                    } else {
                        const iconPath = getFileIconSvg(marked.fileInfo);
                        const fileParts = marked.fileInfo.match(/^(.*?)\s*\(([\d.]+)\s*KB\)$/);
                        const fileName = fileParts ? fileParts[1] : marked.fileInfo;
                        const fileSize = fileParts ? fileParts[2] : '';
                        bubbleContent =
                            `<a href="${escapeAttr(marked.url)}" target="_blank" rel="noopener noreferrer" class="file-msg"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">${iconPath}</svg><span>${escapeHtml(fileName)}${fileSize ? ` (${escapeHtml(fileSize)} KB)` : ''}</span></a>`;
                        msgType = 'file';
                        linkUrl = marked.url;
                    }
                } else {
                    let cleaned = cleanHtml(msg.text);
                    cleaned = cleaned.replace(/@([\w\u4e00-\u9fa5]+)/g, '<b>@$1</b>');
                    bubbleContent = cleaned;
                    msgType = 'text';
                }
            }

            const senderDisplay = isDeleted ? `[用户已注销] ${msg.sender}` : msg.sender;
            const senderClass = isDeleted ? 'sender deleted' : 'sender';
            const avatarClass = isDeleted ? 'avatar av-' + ci + ' deleted' : 'avatar av-' + ci;

            const row = document.createElement('div');
            row.className = `msg-row ${isOwn ? 'own' : ''}`;
            row.dataset.msgId = msg.id;
            row.dataset.msgSender = msg.sender;
            row.dataset.msgText = msg.text || '';
            row.dataset.msgType = msgType;
            row.dataset.linkUrl = linkUrl || '';
            row.dataset.imageUrl = imageUrl || '';
            row.dataset.replyToId = msg.reply_to_id || '';
            row.dataset.replyContent = msg.reply_content || '';
            row.dataset.replySender = msg.reply_to_id ? ((function(){ var _f = publicMessages.find(function(m){ return m.id === msg.reply_to_id; }); return _f ? _f.sender : ''; })() || '') :
            '';

            let bubbleClass = 'bubble';
            if (msgType === 'image') {
                if (msg.text && msg.text.startsWith('🖼️ ') && msg.text.match(/!\[.*?\]\(.*?\)/g) && msg.text.match(
                    /!\[.*?\]\(.*?\)/g).length > 1) {
                    bubbleClass += ' image-bubble';
                } else {
                    bubbleClass += ' image-single';
                }
            }

            row.innerHTML = `
                <div class="${avatarClass}" data-sender="${escapeAttr(msg.sender)}" onclick="showUserProfile('${escapeAttr(msg.sender)}')">${escapeHtml(msg.sender.charAt(0).toUpperCase())}</div>
                <div class="content">
                    <div class="meta"><span class="${senderClass}">${escapeHtml(senderDisplay)}</span><span class="time">${time}</span></div>
                    <div class="${bubbleClass}">${replyHtml}${bubbleContent}</div>
                </div>
            `;
            const avatarElem = row.querySelector('.avatar');
            if (userAvatarCache[msg.sender]) {
                avatarElem.style.backgroundImage = `url(${userAvatarCache[msg.sender]})`;
                avatarElem.textContent = '';
            }
            row.dataset.elementId = msg.id;
            c.appendChild(row);
        }

        function jumpToMessage(msgId, type) {
            if (type === 'public') {
                const container = document.getElementById('publicMessages');
                const targetRow = container.querySelector(`.msg-row[data-msg-id="${msgId}"]`);
                if (targetRow) {
                    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    targetRow.style.transition = 'background 1s';
                    targetRow.style.background = 'rgba(74, 158, 255, 0.25)';
                    targetRow.style.marginLeft = '-16px';
                    targetRow.style.marginRight = '-16px';
                    targetRow.style.paddingLeft = '16px';
                    targetRow.style.paddingRight = '16px';
                    setTimeout(() => {
                        targetRow.style.background = 'transparent';
                        targetRow.style.marginLeft = '';
                        targetRow.style.marginRight = '';
                        targetRow.style.paddingLeft = '';
                        targetRow.style.paddingRight = '';
                    }, 2000);
                } else {
                    showSnackbar('无法定位到此消息');
                }
            } else if (type === 'private') {
                const container = document.getElementById('privateMessages');
                const targetRow = container.querySelector(`.msg-row[data-msg-id="${msgId}"]`);
                if (targetRow) {
                    targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    targetRow.style.transition = 'background 1s';
                    targetRow.style.background = 'rgba(74, 158, 255, 0.25)';
                    targetRow.style.marginLeft = '-16px';
                    targetRow.style.marginRight = '-16px';
                    targetRow.style.paddingLeft = '16px';
                    targetRow.style.paddingRight = '16px';
                    setTimeout(() => {
                        targetRow.style.background = 'transparent';
                        targetRow.style.marginLeft = '';
                        targetRow.style.marginRight = '';
                        targetRow.style.paddingLeft = '';
                        targetRow.style.paddingRight = '';
                    }, 2000);
                } else {
                    showSnackbar('无法定位到此消息');
                }
            }
        }

        function refreshPublicMessages() {
            const c = document.getElementById('publicMessages');
            c.innerHTML = '';
            publicLastDateLabel = '';
            publicMessages.forEach(m => renderPublicMessage(m));
            const container = document.getElementById('publicMessages');
            if (container && document.getElementById('publicPage').classList.contains('active')) {
                setTimeout(() => {
                    scrollToBottom(container);
                    updateScrollButton(container);
                }, 50);
            }
        }

        function updatePublicEntry() {
            const sub = document.getElementById('publicEntrySub');
            const nonSystem = publicMessages.filter(m => !m.is_system);
            if (nonSystem.length === 0) {
                sub.textContent = '点击进入聊天';
                return;
            }
            const last = nonSystem[nonSystem.length - 1];
            const sender = last.sender_deleted ? `[已注销] ${last.sender}` : last.sender;
            let content = '';
            if (last.image_url) {
                content = '🖼️ 图片';
            } else if (last.audio_url) {
                content = '🎤 语音';
            } else {
                content = getMessagePreview(last.text);
            }
            sub.textContent = `${sender}：${content}`;
        }

        function addPublicSystemMsg(text) {
            if (isGarbledText(text)) return;
            const c = document.getElementById('publicMessages');
            const d = document.createElement('div');
            d.className = 'system-msg';
            d.innerHTML = `<span>${escapeHtml(text)}</span>`;
            c.appendChild(d);
        }

        function togglePublicSendBtn() {
            document.getElementById('publicSendBtn').disabled = !document.getElementById('publicMsgInput').value.trim() &&
                !replyTarget;
        }

        function handlePublicKeyDown(e) {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                sendPublicMsg();
            }
        }

        async function sendPublicMsg() {
            const input = document.getElementById('publicMsgInput');
            let text = input.value.trim();
            if (!text && !replyTarget) {
                showSnackbar('请输入内容');
                return;
            }
            if (text) {
                text = cleanHtml(text);
                if (!text) {
                    showSnackbar('消息包含不安全内容');
                    return;
                }
            }
            document.getElementById('publicSendBtn').disabled = true;
            const payload = { sender: currentUser, text: text || '', msg_version: MJCHAT_VERSION, is_system: false };
            if (replyTarget) {
                const replied = publicMessages.find(m => m.id === replyTarget.id);
                if (replied) {
                    let previewText = '';
                    if (replied.image_url) {
                        previewText = '🖼️ 图片';
                    } else if (replied.audio_url) {
                        const dur = replied.audio_dur || 0;
                        const mins = String(Math.floor(dur / 60)).padStart(2, '0');
                        const secs = String(dur % 60).padStart(2, '0');
                        previewText = `🎤 语音 ${mins}:${secs}`;
                    } else if (replied.text && replied.text.startsWith('🔗 ')) {
                        const match = replied.text.match(/🔗 (.*?) → /);
                        previewText = match ? `🔗 ${match[1]}` : '🔗 链接';
                    } else if (replied.text && replied.text.startsWith('📎 ')) {
                        const match = replied.text.match(/📎 (.*?) → /);
                        previewText = match ? `📎 ${match[1]}` : '📎 文件';
                    } else {
                        previewText = replied.text || '';
                    }
                    payload.reply_content = `回复 @${replyTarget.sender}：${previewText}`;
                } else {
                    payload.reply_content = `回复 @${replyTarget.sender}：${replyTarget.content}`;
                }
                payload.reply_to_id = replyTarget.id;
            }
            const result = await sendPublicMessageSecure(payload);
            if (!result.success) {
                addPublicSystemMsg('发送失败: ' + (result.message || '未知错误'));
                document.getElementById('publicSendBtn').disabled = false;
                return;
            }
            input.value = '';
            autoResize(input);
            cancelPublicReply();
            togglePublicSendBtn();
            activeAgent = null;
            const container = document.getElementById('publicMessages');
            if (container) {
                scrollToBottom(container);
                updateScrollButton(container);
                isUserScrolledUp = false;
            }
            checkAgentMention(text);
        }

        async function checkAgentMention(messageText) {
            if (!messageText) return;
            const mentionMatch = messageText.match(/@([\w\u4e00-\u9fa5]+)/g);
            if (!mentionMatch) return;
            const mentionedNames = mentionMatch.map(m => m.substring(1));
            try {
                let agents = null;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('get_agents');
                    if (!rpcError && rpcData) {
                        agents = Array.isArray(rpcData) ? rpcData : [];
                    }
                } catch (e) { /* RPC fallback */ }
                if (!agents) {
                    const { data, error } = await sb.from(TABLE_AGENTS)
                        .select('id, name, provider, model, created_by, created_at');
                    if (error) return;
                    agents = data || [];
                }
                for (const name of mentionedNames) {
                    const agent = agents.find(a => a.name === name);
                    if (agent) {
                        await triggerAgentResponse(agent, messageText);
                    }
                }
            } catch (e) { /* ignore */ }
        }

        async function triggerAgentResponse(agent, userMessage) {
            try {
                if (!checkRateLimit('agent_call', 10, 60000)) {
                    showSnackbar('智能体调用过于频繁，请稍后再试');
                    return;
                }
                const cleanMsg = userMessage.replace(/@[\w\u4e00-\u9fa5]+/g, '').trim();
                if (!cleanMsg) return;

                showSnackbar(`智能体 ${agent.name} 正在思考...`);

                let response = null;
                try {
                    const { data: llmData, error: llmError } = await sb.rpc('call_agent_llm_rate_limited', {
                        p_agent_id: agent.id,
                        p_user_message: cleanMsg,
                        p_caller: currentUser,
                        p_session_token: getSessionToken()
                    });
                    if (!llmError && llmData && llmData.success) {
                        response = llmData.response;
                    } else if (llmData && llmData.message) {
                        showSnackbar(llmData.message);
                        return;
                    }
                } catch (e) { /* RPC error */ }

                if (!response) {
                    showSnackbar(`智能体 ${agent.name} 暂时无法回复`);
                    return;
                }

                let replyToId = null;
                let replyContent = null;
                const lastMsg = publicMessages[publicMessages.length - 1];
                if (lastMsg && lastMsg.sender === currentUser) {
                    replyToId = lastMsg.id;
                    replyContent = `回复 @${currentUser}：${cleanMsg}`;
                }

                let sent = false;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('send_agent_message', {
                        p_agent_name: agent.name,
                        p_content: response,
                        p_reply_to_id: replyToId,
                        p_reply_content: replyContent,
                        p_caller: currentUser,
                        p_session_token: getSessionToken()
                    });
                    if (!rpcError && rpcData && rpcData.success !== false) {
                        sent = true;
                    }
                } catch (e) { /* RPC fallback */ }
                if (!sent) {
                    await ensureAgentUserAccount(agent.name);
                    try {
                        const { data: rpcData2, error: rpcError2 } = await sb.rpc('send_agent_message', {
                            p_agent_name: agent.name,
                            p_content: response,
                            p_reply_to_id: replyToId,
                            p_reply_content: replyContent,
                            p_caller: currentUser,
                            p_session_token: getSessionToken()
                        });
                        if (!rpcError2 && rpcData2 && rpcData2.success !== false) sent = true;
                    } catch (e2) { /* give up */ }
                }
            } catch (e) { /* ignore */ }
        }

        async function ensureAgentUserAccount(agentName) {
            // Agent account creation is handled by send_agent_message RPC
            // This function just ensures the avatar cache is populated
            try {
                const { data } = await sb.from(TABLE_USERS)
                    .select('username, avatar_url').eq('username', agentName).maybeSingle();
                if (!data) return; // RPC will create the account
                if (!userAvatarCache.hasOwnProperty(agentName)) {
                    userAvatarCache[agentName] = '';
                }
            } catch (e) { /* ignore */ }
        }

        // callLLM removed - AI calls now go through server-side call_agent_llm RPC
        // API keys are NEVER exposed to the client

        function updatePublicConn(on) {
            const d = document.getElementById('publicConnDot'),
                t = document.getElementById('publicConnText');
            if (d && t) { if (on) { d.classList.add('on');
                t.textContent = '在线'; } else { d.classList.remove('on');
                t.textContent = '离线'; } }
            const el = document.getElementById('publicOnlineCount');
            if (el) el.textContent = document.getElementById('onlineCount').textContent;
            const homeConnDot = document.getElementById('connDot');
            const homeConnText = document.getElementById('connText');
            if (homeConnDot) {
                if (on) { homeConnDot.classList.add('on');
                    homeConnText.textContent = '在线'; } else { homeConnDot.classList.remove('on');
                    homeConnText.textContent = '离线'; }
            }
        }

        function handlePublicCleared() {
            publicMessages = publicMessages.filter(m => m.is_system);
            publicLastDateLabel = '';
            const c = document.getElementById('publicMessages');
            c.innerHTML = '';
            publicMessages.forEach(m => renderPublicMessage(m));
            addPublicSystemMsg('聊天记录已被清空');
            updatePublicEntry();
        }

        function handlePublicDeleted(msgId) {
            publicMessages = publicMessages.filter(m => m.id !== msgId);
            const rows = document.querySelectorAll('#publicMessages .msg-row');
            rows.forEach(row => { if (row.dataset.msgId === msgId) row.remove(); });
            updatePublicEntry();
        }

        async function clearPublicMessages() {
            const isAdm = await verifyAdminSession();
            if (!isAdm) { showSnackbar('无权限执行此操作'); return; }
            try {
                const { data, error } = await sb.rpc('admin_clear_messages', {
                    p_admin: currentUser,
                    p_session_token: getSessionToken()
                });
                if (error || (data && data.success === false)) {
                    showSnackbar('清空失败: ' + (data?.message || error?.message || ''));
                    return;
                }
                publicChannel.send({ type: 'broadcast', event: 'clear_messages', payload: {} });
                handlePublicCleared();
                showSnackbar('公共消息已清空');
            } catch (e) { showSnackbar('清空失败'); }
        }

        function toggleFeaturePanel() {
            const panel = document.getElementById('publicFeaturePanel');
            const btn = document.getElementById('publicMoreBtn');
            if (panel.classList.contains('show')) {
                panel.classList.remove('show');
                btn.classList.remove('active');
            } else {
                panel.classList.add('show');
                btn.classList.add('active');
            }
        }

        function closeFeaturePanel() {
            document.getElementById('publicFeaturePanel').classList.remove('show');
            document.getElementById('publicMoreBtn').classList.remove('active');
            closeSubPanel();
        }

        function openImagePicker() {
            closeFeaturePanel();
            document.getElementById('imageInput').click();
        }

        async function handleImageSelect(event) {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (files.length === 0) {
                showSnackbar('未选择图片');
                return;
            }

            if (files.length > MAX_IMAGES_PER_MSG) {
                showSnackbar(`一次最多选择 ${MAX_IMAGES_PER_MSG} 张图片`);
                return;
            }
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (file.size > MAX_IMAGE_SIZE) { showSnackbar(`图片 ${file.name} 超过 5MB`); return; }
                if (!file.type.startsWith('image/')) { showSnackbar(`文件 ${file.name} 不是图片`); return; }
            }

            showSnackbar(`正在上传 ${files.length} 张图片...`);
            const imageUrls = [];

            for (let i = 0; i < files.length; i++) {
                let file = files[i];
                let blobToUpload = file;
                if (file.size > COMPRESS_THRESHOLD) {
                    try {
                        blobToUpload = await compressImage(file, 1920, 0.7);
                    } catch (e) { /* use original */ }
                }
                const filePath = `chat/${Date.now()}-${generateId()}-${i}.jpg`;
                try {
                    const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filePath, blobToUpload, {
                        contentType: 'image/jpeg',
                        cacheControl: '3600'
                    });
                    if (error) {
                        showSnackbar('上传失败: ' + error.message);
                        return;
                    }
                    const { data: urlData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
                    imageUrls.push(urlData.publicUrl);
                } catch (e) {
                    showSnackbar('上传失败');
                    return;
                }
            }

            let text = '';
            if (imageUrls.length === 1) {
                text = '';
            } else {
                text = imageUrls.map(url => `![](${url})`).join('\n');
                text = '🖼️ ' + text;
            }

            const payload = {
                sender: currentUser,
                text: text,
                image_url: imageUrls[0],
                msg_version: MJCHAT_VERSION,
                is_system: false
            };
            const result = await sendPublicMessageSecure(payload);
            if (!result.success) {
                showSnackbar('发送图片失败: ' + (result.message || ''));
            }
        }

        function compressImage(file, maxSize, quality) {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = new Image();
                    img.onload = () => {
                        let w = img.width,
                            h = img.height;
                        if (w > maxSize || h > maxSize) {
                            if (w > h) { h = h * maxSize / w;
                                w = maxSize; } else { w = w * maxSize / h;
                                h = maxSize; }
                        }
                        const canvas = document.createElement('canvas');
                        canvas.width = w;
                        canvas.height = h;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, w, h);
                        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(file);
            });
        }

        let previewScale = 1;
        let previewTranslateX = 0,
            previewTranslateY = 0;
        let previewLastDist = 0;
        let previewLastX = 0,
            previewLastY = 0;

        function previewImage(url) {
            if (!url) return;
            const overlay = document.getElementById('imagePreview');
            const img = document.getElementById('previewImg');
            img.src = url;
            previewScale = 1;
            previewTranslateX = 0;
            previewTranslateY = 0;
            updatePreviewTransform();
            overlay.classList.remove('hidden');
        }

        // 文件型图片消息点击时复用图片预览
        function viewImage(url) {
            previewImage(url);
        }

        function updatePreviewTransform() {
            const img = document.getElementById('previewImg');
            img.style.transform = `scale(${previewScale}) translate(${previewTranslateX}px, ${previewTranslateY}px)`;
        }

        function closeImagePreview(e) {
            if (e && e.target !== e.currentTarget) return;
            document.getElementById('imagePreview').classList.add('hidden');
            document.getElementById('previewImg').src = '';
            previewScale = 1;
            previewTranslateX = 0;
            previewTranslateY = 0;
        }

        let previewTouchStart = false;
        document.getElementById('imagePreview').addEventListener('touchstart', function(e) {
            if (e.target.tagName !== 'IMG') return;
            const touches = e.touches;
            if (touches.length === 1) {
                previewTouchStart = true;
                previewLastX = touches[0].clientX;
                previewLastY = touches[0].clientY;
            } else if (touches.length === 2) {
                previewLastDist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1]
                    .clientY);
            }
        }, { passive: true });

        document.getElementById('imagePreview').addEventListener('touchmove', function(e) {
            if (e.target.tagName !== 'IMG') return;
            const touches = e.touches;
            if (touches.length === 1 && previewTouchStart) {
                const dx = touches[0].clientX - previewLastX;
                const dy = touches[0].clientY - previewLastY;
                previewTranslateX += dx;
                previewTranslateY += dy;
                previewLastX = touches[0].clientX;
                previewLastY = touches[0].clientY;
                updatePreviewTransform();
            } else if (touches.length === 2) {
                const dist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
                const scaleFactor = dist / previewLastDist;
                previewScale = Math.min(Math.max(previewScale * scaleFactor, 0.5), 5);
                previewLastDist = dist;
                updatePreviewTransform();
            }
        }, { passive: true });

        document.getElementById('imagePreview').addEventListener('touchend', function(e) {
            previewTouchStart = false;
        }, { passive: true });

        document.getElementById('imagePreview').addEventListener('contextmenu', function(e) { e.preventDefault(); });

        function openFilePicker() {
            closeFeaturePanel();
            document.getElementById('fileInput').click();
        }

        async function handleFileSelect(event) {
            const file = event.target.files[0];
            if (!file) return;
            event.target.value = '';
            if (file.size > 10 * 1024 * 1024) { showSnackbar('文件不能超过 10MB'); return; }
            showSnackbar('正在上传文件...');
            const ext = file.name.split('.').pop() || 'file';
            const filePath = `files/${Date.now()}-${generateId()}.${ext}`;
            try {
                const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filePath, file, { contentType: file.type ||
                        'application/octet-stream', cacheControl: '3600' });
                if (error) {
                    if (error.message.includes('bucket') || error.message.includes('not found')) showSnackbar(
                        '上传失败: 请先在 Storage 创建 chat-images Bucket');
                    else showSnackbar('上传失败: ' + error.message);
                    return;
                }
                const { data: urlData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
                const fileSize = (file.size / 1024).toFixed(1);
                const fileText = buildFileText(file.name, fileSize, urlData.publicUrl);
                const ieResult = await sendPublicMessageSecure({ text: fileText, is_system: false, msg_version: MJCHAT_VERSION });
                if (!ieResult.success) showSnackbar('发送文件失败: ' + (ieResult.message || ''));
            } catch (e) { showSnackbar('上传失败'); }
        }

        function buildFileText(filename, fileSize, url) {
            return '📎 ' + filename + ' (' + fileSize + ' KB) → ' + url;
        }

        function openLinkDialog(mode) {
            closeFeaturePanel();
            linkMode = mode || 'public';
            document.getElementById('linkDialog').classList.remove('hidden');
            document.getElementById('linkText').focus();
        }

        function hideLinkDialog() {
            document.getElementById('linkDialog').classList.add('hidden');
            document.getElementById('linkText').value = '';
            document.getElementById('linkUrl').value = '';
        }

        function showOpensourceDialog() {
            document.getElementById('opensourceDialog').classList.remove('hidden');
        }

        function closeOpensourceDialog() {
            document.getElementById('opensourceDialog').classList.add('hidden');
        }

        async function sendLink() {
            const text = document.getElementById('linkText').value.trim();
            const url = document.getElementById('linkUrl').value.trim();
            if (!url) { showSnackbar('请输入链接地址'); return; }
            if (!isSafeUrl(url)) { showSnackbar('链接地址无效，仅支持 http/https/mailto/tel'); return; }
            const displayText = text || url;
            const linkText = '🔗 ' + displayText + ' → ' + url;
            hideLinkDialog();

            if (linkMode === 'private') {
                if (!privateChannel) return;
                try {
                    const newMsg = await safeInsertPrivateMsg(privateSessionId, currentUser, linkText);
                    privateChannel.send({ type: 'broadcast', event: 'new_message', payload: newMsg });
                    privateMessages.push(newMsg);
                    if (document.getElementById('privatePage').classList.contains('active')) {
                        renderPrivateMessage(newMsg);
                        const container = document.getElementById('privateMessages');
                        if (container) {
                            scrollToBottom(container);
                            updateScrollButton(container);
                            isUserScrolledUp = false;
                        }
                    }
                    notifyPrivateMsg(privateSessionId, currentUser);
                    loadPrivateSessions();
                } catch (e) {
                    const msg = e.message || '';
                    showSnackbar(msg.includes('隐私') || msg.includes('拒收') ? msg : '发送失败: ' + msg);
                }
            } else {
                const linkResult = await sendPublicMessageSecure({ text: linkText, is_system: false, msg_version: MJCHAT_VERSION });
                if (!linkResult.success) showSnackbar('发送链接失败: ' + (linkResult.message || ''));
            }
        }

        function insertEmoji(emoji) {
            const input = document.getElementById('publicMsgInput');
            input.value += emoji;
            autoResize(input);
            togglePublicSendBtn();
        }

        function openEmojiSubPanel() {
            document.getElementById('featurePanelMain').style.display = 'none';
            document.getElementById('emojiSubPanel').classList.add('active');
        }

        function openTextEffectSubPanel() {
            document.getElementById('featurePanelMain').style.display = 'none';
            document.getElementById('textEffectSubPanel').classList.add('active');
        }

        function openVoiceSubPanel() {
            document.getElementById('featurePanelMain').style.display = 'none';
            document.getElementById('voiceSubPanel').classList.add('active');
        }

        function closeSubPanel() {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }
            document.getElementById('emojiSubPanel').classList.remove('active');
            document.getElementById('textEffectSubPanel').classList.remove('active');
            document.getElementById('voiceSubPanel').classList.remove('active');
            document.getElementById('featurePanelMain').style.display = 'block';
        }

        function applyTextEffect(tag) {
            const input = document.getElementById('publicMsgInput');
            const start = input.selectionStart;
            const end = input.selectionEnd;
            if (start === end) { showSnackbar('请先选中文字'); return; }
            const selected = input.value.substring(start, end);
            let wrapped;
            switch (tag) {
                case 'b':
                    wrapped = `<b>${selected}</b>`;
                    break;
                case 'i':
                    wrapped = `<i>${selected}</i>`;
                    break;
                case 'u':
                    wrapped = `<u>${selected}</u>`;
                    break;
                case 's':
                    wrapped = `<s>${selected}</s>`;
                    break;
                case 'none':
                    wrapped = selected;
                    break;
                default:
                    wrapped = selected;
            }
            input.setRangeText(wrapped, start, end, 'end');
            autoResize(input);
            togglePublicSendBtn();
            const newPos = start + wrapped.length;
            input.setSelectionRange(newPos, newPos);
        }

        function initEmojiPicker() {
            const EMOJIS = ['😀', '😂', '🥰', '😎', '🤔', '😴', '😭', '😡', '👍', '👎', '❤️', '🔥', '🎉', '✨', '💯', '🚀', '👀', '🤝',
                '🙏', '💪', '☕', '🍕', '🎵', '⭐', '🌙', '🌸', '💎', '🎯', '🎨', '🎭', '🎪', '🎤', '🎧', '🎸', '🎹', '🎺', '🎻', '🥁', '🎲',
                '♟️', '🎳', '🎮', '🕹️', '🎬', '🎶', '🎼', '🥳', '🤯', '🤩', '😇', '🙃', '😉', '😋', '😜', '🤪', '🤭', '🫡', '🫶', '🤍',
                '💚', '💙', '🩵', '💜', '🤎', '🖤', '🤍', '💝', '💖', '💗', '💓', '💞', '💕', '💟', '❣️', '💔', '❤️‍🔥', '❤️‍🩹', '💘', '💌',
                '💋', '🫦', '💢', '💬', '🗯️', '💭', '💤', '💫', '🌀', '🌊', '🌈', '☀️', '🌤️', '⛅', '🌥️', '🌦️', '☁️', '🌧️', '⛈️', '🌩️',
                '🌨️', '❄️', '☃️', '⛄', '🌬️', '💨', '🌪️', '🌫️', '☁️', '🌊', '💧', '💦', '☔', '☂️', '🌂', '🧵', '🧶', '👗', '👘', '🥻',
                '🩱', '🩲', '🩳', '👙', '👚', '👕', '👖', '🧣', '🧤', '🧥', '🧦', '👔', '👞', '👟', '🥾', '🥿', '👠', '👡', '👢', '👑',
                '👒', '🎩', '🎓', '🧢', '⛑️', '📿', '💄', '💍', '💎', '🔮', '🎭', '🪞', '🪟', '🪑', '🛋️', '🛏️', '🛌', '🧻', '🧹', '🧺',
                '🧻', '🧽', '🧴', '🧷', '🧸', '🧩', '🧮', '🎲', '♟️', '🎯', '🎳', '🎮', '🕹️', '🎰', '🎲', '♠️', '♥️', '♦️', '♣️', '🃏',
                '🀄', '🎴', '🎭', '🎨', '🖼️', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🪕', '🎻', '🎵', '🎶'
            ];
            document.getElementById('emojiGrid').innerHTML = EMOJIS.map(e =>
                `<button class="emoji-item" onclick="insertEmoji('${e}')">${e}</button>`).join('');
        }

        async function toggleRecording() {
            const btn = document.getElementById('recordBtn');
            const timer = document.getElementById('recordTimer');
            const hint = document.getElementById('recordHint');
            const stopBtn = document.getElementById('recordStopBtn');
            if (!mediaRecorder || mediaRecorder.state === 'inactive') {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    audioChunks = [];
                    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
                    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
                    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
                    mediaRecorder.onstop = async () => {
                        stream.getTracks().forEach(t => t.stop());
                        const audioBlob = new Blob(audioChunks, { type: mimeType || 'audio/webm' });
                        if (audioBlob.size < 1000) { showSnackbar('录音太短');
                            resetRecordingUI(); return; }
                        await uploadAudio(audioBlob, mimeType || 'audio/webm');
                        resetRecordingUI();
                    };
                    mediaRecorder.start();
                    recordStartTime = Date.now();
                    btn.classList.add('recording');
                    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
                    hint.textContent = '正在录音...';
                    stopBtn.classList.add('show');
                    recordTimerInterval = setInterval(() => {
                        const elapsed = Math.floor((Date.now() - recordStartTime) / 1000);
                        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
                        const secs = String(elapsed % 60).padStart(2, '0');
                        timer.textContent = `${mins}:${secs}`;
                    }, 1000);
                } catch (e) {
                    showSnackbar('无法访问麦克风');
                }
            } else if (mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }
        }

        function resetRecordingUI() {
            const btn = document.getElementById('recordBtn');
            const timer = document.getElementById('recordTimer');
            const hint = document.getElementById('recordHint');
            const stopBtn = document.getElementById('recordStopBtn');
            btn.classList.remove('recording');
            btn.innerHTML =
                '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
            timer.textContent = '00:00';
            hint.textContent = '点击开始录音';
            stopBtn.classList.remove('show');
            if (recordTimerInterval) { clearInterval(recordTimerInterval);
                recordTimerInterval = null; }
        }

        async function uploadAudio(blob, mimeType) {
            const ext = mimeType.includes('webm') ? 'webm' : 'm4a';
            const filePath = `audio/${Date.now()}-${generateId()}.${ext}`;
            showSnackbar('正在上传语音...');
            try {
                const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filePath, blob, { contentType: mimeType,
                    cacheControl: '3600' });
                if (error) {
                    if (error.message.includes('bucket') || error.message.includes('not found')) showSnackbar(
                        '上传失败: 请先在 Storage 创建 chat-images Bucket');
                    else showSnackbar('上传失败: ' + error.message);
                    return;
                }
                const { data: urlData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
                const duration = recordStartTime ? Math.floor((Date.now() - recordStartTime) / 1000) : 0;
                const fallbackText = buildVoiceFallback(duration);
                let audioResult = await sendPublicMessageSecure({
                    text: fallbackText,
                    audio_url: urlData.publicUrl,
                    audio_dur: duration,
                    is_system: false,
                    msg_version: MJCHAT_VERSION
                });
                if (!audioResult.success && audioResult.message && (audioResult.message.includes('audio_dur') || audioResult.message.includes('audio_url'))) {
                    const fallbackWithUrl = buildVoiceFallback(duration, urlData.publicUrl);
                    audioResult = await sendPublicMessageSecure({
                        text: fallbackWithUrl,
                        is_system: false,
                        msg_version: MJCHAT_VERSION
                    });
                }
                if (!audioResult.success) showSnackbar('发送语音失败: ' + (audioResult.message || ''));
                else showSnackbar('语音已发送');
            } catch (e) { showSnackbar('上传失败'); }
        }

        function buildVoiceFallback(duration, audioUrl) {
            const mins = String(Math.floor(duration / 60)).padStart(2, '0');
            const secs = String(duration % 60).padStart(2, '0');
            var tail = audioUrl || '请升级 MJChat 到最新版本查看此消息';
            return '🎤 语音 ' + mins + ':' + secs + ' → ' + tail;
        }

        function toggleVoicePlay(wrap, event) {
            event.stopPropagation();
            const audioUrl = wrap.dataset.audio;
            if (!audioUrl) return;

            if (activeAudio && activeAudio.wrap === wrap && !activeAudio.audio.paused) {
                activeAudio.audio.pause();
                wrap.classList.remove('playing');
                const btn = wrap.querySelector('.voice-play-btn');
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
                activeAudio = null;
                return;
            }

            if (activeAudio) {
                activeAudio.audio.pause();
                activeAudio.wrap.classList.remove('playing');
                const prevBtn = activeAudio.wrap.querySelector('.voice-play-btn');
                prevBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
            }

            const audio = new Audio(audioUrl);
            wrap.classList.add('playing');
            const btn = wrap.querySelector('.voice-play-btn');
            btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

            audio.onended = () => {
                wrap.classList.remove('playing');
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
                if (activeAudio && activeAudio.wrap === wrap) activeAudio = null;
            };
            audio.onerror = () => {
                wrap.classList.remove('playing');
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
                if (activeAudio && activeAudio.wrap === wrap) activeAudio = null;
                showSnackbar('播放失败');
            };
            audio.play().catch(() => {
                wrap.classList.remove('playing');
                btn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
                showSnackbar('播放失败');
            });
            activeAudio = { audio, wrap };
        }

        function parseMarkedText(text) {
            if (!text) return null;
            if (text.startsWith('🔗 ') && text.includes(' → ')) {
                const rest = text.substring(4);
                const sep = rest.indexOf(' → ');
                if (sep > 0) {
                    const url = rest.substring(sep + 3).trim();
                    // 渲染时校验 URL，防止 javascript: 等危险协议被点击执行
                    if (!isSafeUrl(url)) return null;
                    return { type: 'link', displayText: rest.substring(0, sep), url: url };
                }
            }
            if (text.startsWith('📎 ') && text.includes(' → ')) {
                const rest = text.substring(3);
                const sep = rest.indexOf(' → ');
                if (sep > 0) {
                    const url = rest.substring(sep + 3).trim();
                    if (!isSafeUrl(url)) return null;
                    return { type: 'file', fileInfo: rest.substring(0, sep), url: url };
                }
            }
            if (text.startsWith('🎤 ') && text.includes('语音')) {
                const match = text.match(/🎤\s*语音\s*(\d+):(\d+)\s*→\s*(.*)/);
                if (match) {
                    const duration = parseInt(match[1]) * 60 + parseInt(match[2]);
                    var url = match[3] && match[3].startsWith('http') ? match[3].trim() : null;
                    return { type: 'voice', duration: duration, url: url };
                }
                const match2 = text.match(/🎤\s*语音\s*(\d+):(\d+)/);
                if (match2) {
                    const duration = parseInt(match2[1]) * 60 + parseInt(match2[2]);
                    return { type: 'voice', duration: duration, url: null };
                }
            }
            return null;
        }

        function getFileIconSvg(filename) {
            const ext = (filename.split('.').pop() || '').toLowerCase();
            const FILE_ICONS = {
                audio: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm-1 13h-2v3.5c0 1.38-1.12 2.5-2.5 2.5S6 19.88 6 18.5s1.12-2.5 2.5-2.5c.42 0 .8.11 1.14.29V11h3.36v4z"/>',
                video: '<path d="M4 6.47L5.76 10H20v8H4V6.47M22 4h-4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4z"/>',
                archive: '<path d="M20 6h-2.18c.11-.31.18-.65.18-1a2.996 2.996 0 0 0-5.5-1.65l-.5.67-.5-.68C10.96 2.54 10.05 2 9 2 7.34 2 6 3.34 6 5c0 .35.07.69.18 1H4c-1.11 0-1.99.89-1.99 2L2 19c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-5-2c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM9 4c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm11 15H4v-2h16v2zm0-5H4V8h5.08L7 10.83 8.62 12 11 8.76l1-1.36 1 1.36L15.38 12 17 10.83 14.92 8H20v6z"/>',
                image: '<path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/>',
                document: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>',
                code: '<path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>',
                default: '<path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/>'
            };
            const FILE_EXT_MAP = {
                audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus'],
                video: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'mpeg', 'mpg'],
                archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
                image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'psd'],
                document: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'odt', 'ods',
                    'odp'
                ],
                code: ['js', 'html', 'css', 'py', 'java', 'cpp', 'c', 'h', 'json', 'xml', 'php', 'rb', 'go', 'rs',
                    'ts', 'jsx', 'tsx', 'vue', 'sh', 'bat', 'sql', 'yml', 'yaml', 'toml', 'ini', 'md'
                ]
            };
            for (const [type, exts] of Object.entries(FILE_EXT_MAP)) {
                if (exts.includes(ext)) return FILE_ICONS[type];
            }
            return FILE_ICONS.default;
        }

        function isImageFile(filename) {
            const ext = (filename.split('.').pop() || '').toLowerCase();
            const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'psd'];
            return IMAGE_EXTS.includes(ext);
        }

        function setPublicReplyTarget(msgId, sender, content) {
            replyTarget = { id: msgId, sender, content };
            const preview = document.getElementById('publicReplyPreview');
            document.getElementById('publicReplyContent').textContent = `回复 @${sender}：${content}`;
            preview.style.display = 'flex';
            document.getElementById('publicMsgInput').focus();
            togglePublicSendBtn();
        }

        function cancelPublicReply() {
            replyTarget = null;
            document.getElementById('publicReplyPreview').style.display = 'none';
            togglePublicSendBtn();
        }

        function initInteractions() {
            const messagesEl = document.getElementById('publicMessages');

            messagesEl.addEventListener('contextmenu', (e) => {
                const target = e.target;
                if (target.tagName === 'IMG') {
                    e.preventDefault();
                    return;
                }
                if (!e.target.closest('.msg-input')) {
                    e.preventDefault();
                    // 头像右键：弹出 @ / 拍一拍 菜单
                    const avatar = target.closest('.avatar');
                    if (avatar) {
                        clearTimeout(avatarPressTimer);
                        avatarPressTimer = null;
                        avatarTarget = null;
                        const sender = avatar.dataset.sender;
                        if (sender && sender !== currentUser) {
                            showAvatarContextMenu(e, sender, 'public');
                        }
                        return;
                    }
                    const bubble = target.closest('.bubble');
                    if (bubble) {
                        const row = bubble.closest('.msg-row');
                        if (row) {
                            showContextMenuForRow(row, e.clientX, e.clientY, 'public');
                        }
                    }
                }
            });

            messagesEl.addEventListener('touchstart', (e) => {
                const target = e.target;
                if (target.tagName === 'IMG') {
                    e.preventDefault();
                }
            }, { passive: false });

            let pressTimer = null;
            let pressStartX = 0,
                pressStartY = 0;
            let pressMoved = false;
            let pressTargetRow = null;

            const startPress = (e) => {
                const target = e.target;
                if (target.closest('.msg-input')) return;
                if (target.tagName === 'IMG') return;
                const bubble = target.closest('.bubble');
                if (!bubble) return;
                const row = bubble.closest('.msg-row');
                if (!row) return;
                const cx = e.touches ? e.touches[0].clientX : e.clientX;
                const cy = e.touches ? e.touches[0].clientY : e.clientY;
                pressStartX = cx;
                pressStartY = cy;
                pressMoved = false;
                pressTargetRow = row;
                pressTimer = setTimeout(() => {
                    if (!pressMoved && pressTargetRow) {
                        showContextMenuForRow(pressTargetRow, pressStartX, pressStartY, 'public');
                        pressTargetRow = null;
                    }
                }, 500);
            };
            const movePress = (e) => {
                if (!pressTimer) return;
                const cx = e.touches ? e.touches[0].clientX : e.clientX;
                const cy = e.touches ? e.touches[0].clientY : e.clientY;
                if (Math.abs(cx - pressStartX) > 10 || Math.abs(cy - pressStartY) > 10) {
                    pressMoved = true;
                    clearTimeout(pressTimer);
                    pressTimer = null;
                    pressTargetRow = null;
                }
            };
            const endPress = () => {
                if (pressTimer) {
                    clearTimeout(pressTimer);
                    pressTimer = null;
                    pressTargetRow = null;
                }
            };
            messagesEl.addEventListener('touchstart', startPress, { passive: true });
            messagesEl.addEventListener('touchmove', movePress, { passive: true });
            messagesEl.addEventListener('touchend', endPress);
            messagesEl.addEventListener('touchcancel', endPress);
            messagesEl.addEventListener('mousedown', (e) => { if (e.button === 0) startPress(e); });
            document.addEventListener('mousemove', (e) => { if (pressTimer && e.button === 0) movePress(e); });
            document.addEventListener('mouseup', (e) => { if (e.button === 0) endPress(); });

            let avatarPressTimer = null;
            let avatarMoved = false;
            let avatarStartX = 0,
                avatarStartY = 0;
            let avatarTarget = null;
            messagesEl.addEventListener('pointerdown', (e) => {
                if (e.button !== 0) return;
                const avatar = e.target.closest('.avatar');
                if (!avatar) return;
                const sender = avatar.dataset.sender;
                if (!sender) return;
                avatarTarget = avatar;
                const cx = e.clientX,
                    cy = e.clientY;
                avatarStartX = cx;
                avatarStartY = cy;
                avatarMoved = false;
                avatarPressTimer = setTimeout(() => {
                    if (!avatarMoved && avatarTarget) {
                        const sender = avatarTarget.dataset.sender;
                        if (sender && sender !== currentUser) {
                            insertAtMention(sender);
                        }
                        avatarTarget = null;
                    }
                }, 500);
            });
            document.addEventListener('pointermove', (e) => {
                if (!avatarPressTimer) return;
                const cx = e.clientX,
                    cy = e.clientY;
                if (Math.abs(cx - avatarStartX) > 10 || Math.abs(cy - avatarStartY) > 10) {
                    avatarMoved = true;
                    clearTimeout(avatarPressTimer);
                    avatarPressTimer = null;
                    avatarTarget = null;
                }
            });
            document.addEventListener('pointerup', (e) => {
                if (avatarPressTimer) {
                    clearTimeout(avatarPressTimer);
                    avatarPressTimer = null;
                    if (!avatarMoved && avatarTarget) {
                        const sender = avatarTarget.dataset.sender;
                        if (sender) {
                            showUserProfile(sender);
                        }
                    }
                    avatarTarget = null;
                }
            });

            if (publicChannel) {
                publicChannel.on('broadcast', { event: 'poke' }, (p) => {
                    const from = p.payload.from;
                    const target = p.payload.target;
                    if (target === currentUser) {
                        broadcastSystemMsg(`${from} 拍了拍你`);
                    } else if (from === currentUser) {
                        broadcastSystemMsg(`${from} 拍了拍 ${target}`);
                    }
                });
            }
        }

        function insertAtMention(sender) {
            if (!sender) return;
            const input = document.getElementById('publicMsgInput');
            if (!input) return;
            const atText = `@${sender} `;
            const start = input.selectionStart;
            const end = input.selectionEnd;
            // Avoid duplicate consecutive @mentions
            const before = input.value.substring(0, start);
            if (before.endsWith(atText) && end === start) return;
            input.value = before + atText + input.value.substring(end);
            input.focus();
            const newPos = start + atText.length;
            input.setSelectionRange(newPos, newPos);
            autoResize(input);
            togglePublicSendBtn();
        }

        function insertAtMentionPrivate(sender) {
            const input = document.getElementById('privateMsgInput');
            const atText = `@${sender} `;
            const start = input.selectionStart;
            const end = input.selectionEnd;
            input.value = input.value.substring(0, start) + atText + input.value.substring(end);
            input.focus();
            const newPos = start + atText.length;
            input.setSelectionRange(newPos, newPos);
            autoResize(input);
            togglePrivateSendBtn();
        }

        function pokeUser(sender) {
            if (sender === currentUser) return;
            const now = Date.now();
            if (now - lastPokeTime < 60000) {
                showSnackbar('拍一拍冷却中');
                return;
            }
            lastPokeTime = now;
            if (publicChannel) {
                publicChannel.send({ type: 'broadcast', event: 'poke', payload: { from: currentUser,
                        target: sender } });
            }
            broadcastSystemMsg(`你拍了拍 ${sender}`);
        }

        function showAvatarContextMenu(e, sender, chatType) {
            e.preventDefault();
            e.stopPropagation();
            if (sender === currentUser) return;
            closeContextMenu();
            const menu = document.getElementById('msgContextMenu');
            menu.innerHTML = '';

            const atIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c5.07 0 9.22-3.77 9.86-8.67h-2.1c-.62 3.86-3.92 6.85-7.76 6.85-4.42 0-8-3.58-8-8s3.58-8 8-8c2.92 0 5.44 1.59 6.84 3.97L17.8 9H20V5l-1.69 1.69C16.82 4.01 14.52 3 12 3 7.03 3 3 7.03 3 12s4.03 9 9 9c3.69 0 6.83-2.17 8.25-5.29l1.89.65C20.38 20.52 16.46 23 12 23 5.93 23 1 18.07 1 12S5.93 1 12 1c3.75 0 7.06 1.87 9.02 4.74L23 3v6h-6l2.24-2.24C17.84 4.34 15.08 3 12 3z"/></svg>';
            const pokeIcon = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M6.5 20.5L7 21h9l1.5-.5L20 17h-5l-1 2h-3l.5-4h4l1 2h1l-1-4-8-8-4 4 1 1.5V15l-3 3 .5 2.5zM14 3l-3 3h2v3h2V6h2l-3-3z" fill="currentColor"/></svg>';

            const addItem = (label, iconSvg, action) => {
                const item = document.createElement('div');
                item.className = 'menu-item';
                item.innerHTML = iconSvg + ' ' + label;
                item.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    closeContextMenu();
                    action();
                });
                menu.appendChild(item);
            };

            addItem(`@${sender}`, atIcon, () => {
                if (chatType === 'private') {
                    insertAtMentionPrivate(sender);
                } else {
                    insertAtMention(sender);
                }
            });
            addItem('拍一拍', pokeIcon, () => pokeUser(sender));

            menu.classList.add('show');
            let left = e.clientX,
                top = e.clientY;
            const menuW = menu.offsetWidth || 120;
            const menuH = menu.offsetHeight || 80;
            if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
            if (top + menuH > window.innerHeight - 8) top = window.innerHeight - menuH - 8;
            if (left < 8) left = 8;
            if (top < 8) top = 8;
            menu.style.left = left + 'px';
            menu.style.top = top + 'px';
        }

        function initPrivateInteractions() {
            const messagesEl = document.getElementById('privateMessages');

            messagesEl.addEventListener('contextmenu', (e) => {
                const target = e.target;
                if (target.tagName === 'IMG') {
                    e.preventDefault();
                    return;
                }
                if (!e.target.closest('.msg-input')) {
                    e.preventDefault();
                    // 头像右键：弹出 @ / 拍一拍 菜单
                    const avatar = target.closest('.avatar');
                    if (avatar) {
                        const sender = avatar.dataset.username;
                        if (sender && sender !== currentUser) {
                            showAvatarContextMenu(e, sender, 'private');
                        }
                        return;
                    }
                    const bubble = target.closest('.bubble');
                    if (bubble) {
                        const row = bubble.closest('.msg-row');
                        if (row) {
                            showContextMenuForRow(row, e.clientX, e.clientY, 'private');
                        }
                    }
                }
            });

            messagesEl.addEventListener('touchstart', (e) => {
                const target = e.target;
                if (target.tagName === 'IMG') {
                    e.preventDefault();
                }
            }, { passive: false });

            let pressTimer = null;
            let pressStartX = 0,
                pressStartY = 0;
            let pressMoved = false;
            let pressTargetRow = null;

            const startPress = (e) => {
                const target = e.target;
                if (target.closest('.msg-input')) return;
                if (target.tagName === 'IMG') return;
                const bubble = target.closest('.bubble');
                if (!bubble) return;
                const row = bubble.closest('.msg-row');
                if (!row) return;
                const cx = e.touches ? e.touches[0].clientX : e.clientX;
                const cy = e.touches ? e.touches[0].clientY : e.clientY;
                pressStartX = cx;
                pressStartY = cy;
                pressMoved = false;
                pressTargetRow = row;
                pressTimer = setTimeout(() => {
                    if (!pressMoved && pressTargetRow) {
                        showContextMenuForRow(pressTargetRow, pressStartX, pressStartY, 'private');
                        pressTargetRow = null;
                    }
                }, 500);
            };
            const movePress = (e) => {
                if (!pressTimer) return;
                const cx = e.touches ? e.touches[0].clientX : e.clientX;
                const cy = e.touches ? e.touches[0].clientY : e.clientY;
                if (Math.abs(cx - pressStartX) > 10 || Math.abs(cy - pressStartY) > 10) {
                    pressMoved = true;
                    clearTimeout(pressTimer);
                    pressTimer = null;
                    pressTargetRow = null;
                }
            };
            const endPress = () => {
                if (pressTimer) {
                    clearTimeout(pressTimer);
                    pressTimer = null;
                    pressTargetRow = null;
                }
            };
            messagesEl.addEventListener('touchstart', startPress, { passive: true });
            messagesEl.addEventListener('touchmove', movePress, { passive: true });
            messagesEl.addEventListener('touchend', endPress);
            messagesEl.addEventListener('touchcancel', endPress);
            messagesEl.addEventListener('mousedown', (e) => { if (e.button === 0) startPress(e); });
            document.addEventListener('mousemove', (e) => { if (pressTimer && e.button === 0) movePress(e); });
            document.addEventListener('mouseup', (e) => { if (e.button === 0) endPress(); });
        }

        function showContextMenuForRow(row, x, y, type) {
            closeContextMenu();
            const menu = document.getElementById('msgContextMenu');
            menu.innerHTML = '';

            const msgId = row.dataset.msgId;
            const sender = row.dataset.msgSender;
            const text = row.dataset.msgText || '';
            const msgType = row.dataset.msgType || 'text';
            const linkUrl = row.dataset.linkUrl || '';
            const imageUrl = row.dataset.imageUrl || '';
            const replyToId = row.dataset.replyToId || '';
            const replyContent = row.dataset.replyContent || '';

            contextTarget = { row, msgId, sender, text, type: msgType, linkUrl, imageUrl, replyToId, replyContent,
                chatType: type };

            const isOwn = sender === currentUser;
            const canDelete = isOwn || isAdmin;

            const icons = {
                save: '<svg viewBox="0 0 24 24"><path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/></svg>',
                open: '<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>',
                copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
                delete: '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
                reply: '<svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>'
            };

            const addItem = (label, iconSvg, action) => {
                const item = document.createElement('div');
                item.className = 'menu-item';
                item.innerHTML = iconSvg + ' ' + label;
                item.addEventListener('click', (e) => {
                    e.stopPropagation();
                    closeContextMenu();
                    action();
                });
                menu.appendChild(item);
            };

            const replyContentText = (msgType === 'voice' || msgType === 'link' || msgType === 'file') ? getMessagePreview(text) : (text || '消息');
            addItem('回复', icons.reply, () => {
                if (type === 'public') {
                    setPublicReplyTarget(msgId, sender, replyContentText);
                } else {
                    setPrivateReplyTarget(msgId, sender, replyContentText);
                }
            });

            if (msgType === 'image') {
                addItem('保存图片', icons.save, () => {
                    const url = imageUrl;
                    if (url) {
                        fetch(url).then(res => res.blob()).then(blob => {
                            const a = document.createElement('a');
                            a.href = URL.createObjectURL(blob);
                            a.download = 'image.jpg';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(a.href);
                        }).catch(() => showSnackbar('保存失败'));
                    } else {
                        showSnackbar('图片地址无效');
                    }
                });
                if (canDelete) {
                    addItem('删除', icons.delete, () => {
                        showConfirm('确认删除', '确定要删除此消息吗？将会对所有人删除此消息。', () => {
                            contextDeleteMsg();
                        });
                    });
                }
            } else if (msgType === 'link' || msgType === 'file') {
                if (linkUrl) {
                    addItem('打开链接', icons.open, () => window.open(linkUrl, '_blank'));
                }
                const copyText = text || linkUrl;
                if (copyText) {
                    addItem('复制文字', icons.copy, () => {
                        navigator.clipboard.writeText(copyText).then(() => showSnackbar('已复制'))
                            .catch(() => {
                                const ta = document.createElement('textarea');
                                ta.value = copyText;
                                ta.style.position = 'fixed';
                                ta.style.opacity = '0';
                                document.body.appendChild(ta);
                                ta.select();
                                document.execCommand('copy');
                                document.body.removeChild(ta);
                                showSnackbar('已复制');
                            });
                    });
                }
                if (canDelete) {
                    addItem('删除', icons.delete, () => {
                        showConfirm('确认删除', '确定要删除此消息吗？将会对所有人删除此消息。', () => {
                            contextDeleteMsg();
                        });
                    });
                }
            } else if (msgType === 'text') {
                if (text) {
                    addItem('复制文字', icons.copy, () => {
                        navigator.clipboard.writeText(text).then(() => showSnackbar('已复制'))
                            .catch(() => {
                                const ta = document.createElement('textarea');
                                ta.value = text;
                                ta.style.position = 'fixed';
                                ta.style.opacity = '0';
                                document.body.appendChild(ta);
                                ta.select();
                                document.execCommand('copy');
                                document.body.removeChild(ta);
                                showSnackbar('已复制');
                            });
                    });
                }
                if (canDelete) {
                    addItem('删除', icons.delete, () => {
                        showConfirm('确认删除', '确定要删除此消息吗？将会对所有人删除此消息。', () => {
                            contextDeleteMsg();
                        });
                    });
                }
            } else {
                if (canDelete) {
                    addItem('删除', icons.delete, () => {
                        showConfirm('确认删除', '确定要删除此消息吗？将会对所有人删除此消息。', () => {
                            contextDeleteMsg();
                        });
                    });
                }
            }

            if (menu.children.length === 0) return;

            menu.classList.add('show');
            let left = x,
                top = y;
            const menuW = menu.offsetWidth || 160;
            const menuH = menu.offsetHeight || 80;
            if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
            if (top + menuH > window.innerHeight - 8) top = window.innerHeight - menuH - 8;
            if (left < 8) left = 8;
            if (top < 8) top = 8;
            menu.style.left = left + 'px';
            menu.style.top = top + 'px';
        }

        function closeContextMenu() {
            const menu = document.getElementById('msgContextMenu');
            menu.classList.remove('show');
            menu.innerHTML = '';
        }

        async function contextDeleteMsg() {
            if (!contextTarget) { showSnackbar('无效操作'); return; }
            const target = contextTarget;
            contextTarget = null;
            const msgId = target.msgId;
            const chatType = target.chatType || 'public';
            if (!msgId) { showSnackbar('无效消息'); return; }
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(msgId)) { showSnackbar('无效的消息ID'); return; }
            try {
                if (chatType === 'public') {
                    const { data: delData, error: delError } = await sb.rpc('delete_public_message', {
                        p_msg_id: msgId,
                        p_username: currentUser,
                        p_session_token: getSessionToken()
                    });
                    if (delError || (delData && delData.success === false)) {
                        showSnackbar('删除失败: ' + (delData?.message || delError?.message || ''));
                        return;
                    }
                    publicChannel.send({ type: 'broadcast', event: 'delete_message', payload: { id: msgId } });
                    handlePublicDeleted(msgId);
                } else {
                    // Private messages have RLS deny_all, so use RPC to delete
                    var deleted = false;
                    var rpcFailMsg = null;
                    try {
                        var rpcResult = await sb.rpc('delete_private_message', {
                            p_msg_id: msgId,
                            p_username: currentUser,
                            p_session_token: getSessionToken()
                        });
                        if (!rpcResult.error && rpcResult.data) {
                            var rpcData = rpcResult.data;
                            if (typeof rpcData === 'string') {
                                try { rpcData = JSON.parse(rpcData); } catch (e) { rpcData = {}; }
                            }
                            if (rpcData.success === true) {
                                deleted = true;
                            } else if (rpcData.success === false) {
                                showSnackbar(rpcData.message || '删除失败');
                                return;
                            }
                        } else if (rpcResult.error) {
                            rpcFailMsg = rpcResult.error.message || 'RPC error';
                        }
                    } catch (e) { rpcFailMsg = e.message || 'exception'; }
                    if (!deleted) {
                        if (rpcFailMsg) {
                            showSnackbar('删除失败: ' + rpcFailMsg);
                        } else {
                            showSnackbar('删除失败');
                        }
                        return;
                    }
                    if (privateChannel) {
                        privateChannel.send({ type: 'broadcast', event: 'delete_message', payload: { id: msgId } });
                    }
                    privateMessages = privateMessages.filter(m => m.id !== msgId);
                    var rows = document.querySelectorAll('#privateMessages .msg-row');
                    for (var i = 0; i < rows.length; i++) { if (rows[i].dataset.msgId === msgId) rows[i].remove(); }
                }
                showSnackbar('消息已删除');
            } catch (e) { showSnackbar('删除失败'); }
            closeContextMenu();
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.msg-context-menu') && !e.target.closest('.bubble')) {
                closeContextMenu();
            }
        });

        async function safeInsertPrivateMsg(sessionId, sender, content) {
            try {
                const { data: rpcData, error: rpcError } = await sb.rpc('send_private_message', {
                    p_session_id: sessionId,
                    p_sender: sender,
                    p_content: content,
                    p_session_token: getSessionToken()
                });
                if (!rpcError && rpcData && rpcData.success === false) {
                    throw new Error(rpcData.message || '发送失败');
                } else if (!rpcError && rpcData && rpcData.success !== false && rpcData.message) {
                    return rpcData.message;
                }
                if (rpcError) throw rpcError;
            } catch (e) {
                throw e;
            }
            throw new Error('发送失败: 私聊RPC不可用');
        }

        async function loadPrivateSessions() {
            try {
                let sessions = null;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('get_private_sessions', { p_username: currentUser });
                    if (!rpcError && rpcData) {
                        sessions = Array.isArray(rpcData) ? rpcData : [];
                    }
                } catch (e) { /* RPC not found, fallback */ }
                if (!sessions) {
                    const { data, error } = await sb.from(TABLE_PRIVATE_SESSIONS)
                        .select('id, user1, user2, updated_at, deleted_by_user1, deleted_by_user2, last_message')
                        .or(`user1.eq.${currentUser},user2.eq.${currentUser}`)
                        .order('updated_at', { ascending: false });
                    if (error) {
                        console.error('loadPrivateSessions error:', error);
                        return;
                    }
                    sessions = data || [];
                }
                const filtered = sessions.filter(s => {
                    if (s.user1 === currentUser && s.deleted_by_user1) return false;
                    if (s.user2 === currentUser && s.deleted_by_user2) return false;
                    return true;
                });
                window.privateSessions = filtered;
                const otherUsers = filtered.map(s => s.user1 === currentUser ? s.user2 : s.user1);
                await loadUserAvatars(otherUsers);
                renderPrivateList();
                return filtered;
            } catch (e) {
                console.error('loadPrivateSessions exception:', e);
                return [];
            }
        }

        function renderPrivateList() {
            var container = document.getElementById('privateList');
            var sessions = window.privateSessions || [];
            if (sessions.length === 0) {
                container.innerHTML = '<div class="empty">暂无私聊，点击用户头像发起</div>';
                return;
            }
            container.innerHTML = sessions.map(function(s) {
                var other = s.user1 === currentUser ? s.user2 : s.user1;
                var idx = hashStr(other) % 8;
                var lastMsg = getMessagePreview(s.last_message) || '暂无消息';
                var time = s.updated_at ? new Date(s.updated_at).toLocaleTimeString('zh-CN', { hour: '2-digit',
                    minute: '2-digit' }) : '';
                var unread = privateUnreadCounts[s.id] || 0;
                var unreadBadge = unread > 0 ? '<div class="unread-badge">' + (unread > 99 ? '99+' : unread) + '</div>' : '<div class="unread-badge hidden"></div>';
                var avUrl = userAvatarCache[other];
                var avStyle = avUrl ? ' style="background-image:url(\'' + escapeAttr(sanitizeAvatarUrl(avUrl)) + '\');background-size:cover;background-position:center;"' : '';
                var avText = avUrl ? '' : escapeHtml(other.charAt(0).toUpperCase());
                return '<div class="list-item" onclick="openPrivateChat(\'' + s.id + '\',\'' + escapeAttr(other) + '\')">' +
                            '<div class="av-wrap">' +
                                '<div class="av av-' + idx + '" data-username="' + escapeAttr(other) + '"' + avStyle + '>' + avText + '</div>' +
                                '<div class="av-status-dot" data-username="' + escapeAttr(other) + '"></div>' +
                            '</div>' +
                            '<div class="info">' +
                                '<div class="name">' + escapeHtml(other) + '</div>' +
                                '<div class="last-msg">' + escapeHtml(lastMsg) + '</div>' +
                            '</div>' +
                            '<div class="time">' + time + '</div>' +
                            unreadBadge +
                        '</div>';
            }).join('');
            // Update online status dots after render
            updatePrivateListStatusDots();
        }

        function updatePrivateListStatusDots() {
            var dots = document.querySelectorAll('.home-page .private-list .av-status-dot');
            var onlineNames = [];
            try {
                var _vals = Object.values(onlineUsers);
                for (var _vi = 0; _vi < _vals.length; _vi++) {
                    var _arr = _vals[_vi];
                    if (Array.isArray(_arr)) {
                        for (var _vj = 0; _vj < _arr.length; _vj++) {
                            if (_arr[_vj] && _arr[_vj].name) onlineNames.push(_arr[_vj].name);
                        }
                    } else if (_vals[_vi] && _vals[_vi].name) {
                        onlineNames.push(_vals[_vi].name);
                    }
                }
            } catch (e) {}
            for (var i = 0; i < dots.length; i++) {
                var dot = dots[i];
                var username = dot.getAttribute('data-username');
                if (!username) continue;
                var avatar = dot.previousElementSibling;
                if (onlineNames.indexOf(username) >= 0) {
                    dot.className = 'av-status-dot online';
                    if (avatar) avatar.style.filter = '';
                } else {
                    dot.className = 'av-status-dot';
                    // Check if user is banned/deleted asynchronously
                    (function(d, un, av) {
                        resolveUserStatus(un).then(function(status) {
                            if (status === 'banned' || status === 'deleted') {
                                d.className = 'av-status-dot banned';
                                if (av) av.style.filter = 'grayscale(1)';
                            } else {
                                d.className = 'av-status-dot';
                                if (av) av.style.filter = '';
                            }
                        });
                    })(dot, username, avatar);
                }
            }
        }

        async function createPrivateSession(otherUser) {
            if (otherUser === currentUser) { showSnackbar('不能和自己私聊'); return null; }
            try {
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('create_private_session', {
                        p_user1: currentUser,
                        p_user2: otherUser
                    });
                    if (!rpcError && rpcData && rpcData.success !== false && rpcData.session_id) {
                        return rpcData.session_id;
                    }
                } catch (e) { /* RPC not found, fallback */ }

                const { data: existing } = await sb.from(TABLE_PRIVATE_SESSIONS)
                    .select('id, user1, user2, deleted_by_user1, deleted_by_user2')
                    .or(`and(user1.eq.${currentUser},user2.eq.${otherUser}),and(user1.eq.${otherUser},user2.eq.${currentUser})`)
                    .maybeSingle();
                if (existing) {
                    const updates = {};
                    if (existing.user1 === currentUser && existing.deleted_by_user1) updates.deleted_by_user1 = false;
                    if (existing.user2 === currentUser && existing.deleted_by_user2) updates.deleted_by_user2 = false;
                    if (Object.keys(updates).length > 0) {
                        await sb.from(TABLE_PRIVATE_SESSIONS).update(updates).eq('id', existing.id);
                    }
                    return existing.id;
                }
                const { data, error } = await sb.from(TABLE_PRIVATE_SESSIONS).insert({
                    user1: currentUser,
                    user2: otherUser,
                    deleted_by_user1: false,
                    deleted_by_user2: false
                }).select('id').single();
                if (error) { showSnackbar('创建私聊失败: ' + error.message); return null; }
                return data.id;
            } catch (e) { showSnackbar('创建私聊失败'); return null; }
        }

        async function updatePrivateChatStatus() {
            if (!privateOtherUser || !privateChatActive) return;
            const statusEl = document.getElementById('privateChatStatus');
            if (!statusEl) return;
            const status = await resolveUserStatus(privateOtherUser);
            const textMap = { online: '在线', banned: '已封禁', deleted: '已注销', offline: '离线' };
            statusEl.textContent = textMap[status] || '离线';
            statusEl.className = 'private-status';
        }

        async function openPrivateChat(sessionId, otherUser) {
            privateSessionId = sessionId;
            privateOtherUser = otherUser;
            privateChatActive = true;
            privateHasMore = true;
            privateLoadingMore = false;
            document.getElementById('privateChatTitle').textContent = otherUser;
            if (dismissedPrivacyBanners.has(otherUser)) {
                document.getElementById('privacyBanner').classList.add('hidden-banner');
            } else {
                document.getElementById('privacyBanner').classList.remove('hidden-banner');
            }
            switchPage('privatePage', true);
            pushPageHistory('private');
            clearUnread(sessionId);
            await loadPrivateMessages(sessionId);
            if (privateMessages.length > 0) {
                markPrivateRead(sessionId, privateMessages[privateMessages.length - 1].created_at);
            } else {
                markPrivateRead(sessionId);
            }
            subscribePrivateChannel(sessionId);
            checkPrivacyBanner();
            updatePrivateChatStatus();
            if (privateStatusInterval) clearInterval(privateStatusInterval);
            privateStatusInterval = setInterval(updatePrivateChatStatus, 10000);
            const privateMessagesEl = document.getElementById('privateMessages');
            setupScrollHandlers(privateMessagesEl);
            setTimeout(() => {
                scrollToBottom(privateMessagesEl);
                updateScrollButton(privateMessagesEl);
            }, 50);
        }

        function checkPrivacyBanner() {
            if (dismissedPrivacyBanners.has(privateOtherUser)) {
                document.getElementById('privacyBanner').classList.add('hidden-banner');
                return;
            }
            const senders = new Set(privateMessages.map(m => m.sender));
            if (senders.size >= 2) {
                document.getElementById('privacyBanner').classList.add('hidden-banner');
            } else {
                document.getElementById('privacyBanner').classList.remove('hidden-banner');
            }
        }

        function incrementUnread(sessionId) {
            privateUnreadCounts[sessionId] = (privateUnreadCounts[sessionId] || 0) + 1;
            renderPrivateList();
            updateBackBadge();
        }

        function clearUnread(sessionId) {
            if (privateUnreadCounts[sessionId]) {
                delete privateUnreadCounts[sessionId];
                renderPrivateList();
                updateBackBadge();
            }
        }

        function getTotalUnread() {
            return Object.values(privateUnreadCounts).reduce((a, b) => a + b, 0) + publicUnread;
        }

        function updateBackBadge() {
            const total = getTotalUnread();
            const badges = document.querySelectorAll('.back-badge');
            badges.forEach(b => {
                if (total > 0) {
                    b.classList.remove('hidden');
                    b.textContent = total > 99 ? '99+' : total;
                } else {
                    b.classList.add('hidden');
                }
            });
        }

        function updatePublicBadge() {
            const badge = document.getElementById('publicUnreadBadge');
            if (!badge) return;
            if (publicUnread > 0) {
                badge.textContent = publicUnread > 99 ? '99+' : publicUnread;
                badge.style.display = '';
            } else {
                badge.style.display = 'none';
            }
        }

        async function loadPrivateMessages(sessionId) {
            try {
                let messages = null;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('get_private_messages', {
                        p_session_id: sessionId,
                        p_username: currentUser,
                        p_session_token: getSessionToken(),
                        p_limit: PAGE_SIZE
                    });
                    if (!rpcError && rpcData) {
                        if (Array.isArray(rpcData)) {
                            messages = rpcData;
                        } else if (rpcData.success === false) {
                            console.error('loadPrivateMessages access denied:', rpcData.message);
                            return;
                        }
                    }
                } catch (e) { /* RPC error */ }
                if (!messages) {
                    console.error('loadPrivateMessages: RPC unavailable or failed');
                    return;
                }
                privateMessages = messages.reverse();
                privateHasMore = messages.length === PAGE_SIZE;
                const c = document.getElementById('privateMessages');
                c.innerHTML = '';
                privateLastDateLabel = '';
                if (privateMessages.length > 0) {
                    privateMessages.forEach(m => renderPrivateMessage(m));
                    const senders = [...new Set(privateMessages.map(m => m.sender))];
                    await loadUserAvatars(senders);
                    document.querySelectorAll('#privateMessages .msg-row .avatar').forEach(av => {
                        const sender = av.dataset.username;
                        if (sender && userAvatarCache[sender]) {
                            av.style.backgroundImage = `url(${userAvatarCache[sender]})`;
                            av.textContent = '';
                        }
                    });
                }
            } catch (e) { /* ignore */ }
        }

        async function loadMorePrivateMessages(sessionId) {
            if (privateLoadingMore || !privateHasMore || privateMessages.length === 0) return;
            privateLoadingMore = true;
            showPrivateLoadMore(true);
            try {
                const oldest = privateMessages[0].created_at;
                let moreMessages = null;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('get_private_messages', {
                        p_session_id: sessionId,
                        p_username: currentUser,
                        p_session_token: getSessionToken(),
                        p_limit: PAGE_SIZE
                    });
                    if (!rpcError && rpcData && Array.isArray(rpcData)) {
                        moreMessages = rpcData.filter(m =>
                            new Date(m.created_at) < new Date(oldest)
                        ).slice(0, PAGE_SIZE);
                    }
                } catch (e) { /* RPC error */ }
                if (!moreMessages) {
                    privateHasMore = false;
                    return;
                }
                if (!moreMessages || moreMessages.length === 0) {
                    privateHasMore = false;
                    return;
                }
                const senders = [...new Set(moreMessages.map(m => m.sender))];
                await loadUserAvatars(senders);
                const unique = moreMessages.reverse().filter(m => !privateMessages.some(e => e.id === m.id));
                privateMessages = unique.concat(privateMessages);
                const container = document.getElementById('privateMessages');
                const prevScrollHeight = container.scrollHeight;
                const prevScrollTop = container.scrollTop;
                container.innerHTML = '';
                privateLastDateLabel = '';
                privateMessages.forEach(m => renderPrivateMessage(m));
                requestAnimationFrame(() => {
                    container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
                });
            } catch (e) {
                console.error('loadMorePrivateMessages error:', e);
            } finally {
                privateLoadingMore = false;
                showPrivateLoadMore(false);
            }
        }

        function showPrivateLoadMore(show) {
            let indicator = document.getElementById('privateLoadMoreIndicator');
            if (show) {
                if (!indicator) {
                    indicator = document.createElement('div');
                    indicator.id = 'privateLoadMoreIndicator';
                    indicator.className = 'load-more-indicator';
                    indicator.innerHTML = '<div class="loading-spinner"><svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20"/></svg></div><span>正在加载更多消息...</span>';
                    const container = document.getElementById('privateMessages');
                    container.insertBefore(indicator, container.firstChild);
                }
                indicator.style.display = 'flex';
            } else {
                if (indicator) indicator.style.display = 'none';
            }
        }

        function renderPrivateMessage(msg) {
            const c = document.getElementById('privateMessages');
            const isOwn = msg.sender === currentUser;
            const date = new Date(msg.created_at);
            const dl = date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
            if (dl !== privateLastDateLabel) {
                privateLastDateLabel = dl;
                const s = document.createElement('div');
                s.className = 'date-divider';
                s.innerHTML = `<span>${dl}</span>`;
                c.appendChild(s);
            }
            const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
            const ci = hashStr(msg.sender) % 8;

            let replyHtml = '';
            let actualContent = msg.content || '';
            let fileIsImage = false;
            let replyToId = '';
            let replyContentStr = '';
            const rplMatch = msg.content && msg.content.match(/^__RPL__(.*?)__ENDRPL__/);
            if (rplMatch) {
                try {
                    const rpl = JSON.parse(rplMatch[1]);
                    replyToId = rpl.i || '';
                    replyContentStr = rpl.c || '';
                    actualContent = msg.content.substring(rplMatch[0].length);
                    const senderDisplay = rpl.s || '';
                    replyHtml = `<div class="reply-preview-block" onclick="jumpToMessage('${escapeAttr(replyToId)}', 'private')">↩ <span class="reply-sender">${escapeHtml(senderDisplay)}</span><br><span class="reply-content">${escapeHtml(replyContentStr)}</span></div>`;
                } catch (e) { actualContent = msg.content; }
            }

            let contentHtml = cleanHtml(actualContent);

            const linkMatch = actualContent.match(/🔗 (.*?) → (.*)/);
            const fileMatch = actualContent.match(/📎 (.*?) \(([\d.]+) KB\) → (.*)/);
            const imgMatch = actualContent.match(/!\[.*?\]\((.*?)\)/);
            const voiceMatch = actualContent.match(/🎤\s*语音\s*(\d+):(\d+)\s*→\s*(.*)/);

            if (voiceMatch) {
                const duration = parseInt(voiceMatch[1]) * 60 + parseInt(voiceMatch[2]);
                const audioUrl = voiceMatch[3] && voiceMatch[3].startsWith('http') ? voiceMatch[3].trim() : null;
                const mins = String(Math.floor(duration / 60)).padStart(2, '0');
                const secs = String(duration % 60).padStart(2, '0');
                const durStr = `${mins}:${secs}`;
                const waveBars = Array.from({ length: 12 }, () => Math.floor(Math.random() * 16 + 4)).map(h =>
                    `<div class="voice-wave" style="height:${h}px"></div>`).join('');
                if (audioUrl) {
                    contentHtml =
                        `<div class="voice-msg-wrap" data-audio="${escapeAttr(audioUrl)}" data-dur="${duration}" onclick="toggleVoicePlay(this, event)"><button class="voice-play-btn"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button><div class="voice-waves">${waveBars}</div><span class="voice-dur">${durStr}</span></div>`;
                } else {
                    contentHtml = `<div class="voice-msg-wrap"><span class="voice-dur">${durStr}</span><span style="font-size:0.75rem;color:var(--md-on-surface-dim);margin-left:8px;">语音消息</span></div>`;
                }
            } else if (imgMatch) {
                contentHtml =
                    `<img src="${escapeAttr(imgMatch[1])}" onclick="previewImage('${escapeAttr(imgMatch[1])}')" alt="图片" style="max-width:180px;max-height:180px;border-radius:2px;display:block;" oncontextmenu="return false;">`;
                const extraText = actualContent.replace(/!\[.*?\]\(.*?\)/, '').trim();
                if (extraText) {
                    contentHtml += `<div style="margin-top:4px;">${escapeHtml(extraText)}</div>`;
                }
            } else if (linkMatch && isSafeUrl(linkMatch[2])) {
                contentHtml =
                    `<a href="${escapeAttr(linkMatch[2])}" target="_blank" rel="noopener noreferrer" style="color:#64B5F6;text-decoration:underline;">${escapeHtml(linkMatch[1])}</a>`;
            } else if (fileMatch && isSafeUrl(fileMatch[3])) {
                if (isImageFile(fileMatch[1])) {
                    contentHtml = `<img src="${escapeAttr(fileMatch[3])}" alt="${escapeAttr(fileMatch[1])}" loading="lazy" style="max-width:280px;max-height:280px;border-radius:12px;cursor:pointer;" onclick="viewImage('${escapeAttr(fileMatch[3])}')">`;
                    fileIsImage = true;
                } else {
                    const iconPath = getFileIconSvg(fileMatch[1]);
                    contentHtml =
                        `<a href="${escapeAttr(fileMatch[3])}" target="_blank" rel="noopener noreferrer" class="file-msg"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">${iconPath}</svg><span>${escapeHtml(fileMatch[1])} (${escapeHtml(fileMatch[2])} KB)</span></a>`;
                }
            } else {
                contentHtml = cleanHtml(actualContent);
                contentHtml = contentHtml.replace(/@([\w\u4e00-\u9fa5]+)/g, '<b>@$1</b>');
            }

            const row = document.createElement('div');
            row.className = `msg-row ${isOwn ? 'own' : ''}`;
            row.dataset.msgId = msg.id;
            row.dataset.msgSender = msg.sender;
            row.dataset.msgText = actualContent || '';
            if (replyToId) {
                row.dataset.replyToId = replyToId;
                row.dataset.replyContent = replyContentStr;
            }
            if (voiceMatch) row.dataset.msgType = 'voice';
            else if (imgMatch) row.dataset.msgType = 'image';
            else if (linkMatch && isSafeUrl(linkMatch[2])) { row.dataset.msgType = 'link'; row.dataset.linkUrl = linkMatch[2] || ''; }
            else if (fileMatch && isSafeUrl(fileMatch[3])) { row.dataset.msgType = fileIsImage ? 'image' : 'file'; row.dataset.linkUrl = fileMatch[3] || ''; }
            else row.dataset.msgType = 'text';
            row.innerHTML = `
                <div class="avatar av-${ci}" data-username="${escapeAttr(msg.sender)}" onclick="showUserProfile('${escapeAttr(msg.sender)}')">${escapeHtml(msg.sender.charAt(0).toUpperCase())}</div>
                <div class="content">
                    <div class="meta"><span class="sender">${isOwn ? '我' : escapeHtml(msg.sender)}</span><span class="time">${time}</span></div>
                    <div class="bubble">${replyHtml}${contentHtml}</div>
                </div>
            `;
            if (userAvatarCache[msg.sender]) {
                const avEl = row.querySelector('.avatar');
                avEl.style.backgroundImage = `url(${userAvatarCache[msg.sender]})`;
                avEl.textContent = '';
            }
            c.appendChild(row);
        }

        function addPrivateSystemMsg(text) {
            const c = document.getElementById('privateMessages');
            const d = document.createElement('div');
            d.className = 'system-msg';
            d.innerHTML = `<span>${escapeHtml(text)}</span>`;
            c.appendChild(d);
        }

        function subscribePrivateChannel(sessionId) {
            if (privateChannel) {
                sb.removeChannel(privateChannel);
                privateChannel = null;
            }
            const channelName = `private-${sessionId}`;
            privateChannel = sb.channel(channelName);

            privateChannel.on('broadcast', { event: 'new_message' }, (payload) => {
                const msg = payload.payload;
                if (!privateMessages.some(m => m.id === msg.id)) {
                    privateMessages.push(msg);
                    if (document.getElementById('privatePage').classList.contains('active')) {
                        renderPrivateMessage(msg);
                        checkPrivacyBanner();
                        const container = document.getElementById('privateMessages');
                        if (!isUserScrolledUp && container) {
                            scrollToBottom(container);
                            updateScrollButton(container);
                        }
                    } else {
                        incrementUnread(sessionId);
                    }
                    if (msg.created_at) {
                        sb.from(TABLE_PRIVATE_SESSIONS).update({
                            updated_at: msg.created_at,
                            last_message: msg.content
                        }).eq('id', sessionId);
                    }
                    loadPrivateSessions();
                }
            });

            privateChannel.on('broadcast', { event: 'delete_message' }, (payload) => {
                const msgId = payload.payload.id;
                privateMessages = privateMessages.filter(m => m.id !== msgId);
                const rows = document.querySelectorAll('#privateMessages .msg-row');
                rows.forEach(row => { if (row.dataset.msgId === msgId) row.remove(); });
            });


            privateChannel.subscribe((status) => {});
        }

        function togglePrivateSendBtn() {
            const hasText = document.getElementById('privateMsgInput').value.trim();
            const hasReply = !!privateReplyTarget;
            document.getElementById('privateSendBtn').disabled = !hasText && !hasReply;
        }

        function handlePrivateKeyDown(e) {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                sendPrivateMsg();
            }
        }

        async function sendPrivateMsg() {
            if (!privateSessionId || !privateChatActive) return;
            const input = document.getElementById('privateMsgInput');
            let text = input.value.trim();
            if (!text && !privateReplyTarget) return;
            text = cleanHtml(text || '');
            if (!text && !privateReplyTarget) { showSnackbar('消息包含不安全内容'); return; }
            document.getElementById('privateSendBtn').disabled = true;

            let replyPrefix = '';
            if (privateReplyTarget) {
                const replyData = JSON.stringify({
                    i: privateReplyTarget.id,
                    s: privateReplyTarget.sender,
                    c: privateReplyTarget.content
                });
                replyPrefix = `__RPL__${replyData}__ENDRPL__`;
            }
            const fullContent = replyPrefix + text;

            const hasReply = privateMessages.some(m => m.sender !== currentUser);
            if (!hasReply) {
                const myMsgCount = privateMessages.filter(m => m.sender === currentUser).length;
                if (myMsgCount >= 3) {
                    showSnackbar('对方暂未回复，请稍后再发送');
                    document.getElementById('privateSendBtn').disabled = false;
                    return;
                }
            }

            const payload = {
                session_id: privateSessionId,
                sender: currentUser,
                content: fullContent
            };
            let newMsg = null;
            let sendError = null;
            let blockedMsg = null;
            try {
                const { data: rpcData, error: rpcError } = await sb.rpc('send_private_message', {
                    p_session_id: privateSessionId,
                    p_sender: currentUser,
                    p_content: fullContent,
                    p_session_token: getSessionToken()
                });
                if (!rpcError && rpcData && rpcData.success !== false && rpcData.message) {
                    newMsg = rpcData.message;
                } else if (rpcData && rpcData.success === false) {
                    blockedMsg = rpcData.message || '发送失败';
                } else if (rpcError) {
                    sendError = rpcError;
                }
            } catch (e) { sendError = e; }

            if (blockedMsg) {
                showSnackbar(blockedMsg);
                document.getElementById('privateSendBtn').disabled = false;
                return;
            }

            if (!newMsg && sendError) {
                showSnackbar('发送失败: ' + (sendError.message || '请重新登录'));
                document.getElementById('privateSendBtn').disabled = false;
                return;
            }

            if (privateChannel) {
                privateChannel.send({
                    type: 'broadcast',
                    event: 'new_message',
                    payload: newMsg
                });
            }
            privateMessages.push(newMsg);
            if (document.getElementById('privatePage').classList.contains('active')) {
                renderPrivateMessage(newMsg);
                const container = document.getElementById('privateMessages');
                if (container) {
                    scrollToBottom(container);
                    updateScrollButton(container);
                    isUserScrolledUp = false;
                }
            }
            input.value = '';
            autoResize(input);
            cancelPrivateReply();
            togglePrivateSendBtn();
            checkPrivacyBanner();
            notifyPrivateMsg(privateSessionId, currentUser);
            loadPrivateSessions();
        }

        function leavePrivateChat() {
            leavePrivateChatAnimated();
        }

        async function deletePrivateChat() {
            if (!privateSessionId || !privateChatActive) return;
            if (!confirm(`确定要删除与 ${privateOtherUser} 的聊天吗？\n删除后双方的所有聊天记录将被彻底清除。`)) return;
            const sessionIdToDelete = privateSessionId;
            const otherUserToDelete = privateOtherUser;
            try {
                let deleted = false;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('delete_private_session', {
                        p_session_id: sessionIdToDelete,
                        p_username: currentUser,
                        p_session_token: getSessionToken()
                    });
                    if (!rpcError && rpcData && rpcData.success) {
                        deleted = true;
                    } else if (rpcData && rpcData.success === false) {
                        showSnackbar(rpcData.message || '删除失败');
                        return;
                    } else if (rpcError) {
                        showSnackbar('删除失败: ' + rpcError.message);
                        return;
                    }
                } catch (e) {
                    showSnackbar('删除失败: ' + (e.message || ''));
                    return;
                }
                if (publicChannel) {
                    publicChannel.send({
                        type: 'broadcast',
                        event: 'session_deleted',
                        payload: { session_id: sessionIdToDelete, deleted_by: currentUser, target: otherUserToDelete }
                    });
                }
                window.privateSessions = (window.privateSessions || []).filter(s => s.id !== sessionIdToDelete);
                showSnackbar('已删除聊天');
                leavePrivateChat();
            } catch (e) { showSnackbar('删除失败: ' + (e.message || '')); }
        }

        async function startPrivateChatFromProfile() {
            const username = document.getElementById('userProfileUsername').textContent;
            if (username === currentUser) { showSnackbar('不能和自己私聊'); return; }
            closeUserProfile();
            const sessionId = await createPrivateSession(username);
            if (sessionId) {
                await loadPrivateSessions();
                openPrivateChat(sessionId, username);
            }
        }

        function togglePrivateFeaturePanel() {
            const panel = document.getElementById('privateFeaturePanel');
            const btn = document.getElementById('privateMoreBtn');
            if (panel.classList.contains('show')) {
                panel.classList.remove('show');
                btn.classList.remove('active');
            } else {
                panel.classList.add('show');
                btn.classList.add('active');
            }
        }

        function privateCloseSubPanel() {
            if (privateMediaRecorder && privateMediaRecorder.state === 'recording') {
                privateMediaRecorder.stop();
            }
            document.getElementById('privateEmojiSubPanel').classList.remove('active');
            document.getElementById('privateTextEffectSubPanel').classList.remove('active');
            document.getElementById('privateVoiceSubPanel').classList.remove('active');
            document.getElementById('privateFeaturePanelMain').style.display = 'block';
        }

        function privateOpenImagePicker() {
            privateCloseSubPanel();
            document.getElementById('privateImageInput').click();
        }

        async function privateHandleImageSelect(event) {
            const files = Array.from(event.target.files || []);
            event.target.value = '';
            if (files.length === 0) return;
            if (files.length > MAX_IMAGES_PER_MSG) {
                showSnackbar(`一次最多选择 ${MAX_IMAGES_PER_MSG} 张图片`);
                return;
            }
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (file.size > MAX_IMAGE_SIZE) { showSnackbar(`图片 ${file.name} 超过 5MB`); return; }
                if (!file.type.startsWith('image/')) { showSnackbar(`文件 ${file.name} 不是图片`); return; }
            }
            showSnackbar(`正在上传 ${files.length} 张图片...`);
            const imageUrls = [];
            for (let i = 0; i < files.length; i++) {
                let file = files[i];
                let blobToUpload = file;
                if (file.size > COMPRESS_THRESHOLD) {
                    try {
                        blobToUpload = await compressImage(file, 1920, 0.7);
                    } catch (e) { /* use original */ }
                }
                const filePath = `private/${privateSessionId}/${Date.now()}-${generateId()}-${i}.jpg`;
                try {
                    const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filePath, blobToUpload, { contentType: 'image/jpeg',
                        cacheControl: '3600' });
                    if (error) {
                        showSnackbar('上传失败: ' + error.message);
                        return;
                    }
                    const { data: urlData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
                    imageUrls.push(urlData.publicUrl);
                } catch (e) {
                    showSnackbar('上传失败');
                    return;
                }
            }
            let content = '';
            if (imageUrls.length === 1) {
                content = `![](${imageUrls[0]})`;
            } else {
                content = imageUrls.map(url => `![](${url})`).join('\n');
                content = '🖼️ ' + content;
            }
            const payload = {
                session_id: privateSessionId,
                sender: currentUser,
                content: content
            };
            try {
                const newMsg = await safeInsertPrivateMsg(privateSessionId, currentUser, content);
                if (privateChannel) {
                    privateChannel.send({ type: 'broadcast', event: 'new_message', payload: newMsg });
                }
                privateMessages.push(newMsg);
                if (document.getElementById('privatePage').classList.contains('active')) {
                    renderPrivateMessage(newMsg);
                    checkPrivacyBanner();
                    const container = document.getElementById('privateMessages');
                    if (container) {
                        scrollToBottom(container);
                        updateScrollButton(container);
                        isUserScrolledUp = false;
                    }
                }
                notifyPrivateMsg(privateSessionId, currentUser);
                loadPrivateSessions();
            } catch (ie) {
                const msg = ie.message || '';
                showSnackbar(msg.includes('隐私') || msg.includes('拒收') ? msg : '发送失败: ' + msg);
            }
        }

        function privateOpenFilePicker() {
            privateCloseSubPanel();
            document.getElementById('privateFileInput').click();
        }

        async function privateHandleFileSelect(event) {
            const file = event.target.files[0];
            if (!file) return;
            event.target.value = '';
            if (file.size > 10 * 1024 * 1024) { showSnackbar('文件不能超过 10MB'); return; }
            showSnackbar('正在上传文件...');
            const ext = file.name.split('.').pop() || 'file';
            const filePath = `private/${privateSessionId}/files/${Date.now()}-${generateId()}.${ext}`;
            try {
                const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filePath, file, { contentType: file.type ||
                        'application/octet-stream', cacheControl: '3600' });
                if (error) {
                    if (error.message.includes('bucket') || error.message.includes('not found')) showSnackbar(
                        '上传失败: 请先在 Storage 创建 chat-images Bucket');
                    else showSnackbar('上传失败: ' + error.message);
                    return;
                }
                const { data: urlData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
                const fileSize = (file.size / 1024).toFixed(1);
                const content = `📎 ${file.name} (${fileSize} KB) → ${urlData.publicUrl}`;
                try {
                    const newMsg = await safeInsertPrivateMsg(privateSessionId, currentUser, content);
                    privateChannel.send({ type: 'broadcast', event: 'new_message', payload: newMsg });
                    privateMessages.push(newMsg);
                    if (document.getElementById('privatePage').classList.contains('active')) {
                        renderPrivateMessage(newMsg);
                        checkPrivacyBanner();
                        const container = document.getElementById('privateMessages');
                        if (container) {
                            scrollToBottom(container);
                            updateScrollButton(container);
                            isUserScrolledUp = false;
                        }
                    }
                    notifyPrivateMsg(privateSessionId, currentUser);
                    loadPrivateSessions();
                } catch (ie) { const msg = ie.message || ''; showSnackbar(msg.includes('隐私') || msg.includes('拒收') ? msg : '发送失败: ' + msg); }
            } catch (e) { showSnackbar('上传失败'); }
        }

        function privateInsertEmoji(emoji) {
            const input = document.getElementById('privateMsgInput');
            input.value += emoji;
            autoResize(input);
            togglePrivateSendBtn();
        }

        function privateOpenEmojiSubPanel() {
            document.getElementById('privateFeaturePanelMain').style.display = 'none';
            document.getElementById('privateEmojiSubPanel').classList.add('active');
        }

        function privateOpenTextEffectSubPanel() {
            document.getElementById('privateFeaturePanelMain').style.display = 'none';
            document.getElementById('privateTextEffectSubPanel').classList.add('active');
        }

        function privateOpenVoiceSubPanel() {
            document.getElementById('privateFeaturePanelMain').style.display = 'none';
            document.getElementById('privateVoiceSubPanel').classList.add('active');
        }

        function privateApplyTextEffect(tag) {
            const input = document.getElementById('privateMsgInput');
            const start = input.selectionStart;
            const end = input.selectionEnd;
            if (start === end) { showSnackbar('请先选中文字'); return; }
            const selected = input.value.substring(start, end);
            let wrapped;
            switch (tag) {
                case 'b':
                    wrapped = `<b>${selected}</b>`;
                    break;
                case 'i':
                    wrapped = `<i>${selected}</i>`;
                    break;
                case 'u':
                    wrapped = `<u>${selected}</u>`;
                    break;
                case 's':
                    wrapped = `<s>${selected}</s>`;
                    break;
                case 'none':
                    wrapped = selected;
                    break;
                default:
                    wrapped = selected;
            }
            input.setRangeText(wrapped, start, end, 'end');
            autoResize(input);
            togglePrivateSendBtn();
            const newPos = start + wrapped.length;
            input.setSelectionRange(newPos, newPos);
        }

        function initPrivateEmojiPicker() {
            const EMOJIS = ['😀', '😂', '🥰', '😎', '🤔', '😴', '😭', '😡', '👍', '👎', '❤️', '🔥', '🎉', '✨', '💯', '🚀', '👀', '🤝',
                '🙏', '💪', '☕', '🍕', '🎵', '⭐', '🌙', '🌸', '💎', '🎯', '🎨', '🎭', '🎪', '🎤', '🎧', '🎸', '🎹', '🎺', '🎻', '🥁', '🎲',
                '♟️', '🎳', '🎮', '🕹️', '🎬', '🎶', '🎼', '🥳', '🤯', '🤩', '😇', '🙃', '😉', '😋', '😜', '🤪', '🤭', '🫡', '🫶', '🤍',
                '💚', '💙', '🩵', '💜', '🤎', '🖤', '🤍', '💝', '💖', '💗', '💓', '💞', '💕', '💟', '❣️', '💔', '❤️‍🔥', '❤️‍🩹', '💘', '💌',
                '💋', '🫦', '💢', '💬', '🗯️', '💭', '💤', '💫', '🌀', '🌊', '🌈', '☀️', '🌤️', '⛅', '🌥️', '🌦️', '☁️', '🌧️', '⛈️', '🌩️',
                '🌨️', '❄️', '☃️', '⛄', '🌬️', '💨', '🌪️', '🌫️', '☁️', '🌊', '💧', '💦', '☔', '☂️', '🌂', '🧵', '🧶', '👗', '👘', '🥻',
                '🩱', '🩲', '🩳', '👙', '👚', '👕', '👖', '🧣', '🧤', '🧥', '🧦', '👔', '👞', '👟', '🥾', '🥿', '👠', '👡', '👢', '👑',
                '👒', '🎩', '🎓', '🧢', '⛑️', '📿', '💄', '💍', '💎', '🔮', '🎭', '🪞', '🪟', '🪑', '🛋️', '🛏️', '🛌', '🧻', '🧹', '🧺',
                '🧻', '🧽', '🧴', '🧷', '🧸', '🧩', '🧮', '🎲', '♟️', '🎯', '🎳', '🎮', '🕹️', '🎰', '🎲', '♠️', '♥️', '♦️', '♣️', '🃏',
                '🀄', '🎴', '🎭', '🎨', '🖼️', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🎷', '🎺', '🎸', '🪕', '🎻', '🎵', '🎶'
            ];
            document.getElementById('privateEmojiGrid').innerHTML = EMOJIS.map(e =>
                `<button class="emoji-item" onclick="privateInsertEmoji('${e}')">${e}</button>`).join('');
        }

        async function privateToggleRecording() {
            const btn = document.getElementById('privateRecordBtn');
            const timer = document.getElementById('privateRecordTimer');
            const hint = document.getElementById('privateRecordHint');
            const stopBtn = document.getElementById('privateRecordStopBtn');
            if (!privateMediaRecorder || privateMediaRecorder.state === 'inactive') {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    privateAudioChunks = [];
                    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
                    privateMediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
                    privateMediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) privateAudioChunks.push(e.data); };
                    privateMediaRecorder.onstop = async () => {
                        stream.getTracks().forEach(t => t.stop());
                        const audioBlob = new Blob(privateAudioChunks, { type: mimeType || 'audio/webm' });
                        if (audioBlob.size < 1000) { showSnackbar('录音时间太短');
                            privateResetRecordingUI(); return; }
                        await privateUploadAudio(audioBlob, mimeType || 'audio/webm');
                        privateResetRecordingUI();
                    };
                    privateMediaRecorder.start();
                    privateRecordStartTime = Date.now();
                    btn.classList.add('recording');
                    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
                    hint.textContent = '正在录音...';
                    stopBtn.classList.add('show');
                    privateRecordTimerInterval = setInterval(() => {
                        const elapsed = Math.floor((Date.now() - privateRecordStartTime) / 1000);
                        const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
                        const secs = String(elapsed % 60).padStart(2, '0');
                        timer.textContent = `${mins}:${secs}`;
                    }, 1000);
                } catch (e) {
                    showSnackbar('无法访问麦克风');
                }
            } else if (privateMediaRecorder.state === 'recording') {
                privateMediaRecorder.stop();
            }
        }

        function privateResetRecordingUI() {
            const btn = document.getElementById('privateRecordBtn');
            const timer = document.getElementById('privateRecordTimer');
            const hint = document.getElementById('privateRecordHint');
            const stopBtn = document.getElementById('privateRecordStopBtn');
            btn.classList.remove('recording');
            btn.innerHTML =
                '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
            timer.textContent = '00:00';
            hint.textContent = '点击开始录音';
            stopBtn.classList.remove('show');
            if (privateRecordTimerInterval) { clearInterval(privateRecordTimerInterval);
                privateRecordTimerInterval = null; }
        }

        async function privateUploadAudio(blob, mimeType) {
            const ext = mimeType.includes('webm') ? 'webm' : 'm4a';
            const filePath = `private/${privateSessionId}/audio/${Date.now()}-${generateId()}.${ext}`;
            showSnackbar('正在上传语音...');
            try {
                const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filePath, blob, { contentType: mimeType,
                    cacheControl: '3600' });
                if (error) {
                    if (error.message.includes('bucket') || error.message.includes('not found')) showSnackbar(
                        '上传失败: 请先在 Storage 创建 chat-images Bucket');
                    else showSnackbar('上传失败: ' + error.message);
                    return;
                }
                const { data: urlData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
                const duration = privateRecordStartTime ? Math.floor((Date.now() - privateRecordStartTime) / 1000) : 0;
                const mins = String(Math.floor(duration / 60)).padStart(2, '0');
                const secs = String(duration % 60).padStart(2, '0');
                const content = `🎤 语音 ${mins}:${secs} → ${urlData.publicUrl}`;
                try {
                    const newMsg = await safeInsertPrivateMsg(privateSessionId, currentUser, content);
                    if (privateChannel) {
                        privateChannel.send({ type: 'broadcast', event: 'new_message', payload: newMsg });
                    }
                    privateMessages.push(newMsg);
                    if (document.getElementById('privatePage').classList.contains('active')) {
                        renderPrivateMessage(newMsg);
                        const container = document.getElementById('privateMessages');
                        if (container) {
                            scrollToBottom(container);
                            updateScrollButton(container);
                            isUserScrolledUp = false;
                        }
                    }
                    notifyPrivateMsg(privateSessionId, currentUser);
                    loadPrivateSessions();
                } catch (ie) { const msg = ie.message || ''; showSnackbar(msg.includes('隐私') || msg.includes('拒收') ? msg : '发送失败: ' + msg); }
            } catch (e) { showSnackbar('上传失败'); }
        }

        function setPrivateReplyTarget(msgId, sender, content) {
            privateReplyTarget = { id: msgId, sender, content };
            const preview = document.getElementById('privateReplyPreview');
            document.getElementById('privateReplyContent').textContent = `回复 @${sender}：${content}`;
            preview.style.display = 'flex';
            document.getElementById('privateMsgInput').focus();
            togglePrivateSendBtn();
        }

        function cancelPrivateReply() {
            privateReplyTarget = null;
            document.getElementById('privateReplyPreview').style.display = 'none';
            togglePrivateSendBtn();
        }

        async function doSearch(query) {
            const container = document.getElementById('searchResults');
            if (!query.trim()) {
                container.innerHTML = '<div class="empty">输入用户名开始搜索</div>';
                return;
            }
            try {
                let users = null;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('search_users', { p_query: query.trim(), p_limit: 20 });
                    if (!rpcError && rpcData) { users = rpcData; }
                } catch (e) { /* RPC not found, continue */ }
                if (!users) {
                    const { data, error } = await sb.from(TABLE_USERS)
                        .select('username, avatar_url')
                        .ilike('username', `%${query.trim()}%`)
                        .neq('username', currentUser)
                        .limit(20);
                    if (error) { container.innerHTML = '<div class="empty">搜索失败（数据库权限受限）</div>'; return; }
                    users = data;
                }
                if (!users || users.length === 0) {
                    container.innerHTML = '<div class="empty">未找到用户</div>';
                    return;
                }
                var onlineUsernames = (function(){ var r=[]; var v=Object.values(onlineUsers); for(var i=0;i<v.length;i++){var a=v[i]; if(Array.isArray(a)){for(var j=0;j<a.length;j++){if(a[j]&&a[j].name)r.push(a[j].name);}}} return r; })();
                container.innerHTML = users.map(u => {
                    const idx = hashStr(u.username) % 8;
                    const isOnline = onlineUsernames.includes(u.username);
                    let avatarStyle = '';
                    if (u.avatar_url) {
                        avatarStyle = 'background-image:url(' + escapeAttr(sanitizeAvatarUrl(u.avatar_url)) + ');background-size:cover;background-position:center;';
                    }
                    return `<div class="result-item" onclick="showUserProfile('${escapeAttr(u.username)}')">
                                <div class="av av-${idx}" style="${avatarStyle}">${u.avatar_url ? '' : escapeHtml(u.username.charAt(0).toUpperCase())}</div>
                                <span class="name">${escapeHtml(u.username)}</span>
                                <span class="status">${isOnline ? '在线' : '离线'}</span>
                            </div>`;
                }).join('');
            } catch (e) { container.innerHTML = '<div class="empty">搜索出错</div>'; }
        }

        function renderOnlineUsers() {
            const users = [];
            (function(){ var e=Object.entries(onlineUsers); for(var i=0;i<e.length;i++){var ps=e[i][1]; if(Array.isArray(ps)){for(var j=0;j<ps.length;j++){if(ps[j]&&ps[j].name)users.push(ps[j].name);}}} })();
            const uniq = [...new Set(users)];
            document.getElementById('onlineCount').textContent = uniq.length;
            var poc = document.getElementById('publicOnlineCount');
            if (poc) poc.textContent = uniq.length;
            const container = document.getElementById('onlineListContainer');
            if (container) {
                container.innerHTML = uniq.map(name => {
                    const me = name === currentUser;
                    const idx = hashStr(name) % 8;
                    const avUrl = userAvatarCache[name];
                    const avStyle = avUrl ? ' style="background-image:url(\'' + escapeAttr(sanitizeAvatarUrl(avUrl)) + '\');background-size:cover;background-position:center;"' : '';
                    const avText = avUrl ? '' : escapeHtml(name.charAt(0).toUpperCase());
                    return `<div class="online-item" onclick="closeOnlineList();showUserProfile('${escapeAttr(name)}')">
                                <div class="av av-${idx}" data-username="${escapeAttr(name)}"${avStyle}>${avText}</div>
                                <span class="name">${escapeHtml(name)}${me ? ' <span class="me-tag">(我)</span>' : ''}</span>
                            </div>`;
                }).join('');
            }
        }

        function showOnlineList() {
            document.getElementById('onlineListModal').classList.remove('hidden');
            renderOnlineUsers();
        }

        function closeOnlineList() {
            document.getElementById('onlineListModal').classList.add('hidden');
        }

        async function showUserProfile(username) {
            if (!username) return;
            const modal = document.getElementById('userProfileModal');
            const avatarEl = document.getElementById('userProfileAvatar');

            avatarEl.className = 'profile-avatar';
            avatarEl.style.backgroundImage = '';
            avatarEl.textContent = '...';
            document.getElementById('userProfileUsername').textContent = '加载中...';
            document.getElementById('userProfileRole').textContent = '加载中...';
            document.getElementById('userProfileStatus').textContent = '加载中...';
            document.getElementById('userProfileOnline').textContent = '加载中...';
            document.getElementById('userProfileOnlineItem').style.display = 'flex';
            document.getElementById('userProfileChatBtn').style.display = 'none';
            document.getElementById('userProfileBanBtn').style.display = 'none';
            document.getElementById('userProfileForceLogoutBtn').style.display = 'none';
            document.getElementById('userProfileDeleteBtn').style.display = 'none';
            modal.classList.remove('hidden');

            function getOnlineStatus(name) {
                var onlineUsernames = (function(){ var r=[]; var v=Object.values(onlineUsers); for(var i=0;i<v.length;i++){var a=v[i]; if(Array.isArray(a)){for(var j=0;j<a.length;j++){if(a[j]&&a[j].name)r.push(a[j].name);}}} return r; })();
                return onlineUsernames.includes(name);
            }

            function renderUserProfile(data, isOnline) {
                const idx = hashStr(data.username) % 8;
                avatarEl.className = 'profile-avatar av-' + idx;
                if (data.avatar_url) {
                    avatarEl.style.backgroundImage = `url(${data.avatar_url})`;
                    avatarEl.textContent = '';
                    userAvatarCache[data.username] = data.avatar_url;
                } else {
                    avatarEl.style.backgroundImage = '';
                    avatarEl.textContent = data.username.charAt(0).toUpperCase();
                }
                document.getElementById('userProfileUsername').textContent = data.username;
                document.getElementById('userProfileRole').textContent = data.role === 'admin' ? '管理员' : '普通用户';
                let statusText = '正常';
                if (data.banned) statusText = '已封禁';
                document.getElementById('userProfileStatus').textContent = statusText;
                document.getElementById('userProfileOnline').textContent = isOnline ? '在线' : '离线';
                document.getElementById('userProfileOnlineItem').style.display = 'flex';

                const chatBtn = document.getElementById('userProfileChatBtn');
                chatBtn.style.display = data.username === currentUser ? 'none' : 'block';
                const banBtn = document.getElementById('userProfileBanBtn');
                if (isAdmin && data.username !== currentUser) {
                    banBtn.style.display = 'block';
                    banBtn.textContent = data.banned ? '解封此用户' : '封禁此用户';
                    banBtn.dataset.username = data.username;
                    banBtn.dataset.banned = data.banned;
                } else {
                    banBtn.style.display = 'none';
                }
                const forceBtn = document.getElementById('userProfileForceLogoutBtn');
                if (isAdmin && data.username !== currentUser && isOnline) {
                    forceBtn.style.display = 'block';
                    forceBtn.dataset.username = data.username;
                } else {
                    forceBtn.style.display = 'none';
                }
                const deleteBtn = document.getElementById('userProfileDeleteBtn');
                if (isAdmin && data.username !== currentUser) {
                    deleteBtn.style.display = 'block';
                    deleteBtn.dataset.username = data.username;
                } else {
                    deleteBtn.style.display = 'none';
                }
            }

            function renderDeletedUser(name) {
                const idx = hashStr(name) % 8;
                avatarEl.className = 'profile-avatar av-' + idx;
                avatarEl.style.backgroundImage = '';
                avatarEl.textContent = name.charAt(0).toUpperCase();
                document.getElementById('userProfileUsername').textContent = name;
                document.getElementById('userProfileRole').textContent = '未知';
                document.getElementById('userProfileStatus').textContent = '已注销';
                document.getElementById('userProfileOnline').textContent = '离线';
                document.getElementById('userProfileOnlineItem').style.display = 'flex';
                document.getElementById('userProfileChatBtn').style.display = 'none';
                document.getElementById('userProfileBanBtn').style.display = 'none';
                document.getElementById('userProfileForceLogoutBtn').style.display = 'none';
                document.getElementById('userProfileDeleteBtn').style.display = 'none';
            }

            try {
                let profileData = null;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('get_user_profile', { p_username: username });
                    if (!rpcError && rpcData && rpcData.success !== false) {
                        profileData = rpcData;
                    }
                } catch (e) { /* RPC not found, continue */ }

                if (!profileData) {
                    const { data, error } = await sb.from(TABLE_USERS).select('username, role, banned, avatar_url')
                        .eq('username', username).maybeSingle();
                    if (!error && data) {
                        profileData = data;
                    }
                    if (error && error.message && (error.message.includes('role') || error.message.includes('banned'))) {
                        const { data: data2 } = await sb.from(TABLE_USERS).select('username, avatar_url')
                            .eq('username', username).maybeSingle();
                        if (data2) {
                            profileData = { username: data2.username, avatar_url: data2.avatar_url, role: 'user', banned: false };
                        }
                    }
                }

                const isOnline = getOnlineStatus(username);

                if (profileData) {
                    renderUserProfile(profileData, isOnline);
                } else if (isOnline) {
                    const cachedAvatar = userAvatarCache[username] || '';
                    renderUserProfile({
                        username: username,
                        avatar_url: cachedAvatar,
                        role: 'user',
                        banned: false
                    }, true);
                } else {
                    renderDeletedUser(username);
                }
            } catch (e) {
                const isOnline = getOnlineStatus(username);
                if (isOnline) {
                    const cachedAvatar = userAvatarCache[username] || '';
                    renderUserProfile({
                        username: username,
                        avatar_url: cachedAvatar,
                        role: 'user',
                        banned: false
                    }, true);
                } else {
                    const idx = hashStr(username) % 8;
                    avatarEl.className = 'profile-avatar av-' + idx;
                    avatarEl.style.backgroundImage = '';
                    avatarEl.textContent = username.charAt(0).toUpperCase();
                    document.getElementById('userProfileUsername').textContent = username;
                    document.getElementById('userProfileRole').textContent = '未知';
                    document.getElementById('userProfileStatus').textContent = '未知';
                    document.getElementById('userProfileOnline').textContent = '离线';
                    document.getElementById('userProfileOnlineItem').style.display = 'none';
                    document.getElementById('userProfileChatBtn').style.display = 'none';
                    document.getElementById('userProfileBanBtn').style.display = 'none';
                    document.getElementById('userProfileForceLogoutBtn').style.display = 'none';
                    document.getElementById('userProfileDeleteBtn').style.display = 'none';
                }
            }
        }

        function closeUserProfile() {
            document.getElementById('userProfileModal').classList.add('hidden');
        }

        async function banUserFromProfile() {
            const btn = document.getElementById('userProfileBanBtn');
            const username = btn.dataset.username;
            const currentlyBanned = btn.dataset.banned === 'true';
            const newState = !currentlyBanned;
            if (!confirm(`确定要${newState?'封禁':'解封'}用户 ${username} 吗？`)) return;

            const isAdm = await verifyAdminSession();
            if (!isAdm) { showSnackbar('无权限执行此操作'); return; }

            try {
                const { data, error } = await sb.rpc('ban_user', {
                    p_admin: currentUser,
                    p_target: username,
                    p_session_token: getSessionToken(),
                    p_ban: newState
                });
                if (error || (data && data.success === false)) { showSnackbar('操作失败: ' + (data?.message || error?.message || '')); return; }
                showSnackbar(`用户 ${username} 已${newState?'封禁':'解封'}`);
                if (newState && username === currentUser) {
                    showSnackbar('您已被封禁，即将下线');
                    setTimeout(() => logout(), 1000);
                }
                if (newState) {
                    publicChannel.send({ type: 'broadcast', event: 'user_banned', payload: { username, initiator: currentUser } });
                }
                showUserProfile(username);
            } catch (e) { showSnackbar('操作失败'); }
        }

        async function forceLogoutUser() {
            const isAdm = await verifyAdminSession();
            if (!isAdm) { showSnackbar('无权限执行此操作'); return; }
            const btn = document.getElementById('userProfileForceLogoutBtn');
            const username = btn.dataset.username;
            if (!confirm(`确定要强制下线用户 ${username} 吗？`)) return;
            try {
                publicChannel.send({ type: 'broadcast', event: 'force_logout', payload: { username } });
                showSnackbar(`已向 ${username} 发送下线指令`);
            } catch (e) { showSnackbar('操作失败'); }
        }

        async function adminDeleteUser() {
            const btn = document.getElementById('userProfileDeleteBtn');
            const username = btn.dataset.username;
            if (!username || username === currentUser) return;
            const confirmMsg =
                `确认注销？\n确定要彻底注销该账号吗？\n此操作将：\n1. 永久删除此账户\n2. 发送的所有公共消息将标记为"已注销"\n3. 私聊会话将被删除\n此操作不可恢复！`;
            if (!confirm(confirmMsg)) return;
            const isAdm = await verifyAdminSession();
            if (!isAdm) { showSnackbar('无权限执行此操作'); return; }
            try {
                const { data, error } = await sb.rpc('admin_delete_user', {
                    p_admin: currentUser,
                    p_target: username,
                    p_session_token: getSessionToken()
                });
                if (error || (data && data.success === false)) {
                    showSnackbar('操作失败: ' + (data?.message || error?.message || ''));
                    return;
                }
                if (publicChannel) {
                    publicChannel.send({ type: 'broadcast', event: 'user_deleted', payload: { username: username,
                            forceLogout: false, initiator: currentUser } });
                }
                showSnackbar(`已注销账号 ${username}`);
                closeUserProfile();
                refreshPublicMessages();
                updatePublicEntry();
                if ((function(){ var v=Object.values(onlineUsers); for(var i=0;i<v.length;i++){var a=v[i]; if(Array.isArray(a)){for(var j=0;j<a.length;j++){if(a[j]&&a[j].name===username)return true;}}} return false; })()) {
                    publicChannel.send({ type: 'broadcast', event: 'force_logout', payload: { username } });
                }
            } catch (e) {
                showSnackbar('操作失败');
            }
        }

        async function showAllUsers() {
            document.getElementById('allUsersModal').classList.remove('hidden');
            try {
                let users = null;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('get_all_users');
                    if (!rpcError && rpcData) { users = rpcData; }
                } catch (e) { /* RPC not found, continue */ }
                if (!users) {
                    const { data, error } = await sb.from(TABLE_USERS)
                        .select('username, avatar_url, role, banned')
                        .order('username', { ascending: true });
                    if (error) {
                        document.getElementById('allUsersList').innerHTML = '<p>加载失败（数据库权限受限，请创建 get_all_users RPC 函数）</p>';
                        return;
                    }
                    users = data;
                }
                if (!users || users.length === 0) {
                    document.getElementById('allUsersList').innerHTML = '<p style="text-align:center;color:var(--md-on-surface-dim);">暂无用户</p>';
                    return;
                }
                let html = '';
                users.forEach(u => {
                    const idx = hashStr(u.username) % 8;
                    let avatarStyle = '';
                    if (u.avatar_url) {
                        avatarStyle = 'background-image:url(' + escapeAttr(sanitizeAvatarUrl(u.avatar_url)) + ');background-size:cover;background-position:center;';
                    }
                    const isBanned = u.banned ? '🚫' : '✅';
                    const roleIcon = u.role === 'admin' ? '👑' : '👤';
                    html += `
                        <div style="display:flex;align-items:center;padding:8px 4px;border-bottom:1px solid var(--md-outline);gap:8px;">
                            <div style="width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;color:white;flex-shrink:0;${avatarStyle}" class="av-${idx}">${u.avatar_url ? '' : u.username.charAt(0).toUpperCase()}</div>
                            <div style="flex:1;min-width:0;">
                                <div style="font-weight:500;font-size:0.875rem;">${escapeHtml(u.username)}</div>
                                <div style="font-size:0.7rem;color:var(--md-on-surface-dim);display:flex;gap:6px;flex-wrap:wrap;">
                                    <span>${roleIcon} ${escapeHtml(u.role || 'user')}</span>
                                    <span>${isBanned}</span>
                                </div>
                            </div>
                            <button class="md-button text" style="padding:2px 12px;height:28px;font-size:0.7rem;text-transform:none;background:var(--md-primary);color:var(--md-on-primary);border-radius:4px;" onclick="simulateLogin('${escapeAttr(u.username)}')">登录</button>
                        </div>
                    `;
                });
                document.getElementById('allUsersList').innerHTML = html;
            } catch (e) {
                document.getElementById('allUsersList').innerHTML = '<p>加载失败</p>';
            }
        }

        function closeAllUsersModal() {
            document.getElementById('allUsersModal').classList.add('hidden');
        }

        async function simulateLogin(username) {
            const isAdm = await verifyAdminSession();
            if (!isAdm) { showSnackbar('无权限执行此操作'); return; }
            if (!confirm(`确定要以 ${username} 的身份登录吗？此操作不会修改任何密码或数据。`)) return;
            try {
                let adminRole = null;
                try {
                    const { data: rpcData } = await sb.rpc('get_user_profile', { p_username: currentUser });
                    if (rpcData && rpcData.success !== false) adminRole = rpcData;
                } catch (e) { /* RPC not found */ }
                if (!adminRole || adminRole.role !== 'admin') {
                    showSnackbar('权限验证失败');
                    return;
                }
                currentUser = username;
                let userData = null;
                try {
                    const { data: rpcData } = await sb.rpc('get_user_profile', { p_username: username });
                    if (rpcData && rpcData.success !== false) userData = rpcData;
                } catch (e) { /* RPC not found */ }
                if (!userData) {
                    const { data } = await sb.from(TABLE_USERS).select('role, avatar_url, banned').eq('username', username)
                        .maybeSingle();
                    userData = data;
                }
                if (userData) {
                    isAdmin = (userData.role === 'admin');
                    currentAvatarUrl = userData.avatar_url || '';
                    userAvatarCache[currentUser] = currentAvatarUrl;
                    if (userData.banned) {
                        showSnackbar('该用户已被封禁，但您仍可登录（仅查看）');
                    }
                } else {
                    isAdmin = false;
                    currentAvatarUrl = '';
                }
                localStorage.setItem('mjchat_session', JSON.stringify({ username: username, token: 'admin_switch_' + Date.now() }));
                showSnackbar(`已切换至 ${username}`);
                closeAllUsersModal();
                isEntered = false;
                publicMessages = [];
                privateMessages = [];
                onlineUsers = {};
                if (privatePollTimer) { clearInterval(privatePollTimer); privatePollTimer = null; }
                if (globalPrivateChannel) { sb.removeChannel(globalPrivateChannel); globalPrivateChannel = null; }
                if (publicChannel) { publicChannel.untrack();
                    sb.removeChannel(publicChannel);
                    publicChannel = null; }
                if (privateChannel) { sb.removeChannel(privateChannel);
                    privateChannel = null; }
                document.getElementById('authContainer').style.display = 'none';
                document.getElementById('appContainer').style.display = 'flex';
                authorizeEnterApp();
                enterApp();
            } catch (e) {
                showSnackbar('登录失败: ' + e.message);
            }
        }

        async function showStats() {
            document.getElementById('statsModal').classList.remove('hidden');
            try {
                const { count: totalMsgs } = await sb.from(TABLE_PUBLIC_MSG).select('*', { count: 'exact', head: true });
                let totalUsers = 0;
                try {
                    const { data: rpcData } = await sb.rpc('get_all_users');
                    if (rpcData) totalUsers = rpcData.filter(u => !u.banned).length;
                } catch (e) {
                    const { count } = await sb.from(TABLE_USERS).select('*', { count: 'exact', head: true })
                        .eq('banned', false);
                    totalUsers = count || 0;
                }
                const currentOnline = Object.keys(onlineUsers).length;
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const { count: todayMsgs } = await sb.from(TABLE_PUBLIC_MSG)
                    .select('*', { count: 'exact', head: true })
                    .gte('created_at', today.toISOString());

                const html = `
                    <div><strong>群内消息总数：</strong>${totalMsgs || 0}</div>
                    <div><strong>今日消息数：</strong>${todayMsgs || 0}</div>
                    <div><strong>当前在线用户数：</strong>${currentOnline}</div>
                    <div><strong>历史最高在线用户数：</strong>${currentOnline}（需额外存储）</div>
                    <div><strong>今日最高在线用户数：</strong>${currentOnline}（需额外存储）</div>
                    <div><strong>有效账号数（不含封禁/注销）：</strong>${totalUsers}</div>
                    <div style="font-size:0.7rem;color:var(--md-on-surface-dim);margin-top:8px;">注：历史峰值和今日峰值需额外实现存储。</div>
                `;
                document.getElementById('statsContent').innerHTML = html;
            } catch (e) {
                document.getElementById('statsContent').innerHTML = '<p>加载统计失败</p>';
            }
        }

        function closeStatsModal() {
            document.getElementById('statsModal').classList.add('hidden');
        }

        /* Removed: showLoginHistory and closeLoginHistoryModal */

        async function showBannedList() {
            document.getElementById('bannedListModal').classList.remove('hidden');
            await refreshBannedList();
        }

        function closeBannedList() {
            document.getElementById('bannedListModal').classList.add('hidden');
        }

        async function refreshBannedList() {
            const container = document.getElementById('bannedListContainer');
            try {
                let bannedUsers = null;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('get_all_users');
                    if (!rpcError && rpcData) {
                        bannedUsers = rpcData.filter(u => u.banned);
                    }
                } catch (e) { /* RPC not found */ }
                if (!bannedUsers) {
                    const { data, error } = await sb.from(TABLE_USERS).select('username').eq('banned', true);
                    if (error) { container.innerHTML = '<p>加载失败（数据库权限受限）</p>'; return; }
                    bannedUsers = data;
                }
                if (!bannedUsers || bannedUsers.length === 0) {
                    container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-dim);">暂无封禁用户</p>';
                    return;
                }
                container.innerHTML = bannedUsers.map(u =>
                    `<div class="banned-item">
                            <span class="name">${escapeHtml(u.username)}</span>
                            <button class="unban-btn" onclick="unbanUser('${escapeAttr(u.username)}')">解封</button>
                        </div>`
                ).join('');
            } catch (e) { container.innerHTML = '<p>加载失败</p>'; }
        }

        async function unbanUser(username) {
            if (!confirm(`确定要解封用户 ${username} 吗？`)) return;
            try {
                const { error } = await sb.rpc('ban_user', {
                    p_admin: currentUser,
                    p_target: username,
                    p_ban: false,
                    p_session_token: getSessionToken()
                });
                if (error) { showSnackbar('操作失败: ' + error.message); return; }
                showSnackbar(`已解封 ${username}`);
                refreshBannedList();
            } catch (e) { showSnackbar('操作失败'); }
        }

        function showAgentList() {
            document.getElementById('agentListModal').classList.remove('hidden');
            loadAgentList();
        }

        function closeAgentList() {
            document.getElementById('agentListModal').classList.add('hidden');
        }

        async function loadAgentList() {
            const container = document.getElementById('agentListContainer');
            container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-dim);">加载中...</p>';
            try {
                let agents = null;
                let rpcErrMsg = null;
                // Try RPC first
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('get_agents');
                    if (!rpcError && rpcData !== null && rpcData !== undefined) {
                        let parsed = rpcData;
                        if (typeof parsed === 'string') {
                            try { parsed = JSON.parse(parsed); } catch (e) { parsed = []; }
                        }
                        agents = Array.isArray(parsed) ? parsed : [];
                    } else if (rpcError) {
                        rpcErrMsg = rpcError.message || '';
                    }
                } catch (e) { rpcErrMsg = e.message || ''; }
                // Fallback to direct table query if RPC failed
                if (!agents) {
                    const { data, error } = await sb.from(TABLE_AGENTS)
                        .select('id, name, provider, model, created_by, created_at')
                        .order('created_at', { ascending: true });
                    if (error) {
                        var hint = '加载失败';
                        if (rpcErrMsg) {
                            hint = 'RPC错误: ' + rpcErrMsg + ' | 表查询错误: ' + (error.message || '未知');
                        } else {
                            hint = '加载失败: ' + (error.message || '未知错误');
                        }
                        container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-dim);font-size:0.8rem;">' + escapeHtml(hint) + '</p>';
                        return;
                    }
                    agents = data || [];
                }
                if (!agents || agents.length === 0) {
                    container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-dim);">暂无智能体</p>';
                    return;
                }
                const providerLabels = {
                    'openai': 'OpenAI', 'google': 'Google', 'anthropic': 'Anthropic',
                    'baidu': '百度', 'ali': '阿里', 'bytedance': '字节', 'zhipu': '智谱',
                    'deepseek': 'DeepSeek', 'custom': '自定义'
                };
                const agentNames = agents.map(a => a.name).filter(Boolean);
                if (agentNames.length > 0) {
                    await loadUserAvatars(agentNames);
                }
                container.innerHTML = agents.map(agent => {
                    const canDelete = (agent.created_by === currentUser) || isAdmin;
                    const providerText = providerLabels[agent.provider] || agent.provider || '自定义';
                    const modelText = agent.model ? ' · ' + escapeHtml(agent.model) : '';
                    const isActive = activeAgent && activeAgent.id === agent.id;
                    const avatarIdx = hashStr(agent.name) % 8;
                    let avatarStyle = '';
                    if (userAvatarCache[agent.name]) {
                        avatarStyle = 'background-image:url(' + escapeAttr(sanitizeAvatarUrl(userAvatarCache[agent.name])) + ');';
                    }
                    var activeStyle = isActive ? 'border-color:var(--md-primary);background:rgba(74,158,255,0.05);' : '';
                    var useBtnStyle = 'background:' + (isActive ? 'var(--md-primary)' : 'transparent') + ';color:' + (isActive ? '#fff' : 'var(--md-primary)') + ';border:1px solid var(--md-primary);border-radius:8px;padding:6px 16px;font-size:0.75rem;font-weight:500;cursor:pointer;';
                    return '<div class="agent-item" style="' + activeStyle + '">' +
                                '<div class="avatar av-' + avatarIdx + '" style="' + avatarStyle + '">' + (userAvatarCache[agent.name] ? '' : escapeHtml(agent.name.charAt(0).toUpperCase())) + '</div>' +
                                '<div class="info">' +
                                    '<div class="name">' + escapeHtml(agent.name) + (isActive ? ' <span style="color:var(--md-primary);font-size:0.7rem;">使用中</span>' : '') + '</div>' +
                                    '<div class="provider">' + escapeHtml(providerText) + modelText + '</div>' +
                                    '<div class="creator">添加者：' + escapeHtml(agent.created_by || '未知') + '</div>' +
                                '</div>' +
                                '<div style="display:flex;gap:8px;align-items:center;">' +
                                    '<button class="use-agent-btn" onclick="useAgent(\'' + agent.id + '\')" style="' + useBtnStyle + '">' + (isActive ? '取消' : '使用') + '</button>' +
                                    (canDelete ? '<button class="delete-btn" onclick="deleteAgent(\'' + agent.id + '\')"><svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg></button>' : '') +
                                '</div>' +
                            '</div>';
                }).join('');
            } catch (e) {
                container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-dim);">加载失败：' + escapeHtml(e.message || '未知错误') + '</p>';
            }
        }

        async function deleteAgent(agentId) {
            if (!confirm('确定要删除此智能体吗？\n智能体的用户账号也将被删除。')) return;
            try {
                let deleted = false;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('delete_agent_rpc', {
                        p_agent_id: agentId,
                        p_username: currentUser
                    });
                    if (!rpcError && rpcData && rpcData.success) { deleted = true; }
                    else if (rpcData && rpcData.success === false) {
                        showSnackbar(rpcData.message || '删除失败'); return;
                    }
                } catch (e) { /* RPC fallback */ }
                if (!deleted) {
                    // Direct delete fallback (may fail if RLS blocks it)
                    const { error } = await sb.from(TABLE_AGENTS).delete().eq('id', agentId);
                    if (error) { showSnackbar('删除失败: ' + error.message); return; }
                }
                showSnackbar('智能体已删除');
                loadAgentList();
            } catch (e) { showSnackbar('删除失败'); }
        }

        function showAddAgentDialog() {
            document.getElementById('addAgentDialog').classList.remove('hidden');
            document.getElementById('agentName').value = '';
            document.getElementById('agentApiKey').value = '';
            document.getElementById('agentProvider').value = 'openai';
            document.getElementById('agentModel').value = 'gpt-3.5-turbo';
        }

        function updateAgentModelDefault() {
            const provider = document.getElementById('agentProvider').value;
            const modelInput = document.getElementById('agentModel');
            const defaults = {
                'openai': 'gpt-3.5-turbo',
                'google': 'gemini-1.5-flash',
                'anthropic': 'claude-3-5-sonnet-20241022',
                'baidu': 'ernie-4.0-8k-latest',
                'ali': 'qwen3.7-flash',
                'bytedance': 'doubao-pro-4k',
                'zhipu': 'glm-4-flash',
                'deepseek': 'deepseek-v4-flash',
                'custom': 'gpt-3.5-turbo'
            };
            modelInput.value = defaults[provider] || 'gpt-3.5-turbo';
        }

        function closeAddAgentDialog() {
            document.getElementById('addAgentDialog').classList.add('hidden');
            document.getElementById('agentApiKey').value = '';
        }

        async function saveAgent() {
            const name = document.getElementById('agentName').value.trim();
            const provider = document.getElementById('agentProvider').value;
            const apiKey = document.getElementById('agentApiKey').value.trim();
            const model = document.getElementById('agentModel').value.trim() || 'gpt-3.5-turbo';
            if (!name) { showSnackbar('请输入智能体名称'); return; }
            if (!apiKey) { showSnackbar('请输入 API Key'); return; }
            try {
                let saved = false;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('save_agent', {
                        p_name: name,
                        p_provider: provider,
                        p_api_key: apiKey,
                        p_model: model,
                        p_created_by: currentUser
                    });
                    if (!rpcError && rpcData && rpcData.success) { saved = true; }
                    else if (rpcData && rpcData.success === false) {
                        showSnackbar(rpcData.message || '保存失败'); return;
                    }
                } catch (e) { /* RPC fallback */ }
                if (!saved) {
                    await ensureAgentUserAccount(name);
                    const { error } = await sb.from(TABLE_AGENTS).insert({
                        name: name,
                        provider: provider,
                        api_key: apiKey,
                        model: model,
                        created_by: currentUser
                    });
                    if (error) {
                        showSnackbar('保存失败: ' + error.message);
                        return;
                    }
                }
                showSnackbar('智能体已添加');
                document.getElementById('agentApiKey').value = '';
                closeAddAgentDialog();
                broadcastSystemMsg(`智能体 ${name} 已加入聊天室`);
                loadAgentList();
            } catch (e) {
                showSnackbar('保存失败');
            }
        }

        let activeAgent = null;

        async function useAgent(agentId) {
            closeAgentList();
            const input = document.getElementById('publicMsgInput');
            if (!input) return;
            if (activeAgent && activeAgent.id === agentId) {
                activeAgent = null;
                input.value = input.value.replace(/@[\w\u4e00-\u9fa5]+\s?/, '').trim();
                autoResize(input);
                togglePublicSendBtn();
                showSnackbar('已取消智能体');
                return;
            }
            const agentName = await getAgentName(agentId);
            activeAgent = { id: agentId, name: agentName };
            input.value = `@${agentName} `;
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
            autoResize(input);
            togglePublicSendBtn();
            showSnackbar(`已选择 ${agentName}，输入消息后发送`);
        }

        async function getAgentName(agentId) {
            try {
                let agentName = null;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('get_agents');
                    if (!rpcError && rpcData) {
                        const agents = Array.isArray(rpcData) ? rpcData : [];
                        const agent = agents.find(a => a.id === agentId);
                        if (agent) agentName = agent.name;
                    }
                } catch (e) { /* RPC fallback */ }
                if (!agentName) {
                    const { data, error } = await sb.from(TABLE_AGENTS)
                        .select('name').eq('id', agentId).single();
                    if (!error && data) agentName = data.name;
                }
                return agentName || '智能体';
            } catch (e) { return '智能体'; }
        }

        function showAvatarMenu() {
            document.getElementById('avatarMenu').classList.remove('hidden');
            const overlay = document.createElement('div');
            overlay.id = 'avatarMenuOverlay';
            overlay.style.position = 'fixed';
            overlay.style.inset = '0';
            overlay.style.zIndex = '140';
            overlay.style.background = 'rgba(0,0,0,0.3)';
            overlay.onclick = function() { closeAvatarMenu(); };
            document.body.appendChild(overlay);
        }

        function closeAvatarMenu() {
            document.getElementById('avatarMenu').classList.add('hidden');
            const overlay = document.getElementById('avatarMenuOverlay');
            if (overlay) overlay.remove();
        }

        function setDefaultAvatar() {
            const colors = ['#4A9EFF', '#BA68C8', '#4DB6AC', '#4FC3F7', '#FF8A65', '#A1887F', '#90A4AE', '#F06292'];
            const color = colors[Math.floor(Math.random() * colors.length)];
            sb.rpc('update_avatar', { p_username: currentUser, p_avatar_url: null })
                .then(() => {
                    currentAvatarUrl = '';
                    userAvatarCache[currentUser] = '';
                    if (publicChannel) {
                        publicChannel.send({ type: 'broadcast', event: 'avatar_changed', payload: { username: currentUser, avatar_url: '' } });
                    }
                    updateAllAvatars();
                    updateHomeMenu();
                    updatePublicMenu();
                    const avatarEl = document.getElementById('profileDialogAvatar');
                    avatarEl.style.backgroundImage = '';
                    avatarEl.textContent = currentUser.charAt(0).toUpperCase();
                    avatarEl.style.backgroundColor = color;
                    showSnackbar('已设置为默认头像');
                    closeAvatarMenu();
                })
                .catch(e => { showSnackbar('设置失败: ' + e.message); });
        }

        function uploadAvatarFromMenu() {
            closeAvatarMenu();
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.onchange = async function(e) {
                const file = e.target.files[0];
                if (!file) return;
                if (file.size > MAX_IMAGE_SIZE) { showSnackbar('图片不能超过 5MB'); return; }
                showSnackbar('上传头像中...');
                let blob = file;
                if (file.size > COMPRESS_THRESHOLD) {
                    blob = await compressImage(file, 256, 0.8);
                }
                const filePath = `avatars/${currentUser}-${Date.now()}.jpg`;
                try {
                    const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filePath, blob, { contentType: 'image/jpeg',
                        cacheControl: '3600' });
                    if (error) {
                        showSnackbar('上传失败: ' + error.message);
                        return;
                    }
                    const { data: urlData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
                    const { error: upError } = await sb.rpc('update_avatar', {
                        p_username: currentUser,
                        p_avatar_url: urlData.publicUrl
                    });
                    if (upError) {
                        showSnackbar('更新失败: ' + upError.message);
                        return;
                    }
                    currentAvatarUrl = urlData.publicUrl;
                    userAvatarCache[currentUser] = urlData.publicUrl;
                    if (publicChannel) {
                        publicChannel.send({ type: 'broadcast', event: 'avatar_changed', payload: { username: currentUser, avatar_url: urlData.publicUrl } });
                    }
                    updateAllAvatars();
                    updateHomeMenu();
                    updatePublicMenu();
                    const avatarEl = document.getElementById('profileDialogAvatar');
                    avatarEl.style.backgroundImage = `url(${urlData.publicUrl})`;
                    avatarEl.textContent = '';
                    showSnackbar('头像已更新');
                } catch (e) { showSnackbar('上传失败'); }
            };
            input.click();
        }

        function showChangePasswordDialog() {
            document.getElementById('changePasswordDialog').classList.remove('hidden');
            document.getElementById('changeOldPassword').value = '';
            document.getElementById('changeNewPassword').value = '';
            document.getElementById('changeConfirmPassword').value = '';
        }

        function closeChangePasswordDialog() {
            document.getElementById('changePasswordDialog').classList.add('hidden');
        }

        async function doChangePassword() {
            const oldPwd = document.getElementById('changeOldPassword').value;
            const newPwd = document.getElementById('changeNewPassword').value;
            const confirmPwd = document.getElementById('changeConfirmPassword').value;
            if (!oldPwd || !newPwd || !confirmPwd) {
                showSnackbar('请完整填写密码字段');
                return;
            }
            if (newPwd.length < 6) {
                showSnackbar('新密码至少6位');
                return;
            }
            if (newPwd !== confirmPwd) {
                showSnackbar('两次输入的新密码不一致');
                return;
            }
            const oldHash = await hashPassword(oldPwd);
            const newHash = await hashPassword(newPwd);
            let changeError = null;
            let newSessionToken = null;
            try {
                const { data: changeData, error: secureError } = await sb.rpc('change_password_secure', {
                    p_username: currentUser,
                    p_old_hash: oldHash,
                    p_new_hash: newHash
                });
                if (!secureError && changeData) {
                    newSessionToken = changeData.session_token;
                } else if (secureError) {
                    changeError = secureError;
                }
            } catch (e) { changeError = e; }
            if (changeError) {
                const { error } = await sb.rpc('change_password', {
                    p_username: currentUser,
                    p_old_hash: oldHash,
                    p_new_hash: newHash
                });
                if (error) {
                    showSnackbar('更改密码失败: ' + error.message);
                    return;
                }
            }
            if (newSessionToken) {
                localStorage.setItem('mjchat_session', JSON.stringify({ username: currentUser, token: newSessionToken }));
            }
            showSnackbar('密码更改成功');
            closeChangePasswordDialog();
        }

        function showAdminDialog() {
            document.getElementById('adminDialog').classList.remove('hidden');
        }

        function closeAdminDialog() {
            document.getElementById('adminDialog').classList.add('hidden');
        }

        /* Removed: cleanupGarbledMsgs */

        function showClearDialog() {
            document.getElementById('clearDialog').classList.remove('hidden');
        }

        function hideClearDialog() {
            document.getElementById('clearDialog').classList.add('hidden');
        }

        function showConfirm(title, message, callback) {
            document.getElementById('confirmTitle').textContent = title;
            document.getElementById('confirmMessage').textContent = message;
            confirmCallback = callback;
            document.getElementById('confirmOkBtn').onclick = function() {
                var cb = confirmCallback;
                document.getElementById('confirmDialog').classList.add('hidden');
                confirmCallback = null;
                if (cb) cb();
            };
            document.getElementById('confirmDialog').classList.remove('hidden');
        }

        function closeConfirmDialog() {
            document.getElementById('confirmDialog').classList.add('hidden');
            confirmCallback = null;
        }

        function logout() {
            if (privatePollTimer) { clearInterval(privatePollTimer); privatePollTimer = null; }
            // v040: Clean up public chat polling timers
            if (_publicPollTimer) { clearInterval(_publicPollTimer); _publicPollTimer = null; }
            if (_publicBackupPollTimer) { clearInterval(_publicBackupPollTimer); _publicBackupPollTimer = null; }
            _publicRetryCount = 0;
            if (globalPrivateChannel) { sb.removeChannel(globalPrivateChannel); globalPrivateChannel = null; }
            if (publicChannel) { publicChannel.untrack();
                sb.removeChannel(publicChannel);
                publicChannel = null; }
            if (privateChannel) { sb.removeChannel(privateChannel);
                privateChannel = null; }
            localStorage.removeItem('mjchat_session');
            currentUser = '';
            isAdmin = false;
            publicMessages = [];
            privateMessages = [];
            onlineUsers = {};
            isEntered = false;
            privateChatActive = false;
            publicUnread = 0;
            privateUnreadCounts = {};
            presenceSynced = false;
            presenceReady = false;
            userAvatarCache = {};
            publicHasMore = true;
            privateHasMore = true;
            publicLoadingMore = false;
            privateLoadingMore = false;
            document.getElementById('authContainer').style.display = 'flex';
            document.getElementById('appContainer').style.display = 'none';
            document.getElementById('loginScreen').classList.remove('hidden');
            document.getElementById('registerScreen').classList.add('hidden');
            document.getElementById('loginUsername').value = '';
            document.getElementById('loginPassword').value = '';
            hideGlobalLoading();
            // v038: Reset banner dismissal so it can show again after logout
            try { sessionStorage.removeItem('mjchat_banner_dismissed'); } catch (e) {}
            window._bannerManuallyDismissed = false;
            showLogin();
        }

        async function deleteAccount() {
            if (!currentUser) return;
            const password = prompt('请输入您的密码以确认注销账号：');
            if (!password) return;
            const passwordHash = await hashPassword(password);
            // Classify RPC errors into user-friendly messages.
            const classifyDeleteError = (rawMsg) => {
                const msg = (rawMsg || '') + '';
                // RPC does not exist (e.g. "Could not find the function ... in the schema cache")
                if (msg.includes('Could not find') || msg.includes('schema cache') || msg.includes('delete_my_account')) {
                    return '注销功能暂不可用，请联系管理员';
                }
                // Password / identity verification failure
                if (msg.toLowerCase().includes('password') || msg.includes('身份') || msg.includes('验证')) {
                    return '密码错误，请重试';
                }
                // Fallback: show the actual error message
                return '注销失败: ' + msg;
            };
            try {
                const { data, error } = await sb.rpc('delete_my_account', {
                    p_username: currentUser,
                    p_password_hash: passwordHash
                });
                if (error) {
                    showSnackbar(classifyDeleteError(error.message));
                    return;
                }
                if (data && data.success === false) {
                    showSnackbar(data.message || '密码错误，请重试');
                    return;
                }
                if (publicChannel) {
                    publicChannel.send({ type: 'broadcast', event: 'user_deleted', payload: { username: currentUser,
                            forceLogout: true, initiator: currentUser } });
                }
                localStorage.removeItem('mjchat_session');
                showSnackbar('账号已彻底注销');
                setTimeout(() => {
                    location.reload();
                }, 500);
            } catch (e) {
                showSnackbar(classifyDeleteError(e && e.message));
            }
        }

        const PAGE_STACK_KEY = 'mjchat_page_stack';
        let pageHistory = ['home']; // default page
        let isNavigating = false;

        function pushPageHistory(page) {
            pageHistory.push(page);
            try {
                history.pushState({ page: page, mjchat_nav: true }, '', '#' + page);
            } catch (e) { /* ignore */ }
        }

        function popPageHistory() {
            if (pageHistory.length > 1) {
                pageHistory.pop();
                return pageHistory[pageHistory.length - 1];
            }
            return 'home';
        }

        function switchPage(targetId, forward) {
            if (isNavigating) return;
            isNavigating = true;
            const pages = document.querySelectorAll('.page');
            const targetPage = document.getElementById(targetId);
            if (!targetPage) { isNavigating = false; return; }

            let currentPage = null;
            pages.forEach(p => {
                if (p.classList.contains('active') && p.id !== targetId) {
                    currentPage = p;
                }
            });

            if (currentPage) {
                if (forward) {
                    targetPage.classList.add('active', 'slide-in');
                    setTimeout(() => {
                        targetPage.classList.remove('slide-in');
                        currentPage.classList.remove('active');
                        isNavigating = false;
                    }, 510);
                } else {
                    targetPage.classList.add('active');
                    currentPage.classList.add('slide-out');
                    setTimeout(() => {
                        currentPage.classList.remove('active', 'slide-out');
                        isNavigating = false;
                    }, 460);
                }
            } else {
                pages.forEach(p => p.classList.remove('active'));
                targetPage.classList.add('active');
                isNavigating = false;
            }
        }

        function navigateTo(page) {
            if (page === 'home') {
                pushPageHistory('home');
                switchPage('homePage', true);
                loadPrivateSessions();
                updatePublicEntry();
                updatePublicBadge();
            } else if (page === 'public') {
                pushPageHistory('public');
                switchPage('publicPage', true);
                if (publicMessages.length > 0) {
                    const lastMsg = publicMessages[publicMessages.length - 1];
                    markPublicRead(lastMsg.created_at);
                } else {
                    markPublicRead();
                }
                publicUnread = 0;
                updatePublicBadge();
                updateBackBadge();
                document.getElementById('publicMessages').innerHTML = '';
                publicLastDateLabel = '';
                publicMessages.forEach(m => renderPublicMessage(m));
                const container = document.getElementById('publicMessages');
                setTimeout(() => {
                    scrollToBottom(container);
                    updateScrollButton(container);
                }, 50);
            } else if (page === 'search') {
                pushPageHistory('search');
                switchPage('searchPage', true);
                document.getElementById('searchInput').value = '';
                document.getElementById('searchResults').innerHTML = '<div class="empty">输入用户名开始搜索</div>';
            } else if (page === 'settings') {
                pushPageHistory('settings');
                switchPage('settingsPage', true);
                updateThemeLabel();
            } else if (page === 'about') {
                pushPageHistory('about');
                switchPage('aboutPage', true);
                const v = document.getElementById('aboutVersion');
                if (v) v.textContent = 'v' + APP_VERSION;
                const mjchatVersion = document.getElementById('aboutMjchatVersion');
                if (mjchatVersion) mjchatVersion.textContent = 'MJChat内核版本  ' + MJCHAT_VERSION;
            }
            updateBackBadge();
        }

        let isHandlingPopstate = false;
        function navigateBack() {
            if (privateChatActive) {
                leavePrivateChatAnimated();
                return;
            }
            const currentPage = pageHistory[pageHistory.length - 1];
            if (currentPage !== 'home' && pageHistory.length > 1) {
                popPageHistory();
                const prevPage = pageHistory[pageHistory.length - 1];
                const targetId = prevPage === 'public' ? 'publicPage' :
                                 prevPage === 'search' ? 'searchPage' :
                                 prevPage === 'settings' ? 'settingsPage' :
                                 prevPage === 'about' ? 'aboutPage' : 'homePage';
                switchPage(targetId, false);
                updateBackBadge();
            } else {
                try { history.pushState({ page: 'home', mjchat_nav: true }, '', '#home'); } catch (e) {}
            }
        }

        function leavePrivateChatAnimated() {
            privateChatActive = false;
            if (privateStatusInterval) { clearInterval(privateStatusInterval); privateStatusInterval = null; }
            if (privateChannel) {
                sb.removeChannel(privateChannel);
                privateChannel = null;
            }
            privateSessionId = null;
            privateOtherUser = '';
            privateMessages = [];
            document.getElementById('privateMessages').innerHTML = '<div class="system-msg"><span>加载中...</span></div>';
            const statusEl = document.getElementById('privateChatStatus');
            if (statusEl) { statusEl.textContent = ''; statusEl.className = 'private-status'; }
            switchPage('homePage', false);
            if (pageHistory.length > 1) {
                popPageHistory();
            }
            loadPrivateSessions();
            updateBackBadge();
            updatePublicBadge();
        }

        // Resolve a user's status for display. Returns one of:
        // 'online' | 'banned' | 'deleted' | 'offline'.
        // Uses the SECURITY DEFINER `get_user_profile` RPC first (bypasses RLS) so
        // that RLS-restricted queries are not misread as "account deleted". Only
        // concludes 'deleted' when we are certain the user no longer exists.
        async function resolveUserStatus(username) {
            if (!username) return 'offline';
            var onlineNames = (function(){ var r=[]; var v=Object.values(onlineUsers); for(var i=0;i<v.length;i++){var a=v[i]; if(Array.isArray(a)){for(var j=0;j<a.length;j++){if(a[j]&&a[j].name)r.push(a[j].name);}}} return r; })();
            if (onlineNames.includes(username)) return 'online';
            try {
                const { data: rpcData, error: rpcError } = await sb.rpc('get_user_profile', { p_username: username });
                if (!rpcError && rpcData) {
                    if (rpcData.success === false) return 'deleted';
                    return rpcData.banned ? 'banned' : 'offline';
                }
            } catch (e) { /* RPC unavailable -> fall back to direct query */ }
            try {
                const { data, error } = await sb.from(TABLE_USERS).select('banned').eq('username', username).maybeSingle();
                if (!error && data) return data.banned ? 'banned' : 'offline';
                if (!error && !data) return 'deleted';
            } catch (e) { /* ignore */ }
            return 'offline';
        }

        // 向服务端核实账号真实状态（banned/deleted/active），用于抵御伪造的广播事件
        async function verifyServerAccountState(username) {
            if (!username) return 'unknown';
            try {
                const { data: rpcData, error: rpcError } = await sb.rpc('get_user_profile', { p_username: username });
                if (!rpcError && rpcData) {
                    if (rpcData.success === false) return 'deleted';
                    return rpcData.banned ? 'banned' : 'active';
                }
            } catch (e) { /* RPC unavailable -> fall back to direct query */ }
            try {
                const { data, error } = await sb.from(TABLE_USERS).select('banned').eq('username', username).maybeSingle();
                if (!error) return data ? (data.banned ? 'banned' : 'active') : 'deleted';
            } catch (e) { /* ignore */ }
            return 'unknown';
        }

        // Apply a status to an avatar's status dot, and grey-out the avatar when
        // the user is banned or deleted.
        function setAvatarStatusDot(dotEl, avatarEl, status) {
            if (!dotEl) return;
            dotEl.className = 'avatar-status-dot' + (status ? ' ' + status : '');
            if (avatarEl) {
                if (status === 'banned' || status === 'deleted') {
                    avatarEl.style.filter = 'grayscale(1)';
                } else {
                    avatarEl.style.filter = '';
                }
            }
        }

        // The current (logged-in) user is always online. Determine whether they
        // are banned and reflect that on the given dot/avatar. Resolves to the
        // final status ('online' or 'banned').
        async function applyCurrentUserStatus(dotEl, avatarEl) {
            setAvatarStatusDot(dotEl, avatarEl, 'online');
            try {
                const { data: rpcData } = await sb.rpc('get_user_profile', { p_username: currentUser });
                if (rpcData && rpcData.success !== false && rpcData.banned) {
                    setAvatarStatusDot(dotEl, avatarEl, 'banned');
                    return;
                }
            } catch (e) { /* RPC not found */ }
            try {
                const { data } = await sb.from(TABLE_USERS).select('banned').eq('username', currentUser).maybeSingle();
                if (data && data.banned) setAvatarStatusDot(dotEl, avatarEl, 'banned');
            } catch (e) { /* ignore */ }
        }

        function toggleHomeMenu() {
            const overlay = document.getElementById('homeMenuOverlay');
            if (overlay.classList.contains('show')) {
                closeHomeMenu();
            } else {
                overlay.classList.add('show');
                updateHomeMenu();
            }
        }

        function closeHomeMenu(e) {
            if (e && e.target !== e.currentTarget) return;
            document.getElementById('homeMenuOverlay').classList.remove('show');
        }

        // 点击菜单以外的区域时自动关闭主页菜单
        document.addEventListener('click', (e) => {
            const overlay = document.getElementById('homeMenuOverlay');
            if (overlay.classList.contains('show') &&
                !e.target.closest('#homeMenuOverlay') &&
                !e.target.closest('#homeMenuBtn')) {
                closeHomeMenu();
            }
        });

        function updateHomeMenu() {
            const avatar = document.getElementById('homeMenuAvatar');
            const name = document.getElementById('homeMenuName');
            const dot = document.getElementById('homeAvatarDot');
            const idx = hashStr(currentUser) % 8;
            avatar.className = 'user-avatar av-' + idx;
            if (currentAvatarUrl) {
                avatar.style.backgroundImage = `url(${currentAvatarUrl})`;
                avatar.textContent = '';
            } else {
                avatar.style.backgroundImage = '';
                avatar.textContent = currentUser.charAt(0).toUpperCase();
            }
            name.textContent = currentUser;
            // Current user is always online (they are logged in); green dot unless banned.
            applyCurrentUserStatus(dot, avatar);
            const adminItem = document.getElementById('homeAdminItem');
            if (isAdmin) {
                adminItem.style.display = 'flex';
            } else {
                adminItem.style.display = 'none';
            }
        }

        function togglePublicMenu() {
            const overlay = document.getElementById('publicMenuOverlay');
            if (overlay.classList.contains('show')) {
                closePublicMenu();
            } else {
                overlay.classList.add('show');
                updatePublicMenu();
            }
        }

        function closePublicMenu(e) {
            if (e && e.target !== e.currentTarget) return;
            document.getElementById('publicMenuOverlay').classList.remove('show');
        }

        function updatePublicMenu() {
            const avatar = document.getElementById('publicMenuAvatar');
            const name = document.getElementById('publicMenuName');
            const dot = document.getElementById('publicAvatarDot');
            const idx = hashStr(currentUser) % 8;
            avatar.className = 'user-avatar av-' + idx;
            if (currentAvatarUrl) {
                avatar.style.backgroundImage = `url(${currentAvatarUrl})`;
                avatar.textContent = '';
            } else {
                avatar.style.backgroundImage = '';
                avatar.textContent = currentUser.charAt(0).toUpperCase();
            }
            name.textContent = currentUser;
            // Current user is always online (they are logged in); green dot unless banned.
            applyCurrentUserStatus(dot, avatar);
            const adminItem = document.getElementById('publicAdminItem');
            if (isAdmin) {
                adminItem.style.display = 'flex';
            } else {
                adminItem.style.display = 'none';
            }
        }

        let privateBlockedStatus = false;

        function togglePrivateMenu() {
            const overlay = document.getElementById('privateMenuOverlay');
            if (overlay.classList.contains('show')) {
                closePrivateMenu();
            } else {
                overlay.classList.add('show');
                updatePrivateMenu();
            }
        }

        function closePrivateMenu(e) {
            if (e && e.target !== e.currentTarget) return;
            document.getElementById('privateMenuOverlay').classList.remove('show');
        }

        async function updatePrivateMenu() {
            const avatar = document.getElementById('privateMenuAvatar');
            const name = document.getElementById('privateMenuName');
            const dot = document.getElementById('privateAvatarDot');
            const idx = hashStr(privateOtherUser) % 8;
            avatar.className = 'user-avatar av-' + idx;
            if (userAvatarCache[privateOtherUser]) {
                avatar.style.backgroundImage = `url(${userAvatarCache[privateOtherUser]})`;
                avatar.textContent = '';
            } else {
                avatar.style.backgroundImage = '';
                avatar.textContent = privateOtherUser.charAt(0).toUpperCase();
            }
            name.textContent = privateOtherUser;
            const labelEl = document.getElementById('privateBlockLabel');
            // Reflect the other user's status on the avatar dot (green=online,
            // grey=banned/deleted, none=offline). Reuses the same logic as the
            // private chat status text.
            resolveUserStatus(privateOtherUser).then(status => setAvatarStatusDot(dot, avatar, status));
            try {
                const { data: rpcData, error: rpcError } = await sb.rpc('check_blocked', {
                    p_blocker: currentUser,
                    p_target: privateOtherUser
                });
                if (!rpcError) {
                    privateBlockedStatus = rpcData === true;
                } else { privateBlockedStatus = false; }
            } catch (e) { privateBlockedStatus = false; }
            labelEl.textContent = privateBlockedStatus ? '移出黑名单' : '加入黑名单';
        }

        async function toggleBlockUser() {
            if (!privateOtherUser) return;
            const newBlockState = !privateBlockedStatus;
            try {
                const { data: rpcData, error: rpcError } = await sb.rpc('toggle_block_user', {
                    p_blocker: currentUser,
                    p_blocked: privateOtherUser,
                    p_block: newBlockState
                });
                if (rpcError) { showSnackbar('操作失败: ' + rpcError.message); return; }
                if (rpcData && rpcData.success === false) {
                    showSnackbar(rpcData.message || '操作失败'); return;
                }
                privateBlockedStatus = newBlockState;
                showSnackbar(newBlockState ? '已加入黑名单' : '已移出黑名单');
            } catch (e) { showSnackbar('操作失败'); }
        }

        function showBlocklistModal() {
            document.getElementById('blocklistModal').classList.remove('hidden');
            loadBlocklist();
        }

        function closeBlocklistModal() {
            document.getElementById('blocklistModal').classList.add('hidden');
        }

        async function loadBlocklist() {
            const container = document.getElementById('blocklistContainer');
            container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-dim);">加载中...</p>';
            try {
                const { data: rpcData, error: rpcError } = await sb.rpc('get_blocked_users', {
                    p_username: currentUser
                });
                if (rpcError) { container.innerHTML = '<p>加载失败</p>'; return; }
                const blocked = rpcData || [];
                if (blocked.length === 0) {
                    container.innerHTML = '<p style="text-align:center;color:var(--md-on-surface-dim);">黑名单为空</p>';
                    return;
                }
                container.innerHTML = blocked.map(u =>
                    `<div class="block-item">
                        <span class="name">${escapeHtml(u.blocked)}</span>
                        <button class="unblock-btn" onclick="unblockUser('${escapeAttr(u.blocked)}')">移除</button>
                    </div>`
                ).join('');
            } catch (e) { container.innerHTML = '<p>加载失败</p>'; }
        }

        async function unblockUser(username) {
            try {
                const { data: rpcData, error: rpcError } = await sb.rpc('toggle_block_user', {
                    p_blocker: currentUser,
                    p_blocked: username,
                    p_block: false
                });
                if (rpcError) { showSnackbar('操作失败: ' + rpcError.message); return; }
                showSnackbar(`已移出 ${username}`);
                loadBlocklist();
            } catch (e) { showSnackbar('操作失败'); }
        }

        function showProfileDialog() {
            const avatar = document.getElementById('profileDialogAvatar');
            const name = document.getElementById('profileDialogUsername');
            const role = document.getElementById('profileDialogRole');
            const status = document.getElementById('profileDialogStatus');
            const onlineStatus = document.getElementById('profileDialogOnline');
            const onlineItem = document.getElementById('profileDialogOnlineItem');
            const idx = hashStr(currentUser) % 8;
            avatar.className = 'profile-avatar av-' + idx;
            if (currentAvatarUrl) {
                avatar.style.backgroundImage = `url(${currentAvatarUrl})`;
                avatar.textContent = '';
            } else {
                avatar.style.backgroundImage = '';
                avatar.textContent = currentUser.charAt(0).toUpperCase();
            }
            name.textContent = currentUser;
            role.textContent = isAdmin ? '管理员' : '普通用户';
            (async () => {
                try {
                    const { data: rpcData } = await sb.rpc('get_user_profile', { p_username: currentUser });
                    if (rpcData && rpcData.success !== false) {
                        status.textContent = rpcData.banned ? '已封禁' : '正常';
                        return;
                    }
                } catch (e) { /* RPC not found */ }
                try {
                    const { data } = await sb.from(TABLE_USERS).select('banned').eq('username', currentUser).maybeSingle();
                    status.textContent = (data && data.banned) ? '已封禁' : '正常';
                } catch (e) { status.textContent = '正常'; }
            })();
            var onlineUsernames = (function(){ var r=[]; var v=Object.values(onlineUsers); for(var i=0;i<v.length;i++){var a=v[i]; if(Array.isArray(a)){for(var j=0;j<a.length;j++){if(a[j]&&a[j].name)r.push(a[j].name);}}} return r; })();
            const isOnline = onlineUsernames.includes(currentUser);
            onlineStatus.textContent = isOnline ? '在线' : '离线';
            onlineItem.style.display = 'flex';
            document.getElementById('profileDialog').classList.remove('hidden');
        }

        function closeProfileDialog() {
            document.getElementById('profileDialog').classList.add('hidden');
        }

        function loadTheme() {
            const theme = localStorage.getItem('mjchat_theme') || 'dark';
            document.documentElement.setAttribute('data-theme', theme);
            updateThemeLabel();
        }

        function toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme') || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('mjchat_theme', next);
            updateThemeLabel();
        }

        function updateThemeLabel() {
            const homeLabel = document.getElementById('themeToggleLabel');
            const settingsLabel = document.getElementById('settingsThemeLabel');
            const current = document.documentElement.getAttribute('data-theme') || 'dark';
            const text = current === 'dark' ? '明亮模式' : '暗黑模式';
            if (homeLabel) homeLabel.textContent = text;
            if (settingsLabel) settingsLabel.textContent = text;
        }

        function loadCustomColor() {
            const color = localStorage.getItem('mjchat_theme_color');
            if (color) {
                applyThemeColor(color);
            }
            const picker = document.getElementById('themeColorPicker');
            if (picker) {
                picker.value = color || '#4A9EFF';
            }
        }

        function setCustomColor(color) {
            localStorage.setItem('mjchat_theme_color', color);
            applyThemeColor(color);
        }

        function applyThemeColor(color) {
            const root = document.documentElement;
            root.style.setProperty('--md-primary', color);
            root.style.setProperty('--md-primary-variant', darkenColor(color, 0.3));
        }

        function darkenColor(hex, factor) {
            const r = parseInt(hex.slice(1, 3), 16);
            const g = parseInt(hex.slice(3, 5), 16);
            const b = parseInt(hex.slice(5, 7), 16);
            const dr = Math.round(r * (1 - factor));
            const dg = Math.round(g * (1 - factor));
            const db = Math.round(b * (1 - factor));
            return '#' + [dr, dg, db].map(c => c.toString(16).padStart(2, '0')).join('');
        }

        function init() {
            // v040: Safety timeout - if loading is still visible after 15s, force-show login
            var _safetyTimeout = setTimeout(function() {
                var loadingEl = document.getElementById('globalLoading');
                if (loadingEl && !loadingEl.classList.contains('hidden')) {
                    console.warn('Safety timeout: forcing login page');
                    hideGlobalLoading();
                    if (!isEntered) showLogin();
                }
            }, 15000);

            loadTheme();
            loadCustomColor();

            // v040: Initialize Supabase client with error handling
            try {
                if (typeof window.supabase !== 'undefined' && window.supabase && window.supabase.createClient) {
                    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
                } else {
                    console.error('Supabase library not loaded');
                }
            } catch (e) {
                console.error('Supabase init error:', e);
            }
            clientId = generateId();

            try {
                history.pushState({ page: 'home', mjchat_nav: true, initial: true }, '', '#home');
            } catch (e) {}

            window.addEventListener('popstate', function(e) {
                if (e.state && e.state.mjchat_nav) {
                    navigateBack();
                } else {
                    try { history.pushState({ page: 'home', mjchat_nav: true, initial: true }, '', '#home'); } catch (e2) {}
                    navigateBack();
                }
            });

            document.getElementById('privacyBanner').addEventListener('click', function() {
                if (privateOtherUser) {
                    dismissedPrivacyBanners.add(privateOtherUser);
                    localStorage.setItem('dismissedPrivacyBanners', JSON.stringify([...dismissedPrivacyBanners]));
                    document.getElementById('privacyBanner').classList.add('hidden-banner');
                }
            });

            // v040: Fixed init flow - loading is hidden by default in HTML
            // Only show it for returning users who need session verification
            var savedSession = null;
            try {
                savedSession = localStorage.getItem('mjchat_session');
            } catch (e) { /* ignore */ }

            if (savedSession) {
                // Has a saved session - show loading and verify
                showGlobalLoading('登录中…', '正在验证身份');
                // Add a timeout fallback - if verification takes too long, show login
                var _sessionTimeout = setTimeout(function() {
                    var loadingEl = document.getElementById('globalLoading');
                    if (loadingEl && loadingEl.classList.contains('hidden')) return;
                    console.warn('Session verification timeout, showing login');
                    try { localStorage.removeItem('mjchat_session'); } catch (e) {}
                    hideGlobalLoading();
                    showLogin();
                }, 10000);

                restoreSession(_sessionTimeout);
            } else {
                // No saved session - loading is already hidden, just show login
                hideGlobalLoading();
                showLogin();
            }
        }

        function restoreSession(timeoutId) {
            const saved = localStorage.getItem('mjchat_session');
            if (!saved) {
                if (timeoutId) clearTimeout(timeoutId);
                hideGlobalLoading();
                showLogin();
                return;
            }
            // v040: Check if Supabase client is available before verifying
            if (!sb) {
                if (timeoutId) clearTimeout(timeoutId);
                hideGlobalLoading();
                showLogin();
                showEl('loginError', '连接服务失败，请刷新页面重试');
                return;
            }
            try {
                const session = JSON.parse(saved);
                if (!session.username || !session.token) {
                    localStorage.removeItem('mjchat_session');
                    if (timeoutId) clearTimeout(timeoutId);
                    hideGlobalLoading();
                    showLogin();
                    return;
                }
                const verifyWithSecure = async () => {
                    const { data, error } = await sb.rpc('verify_session_secure', {
                        p_username: session.username, p_token: session.token
                    });
                    if (!error && data && data.success !== false) return data;
                    return null;
                };
                const verifyWithLegacy = async () => {
                    const { data, error } = await sb.rpc('verify_session', {
                        p_username: session.username, p_token: session.token
                    });
                    if (!error && data && data.success !== false) return data;
                    throw error || new Error('Session verify failed');
                };

                (async () => {
                    let userData = null;
                    try { userData = await verifyWithSecure(); } catch (e) { /* ignore */ }
                    if (!userData) {
                        try { userData = await verifyWithLegacy(); } catch (e) {
                            localStorage.removeItem('mjchat_session');
                            if (timeoutId) clearTimeout(timeoutId);
                            hideGlobalLoading();
                            showLogin();
                            return;
                        }
                    }
                    if (timeoutId) clearTimeout(timeoutId);
                    if (isEntered) return;
                    if (userData.banned) {
                        localStorage.removeItem('mjchat_session');
                        hideGlobalLoading();
                        showLogin();
                        showEl('loginError', '您已被封禁');
                        return;
                    }
                    currentUser = session.username;
                    isAdmin = (userData.role === 'admin');
                    currentAvatarUrl = userData.avatar_url || '';
                    userAvatarCache[currentUser] = currentAvatarUrl;
                    updateLoadingText('登录中…', '欢迎回来 ' + currentUser);
                    authorizeEnterApp();
                    enterApp();
                    if (userData.needs_relogin) {
                        setTimeout(() => {
                            showSnackbar('安全提示：请退出后重新登录以更新安全凭证');
                        }, 2000);
                    }
                })().catch(() => {
                    localStorage.removeItem('mjchat_session');
                    if (timeoutId) clearTimeout(timeoutId);
                    hideGlobalLoading();
                    showLogin();
                });
            } catch (e) {
                localStorage.removeItem('mjchat_session');
                if (timeoutId) clearTimeout(timeoutId);
                hideGlobalLoading();
                showLogin();
            }
        }

        document.querySelectorAll('.dialog-overlay').forEach(el => {
            el.addEventListener('click', function(e) {
                if (e.target === this && !this.dataset.lockOverlay) {
                    this.classList.add('hidden');
                }
            });
        });

        // v040: Global error handler - only act during initial loading phase
        // This prevents non-critical runtime errors from disrupting the app
        window.addEventListener('error', function(e) {
            console.error('Global error:', e.error || e.message);
            try {
                // Only hide loading and show login if we're still on the auth/loading screen
                var loadingEl = document.getElementById('globalLoading');
                if (loadingEl && !loadingEl.classList.contains('hidden') && !isEntered) {
                    hideGlobalLoading();
                    showLogin();
                }
            } catch (err) { /* ignore */ }
        });

        // v040: Unhandled promise rejection handler - only act during loading phase
        window.addEventListener('unhandledrejection', function(e) {
            console.error('Unhandled promise rejection:', e.reason);
            try {
                var loadingEl = document.getElementById('globalLoading');
                if (loadingEl && !loadingEl.classList.contains('hidden') && !isEntered) {
                    hideGlobalLoading();
                    showLogin();
                }
            } catch (err) { /* ignore */ }
        });

        window.addEventListener('DOMContentLoaded', init);
