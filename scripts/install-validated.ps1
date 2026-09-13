param(
  [string]$Candidate = '',
  [string]$InstallDir = '',
  [string]$DshHome = '',
  [string]$ManifestSha256 = '',
  [string]$CurrentManifestSha256 = '',
  [switch]$PrepareOnly,
  [string]$ResumePreparation = '',
  [string]$PreparedReceipt = '',
  [string]$ReceiptSha256 = '',
  [switch]$SkipNetworkProbe,
  [switch]$NoRelaunch
)

$ErrorActionPreference = 'Stop'

function Log([string]$Message) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
}

function Read-Build([string]$Root) {
  $path = Join-Path $Root 'resources\version.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } catch { return $null }
}

$repo = Split-Path -Parent $PSScriptRoot
if (-not $Candidate) { $Candidate = Join-Path $repo 'dist\win-unpacked' }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek' }
if (-not $DshHome) { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
$candidate = [System.IO.Path]::GetFullPath($Candidate)
$installDir = [System.IO.Path]::GetFullPath($InstallDir)
$dshHome = [System.IO.Path]::GetFullPath($DshHome)
$programs = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs'))
$installParent = [System.IO.Path]::GetFullPath((Split-Path -Parent $installDir))
if ($installParent -ne $programs) { throw "Refusing install target outside $programs" }
if ($PrepareOnly -and $PreparedReceipt) { throw 'Choose prepare or activate, not both' }
if ($ResumePreparation -and -not $PrepareOnly) { throw 'ResumePreparation is restricted to PrepareOnly' }
$readyTool = Join-Path $PSScriptRoot 'ready-release.mjs'
$validationContractTool = Join-Path $PSScriptRoot 'verification-contract.cjs'
function Get-ValidationTimeoutMs([string]$Mode) {
  $contract = & node $validationContractTool $Mode | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $contract.timeoutMs) { throw "Could not read validation timeout contract for $Mode" }
  return [int]$contract.timeoutMs
}
if ($PreparedReceipt) {
  $readyOutput = & node $readyTool check $PreparedReceipt $ReceiptSha256 $installDir
  if ($LASTEXITCODE -ne 0) { throw 'Prepared release receipt is not valid; prepare again' }
  $ready = $readyOutput | ConvertFrom-Json
  $candidate = [IO.Path]::GetFullPath($ready.candidate)
  $ManifestSha256 = $ready.manifestSha256
  $CurrentManifestSha256 = $ready.currentManifestSha256
}

# A normal update never guesses data compatibility, compiles source, or stops
# an active task. Cross-format upgrades require a separate migration procedure.
if (-not $ManifestSha256 -or -not $CurrentManifestSha256) { throw 'Trusted candidate and current release manifest hashes are required' }
$verifyRelease = Join-Path $PSScriptRoot 'verify-update.mjs'
$activeInstallation = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir + '\', [StringComparison]::OrdinalIgnoreCase)
})
if (-not $PrepareOnly -and $activeInstallation.Count) { throw 'Update deferred: close Desktop after your tasks have safely stopped; nothing has been replaced' }
if (-not $PrepareOnly -and $ManifestSha256 -eq $CurrentManifestSha256) { throw 'This exact release is already installed; no restart is needed' }
if (-not $PreparedReceipt) {
  & node $verifyRelease $candidate $ManifestSha256 $installDir $CurrentManifestSha256
  if ($LASTEXITCODE -ne 0) { throw 'Release integrity or compatibility check failed' }
}

