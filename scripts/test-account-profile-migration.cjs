// Exercises both apply and repeat-apply inside a disposable PostgreSQL database.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Client } = require('pg');

const root = process.cwd();
const config = JSON.parse(fs.readFileSync(path.join(root, '.work/pg-crm/config.json'), 'utf8'));
if (config.marker !== 'prospector-crm-isolated-v1' || config.host !== '127.0.0.1' || !config.password) throw new Error('测试 PostgreSQL 配置无效');
const database = `account_profile_migration_${randomBytes(8).toString('hex')}`;
if (!/^account_profile_migration_[a-f0-9]{16}$/.test(database)) throw new Error('临时数据库名无效');
const base = { host: config.host, port: config.port, user: config.user, password: config.password, connectionTimeoutMillis: 5000 };
const dsn = `postgresql://${encodeURIComponent(base.user)}:${encodeURIComponent(base.password)}@${base.host}:${base.port}/${database}`;

const authSchema = require(path.join(root, 'dist-server/adapters/postgres/auth-schema.js')).AUTH_SCHEMA_SQL;
const adminSchema = require(path.join(root, 'dist-server/adapters/postgres/admin-schema.js')).ADMIN_SQL;
const profileSchema = require(path.join(root, 'dist-server/adapters/postgres/account-profile-schema.js')).ACCOUNT_PROFILE_SCHEMA_SQL;
const growthSchema = require(path.join(root, 'dist-server/adapters/postgres/account-growth-schema.js')).ACCOUNT_GROWTH_SCHEMA_SQL;
const mappingSchema = require(path.join(root, 'dist-server/adapters/postgres/legacy-account-mapping-schema.js')).LEGACY_ACCOUNT_MAPPING_SCHEMA_SQL;

async function createDatabase() {
  const admin = new Client({ ...base, database: 'postgres' });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${database}`); }
  finally { await admin.end(); }
}

async function dropDatabase() {
  const admin = new Client({ ...base, database: 'postgres' });
  await admin.connect();
  try { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); }
  finally { await admin.end(); }
}

async function seed() {
  const client = new Client({ ...base, database });
  await client.connect();
  try {
    await client.query(authSchema);
    await client.query(adminSchema);
    await client.query('ALTER TABLE identity.users ADD COLUMN deleted_at timestamptz');
    await client.query(profileSchema);
    await client.query(growthSchema);
    await client.query(mappingSchema);
    await client.query(`CREATE TABLE operators(
      user_id text PRIMARY KEY,name text NOT NULL,display_name text,preferences_json text,active integer NOT NULL
    )`);
    await client.query(`CREATE TABLE account_experience_events(
      event_id text PRIMARY KEY,user_id text NOT NULL,event_type text NOT NULL,subject_key text NOT NULL,
      points integer NOT NULL,rule_version integer NOT NULL,created_at text NOT NULL,
      UNIQUE(user_id,event_type,subject_key)
    )`);
    const centerId = randomUUID(), legacyId = 'usr_profile_migration_fixture', email = 'zayne@example.invalid';
    await client.query("INSERT INTO identity.users(user_id,display_name,identity_admin) VALUES($1,'zayne',true)", [centerId]);
    await client.query('INSERT INTO identity.login_emails(user_id,email) VALUES($1,$2)', [centerId, email]);
    await client.query("INSERT INTO operators(user_id,name,display_name,preferences_json,active) VALUES($1,$2,'Zayne',$3,1)", [legacyId, email, JSON.stringify({ avatar_id: 'av-04' })]);
    await client.query("INSERT INTO account_experience_events VALUES('legacy-event',$1,'legacy_growth','legacy-day',10,1,'2026-09-30T10:00:00+08:00')", [legacyId]);
    await client.query("INSERT INTO account_experience_events VALUES('current-event',$1,'daily_effective_search',$2,18,2,'2026-10-21T09:00:00+08:00')", [legacyId, `day:${legacyId}`]);
    return { centerId, legacyId, email };
  } finally { await client.end(); }
}

function migrate() {
  return execFileSync(process.execPath, ['scripts/migrate-navigator-account-profile.mjs', '--apply'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, PROSPECTOR_ACCOUNT_MIGRATION_SOURCE_DSN: dsn, PROSPECTOR_ACCOUNT_MIGRATION_TARGET_DSN: dsn },
  });
}

async function verify(fixture, auditCount) {
  const client = new Client({ ...base, database });
  await client.connect();
  try {
    const user = (await client.query('SELECT display_name,management_revision FROM identity.users WHERE user_id=$1', [fixture.centerId])).rows[0];
    const profile = (await client.query('SELECT avatar_id,bio FROM identity.user_profiles WHERE user_id=$1', [fixture.centerId])).rows[0];
    const growth = (await client.query('SELECT total_xp,cycle,level,today_xp FROM identity.account_growth_projection WHERE user_id=$1', [fixture.centerId])).rows[0];
    const events = (await client.query("SELECT count(*)::int AS count FROM identity.account_experience_events WHERE user_id=$1 AND source_product='navigator'", [fixture.centerId])).rows[0].count;
    const mapping = (await client.query("SELECT status,center_user_id::text FROM identity.legacy_account_mappings WHERE source_product='navigator' AND legacy_user_id=$1", [fixture.legacyId])).rows[0];
    const audits = (await client.query("SELECT count(*)::int AS count FROM identity.management_audit WHERE target_id=$1 AND action='identity.navigator.profile.migrated'", [fixture.centerId])).rows[0].count;
    assert.deepEqual(user, { display_name: 'Zayne', management_revision: 2 });
    assert.deepEqual(profile, { avatar_id: 'av-04', bio: '' });
    assert.deepEqual(growth, { total_xp: 30, cycle: 1, level: 3, today_xp: 18 });
    assert.equal(events, 2);
    assert.deepEqual(mapping, { status: 'migrated', center_user_id: fixture.centerId });
    assert.equal(audits, auditCount);
    return { eventCount: events, level: growth.level, totalXp: growth.total_xp, audits };
  } finally { await client.end(); }
}

async function corruptEvent(fixture) {
  const client = new Client({ ...base, database });
  await client.connect();
  try {
    await client.query("UPDATE identity.account_experience_events SET points=19 WHERE user_id=$1 AND source_product='navigator' AND event_type='daily_effective_search'", [fixture.centerId]);
  } finally { await client.end(); }
}

(async () => {
  await createDatabase();
  try {
    const fixture = await seed();
    const firstOutput = migrate();
    const first = await verify(fixture, 1);
    const secondOutput = migrate();
    const second = await verify(fixture, 2);
    await corruptEvent(fixture);
    assert.throws(() => migrate(), /Command failed/);
    console.log(JSON.stringify({ first, second, conflictRejected: true, firstOutput, secondOutput }, null, 2));
  } finally {
    await dropDatabase();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
