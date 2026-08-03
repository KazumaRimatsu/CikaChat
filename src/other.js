/* CikaChat 其他：通用 UI 工具、导航、菜单、主题、应用初始化 */

        let confirmCallback = null;
        function escapeHtml(t) { if (t == null) return ''; const d = document.createElement('div');
            d.textContent = String(t); return d.innerHTML; }

        function escapeAttr(t) { if (t == null) return ''; return String(t).replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;'); }

        // 秒数 → mm:ss（语音消息时长多处共用）
        function formatDuration(seconds) {
            seconds = Math.max(0, Math.floor(Number(seconds) || 0));
            return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
        }

        // 生成语音气泡波形条（高度随机，渲染时调用）
        function buildVoiceWaves(count) {
            const n = count || 12;
            let bars = '';
            for (let i = 0; i < n; i++) {
                bars += `<div class="voice-wave" style="height:${Math.floor(Math.random() * 16 + 4)}px"></div>`;
            }
            return bars;
        }

        // 语音消息气泡 HTML（公聊/私聊共用；无 audio_url 时显示升级提示）
        function buildVoiceBubbleHtml(audioUrl, duration, noUrlText) {
            const durStr = formatDuration(duration);
            if (audioUrl) {
                return `<div class="voice-msg-wrap" data-audio="${escapeAttr(audioUrl)}" data-dur="${Number(duration) || 0}" onclick="toggleVoicePlay(this, event)"><button class="voice-play-btn">${ICON_PLAY}</button><div class="voice-waves">${buildVoiceWaves()}</div><span class="voice-dur">${durStr}</span></div>`;
            }
            return `<div class="voice-msg-wrap"><span class="voice-dur">${durStr}</span><span style="font-size:0.75rem;color:var(--md-on-surface-dim);margin-left:8px;">${escapeHtml(noUrlText || '请升级到最新版本播放')}</span></div>`;
        }

        // 提取所有在线用户的用户名（onlineUsers 兼容数组/对象两种取值形态）
        function getOnlineUsernames() {
            const names = [];
            const vals = Object.values(onlineUsers);
            for (let i = 0; i < vals.length; i++) {
                const v = vals[i];
                if (Array.isArray(v)) {
                    for (let j = 0; j < v.length; j++) {
                        if (v[j] && v[j].name) names.push(v[j].name);
                    }
                } else if (v && v.name) {
                    names.push(v.name);
                }
            }
            return names;
        }

        // 填充用户头像元素：有 URL 用背景图，否则显示首字母
        function fillUserAvatar(avatarEl, user, avatarUrl) {
            if (!avatarEl || !user) return;
            if (avatarUrl) {
                avatarEl.style.backgroundImage = `url(${avatarUrl})`;
                avatarEl.textContent = '';
            } else {
                avatarEl.style.backgroundImage = '';
                avatarEl.textContent = user.charAt(0).toUpperCase();
            }
        }

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
            pages.forEach(p => p.classList.remove('active'));
            targetPage.classList.add('active');
            isNavigating = false;
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
                refreshNotifySettingsUI();
            } else if (page === 'about') {
                pushPageHistory('about');
                switchPage('aboutPage', true);
                const v = document.getElementById('aboutVersion');
                if (v) v.textContent = 'v' + VERSION;
                const mjchatVersion = document.getElementById('aboutMjchatVersion');
                if (mjchatVersion) mjchatVersion.textContent = 'MJChat内核版本  ' + APP_VERSION;
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
            fillUserAvatar(avatar, currentUser, currentAvatarUrl);
            name.textContent = currentUser;
            // Current user is always online (they are logged in); green dot unless banned.
            applyCurrentUserStatus(dot, avatar);
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
            fillUserAvatar(avatar, currentUser, currentAvatarUrl);
            name.textContent = currentUser;
            // Current user is always online (they are logged in); green dot unless banned.
            applyCurrentUserStatus(dot, avatar);
            refreshNotifySettingsUI();
            // v053: 更新群聊免打扰标签
            var muteLabel = document.getElementById('publicMuteLabel');
            if (muteLabel) muteLabel.textContent = (typeof _mutePublic !== 'undefined' && _mutePublic) ? '取消群聊免打扰' : '群聊免打扰';
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
            fillUserAvatar(avatar, privateOtherUser, userAvatarCache[privateOtherUser]);
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
            refreshNotifySettingsUI();
            // v053: 更新私聊免打扰标签
            var muteLabel = document.getElementById('privateMuteLabel');
            if (muteLabel && privateSessionId) {
                muteLabel.textContent = (_mutePerPrivateSession[privateSessionId]) ? '取消消息免打扰' : '消息免打扰';
            }
        }

        function showBlocklistModal() {
            document.getElementById('blocklistModal').classList.remove('hidden');
            loadBlocklist();
        }

        function closeBlocklistModal() {
            document.getElementById('blocklistModal').classList.add('hidden');
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
            fillUserAvatar(avatar, currentUser, currentAvatarUrl);
            name.textContent = currentUser;
            role.textContent = '普通用户';
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
            const onlineUsernames = getOnlineUsernames();
            const isOnline = onlineUsernames.includes(currentUser);
            onlineStatus.textContent = isOnline ? '在线' : '离线';
            onlineItem.style.display = 'flex';
            document.getElementById('profileDialog').classList.remove('hidden');
        }

        function closeProfileDialog() {
            document.getElementById('profileDialog').classList.add('hidden');
        }

        function loadTheme() {
            // Read from encrypted settings cache, default to dark
            const theme = (_userSettingsCache && _userSettingsCache.theme) || 'dark';
            document.documentElement.setAttribute('data-theme', theme);
            updateThemeLabel();
        }

        function toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme') || 'dark';
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            // Update encrypted settings cache
            if (_userSettingsCache) {
                _userSettingsCache.theme = next;
                syncSettingsToEncryptedStore();
            }
            updateThemeLabel();
            // v042: 持久化主题到服务端 user_settings 表
            saveThemeToServer(next);
        }

        // v042: 保存主题到服务端
        async function saveThemeToServer(theme) {
            if (!sb || !currentUser) return;
            try {
                const userSettingsObj = {
                    theme: theme,
                    updated_at: new Date().toISOString()
                };
                await sb.from('user_settings').upsert({
                    username: currentUser,
                    settings: userSettingsObj,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'username' });
            } catch (e) { /* silent - localStorage handles persistence */ }
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
            // Read from encrypted settings cache
            const color = (_userSettingsCache && _userSettingsCache.themeColor) || null;
            if (color) {
                applyThemeColor(color);
            }
            const picker = document.getElementById('themeColorPicker');
            if (picker) {
                picker.value = color || '#4A9EFF';
            }
        }

        function setCustomColor(color) {
            // Update encrypted settings cache
            if (_userSettingsCache) {
                _userSettingsCache.themeColor = color;
                syncSettingsToEncryptedStore();
            }
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
            // v047: safety timeout 保存在外部以便在 enterApp 后清除
            // 未完成初始化并且 loading 页仍可见时，50s 后才强制跳转登录页
            window.__mjchatSafetyTimeout = setTimeout(function() {
                var loadingEl = document.getElementById('globalLoading');
                if (loadingEl && !loadingEl.classList.contains('hidden')) {
                    if (_loginBlockedByCC) {
                        console.warn('Safety timeout: login_blocked=true, keeping loading page');
                        return;
                    }
                    console.warn('Safety timeout: forcing login page');
                    hideGlobalLoading();
                    if (!isEntered) showLogin();
                }
            }, 50000);

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

            // v049: Initialize cloud control system
            initCloudControl();

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
                    // Update encrypted settings cache
                    if (_userSettingsCache) {
                        _userSettingsCache.dismissedPrivacyBanners = [...dismissedPrivacyBanners];
                        syncSettingsToEncryptedStore();
                    }
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
                    currentAvatarUrl = userData.avatar_url || '';
                    userAvatarCache[currentUser] = currentAvatarUrl;
                    if (session.pwhash) {
                        // v049: 用会话中保存的密码哈希重新加载加密设置
                        try {
                            await initUserSettings(session.pwhash, session.username);
                            // 重新应用主题和颜色（init 中已调用过但当时 _userSettingsCache 为空）
                            loadTheme();
                            loadCustomColor();
                        } catch (e) {
                            console.warn('Session restore: initUserSettings failed:', e);
                        }
                    } else {
                        // v057 修复：旧版本保存的会话没有密码哈希，无法解密本地设置。
                        // 直接进入会导致本地设置无法加载/保存（加密密钥为空），
                        // 改为要求重新输入一次密码（保留会话，走快速登录），登录后会重新写入带 pwhash 的会话。
                        if (timeoutId) clearTimeout(timeoutId);
                        hideGlobalLoading();
                        showLogin();
                        showEl('loginError', '请重新登录以恢复本地设置');
                        return;
                    }
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
