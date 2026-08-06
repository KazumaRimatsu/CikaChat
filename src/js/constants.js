/* CikaChat 常量定义：密钥解码、Supabase 配置、表名/桶名、版本、限制、通知音等全局常量 */

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
        const FILES_BUCKET = 'chat-files';
        const CHANNEL_PUBLIC = 'chat-room-md';
        const HISTORY_LIMIT = 200;
        const APP_VERSION = 69;
        const VERSION = '26.8.601';
        const CC_BANNER_TITLE = '系统维护';
        const CC_BANNER_MSG = '系统正在维护，暂时无法登录。';
        const SALT = 'mjchat_2026_salt_v1';
        const FORBIDDEN_WORDS = ['漫卷', 'MJ', 'system', 'System', 'SYSTEM', '管理员', '系统'];
        const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
        const COMPRESS_THRESHOLD = 1 * 1024 * 1024;
        const MAX_IMAGES_PER_MSG = 9;
        const MAX_FILE_SIZE = 32 * 1024 * 1024;

        const PAGE_SIZE = 200;

        const NOTIFY_SOUNDS = {
            'qq': { file: 'assets/notify/qq.mp3', label: 'QQ' },
            'wechat': { file: 'assets/notify/wechat.mp3', label: '微信' },
            'whatsapp': { file: 'assets/notify/whatsapp.mp3', label: 'WhatsApp' },
            'three_note': { file: 'assets/notify/three_note.mp3', label: '三全音' }
        };

        // 通知默认设置（多处复用；写入缓存前必须拷贝，避免共享引用被修改）
        // enabled 主开关已废弃（v057：合并为「消息免打扰」后删除）；publicEnabled/privateEnabled 即各聊天「消息提示音」开关
        const DEFAULT_NOTIFY = { sound: 'three_note', publicEnabled: false, privateEnabled: true };

        // AI 服务商 → 默认模型（ai.js / 智能体设置共用，避免三处各自维护）
        const AGENT_DEFAULT_MODELS = {
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

        // 语音消息播放/暂停按钮图标（渲染语音气泡与切换播放状态共用）
        const ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
        const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

        // 表情列表（公聊/私聊选择器共用，仅渲染一次）
        const EMOJIS = ['😀', '😂', '🥰', '😎', '🤔', '😴', '😭', '😡', '👍', '👎', '❤️', '🔥', '🎉', '✨', '💯', '🚀', '👀', '🤝',
            '🙏', '💪', '☕', '🍕', '🎵', '⭐', '🌙', '🌸', '💎', '🎯', '🎨', '🎭', '🎪', '🎤', '🎧', '🎸', '🎹', '🎺', '🎻', '🥁', '🎲',
            '♟️', '🎳', '🎮', '🕹️', '🎬', '🎶', '🎼', '🥳', '🤯', '🤩', '😇', '🙃', '😉', '😋', '😜', '🤪', '🤭', '🫡', '🫶', '🤍',
            '💚', '💙', '🩵', '💜', '🤎', '🖤', '💝', '💖', '💗', '💓', '💞', '💕', '💟', '❣️', '💔', '❤️‍🔥', '❤️‍🩹', '💘', '💌',
            '💋', '🫦', '💢', '💬', '🗯️', '💭', '💤', '💫', '🌀', '🌊', '🌈', '☀️', '🌤️', '⛅', '🌥️', '🌦️', '☁️', '🌧️', '⛈️', '🌩️',
            '🌨️', '❄️', '☃️', '⛄', '🌬️', '💨', '🌪️', '🌫️', '💧', '💦', '☔', '☂️', '🌂', '🧵', '🧶', '👗', '👘', '🥻',
            '🩱', '🩲', '🩳', '👙', '👚', '👕', '👖', '🧣', '🧤', '🧥', '🧦', '👔', '👞', '👟', '🥾', '🥿', '👠', '👡', '👢', '👑',
            '👒', '🎩', '🎓', '🧢', '⛑️', '📿', '💄', '💍', '🔮', '🖼️'
        ];

        const PAGE_STACK_KEY = 'mjchat_page_stack';
