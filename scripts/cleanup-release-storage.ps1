param(
  [switch]$Execute,
  [int]$KeepBackups = 1,
  [switch]$IncludeTestTemps,
  [string]$ProgramRoot = '',
  [string]$DesktopRoot = '',
  [string]$ApprovedPlan = '',
  [string]$WritePlan = '',
  [string]$AuditPath = ''
)

$ErrorActionPreference = 'Stop'
if ($KeepBackups -lt 1 -or $KeepBackups -gt 5) { throw 'KeepBackups must be between 1 and 5' }
$repo = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $ProgramRoot) { $ProgramRoot = Join-Path $env:LOCALAPPDATA 'Programs' }
if (-not $DesktopRoot) { $DesktopRoot = $repo }
$args = @((Join-Path $PSScriptRoot 'release-storage-maintenance.mjs'), '--mode', $(if ($Execute) { 'execute' } else { 'preview' }), '--keep-backups', $KeepBackups, '--program-root', [IO.Path]::GetFullPath($ProgramRoot), '--desktop-root', [IO.Path]::GetFullPath($DesktopRoot))
if ($Execute) { $args += '--confirm-execute' }
if ($IncludeTestTemps) { throw 'Test temporary cleanup is disabled' }
if ($Execute -and -not $ApprovedPlan) { throw 'Execute requires an approved preview plan' }
if ($ApprovedPlan) { $args += @('--approved-plan', [IO.Path]::GetFullPath($ApprovedPlan)) }
if ($WritePlan) { $args += @('--write-plan', [IO.Path]::GetFullPath($WritePlan)) }
if ($AuditPath) { $args += @('--audit-path', [IO.Path]::GetFullPath($AuditPath)) }
& node @args
exit $LASTEXITCODE
