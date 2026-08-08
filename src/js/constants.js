/* CikaChat 常量定义：存储结构说明、表名/路径、版本、限制、通知音等全局常量 */

        // 本应用已弃用 Supabase，改为雨云存储桶（AWS S3 兼容 API）。
        // 凭证只保存在 src-tauri Rust 侧（s3-config.json 或 CIKACHAT_S3_* 环境变量），
        // 前端统一通过 src/js/s3.js 桥接层调用 Tauri invoke（s3rpc_* 命令）。
        // 单存储桶目录结构（对象 Key 前缀）：
        //   users/                用户资料
        //   sessions/             登录会话
        //   public/messages/      公聊消息
        //   private/sessions/     私聊会话
        //   private/messages/     私聊消息
        //   media/                图片/语音/文件/头像（媒体统一存该前缀下）
        //   agents/               智能体配置（预留）
        //   config/               云控等全局配置（预留）
        const HISTORY_LIMIT = 200;
        const APP_VERSION = 69;
<<<<<<< HEAD
        const VERSION = '1.0.0';
=======
        const VERSION = '26.8.703';
>>>>>>> 796daf7bb5b9461b6f81fd47a3186cc9a7e16bde
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
