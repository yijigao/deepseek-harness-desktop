# Desktop 发布与更新

## 最近本机激活：r9 · 2026-09-12

- 已安装 `desktop-2.2.0-alpha2-r9`，可信清单 SHA256 `a5d2d3f7dce55677e3ce375ea62444901e41e90c4de3ed9f476f6bccda44e045`，28,769 项；app.asar SHA256 `9f29e07fbd24d4bd2d4d3edb768b2aebb6748cbfa00ed1e012720b6c249df90b`。
- 包含任务档案/批次验收、共享 CLI，以及稳定业务工作目录：默认 `app.getPath('documents')/DeepSeek`，不再将业务文件写入安装根。显式工作区覆盖拒绝安装/凭据/应用数据目录；验证入口使用 TEMP，junction 越界在创建前拒绝。
- 保留既有128 KiB Header修补和引擎版本/会话格式。安装漂移先经已批准的76项精确迁移恢复可信登记；没有把业务或凭据混入发布清单。资料与依赖细节见 `install-drift-20260912.md`。
- 首轮准备窗口检查通过但原生退出 `0x80000003`，正确拒绝；仅一次 ResumePreparation 正常退出并取得有效receipt。该异常原因未查明，不宣称根治。随后沿原校验流程使用 NoRelaunch 激活，单独启动验收，不顺带清理旧备份。
- 真实启动约25秒，cwd/版本/窗口响应及只读会话/模型RPC通过；已安装CLI完成隔离预览→绑定→检查→验收；启动后全包复验通过。旧程序保留在 `%LOCALAPPDATA%/Programs/DeepSeek.pre-update-20260912-181421`，未迁移或改写历史/置顶。
- computer-use可访问性确认新任务入口，但系统截图/点击接口受限；候选真实UI/IPC的9项验收通过，不把它表述为现场点击成功。完整记录见 `business-upgrade-status-20260911.md`。
- r8继续封存未激活；本次未提交、推送或发布线上版本。

## 已启用的安全边界

`sync-update.ps1` 已退役，只返回错误，不再拉源码、合并、构建或停任务。
源码里的 Desktop 不再把上游版本号当作可安装版本。线上可信发布渠道尚未配置，
因此不会提示从上游直接升级。当前提供的是维护者驱动的本地成品包准备流程，
不是已经上线的后台下载或一键更新服务。

## 固定基线

- `maintenance/baseline.json`：引擎提交、补丁校验值、工具链及兼容性约定。
- `maintenance/harness-alpha2.patch`：从指定上游提交可重放的固定源码补丁集。
  私有会话、凭据、安装目录和未跟踪的提案笔记不在补丁内。
- `maintenance/version.json`：新包的正式版本信息。
- `electron-builder.release.cjs`：独立打包配置，不读取旧的 staging/payload。

`protocol` 是 Desktop 发布流程维护的兼容性编号，不是声称上游提供了稳定协议。
版本发布者必须依据接口和历史格式测试决定是否变更它，不能仅修改编号绕过验证。

重建干净源码：

```powershell
node scripts/prepare-pinned-source.mjs <上游仓库或本地克隆> <不存在的新目录>
```

此步骤已验证补丁能应用且内容一致；不代表全新的依赖解析、编译和分发闭包已做端到端复现。
当前成品打包仍使用已验证的引擎运行时作为输入，不能把它称为完全可复现的源码发布。

## 构建与封装

从 workspace 构建产物准备运行时时，先在全新目录物化 CLI 根文件与按精确包名匹配的
workspace 包；保留包内运行资源和完整 `lib`，不跟随 workspace `node_modules` 链接。
第三方虚拟仓可显式来自同一构建 checkout：

```powershell
node scripts/flatten-runtime.mjs <已物化的新运行时源目录> <独立目标目录> --dependency-root <本次构建checkout根目录>
```

该参数只改变 `node_modules/.pnpm` 的读取位置，不从 dependency root 复制 CLI 或
workspace 构建文件；同名同版本优先采用已物化的源包。根 CLI 的依赖约束优先决定顶层
版本，其他包所需的备用版本按原流程嵌套。原两参数调用仍使用源目录内的 `.pnpm`。
缺少仓、参数错误或目标与输入目录交叠时，在写目标前拒绝；调用者仍须核实物化产物来源、
最终零链接/依赖闭包及关键文件哈希，不能把源码链接目录直接当作发布运行时。

