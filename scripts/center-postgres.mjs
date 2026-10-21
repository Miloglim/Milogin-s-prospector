import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('pg');
const ROOT = path.join(process.env.ProgramData || 'C:\\ProgramData', 'MiloginCenter');
const CLUSTER = path.join(ROOT, 'postgres-data');
const CONFIG = path.join(ROOT, 'postgres.json');
const PASSWORD_FILE = path.join(ROOT, 'init-password.tmp');
const LOG = path.join(ROOT, 'postgres.log');
const BACKUP_DIR = path.join(ROOT, 'backups');
const MARKER = 'milogin-center-postgres-v1';
const CONFIG_VERSION = 2;
const BIN = process.env.PROSPECTOR_PG_BIN || 'C:\\Program Files\\PostgreSQL\\18\\bin';
const HOST = '127.0.0.1';
const PORT = 55846;
const DATABASE = 'milogin_center';
const OWNER = 'milogin_owner';
const APP = 'milogin_app';
const NAVIGATOR_DATABASE = 'navigator_rates';
const NAVIGATOR_APP = 'navigator_app';
const PASSWORD_BYTES = 32;
const COMMAND_TIMEOUT_MS = 30000;
const START_TIMEOUT_SECONDS = 20;
const CONFIG_MODE = 0o600;
const NOT_RUNNING = 3;
const command = process.argv[2];

