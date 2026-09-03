<div align="center">
  <img src="assets/deepseek-whale-225.png" width="88" alt="DeepSeek Harness Desktop logo">
  <h1>DeepSeek Harness Desktop</h1>
  <p><strong>把 DeepSeek Harness 变成一个更适合长期使用的 Windows AI Agent 工作台。</strong></p>
  <p>多 Provider · Harness Lab · 模型资源中心 · 原生会话管理 · 本地桌面体验</p>
  <p><a href="https://github.com/yijigao/deepseek-harness-desktop/releases/download/v2.2.0/DeepSeek-Setup-2.2.0.exe"><strong>下载 v2.2.0 安装版</strong></a> · <a href="https://github.com/yijigao/deepseek-harness-desktop/releases/tag/v2.2.0">版本说明</a></p>
  <p>
    <a href="https://github.com/yijigao/deepseek-harness-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/yijigao/deepseek-harness-desktop?label=release" alt="Latest release"></a>
    <a href="https://github.com/yijigao/deepseek-harness-desktop/releases"><img src="https://img.shields.io/github/downloads/yijigao/deepseek-harness-desktop/total" alt="Downloads"></a>
    <a href="https://github.com/yijigao/deepseek-harness-desktop/stargazers"><img src="https://img.shields.io/github/stars/yijigao/deepseek-harness-desktop?style=flat" alt="GitHub stars"></a>
    <img src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows" alt="Windows">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  </p>
</div>

DeepSeek Harness Desktop 是由社区维护的 Windows AI Agent 工作台。它保留 Harness 原生的工作区、模型、插件、Agent 预设和权限体系，并补齐长期桌面使用所需的运行可靠性、模型接入、资源可见性、Agent 执行诊断和原生交互；它并非只把 `dsh web` 放进 Electron 窗口。

## 为什么它不只是一个桌面壳

- **多 Provider / OpenAI-compatible**：复用 Harness Provider 架构，提供 OpenAI-compatible Provider 配置能力，以及 ChatGPT subscription OAuth 路由和第三方 Provider 配置示例。
- **Harness Lab**：在本地分析 Agent 执行轨迹，包括工具调用、重试、失败恢复、重复循环、文件操作和执行路径；它是任务诊断工具，不是简单的模型排行榜。
- **模型资源中心**：Provider 支持时显示真实账户用量、余额和重置时间；不支持时明确降级为本地 Token 观察，不伪造 Provider 数据。
- **原生桌面能力**：提供会话置顶、原生剪贴板、独立窗口和本地运行时管理，并尽量在数据层或源码层集成，避免依赖脆弱的 DOM hack。
- **可验证、可回滚升级（当前 main）**：候选构建先隔离执行启动、Renderer/UI 与截图验证；适用时运行已认证的模型网络探测，通过后再原子切换，失败则回滚，并对迁移执行版本门控和备份。

> [!TIP]
> 如果这个项目让 DeepSeek Harness 更好用，欢迎点一个 **Star**，帮助更多人发现它。

> [!IMPORTANT]
> 本项目为非官方社区项目，不代表 DeepSeek 官方立场。

## v2.2.0 有什么新功能

- **原生会话置顶**：在会话菜单中置顶或取消置顶，结果持久保存。排序发生在 React 数据层，不使用 DOM 轮询、观察器或后台扫描。
- **模型资源中心**：顶部常驻显示当前模型，并在提供商允许时展示用量、余额与重置时间；服务不可用时降级到本地 Token 用量。
- **Harness Lab**：在本机比较两次任务的执行轨迹，查看工具调用、重试、失败恢复、重复循环与文件变动，而不是把不同目标的任务当作模型排行榜。
- **完整桌面体验**：独立窗口、原生窗口控制、共享现有 Harness 配置和会话，关闭应用时同步回收本地服务。

![DeepSeek Harness Desktop 主界面](assets/screenshots/workspace.png)

## 快速开始

