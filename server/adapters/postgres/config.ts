import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool, PoolConfig } from "pg";
import settings from "../../core/postgres-test-settings.json";
import { postgresKmsSecretName, resolvePostgresKmsCredential, type PostgresKmsCredential } from "./kms-credential";

export const CRM_TEST_DATABASE = settings.database;
export const CRM_TEST_PORT = settings.port;
export const CRM_TEST_HOST = settings.host;
export const CRM_RUNTIME_MARKER = settings.marker;
const MILLISECONDS_PER_SECOND = 1000;
const CONNECTION_MAX = 4;
const PRODUCTION_DATABASE = "milogin_center";
const DEFAULT_PRODUCTION_USER = "milogin_app";
const LOCAL_HOST = "127.0.0.1";
const DEFAULT_PRODUCTION_PORT = 5432;
const MAX_PORT = 65535;
const PRODUCTION_SEARCH_PATH = "prospector,public";
const PRODUCTION_OPTIONS = `-c search_path=${PRODUCTION_SEARCH_PATH}`;
export const CRM_CONFIG_RELATIVE_PATH = ".work/pg-crm/config.json";

function productionHost(env: NodeJS.ProcessEnv): string {
  const host = (env.PROSPECTOR_CENTER_PG_HOST || LOCAL_HOST).trim();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host)) throw new Error("正式中心数据库主机名无效");
  return host;
}

function productionUser(env: NodeJS.ProcessEnv): string {
  const user = (env.PROSPECTOR_CENTER_PG_USER || DEFAULT_PRODUCTION_USER).trim();
  if (!user || /[\u0000-\u001f\u007f]/.test(user)) throw new Error("正式中心数据库用户名无效");
  return user;
}

function productionPool(host: string, port: number, user: string, password: string): PoolConfig {
  return {
    host, port, database: PRODUCTION_DATABASE, user,
    password, max: CONNECTION_MAX,
    connectionTimeoutMillis: settings.connection_timeout_seconds * MILLISECONDS_PER_SECOND,
    application_name: "prospector-center", options: PRODUCTION_OPTIONS, ssl: false,
  };
}

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
  const expectedHost = productionHost(env);
  const expectedUser = productionUser(env);
  if (!dsn) {
    const password = env.PROSPECTOR_CENTER_PG_PASSWORD;
    const port = Number(env.PROSPECTOR_CENTER_PG_PORT || DEFAULT_PRODUCTION_PORT);
    if (!password || !Number.isSafeInteger(port) || port < 1 || port > MAX_PORT) throw new Error("缺少正式中心数据库连接配置");
    return productionPool(expectedHost, port, expectedUser, password);
  }
  let url: URL;
  try { url = new URL(dsn); }
  catch { throw new Error("正式中心数据库连接配置无效"); }
  const port = Number(url.port || DEFAULT_PRODUCTION_PORT);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== expectedHost
    || !Number.isSafeInteger(port) || port < 1 || port > MAX_PORT || url.pathname !== `/${PRODUCTION_DATABASE}`
    || decodeURIComponent(url.username) !== expectedUser || !url.password
    || url.search || url.hash) throw new Error("正式中心只能连接本机独立应用数据库");
  return productionPool(expectedHost, port, expectedUser, decodeURIComponent(url.password));
}

export function readOnlineDatabaseConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  if (!env.PROSPECTOR_CENTER_MODE || env.PROSPECTOR_CENTER_MODE === 'test') return readTestDatabaseConfig();
  if (env.PROSPECTOR_CENTER_MODE === 'production') return readProductionDatabaseConfig(env);
  throw new Error("未知中心运行模式");
}

export async function resolveOnlineDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
  loadCredential: (source: NodeJS.ProcessEnv) => Promise<PostgresKmsCredential> = resolvePostgresKmsCredential,
): Promise<PoolConfig> {
  if (env.PROSPECTOR_CENTER_MODE !== 'production' || !postgresKmsSecretName(env)) {
    return readOnlineDatabaseConfig(env);
  }
  const credential = await loadCredential(env);
  const resolved: NodeJS.ProcessEnv = {
    ...env,
    PROSPECTOR_CENTER_PG_USER: credential.username,
    PROSPECTOR_CENTER_PG_PASSWORD: credential.password,
  };
  delete resolved.PROSPECTOR_CENTER_PG_DSN;
  return readProductionDatabaseConfig(resolved);
}

export function assertCenterDatabasePool(pool: Pool, env: NodeJS.ProcessEnv = process.env): void {
  let expectedEnv = env;
  if (env.PROSPECTOR_CENTER_MODE === 'production' && postgresKmsSecretName(env)) {
    expectedEnv = {
      ...env,
      PROSPECTOR_CENTER_PG_USER: String(pool.options.user || ''),
      PROSPECTOR_CENTER_PG_PASSWORD: 'kms-resolved',
    };
    delete expectedEnv.PROSPECTOR_CENTER_PG_DSN;
  }
  const expected = readOnlineDatabaseConfig(expectedEnv);
  if (pool.options.host !== expected.host || pool.options.port !== expected.port
    || pool.options.database !== expected.database || pool.options.user !== expected.user) {
    throw new Error(env.PROSPECTOR_CENTER_MODE === 'production'
      ? "中心数据库连接与运行模式不匹配" : "中心仅允许隔离测试数据库");
  }
}