```powershell
$env:DSH_RELEASE_RUNTIME = '<已验证的运行时目录>'
$env:DSH_RELEASE_NODE = '<固定版本的 node.exe>'
cd app
npm ci
npm test
npm run dist
```

打包前校验剪贴板、置顶及隔离运行时启动。输出到 `release-artifacts/<releaseId>`，
已封装的发布不得再次构建覆盖，应先变更 releaseId。
使用 `scripts/test-desktop.ps1 -Candidate <win-unpacked>` 验证隔离窗口与引擎恢复，
不会复制真实会话或凭据，不提交模型任务。

封装不可变文件清单：

```powershell
node scripts/release-package.mjs seal <win-unpacked> maintenance/baseline.json
node scripts/release-package.mjs verify <win-unpacked> <可信清单SHA256>
```

封装不等于测试通过或数字签名。SHA256 必须来自受信任的构建者/发布渠道；
给一个未知下载自行计算哈希，不能证明来源可信。正式线上渠道需要另行配置发布权限和信任机制。
每次内容改变必须使用新的 releaseId；清单不会覆盖已有文件。

## 准备更新，不中断使用

```powershell
node scripts/prepare-release.mjs <新包> <新包可信清单SHA256> <当前安装> <当前可信清单SHA256> <独立缓存目录>
```

校验所有文件，区分 desktop / engine / migration / blocked。普通流程只接受前两种。
这里只准备文件，不启动包内程序，不停止 Desktop，不修改 DSH_HOME。
中断后的完整且哈希匹配文件可以复用；损坏或未知文件拒绝继续，不自动删除。
重复运行已完成的同一准备操作是幂等的。输出 `.prepared.json` 供维护流程使用。
目前缓存仍保存完整包，尚未实现组件级或网络差分下载。

当前安装首次登记需要维护者确认其来源并为其生成清单；正常更新不会自动信任未知安装。
清单绑定静态程序文件，不涵盖用户数据；程序变化后旧清单将失效。

## 切换与数据边界

先让任务安全停止，再由用户关闭 Desktop，然后运行：

```powershell
powershell -File scripts/install-validated.ps1 -Candidate <已准备包> -ManifestSha256 <新清单SHA256> -CurrentManifestSha256 <当前清单SHA256> -SkipNetworkProbe
```

安装器在复制前、复制后和切换前验证。发现 Desktop 仍运行或重新打开时拒绝切换，
不会自动判断业务完成、取消业务或强制杀进程。它保留旧安装目录，启动后禁止自动降级，
因为失败不能证明新引擎从未写入数据。

跨会话格式更新仍须单独提供迁移与恢复方案；不能通过清单参数宣称已完成迁移。
不提供“窗口关闭后自动安装”常驻助手，也不自动回滚用户数据。

## 后台准备与短切换入口

Desktop 正常运行时，维护流程可以执行准备阶段：

```powershell
powershell -File scripts/install-validated.ps1 -PrepareOnly -Candidate <可信新包> -ManifestSha256 <新清单SHA256> -CurrentManifestSha256 <当前清单SHA256> -SkipNetworkProbe
```

该阶段复制到安装目录旁的独立候选目录，完成隔离 Renderer/截图验证及文件校验，
输出 `.ready.json` 和它的 SHA256，随后直接返回，不切换目录、不关闭应用。
这里的“后台”指准备与使用可以并行，不表示已经有桌面内的自动下载按钮或常驻调度器。

任务停止且 Desktop 关闭后，使用准备结果切换：

```powershell
powershell -File scripts/install-validated.ps1 -PreparedReceipt <ready.json> -ReceiptSha256 <可信ready记录SHA256> -SkipNetworkProbe
```

