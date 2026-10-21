[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$DownloadsRoot,
  [switch]$SkipPack,
  [ValidateSet("signed", "unsigned")]
  [string]$Signature = "unsigned",
  [string[]]$Notes = @(),
  [string]$NotesFile
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $SkipPack) {
  Push-Location $repoRoot
  try {
    & npm.cmd run pack
    if ($LASTEXITCODE -ne 0) {
      throw "npm run pack failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
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

& (Join-Path $PSScriptRoot "publish-prospector-download.ps1") `
  -InstallerPath $installer.FullName `
  -DownloadsRoot $DownloadsRoot `
  -Version ([string]$package.version) `
  -Signature $Signature `
  -Notes $Notes `
  -NotesFile $NotesFile
