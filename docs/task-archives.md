# 任务档案与批次验收

这是按需打开的任务窗口，不是常驻监控面板。本机已在 r9（2026-09-12）部署，标题栏的“任务”按钮打开它；r8 为保留的独立候选，没有激活。不改动模型选择或原会话格式。

## 使用

1. 首次选择“选择原始清单并绑定”，补充标题、目标、约束；需要时保存相关会话 ID。
2. 以后用“已有档案 → 打开/刷新”恢复同一个任务，不重复绑定。当前状态从原清单读取，不靠重读完整聊天记录恢复进度。
3. 点选条目查看报告、证据和差异。PNG/JPEG/WebP 可在窗口预览；PDF/Office 仅显示文件摘要，须在可信外部程序里审查。
4. 确认成功产物后点“锁定验收”。保存的是源行和产物 SHA256；预览后的内容变动会拒绝验收，已验收内容变化会使锁定失效。哈希验证不代替人工/模型对业务质量的审查。
5. “生成失败重跑计划”只输出当前失败 ID 和源 manifest 哈希，不执行采集、模型任务、图片生成或平台写入；已成功项目不纳入失败重跑。

业务清单仍是唯一进度源。`DSH_HOME/task-archives/<taskId>.json` 仅保存定位、说明、映射、会话引用、验收与重跑记录；不复制业务状态和进度计数。该能力不自动迁移或绑定历史会话。

## 格式与安全边界

- 标准 JSON 使用 `schemaVersion: 1`、`items`；稳定 `itemId` 和五种状态 `pending/running/needs_review/failed/succeeded`。商品身份使用 `identity.{spu,sku,barcode}`。
- UTF-8 CSV、旧 JSON 数组或 `{items}` 支持只读接入及显式字段/状态映射；未知状态、缺 ID 和重复 ID 隔离为待核验/异常，不猜测可重跑项。
- 清单和可验收产物当前上限均为 5 MiB，清单最多 10,000 项。产物必须是清单所在目录以内的相对路径；禁止链接逃逸、外部 URL、SVG/HTML 与可执行文件。大文件或旧绝对路径可读出任务信息，但不能假称已预览/验收。
- 标准清单更新需要原 manifest 哈希与独占锁；拒绝坏行、删除或改写当前成功项。旧格式不通过更新接口偷偷转换。
- 窗口使用独立 preload、sandbox、CSP 和可信 sender 校验；清单路径只从原生选择器取得。无需后台轮询、自启动或新常驻服务。

## 共享 CLI

安装版 Node：`%LOCALAPPDATA%/Programs/DeepSeek/resources/node.exe`。
CLI：`%LOCALAPPDATA%/Programs/DeepSeek/resources/tools/task-archive/cli.cjs`。
源码入口：`scripts/task-archive/cli.cjs`。CLI 与桌面使用同一服务源码，不需要 Node 读取 app.asar。

命令：`list`、`bind --manifest PATH`、`show TASK` / `read TASK`、`inspect TASK ITEM`、`checkpoint`、`update`、`accept`、`retry-plan`。
`accept` 需要 inspect/read 所取得的源行、manifest、产物三个预期 SHA256，不能省略或用随手重算的新值覆盖旧预览依据。

业务预览工具与具体离线示例见 `C:/Users/yi/Documents/Codex/harness-business-ops` 及 Harness 的 `competitor-price-compare`、`safe-price-adjust` 技能。审批摘要只是材料；审批验证器和平台调价均未实现。
