/* CikaChat 功能模块：语音、图片、文件、链接、表情、文本特效、通知音、Agent、头像、搜索 */

        // 通用上传：返回公网 URL，失败时提示并返回 null（bucket 未创建给出引导）
        async function uploadToBucket(filePath, blob, contentType) {
            const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filePath, blob, { contentType: contentType,
                cacheControl: '3600' });
            if (error) {
                if (error.message.includes('bucket') || error.message.includes('not found')) showSnackbar(
                    '上传失败: 请先在 Storage 创建 chat-images Bucket');
                else showSnackbar('上传失败: ' + error.message);
                return null;
            }
            const { data: urlData } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filePath);
            return urlData.publicUrl;
        }

        // 语音录制工厂：公聊/私聊共用同一套录音、计时、上传流程
        function createVoiceRecorder(config) {
            const RECORD_MIC_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>';
            const RECORD_STOP_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
            const state = { recorder: null, chunks: [], startTime: null, timerInterval: null };

            function reset() {
                const btn = document.getElementById(config.ids.btn);
                const timer = document.getElementById(config.ids.timer);
                const hint = document.getElementById(config.ids.hint);
                const stopBtn = document.getElementById(config.ids.stopBtn);
                btn.classList.remove('recording');
                btn.innerHTML = RECORD_MIC_ICON;
                timer.textContent = '00:00';
                hint.textContent = '点击开始录音';
                stopBtn.classList.remove('show');
                if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
            }

            async function toggle() {
                const btn = document.getElementById(config.ids.btn);
                const timer = document.getElementById(config.ids.timer);
                const hint = document.getElementById(config.ids.hint);
                const stopBtn = document.getElementById(config.ids.stopBtn);
                if (!state.recorder || state.recorder.state === 'inactive') {
                    try {
                        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                        state.chunks = [];
                        const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
                        state.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
                        state.recorder.ondataavailable = (e) => { if (e.data.size > 0) state.chunks.push(e.data); };
                        state.recorder.onstop = async () => {
                            stream.getTracks().forEach(t => t.stop());
                            const audioBlob = new Blob(state.chunks, { type: mimeType || 'audio/webm' });
                            if (audioBlob.size < 1000) {
                                showSnackbar(config.tooShortMsg);
                                reset();
                                return;
                            }
                            await upload(audioBlob, mimeType || 'audio/webm');
                            reset();
                        };
                        state.recorder.start();
                        state.startTime = Date.now();
                        btn.classList.add('recording');
                        btn.innerHTML = RECORD_STOP_ICON;
                        hint.textContent = '正在录音...';
                        stopBtn.classList.add('show');
                        state.timerInterval = setInterval(() => {
                            timer.textContent = formatDuration(Math.floor((Date.now() - state.startTime) / 1000));
                        }, 1000);
                    } catch (e) {
                        showSnackbar('无法访问麦克风');
                    }
                } else if (state.recorder.state === 'recording') {
                    state.recorder.stop();
                }
            }

            async function upload(blob, mimeType) {
                const ext = mimeType.includes('webm') ? 'webm' : 'm4a';
                const filePath = config.makePath(ext);
                showSnackbar('正在上传语音...');
                try {
                    const url = await uploadToBucket(filePath, blob, mimeType);
                    if (!url) return;
                    const duration = state.startTime ? Math.floor((Date.now() - state.startTime) / 1000) : 0;
                    await config.onUploaded(duration, url);
                } catch (e) { showSnackbar('上传失败'); }
            }

            return { toggle: toggle, reset: reset, state: state };
        }

        const publicRecorder = createVoiceRecorder({
            ids: { btn: 'recordBtn', timer: 'recordTimer', hint: 'recordHint', stopBtn: 'recordStopBtn' },
            tooShortMsg: '录音太短',
            makePath: (ext) => `audio/${Date.now()}-${generateId()}.${ext}`,
            onUploaded: async (duration, url) => {
                const fallbackText = buildVoiceFallback(duration);
                let audioResult = await sendPublicMessageSecure({
                    text: fallbackText,
                    audio_url: url,
                    audio_dur: duration,
                    is_system: false,
                    msg_version: APP_VERSION
                });
                if (!audioResult.success && audioResult.message && (audioResult.message.includes('audio_dur') || audioResult.message.includes('audio_url'))) {
                    audioResult = await sendPublicMessageSecure({
                        text: buildVoiceFallback(duration, url),
                        is_system: false,
                        msg_version: APP_VERSION
                    });
                }
                if (!audioResult.success) showSnackbar('发送语音失败: ' + (audioResult.message || ''));
                else showSnackbar('语音已发送');
            }
        });

        const privateRecorder = createVoiceRecorder({
            ids: { btn: 'privateRecordBtn', timer: 'privateRecordTimer', hint: 'privateRecordHint', stopBtn: 'privateRecordStopBtn' },
            tooShortMsg: '录音时间太短',
            makePath: (ext) => `private/${privateSessionId}/audio/${Date.now()}-${generateId()}.${ext}`,
            onUploaded: async (duration, url) => {
                const content = `🎤 语音 ${formatDuration(duration)} → ${url}`;
                try {
                    const newMsg = await safeInsertPrivateMsg(privateSessionId, currentUser, content);
                    appendPrivateMsgLocally(newMsg, false);
                } catch (ie) {
                    const msg = ie.message || '';
                    showSnackbar(msg.includes('隐私') || msg.includes('拒收') ? msg : '发送失败: ' + msg);
                }
            }
        });

        function toggleRecording() { return publicRecorder.toggle(); }
        function privateToggleRecording() { return privateRecorder.toggle(); }
        let activeAudio = null;
        let linkMode = 'public';

        let _notifyAudio = null;
        let _audioUnlocked = false;

        // 在首次用户交互（点击/触摸/按键）时播放一段静音音频，
        // 解锁浏览器/WKWebView 的自动播放限制，否则 WebSocket 事件里播放提示音会被拦截
        function unlockNotifyAudio() {
            if (_audioUnlocked) return;
            _audioUnlocked = true;
            try {
                var silent = new Audio();
                silent.src = 'data:audio/wav;base64,UklGRogAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YWQAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';
                silent.volume = 0.001;
                silent.play().catch(function() {});
            } catch (e) {}
        }
        document.addEventListener('pointerdown', unlockNotifyAudio, true);
        document.addEventListener('touchstart', unlockNotifyAudio, true);
        document.addEventListener('keydown', unlockNotifyAudio, true);

        function playNotifySound() {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            const ns = _userSettingsCache.notify;
            const sound = NOTIFY_SOUNDS[ns.sound] || NOTIFY_SOUNDS['three_note'];
            try {
                if (!_notifyAudio) _notifyAudio = new Audio();
                _notifyAudio.src = sound.file;
                _notifyAudio.volume = 1;
                var p = _notifyAudio.play();
                if (p && p.catch) {
                    p.catch(function(err) {
                        console.warn('[notify] 提示音被自动播放策略拦截:', err && err.name);
                    });
                }
            } catch (e) {
                console.warn('[notify] 提示音播放异常:', e);
            }
        }

        // 群聊「消息提示音」开关（是否播放提示音由调用方结合免打扰状态判断）
        function getPublicNotifyEnabled() {
            if (!_userSettingsCache) return false;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            return !!_userSettingsCache.notify.publicEnabled;
        }

        // 私聊「消息提示音」开关（是否播放提示音由调用方结合免打扰状态判断）
        function getPrivateNotifyEnabled() {
            if (!_userSettingsCache) return false;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            return !!_userSettingsCache.notify.privateEnabled;
        }

        function refreshNotifySettingsUI() {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            const ns = _userSettingsCache.notify;

            // Update settings page（提示音选择始终可见）
            const soundValue = document.getElementById('settingsNotifySoundValue');
            if (soundValue) {
                const snd = NOTIFY_SOUNDS[ns.sound];
                soundValue.textContent = snd ? snd.label : '经典三全音';
            }

            // Update chat menu items：免打扰关闭时显示「消息提示音」开关，开启时隐藏
            const publicMenuItem = document.getElementById('publicMenuNotifyItem');
            if (publicMenuItem) {
                const publicMuted = (typeof _mutePublic !== 'undefined') && _mutePublic;
                publicMenuItem.style.display = publicMuted ? 'none' : '';
                const publicLabel = document.getElementById('publicNotifyLabel');
                if (publicLabel) {
                    publicLabel.textContent = ns.publicEnabled ? '关闭消息提示音' : '开启消息提示音';
                }
            }

            const privateMenuItem = document.getElementById('privateMenuNotifyItem');
            if (privateMenuItem) {
                const privateMuted = privateSessionId && _mutePerPrivateSession && _mutePerPrivateSession[privateSessionId];
                privateMenuItem.style.display = privateMuted ? 'none' : '';
                const privateLabel = document.getElementById('privateNotifyLabel');
                if (privateLabel) {
                    privateLabel.textContent = ns.privateEnabled ? '关闭消息提示音' : '开启消息提示音';
                }
            }
        }

        function showNotifySoundDialog() {
            if (!_userSettingsCache) return;
            // 兼容旧版本：如果 notify 不存在，自动用默认值初始化
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
                syncSettingsToEncryptedStore();
            }
            const dialog = document.getElementById('notifySoundDialog');
            if (dialog) {
                dialog.classList.remove('hidden');
                updateNotifySoundDialog();
            }
        }

        function closeNotifySoundDialog() {
            const dialog = document.getElementById('notifySoundDialog');
            if (dialog) dialog.classList.add('hidden');
        }

        function updateNotifySoundDialog() {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            const currentSound = _userSettingsCache.notify.sound || 'three_note';
            const items = document.querySelectorAll('.notify-sound-item');
            items.forEach(function(item) {
                if (item.dataset.sound === currentSound) {
                    item.classList.add('selected');
                } else {
                    item.classList.remove('selected');
                }
            });
        }

        async function selectNotifySound(sound) {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            _userSettingsCache.notify.sound = sound;
            await syncSettingsToEncryptedStore();
            updateNotifySoundDialog();
            refreshNotifySettingsUI();
        }

        function previewNotifySound(sound) {
            const snd = NOTIFY_SOUNDS[sound];
            if (snd) {
                try {
                    var preview = new Audio(snd.file);
                    var p = preview.play();
                    if (p && p.catch) {
                        p.catch(function(err) {
                            console.warn('[notify] 试听被自动播放策略拦截:', err && err.name);
                        });
                    }
                } catch (e) {}
            }
        }

        // 群聊「消息提示音」开关（仅免打扰关闭时在聊天菜单显示）
        async function togglePublicNotify() {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            _userSettingsCache.notify.publicEnabled = !_userSettingsCache.notify.publicEnabled;
            await syncSettingsToEncryptedStore();
            refreshNotifySettingsUI();
            showSnackbar(_userSettingsCache.notify.publicEnabled ? '公共聊天消息提示音已开启' : '公共聊天消息提示音已关闭');
        }

        // 私聊「消息提示音」开关（仅免打扰关闭时在聊天菜单显示）
        async function togglePrivateNotify() {
            if (!_userSettingsCache) return;
            if (!_userSettingsCache.notify) {
                _userSettingsCache.notify = Object.assign({}, DEFAULT_NOTIFY);
            }
            _userSettingsCache.notify.privateEnabled = !_userSettingsCache.notify.privateEnabled;
            await syncSettingsToEncryptedStore();
            refreshNotifySettingsUI();
            showSnackbar(_userSettingsCache.notify.privateEnabled ? '私聊消息提示音已开启' : '私聊消息提示音已关闭');
        }

        // Pure JavaScript SHA-256 implementation for old WebView compatibility
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
                    const url = await uploadToBucket(filePath, blobToUpload, 'image/jpeg');
                    if (!url) return;
                    imageUrls.push(url);
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
                msg_version: APP_VERSION,
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
                const url = await uploadToBucket(filePath, file, file.type || 'application/octet-stream');
                if (!url) return;
                const fileSize = (file.size / 1024).toFixed(1);
                const fileText = buildFileText(file.name, fileSize, url);
                const ieResult = await sendPublicMessageSecure({ text: fileText, is_system: false, msg_version: APP_VERSION });
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
                    appendPrivateMsgLocally(newMsg, false);
                } catch (e) {
                    const msg = e.message || '';
                    showSnackbar(msg.includes('隐私') || msg.includes('拒收') ? msg : '发送失败: ' + msg);
                }
            } else {
                const linkResult = await sendPublicMessageSecure({ text: linkText, is_system: false, msg_version: APP_VERSION });
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
            if (publicRecorder.state.recorder && publicRecorder.state.recorder.state === 'recording') {
                publicRecorder.state.recorder.stop();
            }
            document.getElementById('emojiSubPanel').classList.remove('active');
            document.getElementById('textEffectSubPanel').classList.remove('active');
            document.getElementById('voiceSubPanel').classList.remove('active');
            document.getElementById('featurePanelMain').style.display = 'block';
        }

        function applyTextEffectTo(input, toggleFn, tag) {
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
                default:
                    wrapped = selected;
            }
            input.setRangeText(wrapped, start, end, 'end');
            autoResize(input);
            toggleFn();
            const newPos = start + wrapped.length;
            input.setSelectionRange(newPos, newPos);
        }

        function applyTextEffect(tag) {
            applyTextEffectTo(document.getElementById('publicMsgInput'), togglePublicSendBtn, tag);
        }

        function initEmojiPicker() {
            document.getElementById('emojiGrid').innerHTML = EMOJIS.map(e =>
                `<button class="emoji-item" onclick="insertEmoji('${e}')">${e}</button>`).join('');
        }

        function buildVoiceFallback(duration, audioUrl) {
            var tail = audioUrl || '请升级 MJChat 到最新版本查看此消息';
            return '🎤 语音 ' + formatDuration(duration) + ' → ' + tail;
        }

        function toggleVoicePlay(wrap, event) {
            event.stopPropagation();
            const audioUrl = wrap.dataset.audio;
            if (!audioUrl) return;

            function resetBtn(w) {
                const b = w.querySelector('.voice-play-btn');
                if (b) b.innerHTML = ICON_PLAY;
            }

            if (activeAudio && activeAudio.wrap === wrap && !activeAudio.audio.paused) {
                activeAudio.audio.pause();
                wrap.classList.remove('playing');
                resetBtn(wrap);
                activeAudio = null;
                return;
            }

            if (activeAudio) {
                activeAudio.audio.pause();
                activeAudio.wrap.classList.remove('playing');
                resetBtn(activeAudio.wrap);
            }

            const audio = new Audio(audioUrl);
            wrap.classList.add('playing');
            const btn = wrap.querySelector('.voice-play-btn');
            btn.innerHTML = ICON_PAUSE;

            audio.onended = () => {
                wrap.classList.remove('playing');
                resetBtn(wrap);
                if (activeAudio && activeAudio.wrap === wrap) activeAudio = null;
            };
            audio.onerror = () => {
                wrap.classList.remove('playing');
                resetBtn(wrap);
                if (activeAudio && activeAudio.wrap === wrap) activeAudio = null;
                showSnackbar('播放失败');
            };
            audio.play().catch(() => {
                wrap.classList.remove('playing');
                resetBtn(wrap);
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
            if (privateRecorder.state.recorder && privateRecorder.state.recorder.state === 'recording') {
                privateRecorder.state.recorder.stop();
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
                    const url = await uploadToBucket(filePath, blobToUpload, 'image/jpeg');
                    if (!url) return;
                    imageUrls.push(url);
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
                appendPrivateMsgLocally(newMsg, true);
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
                const url = await uploadToBucket(filePath, file, file.type || 'application/octet-stream');
                if (!url) return;
                const fileSize = (file.size / 1024).toFixed(1);
                const content = `📎 ${file.name} (${fileSize} KB) → ${url}`;
                try {
                    const newMsg = await safeInsertPrivateMsg(privateSessionId, currentUser, content);
                    appendPrivateMsgLocally(newMsg, true);
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
            applyTextEffectTo(document.getElementById('privateMsgInput'), togglePrivateSendBtn, tag);
        }

        function initPrivateEmojiPicker() {
            document.getElementById('privateEmojiGrid').innerHTML = EMOJIS.map(e =>
                `<button class="emoji-item" onclick="privateInsertEmoji('${e}')">${e}</button>`).join('');
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
                    if (error) { container.innerHTML = '<div class="empty">权限不足</div>'; return; }
                    users = data;
                }
                if (!users || users.length === 0) {
                    container.innerHTML = '<div class="empty">未找到用户</div>';
                    return;
                }
                var onlineUsernames = getOnlineUsernames();
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

        function showAgentList() {
            document.getElementById('agentListModal').classList.remove('hidden');
            loadAgentList();
        }

        function closeAgentList() {
            document.getElementById('agentListModal').classList.add('hidden');
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
            modelInput.value = AGENT_DEFAULT_MODELS[provider] || AGENT_DEFAULT_MODELS['custom'];
        }

        function closeAddAgentDialog() {
            document.getElementById('addAgentDialog').classList.add('hidden');
            document.getElementById('agentApiKey').value = '';
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
            overlay.style.background = 'var(--md-scrim)';
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
