# 按任务启用的插件试点 · 2026-09-12

本轮只做隔离试点；没有修改 live Harness profile、登录态或后台服务。使用现有 Chrome，不下载额外浏览器。主目录为 `C:/Users/yi/Documents/Codex/harness-plugin-pilot-20260912`，依赖已锁定在 npm lockfile。

| 候选 | 验证 | 决定 |
| --- | --- | --- |
| `@playwright/mcp@0.0.80` | MCP SDK 发现 24 个工具；本地合成页面导航、读取 SKU/规格/价格、点击与结果核验通过（2255ms）。另用安装版 Harness 原生 `dsh-mcp-client` + ToolRuntime 完整挂载调用通过（1879ms）。 | 保留按任务隔离启用能力；不挂入所有业务会话，不默认使用已有账号。 |
| `task-passport@0.3.1` | core 本地状态版本冲突测试通过，但发布包缺少 `outbox.js`，实际 CLI 启动 `ERR_MODULE_NOT_FOUND`；MCP 入口也依赖此文件。 | 不正式启用此版本，不私改第三方包；使用本次任务档案直接引用权威 manifest。 |

Playwright 检验只访问 synthetic localhost 页面，headless + isolated、重连关闭、测试结束释放服务与浏览器；不表示已验证商家登录、采集吞吐量或验证码效果。`--allowed-origins` 仅作为该工具的访问约束，不宣称为系统安全沙箱。遇到人机校验需停下交给用户，不绕过校验。

证据：

- 试点目录 `verification.json`、`verification-native.json`，以及对应可重复执行的 `verify.mjs`、`verify-native.mjs`。
- SDK/Task Passport 临时证据：`C:/Users/yi/AppData/Local/Temp/harness-plugin-pilot-EsvjWA`。
- Harness 原生注册表临时证据：`C:/Users/yi/AppData/Local/Temp/harness-native-mcp-pilot-RCZbxV`。

本机复测入口（无需 Desktop 重启）：

```powershell
& 'C:\Users\yi\AppData\Local\Programs\DeepSeek\resources\node.exe' 'C:\Users\yi\Documents\Codex\harness-plugin-pilot-20260912\verify-native.mjs'
```

参考：[Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Task Passport npm 版本](https://www.npmjs.com/package/task-passport/v/0.3.1)。后续仅当具体采集任务需要并明确站点/门店/登录与访问边界时才接入该会话；不新增保活或自启动。
