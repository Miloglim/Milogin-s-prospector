import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'prospector-center-test-';
const TIMEOUT_MS = 180000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const JSON_INDENT = 2;
const PASSWORD_CONCURRENCY = 2;
const LOG_DIRECTORY = path.join(ROOT, '.work/center-tests');
const FILES = [
  'online-auth', 'offline-access', 'desktop-session', 'crm-postgres', 'admin-platform', 'password-change',
  'lead-collaboration', 'r2-center-customers', 'customer-workbook-import', 'customer-followup',
  'lead-assignment', 'crm-experience-projection', 'lead-http', 'notification-delivery',
  'contact-assignment-acceptance', 'contact-sharing-pg', 'center-contact-list', 'contact-mail-acceptance', 'contact-mail-correction', 'contact-mail-send-stage', 'send-acceptance',
  'admin-product-identity', 'admin-lifecycle', 'followup-tasks', 'opportunities', 'offline-crm-postgres',
  'account-registration','crm-lifecycle-pg','legacy-mail-sync-contract',
].map(name => `tests/integration/${name}.test.ts`);
const UNIT_FILES = ['crm-lifecycle','customer-followup-service', 'lead-assignment', 'online-crm', 'password-change', 'online-auth', 'admin-http', 'account-credentials', 'http-body', 'center-runtime-config', 'legacy-mail-sync', 'legacy-mail-sync-store']
  .map(name => `tests/unit/${name}.test.ts`);
function log(level, message) { process.stdout.write(`[${new Date().toISOString()}] [${level}] [center.tests] ${message}\n`); }
function run(args, cwd) {
  return execFileSync(process.execPath, args, { cwd, env: process.env, windowsHide: true, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}
// Source snapshots never contain live runtime credentials or the current center database.
const project = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
const report = { isolated: true, started: false, stopped: false, removed: false, exitCode: 1 };
fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
try {
  for (const name of ['server', 'scripts', 'tests', 'src', 'admin-web', 'docs', 'dist-admin']) {
    const source = path.join(ROOT, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(project, name), { recursive: true });
  }
  for (const name of ['package.json', 'vitest.config.ts', 'tsconfig.server.json']) fs.copyFileSync(path.join(ROOT, name), path.join(project, name));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const settingsFile = path.join(project, 'server/core/postgres-test-settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.port = await freePort();
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, JSON_INDENT));
  log('INFO', '创建一次性测试实例，不连接当前中心库');
  fs.writeFileSync(path.join(LOG_DIRECTORY, 'build.log'), run([path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.server.json'], project));
  // Mark before startup: if initialization partially succeeds, finally still attempts a verified stop.
  report.started = true;
  fs.writeFileSync(path.join(LOG_DIRECTORY, 'startup.log'), run(['scripts/crm-postgres.mjs', 'start'], project));
  const seed = `
    const {Pool}=require('pg');
    const {readTestDatabaseConfig}=require('./dist-server/adapters/postgres/config');
    const {PasswordAdapter}=require('./dist-server/adapters/password');
    const {initializeFixtures}=require('./dist-server/adapters/fixtures');
    (async()=>{const pool=new Pool(readTestDatabaseConfig()),log={write:()=>{}};
      try{for(const [file,name] of [['repository','PostgresCrmRepository'],['auth-repository','PostgresAuthRepository'],['admin-repository','PostgresAdminRepository'],['lead-repository','PostgresLeadRepository'],['notification-repository','PostgresNotificationRepository'],['task-repository','PostgresTaskRepository'],['opportunity-repository','PostgresOpportunityRepository']]){
        const repo=new (require('./dist-server/adapters/postgres/'+file)[name])(pool,log),r=await repo.migrate();if(!r.ok)throw Error('Migration failed');
      }const passwords=new PasswordAdapter(${PASSWORD_CONCURRENCY});await passwords.initialize();await initializeFixtures(new (require('./dist-server/adapters/postgres/auth-repository').PostgresAuthRepository)(pool,log),passwords,true);
      }finally{await pool.end();}})().catch(()=>{process.stderr.write('Test initialization failed\\n');process.exitCode=1;});`;
  run(['-e', seed], project);
  const env = { ...process.env, PROSPECTOR_PG_INTEGRATION: '1', PROSPECTOR_A2_TEST: '1', PROSPECTOR_LIFECYCLE_TEST: '1', PROSPECTOR_TASK_TEST: '1', PROSPECTOR_OPPORTUNITY_TEST: '1' };
  const requested = process.argv.slice(2);
  const selected = requested.length ? requested : [...FILES, ...UNIT_FILES, 'admin-web/api.test.ts', 'admin-web/permissions.test.ts'];
  if (selected.some(file => ![...FILES, ...UNIT_FILES, 'admin-web/api.test.ts', 'admin-web/permissions.test.ts'].includes(file))) throw Error('测试文件不在中心检查清单中');
  let output;
  try {
    output = execFileSync(process.execPath, [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--no-file-parallelism', ...selected], {
      cwd: project, env, windowsHide: true, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
    });
    report.exitCode = 0;
  } catch (error) {
    output = String(error.stdout ?? '') + '\n' + String(error.stderr ?? '');
    report.exitCode = error.status || 1;
  }
  fs.writeFileSync(path.join(LOG_DIRECTORY, 'tests.log'), output);
  process.stdout.write(output);
} catch (error) {
  log('ERROR', error instanceof Error && !('stdout' in error) ? error.message : '隔离测试准备失败，检查本机测试日志');
} finally {
  if (report.started) {
    try { run(['scripts/crm-postgres.mjs', 'stop'], project); report.stopped = true; }
    catch { log('ERROR', '无法核实测试集群已停止，保留临时目录供排查'); }
  }
  if (!report.started || report.stopped) {
    if (path.dirname(project) !== path.resolve(os.tmpdir()) || !path.basename(project).startsWith(PREFIX) || fs.realpathSync(project) !== project) throw Error('临时路径校验失败');
    const dependencyLink = path.join(project, 'node_modules');
    if (fs.existsSync(dependencyLink)) {
      if (!fs.lstatSync(dependencyLink).isSymbolicLink()) throw Error('测试依赖不是受控链接');
      fs.rmSync(dependencyLink, { recursive: true });
    }
    fs.rmSync(project, { recursive: true });
    report.removed = true;
  }
  fs.writeFileSync(path.join(LOG_DIRECTORY, 'report.json'), JSON.stringify(report, null, JSON_INDENT));
  if (!report.removed) log('ERROR', `未回收的隔离目录：${project}`);
  process.exitCode = report.exitCode || (report.removed ? 0 : 1);
}
