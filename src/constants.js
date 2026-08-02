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
        const CHANNEL_PUBLIC = 'chat-room-md';
        const HISTORY_LIMIT = 200;
        const APP_VERSION = 49;
        const VERSION = '26.8.301';
        const CC_BANNER_TITLE = '系统维护';
        const CC_BANNER_MSG = '系统正在维护中，暂时无法登录。请联系管理员解除维护状态。';
        const SALT = 'mjchat_2026_salt_v1';
        const FORBIDDEN_WORDS = ['漫卷', 'MJ', 'system', 'System', 'SYSTEM', '管理员', '系统'];
        const MAX_IMAGE_SIZE = 8 * 1024 * 1024;
        const COMPRESS_THRESHOLD = 1 * 1024 * 1024;
        const MAX_IMAGES_PER_MSG = 8;

        const PAGE_SIZE = 200;

        const NOTIFY_SOUNDS = {
            'qq': { file: 'assets/notify/qq.mp3', label: 'QQ提示音' },
            'wechat': { file: 'assets/notify/wechat.mp3', label: '微信提示音' },
            'whatsapp': { file: 'assets/notify/whatsapp.mp3', label: 'WhatsApp提示音' },
            'three_note': { file: 'assets/notify/three_note.mp3', label: '经典三全音' }
        };

        const PAGE_STACK_KEY = 'mjchat_page_stack';
