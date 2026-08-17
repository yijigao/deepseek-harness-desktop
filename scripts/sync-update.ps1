# Rebuild DeepSeek Harness, package the desktop app, and optionally reinstall it.
# Usage: powershell -ExecutionPolicy Bypass -File sync-update.ps1
#   [-Checkout <upstream checkout>] [-WorkspaceExe <portable output>]
#   [-Relaunch <exe>] [-Silent] [-BuildOnly]
param(
  [string]$Relaunch = '',
  [switch]$Silent,
  [string]$Checkout = '',
  [string]$WorkspaceExe = '',
  [switch]$BuildOnly
)

$ErrorActionPreference = 'Continue'
$logPath = Join-Path $env:TEMP 'deepseek-update.log'
function Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Add-Content -Path $logPath -Value $line -Encoding UTF8
  Write-Host $line
}

$dshexe = Split-Path -Parent $PSScriptRoot
if (-not $Checkout) {
  $Checkout = if ($env:DEEPSEEK_HARNESS_CHECKOUT) { $env:DEEPSEEK_HARNESS_CHECKOUT } else { Join-Path (Split-Path -Parent $dshexe) 'deepseek-harness' }
}
$checkout = [System.IO.Path]::GetFullPath($Checkout)
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
if (-not $node -or -not $git -or -not $pnpm) {
  Log 'Missing prerequisite: node, git and pnpm must all be available on PATH.'
  exit 2
}
$staging    = Join-Path $dshexe 'staging'
$runtime    = Join-Path $staging 'runtime'
$payloadRt  = Join-Path $staging 'payload\runtime'
$distDir    = Join-Path $dshexe 'dist'
$workspaceExe = if ($WorkspaceExe) { [System.IO.Path]::GetFullPath($WorkspaceExe) } else { Join-Path $dshexe 'DeepSeek-Desktop.exe' }
$installedExe = "$env:LOCALAPPDATA\Programs\DeepSeek\DeepSeek.exe"
$appRunning  = [bool](Get-Process -Name 'DeepSeek' -ErrorAction SilentlyContinue)

Log "=== sync-update start (Silent=$Silent, BuildOnly=$BuildOnly, Relaunch=$Relaunch, appRunning=$appRunning) ==="

# 构建阶段对运行中的应用无害（它只用已安装的 resources，不用 dist/payload）；
# 只有「重装」和「重启」受运行状态限制。

# ── 1. git 同步 ──────────────────────────────────────────────────────────────
if (-not (Test-Path (Join-Path $checkout '.git'))) { Log "checkout missing: $checkout"; exit 2 }
& $git -C $checkout fetch origin 2>&1 | ForEach-Object { Log "git: $_" }
if ($LASTEXITCODE -ne 0) { Log 'git fetch failed'; exit 2 }
$local  = (& $git -C $checkout rev-parse HEAD).Trim()
$remoteRef = (& $git -C $checkout symbolic-ref refs/remotes/origin/HEAD 2>$null).Trim() -replace '^refs/remotes/', ''
if (-not $remoteRef) { $remoteRef = 'origin/master' }
$remote = (& $git -C $checkout rev-parse $remoteRef).Trim()
if ($local -eq $remote) {
  Log "already up to date ($($local.Substring(0,8)))"
  if (-not $BuildOnly) { exit 0 }
}
Log "new commits: $($local.Substring(0,8)) -> $($remote.Substring(0,8))"

$lockBefore = (Get-FileHash (Join-Path $checkout 'pnpm-lock.yaml') -ErrorAction SilentlyContinue).Hash
& $git -C $checkout merge --ff-only $remoteRef 2>&1 | ForEach-Object { Log "git: $_" }
if ($LASTEXITCODE -ne 0) {
  Log 'git pull failed (non-fast-forward?) — manual merge required'
  exit 2
}
$lockAfter = (Get-FileHash (Join-Path $checkout 'pnpm-lock.yaml') -ErrorAction SilentlyContinue).Hash
if ($lockBefore -ne $lockAfter) {
  Log 'lockfile changed — running pnpm install'
  Push-Location $checkout
  & $pnpm install --prefer-offline 2>&1 | ForEach-Object { Log "pnpm: $_" }
  Pop-Location
}

# ── 2. 重建前端 ──────────────────────────────────────────────────────────────
Log 'building web frontend'
Push-Location $checkout
& $pnpm run build:web 2>&1 | ForEach-Object { Log "build:web: $_" }
Pop-Location
if ($LASTEXITCODE -ne 0) { Log 'build:web failed'; exit 3 }

# ── 3. 重建运行时闭包 ────────────────────────────────────────────────────────
Log 'deploying runtime closure'
Remove-Item -Recurse -Force $runtime -ErrorAction SilentlyContinue
& $pnpm --filter @deepseek-ai/dsh deploy --legacy --prod $runtime 2>&1 | ForEach-Object { Log "deploy: $_" }
if (-not (Test-Path (Join-Path $runtime 'lib\bin.js'))) { Log 'deploy produced no runtime'; exit 4 }

