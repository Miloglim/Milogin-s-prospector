import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const SOURCE_ENV = "C:\\ProgramData\\FreightRate\\freight-postgres.env";
const TARGET_CONFIG = "C:\\ProgramData\\MiloginCenter\\postgres.json";
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ROLE_MAP = { sales: "sales", operator: "operations" };

function log(level, message) {
  process.stdout.write(`[${new Date().toISOString()}] [identity.navigator-migrate] [${level}] ${message}\n`);
}

function readDsn() {
  const line = fs.readFileSync(SOURCE_ENV, "utf8").split(/\r?\n/).find(value => value.startsWith("FREIGHT_POSTGRES_DSN="));
  if (!line) throw new Error("缺少 Navigator PostgreSQL 配置");
  return line.slice("FREIGHT_POSTGRES_DSN=".length).trim();
}

function readTarget() {
  const value = JSON.parse(fs.readFileSync(TARGET_CONFIG, "utf8"));
  if (value.marker !== "milogin-center-postgres-v1" || value.host !== "127.0.0.1"
    || value.port !== 55846 || value.database !== "milogin_center" || value.app !== "milogin_app"
    || typeof value.appPassword !== "string" || !value.appPassword) {
    throw new Error("正式中心配置不匹配");
  }
  return value;
}

async function sourceAccounts() {
  const source = new Client({ connectionString: readDsn(), options: "-c default_transaction_read_only=on" });
  await source.connect();
  try {
    const result = await source.query(`SELECT user_id::text AS legacy_user_id,name,display_name,role,active,
      password_hash FROM operators ORDER BY user_id`);
    const accounts = result.rows.filter(row => EMAIL_PATTERN.test(String(row.name || "").trim()));
    if (accounts.some(row => !row.active || !row.password_hash || !ROLE_MAP[String(row.role || "").trim().toLowerCase()])) {
      throw new Error("邮箱账号存在停用、缺少密码摘要或未知业务角色，拒绝迁移");
    }
    return accounts.map(row => ({
      legacyUserId: row.legacy_user_id,
      email: String(row.name).trim().toLowerCase(),
      displayName: String(row.display_name || "").trim() || String(row.name).trim().toLowerCase(),
      displayNameDefaulted: !String(row.display_name || "").trim(),
      role: ROLE_MAP[String(row.role).trim().toLowerCase()],
      passwordHash: row.password_hash,
    }));
  } finally {
    await source.end();
  }
}

async function main() {
  const targetConfig = readTarget();
  const accounts = await sourceAccounts();
  if (accounts.length !== 5) throw new Error(`邮箱账号数量变化，预期5个，实际${accounts.length}个`);
  const target = new Client({ host: targetConfig.host, port: targetConfig.port, database: targetConfig.database, user: targetConfig.app, password: targetConfig.appPassword });
  await target.connect();
  try {
    const identity = await target.query("SELECT user_id FROM identity.users WHERE identity_admin AND active AND deleted_at IS NULL ORDER BY created_at LIMIT 1");
    if (identity.rowCount !== 1) throw new Error("中心超级管理员不存在或不唯一");
    const existing = await target.query("SELECT email FROM identity.login_emails WHERE email = ANY($1::text[])", [accounts.map(account => account.email)]);
    if (existing.rowCount) throw new Error("目标中心已有待迁移邮箱，拒绝覆盖");
    await target.query("BEGIN");
    const migrated = [];
    for (const account of accounts) {
      const userId = randomUUID();
      await target.query(`INSERT INTO identity.users(user_id,display_name,active,identity_admin,must_change_password)
        VALUES($1,$2,true,false,false)`, [userId, account.displayName]);
      await target.query("INSERT INTO identity.user_profiles(user_id) VALUES($1)", [userId]);
      await target.query("INSERT INTO identity.login_aliases(alias,user_id) VALUES($1,$2)", [account.email, userId]);
      await target.query("INSERT INTO identity.login_emails(user_id,email,verified_at) VALUES($1,$2,NULL)", [userId, account.email]);
      await target.query("INSERT INTO identity.credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'pbkdf2_sha256')", [userId, account.passwordHash]);
      await target.query("INSERT INTO identity.product_grants(user_id,product_id,role,active) VALUES($1,'navigator',$2,true)", [userId, account.role]);
      await target.query("INSERT INTO identity.product_access(user_id,product_id,active,scope) VALUES($1,'navigator',true,$2)", [userId, account.role === "operations" ? "shared" : "own"]);
      await target.query(`INSERT INTO identity.legacy_account_mappings
        (source_product,legacy_user_id,legacy_login_alias,center_user_id,status,requires_password_reset,reason)
        VALUES('navigator',$1,$2,$3,'migrated',false,$4)`, [account.legacyUserId, account.email, userId, "邮箱账号已导入中心；首次成功登录后重算为 scrypt-v1"]);
      await target.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,product_id,reason)
        VALUES($1,$2,'identity.navigator.migrated','navigator',$3)`, [identity.rows[0].user_id, userId, "Navigator 邮箱账号迁移到中心身份库"]);
      migrated.push({ email: account.email, role: account.role, displayNameDefaulted: account.displayNameDefaulted });
    }
    await target.query("COMMIT");
    const verify = await target.query(`SELECT count(*)::int AS users,
      count(*) FILTER (WHERE status='migrated')::int AS mappings
      FROM identity.legacy_account_mappings WHERE source_product='navigator'`);
    if (verify.rows[0].mappings !== accounts.length) throw new Error("迁移后映射数量校验失败");
    log("INFO", `正式中心迁移完成 accounts=${migrated.length} display_name_defaulted=${migrated.filter(item => item.displayNameDefaulted).length}`);
  } catch (error) {
    await target.query("ROLLBACK");
    throw error;
  } finally {
    await target.end();
  }
}

try {
  await main();
} catch (error) {
  log("ERROR", error instanceof Error ? error.message : "迁移失败");
  process.exitCode = 1;
}
