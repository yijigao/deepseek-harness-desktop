param(
  [Parameter(Mandatory = $true)][string]$Candidate,
  [switch]$UseCurrentSource
)

$ErrorActionPreference = 'Stop'
$candidateRoot = [IO.Path]::GetFullPath($Candidate)
$candidateExe = Join-Path $candidateRoot 'DeepSeek.exe'
if (-not (Test-Path -LiteralPath $candidateExe -PathType Leaf)) { throw 'Candidate executable missing' }
if (-not $UseCurrentSource) { throw 'UseCurrentSource is required so the copied candidate contains the exit-diagnostic entrypoint' }
$repo = Split-Path -Parent $PSScriptRoot
$asarCli = Join-Path $repo 'app\node_modules\@electron\asar\bin\asar.js'
if (-not (Test-Path -LiteralPath $asarCli -PathType Leaf)) { throw 'Local @electron/asar CLI is required for the TEMP-only diagnostic overlay' }

# Keep the runnable copy, all user paths, logs, and Electron crash dumps in
# one disposable TEMP evidence root.  The original candidate is never altered.
$evidence = Join-Path $env:TEMP ('deepseek-exit-diagnostics-' + [guid]::NewGuid().ToString('N'))
$runtimeCopy = Join-Path $evidence 'candidate'
$sourceAppCopy = Join-Path $evidence 'source-app'
$overlayAsar = Join-Path $evidence 'source-overlay.asar'
$profile = Join-Path $evidence 'profile'
$diagnosticTemp = $evidence
$diagnosticHome = Join-Path $profile 'home'
$userData = Join-Path $profile 'userdata'
$appData = Join-Path $profile 'appdata'
$localAppData = Join-Path $profile 'localappdata'
New-Item -ItemType Directory -Path $runtimeCopy,$diagnosticHome,$userData,$appData,$localAppData | Out-Null
& robocopy.exe $candidateRoot $runtimeCopy /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NP | Out-Host
if ($LASTEXITCODE -ge 8) { throw "Candidate copy failed with robocopy exit $LASTEXITCODE" }
# Do not run the source tree directly: stage a source overlay and replace only
# the copied candidate's asar.  Its runtime/junction fixer therefore remains
# entirely under the disposable evidence root.
& robocopy.exe (Join-Path $repo 'app') $sourceAppCopy /E /XD node_modules /R:2 /W:1 /NFL /NDL /NP | Out-Host
if ($LASTEXITCODE -ge 8) { throw "Source overlay copy failed with robocopy exit $LASTEXITCODE" }
& node $asarCli pack $sourceAppCopy $overlayAsar
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $overlayAsar -PathType Leaf)) { throw 'Could not build the TEMP-only source app.asar overlay' }
Copy-Item -LiteralPath $overlayAsar -Destination (Join-Path $runtimeCopy 'resources\app.asar') -Force
$overlaySha256 = (Get-FileHash -LiteralPath $overlayAsar -Algorithm SHA256).Hash

$contract = & node (Join-Path $PSScriptRoot 'verification-contract.cjs') '--verify' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $contract.timeoutMs) { throw 'Could not read the shared validation timeout contract' }
$stdoutPath = Join-Path $evidence 'diagnostic.out.log'
$stderrPath = Join-Path $evidence 'diagnostic.err.log'
$timelinePath = Join-Path $diagnosticTemp 'deepseek-exit-timeline.jsonl'
$dumpRoot = Join-Path $diagnosticTemp 'deepseek-exit-dumps'
function Get-DumpInventory() {
  if (-not (Test-Path -LiteralPath $dumpRoot)) { return @() }
  return @(Get-ChildItem -LiteralPath $dumpRoot -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -in @('.dmp', '.mdmp') } |
    Select-Object Name,Length,CreationTime,LastWriteTime)
}
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = Join-Path $runtimeCopy 'DeepSeek.exe'
$psi.Arguments = (@("--user-data-dir=$userData", '--verify', '--diagnose-verify-exit') | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
$psi.WorkingDirectory = $evidence
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.EnvironmentVariables.Clear()
foreach ($name in @('SystemRoot', 'SystemDrive', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_ARCHITEW6432', 'NUMBER_OF_PROCESSORS', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432')) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ($value) { $psi.EnvironmentVariables[$name] = $value }
}
foreach ($pair in @{
  DSH_HOME = $diagnosticHome; DSH_WORKSPACE = (Join-Path $evidence 'workspace'); DSH_TEST_MODE = '1'; HOME = $diagnosticHome; USERPROFILE = $profile; APPDATA = $appData; LOCALAPPDATA = $localAppData; TEMP = $diagnosticTemp; TMP = $diagnosticTemp
}.GetEnumerator()) { $psi.EnvironmentVariables[$pair.Key] = $pair.Value }

$process = [System.Diagnostics.Process]::Start($psi)
$stdoutFile = [IO.File]::Open($stdoutPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$stderrFile = [IO.File]::Open($stderrPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
$outTask = $process.StandardOutput.BaseStream.CopyToAsync($stdoutFile)
$errTask = $process.StandardError.BaseStream.CopyToAsync($stderrFile)
$timedOut = -not $process.WaitForExit([int]$contract.timeoutMs)
if ($timedOut) {
  $stdoutFile.Flush(); $stderrFile.Flush()
  [pscustomobject]@{ timedOut = $true; pid = $process.Id; timeoutMs = [int]$contract.timeoutMs; evidence = $evidence; dumps = @(Get-DumpInventory); note = 'Process intentionally left running for diagnosis; stdout/stderr files contain data emitted before timeout.' } |
    ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $evidence 'timeout-summary.json') -Encoding utf8
  throw "Exit diagnostics timed out after $($contract.timeoutMs) ms; PID $($process.Id); evidence $evidence"
}
$process.WaitForExit()
$drained = [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($outTask, $errTask), 5000)
$stdoutFile.Dispose(); $stderrFile.Dispose()
$markers = if (Test-Path -LiteralPath $timelinePath) { @(Select-String -LiteralPath $timelinePath -Pattern '"phase":"diagnostics-configured".*"uploadsDisabled":true', '"phase":"verify-emitted"', '"phase":"before-quit"') } else { @() }
$summary = [pscustomobject]@{
  evidence = $evidence
  sourceOverlay = $true
  sourceOverlaySha256 = $overlaySha256
  exitCode = $process.ExitCode
  timeoutMs = [int]$contract.timeoutMs
  dumpRoot = $dumpRoot
  timeline = $timelinePath
  dumps = @(Get-DumpInventory)
  outputDrainCompleted = [bool]$drained
  requiredDiagnosticMarkers = $markers.Count
  coverage = 'Electron crash-reporter dumps cover Electron processes only; they do not prove or exclude a native crash in the separately spawned DSH node process.'
}
$summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $evidence 'diagnostic-summary.json') -Encoding utf8
$summary | ConvertTo-Json -Depth 4
if ($markers.Count -ne 3) { throw "Candidate did not emit the required local exit-diagnostic timeline; evidence $evidence" }
if ($process.ExitCode -ne 0) { throw "Exit diagnostics failed with exit $($process.ExitCode); evidence $evidence" }
