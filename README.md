<div align="center">
  <img src="assets/deepseek-whale-225.png" width="88" alt="DeepSeek Harness Desktop logo">
  <h1>DeepSeek Harness Desktop</h1>
  <p><strong>让 DeepSeek Harness 成为更顺手的 Windows 桌面应用。</strong></p>
  <p>会话置顶 · 模型用量中心 · 本地执行轨迹分析</p>
  <p><a href="https://github.com/yijigao/deepseek-harness-desktop/releases/download/v2.2.0/DeepSeek-Setup-2.2.0.exe"><strong>下载 v2.2.0 安装版</strong></a> · <a href="https://github.com/yijigao/deepseek-harness-desktop/releases/tag/v2.2.0">版本说明</a></p>
  <p>
    <a href="https://github.com/yijigao/deepseek-harness-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/yijigao/deepseek-harness-desktop?label=release" alt="Latest release"></a>
    <a href="https://github.com/yijigao/deepseek-harness-desktop/releases"><img src="https://img.shields.io/github/downloads/yijigao/deepseek-harness-desktop/total" alt="Downloads"></a>
    <a href="https://github.com/yijigao/deepseek-harness-desktop/stargazers"><img src="https://img.shields.io/github/stars/yijigao/deepseek-harness-desktop?style=flat" alt="GitHub stars"></a>
    <img src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows" alt="Windows">
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT License"></a>
  </p>
</div>

DeepSeek Harness Desktop 是由社区维护的 Windows 桌面封装：把完整的 `dsh web` 运行时放进独立 Electron 窗口，同时补上高频会话管理、模型资源可见性和本地 Harness 分析能力。

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

准备上游 DeepSeek Harness 源码及其依赖后运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-update.ps1 `
  -Checkout ..\deepseek-harness `
  -BuildOnly
```

安装版与便携版生成在 `dist/`。构建流程会完成运行时部署、依赖补齐、补丁应用、冒烟测试和 Electron 打包，不依赖固定用户名或绝对路径。

## 隐私与安全

仓库明确排除以下内容：

- `.dsh`、API 凭据、OAuth Token、登录状态与历史会话；
- 日志、缓存、数据库、本地配置与环境变量文件；
- `node_modules`、运行时、构建产物、签名证书与私钥。

应用只读取你本机的 `DSH_HOME`，不会把这些数据复制到仓库或发送到远程分析服务。

## 许可

桌面封装代码采用 [MIT License](LICENSE)。DeepSeek Harness 及其依赖仍分别适用各自的许可证和商标条款；分发包含上游运行时的安装包前，请自行核对对应许可。
