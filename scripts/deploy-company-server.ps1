[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CenterOrigin,
    [Parameter(Mandatory = $true)][string]$NavigatorOrigin,
    [Parameter(Mandatory = $true)][string]$AdminEmail,
    [string]$MigrationBundle,
    [switch]$SkipNavigatorDependencies,
    [switch]$SkipPublicCheck
)

$ErrorActionPreference = 'Stop'
$prospectorRoot = Split-Path -Parent $PSScriptRoot
$deploymentRoot = Split-Path -Parent $prospectorRoot
$navigatorDb = Join-Path $deploymentRoot 'navigator\Database'
$centerRuntime = Join-Path $env:ProgramData 'MiloginCenter'
$navigatorRuntime = Join-Path $env:ProgramData 'FreightRate'
$pgConfigPath = Join-Path $centerRuntime 'postgres.json'
$deploymentPath = Join-Path $centerRuntime 'deployment.json'
$navigatorEnvPath = Join-Path $navigatorRuntime 'freight-postgres.env'
$agentTokenPath = Join-Path $navigatorRuntime 'navigator-agent-token.txt'
$adminCredentialsPath = Join-Path $centerRuntime 'bootstrap-admin.json'
$utf8 = [System.Text.UTF8Encoding]::new($false)
$pgBin = if ($env:PROSPECTOR_PG_BIN) { $env:PROSPECTOR_PG_BIN } else { 'C:\Program Files\PostgreSQL\18\bin' }
$pgRestore = Join-Path $pgBin 'pg_restore.exe'
$psql = Join-Path $pgBin 'psql.exe'

function Assert-HttpsOrigin([string]$value, [string]$name) {
    $uri = [Uri]$value
    $origin = $uri.GetLeftPart([UriPartial]::Authority)
    if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/' -or $origin -ne $value.TrimEnd('/')) {
        throw "$name 必须是不带路径、参数或凭据的 HTTPS Origin"
    }
    return $origin
}

function Protect-SecretFile([string]$file) {
    if (-not (Test-Path -LiteralPath $file)) { return }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $file /inheritance:r /grant:r "${identity}:F" 'SYSTEM:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "无法收紧凭据文件权限：$file" }
}

function Wait-Http([string]$url) {
    $deadline = (Get-Date).AddSeconds(30)
    do {
        try { $result = Invoke-RestMethod -Uri $url -TimeoutSec 3; if ($result.ok -eq $true) { return $result } }
        catch { $null = $_ } # Retry is required while the service is starting.
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "服务未就绪：$url"
}

function Assert-EmptyApplicationDatabase([string]$hostName, [int]$port, [string]$database, [string]$user, [string]$password) {
    if (-not (Test-Path -LiteralPath $psql)) { throw "缺少 psql：$psql" }
    $env:PGPASSWORD = $password
    try {
        $count = & $psql -h $hostName -p $port -U $user -d $database -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"
        if ($LASTEXITCODE -ne 0) { throw "无法检查目标数据库：$database" }
        if ([int]$count.Trim() -ne 0) { throw "迁移恢复要求空数据库，$database 已有对象" }
    } finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
}

$CenterOrigin = Assert-HttpsOrigin $CenterOrigin 'CenterOrigin'
$NavigatorOrigin = Assert-HttpsOrigin $NavigatorOrigin 'NavigatorOrigin'
if ($CenterOrigin -eq $NavigatorOrigin) { throw '中心和 Navigator 必须使用不同域名' }
foreach ($command in @('node', 'python')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "缺少运行环境：$command" }
}
if (-not (Test-Path -LiteralPath (Join-Path $prospectorRoot 'scripts\provision-company-databases.mjs'))) { throw '部署包缺少应用数据库初始化脚本' }
if (-not $env:MILOGIN_DATABASE_ADMIN_DSN) { throw '必须通过 MILOGIN_DATABASE_ADMIN_DSN 提供现有 PostgreSQL 管理员凭据；不得写入命令行或源码' }