$required = @(
  'DeepSeek.exe',
  'resources\app.asar',
  'resources\node.exe',
  'resources\runtime\lib\bin.js',
  'resources\tools\model-resource-probe.mjs'
)
foreach ($relative in $required) {
  if (-not (Test-Path -LiteralPath (Join-Path $candidate $relative) -PathType Leaf)) {
    throw "Candidate is incomplete: $relative"
  }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$releaseDir = Join-Path $programs "DeepSeek.candidate-$stamp"
if ($ResumePreparation) {
  $releaseDir = [IO.Path]::GetFullPath($ResumePreparation)
  if ((Split-Path -Parent $releaseDir) -ne $programs -or (Split-Path -Leaf $releaseDir) -notmatch '^DeepSeek\.candidate-[a-zA-Z0-9-]+$') { throw 'Resume target must be an isolated candidate beside the installation' }
}
$backupDir = Join-Path $programs "DeepSeek.pre-update-$stamp"
$failedDir = Join-Path $programs "DeepSeek.failed-update-$stamp"
$validationHome = Join-Path $env:TEMP "deepseek-validation-home-$stamp"
$validationUserData = Join-Path $env:TEMP "deepseek-validation-userdata-$stamp"
$shotName = "deepseek-update-$stamp.png"
$shotPath = Join-Path $env:TEMP $shotName

if ($PreparedReceipt) {
  $releaseDir = $candidate
  $shotPath = $null
  Log 'Using the validated installation-sibling package; no foreground copy or repeated renderer launch'
} else {
if (-not $ResumePreparation) {
Log 'Copying candidate beside the installed application'
& robocopy.exe $candidate $releaseDir /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NP | Out-Host
if ($LASTEXITCODE -ge 8) { throw "Candidate copy failed with robocopy exit $LASTEXITCODE" }
} else { Log 'Resuming the existing candidate; preserving files and rerunning validation' }
& node $verifyRelease $releaseDir $ManifestSha256 $installDir $CurrentManifestSha256
if ($LASTEXITCODE -ne 0) { throw 'Copied release failed integrity verification' }

Log 'Running isolated renderer and startup validation'
New-Item -ItemType Directory -Path $validationHome | Out-Null
New-Item -ItemType Directory -Path $validationUserData | Out-Null
$previousDshHome = $env:DSH_HOME
$previousDshTestMode = $env:DSH_TEST_MODE
try {
  $env:DSH_HOME = $validationHome
  $env:DSH_TEST_MODE = '1'
  $rendererTimeoutMs = Get-ValidationTimeoutMs '--verify'
  $validation = Start-Process -FilePath (Join-Path $releaseDir 'DeepSeek.exe') `
    -ArgumentList @("--user-data-dir=$validationUserData", '--verify') -WindowStyle Hidden -PassThru -RedirectStandardOutput "$validationHome\renderer.out.log" -RedirectStandardError "$validationHome\renderer.err.log"
  $null = $validation.Handle
  if (-not $validation.WaitForExit($rendererTimeoutMs)) { throw "Candidate renderer validation timed out after $rendererTimeoutMs ms; isolated PID $($validation.Id)" }
  if ($validation.ExitCode -ne 0) { throw "Candidate renderer validation failed with exit $($validation.ExitCode)" }

  $screenshotTimeoutMs = Get-ValidationTimeoutMs '--shot'
  $capture = Start-Process -FilePath (Join-Path $releaseDir 'DeepSeek.exe') `
    -ArgumentList @("--user-data-dir=$validationUserData", "--shot=$shotName") -WindowStyle Hidden -PassThru -RedirectStandardOutput "$validationHome\screenshot.out.log" -RedirectStandardError "$validationHome\screenshot.err.log"
  $null = $capture.Handle
  if (-not $capture.WaitForExit($screenshotTimeoutMs)) { throw "Candidate screenshot validation timed out after $screenshotTimeoutMs ms; isolated PID $($capture.Id)" }
  if ($capture.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $shotPath) -or (Get-Item -LiteralPath $shotPath).Length -lt 30000) {
    throw 'Candidate screenshot validation failed'
  }
} finally {
  $env:DSH_HOME = $previousDshHome
  $env:DSH_TEST_MODE = $previousDshTestMode
}

if (-not $SkipNetworkProbe -and (Test-Path -LiteralPath (Join-Path $dshHome 'oauth-credentials.json'))) {
  Log 'Checking authenticated model network through the configured rule proxy'
  $probeOutput = & (Join-Path $releaseDir 'resources\node.exe') --use-env-proxy `
    (Join-Path $releaseDir 'resources\tools\model-resource-probe.mjs') `
    (Join-Path $releaseDir 'resources\runtime') $dshHome
  if ($LASTEXITCODE -ne 0) { throw 'Model network probe did not complete' }
  $probe = $probeOutput | ConvertFrom-Json
  if (-not $probe.ok) { throw "Model network probe failed: $($probe.code)" }
}
}

