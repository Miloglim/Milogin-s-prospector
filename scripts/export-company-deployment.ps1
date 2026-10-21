[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [switch]$IncludeBusinessImages
)

$ErrorActionPreference = 'Stop'
$prospectorRoot = Split-Path -Parent $PSScriptRoot
$deploymentRoot = Split-Path -Parent $prospectorRoot
$centerRuntime = Join-Path $env:ProgramData 'MiloginCenter'
$pgConfigPath = Join-Path $centerRuntime 'postgres.json'
$deploymentPath = Join-Path $centerRuntime 'deployment.json'
$navigatorEnvPath = Join-Path $env:ProgramData 'FreightRate\freight-postgres.env'
$pgBin = if ($env:PROSPECTOR_PG_BIN) { $env:PROSPECTOR_PG_BIN } else { 'C:\Program Files\PostgreSQL\18\bin' }
$pgDump = Join-Path $pgBin 'pg_dump.exe'
$pgRestore = Join-Path $pgBin 'pg_restore.exe'
$output = [IO.Path]::GetFullPath($OutputDirectory)

foreach ($file in @($pgConfigPath, $navigatorEnvPath, $pgDump, $pgRestore)) {
    if (-not (Test-Path -LiteralPath $file)) { throw "迁移导出缺少文件：$file" }
}
if (Test-Path -LiteralPath $output) {
    if (Get-ChildItem -LiteralPath $output -Force | Select-Object -First 1) { throw "输出目录必须为空：$output" }
} else { New-Item -ItemType Directory -Path $output | Out-Null }

$pg = Get-Content -LiteralPath $pgConfigPath -Raw | ConvertFrom-Json
$centerDsn = "postgresql://$($pg.app):$([uri]::EscapeDataString($pg.appPassword))@$($pg.host):$($pg.port)/$($pg.database)"
$navigatorDsn = ((Get-Content -LiteralPath $navigatorEnvPath -Raw) -split '=', 2)[1].Trim()
$centerDump = Join-Path $output 'center.dump'
$navigatorDump = Join-Path $output 'navigator.dump'

try {
    $env:PGPASSWORD = $pg.appPassword
    & $pgDump --dbname=$centerDsn --format=custom --no-owner --no-privileges --file=$centerDump `
        --exclude-table-data=identity.sessions `
        --exclude-table-data=identity.desktop_refresh_tokens `
        --exclude-table-data=identity.management_challenges
    if ($LASTEXITCODE -ne 0) { throw '中心库导出失败' }

    $navigatorUri = [Uri]$navigatorDsn
    $navigatorEncodedPassword = ($navigatorUri.UserInfo -split ':', 2)[1]
    $env:PGPASSWORD = [Uri]::UnescapeDataString($navigatorEncodedPassword)
    & $pgDump --dbname=$navigatorDsn --format=custom --no-owner --no-privileges --file=$navigatorDump `
        --exclude-table-data=auth_sessions `
        --exclude-table-data=prospector_tokens `
        --exclude-table-data=prospector_codes
    if ($LASTEXITCODE -ne 0) { throw 'Navigator 库导出失败' }
} finally { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }

foreach ($dump in @($centerDump, $navigatorDump)) {
    & $pgRestore --list $dump | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "备份文件无法读取：$dump" }
}

if (Test-Path -LiteralPath $deploymentPath) { Copy-Item -LiteralPath $deploymentPath -Destination (Join-Path $output 'source-deployment.json') }
$configTarget = Join-Path $output 'business-config'
New-Item -ItemType Directory -Path $configTarget | Out-Null
$configRoot = Join-Path $deploymentRoot 'navigator\Skill\freight-rate-heartbeat\scripts\config'
foreach ($name in @('publisher_roster.json', 'chat_sources.json')) {
    $source = Join-Path $configRoot $name
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $configTarget $name) }
}
if ($IncludeBusinessImages) {
    $images = Join-Path $deploymentRoot 'navigator\Database\images'
    if (Test-Path -LiteralPath $images) { Copy-Item -LiteralPath $images -Destination (Join-Path $output 'images') -Recurse }
}

$manifest = [ordered]@{
    marker = 'milogin-company-migration-v1'
    exportedAt = (Get-Date).ToUniversalTime().ToString('o')
    centerDump = 'center.dump'
    navigatorDump = 'navigator.dump'
    excludedRuntimeState = @('center sessions', 'desktop refresh tokens', 'management challenges', 'navigator auth sessions', 'navigator prospector tokens')
    includedBusinessImages = [bool]$IncludeBusinessImages
}
[IO.File]::WriteAllText((Join-Path $output 'migration.json'), ($manifest | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
$hashes = Get-ChildItem -LiteralPath $output -Recurse -File | Where-Object Name -ne 'SHA256SUMS.json' | ForEach-Object {
    [ordered]@{ path = $_.FullName.Substring($output.Length).TrimStart('\'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
}
[IO.File]::WriteAllText((Join-Path $output 'SHA256SUMS.json'), ($hashes | ConvertTo-Json -Depth 3), [Text.UTF8Encoding]::new($false))
Write-Host "迁移包已导出：$output"
Write-Host '请通过受控加密通道传输；迁移完成并验收后删除源端迁移目录。'
