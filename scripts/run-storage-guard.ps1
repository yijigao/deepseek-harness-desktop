param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$MaintenanceScript,
  [Parameter(Mandatory = $true)][string]$ProgramRoot,
  [Parameter(Mandatory = $true)][string]$DesktopRoot,
  [ValidateRange(1, 5)][int]$KeepBackups = 1,
  [ValidateRange(1, 1024)][int]$ThresholdGiB = 20,
  [switch]$IncludeTestTemps,
  [switch]$DryRun,
  [switch]$CheckOnly,
  [switch]$NoNotify
)

$ErrorActionPreference = 'Stop'
if ($IncludeTestTemps) { throw 'IncludeTestTemps is disabled by storage guard policy' }
$maintenanceHome = Join-Path $env:LOCALAPPDATA 'DeepSeekMaintenance'
$logPath = Join-Path $maintenanceHome 'storage-guard.log'
$oldLogPath = Join-Path $maintenanceHome 'storage-guard.log.1'
$statePath = Join-Path $maintenanceHome 'storage-guard-state.json'
$thresholdBytes = [int64]$ThresholdGiB * 1GB
$reminderInterval = [TimeSpan]::FromHours(24)
$mutex = $null
$ownsMutex = $false

function Test-FullyQualifiedPath([string]$Value) {
  return $Value -match '^[A-Za-z]:[\\/]' -or $Value -match '^\\\\[^\\]+\\[^\\]+'
}

function Write-GuardLog([string]$Message) {
  if ($DryRun) { return }
  try {
    if (-not (Test-Path -LiteralPath $maintenanceHome -PathType Container)) {
      New-Item -ItemType Directory -Path $maintenanceHome -Force | Out-Null
    }
    if ((Test-Path -LiteralPath $logPath -PathType Leaf) -and (Get-Item -LiteralPath $logPath).Length -ge 524288) {
      if (Test-Path -LiteralPath $oldLogPath) { Remove-Item -LiteralPath $oldLogPath -Force }
      Move-Item -LiteralPath $logPath -Destination $oldLogPath
    }
    $line = '{0} {1}' -f ([DateTime]::UtcNow.ToString('o')), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  } catch {
    # Diagnostics must never suppress the low-space check or notification.
  }
}

function Read-GuardState {
  $fallback = [pscustomobject]@{ schema = 1; lowSpace = $false; lastNotifiedUtc = $null }
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { return $fallback }
  try {
    $value = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($value.schema -ne 1) { return $fallback }
    $last = $null
    if ($value.lastNotifiedUtc) {
      $parsed = [DateTime]::MinValue
      if ([DateTime]::TryParse([string]$value.lastNotifiedUtc, [ref]$parsed)) { $last = $parsed.ToUniversalTime().ToString('o') }
    }
    return [pscustomobject]@{ schema = 1; lowSpace = ($value.lowSpace -eq $true); lastNotifiedUtc = $last }
  } catch {
    Write-GuardLog 'state=invalid action=reset'
    return $fallback
  }
}

function Save-GuardState($State) {
  if ($DryRun) { return }
  if (-not (Test-Path -LiteralPath $maintenanceHome -PathType Container)) {
    New-Item -ItemType Directory -Path $maintenanceHome -Force | Out-Null
  }
  $temporary = Join-Path $maintenanceHome ('storage-guard-state.{0}.tmp' -f $PID)
  $State | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $statePath -Force
}

function Get-FreeBytes([string]$Path) {
  $absolute = [IO.Path]::GetFullPath($Path)
  $root = [IO.Path]::GetPathRoot($absolute)
  if (-not $root) { throw "Cannot determine volume for DesktopRoot: $Path" }
  return [int64]([IO.DriveInfo]::new($root).AvailableFreeSpace)
}

