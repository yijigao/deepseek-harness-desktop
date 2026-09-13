param([string]$Output = '')
$ErrorActionPreference = 'Stop'

$currentVersion = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$api = [Windows.Foundation.Metadata.ApiInformation,Windows.Foundation.FoundationContract,ContentType=WindowsRuntime]
$report = [ordered]@{
  schema = 1
  checkedAt = [DateTime]::UtcNow.ToString('o')
  windows = [ordered]@{
    productName = [string]$currentVersion.ProductName
    displayVersion = [string]$currentVersion.DisplayVersion
    build = [int]$currentVersion.CurrentBuildNumber
    ubr = [int]$currentVersion.UBR
  }
  graphicsCapture = [ordered]@{
    sessionType = $api::IsTypePresent('Windows.Graphics.Capture.GraphicsCaptureSession')
    startCapture = $api::IsMethodPresent('Windows.Graphics.Capture.GraphicsCaptureSession', 'StartCapture')
    cursorCapture = $api::IsPropertyPresent('Windows.Graphics.Capture.GraphicsCaptureSession', 'IsCursorCaptureEnabled')
    borderRequired = $api::IsPropertyPresent('Windows.Graphics.Capture.GraphicsCaptureSession', 'IsBorderRequired')
    universalContract12 = $api::IsApiContractPresent('Windows.Foundation.UniversalApiContract', 12)
  }
}
$report.recommendation = if (-not $report.graphicsCapture.borderRequired) {
  'Host helper must skip IsBorderRequired and retain the system default capture border.'
} else {
  'The border API is present; investigate capture permission and frame production separately.'
}
$json = $report | ConvertTo-Json -Depth 5
if ($Output) {
  $absolute = [IO.Path]::GetFullPath($Output)
  if (Test-Path -LiteralPath $absolute) { throw 'Refusing to overwrite an existing diagnostic report' }
  [IO.File]::WriteAllText($absolute, $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
}
$json
