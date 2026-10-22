// Reset one production account to a random test password and write it to a protected file.
// The password is never printed. Intended only for an explicitly authorized login rehearsal.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const { PasswordAdapter } = require("../dist-server/adapters/password.js");
const { ADMIN_LOCK } = require("../dist-server/adapters/postgres/admin-schema.js");

const EMAIL = String(process.env.MILOGIN_TEST_ACCOUNT_EMAIL || "").trim().toLowerCase();
const OUTPUT = path.resolve(String(process.env.MILOGIN_TEST_CREDENTIAL_FILE || ""));
const DSN = String(process.env.PROSPECTOR_CENTER_PG_DSN || "");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

if (!EMAIL.includes("@")) throw new Error("MILOGIN_TEST_ACCOUNT_EMAIL 无效");
if (!OUTPUT || OUTPUT === path.parse(OUTPUT).root) throw new Error("MILOGIN_TEST_CREDENTIAL_FILE 无效");
if (!/^postgres(ql)?:\/\//.test(DSN)) throw new Error("缺少正式中心 PostgreSQL DSN");
if (fs.existsSync(OUTPUT)) throw new Error("临时凭据文件已存在，拒绝覆盖");

const password = Array.from(randomBytes(16), byte => ALPHABET[byte % ALPHABET.length]).join("");
const passwords = new PasswordAdapter(1);
await passwords.initialize();
const passwordHash = await passwords.hash(password);
const pool = new Pool({ connectionString: DSN, max: 1, application_name: "milogin-account-test-reset" });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
  const target = await client.query(`SELECT u.user_id FROM identity.users u JOIN identity.login_emails e USING(user_id)
    WHERE e.email=$1 AND u.active AND u.deleted_at IS NULL FOR UPDATE OF u`, [EMAIL]);
  if (target.rowCount !== 1) throw new Error("目标账号不存在或未启用");
  const actor = await client.query(`SELECT u.user_id FROM identity.users u JOIN identity.credentials c USING(user_id)
    WHERE u.active AND u.identity_admin AND u.deleted_at IS NULL ORDER BY u.created_at LIMIT 1`);
  if (actor.rowCount !== 1) throw new Error("缺少用于审计的超级管理员");
  const userId = target.rows[0].user_id;
  await client.query(`UPDATE identity.credentials SET password_hash=$2,hash_scheme='scrypt-v1',changed_at=now() WHERE user_id=$1`, [userId, passwordHash]);
  await client.query(`UPDATE identity.users SET must_change_password=false,security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1`, [userId]);
  await client.query(`UPDATE identity.desktop_refresh_tokens r SET consumed_at=now() FROM identity.sessions s
    WHERE r.session_id=s.session_id AND s.user_id=$1 AND r.consumed_at IS NULL`, [userId]);
  await client.query("UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL", [userId]);
  await client.query("UPDATE identity.management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL", [userId]);
  await client.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,reason)
    VALUES($1,$2,'identity.password.test_reset','账号生产登录链路验收临时密码；结束后由本人改密')`, [actor.rows[0].user_id, userId]);
  await client.query("COMMIT");
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(OUTPUT), 0o700);
  fs.writeFileSync(OUTPUT, JSON.stringify({ marker: "milogin-account-test-credential-v1", email: EMAIL,
    password, createdAt: new Date().toISOString(), mustChangePassword: false }, null, 2),
    { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.chmodSync(OUTPUT, 0o600);
  process.stdout.write(JSON.stringify({ ok: true, email: EMAIL, userId, credentialPath: OUTPUT }) + "\n");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* transaction may already be closed */ }
  throw error;
} finally {
  client.release();
  await pool.end();
}
