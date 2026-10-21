$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$navigatorRoot = 'C:\Users\YQN\Documents\正式版运价库\运价项目\Database'
$navigatorProjectRoot = 'C:\Users\YQN\Documents\正式版运价库\运价项目'
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
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\center-postgres.mjs') -Destination (Join-Path $prospector 'scripts\center-postgres.mjs')
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\provision-company-databases.mjs') -Destination (Join-Path $prospector 'scripts\provision-company-databases.mjs')
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\bootstrap-production-admin.mjs') -Destination (Join-Path $prospector 'scripts\bootstrap-production-admin.mjs')
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\bootstrap-company-server.ps1') -Destination (Join-Path $prospector 'scripts\bootstrap-company-server.ps1')
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\deploy-company-server.ps1') -Destination (Join-Path $prospector 'scripts\deploy-company-server.ps1')
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\export-company-deployment.ps1') -Destination (Join-Path $prospector 'scripts\export-company-deployment.ps1')
Copy-Item -LiteralPath (Join-Path $projectRoot 'scripts\verify-company-deployment.mjs') -Destination (Join-Path $prospector 'scripts\verify-company-deployment.mjs')
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\production-deployment.env.example') -Destination (Join-Path $prospector 'production-deployment.env.example')
Copy-Item -LiteralPath (Join-Path $projectRoot 'docs\company-server-handoff-20261019.md') -Destination (Join-Path $candidateRoot 'README.md')
$deploymentTarget = Join-Path $candidateRoot 'deployment\aliyun'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $deploymentTarget) | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'deployment-templates\aliyun') -Destination $deploymentTarget -Recurse

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
foreach ($name in @('index.html', 'download.html', 'download.css', 'download.js', 'prospector-authorize.html', 'admin-terminal.css', 'admin-terminal.js', 'notices.css', 'notices.js', 'notice-icons.svg', 'notice-icons.LICENSE')) {
  Copy-Item -LiteralPath (Join-Path $navigatorRoot "web\$name") -Destination (Join-Path $web $name) -ErrorAction Stop
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'deployment-templates\aliyun\navigator.Dockerfile') -Destination (Join-Path $navigator 'Dockerfile')
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
$identityConfigTarget = Join-Path $candidateRoot 'navigator\Skill\freight-rate-heartbeat\scripts\config'
New-Item -ItemType Directory -Force -Path $identityConfigTarget | Out-Null
$deploymentTemplates = Join-Path $navigatorProjectRoot 'Database\deployment-templates'
foreach ($name in @('publisher_roster.json', 'chat_sources.json')) {
  Copy-Item -LiteralPath (Join-Path $deploymentTemplates $name) -Destination (Join-Path $identityConfigTarget $name) -ErrorAction Stop
}
$agentSkillSource = Join-Path $navigatorProjectRoot 'Skill\navigator-agent-intake'
$agentSkillTarget = Join-Path $candidateRoot 'navigator\Skill\navigator-agent-intake'
if (!(Test-Path -LiteralPath (Join-Path $agentSkillSource 'SKILL.md'))) { throw 'Navigator Agent intake skill is unavailable' }
Copy-Item -LiteralPath $agentSkillSource -Destination $agentSkillTarget -Recurse

$version = (& node -p "require(process.argv[1]).version" (Join-Path $projectRoot 'package.json')).Trim()
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
  contents = @('prospector/dist-server', 'prospector/dist-admin', 'prospector/node_modules (pg runtime only)', 'navigator/Database Python runtime', 'navigator/Database/Dockerfile', 'navigator/Database/web/download.html', 'navigator/Database/web/download.css', 'navigator/Database/web/download.js', 'navigator/Skill/freight-rate-heartbeat/scripts/freight_identity', 'navigator/Skill/freight-rate-heartbeat/scripts/config (empty deployment templates)', 'navigator/Skill/navigator-agent-intake', 'deployment/aliyun', "client/$installerName")
  excludes = @('runtime config', 'tokens', 'passwords', 'database files', 'logs', 'backups', 'business images', 'test fixtures')
  navigatorSourceBoundary = 'Navigator is Python runtime source; no frozen binary build was introduced.'
  electronInstallerSha256 = $installerHash
  electronInstallerSigned = $false
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $candidateRoot 'MANIFEST.json') -Encoding UTF8

$required = @('prospector\dist-server\online.js', 'prospector\dist-admin\index.html', 'prospector\node_modules\pg\package.json', 'prospector\scripts\center-postgres.mjs', 'prospector\scripts\provision-company-databases.mjs', 'prospector\scripts\production-server.mjs', 'prospector\scripts\bootstrap-company-server.ps1', 'prospector\scripts\bootstrap-production-admin.mjs', 'prospector\scripts\deploy-company-server.ps1', 'prospector\scripts\export-company-deployment.ps1', 'prospector\scripts\verify-company-deployment.mjs', 'navigator\Database\manual_server.py', 'navigator\Database\price_sanitize.py', 'navigator\Database\Dockerfile', 'navigator\Database\web\index.html', 'navigator\Database\web\download.html', 'navigator\Database\web\download.css', 'navigator\Database\web\download.js', 'navigator\Skill\freight-rate-heartbeat\scripts\freight_identity\runtime.py', 'navigator\Skill\freight-rate-heartbeat\scripts\config\publisher_roster.json', 'navigator\Skill\freight-rate-heartbeat\scripts\config\chat_sources.json', 'navigator\Skill\navigator-agent-intake\SKILL.md', 'navigator\Skill\navigator-agent-intake\scripts\submit_intake.py', 'deployment\aliyun\docker-compose.yml', 'deployment\aliyun\Caddyfile', 'deployment\aliyun\env.example', "client\$installerName")
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
