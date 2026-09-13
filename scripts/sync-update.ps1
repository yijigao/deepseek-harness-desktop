# Compatibility tombstone for previously installed Desktop builds.
# Never fetch source, invoke a build, stop Desktop, or change user data here.
param(
  [string]$Relaunch = '',
  [switch]$Silent,
  [string]$Checkout = '',
  [string]$WorkspaceExe = '',
  [switch]$BuildOnly
)
Write-Error 'Source-based updates are retired. Use a verified Desktop release package. No update or source merge was performed. See docs/release-updates.md.'
exit 2
