import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import * as configModule from "../../server/adapters/postgres/config.ts";
import { PostgresCrmRepository } from "../../server/adapters/postgres/repository.ts";

const originalEnvironment = { ...process.env };

beforeEach(() => {
  process.env.PROSPECTOR_CENTER_MODE = "production";
  process.env.PROSPECTOR_CENTER_PG_HOST = "postgres.internal";
  process.env.PROSPECTOR_CENTER_PG_PORT = "5432";
  process.env.PROSPECTOR_CENTER_PG_USER = "milogin_app";
  process.env.PROSPECTOR_CENTER_PG_PASSWORD = "must-not-appear";
  delete process.env.PROSPECTOR_CENTER_PG_DSN;
  delete process.env.PROSPECTOR_CENTER_PG_KMS_SECRET;
  delete process.env["postgres.password"];
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
});

function pool(connect) {
  return {
    options: {
      host: "postgres.internal",
      port: 5432,
      database: "milogin_center",
      user: "milogin_app",
    },
    on() {},
    connect,
  };
}

test("CRM migration logs the failing phase and sanitized timeout cause", async () => {
  const cause = Object.assign(new Error("timeout expired"), { code: "ETIMEDOUT" });
  const timeout = new Error("Connection terminated due to connection timeout", { cause });
  const entries = [];
  const repository = new PostgresCrmRepository(
    pool(async () => { throw timeout; }),
    { write: (level, context, message) => entries.push({ level, context, message }) },
  );

  assert.deepEqual(await repository.migrate(), {
    ok: false,
    error: { code: "DATABASE_ERROR", message: "数据库操作失败，请检查测试服务状态" },
  });
  const diagnostic = entries.find(entry => entry.context === "crm.pg.migrate")?.message ?? "";
  assert.match(diagnostic, /phase=connect/);
  assert.match(diagnostic, /code=UNKNOWN/);
  assert.match(diagnostic, /name=Error/);
  assert.match(diagnostic, /message=Connection terminated due to connection timeout/);
  assert.match(diagnostic, /cause_code=ETIMEDOUT/);
  assert.match(diagnostic, /cause_message=timeout expired/);
  assert.doesNotMatch(diagnostic, /must-not-appear/);
});

test("CRM migration logs checksum rejection instead of only returning a generic failure", async () => {
  const entries = [];
  const client = {
    async query(statement) {
      if (statement.startsWith("SELECT checksum FROM crm_schema_migrations")) {
        return { rows: [{ checksum: "synthetic-drift" }] };
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresCrmRepository(
    pool(async () => client),
    { write: (level, context, message) => entries.push({ level, context, message }) },
  );

  assert.deepEqual(await repository.migrate(), {
    ok: false,
    error: { code: "CONFLICT", message: "已应用迁移校验不一致，拒绝覆盖" },
  });
  const diagnostic = entries.find(entry => entry.context === "crm.pg.migrate")?.message ?? "";
  assert.match(diagnostic, /迁移被拒绝/);
  assert.match(diagnostic, /phase=checksum/);
  assert.match(diagnostic, /code=CONFLICT/);
  assert.match(diagnostic, /message=已应用迁移校验不一致，拒绝覆盖/);
  assert.match(diagnostic, /elapsed_ms=\d+/);
});

test("CRM migration reports the SQL phase that actually failed", async () => {
  const entries = [];
  const client = {
    async query(statement) {
      if (statement.startsWith("SELECT pg_advisory_xact_lock")) {
        throw Object.assign(new Error("permission denied for advisory lock"), { code: "42501" });
      }
      return { rows: [] };
    },
    release() {},
  };
  const repository = new PostgresCrmRepository(
    pool(async () => client),
    { write: (level, context, message) => entries.push({ level, context, message }) },
  );

  assert.equal((await repository.migrate()).ok, false);
  const diagnostic = entries.find(entry => entry.context === "crm.pg.migrate")?.message ?? "";
  assert.match(diagnostic, /phase=advisory_lock/);
  assert.match(diagnostic, /code=42501/);
  assert.match(diagnostic, /message=permission denied for advisory lock/);
});

test("CRM migration diagnostics redact database credentials and username", async () => {
  const entries = [];
  const error = Object.assign(
    new Error('password=topsecret authentication failed for user "milogin_app" at postgresql://milogin_app:topsecret@postgres.internal:5432/milogin_center'),
    { code: "28P01" },
  );
  const repository = new PostgresCrmRepository(
    pool(async () => { throw error; }),
    { write: (level, context, message) => entries.push({ level, context, message }) },
  );

  assert.equal((await repository.migrate()).ok, false);
  const diagnostic = entries.find(entry => entry.context === "crm.pg.migrate")?.message ?? "";
  assert.doesNotMatch(diagnostic, /topsecret|milogin_app/);
  assert.match(diagnostic, /password=\[redacted\]/);
  assert.match(diagnostic, /for user \[redacted\]/);
  assert.match(diagnostic, /postgresql:\/\/\[redacted\]@postgres\.internal/);
});

test("database connection summary includes routing facts and excludes credentials", () => {
  assert.equal(typeof configModule.describePostgresConnection, "function");
  const summary = configModule.describePostgresConnection({
    host: "postgres.internal",
    port: 5432,
    database: "milogin_center",
    user: "milogin_app",
    password: "must-not-appear",
    connectionString: "postgresql://milogin_app:must-not-appear@postgres.internal:5432/milogin_center",
    connectionTimeoutMillis: 5000,
    application_name: "prospector-center",
    options: "-c search_path=prospector,public",
    ssl: false,
  });

  assert.match(summary, /host=postgres.internal/);
  assert.match(summary, /port=5432/);
  assert.match(summary, /database=milogin_center/);
  assert.match(summary, /timeout_ms=5000/);
  assert.match(summary, /application=prospector-center/);
  assert.match(summary, /search_path=prospector,public/);
  assert.match(summary, /ssl=false/);
  assert.doesNotMatch(summary, /must-not-appear|password|connectionString|milogin_app/);
});