此路径不再复制整包，也不重复启动隔离验证窗口，但保留切换前的完整文件校验及活动写入者检查。
因此不是零等待切换；尚未测得下一次真实不同版本升级的停机时长。
验证记录最长有效七天，绑定当前/候选清单、安装位置、校验工具内容和本机 OS/Node 环境。
记录过期、被改写或工具/环境变化时要求重新准备；相同已安装版本拒绝重复安装。
记录本身不具有数字签名，不能凭任意来源给出的记录与自算哈希跳过验证，可信哈希须由本机维护流程保留。

可信发布下载工具：

```powershell
node scripts/download-release.mjs <可信GitHub发布URL> <可信文件SHA256> <可信字节数> <输出文件>
```

只允许白名单 HTTPS 主机，验证重定向、总大小及 SHA256，支持服务端正确实现 Range 时续传，
异常响应保留部分文件但不发布完成产物，不覆盖已有不同文件，不自动解压或执行。
已下载文件及其完成的 `.partial` 缓存可能共享文件内容，后续使用仍须按可信哈希校验，
不能编辑缓存文件。当前没有配置线上可信版本索引或自动取用账号凭据；下载测试使用合成响应，
不宣称已经从 GitHub 下载过正式更新。

准备被打断或隔离验证失败时，可以在保留候选目录的前提下使用
`-PrepareOnly -ResumePreparation <安装目录旁的候选目录>`，同时提供原候选及可信清单参数。
这会跳过复制、重新检查候选并重跑隔离验证，不把失败当作成功。验证进程的 stdout/stderr
保存到独立 TEMP 验证目录，便于区分页面检查结果与进程退出异常。

### 2026-09-08 两阶段准备演练

- 全套 94 项测试：92 项通过、2 项按环境跳过。新增下载/准备凭据/安装边界的 20 项针对性检查通过。
- 使用当前 r2 同版本演练 `PrepareOnly`，没有执行升级。第一次界面报告 OK，
  但验证进程以 `0x80000003` 退出；流程正确拒绝生成 ready 记录，安装目录未变。
  此原生退出问题的根因仍未确认，不能声称本次已修复。
- 复用 `DeepSeek.candidate-20260908-080103` 重试，未重新复制约 703.50 MiB。
  Renderer 和截图进程正常退出，完整文件检查通过，生成
  `%LOCALAPPDATA%/Programs/DeepSeek.candidate-20260908-080103.ready.json`。
- 记录 SHA256：`8675005febfdf70cb0ac553f64d65125de6e3fc98354e1572dcb2a92488824ab`。
  这是本机同版本演练记录，不是新版本发布授权；旧记录也可能因工具修改失效。
- 验证期间未替换当前安装、未发送业务指令。当前程序清单与置顶文件继续保持原哈希。
- 用真实 ready 记录调用切换入口，正确返回“相同版本已安装，无需重启”，未复制或切换目录。
- 尚未完成：线上版本索引/信任配置、自动解压并核验归档、桌面内更新状态与下载调度，
  以及干净源码到完整运行时的可复现发布链路。当前新增能力是维护工具，不是已上线的一键在线更新。

## 自动化与待完成项

### r6 缓存会话模型控制器归属修复

模型目录原来仅按 SessionId 复用。同一会话的新作用域在旧作用域异步卸载完成前创建时，
新界面会取得旧目录，随后被旧清理释放；继续选择模型可能停留在 selecting，使整个菜单变灰。
r6 同时校验实际作用域身份，旧清理只移除自己拥有的目录与输入阻断，已释放目录拒绝新操作。
重试等待结束后再次校验操作代次；目录刷新不再抹掉模型选择失败，显式重试可以清除错误。

