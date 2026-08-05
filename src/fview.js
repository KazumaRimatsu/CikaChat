/* CikaChat 文件预览器 fview.js
 * 合并原媒体查看器（图片/视频），并新增 Office 文档、代码文件预览。
 * 图片/视频：原 media viewer 逻辑（缩放、拖动、触摸）。
 * Office 文档（docx/pptx/xlsx 等）：通过 Office Web Viewer 在线渲染。
 * 代码文件：fetch 原文后用 highlight.js 高亮。
 * 其余类型：空白页面，居中提示“该文件不支持预览”。
 * 依赖：other.js（escapeHtml / escapeAttr / pageHistory / switchPage 等）。
 */

        // ============================================================
        // 文件类型分类
        // ============================================================
        var FVIEW_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'psd'];
        var FVIEW_VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'm4v'];
        // Office Web Viewer 支持的文档格式
        var FVIEW_OFFICE_EXTS = ['doc', 'docx', 'docm', 'dotx', 'dotm', 'rtf',
            'xls', 'xlsx', 'xlsb', 'xlsm', 'csv',
            'ppt', 'pptx', 'pps', 'ppsx', 'pot', 'potx',
            'odt', 'ods', 'odp'
        ];
        var FVIEW_CODE_EXTS = [
            'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx',
            'html', 'htm', 'css', 'scss', 'sass', 'less', 'json',
            'py', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'cs',
            'go', 'rs', 'php', 'rb', 'sh', 'bash', 'zsh', 'sql',
            'xml', 'yaml', 'yml', 'toml', 'ini', 'conf',
            'md', 'markdown', 'swift', 'kt', 'kts', 'lua', 'r', 'dart',
            'scala', 'pl', 'perl', 'vue', 'svelte', 'dockerfile', 'makefile',
            'cmake', 'bat', 'ps1', 'diff', 'groovy', 'tex', 'proto', 'graphql', 'gql'
        ];
        // 扩展名 → highlight.js 语言名
        var FVIEW_CODE_LANG_MAP = {
            js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
            ts: 'typescript', tsx: 'typescript',
            py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust', java: 'java',
            c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cxx: 'cpp',
            cs: 'csharp', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
            html: 'xml', htm: 'xml', xml: 'xml', vue: 'xml',
            css: 'css', scss: 'scss', less: 'less', json: 'json',
            yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini',
            md: 'markdown', markdown: 'markdown', swift: 'swift',
            kt: 'kotlin', kts: 'kotlin', lua: 'lua', r: 'r', dart: 'dart',
            scala: 'scala', pl: 'perl', perl: 'perl', groovy: 'groovy',
            bat: 'dos', ps1: 'powershell', diff: 'diff', dockerfile: 'dockerfile',
            makefile: 'makefile', cmake: 'cmake', tex: 'tex', proto: 'protobuf',
            graphql: 'graphql', gql: 'graphql'
        };
        var OFFICE_VIEWER_BASE = 'https://view.officeapps.live.com/op/view.aspx?src=';

        // ============================================================
        // 预览状态（图片缩放/平移）
        // ============================================================
        let previewScale = 1;
        let previewTranslateX = 0,
            previewTranslateY = 0;
        let previewLastDist = 0;
        let previewLastX = 0,
            previewLastY = 0;
        let previewTouchStart = false;

        // 预览页面中的全部元素
        function _fviewEls() {
            return {
                img: document.getElementById('previewImg'),
                video: document.getElementById('previewVideo'),
                office: document.getElementById('previewOffice'),
                code: document.getElementById('previewCode'),
                unsupported: document.getElementById('previewUnsupported'),
                zoomControls: document.getElementById('mediaZoomControls'),
                title: document.getElementById('mediaViewerTitle'),
                loading: document.getElementById('mediaLoading'),
                loadingText: document.getElementById('mediaLoadingText'),
                body: document.getElementById('mediaViewerBody')
            };
        }

        // 清空所有预览容器并隐藏，返回元素集合
        function _fviewReset() {
            const el = _fviewEls();
            el.video.pause();
            el.video.removeAttribute('src');
            el.video.load();
            el.video.classList.add('hidden');
            el.img.removeAttribute('src');
            el.img.classList.add('hidden');
            el.office.removeAttribute('src');
            el.office.classList.add('hidden');
            el.code.classList.add('hidden');
            const codeEl = el.code.querySelector('code');
            if (codeEl) codeEl.innerHTML = '';
            el.unsupported.textContent = '';
            el.unsupported.classList.add('hidden');
            if (el.loading) el.loading.classList.add('hidden');
            if (el.zoomControls) el.zoomControls.classList.add('hidden');
            if (el.body) el.body.classList.remove('file-mode');
            return el;
        }

        // 进入预览器页面（已在其中则跳过）
        function _enterMediaViewer() {
            if (pageHistory[pageHistory.length - 1] !== 'media') {
                pushPageHistory('media');
                switchPage('mediaViewerPage', true);
            }
            updateBackBadge();
        }

        // ============================================================
        // 图片预览
        // ============================================================
        function previewImage(url) {
            if (!url) return;
            const el = _fviewReset();
            el.img.classList.remove('hidden');
            el.img.src = url;
            if (el.title) el.title.textContent = '图片预览';
            if (el.zoomControls) el.zoomControls.classList.remove('hidden');
            previewScale = 1;
            previewTranslateX = 0;
            previewTranslateY = 0;
            updatePreviewTransform();
            updateZoomLabel();
            _enterMediaViewer();
        }

        // 文件型图片消息点击时复用图片预览
        function viewImage(url) {
            previewImage(url);
        }

        // ============================================================
        // 视频预览
        // ============================================================
        function openVideoPreview(url) {
            if (!url) return;
            const el = _fviewReset();
            if (el.loadingText) el.loadingText.textContent = '视频加载中...';
            if (el.loading) el.loading.classList.remove('hidden');
            el.video.src = url;
            if (el.title) el.title.textContent = '视频预览';
            _enterMediaViewer();
        }

        // ============================================================
        // 文件预览总入口：按扩展名分发
        // ============================================================
        function openFilePreview(url, filename) {
            if (!url) return;
            filename = filename || '';
            const ext = (filename.split('.').pop() || '').toLowerCase();
            if (FVIEW_IMAGE_EXTS.indexOf(ext) !== -1) { previewImage(url); return; }
            if (FVIEW_VIDEO_EXTS.indexOf(ext) !== -1) { openVideoPreview(url); return; }
            if (FVIEW_OFFICE_EXTS.indexOf(ext) !== -1) { _previewOffice(url, filename); return; }
            if (FVIEW_CODE_EXTS.indexOf(ext) !== -1) { _previewCode(url, filename); return; }
            _previewUnsupported(filename);
        }

        // Office 文档：Office Web Viewer
        function _previewOffice(url, filename) {
            const el = _fviewReset();
            if (el.loadingText) el.loadingText.textContent = '文档加载中...';
            if (el.loading) el.loading.classList.remove('hidden');
            el.office.onload = function() {
                if (el.loading) el.loading.classList.add('hidden');
            };
            el.office.onerror = function() {
                if (el.loading) el.loading.classList.add('hidden');
            };
            el.office.src = OFFICE_VIEWER_BASE + encodeURIComponent(url);
            el.office.classList.remove('hidden');
            if (el.title) el.title.textContent = filename || '文档预览';
            if (el.body) el.body.classList.add('file-mode');
            _enterMediaViewer();
        }

        // 代码文件：highlight.js 高亮
        async function _previewCode(url, filename) {
            const el = _fviewReset();
            if (el.title) el.title.textContent = filename || '代码预览';
            if (el.body) el.body.classList.add('file-mode');
            if (el.loadingText) el.loadingText.textContent = '文件加载中...';
            if (el.loading) el.loading.classList.remove('hidden');
            _enterMediaViewer();
            try {
                const res = await fetch(url);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const text = await res.text();
                const ext = (filename.split('.').pop() || '').toLowerCase();
                const lang = FVIEW_CODE_LANG_MAP[ext] || null;
                let html;
                if (typeof hljs !== 'undefined') {
                    if (lang && hljs.getLanguage(lang)) {
                        html = hljs.highlight(text, { language: lang }).value;
                    } else {
                        html = hljs.highlightAuto(text).value;
                    }
                } else {
                    html = escapeHtml(text); // highlight.js 未加载时的兜底
                }
                const codeEl = el.code.querySelector('code');
                if (codeEl) codeEl.innerHTML = html;
                el.code.classList.remove('hidden');
                if (el.loading) el.loading.classList.add('hidden');
            } catch (e) {
                if (el.loading) el.loading.classList.add('hidden');
                el.unsupported.textContent = '文件加载失败';
                el.unsupported.classList.remove('hidden');
            }
        }

        // 不支持的格式：空白页 + 居中提示
        function _previewUnsupported(filename) {
            const el = _fviewReset();
            if (el.title) el.title.textContent = filename || '文件预览';
            el.unsupported.textContent = '该文件不支持预览';
            el.unsupported.classList.remove('hidden');
            if (el.body) el.body.classList.add('file-mode');
            _enterMediaViewer();
        }

        // ============================================================
        // 关闭预览器
        // ============================================================
        function closeMediaViewer() {
            _fviewReset();
            if (pageHistory.length > 1) {
                popPageHistory();
                const prevPage = pageHistory[pageHistory.length - 1];
                let targetId;
                if (prevPage === 'private') {
                    targetId = 'privatePage';
                } else if (prevPage === 'public') {
                    targetId = 'publicPage';
                } else if (prevPage === 'search') {
                    targetId = 'searchPage';
                } else if (prevPage === 'settings') {
                    targetId = 'settingsPage';
                } else if (prevPage === 'about') {
                    targetId = 'aboutPage';
                } else if (prevPage === 'groupFiles') {
                    targetId = 'groupFilesPage';
                } else {
                    targetId = 'homePage';
                }
                switchPage(targetId, false);
                updateBackBadge();
            }
        }

        // ============================================================
        // 图片缩放/平移（按钮 + 双击 + 触摸 + 鼠标拖动）
        // ============================================================
        function updatePreviewTransform() {
            const img = document.getElementById('previewImg');
            img.style.transform = `scale(${previewScale}) translate(${previewTranslateX}px, ${previewTranslateY}px)`;
        }

        function previewZoomIn() {
            previewScale = Math.min(previewScale * 1.25, 5);
            updatePreviewTransform();
            updateZoomLabel();
        }

        function previewZoomOut() {
            previewScale = Math.max(previewScale / 1.25, 0.25);
            updatePreviewTransform();
            updateZoomLabel();
        }

        function previewResetZoom() {
            previewScale = 1;
            previewTranslateX = 0;
            previewTranslateY = 0;
            updatePreviewTransform();
            updateZoomLabel();
        }

        function previewToggleZoom() {
            if (previewScale > 1.01) {
                previewResetZoom();
            } else {
                previewScale = 2;
                updatePreviewTransform();
                updateZoomLabel();
            }
        }

        function updateZoomLabel() {
            const label = document.getElementById('mediaZoomLabel');
            if (label) label.textContent = Math.round(previewScale * 100) + '%';
        }

        // 触摸交互：单指拖动、双指缩放（仅作用于图片）
        const _fviewMediaBody = document.getElementById('mediaViewerBody');
        if (_fviewMediaBody) {
            _fviewMediaBody.addEventListener('touchstart', function(e) {
                if (e.target.tagName !== 'IMG') return;
                const touches = e.touches;
                if (touches.length === 1) {
                    previewTouchStart = true;
                    previewLastX = touches[0].clientX;
                    previewLastY = touches[0].clientY;
                } else if (touches.length === 2) {
                    previewLastDist = Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
                }
            }, { passive: true });

            _fviewMediaBody.addEventListener('touchmove', function(e) {
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
                    previewScale = Math.min(Math.max(previewScale * scaleFactor, 0.25), 5);
                    previewLastDist = dist;
                    updatePreviewTransform();
                    updateZoomLabel();
                }
            }, { passive: true });

            _fviewMediaBody.addEventListener('touchend', function(e) {
                previewTouchStart = false;
            }, { passive: true });

            _fviewMediaBody.addEventListener('contextmenu', function(e) { e.preventDefault(); });

            // 鼠标左键按住拖动（桌面端）：仅作用于图片
            let previewMouseDragging = false;
            let previewMouseLastX = 0;
            let previewMouseLastY = 0;
            _fviewMediaBody.addEventListener('mousedown', function(e) {
                if (e.button !== 0) return;
                if (e.target.tagName !== 'IMG') return;
                previewMouseDragging = true;
                previewMouseLastX = e.clientX;
                previewMouseLastY = e.clientY;
                _fviewMediaBody.classList.add('dragging');
                e.preventDefault();
            });
            window.addEventListener('mousemove', function(e) {
                if (!previewMouseDragging) return;
                const dx = e.clientX - previewMouseLastX;
                const dy = e.clientY - previewMouseLastY;
                previewTranslateX += dx;
                previewTranslateY += dy;
                previewMouseLastX = e.clientX;
                previewMouseLastY = e.clientY;
                updatePreviewTransform();
            });
            window.addEventListener('mouseup', function(e) {
                if (!previewMouseDragging) return;
                previewMouseDragging = false;
                _fviewMediaBody.classList.remove('dragging');
            });
        }

        // 视频缓冲到可播放后再显示，加载失败给出提示
        const _fviewVideoEl = document.getElementById('previewVideo');
        if (_fviewVideoEl) {
            _fviewVideoEl.addEventListener('canplay', function() {
                const loading = document.getElementById('mediaLoading');
                if (loading) loading.classList.add('hidden');
                _fviewVideoEl.classList.remove('hidden');
                if (_fviewVideoEl.paused) {
                    _fviewVideoEl.play().catch(function() { /* 浏览器自动播放策略拦截时忽略 */ });
                }
            });
            _fviewVideoEl.addEventListener('error', function() {
                // 仅在设置过真实 src 时提示失败（清空 src 触发的 error 忽略）
                if (!_fviewVideoEl.hasAttribute('src') || !_fviewVideoEl.getAttribute('src')) return;
                const loading = document.getElementById('mediaLoading');
                const loadingText = document.getElementById('mediaLoadingText');
                if (loadingText) loadingText.textContent = '视频加载失败';
                if (loading) loading.classList.remove('hidden');
            });
        }