New-Item -ItemType Directory -Force -Path $centerRuntime, $navigatorRuntime | Out-Null
Push-Location $prospectorRoot
try {
    & node .\scripts\provision-company-databases.mjs
    if ($LASTEXITCODE -ne 0) { throw '使用现有数据库管理员初始化应用数据库失败' }

    $pg = Get-Content -LiteralPath $pgConfigPath -Raw | ConvertFrom-Json
    $centerDsn = "postgresql://$($pg.app):$([uri]::EscapeDataString($pg.appPassword))@$($pg.host):$($pg.port)/$($pg.database)"
    $navigatorDsn = "postgresql://$($pg.navigatorApp):$([uri]::EscapeDataString($pg.navigatorPassword))@$($pg.host):$($pg.port)/$($pg.navigatorDatabase)"
    if ($MigrationBundle) {
        $bundle = [IO.Path]::GetFullPath($MigrationBundle)
        foreach ($name in @('center.dump', 'navigator.dump')) {
            if (-not (Test-Path -LiteralPath (Join-Path $bundle $name))) { throw "迁移包缺少 $name" }
        }
        if (-not (Test-Path -LiteralPath $pgRestore)) { throw "缺少 pg_restore：$pgRestore" }
        Assert-EmptyApplicationDatabase $pg.host ([int]$pg.port) $pg.database $pg.app $pg.appPassword
        Assert-EmptyApplicationDatabase $pg.host ([int]$pg.port) $pg.navigatorDatabase $pg.navigatorApp $pg.navigatorPassword
        $env:PGPASSWORD = $pg.appPassword
        & $pgRestore --no-owner --no-privileges --exit-on-error --dbname=$centerDsn (Join-Path $bundle 'center.dump')
        if ($LASTEXITCODE -ne 0) { throw '中心库恢复失败' }
        $env:PGPASSWORD = $pg.navigatorPassword
        & $pgRestore --no-owner --no-privileges --exit-on-error --dbname=$navigatorDsn (Join-Path $bundle 'navigator.dump')
        if ($LASTEXITCODE -ne 0) { throw 'Navigator 库恢复失败' }
        Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
        $bundleConfig = Join-Path $bundle 'business-config'
        $targetConfig = Join-Path $navigatorDb '..\Skill\freight-rate-heartbeat\scripts\config'
        foreach ($name in @('publisher_roster.json', 'chat_sources.json')) {
            if (Test-Path -LiteralPath (Join-Path $bundleConfig $name)) { Copy-Item -LiteralPath (Join-Path $bundleConfig $name) -Destination (Join-Path $targetConfig $name) -Force }
        }
        $bundleImages = Join-Path $bundle 'images'
        if (Test-Path -LiteralPath $bundleImages) {
            $targetImages = Join-Path $navigatorDb 'images'
            New-Item -ItemType Directory -Force -Path $targetImages | Out-Null
            Get-ChildItem -LiteralPath $bundleImages -File -Recurse | ForEach-Object {
                $relative = $_.FullName.Substring($bundleImages.Length).TrimStart('\')
                $destination = Join-Path $targetImages $relative
                New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
                Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
            }
        }
    }
    $deployment = [ordered]@{
        marker = 'milogin-company-deployment-v1'
        centerPublicOrigin = $CenterOrigin
        centerInternalUrl = 'http://127.0.0.1:55847'
        navigatorPublicOrigin = $NavigatorOrigin
        navigatorInternalUrl = 'http://127.0.0.1:8795'
        adminEmail = $AdminEmail.ToLowerInvariant()
        generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    }
    [IO.File]::WriteAllText($deploymentPath, ($deployment | ConvertTo-Json), $utf8)
    [IO.File]::WriteAllText($navigatorEnvPath, "FREIGHT_POSTGRES_DSN=$navigatorDsn`n", $utf8)
    Protect-SecretFile $navigatorEnvPath
    Protect-SecretFile $pgConfigPath

    if (-not (Test-Path -LiteralPath $agentTokenPath)) {
        $bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
        [IO.File]::WriteAllText($agentTokenPath, [Convert]::ToHexString($bytes).ToLowerInvariant(), $utf8)
    }
    Protect-SecretFile $agentTokenPath
    $env:NAVIGATOR_AGENT_API_TOKEN = (Get-Content -LiteralPath $agentTokenPath -Raw).Trim()

    $env:PROSPECTOR_CENTER_MODE = 'production'
    $env:PROSPECTOR_CENTER_PG_DSN = $centerDsn
    $env:PROSPECTOR_CENTER_PUBLIC_ORIGIN = $CenterOrigin
    $env:PROSPECTOR_NAVIGATOR_URL = 'http://127.0.0.1:8795'
    $env:PROSPECTOR_NAVIGATOR_ENTRY_URL = $NavigatorOrigin
    & node .\scripts\production-server.mjs start
    if ($LASTEXITCODE -ne 0) { throw 'Prospector 中心服务启动失败' }

    $env:PROSPECTOR_ADMIN_EMAIL = $AdminEmail.ToLowerInvariant()
    $initialPassword = $env:MILOGIN_DEFAULT_ADMIN_PASSWORD
    if ($initialPassword) {
        $env:PROSPECTOR_ADMIN_INITIAL_PASSWORD = $initialPassword
        & node .\scripts\bootstrap-production-admin.mjs --credentials-file $adminCredentialsPath
    } else {
        & node .\scripts\bootstrap-production-admin.mjs --generate-password --credentials-file $adminCredentialsPath
    }
    if ($LASTEXITCODE -ne 0) { throw '默认超级管理员初始化失败' }
} finally { Pop-Location }

if (-not $SkipNavigatorDependencies) {
    Push-Location $navigatorDb
    try {
        & python -m pip install -r .\requirements-postgres.txt
        if ($LASTEXITCODE -ne 0) { throw 'Navigator PostgreSQL 依赖安装失败' }
    } finally { Pop-Location }
}
Push-Location $navigatorDb
try {
    & python .\manual_server.py --backend postgres --postgres-env-file $navigatorEnvPath --center-auth-url http://127.0.0.1:55847 --init-only
    if ($LASTEXITCODE -ne 0) { throw 'Navigator 数据表初始化失败' }
} finally { Pop-Location }

$alreadyListening = Get-NetTCPConnection -State Listen -LocalPort 8795 -ErrorAction SilentlyContinue
if (-not $alreadyListening) {
    Start-Process -FilePath 'python' -ArgumentList @('.\manual_server.py','--host','127.0.0.1','--port','8795','--backend','postgres','--postgres-env-file',$navigatorEnvPath,'--center-auth-url','http://127.0.0.1:55847') -WorkingDirectory $navigatorDb -WindowStyle Hidden | Out-Null
}
Wait-Http 'http://127.0.0.1:55847/health/ready' | Out-Null
Wait-Http 'http://127.0.0.1:8795/api/health/live' | Out-Null

$verifyArgs = @('.\scripts\verify-company-deployment.mjs')
if ($SkipPublicCheck) { $verifyArgs += '--skip-public' }
if ($env:MILOGIN_DEFAULT_ADMIN_PASSWORD) { $env:MILOGIN_VERIFY_ADMIN_PASSWORD = $env:MILOGIN_DEFAULT_ADMIN_PASSWORD }
Push-Location $prospectorRoot
try {
    & node @verifyArgs
    if ($LASTEXITCODE -ne 0) { throw '产品链连通性检查失败' }
} finally { Pop-Location }

$initialPassword = $null
Remove-Item Env:MILOGIN_DEFAULT_ADMIN_PASSWORD, Env:MILOGIN_VERIFY_ADMIN_PASSWORD, Env:PROSPECTOR_ADMIN_INITIAL_PASSWORD, Env:MILOGIN_DATABASE_ADMIN_DSN -ErrorAction SilentlyContinue

Write-Host '部署完成：数据库凭据、默认管理员、域名配置和产品链检查均已就位。'
Write-Host "中心：$CenterOrigin"
Write-Host "Navigator：$NavigatorOrigin"
Write-Host "一次性管理员凭据：$adminCredentialsPath（受 ACL 保护）"
Write-Host "Navigator Agent Token：$agentTokenPath（受 ACL 保护）"
