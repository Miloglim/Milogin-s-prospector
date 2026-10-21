// One-time production identity bootstrap. The password is read from the
// environment or hidden stdin, unless --generate-password explicitly writes a
// one-time credential file protected by Windows ACLs. It is never logged.
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const { readProductionDatabaseConfig } = require("../dist-server/adapters/postgres/config.js");
const { PostgresAuthRepository } = require("../dist-server/adapters/postgres/auth-repository.js");
const { PasswordAdapter } = require("../dist-server/adapters/password.js");
const { AUTH_LIMITS, isAccountEmail, isNewAccountPassword } = require("../dist-server/core/auth.js");
const { capabilitiesFor } = require("../dist-server/core/admin.js");
const { ADMIN_LOCK } = require("../dist-server/adapters/postgres/admin-schema.js");

const ROLES = ["admin", "operations", "sales", "auditor"];
const GENERATE_PASSWORD = process.argv.includes("--generate-password");
const credentialsIndex = process.argv.indexOf("--credentials-file");
const CREDENTIALS_FILE = credentialsIndex >= 0 && process.argv[credentialsIndex + 1]
  ? path.resolve(process.argv[credentialsIndex + 1])
  : path.join(process.env.ProgramData || "C:\\ProgramData", "MiloginCenter", "bootstrap-admin.json");
const log = {
  write(level, context, message) {
    process.stdout.write(`[${new Date().toISOString()}] [${level}] [${context}] ${message}\n`);
  },
};

async function readPassword() {
  if (GENERATE_PASSWORD) return { password: randomBytes(24).toString("hex"), generated: true };
  const supplied = process.env.PROSPECTOR_ADMIN_INITIAL_PASSWORD;
  if (supplied) {
    delete process.env.PROSPECTOR_ADMIN_INITIAL_PASSWORD;
    return { password: supplied, generated: false };
  }
  if (!process.stdin.isTTY) throw new Error("缺少正式管理员初始密码");
  process.stdin.setRawMode(true);
  const reader = createInterface({ input: process.stdin, terminal: false });
  try {
    return { password: await new Promise((resolve, reject) => {
      let received = false;
      reader.once("line", line => { received = true; resolve(line); reader.close(); });
      reader.once("close", () => { if (!received) reject(new Error("缺少正式管理员初始密码")); });
    }), generated: false };
  } finally {
    process.stdin.setRawMode(false);
  }
}

function writeCredentials(email, password) {
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({ marker: "milogin-bootstrap-admin-v1", email, password,
    mustChangePassword: false, createdAt: new Date().toISOString() }, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  if (process.platform === "win32") {
    execFileSync("icacls.exe", [CREDENTIALS_FILE, "/inheritance:r", "/grant:r",
      `${os.userInfo().username}:F`, "SYSTEM:F"], { windowsHide: true, stdio: "ignore" });
  }
}

async function ensureAllProductAccess(client, userId) {
  for (const role of ROLES) {
    await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2) ON CONFLICT DO NOTHING", [userId, role]);
  }
  for (const role of ["operations", "sales"]) {
    await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'navigator',$2) ON CONFLICT DO NOTHING", [userId, role]);
  }
  await client.query(`INSERT INTO identity.product_access(user_id,product_id,active,scope,capabilities)
    VALUES($1,'crm',true,'summary',$2)
    ON CONFLICT(user_id,product_id) DO UPDATE SET active=true,scope='summary',capabilities=EXCLUDED.capabilities`,
    [userId, JSON.stringify(capabilitiesFor(ROLES))]);
  await client.query(`INSERT INTO identity.product_access(user_id,product_id,active,scope,capabilities)
    VALUES($1,'navigator',true,'summary',NULL)
    ON CONFLICT(user_id,product_id) DO UPDATE SET active=true,scope='summary'`, [userId]);
}

async function main() {
  if (process.env.PROSPECTOR_CENTER_MODE !== "production") throw new Error("必须设置 PROSPECTOR_CENTER_MODE=production");
  const email = String(process.env.PROSPECTOR_ADMIN_EMAIL || "").trim().toLowerCase();
  if (!isAccountEmail(email)) throw new Error("PROSPECTOR_ADMIN_EMAIL 不是有效邮箱");
  const passwordInput = await readPassword();
  let password = passwordInput.password;
  if (!isNewAccountPassword(password)) {
    throw new Error(`初始密码必须为 ${AUTH_LIMITS.passwordMin}-${AUTH_LIMITS.passwordMax} 位 ASCII 字母或数字`);
  }
  const passwordHash = await (async () => {
    const adapter = new PasswordAdapter(1);
    await adapter.initialize();
    return adapter.hash(password);
  })();
  const pool = new Pool(readProductionDatabaseConfig());
  try {
    const repo = new PostgresAuthRepository(pool, log);
    if (!(await repo.migrate()).ok) throw new Error("正式中心数据库迁移未通过");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK]);
      const existing = await client.query(`SELECT u.user_id, e.email
        FROM identity.users u JOIN identity.login_emails e USING(user_id)
        WHERE u.identity_admin AND u.active AND u.deleted_at IS NULL FOR UPDATE OF u`);
      const same = existing.rows.find(row => String(row.email).toLowerCase() === email);
      if (existing.rows.length && !same) throw new Error("正式中心已有超级管理员，拒绝创建第二个");
      if (same) {
        await ensureAllProductAccess(client, same.user_id);
        await client.query("COMMIT");
        log.write("INFO", "identity.bootstrap", "正式超级管理员已存在；已补齐 CRM 与 Navigator 全产品权限，未修改密码");
        return;
      }
      if (passwordInput.generated && fs.existsSync(CREDENTIALS_FILE)) {
        throw new Error("一次性管理员凭据文件已存在，拒绝覆盖");
      }
      const userId = randomUUID();
      await client.query(`INSERT INTO identity.users(user_id,display_name,identity_admin,must_change_password)
        VALUES($1,'Milogin 管理员',true,false)`, [userId]);
      await client.query("INSERT INTO identity.login_emails(user_id,email) VALUES($1,$2)", [userId, email]);
      await client.query(`INSERT INTO identity.credentials(user_id,password_hash,hash_scheme)
        VALUES($1,$2,'scrypt-v1')`, [userId, passwordHash]);
      await ensureAllProductAccess(client, userId);
      await client.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,reason)
        VALUES($1,$1,'identity.bootstrap','正式部署默认产品超级管理员初始化，拥有 CRM 与 Navigator 权限')`, [userId]);
      await client.query("COMMIT");
      if (passwordInput.generated) writeCredentials(email, password);
      log.write("INFO", "identity.bootstrap", `正式产品超级管理员已创建 ${email}；可直接登录全部产品${passwordInput.generated ? "；一次性凭据已写入受保护文件" : ""}`);
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { log.write("ERROR", "identity.bootstrap.rollback", "回滚失败"); }
      throw error;
    } finally { client.release(); }
  } finally {
    password = undefined;
    delete process.env.PROSPECTOR_ADMIN_INITIAL_PASSWORD;
    await pool.end();
  }
}

void main().catch(() => {
  log.write("ERROR", "identity.bootstrap", "正式管理员初始化未完成；检查生产 DSN、邮箱与身份冲突，不要粘贴密码");
  process.exitCode = 1;
});
