/* CikaChat 聊天核心功能：公共聊天/私聊的渲染、发送、交互、在线状态、未读提示 */

        let publicChannel = null;
        let privateChannel = null;
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
        let replyTarget = null;
        let privateReplyTarget = null;
        let contextTarget = null;
        let lastPokeTime = 0;
        let currentAvatarUrl = '';
        let isUserScrolledUp = false;
        let scrollTimeout = null;
        let privateUnreadCounts = {};
        let publicUnread = 0;
        let privatePollTimer = null;
        // v040: Public chat polling timers for retry logic
        let userAvatarCache = {};
        let publicHasMore = true;
        let publicLoadingMore = false;
        let privateHasMore = true;
        let privateLoadingMore = false;
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

        function applyAvatarToElement(el, username) {
            fillUserAvatar(el, username, userAvatarCache[username]);
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

        // 兜底通知：实时广播丢失/延迟时（网络不佳），通过广播或轮询补拉的新消息也要播放提示音
        function maybeNotifyPrivateSound(sessionId) {
            if (privateChatActive && privateSessionId === sessionId) return;
            if (!getPrivateNotifyEnabled()) return;
            // v053: 私聊按会话免打扰
            if (_mutePerPrivateSession[sessionId]) return;
            if (document.getElementById('privatePage').classList.contains('active')) return;
            playNotifySound();
        }

        function handlePrivateNotification(sessionId, sender) {
            const mySessions = (window.privateSessions || []);
            const isMySession = mySessions.some(s => s.id === sessionId);
            if (!isMySession && sender !== currentUser) {
                loadPrivateSessions().then(() => {
                    const updated = (window.privateSessions || []);
                    if (updated.some(s => s.id === sessionId) && sender !== currentUser) {
                        // 免打扰时不显示红点、不播放提示音
                        if (!_mutePerPrivateSession[sessionId]) incrementUnread(sessionId);
                        maybeNotifyPrivateSound(sessionId);
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
                    // 免打扰时不显示红点、不播放提示音
                    if (!_mutePerPrivateSession[sessionId]) incrementUnread(sessionId);
                    maybeNotifyPrivateSound(sessionId);
                }
            });
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

        function showLoadMoreIndicator(containerId, indicatorId, show) {
            let indicator = document.getElementById(indicatorId);
            if (show) {
                if (!indicator) {
                    indicator = document.createElement('div');
                    indicator.id = indicatorId;
                    indicator.className = 'load-more-indicator';
                    indicator.innerHTML = '<div class="loading-spinner"><svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="20"/></svg></div><span>正在加载更多消息...</span>';
                    const container = document.getElementById(containerId);
                    container.insertBefore(indicator, container.firstChild);
                }
                indicator.style.display = 'flex';
            } else {
                if (indicator) indicator.style.display = 'none';
            }
        }

        function showPublicLoadMore(show) {
            showLoadMoreIndicator('publicMessages', 'publicLoadMoreIndicator', show);
        }

        function handlePublicMessage(msg, isHistory = false) {
            if (publicMessages.some(m => m.id === msg.id)) return;
            if (msg.is_system && isGarbledText(msg.text)) return;
            if (msg.is_system && msg.text && (
                msg.text.includes('加入了CikaChat') || msg.text.includes('离开了CikaChat') ||
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
                // 消息免打扰：开启时不显示红点、不播放提示音；@提及绕过免打扰
                var isMentioned = _checkMention(nm.text || '');
                if (!_mutePublic || isMentioned) {
                    publicUnread++;
                    updatePublicBadge();
                    updateBackBadge();
                    // 提示音：免打扰开启时仅 @ 消息播放；免打扰关闭时按「消息提示音」开关
                    if (isMentioned && _mutePublic) {
                        playNotifySound();
                    } else if (!_mutePublic && getPublicNotifyEnabled()) {
                        playNotifySound();
                    }
                }
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
                        contentPreview = `[语音] ${formatDuration(repliedMsg.audio_dur || 0)}`;
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
                bubbleContent = buildVoiceBubbleHtml(msg.audio_url, msg.audio_dur || 0);
                msgType = 'voice';
            } else {
                const marked = parseMarkedText(msg.text);
                if (marked && marked.type === 'voice') {
                    bubbleContent = buildVoiceBubbleHtml(marked.url, marked.duration || 0, '请升级到最新版本播放');
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
                    } else if (isVideoFile(marked.fileInfo)) {
                        const fileParts = marked.fileInfo.match(/^(.*?)\s*\(([\d.]+)\s*KB\)$/);
                        const fileName = fileParts ? fileParts[1] : marked.fileInfo;
                        bubbleContent = `<div class="video-bubble" onclick="openVideoPreview('${escapeAttr(marked.url)}')"><video src="${escapeAttr(marked.url)}" preload="metadata" muted playsinline></video><div class="video-play-overlay"><svg viewBox="0 0 24 24" width="40" height="40" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div><div class="video-name">${escapeHtml(fileName)}</div></div>`;
                        msgType = 'video';
                        linkUrl = marked.url;
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
            const container = document.getElementById(type === 'private' ? 'privateMessages' : 'publicMessages');
            const targetRow = container.querySelector(`.msg-row[data-msg-id="${msgId}"]`);
            if (targetRow) {
                targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                targetRow.style.transition = 'background 1s';
                targetRow.style.background = 'var(--md-primary-highlight)';
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
                content = `[图片] (${last.image_url})`;
            } else if (last.audio_url) {
                content = `[语音] (${last.audio_url})`;
            } else {
                content = getMessagePreview(last.text);
            }
            sub.textContent = `${sender}：${content}`;
        }

        function addSystemMsg(container, text) {
            const d = document.createElement('div');
            d.className = 'system-msg';
            d.innerHTML = `<span>${escapeHtml(text)}</span>`;
            container.appendChild(d);
        }

        function addPublicSystemMsg(text) {
            if (isGarbledText(text)) return;
            addSystemMsg(document.getElementById('publicMessages'), text);
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
            const payload = { sender: currentUser, text: text || '', msg_version: APP_VERSION, is_system: false };
            if (replyTarget) {
                const replied = publicMessages.find(m => m.id === replyTarget.id);
                if (replied) {
                    let previewText = '';
                    if (replied.image_url) {
                        previewText = '[图片]';
                    } else if (replied.audio_url) {
                        previewText = `[语音] ${formatDuration(replied.audio_dur || 0)}`;
                    } else if (replied.text && replied.text.startsWith('🔗 ')) {
                        const match = replied.text.match(/🔗 (.*?) → /);
                        previewText = match ? `[链接] ${match[1]}` : '[链接]';
                    } else if (replied.text && replied.text.startsWith('📎 ')) {
                        const match = replied.text.match(/📎 (.*?) → /);
                        previewText = match ? `[文件] ${match[1]}` : '[文件]';
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

        function updatePublicConn(on) {
            // v048: 更新胶囊：在线→显示在线人数，离线→显示 loading 圆圈
            try {
                var capsules = [document.getElementById('homeCapsule'), document.getElementById('publicCapsule')];
                for (var i = 0; i < capsules.length; i++) {
                    var cap = capsules[i];
                    if (!cap) continue;
                    if (on) {
                        cap.classList.remove('loading');
                    } else {
                        cap.classList.add('loading');
                    }
                }
            } catch (e) { /* ignore */ }
            // 同步在线人数文本
            if (on) renderOnlineUsers();
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

        function initMessageInteractions(messagesEl, chatType) {
            const isPublic = chatType === 'public';

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
                        const sender = avatar.dataset.sender || avatar.dataset.username;
                        if (sender && sender !== currentUser) {
                            showAvatarContextMenu(e, sender, chatType);
                        }
                        return;
                    }
                    const bubble = target.closest('.bubble');
                    if (bubble) {
                        const row = bubble.closest('.msg-row');
                        if (row) {
                            showContextMenuForRow(row, e.clientX, e.clientY, chatType);
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
                        showContextMenuForRow(pressTargetRow, pressStartX, pressStartY, chatType);
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

            if (isPublic && publicChannel) {
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

        function initInteractions() {
            initMessageInteractions(document.getElementById('publicMessages'), 'public');
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

        function addContextMenuItem(menu, label, iconSvg, action) {
            const item = document.createElement('div');
            item.className = 'menu-item';
            item.innerHTML = iconSvg + ' ' + label;
            item.addEventListener('click', (ev) => {
                ev.stopPropagation();
                closeContextMenu();
                action();
            });
            menu.appendChild(item);
        }

        function positionContextMenu(menu, x, y, fallbackW, fallbackH) {
            menu.classList.add('show');
            let left = x, top = y;
            const menuW = menu.offsetWidth || (fallbackW || 120);
            const menuH = menu.offsetHeight || (fallbackH || 80);
            if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
            if (top + menuH > window.innerHeight - 8) top = window.innerHeight - menuH - 8;
            if (left < 8) left = 8;
            if (top < 8) top = 8;
            menu.style.left = left + 'px';
            menu.style.top = top + 'px';
        }

        function copyToClipboardWithToast(text) {
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

            addContextMenuItem(menu, `@${sender}`, atIcon, () => {
                if (chatType === 'private') {
                    insertAtMentionPrivate(sender);
                } else {
                    insertAtMention(sender);
                }
            });
            addContextMenuItem(menu, '拍一拍', pokeIcon, () => pokeUser(sender));

            positionContextMenu(menu, e.clientX, e.clientY, 120, 80);
        }

        function initPrivateInteractions() {
            initMessageInteractions(document.getElementById('privateMessages'), 'private');
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
            const canDelete = isOwn;

            const icons = {
                save: '<svg viewBox="0 0 24 24"><path d="M19 12v7H5v-7H3v7c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-7h-2zm-6 .67l2.59-2.58L17 11.5l-5 5-5-5 1.41-1.41L11 12.67V3h2v9.67z"/></svg>',
                open: '<svg viewBox="0 0 24 24"><path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/></svg>',
                copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>',
                delete: '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
                reply: '<svg viewBox="0 0 24 24"><path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z"/></svg>',
                translate: '<svg viewBox="0 0 24 24"><path d="M12.87 15.07l-2.54-2.51.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>'
            };

            const addDeleteItem = () => {
                addContextMenuItem(menu, '删除', icons.delete, () => {
                    showConfirm('确认删除', '确定要删除此消息吗？将会对所有人删除此消息。', () => {
                        contextDeleteMsg();
                    });
                });
            };

            const replyContentText = (msgType === 'voice' || msgType === 'link' || msgType === 'file') ? getMessagePreview(text) : (text || '消息');
            addContextMenuItem(menu, '回复', icons.reply, () => {
                if (type === 'public') {
                    setPublicReplyTarget(msgId, sender, replyContentText);
                } else {
                    setPrivateReplyTarget(msgId, sender, replyContentText);
                }
            });

            const iconsExt = {
                play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
                download: '<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>'
            };

            if (msgType === 'image') {
                addContextMenuItem(menu, '保存图片', icons.save, () => {
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
                if (canDelete) addDeleteItem();
            } else if (msgType === 'video') {
                if (linkUrl) {
                    addContextMenuItem(menu, '预览视频', iconsExt.play, () => openVideoPreview(linkUrl));
                    addContextMenuItem(menu, '下载视频', iconsExt.download, () => {
                        fetch(linkUrl).then(res => res.blob()).then(blob => {
                            const a = document.createElement('a');
                            a.href = URL.createObjectURL(blob);
                            a.download = linkUrl.split('/').pop() || 'video.mp4';
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(a.href);
                        }).catch(() => showSnackbar('下载失败'));
                    });
                    addContextMenuItem(menu, '在新标签页打开', icons.open, () => window.open(linkUrl, '_blank'));
                }
                if (canDelete) addDeleteItem();
            } else if (msgType === 'link' || msgType === 'file') {
                if (linkUrl) {
                    addContextMenuItem(menu, '打开链接', icons.open, () => window.open(linkUrl, '_blank'));
                }
                const copyText = text || linkUrl;
                if (copyText) {
                    addContextMenuItem(menu, '复制文字', icons.copy, () => copyToClipboardWithToast(copyText));
                }
                if (canDelete) addDeleteItem();
            } else if (msgType === 'voice') {
                if (canDelete) addDeleteItem();
            } else if (msgType === 'text') {
                if (text) {
                    addContextMenuItem(menu, '复制文字', icons.copy, () => copyToClipboardWithToast(text));
                    // 翻译：仅当已配置 AI 模型时才显示
                    var _hasAiConfig = false;
                    try {
                        var _aiSettings = (typeof getAIModelSettings === 'function') ? (getAIModelSettings() || {}) : null;
                        _hasAiConfig = !!(_aiSettings && _aiSettings.apiKey);
                    } catch (_) {}
                    if (_hasAiConfig) {
                        addContextMenuItem(menu, '翻译', icons.translate, () => {
                            if (typeof CikaAI_doTranslate === 'function') {
                                CikaAI_doTranslate(row);
                            } else {
                                showSnackbar('AI 功能未加载');
                            }
                        });
                    }
                }
                if (canDelete) addDeleteItem();
            } else {
                if (canDelete) addDeleteItem();
            }

            if (menu.children.length === 0) return;

            positionContextMenu(menu, x, y, 160, 80);
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

        // Tauri 环境下，外部链接交给系统默认浏览器打开；浏览器模式下保持默认行为
        document.addEventListener('click', (e) => {
            if (!window.__TAURI__ || !window.__TAURI__.opener || !window.__TAURI__.opener.openUrl) return;
            if (e.defaultPrevented) return;
            const anchor = e.target.closest ? e.target.closest('a[href]') : null;
            if (!anchor) return;
            const href = anchor.getAttribute('href');
            if (!href || !/^(https?:|mailto:|tel:)/i.test(href)) return;
            e.preventDefault();
            window.__TAURI__.opener.openUrl(href);
        });

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
                return '<div class="list-item" data-session="' + s.id + '" onclick="openPrivateChat(\'' + s.id + '\',\'' + escapeAttr(other) + '\')">' +
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
            // Restore the previously opened chat's selected state
            if (privateSessionId) {
                var activeItem = container.querySelector('.list-item[data-session="' + privateSessionId + '"]');
                if (activeItem) activeItem.classList.add('active');
            }
        }

        function updatePrivateListStatusDots() {
            var dots = document.querySelectorAll('.home-page .private-list .av-status-dot');
            var onlineNames = [];
            try {
                onlineNames = getOnlineUsernames();
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

        async function openPrivateChat(sessionId, otherUser) {
            privateSessionId = sessionId;
            privateOtherUser = otherUser;
            privateChatActive = true;
            privateHasMore = true;
            privateLoadingMore = false;
            // Highlight the selected chat in the sidebar list
            var items = document.querySelectorAll('.home-page .private-list .list-item');
            for (var i = 0; i < items.length; i++) items[i].classList.remove('active');
            var activeItem = document.querySelector('.home-page .private-list .list-item[data-session="' + sessionId + '"]');
            if (activeItem) activeItem.classList.add('active');
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

        function showPrivateLoadMore(show) {
            showLoadMoreIndicator('privateMessages', 'privateLoadMoreIndicator', show);
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
                contentHtml = buildVoiceBubbleHtml(audioUrl, duration, '语音消息');
            } else if (imgMatch) {
                contentHtml =
                    `<img src="${escapeAttr(imgMatch[1])}" onclick="previewImage('${escapeAttr(imgMatch[1])}')" alt="图片" style="max-width:180px;max-height:180px;border-radius:2px;display:block;" oncontextmenu="return false;">`;
                const extraText = actualContent.replace(/!\[.*?\]\(.*?\)/, '').trim();
                if (extraText) {
                    contentHtml += `<div style="margin-top:4px;">${escapeHtml(extraText)}</div>`;
                }
            } else if (linkMatch && isSafeUrl(linkMatch[2])) {
                contentHtml =
                    `<a href="${escapeAttr(linkMatch[2])}" target="_blank" rel="noopener noreferrer" style="color:var(--md-link);text-decoration:underline;">${escapeHtml(linkMatch[1])}</a>`;
            } else if (fileMatch && isSafeUrl(fileMatch[3])) {
                if (isImageFile(fileMatch[1])) {
                    contentHtml = `<img src="${escapeAttr(fileMatch[3])}" alt="${escapeAttr(fileMatch[1])}" loading="lazy" style="max-width:280px;max-height:280px;border-radius:12px;cursor:pointer;" onclick="viewImage('${escapeAttr(fileMatch[3])}')">`;
                    fileIsImage = true;
                } else if (isVideoFile(fileMatch[1])) {
                    contentHtml = `<div class="video-bubble" onclick="openVideoPreview('${escapeAttr(fileMatch[3])}')"><video src="${escapeAttr(fileMatch[3])}" preload="metadata" muted playsinline></video><div class="video-play-overlay"><svg viewBox="0 0 24 24" width="40" height="40" fill="#fff"><path d="M8 5v14l11-7z"/></svg></div><div class="video-name">${escapeHtml(fileMatch[1])}</div></div>`;
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
            else if (fileMatch && isSafeUrl(fileMatch[3])) { row.dataset.msgType = fileIsImage ? 'image' : (isVideoFile(fileMatch[1]) ? 'video' : 'file'); row.dataset.linkUrl = fileMatch[3] || ''; }
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
            addSystemMsg(document.getElementById('privateMessages'), text);
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

        // 私聊消息本地广播/追加/渲染/通知的统一流程（发送与附件、语音、链接共用）
        function appendPrivateMsgLocally(newMsg, withBannerCheck) {
            if (privateChannel) {
                privateChannel.send({ type: 'broadcast', event: 'new_message', payload: newMsg });
            }
            privateMessages.push(newMsg);
            if (document.getElementById('privatePage').classList.contains('active')) {
                renderPrivateMessage(newMsg);
                if (withBannerCheck) checkPrivacyBanner();
                const container = document.getElementById('privateMessages');
                if (container) {
                    scrollToBottom(container);
                    updateScrollButton(container);
                    isUserScrolledUp = false;
                }
            }
            notifyPrivateMsg(privateSessionId, currentUser);
            loadPrivateSessions();
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

            appendPrivateMsgLocally(newMsg, true);
            input.value = '';
            autoResize(input);
            cancelPrivateReply();
            togglePrivateSendBtn();
        }

        function leavePrivateChat() {
            leavePrivateChatAnimated();
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

        function renderOnlineUsers() {
            const uniq = [...new Set(getOnlineUsernames())];
            const n = uniq.length;
            // v048: 同时更新两个胶囊的数字
            var h = document.getElementById('homeCapsule'), p = document.getElementById('publicCapsule');
            if (h) { var t = h.querySelector('.lc-num'); if (t) t.textContent = n; }
            if (p) { var t2 = p.querySelector('.lc-num'); if (t2) t2.textContent = n; }
            document.getElementById('onlineCount').textContent = n;
            var poc = document.getElementById('publicOnlineCount');
            if (poc) poc.textContent = n;
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
            document.getElementById('userProfileUsername').textContent = '加载中';
            document.getElementById('userProfileRole').textContent = '加载中';
            document.getElementById('userProfileStatus').textContent = '加载中';
            document.getElementById('userProfileOnline').textContent = '加载中';
            document.getElementById('userProfileOnlineItem').style.display = 'flex';
            document.getElementById('userProfileChatBtn').style.display = 'none';
            // v049: 管理员按钮可能不存在，需空值保护
            var banBtn = document.getElementById('userProfileBanBtn');
            if (banBtn) banBtn.style.display = 'none';
            var forceLogoutBtn = document.getElementById('userProfileForceLogoutBtn');
            if (forceLogoutBtn) forceLogoutBtn.style.display = 'none';
            var deleteBtn = document.getElementById('userProfileDeleteBtn');
            if (deleteBtn) deleteBtn.style.display = 'none';
            modal.classList.remove('hidden');

            function getOnlineStatus(name) {
                return getOnlineUsernames().includes(name);
            }

            function renderUserProfile(data, isOnline) {
                const idx = hashStr(data.username) % 8;
                avatarEl.className = 'profile-avatar av-' + idx;
                fillUserAvatar(avatarEl, data.username, data.avatar_url);
                if (data.avatar_url) userAvatarCache[data.username] = data.avatar_url;
                document.getElementById('userProfileUsername').textContent = data.username;
                document.getElementById('userProfileRole').textContent = '普通用户';
                let statusText = '正常';
                if (data.banned) statusText = '已封禁';
                document.getElementById('userProfileStatus').textContent = statusText;
                document.getElementById('userProfileOnline').textContent = isOnline ? '在线' : '离线';
                document.getElementById('userProfileOnlineItem').style.display = 'flex';

                const chatBtn = document.getElementById('userProfileChatBtn');
                chatBtn.style.display = data.username === currentUser ? 'none' : 'block';
            }

            function renderDeletedUser(name) {
                const idx = hashStr(name) % 8;
                avatarEl.className = 'profile-avatar av-' + idx;
                fillUserAvatar(avatarEl, name, '');
                document.getElementById('userProfileUsername').textContent = name;
                document.getElementById('userProfileRole').textContent = '未知';
                document.getElementById('userProfileStatus').textContent = '已注销';
                document.getElementById('userProfileOnline').textContent = '离线';
                document.getElementById('userProfileOnlineItem').style.display = 'flex';
                document.getElementById('userProfileChatBtn').style.display = 'none';
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
                    fillUserAvatar(avatarEl, username, '');
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

        /* Removed: showLoginHistory and closeLoginHistoryModal */
/* Removed: admin functions (banUserFromProfile, forceLogoutUser, adminDeleteUser, showAllUsers, closeAllUsersModal, simulateLogin, showStats, closeStatsModal) */

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
