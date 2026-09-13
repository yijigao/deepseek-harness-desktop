# 商品运营执行能力升级 · 2026-09-11

## 授权与分工

用户批准按建议实施，Astra 负责规划、选择执行代理和复核；同一范围不重复请示。当前仅实现与隔离验证，不执行真实平台采集、调价、上架或付费图片生成，不提交/推送。

规划/复核：`astra_business_plan_0911`（gpt-6-astra）；由它指定 `terra_task_archive_0911`（gpt-5.6-terra, high）实现桌面/CLI，`sol_business_skills_0911`（gpt-5.6-sol, high）实现业务技能/计算。主代理负责集成、插件试点、规则与部署。

## 权威状态契约

- 每个任务仅一个业务 manifest，保持原路径/格式；不批量迁移现有任务。
- `.dsh/task-archives` 保存稳定任务 ID、标题/目标/约束、manifest 定位、可选字段映射、会话引用和验收证据；不复制条目进度或计数。
- JSON 根数组或 `items` 数组、UTF-8 CSV 支持显式字段映射；条目必须有稳定且唯一的 ID，不能以行号代替身份。
- 标准字段 `itemId,status,artifactPath,error,nextAction`；规范状态 `pending,running,needs_review,failed,succeeded`。未知状态待核验，不当作 pending。
- 已验收/锁定由成功状态 + 当前产物 SHA256 匹配验收记录派生；源或产物变化需要重新核验。
- 失败重跑仅产生绑定 manifest 哈希和失败 ID 的计划，不自动调用任何业务 API。
- 标准 JSON 的受控检查点写入使用冲突检测与原子替换；旧格式先只读接入。

## 实施清单

1. [x] 任务档案及批次验收：按需窗口、标题栏轻量入口、安全 IPC、共享 CLI、回归测试；源码真实 Electron 验收通过，安装态另见第 7 项。
2. [x] 竞对可信比价、安全调价技能与确定性离线脚本；17 项回归及业务 CLI→档案验收链路通过。
3. [x] 现有商品库、主图批处理技能适度增强，保持验收标准与唯一进度；统一格式仅用于新批次，旧 CSV 等不迁移。
4. [x] Playwright MCP、Task Passport 隔离试点；Playwright 原生工具注册表调用通过，Task Passport 发布包缺依赖拒绝启用。详见 `plugin-pilot-20260912.md`。
5. [x] 固化 Astra 指派执行代理的使用规则；共同源文件与 Codex/Pi/Harness/Claude 入口同步检查通过。
6. [x] Astra 独立审查、整体验证及 r8/r9 独立候选封装完成；r8 保持封存，修复工作目录后使用 r9。
7. [x] 资料迁出、依赖核验、r9 激活与安装态验收完成；实际窗口和只读 RPC 正常、已安装 CLI E2E 通过、启动后全包校验通过。截图及自动点击受 computer-use 系统接口限制，未宣称完成现场像素/点击验收。

## 当前基线与边界

- 源码：用户脏工作区 `deepseek-harness-desktop`，HEAD `19f71ec`；所有已有改动保留。
- 安装：`C:/Users/yi/AppData/Local/Programs/DeepSeek`，`desktop-2.2.0-alpha2-r9`（2026-09-12 18:14 激活，18:15 启动）。
- 当前可信安装清单 SHA256：`a5d2d3f7dce55677e3ce375ea62444901e41e90c4de3ed9f476f6bccda44e045`。
- 不升级 Harness 引擎，不修改历史会话格式，不改账号路由；保留 Gemini 同源、DeepSeek Flash-only 和已移除 Qwen 的设置。
- 发布依照 `docs/release-updates.md`；技能与 CLI 可先验证/部署，桌面包仅在安全关闭后切换。

## 验证与遗留

2026-09-12 额度恢复后继续，Astra 续接审查代理 `astra_business_review_0912` 确认沿用原路由，执行代理 `terra_archive_resume_0912`、`sol_skills_resume_0912` 从现有产物续做。

