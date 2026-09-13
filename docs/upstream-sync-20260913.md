# Harness 0.1.5 选择性同步状态（2026-09-13）

## 目标与边界

- 从官方 `dsh-v0.1.5-rc.2` 选择性回填 P0 与低耦合 P1 修复。
- 保持 Session V2、r10 Gemini scoped policy、当前 Desktop UI、历史会话与现有 preset；排除 Session V3、Sidebar、Agent Teams、通用文件上传和全量 pi-ai 升级。
- 当前生产 r10 运行期间只构建和 PrepareOnly，不关闭、不激活、不修改会话或凭据。

## 冻结源码

- 隔离工作树：`C:/Users/yi/Documents/Codex/harness-r11-selective-upstream-20260913`
- r10 checkpoint：`9782971bfc`
- MCP 重复分页游标熔断：`cfb86b6ae4`
- pi-ai 模型目录/失效配置恢复最小融合：`f40135c64fdad64bb3265aa4f6f1b8ff759c6444`
- 完整 Client build 暴露的未使用测试绑定修复：`e2cbd7582417348247418a3442f384e841906515`
- 最终工作树 clean，tree `01ee769fd2574fe4c0715d8453c0056e1f9c78a1`。

## 验证

- pi-ai 与 Models：6 files / 217 tests 通过。
- MCP：2 files / 82 tests 通过。
- GUI：302 files / 4202 tests 通过，1 file / 4 tests 为既有跳过。
- llm-pi-ai Host 类型检查、ui-settings-models Client 定向类型检查、`build:lib:host` 通过。
- 类型等价 411/411、5 对翻译配对、doc-standard 12/12、pre-commit lint/whitespace/vendor/pairing 通过。
- 第二次 docs 与 GUI 并发时 doc-standard 两项 5 秒扫描超时；脱离资源竞争后 12/12 通过。没有把并发超时冒充功能通过。
- 完整 `pnpm run build` 通过；ui-model-selection 定向类型检查与 14/14 测试通过。

## 七项审计结论

1. MCP 重复分页游标熔断由 `cfb86b6ae4` 回填。
2. Web 断线恢复由 r10 已有持续重试、握手硬超时取消、清理等待与参数校验覆盖，不重复回填 `1bd26370`、`1e04fcff`。
3. DeepSeek 流工具身份由 r10 最终 `acceptIdentity()` 与 malformed-tool-call 修复覆盖，不重复回填 `a1271a49..b03261ca`。
4. Windows 子进程隐藏与清理由 r10 普通 spawn `windowsHide`、隐藏 taskkill helper 与更强 native containment 覆盖，不重复回填 `cc8099dc`、`a05b5fbe`。
5. pi-ai 失效配置恢复由 `f40135c64f` 最小融合，保留 scoped Gemini policy。
6. proxy env 由 r10 的 `http-proxy`、Harness-home `.env`、子进程代理恢复及拒绝值不下发 `NODE_USE_ENV_PROXY` 覆盖，不重复回填 `545e2ad..93bba8ef`。
7. 上游模型元数据建议对应 `bc5fd3b8dc`、`441385fe38`、`0729dbec66`；V4 与 V4 Vision 已存在，V41 默认依赖 `systemPromptUpdate` 横跨 agent-loop、LLM、Session `request/context`、V3 JSONL 与 Web，因此按 Session V2 边界延期。

## r11 候选

- runtime closure：233 个 workspace 包，545 个可达实例，2124 条依赖边，必需依赖缺失 0，链接 0；flat 与 packaged closure 均通过。
- Desktop 定向：发布/更新 20/20、任务窗 9/9、RPC lifecycle、隔离 renderer、同窗体 engine recovery 与合成 Session usage 均通过。
- 无凭据 TEMP：product-quick Host、认证 RPC、roster 与完整 preset 挂载通过；未继承凭据变量，模型请求 0。
- 候选：`release-artifacts/desktop-2.2.0-alpha2-r11/win-unpacked`
- manifest SHA-256：`cbf30b30fa601d6d8b6c451d6f51b14974099fd5537097182817d7e4cead13cb`，32060 个文件，seal 后完整 verify 通过。
- PrepareOnly：`C:/Users/yi/AppData/Local/Programs/DeepSeek.candidate-20260913-124912`；ready receipt SHA-256 `7f7ba74bef28be39da3bb3359f36d763d409c59ec43a9dd77f3101b6b13cbb1e`。
- 生产 r10 manifest 仍为 `f9cc6caa390541163f8ded32094f2f5a9b3ddbc3e7624c4a7ae8b92b7c5d18e5`。未激活、未重启、未做网络探测；激活须另获安全窗口授权。

## r11 生产激活（2026-09-13 12:58 起）

- 激活前 fresh 检查为 DeepSeek 进程 0、匹配安装/工作区的 engine writer 0；重新完整验证 r10 与 r11，分类为 Session 格式不变的 engine 更新。
- 使用已验 PreparedReceipt 原子激活 `desktop-2.2.0-alpha2-r11`，未迁移缓存或会话；旧 r10 保存在 `C:/Users/yi/AppData/Local/Programs/DeepSeek.pre-update-20260913-125836`。
- 启动后 4 个 Desktop/engine 进程响应正常；日志确认 commit `e2cbd7582417348247418a3442f384e841906515` 与 releaseId r11。
- 回环 RPC：认证成功；`session/list` 276 项；模型目录 4 组、14 模型、0 failure；非法模型与不存在会话仍按结构化错误拒绝。
- `agentPresets/list` 发现 7 项并包含 `product-quick`；`skills/list` 发现 12 项并包含 `shangpin-db`。未发送模型请求、未执行真实商品查询，因此不宣称生产任务提速已实测。
