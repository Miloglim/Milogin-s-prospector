[CmdletBinding()]
param(
    [switch]$SkipNavigatorDependencies,
    [switch]$SkipNavigatorInit,
    [switch]$StartServices
)

$ErrorActionPreference = 'Stop'
$prospectorRoot = Split-Path -Parent $PSScriptRoot
$deploymentRoot = Split-Path -Parent $prospectorRoot
$navigatorDb = Join-Path $deploymentRoot 'navigator\Database'
$runtimeRoot = Join-Path ${env:ProgramData} 'FreightRate'
$navigatorEnv = Join-Path $runtimeRoot 'freight-postgres.env'
$checkpoint = 0

function Step([string]$title) {
    $script:checkpoint++
    Write-Host "`n[$($script:checkpoint)] $title" -ForegroundColor Cyan
}

function Require-Command([string]$name, [string]$hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "$name 未找到。$hint"
    }
}

function Assert-ExitCode([int]$code, [string]$operation) {
    if ($code -ne 0) { throw "$operation 失败，退出码 $code。" }
}

function Read-Secret([string]$prompt) {
    $secure = Read-Host $prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Pause-Checkpoint([string]$message) {
    Write-Host $message -ForegroundColor DarkGray
    $answer = Read-Host '输入 Y 继续，其他内容退出'
    if ($answer -notmatch '^(?i)y$') { throw '用户在 checkpoint 主动停止。' }
}

Step '检查目录与运行时'
if (-not (Test-Path (Join-Path $prospectorRoot 'scripts\production-server.mjs'))) {
    throw "Prospector 生产启动脚本不存在：$prospectorRoot"
}
if (-not (Test-Path (Join-Path $navigatorDb 'manual_server.py'))) {
    throw "Navigator 启动脚本不存在：$navigatorDb"
}
Require-Command 'node' '请先安装 Node.js 22 或更高版本。'
Require-Command 'python' '请先安装 Python 3.11 或更高版本，并加入 PATH。'
Require-Command 'psql' '请先安装 PostgreSQL 客户端，或把 PostgreSQL\bin 加入 PATH。'

Step '读取本机配置（密码只保留在当前进程）'
$centerPassword = Read-Secret '请输入 milogin_app 密码'
$navigatorPassword = Read-Secret '请输入 navigator_app 密码'
$centerEncoded = [uri]::EscapeDataString($centerPassword)
$navigatorEncoded = [uri]::EscapeDataString($navigatorPassword)
$centerDsn = "postgresql://milogin_app:$centerEncoded@127.0.0.1:55846/milogin_center"
$navigatorDsn = "postgresql://navigator_app:$navigatorEncoded@127.0.0.1:5432/navigator_rates"

Step '检查 PostgreSQL 连接'
$env:PGPASSWORD = $centerPassword
& psql -h 127.0.0.1 -p 55846 -U milogin_app -d milogin_center -v ON_ERROR_STOP=1 -c 'SELECT 1;' | Out-Host
Assert-ExitCode $LASTEXITCODE '中心 PostgreSQL 连接'
$env:PGPASSWORD = $navigatorPassword
& psql -h 127.0.0.1 -p 5432 -U navigator_app -d navigator_rates -v ON_ERROR_STOP=1 -c 'SELECT 1;' | Out-Host
Assert-ExitCode $LASTEXITCODE 'Navigator PostgreSQL 连接'
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue

Step '写入 Navigator 本机配置'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
if (Test-Path $navigatorEnv) {
    $existing = Get-Content -LiteralPath $navigatorEnv -Raw
    if ($existing -notmatch '(?m)^FREIGHT_POSTGRES_DSN=') {
        Add-Content -LiteralPath $navigatorEnv -Value "FREIGHT_POSTGRES_DSN=$navigatorDsn" -Encoding ascii
    } else {
        Write-Host "已存在配置文件，保留原文件：$navigatorEnv" -ForegroundColor Yellow
    }
} else {
    Set-Content -LiteralPath $navigatorEnv -Value "FREIGHT_POSTGRES_DSN=$navigatorDsn" -Encoding ascii
}
Write-Host "配置文件：$navigatorEnv"

if (-not $SkipNavigatorDependencies) {
    Step '安装 Navigator PostgreSQL 运行依赖'
    Push-Location $navigatorDb
    try {
        & python -m pip install -r .\requirements-postgres.txt
        Assert-ExitCode $LASTEXITCODE '安装 Navigator PostgreSQL 依赖'
    } finally { Pop-Location }
}

if (-not $SkipNavigatorInit) {
    Step '初始化 Navigator PostgreSQL 表结构'
    Push-Location $navigatorDb
    try {
        & python .\manual_server.py --backend postgres --postgres-env-file $navigatorEnv --init-only
        Assert-ExitCode $LASTEXITCODE '初始化 Navigator PostgreSQL'
    } finally { Pop-Location }
}

Step '准备 Prospector 生产环境变量'
$env:PROSPECTOR_CENTER_MODE = 'production'
$env:PROSPECTOR_CENTER_PUBLIC_ORIGIN = if ($env:PROSPECTOR_CENTER_PUBLIC_ORIGIN) { $env:PROSPECTOR_CENTER_PUBLIC_ORIGIN } else { 'https://crm.test.internal' }
$env:PROSPECTOR_CENTER_PG_DSN = $centerDsn
$env:PROSPECTOR_NAVIGATOR_URL = if ($env:PROSPECTOR_NAVIGATOR_URL) { $env:PROSPECTOR_NAVIGATOR_URL } else { 'http://127.0.0.1:8795' }
$env:PROSPECTOR_NAVIGATOR_ENTRY_URL = if ($env:PROSPECTOR_NAVIGATOR_ENTRY_URL) { $env:PROSPECTOR_NAVIGATOR_ENTRY_URL } else { 'http://127.0.0.1:8795' }
Write-Host "PROSPECTOR_CENTER_PUBLIC_ORIGIN=$env:PROSPECTOR_CENTER_PUBLIC_ORIGIN"

if ($StartServices) {
    Step '启动 Prospector 中心服务'
    Push-Location $prospectorRoot
    try {
        & node .\scripts\production-server.mjs start
        Assert-ExitCode $LASTEXITCODE '启动 Prospector 中心服务'
    } finally { Pop-Location }

    Step '启动 Navigator'
    Push-Location $navigatorDb
    try {
        Start-Process -FilePath 'python' -ArgumentList @('.\manual_server.py','--host','127.0.0.1','--port','8795','--backend','postgres','--postgres-env-file',$navigatorEnv,'--center-auth-url','http://127.0.0.1:55847') -WorkingDirectory $navigatorDb
    } finally { Pop-Location }

    Step '服务健康检查'
    Start-Sleep -Seconds 2
    Invoke-WebRequest 'http://127.0.0.1:55847/health/ready' -UseBasicParsing | Out-Host
    Invoke-WebRequest 'http://127.0.0.1:8795/api/health/live' -UseBasicParsing | Out-Host
}

Remove-Variable centerPassword,navigatorPassword,centerDsn,navigatorDsn,centerEncoded,navigatorEncoded -ErrorAction SilentlyContinue
Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
Write-Host "`n部署引导完成。配置文件和密码未写入项目目录；当前 PowerShell 环境变量仅对本窗口有效。" -ForegroundColor Green
