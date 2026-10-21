// Provision Navigator and Prospector application databases using an existing
// PostgreSQL administrator. The administrator DSN is accepted only from env.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const ROOT = path.join(process.env.ProgramData || "C:\\ProgramData", "MiloginCenter");
const CONFIG = path.join(ROOT, "postgres.json");
const MARKER = "milogin-company-postgres-v1";
const CONFIG_VERSION = 3;
const CENTER_DATABASE = "milogin_center";
const CENTER_APP = "milogin_app";
const NAVIGATOR_DATABASE = "navigator_rates";
const NAVIGATOR_APP = "navigator_app";
const PASSWORD_BYTES = 32;
const adminDsn = (process.env.MILOGIN_DATABASE_ADMIN_DSN || "").trim();

function log(level, message) {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] [company.db] ${message}\n`);
}

function validConfig(value, host, port) {
  return value && ['milogin-center-postgres-v1', MARKER].includes(value.marker)
    && value.host === host && value.port === port
    && value.database === CENTER_DATABASE && value.app === CENTER_APP
    && /^[a-f0-9]{64}$/.test(value.appPassword)
    && (!value.navigatorPassword || /^[a-f0-9]{64}$/.test(value.navigatorPassword));
}

function writeConfig(value) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  if (process.platform === "win32") {
    execFileSync("icacls.exe", [CONFIG, "/inheritance:r", "/grant:r",
      `${os.userInfo().username}:F`, "SYSTEM:F"], { windowsHide: true, stdio: "ignore" });
  }
}

async function roleExists(client, role) {
  return (await client.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [role])).rowCount > 0;
}
async function databaseExists(client, database) {
  return (await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [database])).rowCount > 0;
}
async function ensureRole(client, role, password) {
  if (await roleExists(client, role)) {
    await client.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  } else {
    await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
  }
}
async function ensureDatabase(client, database, owner) {
  if (!(await databaseExists(client, database))) await client.query(`CREATE DATABASE ${database} OWNER ${owner}`);
}
async function verifyApp(host, port, database, user, password) {
  const client = new Client({ host, port, database, user, password, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    const result = await client.query("SELECT current_database() AS db, current_user AS role");
    if (result.rows[0].db !== database || result.rows[0].role !== user) throw new Error("应用数据库身份不匹配");
  } finally { await client.end(); }
}

async function main() {
  if (!adminDsn) throw new Error("缺少 MILOGIN_DATABASE_ADMIN_DSN；必须使用现有数据库管理员凭据");
  let url;
  try { url = new URL(adminDsn); }
  catch { throw new Error("MILOGIN_DATABASE_ADMIN_DSN 无效"); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== "127.0.0.1"
    || !url.username || !url.password) throw new Error("数据库管理员连接必须是本机 PostgreSQL 账号");
  const host = "127.0.0.1";
  const port = Number(url.port || 5432);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("数据库管理员连接端口无效");
  const existing = fs.existsSync(CONFIG) ? JSON.parse(fs.readFileSync(CONFIG, "utf8")) : null;
  const config = validConfig(existing, host, port) ? {
    ...existing, marker: MARKER, configVersion: CONFIG_VERSION,
    navigatorDatabase: NAVIGATOR_DATABASE, navigatorApp: NAVIGATOR_APP,
    navigatorPassword: existing.navigatorPassword || randomBytes(PASSWORD_BYTES).toString("hex"),
    provisionedAt: existing.provisionedAt || new Date().toISOString(),
  } : {
    marker: MARKER, configVersion: CONFIG_VERSION, host, port,
    database: CENTER_DATABASE, app: CENTER_APP, appPassword: randomBytes(PASSWORD_BYTES).toString("hex"),
    navigatorDatabase: NAVIGATOR_DATABASE, navigatorApp: NAVIGATOR_APP,
    navigatorPassword: randomBytes(PASSWORD_BYTES).toString("hex"), provisionedAt: new Date().toISOString(),
  };
  const admin = new Client({ connectionString: adminDsn, connectionTimeoutMillis: 5000 });
  try {
    await admin.connect();
    await ensureRole(admin, CENTER_APP, config.appPassword);
    await ensureRole(admin, NAVIGATOR_APP, config.navigatorPassword);
    await ensureDatabase(admin, CENTER_DATABASE, CENTER_APP);
    await ensureDatabase(admin, NAVIGATOR_DATABASE, NAVIGATOR_APP);
  } finally { await admin.end(); }
  await verifyApp(host, port, CENTER_DATABASE, CENTER_APP, config.appPassword);
  await verifyApp(host, port, NAVIGATOR_DATABASE, NAVIGATOR_APP, config.navigatorPassword);
  writeConfig(config);
  log("INFO", `应用数据库已就绪 ${host}:${port}；应用账号与凭据已写入受保护配置`);
}

void main().catch(error => {
  log("ERROR", error instanceof Error ? error.message : "应用数据库初始化失败");
  process.exitCode = 1;
});
