param([string[]]$Modes = @('--verify', '--verify-engine-recovery'), [string]$ConfigHome)
$ErrorActionPreference = 'Stop'
$verifyRoot = Join-Path $env:TEMP ('desktop-alpha2-check-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $verifyRoot | Out-Null
$env:DSH_HOME = Join-Path $verifyRoot 'home'
New-Item -ItemType Directory -Path $env:DSH_HOME | Out-Null
if ($ConfigHome) {
  $resolvedConfig = [IO.Path]::GetFullPath($ConfigHome)
  if (-not $resolvedConfig.StartsWith([IO.Path]::GetFullPath($env:TEMP) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Config home must be isolated under TEMP' }
  if (Test-Path (Join-Path $resolvedConfig 'sessions')) { throw 'Config validation must not load existing sessions' }
  $env:DSH_HOME = $resolvedConfig
}
$verifyExe = Join-Path $PSScriptRoot 'dist-validation-alpha2-desktop\win-unpacked\DeepSeek.exe'
Write-Output "Validation evidence: $verifyRoot"
foreach ($mode in $Modes) {
  $label = $mode.TrimStart('-')
  $proc = Start-Process -FilePath $verifyExe -ArgumentList @("--user-data-dir=$verifyRoot\userdata", $mode) -WindowStyle Hidden -PassThru -RedirectStandardOutput "$verifyRoot\$label.out.log" -RedirectStandardError "$verifyRoot\$label.err.log"
  $null = $proc.Handle
  if (-not $proc.WaitForExit(55000)) { throw "Isolated $label exceeded 55 seconds; PID $($proc.Id)" }
  Write-Output "$label exit=$($proc.ExitCode)"
  Get-Content "$verifyRoot\$label.out.log" -Encoding utf8 | Where-Object { $_ -match '^(VERIFY|ENGINE-RECOVERY-VERIFY)' }
  if ($proc.ExitCode -ne 0) { throw "Isolated $label failed" }
}
