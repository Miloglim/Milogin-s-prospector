import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(process.env.ProgramData || 'C:\\ProgramData', 'MiloginCenter');
const CONFIG = path.join(RUNTIME, 'postgres.json');
const BACKUP = path.join(RUNTIME, 'pre-public-team-upgrade.dump');
const PG_DUMP = path.join(process.env.PROSPECTOR_PG_BIN || 'C:\\Program Files\\PostgreSQL\\18\\bin', 'pg_dump.exe');
const SQL = path.join(ROOT, 'deployment-templates', 'company-postgres-programmable.sql');
const MARKER = 'milogin-center-postgres-v1';

const IDENTITY_TABLES = [
  ['products', 'identity_products'],
  ['users', 'identity_users'],
  ['login_emails', 'identity_login_emails'],
  ['credentials', 'identity_credentials'],
  ['product_grants', 'identity_product_grants'],
  ['product_access', 'identity_product_access'],
  ['user_profiles', 'identity_user_profiles'],
  ['account_experience_events', 'identity_account_experience_events'],
  ['account_growth_projection', 'identity_account_growth_projection'],
  ['audit', 'identity_audit'],
  ['management_audit', 'identity_management_audit'],
  ['legacy_account_mappings', 'identity_legacy_account_mappings'],
  ['login_aliases', 'identity_login_aliases'],
  ['sessions', 'identity_sessions'],
  ['management_challenges', 'identity_management_challenges'],
  ['desktop_refresh_tokens', 'identity_desktop_refresh_tokens'],
  ['outbox', 'identity_outbox'],
];

const CURRENT_VERSION_ALIASES = {
  '005-lead-collaboration-public': '005-lead-collaboration',
  '006-notification-m2-public': '006-notification-m2',
  '008-contact-change-import-capture-public': '008-contact-change-import-capture',
  '009-directed-assignment-public': '009-directed-assignment',
  '011-customer-workbook-profile-public': '011-customer-workbook-profile',
  '017-followup-tasks-public': '017-followup-tasks',
  '018-opportunities-public': '018-opportunities',
  '019-contact-assignment-acceptance-public': '019-contact-assignment-acceptance',
  '020-contact-mail-events-public': '020-contact-mail-events',
  '021-contact-mail-send-stage-public': '021-contact-mail-send-stage',
  '022-crm-lifecycle-public': '022-crm-lifecycle',
  '023-contact-sharing-public': '023-contact-sharing',
  '025-send-acceptance-public': '025-send-acceptance',
  '026-server-campaigns-n7-public': '026-server-campaigns-n7',
};

