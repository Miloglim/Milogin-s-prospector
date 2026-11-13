import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { emailAccounts } from "../../src/main/db/schema/accounts";

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz, raw: null as unknown as SqlJsDatabase };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  getRawDb: () => ({
    prepare: (sql: string) => {
      const statement = h.raw.prepare(sql);
      return {
        run: (...args: unknown[]) => { statement.run(args as never); return { changes: h.raw.getRowsModified() }; },
        get: (...args: unknown[]) => {
          statement.bind(args as never);
          const row = statement.step() ? statement.getAsObject() : undefined;
          statement.reset();
          return row;
        },
        all: (...args: unknown[]) => {
          statement.bind(args as never);
          const rows: unknown[] = [];
          while (statement.step()) rows.push(statement.getAsObject());
          statement.reset();
          return rows;
        },
      };
    },
  }),
  saveDatabase: () => {},
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
  const raw = new SQLLIB.Database();
  h.raw = raw;
  raw.run(BASE_SCHEMA_SQL);
  h.db = drizzle(raw, { schema });
  h.db.insert(emailAccounts).values({
    email: "sales@example.com", encryptedPass: "x", imapHost: "imap.example.com", imapPort: 993, isActive: 1,
  }).run();
  Inbox.setImapFetchFn(async () => ({ success: true as const, data: [] }));
});

afterEach(() => {
  Inbox.stopAutoFetch();
  Inbox.setInboxNetworkAllowed(() => true);
});

describe("inbox initial sync state", () => {
  it("uses a 90-day initial window and preserves one overall progress total across batches", () => {
    const window = Inbox.inboxSyncWindow(1);
    expect(window.phase).toBe("initial");
    const days = (Date.parse(window.windowToAt!) - Date.parse(window.windowFromAt!)) / 86_400_000;
    expect(Math.round(days)).toBe(90);

    Inbox.beginInboxSyncBatch(1, 900, 400);
    Inbox.finishInboxSyncBatch(1, { cursorUid: 500, scanned: 500, newCount: 320, remaining: 400 });
    Inbox.beginInboxSyncBatch(1, 900, 0);
    Inbox.finishInboxSyncBatch(1, { cursorUid: 900, scanned: 400, newCount: 120, remaining: 0 });

    const account = Inbox.inboxSyncSnapshot().accounts[0]!;
    expect(account).toMatchObject({
      phase: "ready", targetCount: 900, scannedCount: 900, newCount: 440, remainingCount: 0,
    });
    expect(account.firstCompletedAt).toBeTruthy();
  });

  it("continues immediate batches until the whole initial window is complete", async () => {
    Inbox.inboxSyncWindow(1);
    let calls = 0;
    Inbox.setImapFetchFn(async () => {
      calls++;
      if (calls === 1) {
        Inbox.beginInboxSyncBatch(1, 520, 20);
        Inbox.finishInboxSyncBatch(1, { cursorUid: 500, scanned: 500, newCount: 400, remaining: 20 });
      } else {
        Inbox.beginInboxSyncBatch(1, 520, 0);
        Inbox.finishInboxSyncBatch(1, { cursorUid: 520, scanned: 20, newCount: 20, remaining: 0 });
      }
      return { success: true as const, data: [] };
    });

    const result = await Inbox.refreshInbox(1);
    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    expect(Inbox.inboxSyncSnapshot().accounts[0]).toMatchObject({
      phase: "ready", targetCount: 520, scannedCount: 520, remainingCount: 0,
    });
  });

  it("continues a pending first sync from the immediate automatic start", async () => {
    Inbox.inboxSyncWindow(1);
    let calls = 0;
    Inbox.setImapFetchFn(async () => {
      calls++;
      if (calls === 1) {
        Inbox.beginInboxSyncBatch(1, 510, 10);
        Inbox.finishInboxSyncBatch(1, { cursorUid: 500, scanned: 500, newCount: 410, remaining: 10 });
      } else {
        Inbox.beginInboxSyncBatch(1, 510, 0);
        Inbox.finishInboxSyncBatch(1, { cursorUid: 510, scanned: 10, newCount: 10, remaining: 0 });
      }
      return { success: true as const, data: [] };
    });

    Inbox.startAutoFetch(60_000);
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(Inbox.inboxSyncSnapshot().accounts[0]).toMatchObject({ phase: "ready", scannedCount: 510 });
  });

  it("opens the previous history window only after the initial sync is complete", async () => {
    expect((await Inbox.refreshInboxHistory({ accountId: 1, months: 3 })).success).toBe(false);

    const initial = Inbox.inboxSyncWindow(1);
    Inbox.beginInboxSyncBatch(1, 1, 0);
    Inbox.finishInboxSyncBatch(1, { cursorUid: 1, scanned: 1, newCount: 1, remaining: 0 });
    expect((await Inbox.refreshInboxHistory({ accountId: 1, months: 3 })).success).toBe(true);

    const account = Inbox.inboxSyncSnapshot().accounts[0]!;
    expect(account.phase).toBe("history");
    expect(Date.parse(account.windowToAt!)).toBeLessThanOrEqual(Date.parse(initial.windowFromAt!));
    expect(Date.parse(account.windowFromAt!)).toBeLessThan(Date.parse(account.windowToAt!));
  });
});
