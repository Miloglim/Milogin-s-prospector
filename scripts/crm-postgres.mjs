import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME_ROOT = path.join(ROOT, ".work", "pg-crm");
const CLUSTER = path.join(RUNTIME_ROOT, "cluster");
const CONFIG_FILE = path.join(RUNTIME_ROOT, "config.json");
const MARKER_FILE = path.join(RUNTIME_ROOT, "marker.json");
const SETTINGS = JSON.parse(fs.readFileSync(path.join(ROOT, "server/core/postgres-test-settings.json"), "utf8"));
const MARKER = SETTINGS.marker;
const TEST_NAME = SETTINGS.database;
const HOST = SETTINGS.host;
const PORT = SETTINGS.port;
const CONNECTION_TIMEOUT_SECONDS = SETTINGS.connection_timeout_seconds;
const START_TIMEOUT_SECONDS = 20;
const PROCESS_TIMEOUT_MS = 30000;
const TEST_PROCESS_TIMEOUT_MS = 120000;
const MILLISECONDS_PER_SECOND = 1000;
const PASSWORD_BYTES = 32;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PG_NOT_RUNNING_STATUS = 3;
const JSON_INDENT = 2;
const EXIT_FAILED = 1;
const BIN = process.env.PROSPECTOR_PG_BIN ?? "C:\\Program Files\\PostgreSQL\\18\\bin";
const exe = name => path.join(BIN, process.platform === "win32" ? `${name}.exe` : name);
function log(level, message) { process.stdout.write(`[${new Date().toISOString()}] [${level}] [crm.pg.runtime] ${message}\n`); }
function markerMatches() {
  if (!fs.existsSync(MARKER_FILE)) return false;
  const value = JSON.parse(fs.readFileSync(MARKER_FILE, "utf8"));
  return value.marker === MARKER && value.cluster === CLUSTER;
}
function readConfig() {
  if (!markerMatches()) throw new Error("隔离目录标记不匹配，拒绝操作");
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  if (config.marker !== MARKER || config.host !== HOST || config.port !== PORT
    || config.database !== TEST_NAME || config.user !== TEST_NAME || typeof config.password !== "string" || !config.password) {
    throw new Error("测试连接配置无效，拒绝操作");
  }
  return config;
}
function run(name, args) {
  // Windows PostgreSQL children can retain inherited pipe handles after pg_ctl exits.
  // Ignore stdio (server output goes to its explicit -l file), so startup never waits for an immortal pipe EOF.
  return execFileSync(exe(name), args, { encoding: "utf8", timeout: PROCESS_TIMEOUT_MS, windowsHide: true, stdio: "ignore" });
}
function active() {
  try { run("pg_ctl", ["status", "-D", CLUSTER]); return true; }
  catch (error) {
    if (error.status === PG_NOT_RUNNING_STATUS) return false; // pg_ctl documented stopped-cluster status
    throw error;
  }
}
async function portAvailable() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(PORT, HOST, () => server.close(error => error ? reject(error) : resolve()));
  });
}
function protectDirectory() {
  if (process.platform === "win32") {
    execFileSync("icacls.exe", [RUNTIME_ROOT, "/inheritance:r", "/grant:r", `${os.userInfo().username}:(OI)(CI)F`],
      { stdio: "pipe", windowsHide: true, timeout: PROCESS_TIMEOUT_MS });
  } else { fs.chmodSync(RUNTIME_ROOT, PRIVATE_DIRECTORY_MODE); }
}
function prepare() {
  if (fs.existsSync(RUNTIME_ROOT)) {
    if (!markerMatches()) throw new Error("现有目录不属于本节点，拒绝初始化");
    readConfig();
    if (!fs.existsSync(path.join(CLUSTER, "PG_VERSION"))) throw new Error("检测到中断初始化，保留目录供核对");
    return;
  }
  if (!fs.existsSync(exe("initdb")) || !fs.existsSync(exe("pg_ctl"))) throw new Error("找不到 PostgreSQL 工具，请配置 PROSPECTOR_PG_BIN");
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  protectDirectory();
  fs.writeFileSync(MARKER_FILE, JSON.stringify({ marker: MARKER, cluster: CLUSTER }), { mode: PRIVATE_FILE_MODE });
  const password = randomBytes(PASSWORD_BYTES).toString("hex");
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ marker: MARKER, host: HOST, port: PORT, database: TEST_NAME,
    user: TEST_NAME, password, connection_timeout_seconds: CONNECTION_TIMEOUT_SECONDS }, null, JSON_INDENT), { mode: PRIVATE_FILE_MODE });
  const passwordFile = path.join(RUNTIME_ROOT, "init-password.txt");
  fs.writeFileSync(passwordFile, password, { mode: PRIVATE_FILE_MODE });
  try {
    run("initdb", ["-D", CLUSTER, "-U", TEST_NAME, "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", `--pwfile=${passwordFile}`]);
    fs.appendFileSync(path.join(CLUSTER, "postgresql.conf"), `\nlisten_addresses = '${HOST}'\nport = ${PORT}\n`);
  } finally {
    // Only this exact temporary password file is removed, never the cluster/data directory.
    if (fs.existsSync(passwordFile)) fs.unlinkSync(passwordFile);
  }
  log("INFO", "独立测试集群已初始化；凭据仅在本机受控目录");
}
async function verifyAndCreateDatabase(create) {
  const config = readConfig();
  const client = new pg.Client({ ...config, database: "postgres", connectionTimeoutMillis: CONNECTION_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND });
  try {
    await client.connect();
    const result = await client.query("SELECT current_setting('data_directory') AS dir, current_setting('port')::int AS port");
    const actual = path.resolve(result.rows[0].dir);
    if (actual.toLowerCase() !== CLUSTER.toLowerCase() || result.rows[0].port !== PORT) throw new Error("连接不是本节点集群，拒绝操作");
    const db = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", [TEST_NAME]);
    if (!db.rowCount && create) await client.query(`CREATE DATABASE ${TEST_NAME}`);
    if (!db.rowCount && !create) throw new Error("测试数据库尚未建立");
  } finally { await client.end(); }
}
const command = process.argv[2];
try {
  if (command === "test") {
    execFileSync(process.execPath, [path.join(ROOT, "scripts/center-tests.mjs"), "tests/integration/crm-postgres.test.ts"], {
      cwd: ROOT, env: { ...process.env, PROSPECTOR_PG_INTEGRATION: "1" },
      timeout: TEST_PROCESS_TIMEOUT_MS, windowsHide: true, stdio: "inherit",
    });
  } else if (command === "start") {
    prepare();
    if (!active()) {
      await portAvailable();
      run("pg_ctl", ["start", "-D", CLUSTER, "-l", path.join(RUNTIME_ROOT, "postgres.log"), "-w", "-t", String(START_TIMEOUT_SECONDS)]);
    }
    await verifyAndCreateDatabase(true);
    log("INFO", `测试数据库就绪 ${HOST}:${PORT}/${TEST_NAME}`);
  } else if (command === "status") {
    readConfig();
    if (!active()) throw new Error("测试集群已停止");
    await verifyAndCreateDatabase(false);
    log("INFO", "测试集群与数据库健康；已核对数据目录和端口");
  } else if (command === "stop") {
    readConfig();
    if (active()) {
      await verifyAndCreateDatabase(false);
      run("pg_ctl", ["stop", "-D", CLUSTER, "-m", "fast", "-w", "-t", String(START_TIMEOUT_SECONDS)]);
    }
    log("INFO", "测试集群已停止，数据保留；现有运价服务未操作");
  } else {
    throw new Error("用法：node scripts/crm-postgres.mjs start|status|stop|test");
  }
} catch (error) {
  // No subprocess stderr or connection object: they may contain secrets or query data.
  const safe = error instanceof Error && !('stdout' in error) && !('stderr' in error)
    && !('code' in error) ? error.message : "测试集群操作失败；请检查本机工具、独立端口和受控日志";
  log("ERROR", safe);
  process.exitCode = EXIT_FAILED;
}
