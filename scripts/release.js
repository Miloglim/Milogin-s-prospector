// ── 自动发布脚本 ──────────────────────────────────────────────────────────
// 用法: node scripts/release.js [更新说明]
// 自动完成: 构建 → 打tag → 推送 → 创建GitHub Release → 上传文件

const { execFileSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, '..', 'dist-release');
const REPO = 'Miloglim/Milogin-s-prospector';
const checkOnly = process.argv.includes('--check-only');
const notes = process.argv.slice(2).filter(arg => arg !== '--check-only').join(' ') || '更新说明';

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit' });
}

function runOptional(command, args) {
  return spawnSync(command, args, { cwd: ROOT, stdio: 'ignore' }).status === 0;
}

// 1. 读取版本号
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version;
console.log(`\n📦 当前版本: v${version}`);

// 2. 确认 dist-release 存在
if (!fs.existsSync(DIST)) {
  console.error('❌ dist-release 目录不存在，请先运行 npm run pack');
  process.exit(1);
}

// 3. 当前版本发布三件套必须齐全，避免客户端因 latest.yml 缺失显示“仓库未找到”
const installer = `prospecting-email-setup-${version}.exe`;
const requiredFiles = [installer, `${installer}.blockmap`, 'latest.yml'];
const files = requiredFiles.map(name => path.join(DIST, name));
for (const file of files) {
  if (!fs.existsSync(file)) {
    console.error(`❌ 缺少发布文件: ${file}`);
    process.exit(1);
  }
}
const latest = fs.readFileSync(path.join(DIST, 'latest.yml'), 'utf-8');
const installerSha512 = crypto.createHash('sha512').update(fs.readFileSync(path.join(DIST, installer))).digest('base64');
if (!latest.match(new RegExp(`^version:\\s*${version.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*$`, 'm'))
    || !latest.includes(`url: ${installer}`) || !latest.includes(installerSha512)) {
  console.error('❌ latest.yml 与当前版本、安装包或 SHA-512 不一致');
  process.exit(1);
}
console.log('📁 发布三件套校验通过:');
files.forEach(file => console.log(`   ${path.basename(file)}`));
if (checkOnly) process.exit(0);

// 4. 打 tag
const tag = `v${version}`;
if (runOptional('git', ['rev-parse', '--verify', `refs/tags/${tag}`])) {
  console.log(`\n🏷 tag 已存在: ${tag}`);
} else {
  console.log(`\n🏷 创建 tag: ${tag}`);
  run('git', ['tag', tag]);
  console.log('📤 推送 tag...');
  run('git', ['push', 'origin', tag]);
}

// 6. 创建 GitHub Release
try {
  if (runOptional('gh', ['release', 'view', tag, '--repo', REPO])) {
    console.log(`\n🚀 Release 已存在，补传当前版本三件套...`);
    run('gh', ['release', 'upload', tag, ...files, '--repo', REPO, '--clobber']);
  } else {
    console.log(`\n🚀 创建 Release...`);
    const createArgs = ['release', 'create', tag, ...files, '--repo', REPO, '--title', tag, '--notes', notes];
    if (version.includes('-')) createArgs.push('--prerelease');
    run('gh', createArgs);
  }
  console.log(`\n✅ 发布完成!`);
} catch (e) {
  console.error('❌ 发布失败，请检查 GitHub 连接和权限（需安装 gh CLI 并登录）');
  process.exit(1);
}