- 真实 Cordis 作用域重叠回归在修复前失败、修复后通过；完整模型选择组件测试 29 项通过。
- Desktop 测试 107 项通过、2 项按环境跳过；敏感信息扫描通过。
- 实际隔离 Electron 请求日志冒烟通过：HTTP 200、start/complete 成对、卸载后 pending 为 0。
- 隔离 Harness 接口验收创建 2 个合成会话并完成 5 次有效模型选择，覆盖引擎重启后的冷恢复；选择耗时 36–336ms，模型任务提交数为 0。证据目录：`%TEMP%/r6-model-rpc-check-haStcM`。
- 新日志只记录当前引擎的创建会话/切换模型 POST 接口、请求编号、耗时和结果，不记录请求内容、会话 ID 或认证 URL。
- 现场旧窗口的全部故障尚未完整复现；已证实并修复的是作用域重叠缺陷，不能将所有挂起归因于它。
- 本机维护只构建 win-unpacked，并沿用清单封存与隔离 PrepareOnly；不生成本次不需要的 NSIS/便携压缩包。部署状态以实际安装记录为准。
- 2026-09-09 05:00（北京时间）使用已验证 receipt 完成 r6 安装和重新启动，返回 `ok: true`；窗口响应正常，启动日志确认 r6，已安装模型选择 bundle 与通过测试的源码 bundle 哈希一致。
- 安装清单 SHA256：`4e69307e4fe9492933e73f4a597dbbf08392479f1f81436a6cdc37b16581b0ea`。旧程序备份：`%LOCALAPPDATA%/Programs/DeepSeek.pre-update-20260909-045919`。
- 未执行会话缓存迁移；置顶文件 SHA256 保持 `129b32434787196922d4d03926932cdfb6cd9e83580988e442ff9a2e9ecd1f51`。真实旧会话的交互效果仍需用户在安装后的窗口确认。

#### 本机自定义预设兼容性修复（2026-09-09，已生效）

- 实际创建接口返回 HTTP 200，但业务结果为 `agent-preset/invalid`；`daily-lite` 的 persona 仍使用旧字段 `text`，安装版要求 `prefix`。旧会话模型选择也因恢复同一预设失败而返回 `gateway/internal`。此前隔离验收未覆盖这两份本机自定义预设。
- 已将 `%USERPROFILE%/.dsh/.agent-presets/` 下 `daily-lite`、`fast-standard` 的 persona `text: |-` 原样迁移为 `prefix: |-`。原文、工具列表和压缩策略保持不变；备份为各目录内的 `agent.cordis.yml.pre-prefix-20260909-051613.bak`。
- 两份配置均通过安装版 `Persona.Config` 校验，并确认相对备份仅改变上述字段。应用原进程已退出后重新启动；没有强制结束进程，没有重装程序或迁移历史会话。
- 重启后自动创建新会话耗时 268ms；只读核验确认会话数 257→258、工作区成员数 70→71。用户连续 6 次模型选择请求耗时 34–51ms，并确认现场测试恢复正常；窗口响应正常，置顶文件哈希不变。诊断未提交任何模型消息。
- 另有未发布源码防护：待处理选择所在作用域退出时，旧目录同步解除 `selecting`，迟到结果不影响替代目录。Terra 实现、Astra 复核；针对性测试 20/20、包级类型检查通过，已保留 r6 现有传输重试策略；未 bundle、未安装，不将现场恢复归因于此补丁。
- 保留项：新会话导航失败目前仍仅输出控制台警告，可见错误提示尚未补齐。本次实际故障已由预设兼容性修复恢复。

### r4 模型切换瞬时失败恢复

确认 `ModelDirectory.select()` 在 `session/selectModel` 的浏览器传输直接抛出异常时，
没有恢复 `selecting` 状态，导致模型菜单永久变灰。r4 对这种“无 Remote 结果”的传输失败
重试相同完整选择一次；选择操作是幂等的，因此首个请求已落地但响应丢失时也会收敛。
若重试仍失败，状态改为 `error` 并解除锁定；服务端明确返回的模型不可用等业务错误不重试。

- 组件针对性测试 13 项通过，其中新增 3 项覆盖重试成功、双失败解除锁定、Remote 错误不重试。
- Desktop 全套测试和敏感信息扫描通过；修复运行时通过默认配置和完整 Web 启动检查。
- r4 清单 SHA256：`6f0d2c174b795201ace04d95f654c9f35f6ee8bc8831a70c4f5f4dd848fd774a`。
- 候选：`%LOCALAPPDATA%/Programs/DeepSeek.candidate-20260909-024512`；隔离 Renderer 和截图通过。
- Ready receipt SHA256：`6d336801b592be4c79c74ec6c878c7e05911849888bff563adc4085e79709e49`。
- 会话格式未变化，无需历史迁移。用户正常退出 r3 后，2026-09-09 02:50 使用已验证
  receipt 完成切换并重新启动，返回 `ok: true`。启动日志确认 r4，安装清单哈希匹配，
  模型选择客户端包含重试/解锁逻辑。置顶文件哈希仍为
  `129b32434787196922d4d03926932cdfb6cd9e83580988e442ff9a2e9ecd1f51`。
  旧程序备份：`%LOCALAPPDATA%/Programs/DeepSeek.pre-update-20260909-025008`。

