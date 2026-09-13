param([switch]$Verify)
$ErrorActionPreference = 'Stop'
$backupRoot = 'C:\Users\yi\.dsh\backups\install-recovery-20260912'
$snapshotRoot = Join-Path $backupRoot 'dependency-snapshot'
$installRoot = 'C:\Users\yi\AppData\Local\Programs\DeepSeek'

function Assert-NoReparse([string]$Target) {
  $cursor = [IO.Path]::GetFullPath($Target)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse component: $cursor" }
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}

Assert-NoReparse $backupRoot
Assert-NoReparse $snapshotRoot
$items = @(
  @{ Name='profile-web.yml'; Source='C:\Users\yi\.dsh\profiles\web\cordis.patch.yml'; ChangesAllowed=$true },
  @{ Name='settings.yaml'; Source='C:\Users\yi\.dsh\settings.yaml' },
  @{ Name='credentials.yaml'; Source='C:\Users\yi\.dsh\.credentials.yaml' },
  @{ Name='oauth-credentials.json'; Source='C:\Users\yi\.dsh\oauth-credentials.json' },
  @{ Name='workspace.json'; Source='C:\Users\yi\.dsh\storages\workspace.json' },
  @{ Name='session_projcache.json'; Source='C:\Users\yi\.dsh\storages\session_projcache.json' },
  @{ Name='session-pins.json'; Source='C:\Users\yi\AppData\Roaming\DeepSeek\session-pins.json' },
  @{ Name='global-wecom-encryption-key'; Source='C:\Users\yi\.dsh\wecom-cli\.encryption_key' },
  @{ Name='global-wecom-credentials.enc'; Source='C:\Users\yi\.dsh\wecom-cli\credentials.enc' },
  @{ Name='disabled-wecom-cli.cmd'; Source='C:\Users\yi\.dsh\wecom-cli-bin\wecom-cli.cmd' }
)
$receiptPath = Join-Path $snapshotRoot 'receipt.json'
if ($Verify) {
  $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $results = foreach ($row in $receipt.files) {
    $copy = Join-Path $snapshotRoot $row.name
    Assert-NoReparse $row.source
    Assert-NoReparse $copy
    if ((Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant() -ne $row.sha256) { throw "Dependency snapshot changed: $($row.name)" }
    $same = (Get-FileHash -LiteralPath $row.source -Algorithm SHA256).Hash.ToLowerInvariant() -eq $row.sha256
    if (-not $same -and -not $row.changesAllowed) { throw "Protected dependency changed: $($row.name)" }
    [pscustomobject]@{ name=$row.name; unchanged=$same; snapshotVerified=$true }
  }
  [pscustomobject]@{ ok=$true; results=@($results) } | ConvertTo-Json -Depth 5
  return
}
if (Test-Path -LiteralPath $receiptPath) { throw 'Dependency snapshot already recorded; use -Verify' }
$writers = @(Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot+'\',[StringComparison]::OrdinalIgnoreCase)) -or
  ($_.Name -match '^(node|python|pythonw)\.exe$' -and $_.CommandLine -and $_.CommandLine.IndexOf($installRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0)
})
if ($writers.Count) { throw 'Installed task writer is running; snapshot deferred' }
if (-not (Test-Path -LiteralPath $backupRoot)) { New-Item -ItemType Directory -Path $backupRoot | Out-Null }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
foreach ($identity in @($sid, [Security.Principal.SecurityIdentifier]'S-1-5-18', [Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
}
Set-Acl -LiteralPath $backupRoot -AclObject $acl
if (-not (Get-Acl -LiteralPath $backupRoot).AreAccessRulesProtected) { throw 'Backup DACL is not protected' }
New-Item -ItemType Directory -Path $snapshotRoot | Out-Null
$records = foreach ($row in $items) {
  Assert-NoReparse $row.Source
  $digest = (Get-FileHash -LiteralPath $row.Source -Algorithm SHA256).Hash.ToLowerInvariant()
  $dest = Join-Path $snapshotRoot $row.Name
  if (Test-Path -LiteralPath $dest) { throw "Backup target already exists: $($row.Name)" }
  Copy-Item -LiteralPath $row.Source -Destination $dest
  if ((Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest -or (Get-FileHash -LiteralPath $row.Source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) { throw "Dependency changed while copying: $($row.Name)" }
  [pscustomobject]@{ name=$row.Name; source=$row.Source; sha256=$digest; changesAllowed=($row.ChangesAllowed -eq $true) }
}
$receipt = [ordered]@{ schema=1; createdAt=[DateTime]::UtcNow.ToString('o'); files=@($records) }
[IO.File]::WriteAllText($receiptPath,($receipt | ConvertTo-Json -Depth 5)+[Environment]::NewLine,(New-Object Text.UTF8Encoding($false)))
[pscustomobject]@{ ok=$true; files=$records.Count; root=$snapshotRoot; receiptSha256=(Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLowerInvariant() } | ConvertTo-Json -Compress
