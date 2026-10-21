import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROLE_CAPABILITIES } from '../dist-server/core/admin.js';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const CONFIG = path.join(process.env.ProgramData || 'C:\\ProgramData', 'MiloginCenter', 'postgres.json');
const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if (config.marker !== 'milogin-center-postgres-v1' || config.host !== '127.0.0.1' || config.port !== 55846
  || config.database !== 'milogin_center' || config.app !== 'milogin_app') throw new Error('Formal center configuration mismatch');
const crmCapabilities = [...new Set(Object.values(ROLE_CAPABILITIES).flat())].sort();
const pool = new Pool({ host: config.host, port: config.port, database: config.database,
  user: config.app, password: config.appPassword, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const admins = await client.query(`SELECT u.user_id,e.email FROM identity.users u
    JOIN identity.login_emails e USING(user_id)
    WHERE u.active AND u.identity_admin AND u.deleted_at IS NULL ORDER BY e.email FOR UPDATE`);
  for (const { user_id: userId, email } of admins.rows) {
    for (const [productId, role] of [['crm','admin'],['navigator','admin']]) {
      await client.query(`INSERT INTO identity.product_grants(user_id,product_id,role,active) VALUES($1,$2,$3,true)
        ON CONFLICT(user_id,product_id,role) DO UPDATE SET active=true`, [userId, productId, role]);
    }
    await client.query(`INSERT INTO identity.product_access(user_id,product_id,active,scope,capabilities)
      VALUES($1,'crm',true,'summary',$2) ON CONFLICT(user_id,product_id)
      DO UPDATE SET active=true,scope='summary',capabilities=EXCLUDED.capabilities`, [userId, JSON.stringify(crmCapabilities)]);
    await client.query(`INSERT INTO identity.product_access(user_id,product_id,active,scope,capabilities)
      VALUES($1,'navigator',true,'summary',NULL) ON CONFLICT(user_id,product_id)
      DO UPDATE SET active=true,scope='summary',capabilities=NULL`, [userId]);
    await client.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,product_id,reason)
      VALUES($1,$1,'identity.superadmin.product_grant','crm','中心超级管理员补齐 Prospector/Navigator 产品管理员权限')`, [userId]);
  }
  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({ ok:true, admins:admins.rows.map(row => row.email) })+'\n');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
