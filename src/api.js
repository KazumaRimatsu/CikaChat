/* CikaChat API 请求：Supabase RPC、实时通道、认证登录、云控、数据加载 */

        let sb = null;
        let currentUser = '';
        // v039: Global flag for login blocked by cloud control
        var _loginBlockedByCC = false;
        // v046: 云控 login_blocked 状态跟踪
        var _prevLoginBlocked = false;
        let clientId = '';
        let isEntered = false;
        let presenceSynced = false;
        let presenceReady = false;
        let globalPrivateChannel = null;
        let _publicPollTimer = null;
        let _publicBackupPollTimer = null;
        let _publicRetryCount = 0;
        var _rateLimits = {};
        // v053: 免打扰系统
        let _mutePublic = false;
        let _mutePerPrivateSession = {};
        // v053: 恢复静音状态
        try {
            var _savedMutePublic = localStorage.getItem('mjchat_public_muted');
            if (_savedMutePublic === '1') _mutePublic = true;
            var _savedPrivateMuted = localStorage.getItem('mjchat_private_muted');
            if (_savedPrivateMuted) _mutePerPrivateSession = JSON.parse(_savedPrivateMuted);
        } catch(e) {}

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

        // v048: RPC 调用包装器——统一错误处理、重试、备用链路
        // 用法: callRPC('func_name', {p_x: 1}, fallback_direct_query_fn)
        // 返回: { data, error }  与 sb.rpc 原生结构一致
        async function callRPC(rpcName, params, fallback) {
            if (!sb) {
                console.warn('[RPC] sb 未初始化, rpc=' + rpcName);
                if (typeof fallback === 'function') {
                    try { const fb = await fallback(); if (fb) return { data: fb, error: null }; } catch (fe) {}
                }
                return { data: null, error: { message: '网络未连接' } };
            }
            var lastErr = null;
            // v048: 最多重试 2 次（应对网络抖动）
            for (var attempt = 0; attempt <= 2; attempt++) {
                try {
                    var res = await sb.rpc(rpcName, params || {});
                    if (!res.error) return res;
                    lastErr = res.error;
                    // 如果是 "function does not exist" 之类 42883 错误，立即走 fallback 不再重试
                    var code = res.error.code || '';
                    var msg = (res.error.message || '').toLowerCase();
                    if (code === '42883' || msg.indexOf('does not exist') >= 0 || msg.indexOf('未找到') >= 0) {
                        console.warn('[RPC] ' + rpcName + ' 后端不存在, code=' + code + ', fallback 尝试中');
                        break;
                    }
                    if (attempt < 2) await new Promise(function(r){ setTimeout(r, 400 * (attempt + 1)); });
                } catch (e) {
                    lastErr = e || lastErr;
                    console.warn('[RPC] ' + rpcName + ' 调用异常 (attempt ' + attempt + '):', e);
                    if (attempt < 2) await new Promise(function(r){ setTimeout(r, 400 * (attempt + 1)); });
                }
            }
            // v048: 所有重试失败，尝试 fallback 表查询
            if (typeof fallback === 'function') {
                try {
                    var fbRes = await fallback();
                    if (fbRes) return { data: fbRes, error: null };
                } catch (fe) {
                    console.warn('[RPC] ' + rpcName + ' fallback 失败:', fe);
                }
            }
            // v048: 友好的错误提示
            var friendlyMsg = (lastErr && lastErr.message) || '未知错误';
            if (friendlyMsg.indexOf('does not exist') >= 0 || friendlyMsg.indexOf('42883') >= 0) {
                friendlyMsg = '后端函数 ' + rpcName + ' 未部署';
            } else if (friendlyMsg.indexOf('JWT') >= 0 || friendlyMsg.indexOf('permission') >= 0) {
                friendlyMsg = '权限不足或登录已过期';
            } else if (friendlyMsg.indexOf('network') >= 0 || friendlyMsg.indexOf('fetch') >= 0) {
                friendlyMsg = '网络连接失败，请检查网络';
            }
            return { data: null, error: { message: friendlyMsg, original: lastErr } };
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
                    p_msg_version: payload.msg_version || APP_VERSION
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
                    p_msg_version: APP_VERSION
                });
                if (error) return { success: false };
                return data || { success: false };
            } catch (e) { return { success: false }; }
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
            // v040: 快速登录——有上次登录记录时显示简化界面
            updateQuickLoginUI();
        }

        function showRegister() {
            document.getElementById('loginScreen').classList.add('hidden');
            document.getElementById('registerScreen').classList.remove('hidden');
            hideEl('loginError');
            // v040: 注册时隐藏快速登录界面
            var quickInfo = document.getElementById('quickLoginInfo');
            var normalForm = document.getElementById('loginNormalForm');
            if (quickInfo) quickInfo.classList.add('hidden');
            if (normalForm) normalForm.classList.remove('hidden');
        }

        // v040: 快速登录——直接登录（无需输入密码，从session读取）
        // 但需要用户输入密码，所以显示密码输入框然后自动提交
        async function quickLogin() {
            var savedSession = null;
            try {
                var raw = localStorage.getItem('mjchat_session');
                if (raw) savedSession = JSON.parse(raw);
            } catch (e) {}
            if (!savedSession || !savedSession.username) {
                switchToNormalLogin();
                return;
            }
            // 显示密码输入框
            var quickInfo = document.getElementById('quickLoginInfo');
            var quickPwdRow = document.getElementById('quickLoginPwdRow');
            var quickPwdInput = document.getElementById('quickLoginPassword');
            if (quickPwdRow) quickPwdRow.classList.remove('hidden');
            var submitBtn = document.getElementById('quickLoginSubmitBtn');
            if (submitBtn) submitBtn.classList.remove('hidden');
            if (quickPwdInput) {
                quickPwdInput.value = '';
                setTimeout(function() { quickPwdInput.focus(); }, 100);
            }
        }

        // v040: 快速登录提交密码
        async function doQuickLoginSubmit() {
            var savedSession = null;
            try {
                var raw = localStorage.getItem('mjchat_session');
                if (raw) savedSession = JSON.parse(raw);
            } catch (e) {}
            if (!savedSession || !savedSession.username) return;
            var pwdEl = document.getElementById('quickLoginPassword');
            var password = pwdEl ? pwdEl.value : '';
            if (!password) {
                showEl('loginError', '请输入密码');
                if (pwdEl) pwdEl.focus();
                return;
            }
            hideEl('loginError');
            showGlobalLoading('登录中', '欢迎回来，' + savedSession.username);
            // 设置 loginUsername 给 doLogin 使用
            var unameEl = document.getElementById('loginUsername');
            var pwdMainEl = document.getElementById('loginPassword');
            if (unameEl) unameEl.value = savedSession.username;
            if (pwdMainEl) pwdMainEl.value = password;
            await doLogin();
        }

        // v040: 快速登录——读取上次登录记录，简化登录界面
        function updateQuickLoginUI() {
            var quickInfo = document.getElementById('quickLoginInfo');
            var normalForm = document.getElementById('loginNormalForm');
            var quickUserEl = document.getElementById('quickLoginUser');
            var quickAvatarEl = document.getElementById('quickLoginAvatar');
            // 读取session中上次登录信息
            var savedSession = null;
            try {
                var raw = localStorage.getItem('mjchat_session');
                if (raw) savedSession = JSON.parse(raw);
            } catch (e) {}
            if (savedSession && savedSession.username) {
                if (quickInfo) quickInfo.classList.remove('hidden');
                if (normalForm) normalForm.classList.add('hidden');
                if (quickUserEl) quickUserEl.textContent = savedSession.username;
                if (quickAvatarEl) {
                    quickAvatarEl.textContent = savedSession.username.charAt(0).toUpperCase();
                    quickAvatarEl.removeAttribute('src');
                    quickAvatarEl.style.backgroundImage = '';
                    quickAvatarEl.className = 'quick-login-avatar av-' + (hashStr(savedSession.username) % 8);
                }
            } else {
                if (quickInfo) quickInfo.classList.add('hidden');
                if (normalForm) normalForm.classList.remove('hidden');
            }
        }

        // v040: 切换到普通登录（从快速登录模式切换）
        function switchToNormalLogin() {
            var quickInfo = document.getElementById('quickLoginInfo');
            var normalForm = document.getElementById('loginNormalForm');
            if (quickInfo) quickInfo.classList.add('hidden');
            if (normalForm) normalForm.classList.remove('hidden');
            // 隐藏快速登录密码区
            var pwdRow = document.getElementById('quickLoginPwdRow');
            var submitBtn = document.getElementById('quickLoginSubmitBtn');
            if (pwdRow) pwdRow.classList.add('hidden');
            if (submitBtn) submitBtn.classList.add('hidden');
            var unameEl = document.getElementById('loginUsername');
            if (unameEl) unameEl.focus();
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
                // v049: 云控 login_blocked 时直接拦截注册，不进入主页面
                try {
                    if (await shouldBlockSessionForLoginLocked()) {
                        _loginBlockedByCC = true;
                        _prevLoginBlocked = true;
                        hideGlobalLoading();
                        showLogin();
                        showAuthBannerDynamic(CC_BANNER_TITLE, CC_BANNER_MSG, false, true);
                        return;
                    }
                } catch (ccErr) { /* ignore */ }
                const sessionToken = regSessionToken || generateLocalNonce();
                localStorage.setItem('mjchat_session', JSON.stringify({ username: username, token: sessionToken, pwhash: passwordHash }));
                // Initialize encrypted user settings with password hash as key (new user, starts fresh)
                initUserSettings(passwordHash, username).catch(function(e) { console.warn('initUserSettings failed:', e); });
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
                        console.warn('[login] verify_login_secure_rate_limited returned error:', secureError.code, secureError.message);
                        loginError = secureError;
                    }
                } catch (e) {
                    // v040: Rate-limited RPC might not exist, fall through
                    loginError = e;
                    console.warn('[login] verify_login_secure_rate_limited failed:', e.message || e);
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
                    } catch (e) { loginError = e;
                        console.warn('[login] verify_login_secure failed:', e.message || e); }
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
                currentAvatarUrl = userData.avatar_url || '';
                userAvatarCache[currentUser] = currentAvatarUrl;
                const sessionToken = userData.session_token || await hashPassword(passwordHash);
                localStorage.setItem('mjchat_session', JSON.stringify({ username: username, token: sessionToken, pwhash: passwordHash }));
                // Initialize encrypted user settings with password hash as key
                initUserSettings(passwordHash, username).catch(function(e) { console.warn('initUserSettings failed:', e); });
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
                // v047/v049: 登录即将成功进入主页面，清除 init 阶段的 safety timeout
                if (window.__mjchatSafetyTimeout) {
                    clearTimeout(window.__mjchatSafetyTimeout);
                    window.__mjchatSafetyTimeout = null;
                }
                // v049: 再次检查云控——防范后端未拦截 login_blocked 的情况
                try {
                    if (await shouldBlockSessionForLoginLocked()) {
                        _loginBlockedByCC = true;
                        _prevLoginBlocked = true;
                        hideGlobalLoading();
                        showLogin();
                        showAuthBannerDynamic(CC_BANNER_TITLE, CC_BANNER_MSG, false, true);
                        return;
                    }
                } catch (ccErr) { /* ignore */ }
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
        function authorizeEnterApp() {
            _enterAppAuthorized = true;
            // v049: 授权即清掉 safety timeout，避免跳回登录
            if (window.__mjchatSafetyTimeout) {
                clearTimeout(window.__mjchatSafetyTimeout);
                window.__mjchatSafetyTimeout = null;
            }
        }
        async function enterApp() {
            if (isEntered) return;
            if (!_enterAppAuthorized) {
                console.error('enterApp 未授权调用');
                showLogin();
                return;
            }
            // v047/v049: 进入 enterApp，清除 safety timeout（不再需要 init 阶段的安全检测）
            if (window.__mjchatSafetyTimeout) {
                clearTimeout(window.__mjchatSafetyTimeout);
                window.__mjchatSafetyTimeout = null;
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
                // v044: 启动公聊轮询备份
                startPublicPollingBackup();
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

        // ============================================
        // Cloud Control System (v049)
        // ============================================
        var _authBannerDynamic = null;
        var _bannerClickCountDyn = 0;
        var _bannerClickTimerDyn = null;
        var _cloudControlInterval = null;
        // v041: Track previous force_logout_all state to detect state CHANGES
        var _prevForceLogoutAll = false;
        // v041: Track if we've already been force-logged-out by the current force_logout_all event
        var _forceLogoutAllProcessed = false;

        function showAuthBannerDynamic(title, message, allowClose, isLoginBlocked) {
            hideAuthBannerDynamic();
            var overlay = document.createElement('div');
            overlay.id = 'dynAuthBanner';
            overlay.style.cssText = 'position:fixed;inset:0;background:var(--md-scrim-mid);display:flex;align-items:center;justify-content:center;z-index:99999;animation:fade-in 0.2s ease;';
            var dialog = document.createElement('div');
            dialog.style.cssText = 'background:var(--md-surface, #1c1c1e);border-radius:16px;padding:24px;max-width:380px;width:86vw;position:relative;box-shadow:0 8px 32px rgba(0,0,0,0.4);';
            var titleEl = document.createElement('h2');
            titleEl.textContent = title || '公告';
            titleEl.style.cssText = 'margin:0 0 12px 0;font-size:1.1rem;color:var(--md-on-surface, #fff);cursor:default;user-select:none;';
            var textEl = document.createElement('p');
            textEl.textContent = message || '';
            textEl.style.cssText = 'margin:0 0 20px 0;font-size:0.875rem;line-height:1.5;color:var(--md-on-surface-muted, #aaa);white-space:pre-wrap;cursor:default;user-select:none;';
            dialog.appendChild(titleEl);
            dialog.appendChild(textEl);
            if (allowClose && !isLoginBlocked) {
                var actionsDiv = document.createElement('div');
                actionsDiv.style.cssText = 'display:flex;justify-content:flex-end;';
                var closeBtn = document.createElement('button');
                closeBtn.textContent = '我知道了';
                closeBtn.style.cssText = 'background:none;border:none;color:var(--md-primary, #4A9EFF);font-size:0.875rem;padding:8px 16px;cursor:pointer;font-weight:500;';
                closeBtn.addEventListener('click', function() {
                    hideAuthBannerDynamic();
                    sessionStorage.setItem('mjchat_banner_dismissed', '1');
                    window._bannerManuallyDismissed = true;
                });
                actionsDiv.appendChild(closeBtn);
                dialog.appendChild(actionsDiv);
            }
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            _authBannerDynamic = overlay;
        }

        function hideAuthBannerDynamic() {
            if (_authBannerDynamic && _authBannerDynamic.parentNode) {
                _authBannerDynamic.parentNode.removeChild(_authBannerDynamic);
                _authBannerDynamic = null;
            }
            var origModal = document.getElementById('authBannerModal');
            if (origModal) origModal.classList.add('hidden');
        }

        // v046: 检查 cloud_control.login_blocked
        async function shouldBlockSessionForLoginLocked() {
            if (!sb) return false;
            try {
                var result = await sb.rpc('get_cloud_control');
                if (result && result.data && result.data.success !== false) {
                    return result.data.login_blocked === true;
                }
                // Fallback: direct table query
                var qr = await sb.from('cloud_control').select('login_blocked').limit(1);
                if (qr && qr.data && qr.data.length > 0) {
                    return qr.data[0].login_blocked === true;
                }
            } catch (e) {
                console.warn('[SessionLock] check error:', e);
            }
            return false;
        }

        async function checkCloudControl() {
            if (!sb) {
                console.warn('[CC] Supabase client not available');
                return false;
            }
            try {
                var result = await Promise.race([
                    sb.rpc('get_cloud_control'),
                    new Promise(function(resolve) {
                        setTimeout(function() { resolve({ data: null, error: 'timeout' }); }, 10000);
                    })
                ]);
                var data = result.data;
                var error = result.error;
                if (error || !data || !data.success) {
                    console.warn('[CC] RPC failed, trying fallback:', { error: error, data: data });
                    // v042: Fallback to direct table query
                    try {
                        const { data: ccData, error: ccError } = await sb.from('cloud_control')
                            .select('*')
                            .limit(1);
                        if (!ccError && ccData && ccData.length > 0) {
                            var cc = ccData[0];
                            data = {
                                success: true,
                                banner_enabled: cc.banner_enabled || false,
                                banner_title: cc.banner_title || '',
                                banner_message: cc.banner_message || '',
                                banner_show_close: cc.banner_show_close !== false,
                                login_blocked: cc.login_blocked || false,
                                force_logout_all: cc.force_logout_all || false
                            };
                        } else {
                            return false;
                        }
                    } catch (e2) { return false; }
                }

                // v041: Only force logout when force_logout_all transitions from false->true
                var currentForceLogoutAll = (data.force_logout_all === true);
                var forceLogoutJustActivated = currentForceLogoutAll && !_prevForceLogoutAll;
                _prevForceLogoutAll = currentForceLogoutAll;

                // v046: Track login_blocked transitions
                var currentLoginBlocked = (data.login_blocked === true);
                _prevLoginBlocked = currentLoginBlocked;

                if (forceLogoutJustActivated && isEntered && !_forceLogoutAllProcessed) {
                    var except = data.force_logout_except || '';
                    if (currentUser && currentUser !== except) {
                        _forceLogoutAllProcessed = true;
                        localStorage.removeItem('mjchat_session');
                        alert('您已被强制下线，请重新登录');
                        window.location.reload();
                        return true;
                    }
                }

                // v041: Reset the processed flag when force_logout_all is turned off
                if (!currentForceLogoutAll) {
                    _forceLogoutAllProcessed = false;
                }

                // On auth page, handle banner and login_blocked
                if (!isEntered) {
                    var isBlocked = (data.login_blocked === true);
                    _loginBlockedByCC = isBlocked;
                    var showBanner = false;
                    var bannerTitle = data.banner_title || '公告';
                    var bannerMsg = data.banner_message || '';
                    var allowClose = data.banner_show_close !== false;

                    if (data.banner_enabled) {
                        var dismissed = sessionStorage.getItem('mjchat_banner_dismissed');
                        if (dismissed !== '1' || isBlocked) {
                            showBanner = true;
                        }
                    } else if (isBlocked) {
                        bannerTitle = CC_BANNER_TITLE;
                        bannerMsg = CC_BANNER_MSG;
                        allowClose = false;
                        showBanner = true;
                    }

                    if (showBanner) {
                        if (isBlocked) allowClose = false;
                        showAuthBannerDynamic(bannerTitle, bannerMsg, allowClose, isBlocked);
                        var origModal = document.getElementById('authBannerModal');
                        if (origModal) {
                            origModal.dataset.bannerEnabled = 'true';
                            if (isBlocked) origModal.dataset.lockOverlay = '1';
                        }
                    }
                }

                return true;
            } catch (e) {
                console.error('[CC] checkCloudControl error:', e);
                return false;
            }
        }

        function initCloudControl() {
            var _ccRetryCount = 0;
            var _ccMaxRetries = 8;
            function initialCheck() {
                checkCloudControl().then(function(success) {
                    if (!success && _ccRetryCount < _ccMaxRetries && !isEntered) {
                        _ccRetryCount++;
                        setTimeout(initialCheck, 2000);
                    }
                });
            }
            initialCheck();
            if (_cloudControlInterval) clearInterval(_cloudControlInterval);
            _cloudControlInterval = setInterval(checkCloudControl, 30000);
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
                            await loadPrivateMessages(privateSessionId, true);
                        }
                    }
                } catch (e) { /* ignore */ }
            }, 10000);
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
                            if (!p || !p.payload) return; // v041: Add null check
                            handlePublicDeleted(p.payload.id);
                            updatePublicEntry();
                        });
                        publicChannel.on('broadcast', { event: 'user_banned' }, (p) => {
                            if (!p || !p.payload) return; // v041: Add null check
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
                            if (!p || !p.payload) return; // v041: Add null check
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
                            if (!p || !p.payload) return; // v041: Add null check
                            if (p.payload.username === currentUser) {
                                showSnackbar('您已被管理员强制下线');
                                setTimeout(() => logout(), 1000);
                            }
                        });
                        publicChannel
                            .on('presence', { event: 'sync' }, () => {
                                onlineUsers = publicChannel.presenceState();
                                renderOnlineUsers();
                                loadUserAvatars(getOnlineUsernames()).then(function() { renderOnlineUsers(); });
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

        // v044: 公聊轻量轮询备份——Realtime 连接正常时也定期轮询，防止 postgres_changes 事件漏发
        var _lastPublicPollTime = null;
        function startPublicPollingBackup() {
            if (_publicBackupPollTimer) clearInterval(_publicBackupPollTimer);
            _publicBackupPollTimer = setInterval(async () => {
                if (!sb || !currentUser || !isEntered) return;
                try {
                    await _pollPublicMessages();
                } catch (e) { /* ignore */ }
            }, 10000);
        }

        async function _pollPublicMessages() {
            if (!sb || !isEntered) return;
            try {
                var latestTime = _lastPublicPollTime;
                if (publicMessages && publicMessages.length > 0) {
                    for (var i = publicMessages.length - 1; i >= 0; i--) {
                        if (publicMessages[i].created_at) {
                            latestTime = publicMessages[i].created_at;
                            break;
                        }
                    }
                }
                var query = sb.from(TABLE_PUBLIC_MSG)
                    .select('id, sender, text, image_url, audio_url, audio_dur, msg_version, created_at, reply_to_id, reply_content, sender_deleted, is_system')
                    .order('created_at', { ascending: false })
                    .limit(20);
                if (latestTime) query = query.gt('created_at', latestTime);
                var result = await query;
                if (result.error || !result.data || !Array.isArray(result.data)) return;
                if (result.data.length === 0) return;
                result.data.reverse().forEach(function(msg) {
                    if (!publicMessages.some(function(m) { return m.id === msg.id; })) {
                        handlePublicMessage(msg);
                        updatePublicEntry();
                        var container = document.getElementById('publicMessages');
                        if (!isUserScrolledUp && container) {
                            scrollToBottom(container);
                            updateScrollButton(container);
                        }
                    }
                });
                if (publicChannel && publicChannel.presenceState) {
                    try {
                        onlineUsers = publicChannel.presenceState();
                        renderOnlineUsers();
                    } catch (e) { /* ignore */ }
                }
            } catch (e) { /* silent fail */ }
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

        async function loadPrivateMessages(sessionId, notifyNew) {
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
                const prevIds = notifyNew ? new Set(privateMessages.map(m => m.id)) : null;
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
                // 网络不佳时实时广播可能丢失，轮询补拉发现的新消息需要正常播放提示音（免打扰时不播放）
                if (notifyNew && prevIds) {
                    const fresh = privateMessages.filter(m => !prevIds.has(m.id) && m.sender !== currentUser);
                    if (fresh.length > 0 && !_mutePerPrivateSession[privateSessionId] && getPrivateNotifyEnabled() &&
                        !document.getElementById('privatePage').classList.contains('active')) {
                        playNotifySound();
                    }
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
                        // v053: 私聊免打扰时不增加未读计数
                        if (!_mutePerPrivateSession[sessionId]) {
                            incrementUnread(sessionId);
                        }
                    }
                    // Play notification sound for private chat (when not in view or not own msg)
                    if (msg.sender !== currentUser && getPrivateNotifyEnabled()) {
                        // v053: 私聊按会话免打扰
                        if (!_mutePerPrivateSession[sessionId]) {
                            if (!document.getElementById('privatePage').classList.contains('active')) {
                                playNotifySound();
                            }
                        }
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
                if (!payload || !payload.payload) return; // v041: Add null check
                const msgId = payload.payload.id;
                privateMessages = privateMessages.filter(m => m.id !== msgId);
                const rows = document.querySelectorAll('#privateMessages .msg-row');
                rows.forEach(row => { if (row.dataset.msgId === msgId) row.remove(); });
            });


            privateChannel.subscribe((status) => {});
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
                if (!agents) agents = [];
                // v049: 只显示 enabled 的智能体
                agents = agents.filter(function(a){ return a.enabled !== false; });
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
                    const canDelete = (agent.created_by === currentUser);
                    const providerText = providerLabels[agent.provider] || agent.provider || '自定义';
                    const modelText = agent.model ? ' · ' + escapeHtml(agent.model) : '';
                    const isActive = activeAgent && activeAgent.id === agent.id;
                    const avatarIdx = hashStr(agent.name) % 8;
                    let avatarStyle = '';
                    if (userAvatarCache[agent.name]) {
                        avatarStyle = 'background-image:url(' + escapeAttr(sanitizeAvatarUrl(userAvatarCache[agent.name])) + ');';
                    }
                    var activeStyle = isActive ? 'border-color:var(--md-primary);background:var(--md-primary-container);' : '';
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

        async function saveAgent() {
            const name = document.getElementById('agentName').value.trim();
            const provider = document.getElementById('agentProvider').value;
            const apiKey = document.getElementById('agentApiKey').value.trim();
            const model = document.getElementById('agentModel').value.trim() || 'gpt-3.5-turbo';
            if (!name) { showSnackbar('请输入智能体名称'); return; }
            if (!apiKey) { showSnackbar('请输入 API Key'); return; }
            try {
                // v043: 对 API Key 做加盐哈希，防止明文在日志或网络抓包中泄露
                const apiKeyHash = await hashApiKey(apiKey);
                let saved = false;
                try {
                    const { data: rpcData, error: rpcError } = await sb.rpc('save_agent', {
                        p_name: name,
                        p_provider: provider,
                        p_api_key: apiKeyHash,
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
                        api_key: apiKeyHash,
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
                localStorage.setItem('mjchat_session', JSON.stringify({ username: currentUser, token: newSessionToken, pwhash: newPasswordHash }));
                // Re-initialize encrypted settings with new password hash
                initUserSettings(newPasswordHash, currentUser).catch(function(e) { console.warn('initUserSettings failed:', e); });
            }
            showSnackbar('密码更改成功');
            closeChangePasswordDialog();
        }

        /* Removed: cleanupGarbledMsgs */

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
            // v053: 登出时重置免打扰状态
            _mutePublic = false;
            _mutePerPrivateSession = {};
            localStorage.removeItem('mjchat_public_muted');
            localStorage.removeItem('mjchat_private_muted');
            currentUser = '';
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
            clearEncryptionKey();
            // v041: Reset force_logout tracking on logout
            _forceLogoutAllProcessed = false;
            showLogin();
        }

        async function deleteAccount() {
            if (!currentUser) return;
            // v043: 用自定义模态对话框替代原生 prompt，防止浏览器弹窗被脚本注入
            showDeleteAccountModal();
        }

        // v043: 账号注销专用模态对话框
        function showDeleteAccountModal() {
            var existing = document.getElementById('deleteAccountModalDyn');
            if (existing) existing.remove();

            var overlay = document.createElement('div');
            overlay.id = 'deleteAccountModalDyn';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:100000;animation:fade-in 0.2s ease;';

            var dialog = document.createElement('div');
            dialog.style.cssText = 'background:var(--md-surface-4dp, #1c1c1e);border-radius:8px;padding:24px;max-width:350px;width:86vw;box-shadow:var(--md-elevation-8, 0 8px 32px rgba(0,0,0,0.4));';

            var title = document.createElement('h2');
            title.textContent = '注销账号';
            title.style.cssText = 'margin:0 0 12px 0;font-size:1.1rem;color:var(--md-on-surface, #fff);';
            dialog.appendChild(title);

            var desc = document.createElement('p');
            desc.textContent = '请输入您的密码以确认注销账号：\n注销后，您的所有数据将被永久删除，此操作不可恢复。';
            desc.style.cssText = 'margin:0 0 16px 0;font-size:0.8rem;color:var(--md-on-surface-dim, #aaa);white-space:pre-line;line-height:1.5;';
            dialog.appendChild(desc);

            var inputContainer = document.createElement('div');
            inputContainer.style.cssText = 'width:100%;margin-bottom:16px;position:relative;';
            var input = document.createElement('input');
            input.type = 'password';
            input.id = 'deleteAccountPasswordInput';
            input.placeholder = ' ';
            input.style.cssText = 'width:100%;padding:12px 0;background:transparent;border:none;border-bottom:1px solid var(--md-outline, #555);color:var(--md-on-surface, #fff);font-size:1rem;outline:none;';
            input.addEventListener('keypress', function(e) {
                if (e.key === 'Enter') doDeleteAccountConfirm();
            });
            inputContainer.appendChild(input);
            var label = document.createElement('label');
            label.textContent = '账号密码';
            label.style.cssText = 'position:absolute;left:0;bottom:32px;font-size:0.75rem;color:var(--md-on-surface-dim, #888);pointer-events:none;';
            inputContainer.appendChild(label);
            dialog.appendChild(inputContainer);

            var errorEl = document.createElement('div');
            errorEl.id = 'deleteAccountError';
            errorEl.style.cssText = 'color:var(--md-error, #cf6679);font-size:0.75rem;margin-bottom:8px;display:none;';
            dialog.appendChild(errorEl);

            var actions = document.createElement('div');
            actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
            var cancelBtn = document.createElement('button');
            cancelBtn.textContent = '取消';
            cancelBtn.style.cssText = 'background:transparent;color:var(--md-on-surface, #fff);border:none;border-radius:8px;font-size:0.875rem;padding:10px 20px;cursor:pointer;font-weight:500;';
            cancelBtn.addEventListener('click', function() { overlay.remove(); });
            actions.appendChild(cancelBtn);
            var okBtn = document.createElement('button');
            okBtn.textContent = '确认注销';
            okBtn.id = 'deleteAccountConfirmBtn';
            okBtn.style.cssText = 'background:var(--md-error, #cf6679);color:#fff;border:none;border-radius:8px;font-size:0.875rem;padding:10px 20px;cursor:pointer;font-weight:500;';
            okBtn.addEventListener('click', function() { doDeleteAccountConfirm(); });
            actions.appendChild(okBtn);
            dialog.appendChild(actions);
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            setTimeout(function() { input.focus(); }, 100);
        }

        async function doDeleteAccountConfirm() {
            var input = document.getElementById('deleteAccountPasswordInput');
            var errorEl = document.getElementById('deleteAccountError');
            var okBtn = document.getElementById('deleteAccountConfirmBtn');
            if (!input) return;
            var password = input.value;
            errorEl.style.display = 'none';
            if (!password) {
                errorEl.textContent = '请输入密码';
                errorEl.style.display = 'block';
                return;
            }
            if (okBtn) {
                okBtn.textContent = '注销中...';
                okBtn.disabled = true;
                okBtn.style.opacity = '0.6';
            }
            var passwordHash = await hashPassword(password);
            var overlay = document.getElementById('deleteAccountModalDyn');
            const classifyDeleteError = (rawMsg) => {
                const msg = (rawMsg || '') + '';
                if (msg.includes('Could not find') || msg.includes('schema cache') || msg.includes('delete_my_account')) {
                    return '注销功能暂不可用，请联系管理员';
                }
                if (msg.toLowerCase().includes('password') || msg.includes('身份') || msg.includes('验证')) {
                    return '密码错误，请重试';
                }
                return '注销失败: ' + msg;
            };
            try {
                const { data, error } = await sb.rpc('delete_my_account', {
                    p_username: currentUser,
                    p_password_hash: passwordHash
                });
                if (error) {
                    if (overlay) overlay.remove();
                    showSnackbar(classifyDeleteError(error.message));
                    return;
                }
                if (data && data.success === false) {
                    if (overlay) overlay.remove();
                    showSnackbar(data.message || '密码错误，请重试');
                    return;
                }
                if (publicChannel) {
                    publicChannel.send({ type: 'broadcast', event: 'user_deleted', payload: { username: currentUser,
                            forceLogout: true, initiator: currentUser } });
                }
                if (overlay) overlay.remove();
                localStorage.removeItem('mjchat_session');
                clearEncryptionKey();
                showSnackbar('账号已彻底注销');
                setTimeout(function() {
                    location.reload();
                }, 500);
            } catch (e) {
                if (overlay) overlay.remove();
                showSnackbar(classifyDeleteError(e && e.message));
            }
        }

        async function resolveUserStatus(username) {
            if (!username) return 'offline';
            if (getOnlineUsernames().includes(username)) return 'online';
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

        // v053: 群聊免打扰切换
        function togglePublicMute() {
            _mutePublic = !_mutePublic;
            showSnackbar(_mutePublic ? '已开启群聊消息免打扰' : '已关闭群聊消息免打扰');
            try { localStorage.setItem('mjchat_public_muted', _mutePublic ? '1' : '0'); } catch(e) {}
            updatePublicMenu();
            updatePublicBadge();
            updateBackBadge();
        }

        // v053: 私聊按会话免打扰切换
        function togglePrivateMute() {
            if (!privateSessionId) return;
            const cur = !!_mutePerPrivateSession[privateSessionId];
            _mutePerPrivateSession[privateSessionId] = !cur;
            showSnackbar(!cur ? '已开启消息免打扰' : '已关闭消息免打扰');
            try { localStorage.setItem('mjchat_private_muted', JSON.stringify(_mutePerPrivateSession)); } catch(e) {}
            updatePrivateMenu();
            renderPrivateList();
            updateBackBadge();
        }

        // v046: 检测消息文本中是否@提到了当前用户
        function _checkMention(text) {
            if (!text || !currentUser) return false;
            var mentionPattern = '@' + currentUser;
            return text.indexOf(mentionPattern) !== -1;
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
