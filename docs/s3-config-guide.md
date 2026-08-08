# CikaChat 服务端存储桶配置指南

CikaChat 已弃用 Supabase 数据库，改为使用兼容 AWS S3 API的存储桶作为唯一数据后端。
全部业务数据（用户、会话、消息、媒体、智能体、云控配置）均存放在**同一个存储桶**中，通过对象 Key 前缀区分。

> 核心约定：**服务端只有一个存储桶**，任何数据都写入这个桶。

***

## 1. 架构说明

```
┌─────────────────────────────────────────────────────┐
│ 前端（Tauri WebView）                                │
│   src/js/s3.js  →  window.s3.rpc(name, params)      │
│         │  Tauri invoke                             │
│         ▼                                           │
│  Tauri 后端（src-tauri/src/s3rpc.rs）               │
│   统一分发命令 s3rpc_call + 业务命令层                │
│         │  AWS Signature V4（HMAC-SHA256 签名）      │
│         ▼                                           │
│  src-tauri/src/s3.rs（S3 客户端）                    │
│   PUT / GET / DELETE / LIST / 预签名 URL            │
│         │                                           │
│         ▼                                           │
│  雨云对象存储（AWS S3 兼容 API）【唯一存储桶】        │
└─────────────────────────────────────────────────────┘
```

- 凭证（AccessKey / SecretKey）**只保存在 Tauri Rust 侧**，前端拿不到明文凭证。
- 前端所有数据操作统一走 `s3.rpc('rpc_name', params)`，返回 `{ data, error }`。
- 无实时通道：公聊/私聊新消息通过**轮询**（`get_public_messages` / `get_private_sessions`）拉取；在线人数功能已移除。

***

## 2. 存储桶目录结构

S3 没有真正的"文件夹"，前缀 `xxx/` 即视为目录。CikaChat 约定如下（应用运行时自动创建，**无需手动建目录**）：

```
cikachat（存储桶名，可在雨云控制台自由命名）
├── users/                    用户资料（用户名 → 密码哈希、邮箱、简介、封禁状态等）
│     └── <用户名>.json
├── sessions/                 登录会话（会话 Token → 用户名）
│     └── <token>.json
├── public/                   公聊数据
│     └── messages/           公聊消息（按时间序 id 命名）
│           └── <毫秒时间戳十六进制>.json
├── private/                  私聊数据
│     ├── sessions/           私聊会话索引（两个用户名确定 id）
│     │     └── <session_id>.json
│     └── messages/           私聊消息
│           └── <session_id>/<毫秒时间戳十六进制>.json
├── media/                    所有媒体文件（图片 / 语音 / 文件 / 头像 / 背景）
│     ├── public/             公聊附件与语音
│     ├── private/            私聊附件与语音
│     ├── avatars/            用户头像
│     └── background/         个人主页背景
├── agents/                   智能体配置（预留，当前未开放）
└── config/                   云控等全局配置（预留）
      └── cloud_control.json
```

说明：

- 对象 Key 使用 **十六进制毫秒时间戳前缀**，S3 按字典序返回对象，天然即"按时间排序"，配合 `p_before_id` / `p_after_id` 实现翻页。
- 私聊会话 id 由两个用户名（URL 编码后按字典序拼接）确定性生成，双方计算出相同 id，无需单独分配。
- 密码不落明文：前端 SHA-256 预哈希 → 服务端存储哈希值（登录时比对哈希）。
- 上传的媒体统一落到 `media/` 前缀下（Rust 侧 `media_key_of` 强制归一化），群文件页枚举 `media/` 前缀（自动过滤 `media/private/`）。

***

## 3. 在雨云创建存储桶

