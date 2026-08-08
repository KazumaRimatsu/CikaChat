//! 雨云存储桶（AWS S3 兼容 API）客户端。
//! 实现 AWS Signature V4（SigV4）请求签名，以及底层对象操作
//! （PUT/GET/DELETE/LIST），供 s3rpc 业务命令层使用。
//!
//! 存储桶只用一个，数据通过对象 Key 前缀（等价于"文件夹"）区分：
//!   users/<uid>.json          用户资料（uid 从 1 递增，类似 QQ 号，是用户主键）
//!   users/by_name/<name>.json 用户名 → uid 反向索引
//!   users/_meta.json          uid 计数器
//!   sessions/                 登录会话
//!   public/messages/          公聊消息（每条消息一个对象）
//!   private/sessions/         私聊会话元数据
//!   private/messages/<sid>/   私聊消息
//!   media/                    图片/语音/文件/头像等媒体
//!   agents/                   智能体配置（预留）
//!   config/                   云控等全局配置（预留）

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::Utc;
use hmac::{Hmac, Mac};
use regex::Regex;
use reqwest::Method;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

const ALGORITHM: &str = "AWS4-HMAC-SHA256";
const PAYLOAD_UNSIGNED: &str = "UNSIGNED-PAYLOAD";
const SERVICE: &str = "s3";

/// S3 连接配置（凭证只存在于 Rust 侧，绝不进入前端）
#[derive(Clone, Debug)]
pub struct S3Config {
    /// 雨云 S3 兼容 endpoint，例如 https://oss.rainyun.com
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    /// true 用 path 风格（{endpoint}/{bucket}/{key}），false 用虚拟主机风格（{bucket}.{endpoint}/{key}）
    pub path_style: bool,
    /// 媒体文件的公网访问前缀（如 https://xxx.oss.rainyun.com/cikachat）
    /// 存储桶开启公共读后，媒体 URL 直接拼接此前缀即可访问
    pub public_base: String,
}

pub struct S3 {
    pub cfg: S3Config,
    client: reqwest::Client,
}

impl S3 {
    pub fn new(cfg: S3Config) -> Self {
        S3 {
            cfg,
            client: reqwest::Client::new(),
        }
    }

    // ==================== SigV4 签名基础 ====================

    fn sha256_hex(data: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(data);
        hex::encode(h.finalize())
    }

    fn hmac_sha256(key: &[u8], data: &str) -> Vec<u8> {
        let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("hmac key");
        mac.update(data.as_bytes());
        mac.finalize().into_bytes().to_vec()
    }

    fn signing_key(secret: &str, date: &str, region: &str) -> Vec<u8> {
        let k_date = Self::hmac_sha256(format!("AWS4{}", secret).as_bytes(), date);
        let k_region = Self::hmac_sha256(&k_date, region);
        let k_service = Self::hmac_sha256(&k_region, SERVICE);
        Self::hmac_sha256(&k_service, "aws4_request")
    }