### r3 图标修复

r2 的 qualified 打包配置遗漏 `resources/icon.ico`，标题栏又从该路径生成图片，
导致安装版显示破图。r3 补齐 ICO 和现有 PNG，标题栏独立读取 PNG；缺失或加载失败时
隐藏图片，不显示破图符号。`--verify` 新增 `logoLoaded` 硬门槛，必须完成图片解码且宽度大于零。
修复只涉及桌面资源，不改变引擎、会话格式或模型配置。部署状态以实际安装记录为准，
源码测试通过不代表正在运行的安装版已经更新。

r3 已构建并完成隔离安装准备：`logoLoaded: true`、Renderer/截图均通过。
候选目录：`%LOCALAPPDATA%/Programs/DeepSeek.candidate-20260908-171803`。
发布清单 SHA256：`6c73c7d638f83a42ab28cc7e1f284ca4c6384225e091be4b566f94f758e64148`。
旁置 `.ready.json` SHA256：`c918928680b173bf3b5a65dca4f81fc1529e17a9d04dfd0cf4c432221205cfe3`。
用户正常退出后，2026-09-08 17:21 使用 PreparedReceipt 完成切换并重新启动，返回 `ok: true`。
启动日志确认安装版为 r3；清单、app.asar、ICO、PNG 哈希全部匹配。
置顶文件 SHA256 仍为 `129b32434787196922d4d03926932cdfb6cd9e83580988e442ff9a2e9ecd1f51`，未迁移会话。
旧程序备份：`%LOCALAPPDATA%/Programs/DeepSeek.pre-update-20260908-172120`。

### 2026-09-08：下载归档安全解压已补齐（维护工具）

下载后的 ZIP 可用以下命令验真、解压，输出 JSON 中的 `candidate` 再交给已有
`prepare-release.mjs` 或安装器的 `-PrepareOnly`。这一步不启动归档中的任何程序。

```powershell
node scripts/extract-release.mjs <ZIP路径> <可信归档SHA256> <可信字节数> <可信清单SHA256> <全新容器目录>
```

- 发布包必须直接以 `desktop-release.json`、`DeepSeek.exe`、`resources/` 为根，
  使用单磁盘、非 ZIP64 的 ZIP（stored/deflate）；不接受自解压 EXE。
- 先检查归档哈希和中央目录上限，再检查所有路径、链接/特殊文件、加密标志、
  大小写/父子路径冲突和 Windows 保留名称。最多 60,000 项、单文件 1 GiB、总展开 2 GiB。
- 流式解压还检查实际输出长度；完整发布清单验真后才将 `.extracting` 改名为 `package`。
  目标容器必须全新，已有目录不会覆盖；失败内容保留在 `.extracting` 供诊断，重试使用新容器。
- 容器及归档应放在当前用户专用维护目录中，不支持与其他写入者共享或并发修改。
  SHA256 保证完整性，可信哈希仍需从独立可信维护记录获取，不能把任意远端提供的哈希当作授权。
- 本轮只修改源码维护工具，没有替换安装版或重启 Desktop，没有修改会话、置顶与业务清单。
- 新增解压回归测试 9 项全部通过；全套 103 项中 101 通过、2 项按环境跳过，敏感信息扫描通过。
- GitHub 只读核对：最新 release 是 2026-08-28 的 `v2.2.0`，附件只有安装/便携 EXE；
  没有当前资格化 ZIP 或签名版本索引，不能直接启用为新在线渠道。
- 线上接入仍需独立受信的验签公钥、签名版本索引（绑定发布序号、版本、架构、大小和双哈希）、
  防降级规则，以及经过验证的 ZIP 发布产物。此次没有创建密钥、提交、推送或发布。