$oldBuild = if (Test-Path -LiteralPath $installDir) { Read-Build $installDir } else { $null }
$newBuild = Read-Build $releaseDir
$oldVersion = [string]$oldBuild.dshVersion
$newVersion = [string]$newBuild.dshVersion
$classificationOutput = & node $verifyRelease $releaseDir $ManifestSha256 $installDir $CurrentManifestSha256
if ($LASTEXITCODE -ne 0) { throw 'Release changed during validation; installation untouched' }
$classification = $classificationOutput | ConvertFrom-Json
if ($PrepareOnly) {
  $receiptPath = "$releaseDir.ready.json"
  & node $readyTool record $receiptPath $releaseDir $ManifestSha256 $installDir $CurrentManifestSha256 $classification.kind
  if ($LASTEXITCODE -ne 0) { throw 'Could not record preparation; no installation change was made' }
  return
}
Log 'Candidate passed; switching installation atomically'
$installedExe = Join-Path $installDir 'DeepSeek.exe'
$desktopProcesses = @(Get-Process -Name DeepSeek -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installedExe })
if ($desktopProcesses.Count) { throw 'Desktop was reopened during preparation; update deferred' }
# Electron may exit while its engine still holds the live session writer.
# Never force-kill it or replace the runtime underneath that writer.
$remainingWriters = @(Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installDir + '\', [StringComparison]::OrdinalIgnoreCase)) -or
  ($_.Name -match '^node(\.exe)?$' -and $_.CommandLine -and
    $_.CommandLine.IndexOf((Join-Path $installDir 'resources\runtime'), [StringComparison]::OrdinalIgnoreCase) -ge 0)
})
if ($remainingWriters.Count) { throw 'An installed engine process is still running; installation has not been replaced' }
if (Test-Path -LiteralPath $installDir) { Move-Item -LiteralPath $installDir -Destination $backupDir }
$activationMayHaveWritten = $false
try {
  Move-Item -LiteralPath $releaseDir -Destination $installDir
  if (-not $NoRelaunch) {
    # Fence before process creation: even a failed Start-Process result cannot
    # prove that the new engine never opened or migrated a live session.
    $activationMayHaveWritten = $true
    Start-Process -FilePath (Join-Path $installDir 'DeepSeek.exe') -WindowStyle Hidden
    # The engine's own authenticated-start deadline is 90 seconds. Real user
    # state took 67 seconds on this host; do not roll back a still-valid startup.
    $deadline = (Get-Date).AddSeconds(120)
    $window = $null
    do {
      Start-Sleep -Milliseconds 500
      $window = Get-Process -Name DeepSeek -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $installedExe -and $_.MainWindowHandle -ne 0 -and $_.Responding } | Select-Object -First 1
    } until ($window -or (Get-Date) -ge $deadline)
    if (-not $window) { throw 'Updated application did not create a responsive window' }
  }
} catch {
  if ($activationMayHaveWritten) {
    Log "Activation could have written live session data; retaining the new runtime and backup: $backupDir"
    Log 'Automatic downgrade is disabled after launch. Diagnose or retry this runtime; do not start the backup engine against live data.'
    throw
  }
  Log "Activation failed; rolling back: $($_.Exception.Message)"
  if (Test-Path -LiteralPath $installDir) { Move-Item -LiteralPath $installDir -Destination $failedDir }
  if (Test-Path -LiteralPath $backupDir) {
    Move-Item -LiteralPath $backupDir -Destination $installDir
    if (-not $NoRelaunch) { Start-Process -FilePath (Join-Path $installDir 'DeepSeek.exe') -WindowStyle Hidden }
  }
  throw
}

$result = [ordered]@{
  ok = $true
  installed = $installDir
  backup = if (Test-Path -LiteralPath $backupDir) { $backupDir } else { $null }
  screenshot = $shotPath
  dshVersion = $newVersion
  cacheMigrated = $false
  pinsPreserved = Test-Path -LiteralPath (Join-Path $env:APPDATA 'DeepSeek\session-pins.json')
}
if (-not $NoRelaunch) {
  # Storage maintenance is post-activation hygiene only: a launch failure must
  # never alter the successfully activated installation result.
  try {
    $maintenanceArgs = @(
      (Join-Path $PSScriptRoot 'release-storage-maintenance.mjs'), '--mode', 'auto',
      '--program-root', $programs, '--desktop-root', $repo
    ) | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
    Start-Process -FilePath 'node.exe' -ArgumentList ($maintenanceArgs -join ' ') -WindowStyle Hidden | Out-Null
  } catch { Log "Automatic storage maintenance did not start: $($_.Exception.Message)" }
}
$result | ConvertTo-Json -Depth 3
