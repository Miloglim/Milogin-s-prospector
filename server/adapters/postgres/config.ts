import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool, PoolConfig } from "pg";
import settings from "../../core/postgres-test-settings.json";

export const CRM_TEST_DATABASE = settings.database;
export const CRM_TEST_PORT = settings.port;
export const CRM_TEST_HOST = settings.host;
export const CRM_RUNTIME_MARKER = settings.marker;
const MILLISECONDS_PER_SECOND = 1000;
const CONNECTION_MAX = 4;
const PRODUCTION_DATABASE = "milogin_center";
const PRODUCTION_USER = "milogin_app";
const LOCAL_HOST = "127.0.0.1";
export const CRM_CONFIG_RELATIVE_PATH = ".work/pg-crm/config.json";

/** No environment DSN fallback: this node may only connect to its isolated test instance. */
export function readTestDatabaseConfig(): PoolConfig {
  const value = JSON.parse(readFileSync(path.resolve(CRM_CONFIG_RELATIVE_PATH), "utf8")) as Record<string, unknown>;
  if (value.marker !== CRM_RUNTIME_MARKER || value.database !== CRM_TEST_DATABASE
    || value.user !== CRM_TEST_DATABASE || value.host !== CRM_TEST_HOST || value.port !== CRM_TEST_PORT
    || typeof value.password !== "string" || !value.password
    || value.connection_timeout_seconds !== settings.connection_timeout_seconds) {
    throw new Error("测试 PG 配置无效；禁止使用正式数据库配置");
  }
  return {
    host: CRM_TEST_HOST, port: CRM_TEST_PORT, database: CRM_TEST_DATABASE, user: CRM_TEST_DATABASE,
    password: value.password, max: CONNECTION_MAX,
    connectionTimeoutMillis: value.connection_timeout_seconds * MILLISECONDS_PER_SECOND,
    application_name: "prospector-crm-isolated", ssl: false,
  };
}

export function readProductionDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const dsn = env.PROSPECTOR_CENTER_PG_DSN;
  if (!dsn) throw new Error("缺少正式中心数据库连接配置");
  let url: URL;
  try { url = new URL(dsn); }
  catch { throw new Error("正式中心数据库连接配置无效"); }
  const port = Number(url.port || 5432);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== LOCAL_HOST
    || !Number.isSafeInteger(port) || port < 1 || port > 65535 || url.pathname !== `/${PRODUCTION_DATABASE}`
    || decodeURIComponent(url.username) !== PRODUCTION_USER || !url.password
    || url.search || url.hash) throw new Error("正式中心只能连接本机独立应用数据库");
  return {
    host: LOCAL_HOST, port, database: PRODUCTION_DATABASE, user: PRODUCTION_USER,
    password: decodeURIComponent(url.password), max: CONNECTION_MAX,
    connectionTimeoutMillis: settings.connection_timeout_seconds * MILLISECONDS_PER_SECOND,
    application_name: "milogin-center", ssl: false,
  };
}

export function readOnlineDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  if (!env.PROSPECTOR_CENTER_MODE || env.PROSPECTOR_CENTER_MODE === 'test') return readTestDatabaseConfig();
  if (env.PROSPECTOR_CENTER_MODE === 'production') return readProductionDatabaseConfig(env);
  throw new Error("未知中心运行模式");
}

export function assertCenterDatabasePool(pool: Pool, env: NodeJS.ProcessEnv = process.env): void {
  const expected = readOnlineDatabaseConfig(env);
  if (pool.options.host !== expected.host || pool.options.port !== expected.port
    || pool.options.database !== expected.database || pool.options.user !== expected.user) {
    throw new Error(env.PROSPECTOR_CENTER_MODE === 'production'
      ? "中心数据库连接与运行模式不匹配" : "中心仅允许隔离测试数据库");
  }
}