Log 'augmenting runtime (peers)'
& $node (Join-Path $dshexe 'scripts\augment-runtime.mjs') $runtime $checkout 2>&1 | ForEach-Object { Log "augment: $_" }
Log 'augmenting runtime (registry deps)'
& $node (Join-Path $dshexe 'scripts\augment-deps.mjs') $runtime 2>&1 | ForEach-Object { Log "augdeps: $_" }

Log 'flattening runtime'
$runtimeNew = Join-Path $staging 'runtime-new'
Remove-Item -Recurse -Force $runtimeNew -ErrorAction SilentlyContinue
& $node (Join-Path $dshexe 'scripts\flatten-runtime.mjs') $runtime $runtimeNew 2>&1 | ForEach-Object { Log "flatten: $_" }
if (-not (Test-Path (Join-Path $runtimeNew 'lib\bin.js'))) { Log 'flatten produced no runtime'; exit 5 }

# 订阅模型接入（可选项，但默认开启）：给 dsh-llm-pi-ai 适配器注入文件持久化
# OAuth 存储，让 openai-codex（ChatGPT 订阅）等 OAuth-only 路由可登录使用。
# 幂等：原版文件备份为 index.js.oauth-bak；上游改动导致锚点失配时构建失败，避免静默半补丁。
Log 'patching pi-ai OAuth credential seam'
& $node (Join-Path $dshexe 'scripts\patch-pi-ai-oauth.mjs') $runtimeNew 2>&1 | ForEach-Object { Log "patch-pi-ai: $_" }
if ($LASTEXITCODE -ne 0) { Log 'pi-ai OAuth patch FAILED — aborting build'; exit 9 }

Log 'smoke-testing flattened runtime'
& $node (Join-Path $dshexe 'scripts\test-runtime.mjs') $runtimeNew 2>&1 | ForEach-Object { Log "test: $_" }
if ($LASTEXITCODE -ne 0) { Log 'runtime smoke test FAILED — keeping current runtime'; exit 6 }

# swap in the new runtime
$payloadOld = Join-Path $staging 'runtime-old'
Remove-Item -Recurse -Force $payloadOld -ErrorAction SilentlyContinue
Move-Item $payloadRt $payloadOld
Move-Item $runtimeNew $payloadRt
Remove-Item -Recurse -Force $payloadOld -ErrorAction SilentlyContinue

# ── 4. 版本信息 + 打 exe ─────────────────────────────────────────────────────
Log 'writing version.json'
$appVersion = (Get-Content (Join-Path $dshexe 'app\package.json') -Raw | ConvertFrom-Json).version
& $node (Join-Path $dshexe 'scripts\gen-version.mjs') (Join-Path $staging 'payload') $appVersion 2>&1 | ForEach-Object { Log "version: $_" }
Copy-Item (Join-Path $dshexe 'app\fix-junctions.js') (Join-Path $staging 'payload\fix-junctions.js') -Force
Copy-Item (Join-Path $dshexe 'app\build\icon.ico') (Join-Path $staging 'payload\icon.ico') -Force
Copy-Item (Join-Path $dshexe 'scripts\sync-update.ps1') (Join-Path $staging 'payload\sync-update.ps1') -Force
Copy-Item (Join-Path $dshexe 'scripts\patch-pi-ai-oauth.mjs') (Join-Path $staging 'payload\patch-pi-ai-oauth.mjs') -Force

Log 'building exes (electron-builder)'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
Push-Location (Join-Path $dshexe 'app')
& $node (Join-Path $dshexe 'app\node_modules\electron-builder\out\cli\cli.js') --win 2>&1 | ForEach-Object { Log "builder: $_" }
Pop-Location
if ($LASTEXITCODE -ne 0) { Log 'electron-builder failed'; exit 7 }

# ── 5. 发布产物 ──────────────────────────────────────────────────────────────
$portable = Get-ChildItem $distDir -Filter '*portable.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($portable) {
  Copy-Item $portable.FullName $workspaceExe -Force
  Log "workspace exe updated: $workspaceExe"
} else { Log 'no portable artifact found'; exit 8 }

if (-not $BuildOnly -and -not $appRunning) {
  $setup = Get-ChildItem $distDir -Filter 'DeepSeek-Setup-*.exe' | Where-Object { $_.Name -notmatch '__uninstaller' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($setup) {
    Log 'reinstalling'
    $p = Start-Process $setup.FullName -ArgumentList '/S' -Wait -PassThru
    Log "installer exit: $($p.ExitCode)"
  }
} elseif (-not $BuildOnly -and -not $Silent) {
  Log 'app is running — skipping reinstall (interactive mode quits the app first, so this should not happen)'
}

if ($Relaunch -and (Test-Path $Relaunch)) {
  Log "relaunching $Relaunch"
  Start-Process $Relaunch
}

Log '=== sync-update finished ==='
exit 0
