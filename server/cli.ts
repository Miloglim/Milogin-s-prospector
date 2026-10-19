import { Pool } from "pg";
import { readTestDatabaseConfig } from "./adapters/postgres/config";
import { PostgresCrmRepository } from "./adapters/postgres/repository";
import { serverLog } from "./adapters/logger";

const EXIT_FAILED = 1;
async function main() {
  const pool = new Pool(readTestDatabaseConfig());
  try {
    const repository = new PostgresCrmRepository(pool, serverLog);
    const result = await repository.migrate();
    if (!result.ok) {
      serverLog.write("ERROR", "crm.pg.cli", result.error.message);
      process.exitCode = EXIT_FAILED;
      return;
    }
    const resultCount = await pool.query("SELECT count(*)::int AS count FROM crm_schema_migrations");
    serverLog.write("INFO", "crm.pg.cli", `PG 连接与 schema 就绪，迁移数=${resultCount.rows[0].count}`);
  } finally { await pool.end(); }
}
void main().catch(() => {
  serverLog.write("ERROR", "crm.pg.cli", "启动失败，请先启动隔离测试 PG 并检查本机配置");
  process.exitCode = EXIT_FAILED;
});
