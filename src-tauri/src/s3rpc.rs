//! KnockChat S3 业务命令层。
//! 前端通过 Tauri invoke 调用 `s3rpc_<rpc名>`，参数统一为 `{ params: {...} }`（serde_json::Value），
//! 返回 `serde_json::Value`（与旧 Supabase RPC 的结构保持一致，前端改动最小）。

use crate::s3::{ObjectMeta, S3, S3Config};
use chrono::{Duration, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock};

static CFG: OnceLock<Mutex<Option<Arc<S3>>>> = OnceLock::new();

/// 设置全局 S3 客户端（lib.rs 在启动时调用）
pub fn set_s3(s3: Option<S3>) {
    let lock = CFG.get_or_init(|| Mutex::new(None));
    if let Ok(mut g) = lock.lock() {
        *g = s3.map(|s| Arc::new(s));
    }
}

/// 获取全局 S3 客户端，未配置时返回错误
fn s3() -> Result<Arc<S3>, String> {
    let lock = CFG.get_or_init(|| Mutex::new(None));
    let g = lock.lock().map_err(|_| "S3 配置锁异常".to_string())?;
    g.clone().ok_or_else(|| "S3 存储桶未配置，请先完成存储桶配置（见配置指南）".to_string())
}

fn err(msg: &str) -> Result<Value, String> {
    Err(msg.to_string())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn new_id() -> String {
    let ms = Utc::now().timestamp_millis().max(0) as u64;
    let r: u64 = rand::random();
    format!("{:x}{:016x}", ms, r)
}

/// 用户名 → 对象 Key 安全编码（保留 ASCII 字母数字 .-_，其余字节 %XX）
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let c = *b as char;
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' {
            out.push(c);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// 用户主键：users/<uid>.json（uid 从 1 开始递增，类似 QQ 号）
fn user_key(uid: u64) -> String {
    format!("users/{}.json", uid)
}

/// 用户名 → uid 反向索引：users/by_name/<enc(username)>.json 存 {"uid": N}
fn user_name_index(username: &str) -> String {
    format!("users/by_name/{}.json", enc(username))
}

/// uid 计数器：users/_meta.json 存 {"next_uid": N}
const UID_META_KEY: &str = "users/_meta.json";

/// 分配一个新的 uid（从 1 开始递增，类 QQ 号）。
/// S3 无原子操作：读 next_uid → 尝试写用户对象（占用检查）→ 更新计数器。
async fn next_uid(s3: &Arc<S3>) -> Result<u64, String> {
    for _ in 0..50 {
        let next = match json_get(s3, UID_META_KEY).await? {
            Some(v) => v["next_uid"].as_u64().unwrap_or(1).max(1),
            None => 1,
        };
        // 占用检查：该 uid 尚未被写用户文件，则占用成功（并发注册时几乎不可能同号）
        if json_get(s3, &user_key(next)).await?.is_none() {
            json_put(s3, UID_META_KEY, &json!({ "next_uid": next + 1 })).await?;
            return Ok(next);
        }
    }
    Err("uid 分配冲突，请重试".to_string())
}

fn session_key(token: &str) -> String {
    format!("sessions/{}.json", enc(token))
}

fn pub_msg_key(id: &str) -> String {
    format!("public/messages/{}.json", id)
}

fn priv_sess_key(sid: &str) -> String {
    format!("private/sessions/{}.json", sid)
}

fn priv_msg_key(sid: &str, id: &str) -> String {
    format!("private/messages/{}/{}.json", sid, id)
}

/// 私聊会话 id：两个 uid 按数值排序拼接（唯一且可推导）
fn private_session_id(uid_a: u64, uid_b: u64) -> String {
    if uid_a < uid_b {
        format!("{}__{}", uid_a, uid_b)
    } else {
        format!("{}__{}", uid_b, uid_a)
    }
}

fn valid_username(u: &str) -> bool {
    let n = u.chars().count();
    if n < 2 || n > 15 {
        return false;
    }
    !u.chars().any(|c| {
        // 空白 / 控制字符（C0/C1 与 Unicode Cc）/
        // 零宽及不可见格式字符（Cf）：U+00AD 软连字符、U+061C 阿拉伯字母数字符号、
        // U+200B-200F 零宽空格/连接符/分隔符、U+202A-202E 双向文本、U+2060-2064/2066-2069 隐形格式、U+FEFF BOM
        c.is_whitespace()
            || c.is_control()
            || matches!(
                c,
                '\u{00AD}' | '\u{061C}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{200E}' | '\u{200F}'
                    | '\u{202A}' | '\u{202B}' | '\u{202C}' | '\u{202D}' | '\u{202E}' | '\u{2060}' | '\u{2061}'
                    | '\u{2062}' | '\u{2063}' | '\u{2064}' | '\u{2066}' | '\u{2067}' | '\u{2068}' | '\u{2069}'
                    | '\u{FEFF}'
            )
            || matches!(
                c,
                '<' | '>' | '&' | '"' | '\'' | '\\' | '/' | '#' | '?' | ':' | '%'
                    | '{' | '}' | '|' | '^' | '`' | '~' | '[' | ']' | '@' | '*' | '$'
                    | '!' | '(' | ')' | '=' | '+' | ',' | ';'
            )
    })
}

// ==================== JSON 读写辅助 ====================

async fn json_get(s3: &S3, key: &str) -> Result<Option<Value>, String> {
    match s3.get_object(key).await? {
        Some(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| format!("解析 {} 失败: {e}", key)),
        None => Ok(None),
    }
}

async fn json_put(s3: &S3, key: &str, v: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec(v).map_err(|e| format!("序列化失败: {e}"))?;
    s3.put_object(key, bytes, "application/json").await
}

async fn fetch_json_all(s3: &Arc<S3>, keys: &[String]) -> Vec<Value> {
    let mut out = Vec::with_capacity(keys.len());
    for chunk in keys.chunks(16) {
        let fut: Vec<_> = chunk.iter().map(|k| json_get(s3, k)).collect();
        let res = futures::future::join_all(fut).await;
        for r in res {
            if let Ok(Some(v)) = r {
                out.push(v);
            }
        }
    }
    out
}

fn sort_desc_by_created(arr: &mut [Value]) {
    arr.sort_by(|a, b| {
        let ta = a["created_at"].as_str().unwrap_or("");
        let tb = b["created_at"].as_str().unwrap_or("");
        tb.cmp(ta)
    });
}

// ==================== 会话管理 ====================

async fn create_session(s3: &Arc<S3>, uid: u64, username: &str) -> Result<String, String> {
    let token = new_id();
    let sess = json!({
        "uid": uid,
        "username": username,
        "created_at": now_iso(),
        "expires_at": (Utc::now() + Duration::days(30)).to_rfc3339_opts(SecondsFormat::Millis, true)
    });
    json_put(s3, &session_key(&token), &sess).await?;
    Ok(token)
}

async fn verify_session(s3: &Arc<S3>, uid: u64, token: &str) -> Result<bool, String> {
    if token.is_empty() {
        return Ok(false);
    }
    let Some(v) = json_get(s3, &session_key(token)).await? else {
        return Ok(false);
    };
    let suid = v["uid"].as_u64().unwrap_or(0);
    let exp = v["expires_at"].as_str().unwrap_or("");
    if suid != uid || exp.is_empty() {
        return Ok(false);
    }
    let expired = chrono::DateTime::parse_from_rfc3339(exp)
        .map(|d| d <= Utc::now())
        .unwrap_or(true);
    Ok(!expired)
}

// ==================== 用户文件 ====================

async fn get_user(s3: &Arc<S3>, uid: u64) -> Result<Option<Value>, String> {
    json_get(s3, &user_key(uid)).await
}

async fn save_user(s3: &Arc<S3>, uid: u64, v: &Value) -> Result<(), String> {
    json_put(s3, &user_key(uid), v).await
}

/// 通过用户名查 uid（反向索引）
async fn uid_by_name(s3: &Arc<S3>, username: &str) -> Result<Option<u64>, String> {
    let Some(v) = json_get(s3, &user_name_index(username)).await? else {
        return Ok(None);
    };
    Ok(v["uid"].as_u64())
}

async fn get_user_by_name(s3: &Arc<S3>, username: &str) -> Result<Option<Value>, String> {
    match uid_by_name(s3, username).await? {
        Some(uid) => get_user(s3, uid).await,
        None => Ok(None),
    }
}

fn default_user(username: &str, password_hash: &str, uid: u64) -> Value {
    json!({
        "uid": uid,
        "username": username,
        "password_hash": password_hash,
        "role": "user",
        "banned": false,
        "avatar_url": "",
        "bg_url": "",
        "email": "",
        "birthday": "",
        "bio": "",
        "tags": [],
        "blocked": [],
        "created_at": now_iso(),
        "last_login_at": "",
        "last_login_ip": ""
    })
}

fn user_public_fields(v: &Value) -> Value {
    json!({
        "success": true,
        "uid": v["uid"].as_u64().unwrap_or(0),
        "username": v["username"].as_str().unwrap_or(""),
        "role": v["role"].as_str().unwrap_or("user"),
        "banned": v["banned"].as_bool().unwrap_or(false),
        "avatar_url": v["avatar_url"].as_str().unwrap_or(""),
        "bg_url": v["bg_url"].as_str().unwrap_or(""),
        "email": v["email"].as_str().unwrap_or(""),
        "birthday": v["birthday"].as_str().unwrap_or(""),
        "bio": v["bio"].as_str().unwrap_or(""),
        "tags": v["tags"].clone(),
        "created_at": v["created_at"].as_str().unwrap_or("")
    })
}

// ==================== 认证 ====================

pub async fn s3rpc_check_username_exists(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let username = params["p_username"].as_str().unwrap_or("");
    if username.is_empty() {
        return err("缺少用户名");
    }
    let exists = get_user_by_name(&s, username).await?.is_some();
    Ok(json!({ "exists": exists }))
}

async fn do_register(s3: &Arc<S3>, username: &str, password_hash: &str) -> Result<Value, String> {
    if !valid_username(username) {
        return Ok(json!({ "success": false, "message": "昵称不合法（2-15 个字符）" }));
    }
    if password_hash.len() < 10 {
        return Ok(json!({ "success": false, "message": "密码哈希无效" }));
    }
    if get_user_by_name(s3, username).await?.is_some() {
        return Ok(json!({ "success": false, "message": "该昵称已被使用" }));
    }
    let uid = next_uid(s3).await?;
    save_user(s3, uid, &default_user(username, password_hash, uid)).await?;
    json_put(s3, &user_name_index(username), &json!({ "uid": uid })).await?;
    let token = create_session(s3, uid, username).await?;
    Ok(json!({ "success": true, "uid": uid, "username": username, "session_token": token }))
}

pub async fn s3rpc_register_user_secure(params: Value) -> Result<Value, String> {
    let s = s3()?;
    do_register(&s, params["p_username"].as_str().unwrap_or(""), params["p_password_hash"].as_str().unwrap_or("")).await
}

pub async fn s3rpc_register_user(params: Value) -> Result<Value, String> {
    s3rpc_register_user_secure(params).await
}

async fn do_login(s3: &Arc<S3>, username: &str, password_hash: &str) -> Result<Value, String> {
    let Some(user) = get_user_by_name(s3, username).await? else {
        return Ok(json!({ "success": false, "message": "昵称或密码错误" }));
    };
    if user["password_hash"].as_str().unwrap_or("") != password_hash {
        return Ok(json!({ "success": false, "message": "昵称或密码错误" }));
    }
    if user["banned"].as_bool().unwrap_or(false) {
        return Ok(json!({ "success": true, "banned": true, "message": "您的账户已被封禁，无法登录" }));
    }
    let uid = user["uid"].as_u64().unwrap_or(0);
    let token = create_session(s3, uid, username).await?;
    let avatar = user["avatar_url"].as_str().unwrap_or("");
    Ok(json!({
        "success": true,
        "uid": uid,
        "username": username,
        "session_token": token,
        "avatar_url": avatar,
        "banned": false,
        "role": user["role"].as_str().unwrap_or("user")
    }))
}

pub async fn s3rpc_verify_login_secure_rate_limited(params: Value) -> Result<Value, String> {
    let s = s3()?;
    do_login(&s, params["p_username"].as_str().unwrap_or(""), params["p_password_hash"].as_str().unwrap_or("")).await
}

pub async fn s3rpc_verify_login_secure(params: Value) -> Result<Value, String> {
    s3rpc_verify_login_secure_rate_limited(params).await
}

pub async fn s3rpc_verify_login(params: Value) -> Result<Value, String> {
    s3rpc_verify_login_secure_rate_limited(params).await
}

async fn do_verify_session(s3: &Arc<S3>, uid: u64, username: &str, token: &str) -> Result<Value, String> {
    let valid = verify_session(s3, uid, token).await?;
    if !valid {
        return Ok(json!({ "success": true, "valid": false }));
    }
    let user = get_user(s3, uid).await?.unwrap_or_else(|| json!({}));
    let name = if username.is_empty() {
        user["username"].as_str().unwrap_or("")
    } else {
        username
    };
    Ok(json!({
        "success": true,
        "valid": true,
        "uid": uid,
        "username": name,
        "avatar_url": user["avatar_url"].as_str().unwrap_or(""),
        "banned": user["banned"].as_bool().unwrap_or(false),
        "needs_relogin": false
    }))
}

pub async fn s3rpc_verify_session_secure(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let username = params["p_username"].as_str().unwrap_or("");
    let token = params["p_token"].as_str().or_else(|| params["p_session_token"].as_str()).unwrap_or("");
    // 兼容旧客户端只传 username：通过反向索引解析 uid
    let uid = if uid == 0 && !username.is_empty() {
        uid_by_name(&s, username).await?.unwrap_or(0)
    } else {
        uid
    };
    if uid == 0 {
        return Ok(json!({ "success": true, "valid": false }));
    }
    do_verify_session(&s, uid, username, token).await
}

pub async fn s3rpc_verify_session(params: Value) -> Result<Value, String> {
    s3rpc_verify_session_secure(params).await
}

pub async fn s3rpc_change_password_secure(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let old_hash = params["p_old_password_hash"].as_str().unwrap_or("");
    let new_hash = params["p_new_password_hash"].as_str().unwrap_or("");
    let Some(mut user) = get_user(&s, uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    if user["password_hash"].as_str().unwrap_or("") != old_hash {
        return Ok(json!({ "success": false, "message": "原密码错误" }));
    }
    user["password_hash"] = json!(new_hash);
    save_user(&s, uid, &user).await?;
    let username = user["username"].as_str().unwrap_or("");
    let token = create_session(&s, uid, username).await?;
    Ok(json!({ "success": true, "session_token": token }))
}

pub async fn s3rpc_change_password(params: Value) -> Result<Value, String> {
    s3rpc_change_password_secure(params).await
}

pub async fn s3rpc_delete_my_account(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let hash = params["p_password_hash"].as_str().unwrap_or("");
    let Some(user) = get_user(&s, uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    if user["password_hash"].as_str().unwrap_or("") != hash {
        return Ok(json!({ "success": false, "message": "密码错误" }));
    }
    let username = user["username"].as_str().unwrap_or("");
    // 删除用户资料与用户名索引
    s.delete_object(&user_key(uid)).await?;
    if !username.is_empty() {
        let _ = s.delete_object(&user_name_index(username)).await;
    }
    // 删除该用户的会话
    let sess_keys = s.list_objects("sessions/").await?;
    let mut to_delete = Vec::new();
    for meta in &sess_keys {
        if let Some(v) = json_get(&s, &meta.key).await? {
            if v["uid"].as_u64().unwrap_or(0) == uid {
                to_delete.push(meta.key.clone());
            }
        }
    }
    for k in to_delete {
        let _ = s.delete_object(&k).await;
    }
    // 删除相关私聊会话与消息
    let sessions = list_all_sessions(&s).await?;
    for sess in &sessions {
        let u1 = sess["user1_uid"].as_u64().unwrap_or(0);
        let u2 = sess["user2_uid"].as_u64().unwrap_or(0);
        if u1 == uid || u2 == uid {
            let sid = sess["id"].as_str().unwrap_or("");
            if let Ok(msgs) = s.list_objects(&format!("private/messages/{}/", sid)).await {
                for m in msgs {
                    let _ = s.delete_object(&m.key).await;
                }
            }
            let _ = s.delete_object(&priv_sess_key(sid)).await;
        }
    }
    Ok(json!({ "success": true }))
}

pub async fn s3rpc_record_login(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    if uid == 0 {
        return Ok(json!({ "success": true }));
    }
    if let Some(mut user) = get_user(&s, uid).await? {
        user["last_login_at"] = json!(now_iso());
        user["last_login_ip"] = json!(params["p_ip"].as_str().unwrap_or("unknown"));
        let _ = save_user(&s, uid, &user).await;
    }
    Ok(json!({ "success": true }))
}

// ==================== 公聊 ====================

pub async fn s3rpc_get_public_messages(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let limit = params["p_limit"].as_u64().unwrap_or(200).min(500) as usize;
    let before_id = params["p_before_id"].as_str().unwrap_or("").trim();
    let after_id = params["p_after_id"].as_str().unwrap_or("").trim();

    let metas = s.list_objects("public/messages/").await?;
    let mut ids: Vec<String> = metas
        .into_iter()
        .filter(|m| m.key.starts_with("public/messages/") && m.key.ends_with(".json"))
        .map(|m| m.key["public/messages/".len()..m.key.len() - 5].to_string())
        .collect();
    ids.sort(); // Key 字典序 ≈ 时间序（id 前缀为十六进制毫秒时间戳）

    let selected: Vec<String> = if !before_id.is_empty() {
        // 加载更早的消息：取 before_id 之前的最后 limit 条
        let mut v: Vec<String> = ids.iter().filter(|i| i.as_str() < before_id).cloned().collect();
        v.reverse();
        v.truncate(limit);
        v
    } else if !after_id.is_empty() {
        // 增量轮询：取 after_id 之后的最多 50 条
        let v: Vec<String> = ids.iter().filter(|i| i.as_str() > after_id).cloned().collect();
        v[..v.len().min(50)].to_vec()
    } else {
        // 最新 limit 条
        let mut v: Vec<String> = ids.into_iter().rev().take(limit).collect();
        v.reverse();
        v
    };

    let keys: Vec<String> = selected.iter().map(|id| pub_msg_key(id)).collect();
    let mut msgs = fetch_json_all(&s, &keys).await;
    sort_desc_by_created(&mut msgs);
    Ok(Value::Array(msgs))
}

pub async fn s3rpc_send_public_message_secure(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let user = get_user(&s, uid).await?.unwrap_or_else(|| json!({}));
    let username = user["username"].as_str().unwrap_or("");
    let msg = json!({
        "id": new_id(),
        "sender": username,
        "sender_uid": uid,
        "text": params["p_text"].as_str().unwrap_or(""),
        "image_url": params["p_image_url"].as_str().unwrap_or(""),
        "audio_url": params["p_audio_url"].as_str().unwrap_or(""),
        "audio_dur": params["p_audio_dur"].as_f64().unwrap_or(0.0),
        "reply_to_id": params["p_reply_to_id"].as_str().unwrap_or(""),
        "reply_content": params["p_reply_content"].as_str().unwrap_or(""),
        "is_system": params["p_is_system"].as_bool().unwrap_or(false),
        "sender_deleted": false,
        "created_at": now_iso()
    });
    json_put(&s, &pub_msg_key(msg["id"].as_str().unwrap()), &msg).await?;
    Ok(json!({ "success": true, "message": msg }))
}

pub async fn s3rpc_delete_public_message(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let msg_id = params["p_msg_id"].as_str().unwrap_or("");
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let key = pub_msg_key(msg_id);
    if let Some(msg) = json_get(&s, &key).await? {
        let owner = msg["sender_uid"].as_u64().unwrap_or(0);
        if owner != 0 {
            if owner != uid {
                return Ok(json!({ "success": false, "message": "只能删除自己的消息" }));
            }
        } else if msg["sender"].as_str().unwrap_or("") != "" {
            // 兼容旧消息（无 sender_uid）：按用户名比对
            let user = get_user(&s, uid).await?.unwrap_or_else(|| json!({}));
            if msg["sender"].as_str().unwrap_or("") != user["username"].as_str().unwrap_or("") {
                return Ok(json!({ "success": false, "message": "只能删除自己的消息" }));
            }
        }
    }
    s.delete_object(&key).await?;
    Ok(json!({ "success": true }))
}

// ==================== 私聊 ====================

async fn list_all_sessions(s3: &Arc<S3>) -> Result<Vec<Value>, String> {
    let metas = s3.list_objects("private/sessions/").await?;
    let keys: Vec<String> = metas
        .into_iter()
        .filter(|m| m.key.starts_with("private/sessions/") && m.key.ends_with(".json"))
        .map(|m| m.key)
        .collect();
    Ok(fetch_json_all(s3, &keys).await)
}

pub async fn s3rpc_get_private_sessions(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let sessions = list_all_sessions(&s).await?;
    let mut mine: Vec<Value> = sessions
        .into_iter()
        .filter(|v| {
            let u1 = v["user1_uid"].as_u64().unwrap_or(0);
            let u2 = v["user2_uid"].as_u64().unwrap_or(0);
            if u1 == uid {
                v["deleted_by_user1"].as_bool().unwrap_or(false) == false
            } else if u2 == uid {
                v["deleted_by_user2"].as_bool().unwrap_or(false) == false
            } else {
                false
            }
        })
        .collect();
    mine.sort_by(|a, b| {
        let ta = a["updated_at"].as_str().unwrap_or("");
        let tb = b["updated_at"].as_str().unwrap_or("");
        tb.cmp(ta)
    });
    Ok(Value::Array(mine))
}

pub async fn s3rpc_create_private_session(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let user1_uid = params["p_user1_uid"].as_u64().unwrap_or(0);
    let user2_uid = params["p_user2_uid"].as_u64().unwrap_or(0);
    if user1_uid == 0 || user2_uid == 0 {
        return err("缺少参数");
    }
    let sid = private_session_id(user1_uid, user2_uid);
    let key = priv_sess_key(&sid);
    let user1 = get_user(&s, user1_uid).await?.unwrap_or_else(|| json!({}));
    let user2 = get_user(&s, user2_uid).await?.unwrap_or_else(|| json!({}));
    let user1_name = user1["username"].as_str().unwrap_or("").to_string();
    let user2_name = user2["username"].as_str().unwrap_or("").to_string();
    match json_get(&s, &key).await? {
        Some(mut v) => {
            // 已有会话：解除双方删除标记并刷新时间
            v["deleted_by_user1"] = json!(false);
            v["deleted_by_user2"] = json!(false);
            v["updated_at"] = json!(now_iso());
            json_put(&s, &key, &v).await?;
        }
        None => {
            let v = json!({
                "id": sid,
                "user1_uid": user1_uid,
                "user2_uid": user2_uid,
                "user1": user1_name,
                "user2": user2_name,
                "updated_at": now_iso(),
                "last_message": "",
                "deleted_by_user1": false,
                "deleted_by_user2": false
            });
            json_put(&s, &key, &v).await?;
        }
    }
    Ok(json!({ "success": true, "session_id": sid }))
}

async fn session_accessible(s3: &Arc<S3>, sid: &str, uid: u64) -> Result<Option<Value>, String> {
    let Some(v) = json_get(s3, &priv_sess_key(sid)).await? else {
        return Ok(None);
    };
    let u1 = v["user1_uid"].as_u64().unwrap_or(0);
    let u2 = v["user2_uid"].as_u64().unwrap_or(0);
    if u1 != uid && u2 != uid {
        return Ok(None);
    }
    Ok(Some(v))
}

pub async fn s3rpc_get_private_messages(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let sid = params["p_session_id"].as_str().unwrap_or("");
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let limit = params["p_limit"].as_u64().unwrap_or(200).min(500) as usize;
    if session_accessible(&s, sid, uid).await?.is_none() {
        return Ok(json!({ "success": false, "message": "无权访问该会话" }));
    }
    let metas = s.list_objects(&format!("private/messages/{}/", sid)).await?;
    let mut ids: Vec<String> = metas
        .into_iter()
        .filter(|m| m.key.ends_with(".json"))
        .map(|m| {
            let prefix = format!("private/messages/{}/", sid);
            m.key[prefix.len()..m.key.len() - 5].to_string()
        })
        .collect();
    ids.sort();
    let take: Vec<String> = ids.into_iter().rev().take(limit).collect();
    let keys: Vec<String> = take.iter().map(|id| priv_msg_key(sid, id)).collect();
    let mut msgs = fetch_json_all(&s, &keys).await;
    sort_desc_by_created(&mut msgs);
    Ok(Value::Array(msgs))
}

pub async fn s3rpc_send_private_message(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let sid = params["p_session_id"].as_str().unwrap_or("");
    let sender_uid = params["p_sender_uid"].as_u64().unwrap_or(0);
    let content = params["p_content"].as_str().unwrap_or("");
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, sender_uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let Some(mut sess) = session_accessible(&s, sid, sender_uid).await? else {
        return Ok(json!({ "success": false, "message": "会话不存在或无权访问" }));
    };
    let user = get_user(&s, sender_uid).await?.unwrap_or_else(|| json!({}));
    let sender_name = user["username"].as_str().unwrap_or("");
    let msg = json!({
        "id": new_id(),
        "session_id": sid,
        "sender": sender_name,
        "sender_uid": sender_uid,
        "content": content,
        "sender_deleted": false,
        "created_at": now_iso()
    });
    json_put(&s, &priv_msg_key(sid, msg["id"].as_str().unwrap()), &msg).await?;
    sess["updated_at"] = json!(now_iso());
    sess["last_message"] = json!(content.chars().take(60).collect::<String>());
    json_put(&s, &priv_sess_key(sid), &sess).await?;
    Ok(json!({ "success": true, "message": msg }))
}

pub async fn s3rpc_mark_private_messages_read(_params: Value) -> Result<Value, String> {
    // 实时已读回执已随 Realtime 移除；保留命令避免前端报错
    Ok(json!({ "success": true }))
}

pub async fn s3rpc_delete_private_session(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let sid = params["p_session_id"].as_str().unwrap_or("");
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let Some(mut sess) = json_get(&s, &priv_sess_key(sid)).await? else {
        return Ok(json!({ "success": true }));
    };
    let u1 = sess["user1_uid"].as_u64().unwrap_or(0);
    let u2 = sess["user2_uid"].as_u64().unwrap_or(0);
    if u1 == uid {
        sess["deleted_by_user1"] = json!(true);
    } else if u2 == uid {
        sess["deleted_by_user2"] = json!(true);
    }
    json_put(&s, &priv_sess_key(sid), &sess).await?;
    Ok(json!({ "success": true }))
}

pub async fn s3rpc_delete_private_message(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let sid = params["p_session_id"].as_str().unwrap_or("");
    let msg_id = params["p_msg_id"].as_str().unwrap_or("");
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_session_token"].as_str().unwrap_or("");
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let key = priv_msg_key(sid, msg_id);
    if let Some(msg) = json_get(&s, &key).await? {
        let owner = msg["sender_uid"].as_u64().unwrap_or(0);
        if owner != 0 {
            if owner != uid {
                return Ok(json!({ "success": false, "message": "只能删除自己的消息" }));
            }
        } else {
            // 兼容旧消息：按用户名比对
            let user = get_user(&s, uid).await?.unwrap_or_else(|| json!({}));
            if msg["sender"].as_str().unwrap_or("") != user["username"].as_str().unwrap_or("") {
                return Ok(json!({ "success": false, "message": "只能删除自己的消息" }));
            }
        }
    }
    s.delete_object(&key).await?;
    Ok(json!({ "success": true }))
}

// ==================== 用户资料 ====================

pub async fn s3rpc_get_user_profile(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let username = params["p_username"].as_str().unwrap_or("");
    if uid == 0 && username.is_empty() {
        return Ok(json!({ "success": false, "message": "缺少用户标识" }));
    }
    let user = if uid != 0 {
        get_user(&s, uid).await?
    } else {
        get_user_by_name(&s, username).await?
    };
    match user {
        Some(v) => Ok(user_public_fields(&v)),
        None => Ok(json!({ "success": false, "message": "用户不存在" })),
    }
}

pub async fn s3rpc_update_avatar(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let avatar_url = params["p_avatar_url"].as_str().unwrap_or("");
    if let Some(mut user) = get_user(&s, uid).await? {
        user["avatar_url"] = json!(avatar_url);
        save_user(&s, uid, &user).await?;
    }
    Ok(json!({ "success": true }))
}

pub async fn s3rpc_upsert_user_profile(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let Some(mut user) = get_user(&s, uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    for (field, key) in [
        ("p_email", "email"),
        ("p_birthday", "birthday"),
        ("p_bio", "bio"),
        ("p_bg_url", "bg_url"),
    ] {
        if let Some(v) = params[field].as_str() {
            user[key] = json!(v);
        }
    }
    if let Some(tags) = params["p_tags"].as_array() {
        user["tags"] = Value::Array(tags.clone());
    }
    save_user(&s, uid, &user).await?;
    Ok(json!({ "success": true }))
}

/// 昵称（用户名）每日可修改次数上限
const MAX_USERNAME_RENAMES_PER_DAY: u64 = 5;

/// 修改昵称（用户名）——用户文件 renames 字段记录 {date, count} 实现每日限次；
/// 主键为 users/<uid>.json，私聊会话 id 基于 uid，改名只需重建 users/by_name/ 反向索引。
pub async fn s3rpc_update_username(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let new_name = params["p_new_username"].as_str().unwrap_or("").trim().to_string();
    if uid == 0 {
        return err("缺少用户标识");
    }
    if new_name.is_empty() || !valid_username(&new_name) {
        return Ok(json!({ "success": false, "message": "昵称不合法（2-15 个字符，不含特殊字符）" }));
    }
    let Some(mut user) = get_user(&s, uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    let old_name = user["username"].as_str().unwrap_or("").to_string();
    if old_name == new_name {
        return Ok(json!({ "success": false, "message": "昵称未变化" }));
    }
    // 新昵称不得被其他用户占用
    if let Some(owner) = uid_by_name(&s, &new_name).await? {
        if owner != uid {
            return Ok(json!({ "success": false, "message": "该昵称已被使用" }));
        }
    }
    // 每日修改次数限制
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let mut rename_count: u64 = 0;
    if let Some(r) = user["renames"].as_object() {
        if r.get("date").and_then(|v| v.as_str()) == Some(today.as_str()) {
            rename_count = r.get("count").and_then(|v| v.as_u64()).unwrap_or(0);
        }
    }
    if rename_count >= MAX_USERNAME_RENAMES_PER_DAY {
        return Ok(json!({ "success": false, "message": "今日昵称修改次数已达上限（每天 5 次）" }));
    }
    // 执行改名：更新用户文件 + 重建反向索引
    user["username"] = json!(new_name);
    user["renames"] = json!({ "date": today, "count": rename_count + 1 });
    save_user(&s, uid, &user).await?;
    if !old_name.is_empty() {
        let _ = s.delete_object(&user_name_index(&old_name)).await;
    }
    json_put(&s, &user_name_index(&new_name), &json!({ "uid": uid })).await?;
    Ok(json!({
        "success": true,
        "username": new_name,
        "renames_left": MAX_USERNAME_RENAMES_PER_DAY.saturating_sub(rename_count + 1)
    }))
}

/// 云端设置单条上限（客户端打包为单个加密 JSON，远小于该值）
const MAX_CLOUD_SETTINGS_BYTES: usize = 16 * 1024;

/// 读取云端用户设置（cloud_settings 字段）。
/// 内容由客户端用「密码派生密钥」AES-GCM 加密，服务端只见密文，无法解读。
/// 需验权：仅登录会话所有者可读取自己的设置。
pub async fn s3rpc_get_user_settings(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_token"].as_str().or_else(|| params["p_session_token"].as_str()).unwrap_or("");
    if uid == 0 {
        return Ok(json!({ "success": false, "message": "缺少用户标识" }));
    }
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let user = get_user(&s, uid).await?.unwrap_or_else(|| json!({}));
    let cs = user["cloud_settings"].clone();
    if cs.is_null() {
        return Ok(json!({ "success": true, "settings": Value::Null }));
    }
    Ok(json!({ "success": true, "settings": cs }))
}

/// 覆盖写入云端用户设置（cloud_settings 字段，整体替换，云端为权威）。
/// 内容为客户端加密密文，服务端仅做大小与结构校验。
pub async fn s3rpc_update_user_settings(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let token = params["p_token"].as_str().or_else(|| params["p_session_token"].as_str()).unwrap_or("");
    if uid == 0 {
        return Ok(json!({ "success": false, "message": "缺少用户标识" }));
    }
    if !verify_session(&s, uid, token).await? {
        return Ok(json!({ "success": false, "message": "请重新登录" }));
    }
    let settings = &params["p_settings"];
    if !settings.is_object() {
        return Ok(json!({ "success": false, "message": "缺少设置数据" }));
    }
    let serialized = serde_json::to_string(settings).map_err(|e| format!("设置序列化失败: {}", e))?;
    if serialized.len() > MAX_CLOUD_SETTINGS_BYTES {
        return Ok(json!({ "success": false, "message": "设置数据过大" }));
    }
    let Some(mut user) = get_user(&s, uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    user["cloud_settings"] = settings.clone();
    save_user(&s, uid, &user).await?;
    Ok(json!({ "success": true, "updated_at": now_iso() }))
}

pub async fn s3rpc_search_users(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let query = params["p_query"].as_str().unwrap_or("").trim().to_lowercase();
    let limit = params["p_limit"].as_u64().unwrap_or(20).min(50) as usize;
    if query.is_empty() {
        return Ok(Value::Array(vec![]));
    }
    let metas = s.list_objects("users/").await?;
    let keys: Vec<String> = metas
        .into_iter()
        .filter(|m| {
            // 只取 users/<uid>.json（排除 by_name/ 索引与 _meta 计数器）
            m.key.starts_with("users/") && m.key.ends_with(".json") && !m.key.starts_with("users/by_name/")
        })
        .take(500)
        .map(|m| m.key)
        .collect();
    let users = fetch_json_all(&s, &keys).await;
    let mut matched: Vec<Value> = users
        .into_iter()
        .filter(|v| {
            let name = v["username"].as_str().unwrap_or("");
            name.to_lowercase().contains(&query) || {
                // 也匹配编码后的用户名（中文等）
                enc(name).to_lowercase().contains(&query) || enc(name).to_lowercase().contains(&query.replace(" ", ""))
            }
        })
        .map(|v| {
            json!({
                "uid": v["uid"].as_u64().unwrap_or(0),
                "username": v["username"].as_str().unwrap_or(""),
                "avatar_url": v["avatar_url"].as_str().unwrap_or("")
            })
        })
        .take(limit)
        .collect();
    matched.sort_by(|a, b| a["username"].as_str().unwrap_or("").cmp(b["username"].as_str().unwrap_or("")));
    Ok(Value::Array(matched))
}

pub async fn s3rpc_toggle_block_user(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let blocker_uid = params["p_blocker_uid"].as_u64().unwrap_or(0);
    let blocked_uid = params["p_blocked_uid"].as_u64().unwrap_or(0);
    let block = params["p_block"].as_bool().unwrap_or(false);
    let Some(mut user) = get_user(&s, blocker_uid).await? else {
        return Ok(json!({ "success": false, "message": "用户不存在" }));
    };
    let mut list: Vec<u64> = user["blocked"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_u64())
                .collect()
        })
        .unwrap_or_default();
    if block {
        if !list.contains(&blocked_uid) {
            list.push(blocked_uid);
        }
    } else {
        list.retain(|x| *x != blocked_uid);
    }
    user["blocked"] = Value::Array(list.into_iter().map(|x| json!(x)).collect());
    save_user(&s, blocker_uid, &user).await?;
    Ok(json!({ "success": true }))
}

pub async fn s3rpc_get_blocked_users(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let uid = params["p_uid"].as_u64().unwrap_or(0);
    let user = get_user(&s, uid).await?.unwrap_or_else(|| json!({}));
    let blocked_ids: Vec<u64> = user["blocked"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_u64()).collect())
        .unwrap_or_default();
    let mut list: Vec<Value> = Vec::with_capacity(blocked_ids.len());
    for blocked_uid in blocked_ids {
        let name = get_user(&s, blocked_uid)
            .await?
            .map(|u| u["username"].as_str().unwrap_or("").to_string())
            .unwrap_or_default();
        list.push(json!({ "blocked": blocked_uid, "username": name }));
    }
    Ok(Value::Array(list))
}

pub async fn s3rpc_check_blocked(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let blocker_uid = params["p_blocker_uid"].as_u64().unwrap_or(0);
    let target_uid = params["p_target_uid"].as_u64().unwrap_or(0);
    let user = get_user(&s, blocker_uid).await?.unwrap_or_else(|| json!({}));
    let blocked = user["blocked"]
        .as_array()
        .map(|a| a.iter().any(|v| v.as_u64() == Some(target_uid)))
        .unwrap_or(false);
    Ok(json!(blocked))
}

// ==================== 媒体 ====================

/// 校验媒体 Key 合法且位于 media/ 前缀下
fn media_key_of(params: &Value) -> Result<String, String> {
    let raw = params["p_key"].as_str().unwrap_or("");
    if raw.is_empty() {
        return Err("缺少文件路径".to_string());
    }
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '%' | '@') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let key = if cleaned.starts_with("media/") {
        cleaned
    } else {
        format!("media/{}", cleaned)
    };
    if key.len() > 512 {
        return Err("文件路径过长".to_string());
    }
    Ok(key)
}

/// 媒体上传大小限制（按用途前缀，单位字节）——服务端权威校验，
/// 即使绕过前端直接调 RPC，超大文件也会在上传前被拦截，防止刷流量/占存储
fn media_upload_limit(key: &str) -> usize {
    const MB: usize = 1024 * 1024;
    // media_key_of 会补 media/ 前缀，这里去掉前缀再按用途判断
    let k = key.strip_prefix("media/").unwrap_or(key);
    if k.starts_with("avatars/") {
        5 * MB // 头像：前端裁剪压缩后通常 100-200KB
    } else if k.starts_with("background/") {
        8 * MB // 背景图
    } else if k.starts_with("chat/") {
        8 * MB // 公聊图片
    } else if k.starts_with("public/") || k.starts_with("private/") {
        32 * MB // 公/私聊文件（含语音）
    } else {
        8 * MB // 未知用途保守限制
    }
}

pub async fn s3rpc_upload_media(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let key = media_key_of(&params)?;
    let b64 = params["p_base64"].as_str().unwrap_or("");
    let content_type = params["p_content_type"].as_str().unwrap_or("application/octet-stream");
    let bytes = S3::decode_base64(b64)?;
    if bytes.is_empty() {
        return err("文件内容为空");
    }
    // 按用途前缀限制大小（服务端强制，前端校验仅作首道防线）
    let limit = media_upload_limit(&key);
    if bytes.len() > limit {
        return Err(format!("文件超过 {}MB 限制", limit / (1024 * 1024)));
    }
    // 头像/背景/聊天图片用途仅允许图片类型
    let k = key.strip_prefix("media/").unwrap_or(&key);
    if (k.starts_with("avatars/") || k.starts_with("background/") || k.starts_with("chat/"))
        && !content_type.starts_with("image/")
    {
        return err("该用途仅允许上传图片");
    }
    s.put_object(&key, bytes, content_type).await?;
    let url = s.public_url(&key);
    Ok(json!({ "success": true, "key": key, "url": url }))
}

pub async fn s3rpc_get_media_url(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let key = params["p_key"].as_str().unwrap_or("");
    if key.is_empty() {
        return err("缺少文件路径");
    }
    Ok(json!({ "success": true, "url": s.presign_get(key, 3600) }))
}

pub async fn s3rpc_list_media(params: Value) -> Result<Value, String> {
    let s = s3()?;
    let prefix = params["p_prefix"].as_str().unwrap_or("media/");
    let metas: Vec<ObjectMeta> = s.list_objects(prefix).await?;
    let list: Vec<Value> = metas
        .into_iter()
        .map(|m| {
            let name = m.key.rsplit('/').next().unwrap_or("").to_string();
            let created = chrono::DateTime::parse_from_rfc3339(&m.last_modified)
                .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
                .unwrap_or_else(|_| m.last_modified.clone());
            json!({
                "key": m.key,
                "name": name,
                "size": m.size,
                "created_at": created,
                "url": s.public_url(&m.key)
            })
        })
        .collect();
    Ok(Value::Array(list))
}

// ==================== 智能体（暂未迁移，返回空/禁用） ====================

pub async fn s3rpc_get_agents(params: Value) -> Result<Value, String> {
    let _ = params;
    Ok(Value::Array(vec![]))
}

pub async fn s3rpc_save_agent(params: Value) -> Result<Value, String> {
    let _ = params;
    Ok(json!({ "success": false, "message": "智能体功能暂未开放" }))
}

pub async fn s3rpc_delete_agent_rpc(params: Value) -> Result<Value, String> {
    let _ = params;
    Ok(json!({ "success": false, "message": "智能体功能暂未开放" }))
}

pub async fn s3rpc_call_agent_llm_rate_limited(params: Value) -> Result<Value, String> {
    let _ = params;
    Ok(json!({ "success": false, "message": "智能体功能暂未开放" }))
}

pub async fn s3rpc_send_agent_message(params: Value) -> Result<Value, String> {
    let _ = params;
    Ok(json!({ "success": false, "message": "智能体功能暂未开放" }))
}

// ==================== 云控（暂未迁移，返回默认配置） ====================

pub async fn s3rpc_get_cloud_control(params: Value) -> Result<Value, String> {
    let _ = params;
    Ok(json!({
        "success": true,
        "banner_enabled": false,
        "banner_title": "",
        "banner_message": "",
        "banner_show_close": true,
        "login_blocked": false,
        "force_logout_all": false,
        "force_logout_except": ""
    }))
}

/// 是否已配置 S3（供 s3_status 命令使用）
pub fn config_summary() -> Option<S3Config> {
    let lock = CFG.get_or_init(|| Mutex::new(None));
    lock.lock().ok().and_then(|g| g.as_ref().map(|s| s.cfg.clone()))
}

/// 统一 RPC 分发命令：前端 s3.js 通过 invoke('s3rpc_call', { name, params }) 调用。
/// 相比为每个 s3rpc_* 单独注册 #[tauri::command]，单个分发命令更易维护且行为一致。
#[tauri::command]
pub async fn s3rpc_call(name: String, params: Value) -> Result<Value, String> {
    match name.as_str() {
        // ==== 认证 ====
        "check_username_exists" => s3rpc_check_username_exists(params).await,
        "register_user_secure" => s3rpc_register_user_secure(params).await,
        "register_user" => s3rpc_register_user(params).await,
        "verify_login_secure_rate_limited" => s3rpc_verify_login_secure_rate_limited(params).await,
        "verify_login_secure" => s3rpc_verify_login_secure(params).await,
        "verify_login" => s3rpc_verify_login(params).await,
        "verify_session_secure" => s3rpc_verify_session_secure(params).await,
        "verify_session" => s3rpc_verify_session(params).await,
        "change_password_secure" => s3rpc_change_password_secure(params).await,
        "change_password" => s3rpc_change_password(params).await,
        "delete_my_account" => s3rpc_delete_my_account(params).await,
        "record_login" => s3rpc_record_login(params).await,
        // ==== 公聊 ====
        "get_public_messages" => s3rpc_get_public_messages(params).await,
        "send_public_message_secure" => s3rpc_send_public_message_secure(params).await,
        "delete_public_message" => s3rpc_delete_public_message(params).await,
        // ==== 私聊 ====
        "get_private_sessions" => s3rpc_get_private_sessions(params).await,
        "create_private_session" => s3rpc_create_private_session(params).await,
        "get_private_messages" => s3rpc_get_private_messages(params).await,
        "send_private_message" => s3rpc_send_private_message(params).await,
        "mark_private_messages_read" => s3rpc_mark_private_messages_read(params).await,
        "delete_private_session" => s3rpc_delete_private_session(params).await,
        "delete_private_message" => s3rpc_delete_private_message(params).await,
        // ==== 用户资料 ====
        "get_user_profile" => s3rpc_get_user_profile(params).await,
        "update_avatar" => s3rpc_update_avatar(params).await,
        "update_username" => s3rpc_update_username(params).await,
        "upsert_user_profile" => s3rpc_upsert_user_profile(params).await,
        // ==== 云设置同步 ====
        "get_user_settings" => s3rpc_get_user_settings(params).await,
        "update_user_settings" => s3rpc_update_user_settings(params).await,
        "search_users" => s3rpc_search_users(params).await,
        "toggle_block_user" => s3rpc_toggle_block_user(params).await,
        "get_blocked_users" => s3rpc_get_blocked_users(params).await,
        "check_blocked" => s3rpc_check_blocked(params).await,
        // ==== 媒体 ====
        "upload_media" => s3rpc_upload_media(params).await,
        "get_media_url" => s3rpc_get_media_url(params).await,
        "list_media" => s3rpc_list_media(params).await,
        // ==== 智能体（预留） ====
        "get_agents" => s3rpc_get_agents(params).await,
        "save_agent" => s3rpc_save_agent(params).await,
        "delete_agent_rpc" => s3rpc_delete_agent_rpc(params).await,
        "call_agent_llm_rate_limited" => s3rpc_call_agent_llm_rate_limited(params).await,
        "send_agent_message" => s3rpc_send_agent_message(params).await,
        // ==== 云控（预留） ====
        "get_cloud_control" => s3rpc_get_cloud_control(params).await,
        other => Err(format!("未知 RPC: {}", other)),
    }
}