function log(level, message) {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] [center.pg] ${message}\n`);
}
function tool(name, args) {
  return execFileSync(path.join(BIN, `${name}.exe`), args, {
    windowsHide: true, timeout: COMMAND_TIMEOUT_MS, stdio: 'ignore',
  });
}
function readConfig() {
  const info = fs.lstatSync(ROOT);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('中心目录无效');
  const value = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (value.marker !== MARKER || value.cluster !== CLUSTER || value.host !== HOST
    || value.port !== PORT || value.database !== DATABASE || value.owner !== OWNER
    || value.app !== APP || !/^[a-f0-9]{64}$/.test(value.ownerPassword)
    || !/^[a-f0-9]{64}$/.test(value.appPassword)
    || !fs.existsSync(path.join(CLUSTER, 'PG_VERSION'))) throw new Error('中心集群配置不匹配');
  if (!value.navigatorDatabase || !value.navigatorApp || !value.navigatorPassword) {
    value.configVersion = CONFIG_VERSION;
    value.navigatorDatabase = NAVIGATOR_DATABASE;
    value.navigatorApp = NAVIGATOR_APP;
    value.navigatorPassword = randomBytes(PASSWORD_BYTES).toString('hex');
    fs.writeFileSync(CONFIG, JSON.stringify(value), { mode: CONFIG_MODE });
  } else if (!/^[a-f0-9]{64}$/.test(value.navigatorPassword)) {
    throw new Error('Navigator 数据库配置不匹配');
  }
  return value;
}
function initialize() {
  if (fs.existsSync(ROOT)) return readConfig();
  if (!fs.existsSync(path.join(BIN, 'initdb.exe')) || !fs.existsSync(path.join(BIN, 'pg_ctl.exe'))) {
    throw new Error('缺少 PostgreSQL 18 工具');
  }
  fs.mkdirSync(ROOT, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [ROOT, '/inheritance:r', '/grant:r', `${os.userInfo().username}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'],
      { windowsHide: true, timeout: COMMAND_TIMEOUT_MS, stdio: 'ignore' });
  } else fs.chmodSync(ROOT, 0o700);
  const value = {
    marker: MARKER, configVersion: CONFIG_VERSION, cluster: CLUSTER, host: HOST, port: PORT, database: DATABASE,
    owner: OWNER, app: APP,
    navigatorDatabase: NAVIGATOR_DATABASE, navigatorApp: NAVIGATOR_APP,
    ownerPassword: randomBytes(PASSWORD_BYTES).toString('hex'),
    appPassword: randomBytes(PASSWORD_BYTES).toString('hex'),
    navigatorPassword: randomBytes(PASSWORD_BYTES).toString('hex'),
  };
  fs.writeFileSync(CONFIG, JSON.stringify(value), { mode: CONFIG_MODE, flag: 'wx' });
  fs.writeFileSync(PASSWORD_FILE, value.ownerPassword, { mode: CONFIG_MODE, flag: 'wx' });
  try {
    tool('initdb', ['-D', CLUSTER, '-U', OWNER, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C', `--pwfile=${PASSWORD_FILE}`]);
    fs.appendFileSync(path.join(CLUSTER, 'postgresql.conf'), `\nlisten_addresses = '${HOST}'\nport = ${PORT}\n`);
  } finally {
    if (fs.existsSync(PASSWORD_FILE)) fs.unlinkSync(PASSWORD_FILE);
  }
  return value;
}
function running() {
  try { tool('pg_ctl', ['status', '-D', CLUSTER]); return true; }
  catch (error) {
    if (error.status === NOT_RUNNING) return false;
    throw error;
  }
}
async function verify(config, create) {
  const client = new Client({ host: HOST, port: PORT, database: 'postgres', user: OWNER,
    password: config.ownerPassword, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const probe = await client.query("SELECT current_setting('data_directory') AS directory, current_setting('port')::int AS port");
    if (path.resolve(probe.rows[0].directory).toLowerCase() !== CLUSTER.toLowerCase()
      || probe.rows[0].port !== PORT) throw new Error('连接的不是中心专用集群');
    const role = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [APP]);
    if (!role.rowCount && create) await client.query(`CREATE ROLE ${APP} LOGIN PASSWORD '${config.appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    const database = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [DATABASE]);
    if (!database.rowCount && create) await client.query(`CREATE DATABASE ${DATABASE} OWNER ${APP}`);
    const navigatorRole = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [NAVIGATOR_APP]);
    if (create && navigatorRole.rowCount) await client.query(`ALTER ROLE ${NAVIGATOR_APP} LOGIN PASSWORD '${config.navigatorPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    else if (!navigatorRole.rowCount && create) await client.query(`CREATE ROLE ${NAVIGATOR_APP} LOGIN PASSWORD '${config.navigatorPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    const navigatorDatabase = await client.query('SELECT 1 FROM pg_database WHERE datname=$1', [NAVIGATOR_DATABASE]);
    if (!navigatorDatabase.rowCount && create) await client.query(`CREATE DATABASE ${NAVIGATOR_DATABASE} OWNER ${NAVIGATOR_APP}`);
    if ((!role.rowCount || !database.rowCount) && !create) throw new Error('中心角色或数据库未建立');
    if ((!navigatorRole.rowCount || !navigatorDatabase.rowCount) && !create) throw new Error('Navigator 角色或数据库未建立');
  } finally { await client.end(); }
  const app = new Client({ host: HOST, port: PORT, database: DATABASE, user: APP,
    password: config.appPassword, connectionTimeoutMillis: 5000 });
  try {
    await app.connect();
    const result = await app.query('SELECT current_database() AS db, current_user AS role');
    if (result.rows[0].db !== DATABASE || result.rows[0].role !== APP) throw new Error('中心应用连接不匹配');
  } finally { await app.end(); }
  const navigator = new Client({ host: HOST, port: PORT, database: NAVIGATOR_DATABASE, user: NAVIGATOR_APP,
    password: config.navigatorPassword, connectionTimeoutMillis: 5000 });
  try {
    await navigator.connect();
    const result = await navigator.query('SELECT current_database() AS db, current_user AS role');
    if (result.rows[0].db !== NAVIGATOR_DATABASE || result.rows[0].role !== NAVIGATOR_APP) throw new Error('Navigator 应用连接不匹配');
  } finally { await navigator.end(); }
}

function backup(config) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const output = path.join(BACKUP_DIR, `center-${stamp}.dump`);
  const temporary = `${output}.tmp`;
  try {
    execFileSync(path.join(BIN, 'pg_dump.exe'), ['-h', HOST, '-p', String(PORT), '-U', APP,
      '-d', DATABASE, '-Fc', '-f', temporary], {
      env: { ...process.env, PGPASSWORD: config.appPassword }, windowsHide: true,
      timeout: 120000, stdio: 'ignore',
    });
    if (!fs.statSync(temporary).size) throw new Error('备份文件为空');
    execFileSync(path.join(BIN, 'pg_restore.exe'), ['--list', temporary], {
      windowsHide: true, timeout: COMMAND_TIMEOUT_MS, stdio: 'ignore',
    });
    fs.renameSync(temporary, output);
    log('INFO', `独立中心数据库备份已校验 ${output}`);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

try {
  if (!['start', 'status', 'backup'].includes(command)) throw new Error('用法：center-postgres.mjs start|status|backup');
  const config = command === 'start' ? initialize() : readConfig();
  if (!running()) {
    if (command !== 'start') throw new Error('中心专用集群尚未运行');
    tool('pg_ctl', ['start', '-D', CLUSTER, '-l', LOG, '-w', '-t', String(START_TIMEOUT_SECONDS)]);
  }
  await verify(config, command === 'start');
  if (command === 'backup') backup(config);
  log('INFO', `独立中心数据库就绪 ${HOST}:${PORT}/${DATABASE}`);
} catch {
  log('ERROR', '中心专用数据库未就绪；检查受控目录、端口与本机日志，不要发送密码');
  process.exitCode = 1;
}