自动归档解压已完成，下面关于全链路发布和桌面调度的待办仍然有效。

GitHub Windows 检查定义已添加：单元测试、敏感信息扫描、固定补丁重放。
该工作流尚未在远端运行，且不是完整源码构建/发布流水线。
后续工作是锁定运行时补全依赖、验证干净源码到运行时的全链路、接入可信成品发布渠道，
再增加后台下载和可见的更新状态。这些未完成项不应被表述为已上线。

## 2026-09-08 本机落地记录

- 固定补丁从全新克隆重放成功，38 个修改文件与被验证源码的 SHA256 逐一匹配。
- 全套单元测试 82 项：80 通过、2 项按环境默认跳过。凭据锁测试随后指定已安装运行时，
  使用合成凭据补测通过。最新安装器和发布工具的 19 项针对性测试通过。
- 新包隔离窗口及引擎恢复均退出 0。证据目录：
  `%TEMP%/desktop-release-check-4a04572192994be6b1bd1b96d711fa8d`。
- 当前安装只登记了静态文件清单，并备份/停用了旧的 resources/sync-update.ps1；
  没有更换正在运行的 app.asar，没有重启或操作真实会话。
- 当前安装登记 ID：`desktop-2.2.0-alpha2-adopted`，28,767 个文件；可信清单 SHA256：
  `72d804457d4a993995845adeb9284cafb908c9a8a64786efbde6bec8e715b5d7`。
- 新包 ID：`desktop-2.2.0-alpha2-r1`，28,765 个文件；可信清单 SHA256：
  `412532ee4c1fcd1d467033a14c4bbefb5cc663684e6f941d20ea8320f5bcd58e`。
- 新包已准备到 `release-artifacts/prepared/desktop-2.2.0-alpha2-r1`，旁边有 `.prepared.json`。
  实际完整包验证得到 `kind: desktop`；无需为这次桌面变化重做历史会话迁移。
- 文件枚举与哈希改为有界并发流式读取，复制也是有界并发；没有通过跳过完整性检查提速。
- 旧脚本备份：`DSH_HOME/backups/20260908-release-updater-retirement/sync-update.ps1`。
  运行中的旧桌面仍可能保留旧提示文案，但其源码更新脚本已不能执行。
- 未提交、推送或发布 GitHub 版本；CI 定义未经过远端运行。
- 用真实候选与可信哈希调用普通安装入口，因 Desktop 仍运行而立即拒绝切换，
  验证了延后保护：退出码 1，未复制替换安装目录、未停止进程。

## r2 激活前复核

- 用户关闭 Desktop 后开始 r1 安装，但最终源码复核发现健康面板仍调用已退役的
  `patch-pi-ai-oauth.mjs`。在任何安装目录替换之前停止了安装器；旧安装清单仍匹配
  `72d804457d4a993995845adeb9284cafb908c9a8a64786efbde6bec8e715b5d7`。
  暂存目录 `DeepSeek.candidate-20260908-074233` 保留用于诊断，没有删除业务数据。
- r2 新增原生凭据组件检测，原生组件存在时不运行旧补丁检查器；缺少旧检查器时
  不将其误报为账号失效。此检测仅说明组件已安装，不代表登录、额度或供应商资格有效。
- 新增 3 项针对性测试；全套 85 项中 83 项通过、2 项按环境跳过。
  构建前的剪贴板、置顶、隔离运行时启动检查通过；敏感信息扫描通过（116 文件）。
- 构建输出改为 releaseId 独立目录，并在发现该目录已有发布清单时拒绝覆盖。
  r1 保持不可变；r2 使用 `release-artifacts/desktop-2.2.0-alpha2-r2/win-unpacked`。

## r2 已启用 — 2026-09-08 07:52

- r2 清单 SHA256：`e08f2213716124a2eea4338f439e8d0917401bbe302af8c157463a46b518c866`。
  独立窗口与引擎恢复检查均退出 0；证据目录
  `%TEMP%/desktop-release-check-548d44503ac84e3aabf7884c8e8aa829`。
