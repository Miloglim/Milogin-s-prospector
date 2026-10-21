[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CenterUrl
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$centerFile = Join-Path $root 'assets\center.json'
$utf8 = [System.Text.UTF8Encoding]::new($false)

$uri = [Uri]$CenterUrl
$origin = $uri.GetLeftPart([UriPartial]::Authority)
if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or $origin -ne $CenterUrl.TrimEnd('/')) {
    throw 'CenterUrl 必须是不带路径、参数或凭据的 HTTPS Origin'
}

$previous = if (Test-Path -LiteralPath $centerFile) { [IO.File]::ReadAllText($centerFile, $utf8) } else { $null }
try {
    [IO.File]::WriteAllText($centerFile, "{`n  `"baseUrl`": `"$origin`"`n}`n", $utf8)
    Push-Location $root
    try {
        & npm.cmd run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
        & npm.cmd run crm:admin:build
        if ($LASTEXITCODE -ne 0) { throw 'admin build failed' }
        & npm.cmd run crm:pg:build
        if ($LASTEXITCODE -ne 0) { throw 'server build failed' }
        & npm.cmd run pack
        if ($LASTEXITCODE -ne 0) { throw 'desktop package failed' }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'create-deployment-candidate.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'deployment candidate failed' }
    } finally {
        Pop-Location
    }
} finally {
    if ($null -eq $previous) { Remove-Item -LiteralPath $centerFile -Force -ErrorAction SilentlyContinue }
    else { [IO.File]::WriteAllText($centerFile, $previous, $utf8) }
}
