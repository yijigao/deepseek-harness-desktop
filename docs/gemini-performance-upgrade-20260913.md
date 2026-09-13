# Gemini / Harness 性能优化状态（2026-09-13）

> 当前状态：r10 已于 2026-09-13 生产激活并完成只读发现验收；本文件前半部分保留实施当时的“未部署”阶段记录，最终安装事实见末尾“r10 生产激活”。

## 目标与边界

- 针对 `antigravity-pro / gemini-3.8-flash-high` 在简单商品查询中出现的多轮串行工具调用、上下文膨胀及 300 秒无 chunk 等待。
- 保留复杂任务质量；不全局缩短默认 300 秒 stream idle timeout。保护策略只在独立 agent preset 显式启用，每个 agent、turn、step 隔离并重置。
- 本轮仅完成源码、合成数据与隔离测试；不重启或替换生产 Desktop，不读取真实凭据、会话或商品数据库，不调用真实模型。

## 已确认基线

- 会话 `session-7aa11e3f-a88d-4039-b651-d5e3a9f74b55` 首轮耗时 520.897 秒；模型/请求 511.246 秒、23 次工具 8.797 秒。
- 25 次可见模型 attempt 中一次命中 `pi-ai stream idle timeout after 300000ms`，另一次首 chunk 前约 67.856 秒；没有运行期压缩或恢复事件。
- 工作流存在约 14 次重叠/渐进查询、5 个 TEMP JSON 与 7 次分页回读，上下文约从 1.4 万增至 5.8 万 tokens。

## 商品查询快速路径

- 源码位于 `C:/Users/yi/Documents/Codex/harness-business-ops/skills/shangpin-db`，新增只读成本/售价 helper；一次返回商品身份、规格、成本、售价、来源与快照范围，并保留歧义、分页、平台独有及 NULL 处理；不直接计算利润。
- 默认输出有界；重复条码 issue ID 有界且提供续取 cursor；Markdown 使用候选显示身份并标明历史快照范围。
- Astra 独立测试 17/17、业务工具仓库 34/34 通过。TEMP 2000 SKU + 5000 listing 基准由 0.764 秒降至 0.012 秒，查询计划已消除相关子查询全扫描；不能据此外推真实库绝对耗时。
- 冻结 SHA-256：`SKILL.md` `8ea2fd88e7a21489807b29c5259dd7b087031f069c7b64b0901a59c7eedefc2e`；`product_cost_price.py` `39abe1f808ba485166b1b55784ac3fb799714780a92915f577b51c5b390035d5`；测试 `15da7a487cb71146b775a73d7da4e156da90ec94b782ee18fa16b87b9f6c794b`。
- 尚未部署到 `.agents/.dsh`，未访问或修改生产商品库及现有运营脚本。

## Harness 隔离候选

- 工作树：`C:/Users/yi/Documents/Codex/harness-performance-guard-20260913`；保持 r9 fixed patch 基线，生产 r9 未变。
- 已实现候选：瞬态 stream-health 事件到 controller/UI；辅助标题与压缩请求隔离；旧流 token、取消/错误/turn stop/dispose 清理；只读 exact repeat 与可证明分页重叠提醒默认关闭、精确 allowlist、每 turn 有界，不阻断、不缓存、不复用写工具。
- 已修复边界：abort listener 清理、取消后 settled 状态、credentials await 后旧请求绑定、不同参数/来源误判以及重复提示无界增长。
- 已补齐候选：`toolOutputBudget` 默认关闭，仅累计 post-execute 最终模型可见文本字符（非 token 估算），按真实 turn 限次提示，不截断或替换结果；`taskStreamPolicy.hardSilenceMs` 与 `retryTotalMs` 默认关闭。hard silence 逐 chunk 重置且不得晚于 route idle；retry-total 覆盖凭据解析、attempt 与 backoff，按 agent/turn/step 保持绝对 deadline，`always` 也不得绕过到期或硬预算错误。
- 生命周期已补：旧 token/迟到 abort 不清新 turn；失败/aborted finish 不清预算；cancel、idle、turn stop、dispose 清预算及 health listener；硬预算下 SDK `iterator.return()` 不结算时不阻塞请求边界。hard/total 的事件与预算均不写 Session JSONL。
- 定向验收：`task-stream-policy-review.spec.ts` 4/4（默认 300 秒下 68/130 秒首 chunk 成功、45/90 soft 只观察、hard 100ms 连续 60ms chunks 重置、含 hard/total 的 compaction 隔离）；核心相关 5 suite 131/131 通过。host/client 源码面类型检查通过；host build 的 tsdown Remote JSON 错误已改为 baseline 省略无 health 条目，待最终完整 build/复核再冻结。

