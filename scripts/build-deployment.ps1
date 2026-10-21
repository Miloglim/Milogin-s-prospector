[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$CenterUrl,
    [Parameter(Mandatory = $true)]
    [string]$NavigatorUrl
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$utf8 = [System.Text.UTF8Encoding]::new($false)
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$assetsRoot = Join-Path $root ".work\deployment-assets-$stamp"
$builderConfig = Join-Path $root ".work\electron-builder-deployment-$stamp.json"

function Get-HttpsOrigin([string]$value, [string]$name) {
    $uri = [Uri]$value
    $origin = $uri.GetLeftPart([UriPartial]::Authority)
    if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or $origin -ne $value.TrimEnd('/')) {
        throw "$name 必须是不带路径、参数或凭据的 HTTPS Origin"
    }
    return $origin
}
$centerOrigin = Get-HttpsOrigin $CenterUrl 'CenterUrl'
$navigatorOrigin = Get-HttpsOrigin $NavigatorUrl 'NavigatorUrl'
if ($centerOrigin -eq $navigatorOrigin) { throw 'CenterUrl 与 NavigatorUrl 必须使用不同 Origin' }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $assetsRoot) | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'assets') -Destination $assetsRoot -Recurse
[IO.File]::WriteAllText((Join-Path $assetsRoot 'center.json'), "{`n  `"baseUrl`": `"$centerOrigin`",`n  `"ratesUrl`": `"$navigatorOrigin`"`n}`n", $utf8)
$package = [IO.File]::ReadAllText((Join-Path $root 'package.json'), $utf8) | ConvertFrom-Json
$package.build.extraResources = @([ordered]@{ from = $assetsRoot; to = 'assets' })
[IO.File]::WriteAllText($builderConfig, ($package.build | ConvertTo-Json -Depth 20), $utf8)

try {
    Push-Location $root
    try {
        & npm.cmd run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'typecheck failed' }
        & npm.cmd run crm:admin:build
        if ($LASTEXITCODE -ne 0) { throw 'admin build failed' }
        & npm.cmd run crm:pg:build
        if ($LASTEXITCODE -ne 0) { throw 'server build failed' }
        & npx.cmd electron-vite build
        if ($LASTEXITCODE -ne 0) { throw 'Electron build failed' }
        & npx.cmd electron-builder --win --config $builderConfig
        if ($LASTEXITCODE -ne 0) { throw 'desktop package failed' }
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'create-deployment-candidate.ps1')
        if ($LASTEXITCODE -ne 0) { throw 'deployment candidate failed' }
    } finally {
        Pop-Location
    }
} finally { }
