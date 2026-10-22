[CmdletBinding()]
param(
  [string]$DownloadsRoot,
  [string]$CenterUrl,
  [string]$NavigatorUrl,
  [switch]$SkipPack,
  [ValidateSet("signed", "unsigned")]
  [string]$Signature = "unsigned",
  [string[]]$Notes = @(),
  [string]$NotesFile
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$CenterUrl = if ($CenterUrl) { $CenterUrl } else { $env:PROSPECTOR_CENTER_URL }
$NavigatorUrl = if ($NavigatorUrl) { $NavigatorUrl } else { $env:PROSPECTOR_NAVIGATOR_URL }
$DownloadsRoot = if ($DownloadsRoot) { $DownloadsRoot } else { $env:PROSPECTOR_DOWNLOADS_ROOT }

function Get-HttpsOrigin([string]$value, [string]$name) {
  $uri = [Uri]$value
  $origin = $uri.GetLeftPart([UriPartial]::Authority)
  if ($uri.Scheme -ne "https" -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne "/" -or $origin -ne $value.TrimEnd("/")) {
    throw "$name 必须是不带路径、参数或凭据的 HTTPS Origin"
  }
  return $origin
}

if (-not $DownloadsRoot) { throw "缺少 DownloadsRoot 或 PROSPECTOR_DOWNLOADS_ROOT" }
$centerOrigin = Get-HttpsOrigin $CenterUrl "CenterUrl"
$navigatorOrigin = Get-HttpsOrigin $NavigatorUrl "NavigatorUrl"
if ($centerOrigin -eq $navigatorOrigin) { throw "CenterUrl 与 NavigatorUrl 必须使用不同 Origin" }

if (-not $SkipPack) {
  & (Join-Path $PSScriptRoot "build-deployment.ps1") -CenterUrl $centerOrigin -NavigatorUrl $navigatorOrigin
  if ($LASTEXITCODE -ne 0) { throw "production deployment package failed with exit code $LASTEXITCODE" }
}

$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot "..\dist-release"))
if (-not (Test-Path -LiteralPath $releaseRoot -PathType Container)) {
  throw "Release directory not found: $releaseRoot"
}
$packageText = [System.IO.File]::ReadAllText((Join-Path $repoRoot "package.json"), [System.Text.Encoding]::UTF8)
$package = $packageText | ConvertFrom-Json
$installer = Get-ChildItem -LiteralPath $releaseRoot -File -Filter "prospecting-email-setup-*.exe" |
  Where-Object { $_.Name -like "*$($package.version)*" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $installer) {
  throw "No Prospector installer for version $($package.version) found in $releaseRoot"
}

$deploymentConfig = Join-Path $repoRoot "..\dist-release\win-unpacked\resources\assets\center.json"
if (-not (Test-Path -LiteralPath $deploymentConfig -PathType Leaf)) {
  throw "Built application endpoint config not found: $deploymentConfig"
}
$endpoints = [System.IO.File]::ReadAllText($deploymentConfig, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($endpoints.baseUrl -ne $centerOrigin -or $endpoints.ratesUrl -ne $navigatorOrigin) {
  throw "Installer endpoint mismatch: baseUrl=$($endpoints.baseUrl), ratesUrl=$($endpoints.ratesUrl)"
}

& (Join-Path $PSScriptRoot "publish-prospector-download.ps1") `
  -InstallerPath $installer.FullName `
  -DownloadsRoot $DownloadsRoot `
  -Version ([string]$package.version) `
  -Signature $Signature `
  -Notes $Notes `
  -NotesFile $NotesFile
