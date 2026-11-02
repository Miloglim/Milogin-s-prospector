[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$DownloadsRoot,
  [Parameter(Mandatory)][string]$CenterUrl,
  [Parameter(Mandatory)][string]$NavigatorUrl,
  [switch]$SkipPack,
  [ValidateSet("signed", "unsigned")][string]$Signature = "unsigned",
  [string[]]$Notes = @(),
  [string]$NotesFile
)

$ErrorActionPreference = "Stop"
$env:VITE_PROSPECTOR_EDITION = "contact-autodev"
& (Join-Path $PSScriptRoot "package-formal-download.ps1") @PSBoundParameters
if ($LASTEXITCODE -ne 0) { throw "contact-autodev package failed with exit code $LASTEXITCODE" }
