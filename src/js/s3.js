/* CikaChat S3 后端桥接层：所有服务端数据访问经由 Tauri invoke 转发到 Rust 侧（s3rpc_* 命令）。
 * 凭证只存在于 src-tauri Rust 侧，前端永远接触不到 AccessKey/SecretKey。
 * 用法：
 *   const { data, error } = await s3.rpc('send_public_message_secure', { p_username, ... });
 *   const status = await s3.status();
 */

window.s3 = (function() {
    function invoke(cmd, args) {
        if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
            return window.__TAURI__.core.invoke(cmd, args || {});
        }
        return Promise.reject(new Error('Tauri 后端不可用：请通过桌面应用（CikaChat）运行本程序'));
    }

    // 与旧 sb.rpc 返回结构一致：{ data, error }
    async function rpc(name, params) {
        try {
            const data = await invoke('s3rpc_call', { name: name, params: params || {} });
            return { data: data, error: null };
        } catch (e) {
            const msg = (e && e.message) ? String(e.message) : String(e);
            return { data: null, error: { message: msg } };
        }
    }

    return {
        rpc: rpc,
        invoke: invoke,
        status: function() {
            return invoke('s3_status', {});
        },
        // 获取媒体访问 URL（私有桶场景用预签名 URL；公共读桶返回直链）
        mediaUrl: function(key) {
            return rpc('get_media_url', { p_key: key }).then(function(res) {
                if (res.error || !res.data || res.data.success === false) return '';
                return res.data.url || '';
            });
        }
    };
})();
