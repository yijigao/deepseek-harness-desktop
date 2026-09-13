# computer-use：Windows 10 截图兼容问题

## 已确认

- 现场系统为 Windows 10 22H2，build 19045.6456。
- `GraphicsCaptureSession`、`StartCapture` 和 `IsCursorCaptureEnabled` 存在；`IsBorderRequired` 与 UniversalApiContract v12 不存在。
- computer-use 宿主 `@oai/sky` 0.6.26 的 Windows 原生 helper 包含 `SetIsBorderRequired failed`、`coordinate input geometry is unavailable` 及捕获会话错误路径；现场窗口枚举和 UI Automation 文本正常，截图在调用该属性时返回 `0x80004002`。
- 微软文档标明 `IsBorderRequired` 从 Windows build 20348 / UniversalApiContract v12 引入。因此这是原生宿主的 API 版本兼容问题，不是 Harness 页面、native pipe 或管理员权限问题。

微软 API 参考：

- `GraphicsCaptureSession.IsBorderRequired`：https://learn.microsoft.com/windows/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired
- `ApiInformation.IsPropertyPresent`：https://learn.microsoft.com/uwp/api/windows.foundation.metadata.apiinformation.ispropertypresent

运行只读能力报告：

```powershell
& .\scripts\diagnose-computer-use-compat.ps1
```

## 原生宿主最小修复契约

创建捕获会话后，必须在设置无边框属性之前做运行时能力探测。若 `IsBorderRequired` 接口不存在，不调用 setter，保留 Windows 默认黄色捕获边框，并继续 `StartCapture`。`E_NOINTERFACE (0x80004002)` 不能当作整个截图失败。

伪代码：

```text
session = framePool.CreateCaptureSession(item)
if ApiInformation.IsPropertyPresent(GraphicsCaptureSession, IsCursorCaptureEnabled):
    session.IsCursorCaptureEnabled = true
if ApiInformation.IsPropertyPresent(GraphicsCaptureSession, IsBorderRequired):
    session.IsBorderRequired = false
session.StartCapture()
```

如果原生实现使用 ABI/QueryInterface，应只把缺少 `IsBorderRequired` 对应接口视为可选能力缺失；其他会话创建、D3D 或 frame pool 错误仍须失败。

## 验收

1. 在 build 19045 上 `get_window_state(include_screenshot:true)` 返回至少一张截图，并允许系统默认边框。
2. 同一观察结果能提供窗口 bounds；使用其 screenshotId 的坐标点击不再返回 geometry unavailable。
3. 在支持 v12 的 Windows 上仍可按原行为请求无边框截图。
4. UI Automation-only 路径不依赖截图，应继续工作。
5. 若第1项恢复而第2项仍失败，再独立检查 DPI 缩放、窗口 bounds 与截图坐标映射，不能继续把它归因于 `IsBorderRequired`。

## 部署边界

修复归属 Codex computer-use 原生 helper，不在 Harness Desktop 的 JavaScript/renderer 中。当前本机只有随 Codex 安装的已签名二进制，没有可维护的原生源码或更高版本缓存；这只说明本地没有可直接替换的版本，不等于已确认官方更新渠道不存在新版本。不要二进制热补丁、绕过签名、修改系统安全设置或私造控制管道。应通过受信任的 Codex/插件更新交付兼容 helper；更新后用上述矩阵复验。
