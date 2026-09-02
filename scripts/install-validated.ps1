param(
  [string]$Candidate = '',
  [string]$InstallDir = '',
  [string]$DshHome = '',
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
$backupDir = Join-Path $programs "DeepSeek.pre-update-$stamp"
$failedDir = Join-Path $programs "DeepSeek.failed-update-$stamp"
$validationHome = Join-Path $env:TEMP "deepseek-validation-home-$stamp"
$validationUserData = Join-Path $env:TEMP "deepseek-validation-userdata-$stamp"
$shotName = "deepseek-update-$stamp.png"
$shotPath = Join-Path $env:TEMP $shotName

Log 'Copying candidate beside the installed application'
& robocopy.exe $candidate $releaseDir /E /COPY:DAT /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NP | Out-Host
if ($LASTEXITCODE -ge 8) { throw "Candidate copy failed with robocopy exit $LASTEXITCODE" }

Log 'Running isolated renderer and startup validation'
New-Item -ItemType Directory -Path $validationHome | Out-Null
New-Item -ItemType Directory -Path $validationUserData | Out-Null
$previousDshHome = $env:DSH_HOME
try {
  $env:DSH_HOME = $validationHome
  $validation = Start-Process -FilePath (Join-Path $releaseDir 'DeepSeek.exe') `
    -ArgumentList @("--user-data-dir=$validationUserData", '--verify') -PassThru -Wait
  if ($validation.ExitCode -ne 0) { throw "Candidate renderer validation failed with exit $($validation.ExitCode)" }

  $capture = Start-Process -FilePath (Join-Path $releaseDir 'DeepSeek.exe') `
    -ArgumentList @("--user-data-dir=$validationUserData", "--shot=$shotName") -PassThru -Wait
  if ($capture.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $shotPath) -or (Get-Item -LiteralPath $shotPath).Length -lt 30000) {
    throw 'Candidate screenshot validation failed'
  }
} finally {
  $env:DSH_HOME = $previousDshHome
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

$oldBuild = if (Test-Path -LiteralPath $installDir) { Read-Build $installDir } else { $null }
$newBuild = Read-Build $releaseDir
$oldVersion = [string]$oldBuild.dshVersion
$newVersion = [string]$newBuild.dshVersion
$needsAlpha4Migration = $newVersion -match '^0\.1\.2-alpha\.[4-9]|^0\.1\.[3-9]|^[1-9]\.' `
  -and $oldVersion -and $oldVersion -notmatch '^0\.1\.2-alpha\.[4-9]|^0\.1\.[3-9]|^[1-9]\.'

Log 'Candidate passed; switching installation atomically'
Get-Process -Name DeepSeek -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
if ($needsAlpha4Migration) {
  $cacheBackup = Join-Path $dshHome "migration-backups\alpha4-$stamp"
  New-Item -ItemType Directory -Path $cacheBackup | Out-Null
  foreach ($name in @('session_projcache', 'session_projcache.json')) {
    $source = Join-Path $dshHome "storages\$name"
    if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination $cacheBackup }
  }
  Get-ChildItem -LiteralPath (Join-Path $dshHome 'storages') -Filter 'session_projcache.rebuild-partial-*.json' -ErrorAction SilentlyContinue |
    ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination $cacheBackup }
}

if (Test-Path -LiteralPath $installDir) { Move-Item -LiteralPath $installDir -Destination $backupDir }
try {
  Move-Item -LiteralPath $releaseDir -Destination $installDir
  if (-not $NoRelaunch) {
    Start-Process -FilePath (Join-Path $installDir 'DeepSeek.exe')
    $deadline = (Get-Date).AddSeconds(30)
    $window = $null
    do {
      Start-Sleep -Milliseconds 500
      $window = Get-Process -Name DeepSeek -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.Responding } | Select-Object -First 1
    } until ($window -or (Get-Date) -ge $deadline)
    if (-not $window) { throw 'Updated application did not create a responsive window' }
  }
} catch {
  Log "Activation failed; rolling back: $($_.Exception.Message)"
  Get-Process -Name DeepSeek -ErrorAction SilentlyContinue | Stop-Process -Force
  if (Test-Path -LiteralPath $installDir) { Move-Item -LiteralPath $installDir -Destination $failedDir }
  if (Test-Path -LiteralPath $backupDir) {
    Move-Item -LiteralPath $backupDir -Destination $installDir
    if (-not $NoRelaunch) { Start-Process -FilePath (Join-Path $installDir 'DeepSeek.exe') }
  }
  throw
}

$result = [ordered]@{
  ok = $true
  installed = $installDir
  backup = if (Test-Path -LiteralPath $backupDir) { $backupDir } else { $null }
  screenshot = $shotPath
  dshVersion = $newVersion
  cacheMigrated = [bool]$needsAlpha4Migration
  pinsPreserved = Test-Path -LiteralPath (Join-Path $env:APPDATA 'DeepSeek\session-pins.json')
}
$result | ConvertTo-Json -Depth 3