- 桌面/CLI 已修复已有档案重开、产物预览哈希绑定、特殊 itemId 记录，并补标准写入保护和栅格预览。Astra 独立 15 项反例、13 项相关回归通过；最终全套 154 项中 151 通过、3 项既有环境跳过；敏感信息扫描通过（158 文件）。
- 真实 Electron 使用生产窗口/preload/IPC，隔离 DSH_HOME、原生选择器合成返回，未启动引擎：绑定、1200x1200 栅格解码、过期产物拒绝、验收、关闭重开、失败计划、非可信页面拒绝均通过。1200px 图像的横向溢出已定点修正，最终文档宽度与视口均 949px。证据 `%TEMP%/desktop-task-window-SdtNoO`；验证脚本 `scripts/verify-task-window-electron.cjs`。
- 业务技能已部署到 `.dsh/skills/competitor-price-compare`、`safe-price-adjust`，离线工具位于 `C:/Users/yi/Documents/Codex/harness-business-ops`。Astra 业务 11 项独立反例、13 项回归与 250 组定价逐分穷举通过；4 个技能结构校验和安装版 Harness 原生技能发现通过。ecom 版本语义保留在 `metadata.version`。
- 业务集成补齐完成：CLI 输出逐项不可变审查报告，供同一 manifest 引用并进入档案验收；禁止覆盖输入或不同内容已有文件。Astra 已复验两种真实业务 CLI 与源码档案 CLI→验收合成链路，17 项回归全过。CLI 已有直接复用 service 的 inspect 薄入口。
- 插件试点完成：Playwright SDK 与安装版 Harness 原生 MCP 注册表均通过合成 DOM 操作；Task Passport 0.3.1 缺失 outbox.js，拒绝正式启用。没有 live profile 改动或常驻进程。
- 重要部署阻碍：安装目录多出 58 项业务/本地企业微信数据/旧备份，另 host-webserver 保留既有 128 KiB Header 热修，原清单整体校验失败。详见 `install-drift-20260912.md`。不删除资料、不重封混合安装、不绕过 PrepareOnly；正式切换需要资料依赖方案和相应授权。
- r8 候选已封存并逐文件验证通过，28,769 项。候选目录：`release-artifacts/desktop-2.2.0-alpha2-r8/win-unpacked`；可信清单 SHA256 `afbecb49f427e1f035a57836499cb148250cd5322ad921bec3f5e2139b1dd2f4`；app.asar SHA256 `50e19850cc6e5c9c74f48afec8dd8c0ed009faf5ce9d7d20d0b6145014d7e84e`。这是独立候选，不是已安装版本。
- 构建输入来自完整验证的封存 r7，只重放现有 Header 热修；candidate/runtime/安装的该 JS 哈希逐字一致。固定源码补丁已回填并全新重放，patchset `3c08a08037f4f1e31d2aa12458222b5c56401cfbb04b2cea8b6d7f7d7ba4250f`；原 patch 字节保持不动，引擎提交/协议/会话读写/工具链不变。实际 HttpServer 的 20 KiB Cookie→204、140 KiB→431 通过，不声称根治 Cookie 积累。
- 候选主窗口与引擎恢复验证通过：`%TEMP%/desktop-release-check-092667f00b5e420d9b2c70c61f7ac305`。打包后任务窗口 9 项检查通过：`%TEMP%/desktop-task-window-NYbwKF`；candidate Node+外置 CLI 业务预览→绑定→inspect→accept 成功：`%TEMP%/business-archive-e2e-1ea9f9c14ad9474293bcf84506e6224f`。
- 源码/asar/外置 CLI service 哈希一致，CLI 与源码相同，候选无 Lab 或安装根目录业务数据。与 r7 相比，asar 仅 main/preload/titlebar 与新增任务模块变化。Astra 最终复核通过；当前安装仍运行且未改。未执行真实采集/调价/图片、未改凭据或会话、未提交/推送。

## 下次恢复入口

不重新实现、不覆盖封存 r8。用户已批准资料保留方案；最新复核 extras 从 58 增至 76 项（69 业务、5 企业微信本地数据、2 维护备份），须以新鲜精确路径/哈希清单为准。85 个会话归属既有 `Documents/DeepSeek`，工作区与会话索引均没有安装路径引用，不迁移或重写聊天历史。已观察 Desktop/相关进程退出，实际写入前仍重新核验。

