// Development-only: set every active local-center account to the same password.
// Refuses any database that is not the loopback development center.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PasswordAdapter } from '../dist-server/adapters/password.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const ROOT = path.join(process.env.ProgramData || 'C:\\ProgramData', 'MiloginCenter');
const CONFIG = path.join(ROOT, 'postgres.json');
const DATABASE = 'milogin_center';
const PORT = 55846;
const APP_NAME = 'milogin_app';
const MARKER = 'milogin-center-postgres-v1';
const PASSWORD = process.env.PROSPECTOR_DEV_PASSWORD || '123456';

if (!/^[A-Za-z0-9]{6,128}$/.test(PASSWORD)) throw new Error('开发密码必须是 6-128 位字母或数字');
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if (config.marker !== MARKER || config.host !== '127.0.0.1' || config.port !== PORT
  || config.database !== DATABASE || config.app !== APP_NAME || !/^[a-f0-9]{64}$/.test(config.appPassword)) {
  throw new Error('只允许操作本机 127.0.0.1 的开发中心库');
}

const adapter = new PasswordAdapter(1);
await adapter.initialize();
const passwordHash = await adapter.hash(PASSWORD);
const pool = new Pool({ host: config.host, port: config.port, database: config.database,
  user: config.app, password: config.appPassword, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const users = await client.query(`SELECT user_id FROM public.identity_users
    WHERE active AND deleted_at IS NULL FOR UPDATE`);
  for (const row of users.rows) {
    await client.query(`INSERT INTO public.identity_credentials(user_id,password_hash,hash_scheme,changed_at)
      VALUES($1,$2,'scrypt-v1',now())
      ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,hash_scheme='scrypt-v1',changed_at=now()`,
    [row.user_id, passwordHash]);
    await client.query(`UPDATE public.identity_users SET must_change_password=false,
      security_revision=security_revision+1,management_revision=management_revision+1
      WHERE user_id=$1`, [row.user_id]);
    await client.query(`UPDATE public.identity_desktop_refresh_tokens r SET consumed_at=now()
      FROM public.identity_sessions s WHERE r.session_id=s.session_id AND s.user_id=$1 AND r.consumed_at IS NULL`, [row.user_id]);
    await client.query('UPDATE public.identity_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [row.user_id]);
  }
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({ ok: true, accounts: users.rowCount }) + '\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
