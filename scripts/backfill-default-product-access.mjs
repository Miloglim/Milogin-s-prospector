// Give active center users missing product records the default two-product access.
// Existing disabled or customized product records are never overwritten.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const APPLY = process.argv.includes("--apply");
const DSN = process.env.PROSPECTOR_CENTER_PG_DSN || "";

if (!/^postgres(ql)?:\/\//.test(DSN)) throw new Error("缺少正式中心 PostgreSQL DSN");

const pool = new Pool({ connectionString: DSN, max: 1, application_name: "milogin-product-backfill" });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock(hashtext('milogin-default-product-access-v1'))");
  const actor = await client.query(`SELECT u.user_id FROM identity.users u
    JOIN identity.credentials c USING(user_id)
    WHERE u.active AND u.identity_admin AND u.deleted_at IS NULL
    ORDER BY u.created_at LIMIT 1 FOR SHARE OF u`);
  if (!actor.rows.length) throw new Error("没有可用于记录审计的超级管理员");
  const users = await client.query(`SELECT u.user_id,e.email,u.identity_admin,
      EXISTS(SELECT 1 FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm') OR
      EXISTS(SELECT 1 FROM identity.product_access a WHERE a.user_id=u.user_id AND a.product_id='crm') AS crm_configured,
      EXISTS(SELECT 1 FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='navigator') OR
      EXISTS(SELECT 1 FROM identity.product_access a WHERE a.user_id=u.user_id AND a.product_id='navigator') AS navigator_configured,
      COALESCE((SELECT array_agg(g.role ORDER BY g.role) FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active),ARRAY[]::text[]) AS crm_roles
    FROM identity.users u JOIN identity.login_emails e USING(user_id)
    WHERE u.active AND u.deleted_at IS NULL ORDER BY e.email`);

  const changes = [];
  for (const user of users.rows) {
    const addCrm = !user.crm_configured;
    const addNavigator = !user.navigator_configured;
    if (!addCrm && !addNavigator) continue;
    const navigatorRole = user.identity_admin || user.crm_roles.includes("operations") ? "operations" : "sales";
    changes.push({ ...user, addCrm, addNavigator, navigatorRole });
    if (!APPLY) continue;
    if (addCrm) {
      await client.query("INSERT INTO identity.product_grants(user_id,product_id,role,active) VALUES($1,'crm','sales',true)", [user.user_id]);
      await client.query("INSERT INTO identity.product_access(user_id,product_id,active,scope) VALUES($1,'crm',true,'own')", [user.user_id]);
    }
    if (addNavigator) {
      await client.query("INSERT INTO identity.product_grants(user_id,product_id,role,active) VALUES($1,'navigator',$2,true)", [user.user_id, navigatorRole]);
      await client.query("INSERT INTO identity.product_access(user_id,product_id,active,scope) VALUES($1,'navigator',true,'own')", [user.user_id]);
    }
    await client.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,reason)
      VALUES($1,$2,'identity.default_products','新账号全产品默认开通回填')`, [actor.rows[0].user_id, user.user_id]);
    await client.query(`INSERT INTO identity.outbox(event_type,user_id,revision)
      SELECT 'identity.default_products',user_id,management_revision FROM identity.users WHERE user_id=$1`, [user.user_id]);
  }

  if (APPLY) await client.query("COMMIT"); else await client.query("ROLLBACK");
  process.stdout.write(JSON.stringify({ ok: true, apply: APPLY, changed: changes.length,
    users: changes.map(user => ({ email: user.email, crm: user.addCrm, navigator: user.addNavigator,
      navigatorRole: user.addNavigator ? user.navigatorRole : null })) }) + "\n");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* connection may already be closed */ }
  throw error;
} finally {
  client.release();
  await pool.end();
}