由 Astra 续接规划/复核，Terra 已实现默认引擎 cwd 为 `Documents/DeepSeek`，验证模式隔离到 TEMP，并补 junction 创建前防护；160 项测试中 157 通过、3 既有跳过。Sol 实现有界恢复工具与合成测试。主代理生成 76 项机器清单、迁移及依赖映射、恢复可信本机登记；新 cwd 修复使用新 r9 封装，不改 r8。企业微信 disabled wrapper 不启用；两处凭据不同、不合并，依赖方案只允许保持原配对并指定迁后目录。安装采用 PrepareOnly/receipt，激活使用 NoRelaunch 避免顺带清理旧备份，随后单独启动验收。

17:55 断点：r9 已封存，28,769 项，清单 SHA256 `a5d2d3f7dce55677e3ce375ea62444901e41e90c4de3ed9f476f6bccda44e045`，app.asar SHA256 `9f29e07fbd24d4bd2d4d3edb768b2aebb6748cbfa00ed1e012720b6c249df90b`。打包任务窗口 9 项通过（`%TEMP%/desktop-task-window-0RneIm`），candidate CLI E2E 通过（`%TEMP%/business-archive-e2e-27f5552ed9ff4c1d98161a1fd94efce0`）。首次冷启动约 80s 超过父脚本 55s，但自行完成全部 VERIFY；原因未确认，不算验收通过。一次 warm 复测的主窗口/引擎恢复均在期限内正常退出（`%TEMP%/desktop-release-check-c332c43ede674c7b89f27c9fe98ffa6a`），未提高超时或强杀。10 项配置/工作区/索引/置顶/另一套企业微信凭据/禁用 wrapper 已快照到 `.dsh/backups/install-recovery-20260912/dependency-snapshot`，DACL 限当前用户、SYSTEM、Administrators。精确 audit/spec 在 `maintenance/install-recovery-*-20260912.json`（gitignored）；spec SHA256 `5184d71a04706f261dbe463f8f38442bb17f4d36aeb3df940a7aa1f1e79dd1c5`。

18:06 后已完成资料迁移：Astra 独立 9 项测试、4 项故障/恢复反例及真实 Windows File.Move/逐目标 ACL 验收通过。生产计划 `.dsh/backups/install-recovery-20260912/plan.json`，canonical SHA256 `43b0711095850594ea14e90d95a8d6cab98c73ab240334fc3c03ae5e3fe0784f`；79 项原字节 snapshot 逐文件通过，receipt SHA256 `a0fb4bfb816a0e56e319b2ab9fc8c837076d7d94f2a5c757abb96c9c58e5d412`。76 项逐叶迁出后完整安装验证成功，本机恢复登记 `desktop-2.2.0-alpha2-r7-adopted-header-20260912`，manifest SHA256 `2b433b371ddac16a5af938272e81249dbf0ca1b06a9399e52b85983772c733e8`；只同步已审 Header/version.releaseId/manifest，不改原封存 r7/r8。

迁后 22 个 Python 的 26 处安装根前缀机械替换，语法全部通过；其余 54 项原字节不变。记录 `.dsh/backups/install-recovery-20260912/script-path-updates.json`。业务根新增 AGENTS 路径映射，恢复目录新增 RECOVERY 说明；历史/索引未改。profile 仅插入 wecomCli.configDir 指向迁后的原5件套，逐字撤销此行等于原版，离线 YAML（!!js 仅作表达式字符串、未求值）解析与结构对比通过，权限/启用状态不变。10 项依赖快照回验通过，其他9项原文件仍原字节。

诊断安全遗留：一次通用 YAML 解析异常将含敏感字段的 profile 片段带入工具诊断输出，已停止输出异常对象/正文，后续仅错误码。未写入发布包或仓库，未自动轮换凭据；已向用户说明，建议另行轮换受影响企业微信机器人密钥。

## r9 已完成交付 · 18:15 后

