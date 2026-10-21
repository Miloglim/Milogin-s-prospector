import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const bundlePath = process.argv[2];
const email = String(process.argv[3] || "").trim().toLowerCase();
const navigatorUserId = String(process.argv[4] || "").trim();
const dsn = process.env.PROSPECTOR_CENTER_PG_DSN;
if (!bundlePath || !email || !dsn) throw new Error("usage: apply-account-profile-bundle.mjs <bundle> <email> <navigatorUserId>");
const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
if (!Array.isArray(bundle.events) || !bundle.projection || !bundle.displayName || !bundle.avatarId) throw new Error("bundle invalid");

const client = new Client({ connectionString: dsn });
await client.connect();
try {
  await client.query("BEGIN");
  const target = await client.query(`SELECT u.user_id::text FROM identity.users u JOIN identity.login_emails e USING(user_id)
    WHERE e.email=$1 AND u.active AND u.deleted_at IS NULL`,[email]);
  if (target.rowCount !== 1) throw new Error("target center user is not unique");
  const userId = target.rows[0].user_id;
  await client.query("UPDATE identity.users SET display_name=$2,management_revision=management_revision+1 WHERE user_id=$1",[userId,bundle.displayName]);
  await client.query(`INSERT INTO identity.user_profiles(user_id,avatar_id,bio) VALUES($1,$2,$3)
    ON CONFLICT(user_id) DO UPDATE SET avatar_id=EXCLUDED.avatar_id,bio=EXCLUDED.bio,updated_at=now()`,[userId,bundle.avatarId,bundle.bio || ""]);
  if (navigatorUserId) {
    await client.query(`INSERT INTO identity.legacy_account_mappings
      (source_product,legacy_user_id,legacy_login_alias,center_user_id,status,requires_password_reset,reason)
      VALUES('navigator',$1,$2,$3,'migrated',false,'云端共享账号资料迁移') ON CONFLICT(source_product,legacy_user_id)
      DO UPDATE SET legacy_login_alias=EXCLUDED.legacy_login_alias,center_user_id=EXCLUDED.center_user_id,status='migrated',updated_at=now()`,
    [navigatorUserId,email,userId]);
  }
  if (bundle.events.length) {
    const events = bundle.events.map(event => ({ event_id: event.eventId, user_id: userId, source_product: event.sourceProduct, event_type: event.eventType, subject_key: event.subjectKey, points: event.points, rule_version: event.ruleVersion, occurred_at: event.occurredAt }));
    await client.query(`INSERT INTO identity.account_experience_events
      (event_id,user_id,source_product,event_type,subject_key,points,rule_version,occurred_at)
      SELECT event_id,user_id,source_product,event_type,subject_key,points,rule_version,occurred_at
      FROM jsonb_to_recordset($1::jsonb) AS x(event_id uuid,user_id uuid,source_product text,event_type text,subject_key text,points integer,rule_version integer,occurred_at timestamptz)
      ON CONFLICT DO NOTHING`, [JSON.stringify(events)]);
  }
  await client.query(`INSERT INTO identity.account_growth_projection(user_id,total_xp,cycle,level,today_xp,today_key)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET total_xp=EXCLUDED.total_xp,cycle=EXCLUDED.cycle,
    level=EXCLUDED.level,today_xp=EXCLUDED.today_xp,today_key=EXCLUDED.today_key,updated_at=now()`,
  [userId,bundle.projection.totalXp,bundle.projection.cycle,bundle.projection.level,bundle.projection.todayXp,bundle.projection.todayKey]);
  await client.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,product_id,reason)
    VALUES($1,$1,'identity.navigator.profile.migrated','navigator',$2)`,[userId,`云端账号资料迁移；events=${bundle.events.length};total_xp=${bundle.projection.totalXp}`]);
  const verify = await client.query(`SELECT u.display_name,p.avatar_id,g.total_xp,g.cycle,g.level,
    (SELECT count(*)::int FROM identity.account_experience_events e WHERE e.user_id=u.user_id AND e.source_product='navigator') AS events
    FROM identity.users u JOIN identity.user_profiles p USING(user_id) JOIN identity.account_growth_projection g USING(user_id) WHERE u.user_id=$1`,[userId]);
  const row = verify.rows[0];
  if (!row || row.display_name !== bundle.displayName || row.avatar_id !== bundle.avatarId || Number(row.total_xp) !== bundle.projection.totalXp || Number(row.events) !== bundle.events.length) throw new Error("bundle verification failed");
  await client.query("COMMIT");
  process.stdout.write(JSON.stringify({ ok: true, userId, displayName: row.display_name, avatarId: row.avatar_id, totalXp: row.total_xp, cycle: row.cycle, level: row.level, events: row.events }) + "\n");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  throw error;
} finally {
  await client.end();
}