1. 从 [Releases](https://github.com/yijigao/deepseek-harness-desktop/releases/latest) 下载安装版或便携版。
2. 安装并启动 DeepSeek Harness Desktop。
3. 继续使用原有 `DSH_HOME`（默认 `%USERPROFILE%\.dsh`）中的设置和会话。

应用只在 `127.0.0.1` 的随机端口启动 `dsh web`。账号凭据、历史会话、日志和本地配置不会被复制进项目目录。

## 会话置顶

在任意会话的菜单中选择“置顶会话”。空白的新会话始终位于最前，其后是已置顶会话，再后是普通会话。最多保存 50 个置顶会话 ID，避免长期使用造成无界增长。

该功能直接作用于会话数据层，没有 `MutationObserver`、定时器、页面扫描或额外子进程，设计目标是让长会话列表仍保持流畅。

## 模型资源中心

模型资源中心优先读取提供商返回的真实账户信息，展示当前模型、用量或余额以及重置时间。若提供商不开放这些数据，则明确降级为本机会话 Token 统计，不伪造“余额”。账户探测和会话统计均在后台执行，不阻塞主界面启动与操作。

## Harness Lab

![Harness Lab 执行轨迹对比](assets/screenshots/harness-lab-compare.png)

Harness Lab 用来回答“这次任务是怎样完成的，以及哪里值得改进”，而不是笼统判断两个不同目标的任务谁更好。选择两次有关联的运行后，可以比较：

- 步骤、工具调用、重试、失败和耗时；
- 重复工具循环与失败后的恢复路径；
- 不必要的文件读取、写入与搜索路径；
- 测试执行时机和执行路线差异。

分析在本机完成。渲染层只接收净化后的指标、工具类别、通用摘要和文件 basename，不接收原始 Prompt、凭据或绝对路径。

> 截图使用内置的合成演示数据，仅用于展示比较流程，不是模型性能 benchmark，也不代表性能提升。

> Schema-derived, synthetic-tested, and smoke-validated against a locally generated minimal DeepSeek Harness session.

## 设置与兼容性

![DeepSeek Harness Desktop 设置界面](assets/screenshots/settings.png)

桌面版保留工作区、模型、插件、Agent 预设、权限和语言等 Harness 原生能力，并直接复用现有 `DSH_HOME`。[`config-example/`](config-example/README.md) 提供多提供商与 ChatGPT 订阅 OAuth 路由的配置示例；仓库不包含任何真实凭据。

## Provider integrations

DeepSeek Harness Desktop reuses the Harness provider architecture. OpenAI-compatible providers can be added as optional providers without rewriting the Agent, session, or tool layers.

Model/API providers interested in tested integration, onboarding, documentation, resource or usage visibility where APIs support it, or release collaboration can contact the project through a [GitHub Issue](https://github.com/yijigao/deepseek-harness-desktop/issues).

## 本地开发

要求 Node.js 22.15+：

```powershell
cd app
npm ci
npm start
```

运行测试：

```powershell
cd app
npm test
```

Harness Lab 合成数据演示：

```powershell
cd app
npm start -- --demo-harness-lab
```

开发模式需要预先准备 `staging/payload/runtime` 和 `staging/payload/node.exe`，它们来自上游 DeepSeek Harness，不提交到本仓库。

## 构建

准备上游 DeepSeek Harness 源码及其依赖后运行。Desktop 使用的 Harness 分支直接在 `packages/client/ui-primitives/src/clipboard.ts` 集成原生剪贴板 host；更新脚本会合并官方 `origin/master`，构建后只校验该能力，不再修改压缩后的前端 bundle：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-update.ps1 `
  -Checkout ..\deepseek-harness `
  -BuildOnly
```

安装版与便携版生成在 `dist/`。构建流程会完成官方源码同步、运行时部署、依赖补齐、旧功能兼容处理、源码集成校验、冒烟测试和 Electron 打包，不依赖固定用户名或绝对路径。

安装更新时，候选构建会先在独立目录完成启动、Renderer/UI 和截图验证；存在适用凭据时还会执行模型网络探测。验证通过后才切换安装目录，激活失败则恢复上一版本；需要迁移的本地数据按版本门控并先行备份。

## 隐私与安全

仓库明确排除以下内容：

- `.dsh`、API 凭据、OAuth Token、登录状态与历史会话；
- 日志、缓存、数据库、本地配置与环境变量文件；
- `node_modules`、运行时、构建产物、签名证书与私钥。

应用只读取你本机的 `DSH_HOME`，不会把这些数据复制到仓库或发送到远程分析服务。

## 许可

桌面端代码采用 [MIT License](LICENSE)。DeepSeek Harness 及其依赖仍分别适用各自的许可证和商标条款；分发包含上游运行时的安装包前，请自行核对对应许可。
