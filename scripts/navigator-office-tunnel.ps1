[CmdletBinding()]
param(
  [string]$RemoteHost = "47.96.159.26",
  [string]$RemoteUser = "navigator-tunnel",
  [int]$RemotePort = 18795,
  [int]$LocalPort = 8795,
  [string]$IdentityFile = "$env:USERPROFILE\.ssh\milogin_tunnel",
  [int]$RetrySeconds = 10
)

$ErrorActionPreference = "Continue"
$ssh = Join-Path $env:WINDIR "System32\OpenSSH\ssh.exe"
$stateRoot = Join-Path $env:LOCALAPPDATA "Milogin"
$knownHosts = Join-Path $stateRoot "known_hosts"
$logRoot = Join-Path $stateRoot "Logs"
$logFile = Join-Path $logRoot "navigator-office-tunnel.log"

New-Item -ItemType Directory -Force -Path $stateRoot,$logRoot | Out-Null
if (-not (Test-Path -LiteralPath $knownHosts)) {
  New-Item -ItemType File -Path $knownHosts | Out-Null
}

function Write-TunnelLog([string]$message) {
  $line = "[{0}] [tunnel] {1}" -f (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz"), $message
  Add-Content -LiteralPath $logFile -Value $line -Encoding utf8
}

$arguments = @(
  "-N", "-T",
  "-i", $IdentityFile,
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=15",
  "-o", "ExitOnForwardFailure=yes",
  "-o", "ServerAliveInterval=30",
  "-o", "ServerAliveCountMax=3",
  "-o", "StrictHostKeyChecking=accept-new",
  "-o", "UserKnownHostsFile=$knownHosts",
  "-R", "127.0.0.1:${RemotePort}:127.0.0.1:${LocalPort}",
  "$RemoteUser@$RemoteHost"
)

Write-TunnelLog "service started"
while ($true) {
  try {
    Write-TunnelLog "connecting remote=127.0.0.1:$RemotePort local=127.0.0.1:$LocalPort"
    & $ssh @arguments *>> $logFile
    Write-TunnelLog "ssh exited code=$LASTEXITCODE"
  } catch {
    Write-TunnelLog ("ssh launch failed: " + $_.Exception.Message)
  }
  Start-Sleep -Seconds $RetrySeconds
}
