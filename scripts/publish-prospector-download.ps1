[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [Parameter(Mandatory = $true)]
  [string]$DownloadsRoot,
  [string]$Version,
  [string]$MinimumWindows = "Windows 10 64-bit",
  [ValidateSet("signed", "unsigned")]
  [string]$Signature = "unsigned",
  [string[]]$Notes = @(),
  [string]$NotesFile
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  throw "Installer not found: $InstallerPath"
}
$installer = Get-Item -LiteralPath $InstallerPath
if ($installer.Extension -ne ".exe") {
  throw "Installer must be a .exe file: $($installer.FullName)"
}

if (-not $Version) {
  $packageText = [System.IO.File]::ReadAllText((Join-Path $repoRoot "package.json"), [System.Text.Encoding]::UTF8)
  $package = $packageText | ConvertFrom-Json
  $Version = [string]$package.version
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$') {
  throw "Invalid version: $Version"
}

$resolvedNotes = @($Notes | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() })
if ($NotesFile) {
  if (-not (Test-Path -LiteralPath $NotesFile -PathType Leaf)) {
    throw "Release notes file not found: $NotesFile"
  }
  $resolvedNotes += @([System.IO.File]::ReadAllLines($NotesFile, [System.Text.Encoding]::UTF8) | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
}
$resolvedNotes = @($resolvedNotes | Select-Object -Unique)
if ($resolvedNotes.Count -gt 20) {
  throw "At most 20 release notes are allowed"
}
if ($resolvedNotes | Where-Object { $_.Length -gt 500 }) {
  throw "Each release note must be at most 500 characters"
}

$root = [System.IO.Path]::GetFullPath($DownloadsRoot)
New-Item -ItemType Directory -Force -Path $root | Out-Null
$destination = Join-Path $root $installer.Name
$hash = Get-Sha256 $installer.FullName

if (Test-Path -LiteralPath $destination -PathType Leaf) {
  $existingHash = Get-Sha256 $destination
  if ($existingHash -ne $hash) {
    throw "Refusing to overwrite a different installer with the same name: $destination"
  }
} else {
  $temporaryInstaller = "$destination.tmp"
  Copy-Item -LiteralPath $installer.FullName -Destination $temporaryInstaller
  Move-Item -LiteralPath $temporaryInstaller -Destination $destination
}

$manifest = [ordered]@{
  manifestVersion = 1
  product = "prospector"
  channel = "stable"
  version = $Version
  fileName = $installer.Name
  sizeBytes = $installer.Length
  sha256 = $hash
  publishedAt = (Get-Date).ToString("o")
  minimumWindows = $MinimumWindows
  signature = $Signature
  notes = $resolvedNotes
}
$manifestPath = Join-Path $root "latest.json"
$temporaryManifest = "$manifestPath.tmp"
[System.IO.File]::WriteAllText(
  $temporaryManifest,
  ($manifest | ConvertTo-Json -Depth 6),
  (New-Object System.Text.UTF8Encoding($false))
)
Move-Item -LiteralPath $temporaryManifest -Destination $manifestPath -Force

[pscustomobject]@{
  manifest = $manifestPath
  installer = $destination
  version = $Version
  sha256 = $hash
}