1. 登录 [雨云控制台](https://www.rainyun.com/) → 进入「对象存储 / COS」产品。
2. 创建一个**存储桶**（例如 `cikachat`），记录：
   - **EndPoint（地域节点）**：形如 `https://cos.ap-shanghai.myqcloud.com`（雨云通常提供兼容 AWS S3 的 Endpoint）
   - **Region**：如 `ap-shanghai`（一般可从 Endpoint 推断）
   - **Bucket 名称**
3. 创建一组 **AccessKey / SecretKey**（API 密钥），注意 SecretKey 只显示一次，请立即保存。

> 无需在控制台预建任何"文件夹"。CikaChat 运行时会按前缀自动写入。

***

## 4. 客户端配置（二选一）

Tauri 后端按以下顺序加载配置：

### 方式一：s3-config.json（推荐，随应用分发）

仓库已随附配置模板 [`src-tauri/s3-config.json`](../src-tauri/s3-config.json)（AccessKey/SecretKey 留空，应用视为"未配置"）。

**首次部署**：直接编辑该模板文件，填入你的 Endpoint / AccessKey / SecretKey 保存即可，无需重编译；
也可以把模板复制到应用配置目录 `app_config_dir` 再填写（优先级低于运行目录，便于已安装的应用使用）。

模板内容：

```json
{
  "endpoint": "https://cos.ap-shanghai.myqcloud.com",
  "region": "ap-shanghai",
  "bucket": "cikachat",
  "access_key": "你的AccessKey",
  "secret_key": "你的SecretKey",
  "path_style": true,
  "public_base": ""
}
```

字段说明：

| 字段            | 必填 | 说明                                                                                          |
| ------------- | -- | ------------------------------------------------------------------------------------------- |
| `endpoint`    | 是  | 雨云 S3 兼容 Endpoint（含 `https://` 前缀）                                                          |
| `region`      | 否  | 地域，默认 `us-east-1`；雨云一般填 Endpoint 中对应地域                                                      |
| `bucket`      | 是  | 存储桶名称（唯一桶）                                                                                  |
| `access_key`  | 是  | API 访问密钥 ID                                                                                 |
| `secret_key`  | 是  | API 访问密钥 Secret                                                                             |
| `path_style`  | 否  | 路径风格寻址（`endpoint/bucket/key`），雨云/对象存储一般填 `true`                                             |
| `public_base` | 否  | 若桶为公开读，可填公网访问域名，如 `https://cikachat.cos.ap-shanghai.myqcloud.com`；留空则自动由 Endpoint+Bucket 拼出 |

> **安全提醒**：`src-tauri/s3-config.json` 是随仓库提交的**空密钥模板**，可放心提交。
> 填入真实密钥后请**不要**再把它提交到公共仓库（git 会提示该文件被修改）。需要与团队共享时，请改用方式二环境变量，或把填好密钥的文件保留为本地未跟踪副本。

### 方式二：环境变量（部署/测试用）

优先级高于配置文件，适用于不想把密钥写进仓库的场景：

```
CIKACHAT_S3_ENDPOINT=https://cos.ap-shanghai.myqcloud.com
CIKACHAT_S3_REGION=ap-shanghai
CIKACHAT_S3_BUCKET=cikachat
CIKACHAT_S3_ACCESS_KEY=你的AccessKey
CIKACHAT_S3_SECRET_KEY=你的SecretKey
CIKACHAT_S3_PATH_STYLE=true
CIKACHAT_S3_PUBLIC_BASE=            # 可选
```

### 验证配置是否生效

登录页会调用 `s3_status` 命令返回配置状态；未配置时提示：

```
S3 存储桶未配置。请在 src-tauri 目录放置 s3-config.json 或设置 CIKACHAT_S3_* 环境变量（详见 docs/s3-config-guide.md）。
```

***

## 5. 权限策略建议

### 方案 A：私有桶 + 预签名 URL（推荐）

- 桶权限设为**私有**（不公开读）。
- 媒体访问走服务端 `get_media_url` 生成的**预签名 URL**（默认 1 小时有效），前端拿到的链接都带签名，过期自动失效。
- 适合正式生产，防爬、防盗链。

### 方案 B：公开读

- 将桶设为公开读（或在桶策略中允许 `s3:GetObject`）。
- `upload_media` 返回的即永久公网 URL，无需签名。
- 适合测试/轻量使用；媒体 URL 一旦泄露可长期访问。

> 无论哪种方案，**写操作（PutObject）都仅由服务端签名发起**，前端不会直接接触存储凭证。

***

## 6. 运维建议

- **备份**：`users/`、`sessions/`、`private/` 是核心数据，建议在雨云开启版本控制或定期导出。
- **清理**：`media/` 可能累积大文件，建议按前缀设置生命周期规则（如 `media/private/` 保留 N 天）或手动归档。
- **监控**：关注雨云控制台的请求量/流量计费，公聊轮询默认每 5\~10 秒一次，量小无压力。
- **迁移**：旧 Supabase 数据可按本指南的目录结构，把各表导出为 JSON 后按 Key 写入对应前缀即可平滑迁移。

***

## 7. 单桶约束说明

- 应用假设**只有一个存储桶**，所有 Key 都不含桶名，代码中 `bucket` 仅用于寻址。
- 如你后续在雨云新建了其他桶，业务数据仍只写入配置中的这个桶，其他桶不影响 CikaChat。