- 首轮 PrepareOnly 的 Renderer 检查全通过，但退出 `0x80000003`，安装器正确拒绝。未查明原生异常原因，未归因于误杀；一次既有 ResumePreparation 正常退出，Renderer/截图及完整包验证通过。没有第三次重试、重复制或放宽门槛。
- 有效 receipt：`C:/Users/yi/AppData/Local/Programs/DeepSeek.candidate-20260912-180916.ready.json`，SHA256 `2ba0e88d113eb5830dfa2de1e7d6e6829208900fa8db0c8827ef066eece23ca0`；已消费激活，不重复使用。截图 `%TEMP%/deepseek-update-20260912-181245.png` 已视觉复核任务入口/图标/无 Lab。
- 18:14:35 使用 NoRelaunch 安全切换，旧程序保留在 `C:/Users/yi/AppData/Local/Programs/DeepSeek.pre-update-20260912-181421`，未触发额外存储清理。
- 18:15:21 单独启动已安装 r9，18:15:45 窗口 ready（约25秒）；日志实证 cwd=`C:/Users/yi/Documents/DeepSeek`，进程窗口响应正常，r9 releaseId 与哈希匹配。启动后再次完整验证 28,769 文件通过。
- 本地只读 RPC 通过：session/list 200（273项，全局列表，不等于工作区85项），modelCatalog 200（4组14模型，0失败）；未创建/切换/提交会话任务。已安装 Node+CLI 的隔离业务预览→绑定→inspect→accept 全链路通过，证据 `%TEMP%/business-archive-e2e-6e027ae02bdc4a5d8bb6028c3fa5d0eb`。
- 85个会话的 workspace/session_projcache 与 pins、settings、OAuth、全局企业微信另一套凭据、disabled wrapper 启动后仍与原快照逐字一致。迁出76项再验通过：22脚本只前缀变化且语法有效、54项原字节，未操作业务数据库或真实平台。
- computer-use 能读取现场可访问性，确认“任务”按钮、既有置顶会话和 V4.1 Flash；截图刷新重试仍返回 `SetIsBorderRequired ... 0x80004002`，点击返回 `coordinate input geometry is unavailable`，复查仅主窗口仍在、任务按钮可见。停止自动输入，未伪称现场截图/点击验收成功；相同安装字节的候选真实窗口/IPC已单独验收。
- 后续无需重新迁移或打包。用户可直接用原会话继续；旧安装根业务路径按 `Documents/DeepSeek/AGENTS.md` 映射到恢复目录。任务档案按需绑定原清单，不强制转换历史CSV/聊天。保留未解的原生验证退出、首次冷启动耗时、computer-use接口和密钥轮换提醒；不扩范围继续修复。

## 2026-09-12 退出与 computer-use 兼容诊断

- 验证父进程已改用共享分阶段时限契约：每次引擎启动覆盖最多 180 秒 junction repair 与 90 秒 ready 等待，另计渲染/恢复二次启动及 30 秒关闭余量；父脚本不再用旧 55 秒提前误判合法慢启动。startup timeout、VERIFY failure 与 nonzero exit 仍分别处理。
- 新增仅限 TEMP 的 `--diagnose-verify-exit` 入口、JSONL 关闭时间线、流式 stderr、本地 Crashpad dump inventory 与诊断启用标记；不上传 dump、不继承凭据、不改变正常单实例锁或生产关闭行为。
- 一次有效隔离采集完整走到 VERIFY、before-quit、窗口关闭、will-quit、Node exit、quit 与 server child exit；本次未复现 `0x80000003`，stderr 为空且无 dump。VERIFY 的 UI 断言为失败，外层 OS ExitCode 未落盘，因此只证明诊断链路有效，不宣称偶发退出已根治。
- computer-use 根因已定位为 Windows 10 build 19045 不提供 `GraphicsCaptureSession.IsBorderRequired`，当前原生 helper 无条件调用后返回 `0x80004002`；截图失败后点击 geometry 不可用是待截图恢复后复验的后继问题。已提供只读诊断脚本和上游最小兼容契约；本机没有可维护原生源码或更高版本缓存，未热补签名二进制、未改系统权限。
- 复核验证：退出/时限相关定向回归 29/29 通过；Astra 扩展回归累计 37 项及 14 项 TEMP/junction 边界反例通过；`git diff --check` 无错误。生产 r9 未重启、未修改。
