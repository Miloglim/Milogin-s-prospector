import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = process.env.PROGRAMDATA
  ? path.join(process.env.PROGRAMDATA, "MiloginCenter")
  : path.join(ROOT, ".work", "production-center");
const STATE = path.join(RUNTIME, "online-process.json");
const LOG = path.join(RUNTIME, "online.log");
const DEPLOYMENT = path.join(RUNTIME, "deployment.json");
const POSTGRES_CONFIG = path.join(RUNTIME, "postgres.json");
const INSTANCE_MARKER = "prospector-production-instance-v1";
const API_ORIGIN = "http://127.0.0.1:55847";
const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const EXIT_FAILED = 1;

function log(level, message) {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] [production.lifecycle] ${message}\n`);
}

function loadRuntimeEnvironment() {
  if (!process.env.PROSPECTOR_CENTER_MODE && fs.existsSync(DEPLOYMENT)) process.env.PROSPECTOR_CENTER_MODE = "production";
  if (!process.env.PROSPECTOR_CENTER_PUBLIC_ORIGIN && fs.existsSync(DEPLOYMENT)) {
    const value = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
    process.env.PROSPECTOR_CENTER_PUBLIC_ORIGIN = value.centerPublicOrigin;
    process.env.PROSPECTOR_NAVIGATOR_URL = value.navigatorInternalUrl;
    process.env.PROSPECTOR_NAVIGATOR_ENTRY_URL = value.navigatorPublicOrigin;
    if (value.localHttp === true) process.env.PROSPECTOR_CENTER_LOCAL_HTTP = "1";
  }
  if (!process.env.PROSPECTOR_CENTER_PG_DSN && fs.existsSync(POSTGRES_CONFIG)) {
    const value = JSON.parse(fs.readFileSync(POSTGRES_CONFIG, "utf8"));
    if (!value.app || !value.appPassword || !value.database || !value.host || !value.port) throw new Error("中心数据库运行配置无效");
    process.env.PROSPECTOR_CENTER_PG_DSN = `postgresql://${encodeURIComponent(value.app)}:${encodeURIComponent(value.appPassword)}@${value.host}:${value.port}/${value.database}`;
  }
}

function requireProductionEnvironment() {
  if (process.env.PROSPECTOR_CENTER_MODE !== "production") {
    throw new Error("必须设置 PROSPECTOR_CENTER_MODE=production");
  }
  if (!process.env.PROSPECTOR_CENTER_PG_DSN || !process.env.PROSPECTOR_CENTER_PUBLIC_ORIGIN) {
    throw new Error("缺少正式中心数据库或 HTTPS 对外地址配置");
  }
}

function readState() {
  if (!fs.existsSync(STATE)) return null;
  const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
  if (state.marker !== INSTANCE_MARKER || !Number.isSafeInteger(state.pid)
    || state.pid < 1 || !/^[a-f0-9]{64}$/.test(state.instanceId)) {
    throw new Error("生产进程记录无效，拒绝操作");
  }
  return state;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "ESRCH") return false; throw error; }
}

async function health(route = "/health/live") {
  try {
    const response = await fetch(`${API_ORIGIN}${route}`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}

async function owns(state) {
  const live = await health();
  return live?.ok === true && live.data?.instanceId === state.instanceId && live.data?.pid === state.pid;
}

const delay = () => new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
const command = process.argv[2];

try {
  loadRuntimeEnvironment();
  requireProductionEnvironment();
  fs.mkdirSync(RUNTIME, { recursive: true });
  const state = readState();

  if (command === "status") {
    if (!state || !alive(state.pid) || !(await owns(state))) throw new Error("生产中心未运行或进程标识不匹配");
    if (!(await health("/health/ready"))?.ok) throw new Error("生产中心进程存在，但数据库尚未就绪");
    log("INFO", "生产中心健康检查通过");
  } else if (command === "start") {
    if (state && alive(state.pid)) {
      if (!(await owns(state))) throw new Error("已有生产进程但无法核实身份，拒绝重复启动");
      if (!(await health("/health/ready"))?.ok) throw new Error("生产中心已启动但未就绪");
      log("INFO", "生产中心已在运行");
    } else {
      const instanceId = randomBytes(32).toString("hex");
      const output = fs.openSync(LOG, "a");
      let child;
      try {
        child = spawn(process.execPath, [path.join(ROOT, "dist-server", "online.js")], {
          cwd: ROOT,
          detached: true,
          windowsHide: true,
          env: { ...process.env, PROSPECTOR_ONLINE_INSTANCE: instanceId },
          stdio: ["ignore", output, output],
        });
      } finally { fs.closeSync(output); }
      if (!child.pid) throw new Error("生产中心进程未启动");
      child.unref();
      const next = { marker: INSTANCE_MARKER, pid: child.pid, instanceId };
      fs.writeFileSync(STATE, JSON.stringify(next, null, 2), { encoding: "utf8" });
      const deadline = Date.now() + START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await owns(next) && (await health("/health/ready"))?.ok === true) break;
        if (!alive(next.pid)) throw new Error("生产中心启动后退出，请检查受控日志");
        await delay();
      }
      if (!(await owns(next)) || !(await health("/health/ready"))?.ok) throw new Error("生产中心启动未就绪，保留进程记录供核对");
      log("INFO", "生产中心已启动并通过就绪检查");
    }
  } else if (command === "stop") {
    if (!state || !alive(state.pid)) throw new Error("生产中心未运行");
    if (!(await owns(state))) throw new Error("无法核实生产进程身份，拒绝终止");
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (alive(state.pid) && Date.now() < deadline) await delay();
    if (alive(state.pid)) throw new Error("生产中心未完成退出，保留进程记录");
    fs.unlinkSync(STATE);
    log("INFO", "生产中心已停止");
  } else {
    throw new Error("用法：node scripts/production-server.mjs start|status|stop");
  }
} catch (error) {
  log("ERROR", error instanceof Error ? error.message : "生产中心操作失败；检查受控配置和日志");
  process.exitCode = EXIT_FAILED;
}