    /// AWS SigV4 UriEncode：除未保留字符（A-Za-z0-9-._~）外，其余字节全部百分号编码。
    /// 查询串的键值必须按此规则编码（例如 X-Amz-Credential 作用域中的 `/` → `%2F`）。
    fn sigv4_encode(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        for b in s.bytes() {
            if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
                out.push(b as char);
            } else {
                out.push_str(&format!("%{:02X}", b));
            }
        }
        out
    }

    /// 对象所在 URL（路径风格：{endpoint}/{bucket}/{key}）
    fn object_url(&self, key: &str) -> String {
        if self.cfg.path_style {
            format!("{}/{}/{}", self.cfg.endpoint.trim_end_matches('/'), self.cfg.bucket, key)
        } else {
            let ep = self.cfg.endpoint.trim_end_matches('/');
            match reqwest::Url::parse(ep) {
                Ok(mut u) => {
                    if let Some(host) = u.host_str() {
                        let _ = u.set_host(Some(&format!("{}.{}", self.cfg.bucket, host)));
                    }
                    format!("{}/{}", u, key)
                }
                Err(_) => format!("{}/{}/{}", ep, self.cfg.bucket, key),
            }
        }
    }

    /// 签名用规范化 URI：与实际发出的请求路径保持一致（Key 已由调用方预编码，
    /// 因此直接嵌入，不能再次转义 `%`，否则含 `%` 的 Key（如中文用户名索引）会签名不匹配）。
    fn canonical_uri(&self, key: &str) -> String {
        if self.cfg.path_style {
            format!("/{}/{}", self.cfg.bucket, key)
        } else {
            format!("/{}", key)
        }
    }

    /// 执行一次带 SigV4 签名的请求，返回 (HTTP 状态码, 响应体)
    async fn send(
        &self,
        method: Method,
        key: &str,
        query: &[(String, String)],
        body: Option<&[u8]>,
        extra_headers: &[(&str, &str)],
    ) -> Result<(u16, Vec<u8>), String> {
        let url = self.object_url(key);
        let mut parsed = reqwest::Url::parse(&url).map_err(|e| format!("URL 解析失败: {e}"))?;
        let host = parsed
            .host_str()
            .ok_or_else(|| "endpoint 缺少主机名".to_string())?
            .to_string();

        let amz_date = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let date = amz_date[..8].to_string();

        let payload_hash = match body {
            Some(b) => Self::sha256_hex(b),
            None => Self::sha256_hex(b""),
        };

        // 规范化请求头（小写键，排序后拼接）
        let mut headers: BTreeMap<String, String> = BTreeMap::new();
        headers.insert("host".into(), host.clone());
        headers.insert("x-amz-content-sha256".into(), payload_hash.clone());
        headers.insert("x-amz-date".into(), amz_date.clone());
        for (k, v) in extra_headers {
            headers.insert(k.to_ascii_lowercase(), v.to_string());
        }

        // 规范化查询串（排序 + AWS SigV4 UriEncode）
        let mut qmap: BTreeMap<String, String> = BTreeMap::new();
        for (k, v) in query {
            qmap.insert(k.clone(), v.clone());
        }
        let canonical_query = qmap
            .iter()
            .map(|(k, v)| format!("{}={}", Self::sigv4_encode(k), Self::sigv4_encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let canonical_headers = headers
            .iter()
            .map(|(k, v)| format!("{}:{}\n", k, v))
            .collect::<String>();
        let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";");

        let canonical_request = format!(
            "{}\n{}\n{}\n{}\n{}\n{}",
            method.as_str(),
            self.canonical_uri(key),
            canonical_query,
            canonical_headers,
            signed_headers,
            payload_hash
        );

        let scope = format!("{}/{}/{}/aws4_request", date, self.cfg.region, SERVICE);
        let string_to_sign = format!(
            "{}\n{}\n{}\n{}",
            ALGORITHM,
            amz_date,
            scope,
            Self::sha256_hex(canonical_request.as_bytes())
        );

        let signing_key = Self::signing_key(&self.cfg.secret_key, &date, &self.cfg.region);
        let signature = hex::encode(Self::hmac_sha256(&signing_key, &string_to_sign));

        let authorization = format!(
            "{} Credential={}/{}, SignedHeaders={}, Signature={}",
            ALGORITHM, self.cfg.access_key, scope, signed_headers, signature
        );

        // 关键：必须把查询串原样附加到实际请求 URL 上（与签名所用完全一致），
        // 否则服务端按无查询串校验签名会报 SignatureDoesNotMatch。
        if !query.is_empty() {
            parsed.set_query(Some(&canonical_query));
        }

        let mut req = self.client.request(method, parsed);
        for (k, v) in &headers {
            req = req.header(k, v);
        }
        req = req.header("Authorization", &authorization);
        if let Some(b) = body {
            req = req.body(b.to_vec());
        }

        let resp = req.send().await.map_err(|e| format!("S3 请求失败: {e}"))?;
        let status = resp.status().as_u16();
        let bytes = resp.bytes().await.map_err(|e| format!("读取 S3 响应失败: {e}"))?.to_vec();
        Ok((status, bytes))
    }

    // ==================== 底层对象操作 ====================

    /// PUT 对象（自动带签名），成功返回 Ok(())
    pub async fn put_object(&self, key: &str, body: Vec<u8>, content_type: &str) -> Result<(), String> {
        let (status, resp) = self
            .send(Method::PUT, key, &[], Some(&body), &[("content-type", content_type)])
            .await?;
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(format!("PUT {} 失败: HTTP {} {}", key, status, String::from_utf8_lossy(&resp)))
        }
    }

    /// GET 对象；404 返回 Ok(None)
    pub async fn get_object(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        let (status, body) = self.send(Method::GET, key, &[], None, &[]).await?;
        match status {
            200 => Ok(Some(body)),
            404 => Ok(None),
            _ => Err(format!("GET {} 失败: HTTP {} {}", key, status, String::from_utf8_lossy(&body))),
        }
    }

    /// DELETE 对象；404 视为成功（幂等）
    pub async fn delete_object(&self, key: &str) -> Result<(), String> {
        let (status, resp) = self.send(Method::DELETE, key, &[], None, &[]).await?;
        if status == 404 || (200..300).contains(&status) {
            Ok(())
        } else {
            Err(format!("DELETE {} 失败: HTTP {} {}", key, status, String::from_utf8_lossy(&resp)))
        }
    }

    /// 列出某前缀下的全部对象 Key（自动翻页，含 <Size>/<LastModified> 元数据）
    pub async fn list_objects(&self, prefix: &str) -> Result<Vec<ObjectMeta>, String> {
        let mut out = Vec::new();
        let mut token: Option<String> = None;
        let key_re = Regex::new(r"<Key>([^<]+)</Key>").unwrap();
        let size_re = Regex::new(r"<Size>(\d+)</Size>").unwrap();
        let lm_re = Regex::new(r"<LastModified>([^<]+)</LastModified>").unwrap();
        let token_re = Regex::new(r"<NextContinuationToken>([^<]+)</NextContinuationToken>").unwrap();
        let truncated_re = Regex::new(r"<IsTruncated>true</IsTruncated>").unwrap();

        loop {
            let mut query = vec![
                ("list-type".to_string(), "2".to_string()),
                ("prefix".to_string(), prefix.to_string()),
            ];
            if let Some(t) = &token {
                query.push(("continuation-token".to_string(), t.clone()));
            }
            let (status, body) = self.send(Method::GET, "", &query, None, &[]).await?;
            if status != 200 {
                return Err(format!("list_objects({prefix}) 失败: HTTP {status} {}", String::from_utf8_lossy(&body)));
            }
            let xml = String::from_utf8_lossy(&body);
            let keys: Vec<String> = key_re.captures_iter(&xml).map(|c| c[1].to_string()).collect();
            let sizes: Vec<String> = size_re.captures_iter(&xml).map(|c| c[1].to_string()).collect();
            let lms: Vec<String> = lm_re.captures_iter(&xml).map(|c| c[1].to_string()).collect();
            for i in 0..keys.len() {
                out.push(ObjectMeta {
                    key: keys[i].clone(),
                    size: sizes.get(i).and_then(|s| s.parse().ok()).unwrap_or(0),
                    last_modified: lms.get(i).cloned().unwrap_or_default(),
                });
            }
            if !truncated_re.is_match(&xml) {
                break;
            }
            match token_re.captures(&xml) {
                Some(c) => token = Some(c[1].to_string()),
                None => break,
            }
            if out.len() > 20000 {
                break; // 安全上限，防止失控循环
            }
        }
        Ok(out)
    }

    /// 生成预签名 GET URL（私有桶场景下前端直接访问媒体）
    pub fn presign_get(&self, key: &str, expires_secs: i64) -> String {
        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date = amz_date[..8].to_string();
        let scope = format!("{}/{}/{}/aws4_request", date, self.cfg.region, SERVICE);

        let base_url = if self.cfg.path_style {
            format!("{}/{}/{}", self.cfg.endpoint.trim_end_matches('/'), self.cfg.bucket, key)
        } else {
            self.object_url(key)
        };
        let host = match reqwest::Url::parse(&base_url) {
            Ok(u) => u.host_str().unwrap_or("").to_string(),
            Err(_) => String::new(),
        };

        let mut qmap: BTreeMap<String, String> = BTreeMap::new();
        qmap.insert("X-Amz-Algorithm".into(), ALGORITHM.into());
        qmap.insert("X-Amz-Credential".into(), format!("{}/{}", self.cfg.access_key, scope));
        qmap.insert("X-Amz-Date".into(), amz_date.clone());
        qmap.insert("X-Amz-Expires".into(), expires_secs.to_string());
        qmap.insert("X-Amz-SignedHeaders".into(), "host".into());
        let canonical_query = qmap
            .iter()
            .map(|(k, v)| format!("{}={}", Self::sigv4_encode(k), Self::sigv4_encode(v)))
            .collect::<Vec<_>>()
            .join("&");

        let canonical_request = format!(
            "GET\n{}\n{}\nhost:{}\n\nhost\n{}",
            self.canonical_uri(key),
            canonical_query,
            host,
            PAYLOAD_UNSIGNED
        );
        let string_to_sign = format!(
            "{}\n{}\n{}\n{}",
            ALGORITHM,
            amz_date,
            scope,
            Self::sha256_hex(canonical_request.as_bytes())
        );
        let signing_key = Self::signing_key(&self.cfg.secret_key, &date, &self.cfg.region);
        let signature = hex::encode(Self::hmac_sha256(&signing_key, &string_to_sign));

        format!("{}?{}&X-Amz-Signature={}", base_url, canonical_query, signature)
    }

    /// 媒体公开 URL（存储桶开启公共读时使用）
    /// 私有桶场景返回预签名 URL：有效期 7 天（AWS 预签名上限），减少媒体/头像因过期而无法显示。
    pub fn public_url(&self, key: &str) -> String {
        if !self.cfg.public_base.is_empty() {
            format!("{}/{}", self.cfg.public_base.trim_end_matches('/'), key)
        } else {
            self.presign_get(key, 604800)
        }
    }

    /// base64 解码（供上传媒体使用）
    pub fn decode_base64(b64: &str) -> Result<Vec<u8>, String> {
        BASE64
            .decode(b64.trim())
            .map_err(|e| format!("base64 解码失败: {e}"))
    }
}

#[derive(Clone, Debug)]
pub struct ObjectMeta {
    pub key: String,
    pub size: i64,
    pub last_modified: String,
}
