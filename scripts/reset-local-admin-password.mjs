import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PasswordAdapter } from '../dist-server/adapters/password.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const ROOT = path.join(process.env.ProgramData || 'C:\\ProgramData', 'MiloginCenter');
const CONFIG = path.join(ROOT, 'postgres.json');
const EMAIL = 'admin@yqn.com';
const DATABASE = 'milogin_center';
const PORT = 55846;
const APP_NAME = 'milogin_app';
const MARKER = 'milogin-center-postgres-v1';
const expectedPassword = process.env.MILOGIN_RESET_ADMIN_PASSWORD || '';

if (!/^[A-Za-z0-9]{12,128}$/.test(expectedPassword)) {
  throw new Error('MILOGIN_RESET_ADMIN_PASSWORD must be 12-128 alphanumeric characters');
}
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if (config.marker !== MARKER || config.host !== '127.0.0.1' || config.port !== PORT
  || config.database !== DATABASE || config.app !== APP_NAME || !/^[a-f0-9]{64}$/.test(config.appPassword)) {
  throw new Error('Formal center database configuration is invalid');
}

const adapter = new PasswordAdapter(1);
await adapter.initialize();
const passwordHash = await adapter.hash(expectedPassword);
const pool = new Pool({ host: config.host, port: config.port, database: config.database,
  user: config.app, password: config.appPassword, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const identity = await client.query(`SELECT u.user_id FROM identity.users u
    JOIN identity.login_emails e USING(user_id)
    WHERE e.email=$1 AND u.active AND u.identity_admin AND u.deleted_at IS NULL FOR UPDATE`, [EMAIL]);
  if (identity.rowCount !== 1) throw new Error('Active formal center superadmin not found');
  const userId = identity.rows[0].user_id;
  await client.query(`UPDATE identity.credentials SET password_hash=$2,hash_scheme='scrypt-v1',changed_at=now()
    WHERE user_id=$1`, [userId, passwordHash]);
  await client.query(`UPDATE identity.users SET must_change_password=true,
    security_revision=security_revision+1,management_revision=management_revision+1
    WHERE user_id=$1`, [userId]);
  await client.query(`UPDATE identity.desktop_refresh_tokens r SET consumed_at=now()
    FROM identity.sessions s WHERE r.session_id=s.session_id AND s.user_id=$1 AND r.consumed_at IS NULL`, [userId]);
  await client.query(`UPDATE identity.sessions SET revoked_at=now()
    WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
  await client.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,reason)
    VALUES($1,$1,'identity.password.local_reset','本机维护恢复：随机临时密码，强制首次登录改密并撤销全部会话')`, [userId]);
  await client.query('COMMIT');
  process.stdout.write('{"ok":true,"email":"admin@yqn.com","must_change_password":true}\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
