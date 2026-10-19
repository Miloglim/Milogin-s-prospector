$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$navigatorRoot = 'C:\Users\YQN\Documents\正式版运价库\运价项目\Database'
$navigatorScripts = 'C:\Users\YQN\Documents\正式版运价库\运价项目\Skill\freight-rate-heartbeat\scripts'
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssfffZ')
$candidateRoot = Join-Path $projectRoot ".work\deployment-candidate-$stamp"
$packagePath = "D:\Agent Basement\company-deployment-candidate-$stamp.zip"

if (Test-Path -LiteralPath $candidateRoot) { throw "候选目录已存在：$candidateRoot" }
if (Test-Path -LiteralPath $packagePath) { throw "候选包已存在：$packagePath" }
if (!(Test-Path -LiteralPath (Join-Path $navigatorRoot 'manual_server.py'))) { throw 'Navigator 源目录不可用' }
if (!(Test-Path -LiteralPath (Join-Path $navigatorScripts 'freight_identity\runtime.py'))) { throw 'Navigator 发布身份模块不可用' }

$prospector = Join-Path $candidateRoot 'prospector'
$navigator = Join-Path $candidateRoot 'navigator\Database'
$client = Join-Path $candidateRoot 'client'
New-Item -ItemType Directory -Force -Path $prospector, $navigator, $client, (Join-Path $prospector 'scripts') | Out-Null

Copy-Item -LiteralPath (Join-Path $projectRoot 'dist-server') -Destination (Join-Path $prospector 'dist-server') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'dist-admin') -Destination (Join-Path $prospector 'dist-admin') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\server-runtime\package.json') -Destination (Join-Path $prospector 'package.json')
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\server-runtime\package-lock.json') -Destination (Join-Path $prospector 'package-lock.json')
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\production-server.mjs') -Destination (Join-Path $prospector 'scripts\production-server.mjs')
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\production-deployment.env.example') -Destination (Join-Path $prospector 'production-deployment.env.example')
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\company-server-handoff-20261019.md') -Destination (Join-Path $candidateRoot 'README.md')

Push-Location $prospector
try {
  & npm.cmd ci --offline --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw '中心服务运行依赖安装失败' }
} finally { Pop-Location }

$rootFiles = @('manual_server.py', 'manualdb.py', 'postgresdb.py', 'price_sanitize.py', 'requirements-postgres.txt')
foreach ($name in $rootFiles) {
  Copy-Item -LiteralPath (Join-Path $navigatorRoot $name) -Destination (Join-Path $navigator $name) -ErrorAction Stop
}
foreach ($directory in @('core', 'services', 'transport', 'ops')) {
  $target = Join-Path $navigator $directory
  New-Item -ItemType Directory -Path $target | Out-Null
  Get-ChildItem -LiteralPath (Join-Path $navigatorRoot $directory) -File -Filter '*.py' |
    Where-Object { $_.Name -notlike 'test_*' } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $target $_.Name) }
}
$web = Join-Path $navigator 'web'
New-Item -ItemType Directory -Path $web | Out-Null
foreach ($name in @('index.html', 'prospector-authorize.html', 'admin-terminal.css', 'admin-terminal.js', 'notices.css', 'notices.js', 'notice-icons.svg', 'notice-icons.LICENSE')) {
  Copy-Item -LiteralPath (Join-Path $navigatorRoot "web\$name") -Destination (Join-Path $web $name) -ErrorAction Stop
}
Copy-Item -LiteralPath (Join-Path $navigatorRoot 'web\avatars') -Destination (Join-Path $web 'avatars') -Recurse
New-Item -ItemType Directory -Path (Join-Path $navigator 'images') | Out-Null
$identityTarget = Join-Path $candidateRoot 'navigator\Skill\freight-rate-heartbeat\scripts\freight_identity'
New-Item -ItemType Directory -Force -Path $identityTarget | Out-Null
foreach ($directory in @('', 'core', 'services')) {
  $sourceDirectory = Join-Path (Join-Path $navigatorScripts 'freight_identity') $directory
  $targetDirectory = Join-Path $identityTarget $directory
  New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
  Get-ChildItem -LiteralPath $sourceDirectory -File -Filter '*.py' |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $targetDirectory $_.Name) }
}

$version = (& node -p "require('./package.json').version").Trim()
$installerName = "prospecting-email-setup-$version.exe"
$installerPath = Join-Path (Join-Path $projectRoot '..\dist-release') $installerName
if (!(Test-Path -LiteralPath $installerPath)) { throw "客户端安装包不存在：$installerPath" }
Copy-Item -LiteralPath $installerPath -Destination (Join-Path $client $installerName)
$installerHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash
$manifest = [ordered]@{
  product = 'Milogin product chain'
  candidate = $stamp
  version = $version
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  contents = @('prospector/dist-server', 'prospector/dist-admin', 'prospector/node_modules (pg runtime only)', 'navigator/Database Python runtime', 'navigator/Skill/freight-rate-heartbeat/scripts/freight_identity', "client/$installerName")
  excludes = @('runtime config', 'tokens', 'passwords', 'database files', 'logs', 'backups', 'business images', 'test fixtures')
  navigatorSourceBoundary = 'Navigator is Python runtime source; no frozen binary build was introduced.'
  electronInstallerSha256 = $installerHash
  electronInstallerSigned = $false
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $candidateRoot 'MANIFEST.json') -Encoding UTF8

$required = @('prospector\dist-server\online.js', 'prospector\dist-admin\index.html', 'prospector\node_modules\pg\package.json', 'navigator\Database\manual_server.py', 'navigator\Database\price_sanitize.py', 'navigator\Database\web\index.html', 'navigator\Skill\freight-rate-heartbeat\scripts\freight_identity\runtime.py', "client\$installerName")
foreach ($name in $required) {
  if (!(Test-Path -LiteralPath (Join-Path $candidateRoot $name))) { throw "候选包缺少运行文件：$name" }
}
$forbidden = Get-ChildItem -LiteralPath $candidateRoot -Recurse -File -Force | Where-Object {
  ($_.Name -match '(^|\.)(env|db|log|pid|pem|key)$|token_manual|\.bak|backup-status.*\.json$') -and $_.Name -notlike '*.env.example'
}
if ($forbidden) { throw "候选包包含禁止文件：$($forbidden.FullName -join ', ')" }

Compress-Archive -Path (Join-Path $candidateRoot '*') -DestinationPath $packagePath -CompressionLevel Optimal
Get-FileHash -LiteralPath $packagePath -Algorithm SHA256 | Format-List
Write-Output "CANDIDATE=$packagePath"
Write-Output "STAGING=$candidateRoot"
