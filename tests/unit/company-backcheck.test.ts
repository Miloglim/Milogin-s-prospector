import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { companies } from "../../src/main/db/schema/companies";
import { contacts } from "../../src/main/db/schema/contacts";

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db, saveDatabase: () => {}, getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({ Log: log }));

const { getBackcheckReport, saveBackcheck } = await import("../../src/main/services/company.service");
let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQLLIB = await initSqlJs({ locateFile: file => path.resolve(process.cwd(), "node_modules/sql.js/dist", file) });
});

beforeEach(() => {
  log.warn.mockClear();
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(BASE_SCHEMA_SQL);
  h.db = drizzle(raw, { schema });
});

describe("公司背调持久化", () => {
  it("保存报告，更新联系人分类，并可供后续开发信读取", () => {
    h.db.insert(companies).values({ name: "Atlas Logistics" }).run();
    const company = h.db.select().from(companies).get()!;
    h.db.insert(contacts).values({ email: "a@atlas.com", companyId: company.id }).run();
    const report = { summary: "国际货代", rating: 4 };

    const saved = saveBackcheck({ name: "Atlas Logistics", report });

    expect(saved).toEqual({ success: true, data: { id: company.id, clientType: "agent" } });
    expect(getBackcheckReport("Atlas Logistics")).toEqual(report);
    expect(h.db.select().from(contacts).get()?.clientType).toBe("agent");
  });

  it("报告 JSON 损坏时记录告警并返回空值", () => {
    h.db.insert(companies).values({ name: "Broken", backcheckData: "{" }).run();

    expect(getBackcheckReport("Broken")).toBeNull();
    expect(log.warn).toHaveBeenCalledOnce();
  });
});
