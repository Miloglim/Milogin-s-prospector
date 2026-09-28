import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { emailAccounts } from "../../src/main/db/schema/accounts";

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db, getRawDb: () => null, saveDatabase: () => {},
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/services/suggestion-bus", () => ({ nudge: () => {} }));

const Inbox = await import("../../src/main/services/inbox.service");
let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQLLIB = await initSqlJs({ locateFile: file => path.resolve(process.cwd(), "node_modules/sql.js/dist", file) });
});

beforeEach(() => {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(BASE_SCHEMA_SQL);
  h.db = drizzle(raw, { schema });
  h.db.insert(emailAccounts).values({ email: "sales@example.com", encryptedPass: "x", isActive: 1 }).run();
  Inbox.setImapFetchFn(async () => ({ success: true, data: [] }));
});

describe("手动抓取收件箱", () => {
  it("仍会在返回列表后触发退信深补和 Sent 探测", async () => {
    const backfillBounceDeep = vi.fn(async () => 0);
    const detectSent = vi.fn(async () => 0);
    Inbox.setPostFetchAdapters({ isPop3Port: () => false, backfillBounceDeep, detectSent });

    const result = await Inbox.refreshInbox();
    await vi.waitFor(() => expect(backfillBounceDeep).toHaveBeenCalledOnce());

    expect(result.success).toBe(true);
    expect(detectSent).toHaveBeenCalledOnce();
  });
});
