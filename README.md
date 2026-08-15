# DeepSeek Harness Desktop

一个由社区维护的 Windows 桌面封装：将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh web` 界面运行在独立 Electron 窗口中。

> [!IMPORTANT]
> 这是社区项目，不是 DeepSeek 官方桌面客户端，也不代表 DeepSeek 官方立场。

## 功能

- 双击启动，无需手动打开终端
- 独立的深色 Electron 窗口与原生窗口控制
- 使用随机本机端口启动 `dsh web`，关闭窗口时结束子进程
- 复用用户自己的 `DSH_HOME`（默认 `%USERPROFILE%\.dsh`）
- 每天最多检查一次上游 DeepSeek Harness 的 major/minor 更新
- 可重建内置运行时并生成安装版和便携版

## 隐私

仓库只包含桌面壳源码、构建脚本和必要图标，不包含：

- `.dsh`、API 凭据、登录状态或历史会话
- 日志、缓存、数据库和本机配置
- `node_modules`、打包产物、内置运行时或 Node 可执行文件
- 代码签名证书、私钥或环境变量文件

应用会在运行时读取本机的 `DSH_HOME`；这些数据不会被复制到项目目录。

## 开发运行

要求 Node.js 20+：

```powershell
cd app
npm ci
npm start
```

开发模式需要先准备 `staging/payload/runtime` 和 `staging/payload/node.exe`。运行时来自上游 DeepSeek Harness，不提交到本仓库。

## 构建

1. 将上游仓库克隆到本机，例如 `..\deepseek-harness`。
2. 安装 `pnpm`，并在上游仓库安装依赖。
3. 运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\sync-update.ps1 `
  -Checkout ..\deepseek-harness `
  -BuildOnly
```

生成文件位于 `dist/`。更新脚本不会依赖任何固定用户名或绝对路径。

## 自动更新说明

桌面应用根据打包时生成的 `version.json` 检查上游 DeepSeek Harness 版本。收到 major/minor 更新提示后，更新脚本会拉取用户本机的上游源码、重建运行时并重新打包。该流程需要 Git、Node.js、pnpm 和完整源码工作区，并非下载未知二进制覆盖安装。

## 上游与许可

桌面封装代码以 [MIT License](LICENSE) 发布。DeepSeek Harness 及其依赖仍分别适用各自的许可证和商标条款；分发包含上游运行时的安装包前，请自行核对并遵守对应许可。

