# DeepSeek Harness 配置示例（Config Examples）

本目录提供一套**可直接上手**的 Harness 用户配置示例，覆盖：

- 默认模型路由与权限预设（`settings.yaml.example`）
- 通用多提供商适配器（`llm-pi-ai`）的 provider 配置——包括 OpenAI 兼容网关示例（火山方舟豆包）
- ChatGPT 订阅（Plus / Pro / Pro Max）通过 OAuth 接入 `openai-codex` 路由的一键登录/验证脚本

> **隐私承诺**：本目录不包含任何真实凭据。API Key 请写在 `$DSH_HOME/.credentials.yaml`
> 或 `.env`；ChatGPT 订阅的 OAuth token 由登录脚本写入 `$DSH_HOME/oauth-credentials.json`，
> 两者都不进入本仓库（见仓库根 `.gitignore`）。

## 文件清单

| 文件 | 作用 |
|---|---|
| `settings.yaml.example` | 把需要的段落复制到 `$DSH_HOME/settings.yaml`（默认 `%USERPROFILE%\.dsh\settings.yaml`），热生效，无需重启 |
| `oauth-login-openai-codex.mjs` | 一次性登录：为 `openai-codex` 路由获取 ChatGPT 订阅的 OAuth 凭据 |
| `test-openai-codex.mjs` | 验证凭据可用：经 `chatgpt.com/backend-api` 发一条消息并打印回复 |
| `../scripts/patch-pi-ai-oauth.mjs` | 幂等补丁：给运行时的 `dsh-llm-pi-ai` 适配器注入文件持久化 OAuth 存储 |

## 快速开始

### 1. 安装运行时补丁（一次）

`openai-codex` 是 OAuth-only 路由，原版适配器不携带凭据存储，需要先打补丁：

```powershell
# 默认指向已安装的应用运行时（%LOCALAPPDATA%\Programs\DeepSeek\resources\runtime）
node scripts\patch-pi-ai-oauth.mjs "%LOCALAPPDATA%\Programs\DeepSeek\resources\runtime"
```

- 重复运行是幂等的；`--check` 只验证；`--restore` 从 `index.js.oauth-bak` 还原。
- 重新构建桌面应用时 `sync-update.ps1` 会自动执行该补丁。

### 2. 写配置

把 `settings.yaml.example` 中需要的段落合并进 `$DSH_HOME/settings.yaml`：

- 默认模型段（`agent-default-model`）与权限预设（`permission`）直接可用；
- `llm-pi-ai.providers.openai-codex` 段启用 ChatGPT 订阅路由（模型名可自行增删）；
- 火山方舟豆包段默认注释，取消注释并填入你的 Endpoint ID / API Key 引用即可。

### 3. 登录 ChatGPT 订阅（一次，手动授权）

```powershell
node config-example\oauth-login-openai-codex.mjs
```

脚本会打开浏览器授权（或打印授权地址/设备码），完成后凭据写入
`$DSH_HOME/oauth-credentials.json`，token 到期后应用会自动刷新。

验证：

```powershell
node config-example\test-openai-codex.mjs gpt-5.6-luna
```

### 4. 在 Harness 中选用模型

Web GUI 的模型选择器里选中 `openai-codex` 路由下的模型即可。该路由由
`llm-pi-ai` 适配器在 `settings.yaml` 出现 `llm-pi-ai:` 段时实时注册（无需重启）。

## 添加 OpenAI 兼容提供商（例如豆包 / 火山方舟）

在 `settings.yaml` 的 `llm-pi-ai.providers` 下加一段即可，`apiKeyEnv` 引用的是
**按请求解析的凭据引用**（写入 `$DSH_HOME/.credentials.yaml` 或 `.env`），不是明文：

```yaml
llm-pi-ai:
  providers:
    volcark:
      displayName: 火山方舟豆包
      apiKeyEnv: ARK_API_KEY
      api: openai-completions
      baseURL: https://ark.cn-beijing.volces.com/api/v3
      models:
        - id: ep-xxxxxxxx      # 方舟控制台的推理接入点 ID，或模型名（如 doubao-seed-2-1-pro）
          name: 豆包 2.1 Pro
          contextWindow: 128000
          maxTokens: 8192
```

> 注意：豆包专业版订阅是 App/网页消费订阅，不发放 API Key；API 调用走火山方舟单独计费。
> 本仓库不提供任何 Cookie/网页会话桥接方案。