function Show-LowSpaceNotification([int64]$FreeBytes, [int]$AlertThresholdGiB) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $icon = [System.Windows.Forms.NotifyIcon]::new()
  try {
    $icon.Icon = [System.Drawing.SystemIcons]::Warning
    $icon.Visible = $true
    $icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Warning
    $icon.BalloonTipTitle = 'DeepSeek storage is running low'
    $freeGiB = [Math]::Round($FreeBytes / 1GB, 1)
    $icon.BalloonTipText = "Free space is $freeGiB GiB. The alert threshold is $AlertThresholdGiB GiB."
    $icon.ShowBalloonTip(5000)
    Start-Sleep -Seconds 6
  } finally {
    $icon.Visible = $false
    $icon.Dispose()
  }
}

try {
  $created = $false
  $mutex = [Threading.Mutex]::new($false, 'Local\DeepSeek-StorageGuard', [ref]$created)
  try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
  if (-not $ownsMutex) {
    Write-GuardLog 'result=skipped reason=already-running'
    [pscustomobject]@{ ok = $true; skipped = 'already-running'; dryRun = [bool]$DryRun } | ConvertTo-Json -Compress
    exit 0
  }

  foreach ($required in @($NodePath, $MaintenanceScript, $ProgramRoot, $DesktopRoot)) {
    if (-not (Test-FullyQualifiedPath $required)) { throw "A required path is not absolute: $required" }
  }
  if (-not (Test-Path -LiteralPath $DesktopRoot -PathType Container)) { throw "DesktopRoot not found: $DesktopRoot" }
  $ProgramRoot = [IO.Path]::GetFullPath($ProgramRoot)
  $DesktopRoot = [IO.Path]::GetFullPath($DesktopRoot)
  $MaintenanceScript = [IO.Path]::GetFullPath($MaintenanceScript)

  $summary = [ordered]@{
    attempted = $false
    succeeded = $null
    mode = 'check-only'
    errorType = $null
    exitCode = $null
    blockedReason = $null
  }
  if (-not $CheckOnly) {
    $summary.attempted = $true
    $summary.succeeded = $false
    # SAFETY: --mode auto is destructive; DryRun must remain mapped to preview.
    $summary.mode = if ($DryRun) { 'preview' } else { 'auto' }
    $helperArgs = @(
      $MaintenanceScript,
      '--mode', $summary.mode,
      '--program-root', $ProgramRoot,
      '--desktop-root', $DesktopRoot,
      '--keep-backups', [string]$KeepBackups,
      '--json'
    )
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
      $summary.errorType = 'MissingNodeExecutable'
    } elseif (-not (Test-Path -LiteralPath $MaintenanceScript -PathType Leaf)) {
      $summary.errorType = 'MissingMaintenanceHelper'
    } else {
      $savedPreference = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        $raw = @(& $NodePath @helperArgs 2>$null)
        $helperExitCode = $LASTEXITCODE
      } catch {
        $helperExitCode = $null
        $summary.errorType = 'InvocationFailure'
      } finally {
        $ErrorActionPreference = $savedPreference
      }
      if (-not $summary.errorType -and $helperExitCode -ne 0) {
        $summary.errorType = 'NonZeroExit'
        $summary.exitCode = $helperExitCode
      }
      if (-not $summary.errorType) {
        try { $result = ($raw -join [Environment]::NewLine) | ConvertFrom-Json } catch { $summary.errorType = 'InvalidJson' }
      }
      if (-not $summary.errorType) {
        try {
          if (-not $result.disk -or $null -eq $result.disk.beforeBytes -or $null -eq $result.disk.afterBytes -or $null -eq $result.disk.freedBytes) {
            throw 'missing disk summary'
          }
          foreach ($collection in @('candidates', 'protected', 'skipped')) {
            if ($result.PSObject.Properties.Name -notcontains $collection) { throw "missing $collection" }
          }
          if ([double]$result.disk.beforeBytes -lt 0 -or [double]$result.disk.afterBytes -lt 0 -or [double]$result.disk.freedBytes -lt 0) {
            throw 'invalid disk summary'
          }
          $summary.mode = [string]$result.mode
          $summary.beforeBytes = [int64]$result.disk.beforeBytes
          $summary.afterBytes = [int64]$result.disk.afterBytes
          $summary.freedBytes = [int64]$result.disk.freedBytes
          $summary.candidateCount = @($result.candidates).Count
          $summary.protectedCount = @($result.protected).Count
          $summary.skippedCount = @($result.skipped).Count
          $summary.appliedCount = @($result.applied).Count
          if ($result.PSObject.Properties.Name -contains 'blocked' -and $null -ne $result.blocked) {
            $summary.errorType = 'Blocked'
            $summary.blockedReason = [string]$result.blocked
          } else {
            $summary.succeeded = $true
          }
        } catch {
          $summary.errorType = 'InvalidContract'
        }
      }
    }
    if ($summary.succeeded) {
      Write-GuardLog ('maintenance=success mode={0} beforeBytes={1} afterBytes={2} freedBytes={3} candidates={4} protected={5} skipped={6} applied={7}' -f $summary.mode, $summary.beforeBytes, $summary.afterBytes, $summary.freedBytes, $summary.candidateCount, $summary.protectedCount, $summary.skippedCount, $summary.appliedCount)
    } else {
      Write-GuardLog ('maintenance=failed mode={0} errorType={1} exitCode={2}' -f $summary.mode, $summary.errorType, $(if ($null -eq $summary.exitCode) { '-' } else { $summary.exitCode }))
    }
  }

  $freeBytes = Get-FreeBytes $DesktopRoot
  $state = Read-GuardState
  $isLow = $freeBytes -lt $thresholdBytes
  $now = [DateTime]::UtcNow
  $shouldNotify = $false
  $reason = 'healthy'
  if (-not $isLow) {
    if ($state.lowSpace) { $reason = 'recovered' }
    $state = [pscustomobject]@{ schema = 1; lowSpace = $false; lastNotifiedUtc = $null }
  } else {
    $last = if ($state.lastNotifiedUtc) { [DateTime]::Parse([string]$state.lastNotifiedUtc).ToUniversalTime() } else { $null }
    $shouldNotify = (-not $state.lowSpace) -or ($null -eq $last) -or (($now - $last) -ge $reminderInterval)
    $reason = if ($shouldNotify) { if ($state.lowSpace) { 'reminder-due' } else { 'new-low-space' } } else { 'reminder-rate-limited' }
    $state = [pscustomobject]@{ schema = 1; lowSpace = $true; lastNotifiedUtc = $state.lastNotifiedUtc }
  }

  $notified = $false
  if ($shouldNotify -and -not $NoNotify -and -not $DryRun) {
    try {
      Show-LowSpaceNotification $freeBytes $ThresholdGiB
      $notified = $true
      $state.lastNotifiedUtc = $now.ToString('o')
    } catch {
      Write-GuardLog ('notification=failed errorType={0}' -f $_.Exception.GetType().Name)
    }
  }
  Save-GuardState $state
  Write-GuardLog ('check=complete freeBytes={0} thresholdBytes={1} low={2} notifyEligible={3} notified={4} reason={5}' -f $freeBytes, $thresholdBytes, $isLow, $shouldNotify, $notified, $reason)
  [pscustomobject]@{
    ok = $true
    dryRun = [bool]$DryRun
    checkOnly = [bool]$CheckOnly
    noNotify = [bool]$NoNotify
    freeBytes = $freeBytes
    thresholdBytes = $thresholdBytes
    lowSpace = $isLow
    notificationEligible = $shouldNotify
    notified = $notified
    reason = $reason
    maintenance = $summary
  } | ConvertTo-Json -Depth 4 -Compress
} catch {
  Write-GuardLog ('result=failed errorType={0}' -f $_.Exception.GetType().Name)
  throw
} finally {
  if ($ownsMutex -and $mutex) { $mutex.ReleaseMutex() }
  if ($mutex) { $mutex.Dispose() }
}
