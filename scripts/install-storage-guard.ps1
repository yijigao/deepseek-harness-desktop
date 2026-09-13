param(
  [string]$RepoRoot = '',
  [string]$ProgramRoot = '',
  [string]$DesktopRoot = '',
  [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
  [string]$TaskName = 'DeepSeek-StorageGuard',
  [string]$DailyAt = '12:15',
  [ValidateRange(1, 5)][int]$KeepBackups = 1,
  [ValidateRange(1, 1024)][int]$ThresholdGiB = 20,
  [switch]$IncludeTestTemps,
  [switch]$DryRun,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
if ($TaskName -cne 'DeepSeek-StorageGuard') { throw "TaskName must be exactly 'DeepSeek-StorageGuard'" }
if ($IncludeTestTemps) { throw 'IncludeTestTemps is disabled by storage guard policy' }
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
if (-not $DesktopRoot) { $DesktopRoot = $RepoRoot }
if (-not $ProgramRoot) { $ProgramRoot = Join-Path $env:LOCALAPPDATA 'Programs' }
$DesktopRoot = [IO.Path]::GetFullPath($DesktopRoot)
$ProgramRoot = [IO.Path]::GetFullPath($ProgramRoot)
$NodePath = [IO.Path]::GetFullPath($NodePath)
$sourceRunner = Join-Path $RepoRoot 'scripts\run-storage-guard.ps1'
$helper = Join-Path $RepoRoot 'scripts\release-storage-maintenance.mjs'
$maintenanceHome = Join-Path $env:LOCALAPPDATA 'DeepSeekMaintenance'
$installedRunner = Join-Path $maintenanceHome 'run-storage-guard.ps1'
$powershellPath = Join-Path $PSHOME 'powershell.exe'

function Test-FullyQualifiedPath([string]$Value) {
  return $Value -match '^[A-Za-z]:[\\/]' -or $Value -match '^\\\\[^\\]+\\[^\\]+'
}

function Quote-TaskArgument([string]$Value) {
  if ($Value.Contains('"')) { throw 'Task argument paths cannot contain a double quote' }
  return '"' + $Value + '"'
}

function Get-AccountSid([string]$Account) {
  if ($Account -match '^S-1-') { return $Account }
  return ([Security.Principal.NTAccount]::new($Account)).Translate([Security.Principal.SecurityIdentifier]).Value
}

function Test-KnownTask($Task, [string]$ExpectedUserSid) {
  if ($null -eq $Task -or $Task.TaskPath -cne '\' -or $Task.TaskName -cne $TaskName) { return $false }
  try {
    if ((Get-AccountSid ([string]$Task.Principal.UserId)) -ne $ExpectedUserSid) { return $false }
  } catch { return $false }
  if (([string]$Task.Principal.RunLevel -ne 'Limited') -or -not (@('Interactive', 'InteractiveToken') -contains [string]$Task.Principal.LogonType)) { return $false }
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1 -or -not [string]::Equals([string]$actions[0].Execute, $powershellPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
  $runnerPrefix = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + (Quote-TaskArgument $installedRunner) + ' '
  return ([string]$actions[0].Arguments).StartsWith($runnerPrefix, [StringComparison]::OrdinalIgnoreCase)
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$userId = $identity.Name
$userSid = $identity.User.Value

if ($Uninstall) {
  $plan = [pscustomobject]@{ action = 'uninstall'; taskPath = '\'; taskName = $TaskName; userId = $userId; installedRunner = $installedRunner; dryRun = [bool]$DryRun }
  if ($DryRun) { $plan | ConvertTo-Json -Compress; exit 0 }
  $existing = Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    if (-not (Test-KnownTask $existing $userSid)) { throw "Refusing to uninstall unknown task '\$TaskName'" }
    Unregister-ScheduledTask -TaskPath '\' -TaskName $TaskName -Confirm:$false
    if (Test-Path -LiteralPath $installedRunner -PathType Leaf) { Remove-Item -LiteralPath $installedRunner -Force }
  }
  # Bounded maintenance logs and alert state are intentionally retained for audit.
  $plan | ConvertTo-Json -Compress
  exit 0
}

foreach ($required in @($RepoRoot, $DesktopRoot, $ProgramRoot, $NodePath, $sourceRunner, $helper, $powershellPath)) {
  if (-not (Test-FullyQualifiedPath $required)) { throw "A required path is not absolute: $required" }
}
if (-not (Test-Path -LiteralPath $RepoRoot -PathType Container)) { throw "RepoRoot not found: $RepoRoot" }
if (-not (Test-Path -LiteralPath $DesktopRoot -PathType Container)) { throw "DesktopRoot not found: $DesktopRoot" }
if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw "Node executable not found: $NodePath" }
if (-not (Test-Path -LiteralPath $sourceRunner -PathType Leaf)) { throw "Storage guard runner not found: $sourceRunner" }
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw "Storage maintenance helper not found: $helper" }
$dailyTime = [TimeSpan]::Zero
if (-not [TimeSpan]::TryParseExact($DailyAt, 'hh\:mm', [Globalization.CultureInfo]::InvariantCulture, [ref]$dailyTime)) {
  throw 'DailyAt must use 24-hour HH:mm format'
}

$runnerArgs = @(
  '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
  '-File', (Quote-TaskArgument $installedRunner),
  '-NodePath', (Quote-TaskArgument $NodePath),
  '-MaintenanceScript', (Quote-TaskArgument $helper),
  '-ProgramRoot', (Quote-TaskArgument $ProgramRoot),
  '-DesktopRoot', (Quote-TaskArgument $DesktopRoot),
  '-KeepBackups', [string]$KeepBackups,
  '-ThresholdGiB', [string]$ThresholdGiB
)
$actionArguments = $runnerArgs -join ' '
$plan = [pscustomobject]@{
  action = 'install'
  taskPath = '\'
  taskName = $TaskName
  userId = $userId
  runLevel = 'Limited'
  logonType = 'Interactive'
  triggers = @('logon', "daily-$DailyAt")
  executable = $powershellPath
  arguments = $actionArguments
  installedRunner = $installedRunner
  dryRun = [bool]$DryRun
}
if ($DryRun) { $plan | ConvertTo-Json -Depth 4 -Compress; exit 0 }

$existing = Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing -and -not (Test-KnownTask $existing $userSid)) {
  throw "Refusing to overwrite unknown task '\$TaskName'"
}
New-Item -ItemType Directory -Path $maintenanceHome -Force | Out-Null
Copy-Item -LiteralPath $sourceRunner -Destination $installedRunner -Force
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument $actionArguments
$triggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User $userId),
  (New-ScheduledTaskTrigger -Daily -At ([DateTime]::Today.Add($dailyTime)))
)
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::FromMinutes(30))
try {
  Register-ScheduledTask -TaskPath '\' -TaskName $TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description 'Safe allowlisted DeepSeek release-output maintenance and local low-space notification.' -Force | Out-Null
} catch {
  throw "Unable to register current-user limited interactive scheduled task '\$TaskName'. No startup entry or privilege workaround was created. $($_.Exception.Message)"
}
$registered = Get-ScheduledTask -TaskPath '\' -TaskName $TaskName -ErrorAction Stop
$registeredActions = @($registered.Actions)
$registeredTriggers = @($registered.Triggers)
$logonTriggers = @($registeredTriggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' })
$dailyTriggers = @($registeredTriggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskDailyTrigger' })
$principalMatches = $false
try { $principalMatches = (Get-AccountSid ([string]$registered.Principal.UserId)) -eq $userSid } catch { $principalMatches = $false }
$logonUserMatches = $false
if ($logonTriggers.Count -eq 1) {
  try { $logonUserMatches = (Get-AccountSid ([string]$logonTriggers[0].UserId)) -eq $userSid } catch { $logonUserMatches = $false }
}
$dailyTimeMatches = $false
if ($dailyTriggers.Count -eq 1) {
  try { $dailyTimeMatches = ([DateTime]::Parse([string]$dailyTriggers[0].StartBoundary).TimeOfDay -eq $dailyTime) } catch { $dailyTimeMatches = $false }
}
if (
  $registered.TaskPath -cne '\' -or $registered.TaskName -cne $TaskName -or
  $registeredActions.Count -ne 1 -or
  -not [string]::Equals([string]$registeredActions[0].Execute, $powershellPath, [StringComparison]::OrdinalIgnoreCase) -or
  -not [string]::Equals([string]$registeredActions[0].Arguments, $actionArguments, [StringComparison]::Ordinal) -or
  -not $principalMatches -or [string]$registered.Principal.RunLevel -ne 'Limited' -or
  -not (@('Interactive', 'InteractiveToken') -contains [string]$registered.Principal.LogonType) -or
  $registeredTriggers.Count -ne 2 -or $logonTriggers.Count -ne 1 -or $dailyTriggers.Count -ne 1 -or
  -not (Test-KnownTask $registered $userSid) -or
  -not $logonUserMatches -or
  [int]$dailyTriggers[0].DaysInterval -ne 1 -or -not $dailyTimeMatches
) {
  throw "Scheduled task '\$TaskName' was registered but exact verification failed"
}
$plan | ConvertTo-Json -Depth 4 -Compress
