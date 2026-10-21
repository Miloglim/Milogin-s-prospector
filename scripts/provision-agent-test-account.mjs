import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { PasswordAdapter } from '../dist-server/adapters/password.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const EMAIL = 'agent-test@yqn.com';
const DISPLAY_NAME = 'Agent Test';
const CONFIG = path.join(process.env.ProgramData || 'C:\\ProgramData', 'MiloginCenter', 'postgres.json');
const password = process.env.MILOGIN_AGENT_PASSWORD || '';
if (!/^[A-Za-z0-9]{12,128}$/.test(password)) throw new Error('MILOGIN_AGENT_PASSWORD must be 12-128 alphanumeric characters');
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if (config.marker !== 'milogin-center-postgres-v1' || config.host !== '127.0.0.1' || config.port !== 55846
  || config.database !== 'milogin_center' || config.app !== 'milogin_app') throw new Error('Formal center configuration mismatch');

const passwords = new PasswordAdapter(1);
await passwords.initialize();
const passwordHash = await passwords.hash(password);
const pool = new Pool({ host: config.host, port: config.port, database: config.database,
  user: config.app, password: config.appPassword, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const existing = await client.query(`SELECT u.user_id FROM identity.users u JOIN identity.login_emails e USING(user_id)
    WHERE e.email=$1 FOR UPDATE`, [EMAIL]);
  const userId = existing.rows[0]?.user_id || randomUUID();
  if (existing.rowCount) {
    await client.query(`UPDATE identity.users SET display_name=$2,active=true,identity_admin=false,must_change_password=false,
      security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1`, [userId, DISPLAY_NAME]);
    await client.query(`UPDATE identity.credentials SET password_hash=$2,hash_scheme='scrypt-v1',changed_at=now() WHERE user_id=$1`,
      [userId, passwordHash]);
  } else {
    await client.query(`INSERT INTO identity.users(user_id,display_name,active,identity_admin,must_change_password)
      VALUES($1,$2,true,false,false)`, [userId, DISPLAY_NAME]);
    await client.query(`INSERT INTO identity.login_emails(user_id,email,verified_at) VALUES($1,$2,now())`, [userId, EMAIL]);
    await client.query(`INSERT INTO identity.credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1')`, [userId, passwordHash]);
  }
  for (const [productId, role, scope] of [['crm','sales','own'],['navigator','sales','own']]) {
    await client.query(`INSERT INTO identity.product_grants(user_id,product_id,role,active) VALUES($1,$2,$3,true)
      ON CONFLICT(user_id,product_id,role) DO UPDATE SET active=true`, [userId, productId, role]);
    await client.query(`INSERT INTO identity.product_access(user_id,product_id,active,scope,capabilities) VALUES($1,$2,true,$3,NULL)
      ON CONFLICT(user_id,product_id) DO UPDATE SET active=true,scope=EXCLUDED.scope,capabilities=NULL`, [userId, productId, scope]);
  }
  await client.query(`UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [userId]);
  await client.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,reason)
    VALUES($1,$1,'identity.agent_test.provisioned','AI 端到端测试账号；CRM/Navigator 销售权限')`, [userId]);
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({ ok:true, email:EMAIL, userId, crmRole:'sales', navigatorRole:'sales' })+'\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