- 普通安装器完成复制前、复制后、启动验证后完整性及兼容性校验，最终返回 `ok: true`、
  `cacheMigrated: false`、`pinsPreserved: true`。没有会话迁移，没有发送业务指令。
- 旧程序备份：`%LOCALAPPDATA%/Programs/DeepSeek.pre-update-20260908-074814`。
  已安装清单、app.asar 和置顶文件哈希验证通过；真实主窗口响应正常。
- 启动日志确认新版更新入口已生效：`channel: qualified-artifacts`、
  `status: channel-not-configured`，不再根据上游源码版本发起本机合并与编译。
- 仍有明确性能欠账：本次复制约 703.50 MiB，复制阶段约 74 秒，随后还有重复校验和隔离启动。
  安全切换已启用，但尚不是后台全部准备完毕后的短暂停机更新。后续应将准备阶段前移，
  建立绑定不可变发布的验证凭据，并完成可信发布渠道；不以跳过检查冒充速度提升。

## 2026-09-11 Harness Lab 退役（r7，安装前）

- 删除标题栏 Lab 按钮、主窗口 preload 入口、Lab 窗口、IPC、服务初始化和演示启动分支。
  发布包排除 Lab 前端、专用会话服务及演示数据；这些历史源文件仍供参考和离线测试。
  共享轨迹解析器继续支持模型资源用量统计，不删除用户会话、基线、缓存或报告。
- 不新增常驻替代面板。Lab 未打开时原本没有持续扫描，因此此次不宣称显著模型提速。
- 对照可信 r6 的 app.asar：现有应用源文件中只有本次的 main.js、preload.js、titlebar.js、
  package.json 内容不同。构建沿用已完整验证的 r6 引擎输入，没有升级引擎或修改会话格式。
- 全套 142 项测试：140 通过、0 失败、2 项按环境跳过（合成凭据锁、未打补丁的 alpha.2 客户端输入）。
  新增桥接和主进程加载测试；更新生产包排除断言及实际界面的按钮列表验收。
- 候选实际界面仅包含 settings、resources、recover、min、max、close；Logo 和内容正常，
  无外层滚动溢出。隔离引擎故障后保留窗口和合成草稿，恢复成功。
  证据：`%TEMP%/desktop-release-check-312e4f87675042f5bb7ce34ba1526ce9`。
- 成品 app.asar 已验证不含 Lab 前端、专用服务、demo，保留共享统计依赖；
  Electron 打包环境下的合成用量统计正确返回 150 tokens。
  证据：`%TEMP%/desktop-lab-removal-daffe2f8440a43919136a522319d0a98`。
- r7 不可变发布目录：`release-artifacts/desktop-2.2.0-alpha2-r7/win-unpacked`，28,767 个文件。
  新清单 SHA256：`4e6d46e540855ebf6a0335d4f132c7f2980da6d981f66277681e2246198a41ca`。
  当前 r6 清单 SHA256：`4e69307e4fe9492933e73f4a597dbbf08392479f1f81436a6cdc37b16581b0ea`。
- 此记录不代表安装已切换。需要用户安全停止任务并关闭 Desktop 后，才能按准备记录激活。
  没有强杀应用、复制真实凭据/会话、发送模型请求、提交或推送。
- `PrepareOnly` 已完成，分类为 `desktop`，复制后及隔离启动后的完整性验证通过。
  准备目录：`%LOCALAPPDATA%/Programs/DeepSeek.candidate-20260911-015059`。
  准备记录：`%LOCALAPPDATA%/Programs/DeepSeek.candidate-20260911-015059.ready.json`，
  可信 SHA256：`51adfc9482e646dfda9db03dda86ff0cd33ee8b9efbf468fb5996480e974c95e`。
  已视觉复核 `%TEMP%/deepseek-update-20260911-015059.png`：标题栏无 Lab，剩余控件布局正常。
  截图中的首次使用声明来自隔离空白测试目录，不是用户真实会话。

本次使用以下两阶段入口激活（现已执行，勿重复；准备目录已移动为安装目录）：

