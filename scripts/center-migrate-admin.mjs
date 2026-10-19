import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const ROOT = path.join(process.env.ProgramData || 'C:\\ProgramData', 'MiloginCenter');
const CONFIG = path.join(ROOT, 'postgres.json');
const BACKUP = path.join(ROOT, 'pre-admin-migration.dump');
const PG_DUMP = path.join(process.env.PROSPECTOR_PG_BIN || 'C:\\Program Files\\PostgreSQL\\18\\bin', 'pg_dump.exe');
const ADMIN_EMAIL = 'admin@yqn.com';
const APP_NAME = 'milogin_app';
const DATABASE = 'milogin_center';
const PORT = 55846;
const TEST_CONFIG = path.resolve('.work/pg-crm/config.json');
const MARKER = 'milogin-center-postgres-v1';
const CODE_OK = 0;
const CODE_FAILED = 1;

function log(level, message) {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] [center.migrate] ${message}\n`);
}
function sourceConfig() {
  const value = JSON.parse(fs.readFileSync(TEST_CONFIG, 'utf8'));
  if (value.marker !== 'prospector-crm-isolated-v1' || value.host !== '127.0.0.1'
    || value.port !== 55843 || value.database !== 'prospector_crm_test'
    || value.user !== 'prospector_crm_test' || typeof value.password !== 'string') {
    throw new Error('来源测试库配置不匹配');
  }
  return { host: value.host, port: value.port, database: value.database,
    user: value.user, password: value.password, max: 1 };
}
function targetConfig() {
  const value = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (value.marker !== MARKER || value.host !== '127.0.0.1' || value.port !== PORT
    || value.database !== DATABASE || value.app !== APP_NAME
    || value.cluster !== path.join(ROOT, 'postgres-data')
    || !/^[a-f0-9]{64}$/.test(value.appPassword)) throw new Error('目标正式库配置不匹配');
  return { host: value.host, port: value.port, database: value.database,
    user: value.app, password: value.appPassword, max: 1 };
}
async function assertDatabase(pool, database, user) {
  const result = await pool.query('SELECT current_database() AS db, current_user AS role');
  if (result.rows[0].db !== database || result.rows[0].role !== user) {
    throw new Error('数据库身份不匹配');
  }
}
function backup(config) {
  if (fs.existsSync(BACKUP)) throw new Error('已有迁移前备份，拒绝覆盖');
  const temp = `${BACKUP}.tmp`;
  if (fs.existsSync(temp)) throw new Error('存在未完成的备份，拒绝覆盖');
  try {
    execFileSync(PG_DUMP, ['-h', config.host, '-p', String(config.port), '-U', config.user,
      '-d', config.database, '-Fc', '-f', temp], {
      env: { ...process.env, PGPASSWORD: config.password }, windowsHide: true,
      timeout: 120000, stdio: 'ignore',
    });
    if (!fs.statSync(temp).size) throw new Error('迁移前备份为空');
    fs.renameSync(temp, BACKUP);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}
async function main() {
  const verifyOnly = process.argv[2] === 'verify';
  if (process.argv.length > (verifyOnly ? 3 : 2)) throw new Error('用法：center-migrate-admin.mjs [verify]');
  const target = targetConfig();
  const source = new Pool(sourceConfig());
  const destination = new Pool(target);
  try {
    await assertDatabase(source, 'prospector_crm_test', 'prospector_crm_test');
    await assertDatabase(destination, DATABASE, APP_NAME);
    const matching = await source.query(`SELECT u.user_id,u.display_name,u.active,u.identity_admin,
      u.security_revision,u.management_revision,u.created_at,u.deleted_at,u.must_change_password,
      e.email,e.verified_at,c.password_hash,c.hash_scheme,c.changed_at
      FROM identity.users u JOIN identity.login_emails e USING(user_id)
      JOIN identity.credentials c USING(user_id) WHERE e.email=$1`, [ADMIN_EMAIL]);
    if (matching.rowCount !== 1 || !matching.rows[0].active || !matching.rows[0].identity_admin
      || matching.rows[0].deleted_at || matching.rows[0].must_change_password
      || matching.rows[0].hash_scheme !== 'scrypt-v1') throw new Error('来源超管身份不符合迁移条件');
    const present = await destination.query("SELECT to_regclass('identity.users') AS users");
    if (verifyOnly) {
      if (!present.rows[0].users) throw new Error('目标身份表尚未建立');
      const migrated = await destination.query(`SELECT u.user_id,u.active,u.identity_admin,
        u.security_revision,u.management_revision,u.must_change_password,e.email,e.verified_at,
        c.password_hash,c.hash_scheme FROM identity.users u
        JOIN identity.login_emails e USING(user_id)
        JOIN identity.credentials c USING(user_id)`);
      const sessions = await destination.query(`SELECT
        (SELECT count(*)::int FROM identity.sessions) AS sessions,
        (SELECT count(*)::int FROM identity.desktop_refresh_tokens) AS refresh_tokens`);
      const original = matching.rows[0], copied = migrated.rows[0];
      if (migrated.rowCount !== 1 || copied.user_id !== original.user_id
        || copied.email !== ADMIN_EMAIL || copied.password_hash !== original.password_hash
        || copied.hash_scheme !== original.hash_scheme || !copied.active || !copied.identity_admin
        || copied.security_revision !== original.security_revision
        || copied.management_revision !== original.management_revision
        || copied.must_change_password !== original.must_change_password
        || String(copied.verified_at) !== String(original.verified_at)
        || sessions.rows[0].sessions !== 0 || sessions.rows[0].refresh_tokens !== 0) {
        throw new Error('迁移身份、密码校验或会话边界不一致');
      }
      log('INFO', '独立核验通过：同一超管身份及密码校验、总账号 1、会话 0、刷新凭据 0');
      return;
    }
    if (present.rows[0].users) throw new Error('目标身份表已存在，拒绝再次迁移');
    backup(target);
    log('INFO', '迁移前备份完成，开始建表');
    process.env.PROSPECTOR_CENTER_MODE = 'production';
    process.env.PROSPECTOR_CENTER_PG_DSN = `postgresql://${APP_NAME}:${target.password}@127.0.0.1:${PORT}/${DATABASE}`;
    const { PostgresCrmRepository } = require('../dist-server/adapters/postgres/repository.js');
    const { PostgresAuthRepository } = require('../dist-server/adapters/postgres/auth-repository.js');
    const { PostgresLeadRepository } = require('../dist-server/adapters/postgres/lead-repository.js');
    const { PostgresNotificationRepository } = require('../dist-server/adapters/postgres/notification-repository.js');
    const { PostgresTaskRepository } = require('../dist-server/adapters/postgres/task-repository.js');
    const { PostgresOpportunityRepository } = require('../dist-server/adapters/postgres/opportunity-repository.js');
    const logger = { write(level, context, message) { log(level, `${context} ${message}`); } };
    for (const Repository of [PostgresCrmRepository, PostgresAuthRepository,
      PostgresLeadRepository, PostgresNotificationRepository, PostgresTaskRepository,
      PostgresOpportunityRepository]) {
      const result = await new Repository(destination, logger).migrate();
      if (!result.ok) throw new Error(`建表被拒绝: ${result.error?.code ?? 'unknown'}`);
    }
    const client = await destination.connect();
    try {
      await client.query('BEGIN');
      const identityCount = await client.query('SELECT count(*)::int AS n FROM identity.users');
      const sessionCount = await client.query('SELECT count(*)::int AS n FROM identity.sessions');
      if (identityCount.rows[0].n !== 0 || sessionCount.rows[0].n !== 0) {
        throw new Error('目标库已有账号或会话，拒绝迁移');
      }
      const u = matching.rows[0];
      await client.query(`INSERT INTO identity.users
        (user_id,display_name,active,identity_admin,security_revision,management_revision,
         created_at,deleted_at,must_change_password) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [u.user_id,u.display_name,u.active,u.identity_admin,u.security_revision,
        u.management_revision,u.created_at,u.deleted_at,u.must_change_password]);
      await client.query('INSERT INTO identity.login_emails(user_id,email,verified_at) VALUES($1,$2,$3)',
        [u.user_id,u.email,u.verified_at]);
      await client.query(`INSERT INTO identity.credentials
        (user_id,password_hash,hash_scheme,changed_at) VALUES($1,$2,$3,$4)`,
      [u.user_id,u.password_hash,u.hash_scheme,u.changed_at]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    const verified = await destination.query(`SELECT count(*)::int AS users,
      count(*) FILTER (WHERE identity_admin AND active AND deleted_at IS NULL)::int AS admins
      FROM identity.users`);
    const sessions = await destination.query('SELECT count(*)::int AS n FROM identity.sessions');
    if (verified.rows[0].users !== 1 || verified.rows[0].admins !== 1 || sessions.rows[0].n !== 0) {
      throw new Error('迁移后账号或会话数量异常');
    }
    log('INFO', '仅迁入 1 名超级管理员；测试账号 0、登录会话 0；网页服务未切换');
  } finally {
    delete process.env.PROSPECTOR_CENTER_PG_DSN;
    await source.end();
    await destination.end();
  }
}

try { await main(); process.exitCode = CODE_OK; }
catch (error) { log('ERROR', error instanceof Error ? error.message : '迁移失败'); process.exitCode = CODE_FAILED; }