function log(level, message) {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] [center.public-upgrade] ${message}\n`);
}

function targetConfig() {
  const value = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (value.marker !== MARKER || !value.app || !value.appPassword || !value.database || !value.host || !value.port) {
    throw new Error('正式中心数据库配置无效');
  }
  return { host: value.host, port: value.port, database: value.database, user: value.app, password: value.appPassword, max: 1, application_name: 'prospector-public-upgrade' };
}

function backup(config) {
  if (fs.existsSync(BACKUP)) {
    if (!fs.statSync(BACKUP).size) throw new Error('既有升级备份为空，拒绝继续');
    return;
  }
  const temporary = `${BACKUP}.tmp`;
  if (fs.existsSync(temporary)) throw new Error('存在未完成备份，拒绝覆盖');
  try {
    const result = spawnSync(PG_DUMP, ['-h', config.host, '-p', String(config.port), '-U', config.user, '-d', config.database, '-Fc', '-f', temporary], {
      env: { ...process.env, PGPASSWORD: config.password }, windowsHide: true, timeout: 120000, stdio: 'ignore',
    });
    if (result.status !== 0 || !fs.existsSync(temporary) || fs.statSync(temporary).size === 0) throw new Error('数据库备份失败');
    fs.renameSync(temporary, BACKUP);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function currentChecksums() {
  const directory = path.join(ROOT, 'dist-server', 'adapters', 'postgres');
  const result = new Map();
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('-schema.js'))) {
    const module = require(path.join(directory, file));
    for (const [key, version] of Object.entries(module)) {
      if (!key.endsWith('_VERSION') || typeof version !== 'string') continue;
      const sqlKey = key.replace(/_VERSION$/, '_SQL');
      if (typeof module[sqlKey] !== 'string') continue;
      result.set(version, createHash('sha256').update(module[sqlKey]).digest('hex'));
    }
  }
  return result;
}

async function columns(client, schema, table) {
  return (await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position', [schema, table])).rows.map(row => row.column_name);
}

function quote(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function copyIdentity(client) {
  const copied = {};
  for (const [legacy, target] of IDENTITY_TABLES) {
    const targetColumns = await columns(client, 'public', target);
    const legacyColumns = await columns(client, 'identity', legacy);
    const shared = legacyColumns.filter(column => targetColumns.includes(column));
    if (!shared.length) throw new Error(`identity.${legacy} 无共同字段`);
    const names = shared.map(quote).join(',');
    const values = shared.map(column => target === 'identity_outbox' && column === 'recipient_user_ids'
      ? "COALESCE(\"recipient_user_ids\",'{}'::uuid[])"
      : target === 'identity_outbox' && column === 'payload'
        ? "COALESCE(\"payload\",'{}'::jsonb)"
        : quote(column)).join(',');
    const result = await client.query(`INSERT INTO public.${quote(target)} (${names}) OVERRIDING SYSTEM VALUE SELECT ${values} FROM identity.${quote(legacy)} ON CONFLICT DO NOTHING`);
    copied[legacy] = result.rowCount;
  }
  return copied;
}

async function repointForeignKeys(client) {
  const rows = (await client.query(`
    SELECT c.conrelid::regclass::text AS table_name,c.conname,pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c
    JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname='public' AND c.contype='f' AND c.confrelid='identity.users'::regclass
    ORDER BY 1,2
  `)).rows;
  for (const row of rows) {
    const definition = row.definition.replace('REFERENCES identity.users', 'REFERENCES public.identity_users');
    await client.query(`ALTER TABLE ${row.table_name} DROP CONSTRAINT ${quote(row.conname)}`);
    await client.query(`ALTER TABLE ${row.table_name} ADD CONSTRAINT ${quote(row.conname)} ${definition}`);
  }
  return rows.length;
}

async function setIdentitySequences(client) {
  const rows = (await client.query(`
    SELECT table_name,column_name,pg_get_serial_sequence(format('public.%I',table_name),column_name) AS sequence_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name LIKE 'identity_%' AND pg_get_serial_sequence(format('public.%I',table_name),column_name) IS NOT NULL
  `)).rows;
  for (const row of rows) {
    await client.query(`SELECT setval($1, COALESCE((SELECT max(${quote(row.column_name)}) FROM public.${quote(row.table_name)}),1), (SELECT max(${quote(row.column_name)}) IS NOT NULL FROM public.${quote(row.table_name)}))`, [row.sequence_name]);
  }
}

async function main() {
  if (!process.argv.includes('--apply') || !process.argv.includes('--confirm-upgrade')) {
    throw new Error('用法：node scripts/upgrade-local-center-public.mjs --apply --confirm-upgrade');
  }
  try {
    const response = await fetch('http://127.0.0.1:55847/health/live', { signal: AbortSignal.timeout(1000) });
    if (response.ok) throw new Error('中心仍在运行，请先停止服务再升级');
  } catch (error) {
    if (error instanceof Error && error.message.includes('仍在运行')) throw error;
    // A refused connection is the required maintenance-window state.
  }
  const config = targetConfig();
  backup(config);
  log('INFO', '升级前数据库备份完成');
  const pool = new Pool(config);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const legacyUsers = Number((await client.query('SELECT count(*)::int AS count FROM identity.users')).rows[0].count);
    const publicUsers = Number((await client.query('SELECT count(*)::int AS count FROM public.identity_users')).rows[0].count);
    if (legacyUsers < 1) throw new Error('旧身份表没有可迁移账号');
    if (publicUsers !== 0 && publicUsers !== legacyUsers) throw new Error('public.identity_users 已含不同账号，拒绝自动合并');

    await client.query("ALTER TABLE public.identity_outbox ADD COLUMN IF NOT EXISTS customer_id uuid");
    await client.query("ALTER TABLE public.identity_outbox ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}'::jsonb");
    await client.query("ALTER TABLE public.identity_outbox ADD COLUMN IF NOT EXISTS recipient_user_ids uuid[] NOT NULL DEFAULT '{}'::uuid[]");
    const copied = await copyIdentity(client);
    const repointed = await repointForeignKeys(client);
    await setIdentitySequences(client);

    const teamSchema = require(path.join(ROOT, 'dist-server', 'adapters', 'postgres', 'team-schema.js'));
    const teamExists = await client.query("SELECT to_regclass('public.crm_teams') AS value");
    if (!teamExists.rows[0].value) await client.query(teamSchema.TEAM_SCHEMA_SQL);

    const checksums = currentChecksums();
    for (const [current, legacy] of Object.entries(CURRENT_VERSION_ALIASES)) {
      const present = await client.query('SELECT 1 FROM crm_schema_migrations WHERE version=$1', [current]);
      if (present.rows.length) continue;
      const old = await client.query('SELECT 1 FROM crm_schema_migrations WHERE version=$1', [legacy]);
      if (!old.rows.length) throw new Error(`缺少旧迁移基线: ${legacy}`);
      const checksum = checksums.get(current);
      if (!checksum) throw new Error(`缺少当前迁移校验: ${current}`);
      await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [current, checksum]);
    }
    const teamPresent = await client.query('SELECT 1 FROM crm_schema_migrations WHERE version=$1', [teamSchema.TEAM_SCHEMA_VERSION]);
    if (!teamPresent.rows.length) await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [teamSchema.TEAM_SCHEMA_VERSION, createHash('sha256').update(teamSchema.TEAM_SCHEMA_SQL).digest('hex')]);
    const treePresent = await client.query('SELECT 1 FROM crm_schema_migrations WHERE version=$1', [teamSchema.TEAM_TREE_VERSION]);
    if (!treePresent.rows.length) {
      await client.query(teamSchema.TEAM_TREE_SQL);
      await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [teamSchema.TEAM_TREE_VERSION, createHash('sha256').update(teamSchema.TEAM_TREE_SQL).digest('hex')]);
    }
    await client.query('ALTER TABLE public.identity_outbox ADD CONSTRAINT identity_outbox_customer_id_fkey FOREIGN KEY(customer_id) REFERENCES crm_customers(customer_id)');
    // This maintenance script upgrades the legacy local center, whose tables intentionally remain in public.
    const programmable = fs.readFileSync(SQL, 'utf8').replace(/\b(?:prospector|navigator)\./g, 'public.');
    const navigatorViews = programmable.indexOf('CREATE OR REPLACE VIEW public.freight_rates');
    if (navigatorViews < 0) throw new Error('公共函数脚本边界缺失');
    await client.query(programmable.slice(0, navigatorViews));

    const verify = {
      legacyUsers,
      publicUsers: Number((await client.query('SELECT count(*)::int AS count FROM public.identity_users')).rows[0].count),
      publicGrants: Number((await client.query('SELECT count(*)::int AS count FROM public.identity_product_grants')).rows[0].count),
      publicAccess: Number((await client.query('SELECT count(*)::int AS count FROM public.identity_product_access')).rows[0].count),
      publicRefreshTokens: Number((await client.query('SELECT count(*)::int AS count FROM public.identity_desktop_refresh_tokens')).rows[0].count),
      teamTables: Number((await client.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('crm_teams','crm_team_members','crm_team_invitations','crm_team_idempotency')")).rows[0].count),
      teamMigration: Number((await client.query("SELECT count(*)::int AS count FROM crm_schema_migrations WHERE version=ANY($1::text[])", [[teamSchema.TEAM_SCHEMA_VERSION, teamSchema.TEAM_TREE_VERSION]])).rows[0].count),
    };
    if (verify.publicUsers !== legacyUsers || verify.teamTables !== 4 || verify.teamMigration !== 2) throw new Error('升级后账号或团队结构校验失败');
    await client.query('COMMIT');
    log('INFO', `账号=${verify.publicUsers} 权限=${verify.publicGrants} 产品准入=${verify.publicAccess} 刷新凭据=${verify.publicRefreshTokens} 外键重指向=${repointed} 团队表=${verify.teamTables}`);
    log('INFO', `身份复制摘要=${JSON.stringify(copied)}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  log('ERROR', error instanceof Error ? error.message : '升级失败');
  process.exitCode = 1;
}