## 下一步

1. Astra 复核最终源码、定向测试和完整 build；仅将本轮候选 delta 纳入独立 patch，不修改固定 `maintenance/baseline.json` 或 r9 patch。
2. 生成源文件 hash 清单和验收记录；临时 `.sol-review*`/`tsconfig.sol-review*` 已删除，不纳入候选。
3. 后续若进入 Desktop 候选，只在新目录重放 `82a5fd6 + r9 fixed patch + 本次增量`，使用 TEMP DSH_HOME 做无凭据、无真实模型的 UI/IPC 验收。
4. 未获得生产切换安全窗口前，不运行安装、激活或重启。

## 最终冻结（2026-09-13）

- 状态：已完成隔离候选实现与验收；未部署、未重启、未修改生产 Desktop、`r9`/baseline 或 `maintenance/harness-alpha2.patch`。
- LLM 复制基线：worktree `C:/Users/yi/Documents/Codex/harness-performance-guard-20260913` 建自 `82a5fd61a7cf5c293cec4bdff68f455398d685e9`（`release-dsh-0.1.3-alpha.2`）；仅在该隔离 worktree 中修改。
- 受管已跟踪增量（不含未跟踪的新增测试、snapshot sidecar 与 Agent Note）二进制 diff SHA-1：`084b43643e191f6ff56a1b451f97e22caed30fa0`。关键文件 SHA-256：`adapter.ts` `bf9dcfb8ba1edb93f15158a064ef07806d3fda99194a16b4db9887ad51e81b6e`；真实集成测试 `427f612e42f3ee5081da18dac5d486c6131418e937eea21a749c51f344bfc644`；fake-clock 策略测试 `c0b2d8cf45e509561a8e39a792014ad4fc31fc6fac0b74ae24acad94b64689d4`；repeat guard `223392f11df231f25775cbeb850e7461f46b8ae81cb24b34130bb18b59a8e783`。
- 验收：Astra 最终独立复核 107/107；定向 Vitest 10 files / 283 tests 通过；keyless shipped-headless recorded-session replay 1/1 通过；`pnpm run build:lib:host` 在最终 abort-race 源码上通过；配置目录、双语配对、scoped events、Agent Note 格式与 `git diff --check` 通过。
- 真实 snapshot：`snapshots/session/repeat-tool-reminder/` 以 pwsh 明确组合回放，持久 transcript 同时保留原 `todo_write × 3` 提醒和新增 `tool-output-budget` 建议。
- 已清理并排除 `.sol-review-typecheck.mts`、`tsconfig.sol-review-host.json`、`tsconfig.sol-review-client.json` 及构建产生的源码 JS/d.ts/map；合同 client typecheck 仍由既有无关 `packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts:184` 未使用变量阻断，未改动。

## r10 生产激活（2026-09-13 10:51 起）

- 用户关闭 Desktop 后重新确认无 DeepSeek 或 Harness engine writer；切换前完整验证 r9 与 r10，分类为 Session 格式不变的 engine 更新。
- 使用已验 PrepareOnly receipt 原子激活 `desktop-2.2.0-alpha2-r10`；安装清单 SHA-256 `f9cc6caa390541163f8ded32094f2f5a9b3ddbc3e7624c4a7ae8b92b7c5d18e5`。旧 r9 保存在 `C:/Users/yi/AppData/Local/Programs/DeepSeek.pre-update-20260913-105135`，未执行缓存或会话迁移。
- `product-quick` 部署到 `C:/Users/yi/.dsh/.agent-presets/product-quick`；两个文件与冻结 staging 哈希一致，原 `daily-lite` / `fast-standard` 四个主文件哈希不变。
- 生产启动后 releaseId 为 r10，四个 Desktop 进程响应正常；回环 RPC 认证成功，`session/list` 返回 275 项，`session/modelCatalog` 返回 4 组 14 模型且 0 failure，非法模型/会话仍按预期失败。
- `agentPresets/list` 返回 7 项并发现 `product-quick`；`skills/list` 返回 12 项并发现 model-invocable `shangpin-db`。现场验证未创建会话、未提交 prompt、未调用 Gemini 或真实商品数据库，因此不把部署成功表述为生产提速实测。