```powershell
& .\scripts\install-validated.ps1 -PreparedReceipt 'C:\Users\yi\AppData\Local\Programs\DeepSeek.candidate-20260911-015059.ready.json' -ReceiptSha256 '51adfc9482e646dfda9db03dda86ff0cd33ee8b9efbf468fb5996480e974c95e' -SkipNetworkProbe
```

## r7 已启用 — 2026-09-11 02:00

- 用户确认关闭后，检查 Desktop 和安装引擎进程均已退出，使用上述可信准备记录激活。
  未重新复制整包或重跑候选界面测试；保留了激活前的完整性和活动写入者检查。
- 安装器退出 0，报告 `ok: true`、`cacheMigrated: false`、`pinsPreserved: true`。
  旧安装保留在 `%LOCALAPPDATA%/Programs/DeepSeek.pre-update-20260911-015913`；没有删除旧安装或用户数据。
- 实际安装版本、清单 SHA256 与 r7 一致；安装 app.asar SHA256 与已验证候选一致：
  `d000accdaa5077b09ebf71034942fed53fb48757870ad1256f5bf59aee2df58e`。
  安装包内再次确认 Lab 前端、专用服务及桥接入口已不存在，模型资源和共享统计依赖保留。
- 新进程于 01:59:43 启动，02:00:23 日志记录 `window ready`，主窗口响应正常；
  后续启动日志明确报告 `desktopReleaseId: desktop-2.2.0-alpha2-r7`。
- computer-use 已找到实际安装窗口，但截图接口返回
  `SetIsBorderRequired failed: 不支持此接口 (0x80004002)`；按技能指引刷新目标后，
  无截图的辅助功能读取成功，但仅返回结构节点，无法读取标题栏文字。
  因此未宣称完成真实窗口的视觉验收；移除依据为相同候选的已通过界面验证、安装文件校验与启动记录。
  本次没有修改系统权限或安全设置来绕过截图接口，也没有操作业务会话或发送任务。

## r8 独立候选已封存 — 2026-09-12，尚未激活

- 新增按需任务档案/批次验收窗口、标题栏“任务”入口、共享 Node CLI。已有档案可打开/刷新，验收绑定源行/manifest/产物三哈希，失败重跑只产出计划。详细使用边界见 `task-archives.md`。
- 开发由 Astra 规划/复核，Terra 与 Sol 分工执行。桌面最终 154 项测试中 151 通过、3 项既有环境跳过；独立桌面/业务反例与定价穷举通过，敏感信息扫描通过（158 文件）。
- 原安装含 58 项额外业务/企业微信本地数据/旧备份，且有一处已生效 Header 热修，旧清单整体校验失败。没有删除或移动资料，没有重新封存混合安装，也没有执行 PrepareOnly。详见 `install-drift-20260912.md`。
- 候选来自已完整验真的封存 r7，独立 runtime 仅重放已生效的 128 KiB Header 热修以避免回退。对应固定源码补丁及真实 HTTP 测试已回填并全新重放；20 KiB Cookie 204、140 KiB 431。引擎提交、协议、会话格式与工具链不变；相对原封存 r7，发布分类仍会因补丁集差异记录为 engine，而非声称零运行时差异。
- 候选实际主窗口、引擎故障恢复通过；打包后的任务窗口安全/图片/重开/验收 9 项检查通过；candidate Node 与外置 CLI 完成真实离线预览→绑定→检查→验收（全部使用合成数据与独立临时目录）。没有模型请求或平台写入。
- 不可变候选：`release-artifacts/desktop-2.2.0-alpha2-r8/win-unpacked`，28,769 个文件；可信清单 SHA256 `afbecb49f427e1f035a57836499cb148250cd5322ad921bec3f5e2139b1dd2f4`。封存后完整校验通过。
- app.asar SHA256：`50e19850cc6e5c9c74f48afec8dd8c0ed009faf5ce9d7d20d0b6145014d7e84e`；源码、asar 内与外置 CLI 的任务服务同源。未提交/推送。
- 下一步不是直接替换：须先明确并获准处理资料/工作区依赖、核验安全关闭，再恢复可信安装边界后按既定流程准备与激活。候选验证不等于当前 Desktop 已升级。
