param([Parameter(Mandatory = $true)][string]$Candidate)
$ErrorActionPreference = 'Stop'
$candidateRoot = [IO.Path]::GetFullPath($Candidate)
$exe = Join-Path $candidateRoot 'DeepSeek.exe'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Candidate executable missing' }
$contractTool = Join-Path $PSScriptRoot 'verification-contract.cjs'
function Get-ValidationTimeoutMs([string]$Mode) {
  $contract = & node $contractTool $Mode | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or -not $contract.timeoutMs) { throw "Could not read validation timeout contract for $Mode" }
  return [int]$contract.timeoutMs
}
$evidence = Join-Path $env:TEMP ('desktop-release-check-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $evidence | Out-Null
$previousHome = $env:DSH_HOME
$previousTestMode = $env:DSH_TEST_MODE
try {
  $env:DSH_HOME = Join-Path $evidence 'home'
  $env:DSH_TEST_MODE = '1'
  New-Item -ItemType Directory -Path $env:DSH_HOME | Out-Null
  foreach ($mode in @('--verify', '--verify-engine-recovery')) {
    $label = $mode.TrimStart('-')
    $timeoutMs = Get-ValidationTimeoutMs $mode
    $process = Start-Process -FilePath $exe -ArgumentList @("--user-data-dir=$evidence\userdata", $mode) -WindowStyle Hidden -PassThru -RedirectStandardOutput "$evidence\$label.out" -RedirectStandardError "$evidence\$label.err"
    $null = $process.Handle
    if (-not $process.WaitForExit($timeoutMs)) { throw "Isolated $label timed out after $timeoutMs ms; PID $($process.Id); evidence $evidence" }
    if ($process.ExitCode -ne 0) { throw "Isolated $label failed; evidence $evidence" }
    Get-Content -LiteralPath "$evidence\$label.out" -Encoding utf8 | Where-Object { $_ -match '^(VERIFY|ENGINE-RECOVERY-VERIFY)' }
  }
} finally {
  $env:DSH_HOME = $previousHome
  $env:DSH_TEST_MODE = $previousTestMode
}
Write-Output "Release validation evidence: $evidence"
