$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$ready = 'http://127.0.0.1:55847/health/ready'

function Test-CenterReady {
  try {
    $response = Invoke-RestMethod -UseBasicParsing -TimeoutSec 2 $ready
    return $response.ok -eq $true
  } catch { return $false }
}

if (Test-CenterReady) {
  Write-Host '[center] already ready'
  exit 0
}

Push-Location $root
try {
  Write-Host '[center] not ready; starting center database...'
  if (-not (Test-Path (Join-Path $root 'dist-server\online.js'))) {
    Write-Host '[center] server build missing; building...'
    & npm run crm:pg:build
    if ($LASTEXITCODE -ne 0) { throw 'server build failed' }
  }
  & node scripts/center-postgres.mjs start
  if ($LASTEXITCODE -ne 0) { throw 'center database failed to start' }

  Write-Host '[center] starting center service...'
  & npm run crm:production:start
  if ($LASTEXITCODE -ne 0) { throw 'center service failed to start' }

  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Test-CenterReady) {
      Write-Host '[center] ready'
      exit 0
    }
    Start-Sleep -Milliseconds 1000
  }
  throw 'center did not become ready'
} catch {
  Write-Host "[center] $_" -ForegroundColor Red
  Write-Host '[center] check C:\ProgramData\MiloginCenter\online.log and postgres.log'
  exit 1
} finally {
  Pop-Location
}
