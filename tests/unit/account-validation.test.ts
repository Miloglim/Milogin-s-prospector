import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { emailAccounts } from "../../src/main/db/schema/accounts";

const h = vi.hoisted(() => ({ db: null as unknown, createTransport: vi.fn(), verify: vi.fn(), close: vi.fn() }));
vi.mock("../../src/main/db", () => ({ getDb: () => h.db, saveDatabase: () => {} }));
vi.mock("../../src/main/logger", () => ({ Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));

const nodemailer = require("nodemailer") as typeof import("nodemailer");
const Account = await import("../../src/main/services/account.service");
let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQLLIB = await initSqlJs({ locateFile: file => path.resolve(process.cwd(), "node_modules/sql.js/dist", file) });
});

beforeEach(() => {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(BASE_SCHEMA_SQL);
  h.db = drizzle(raw, { schema });
  h.verify.mockReset().mockResolvedValue(undefined);
  h.close.mockReset();
  h.createTransport.mockReset().mockReturnValue({ verify: h.verify, close: h.close });
  vi.spyOn(nodemailer, "createTransport").mockImplementation(h.createTransport);
});

describe("账号连接测试", () => {
  it("仅发信账号跳过 IMAP，不将其误报为连接异常", async () => {
    const db = h.db as ReturnType<typeof drizzle<typeof schema>>;
    db.insert(emailAccounts).values({
      email: "send-only@example.com", encryptedPass: "plain-password",
      smtpHost: "smtp.example.com", smtpPort: 465,
    }).run();
    const id = db.select({ id: emailAccounts.id }).from(emailAccounts).get()!.id;

    const result = await Account.validateAccount(id);
    expect(result).toMatchObject({ success: true, data: { smtpOk: true, imapConfigured: false, imapOk: false } });
    expect(h.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.example.com", port: 465, secure: true,
    }));
  });

  it("编辑为仅发信账号时清除旧的收信失败记录", async () => {
    const db = h.db as ReturnType<typeof drizzle<typeof schema>>;
    db.insert(emailAccounts).values({
      email: "send-only@example.com", encryptedPass: "plain-password",
      smtpHost: "smtp.example.com", smtpPort: 465,
      fetchFailCount: 3, lastFetchError: "未配置 IMAP",
    }).run();
    const id = db.select({ id: emailAccounts.id }).from(emailAccounts).get()!.id;

    const result = await Account.upsertAccount({
      id, email: "send-only@example.com", smtpHost: "smtp.example.com", smtpPort: 465,
      encryptedPass: "plain-password", imapHost: null,
    });
    expect(result).toMatchObject({ success: true, data: { fetchFailCount: 0, lastFetchError: null } });
    expect(h.createTransport).not.toHaveBeenCalled();
  });

  it("编辑账号时不重输密码也能保存 IMAP 地址", async () => {
    const db = h.db as ReturnType<typeof drizzle<typeof schema>>;
    db.insert(emailAccounts).values({
      email: "sender@example.com", encryptedPass: "plain-password",
      smtpHost: "smtp.example.com", smtpPort: 465,
    }).run();
    const id = db.select({ id: emailAccounts.id }).from(emailAccounts).get()!.id;

    const result = await Account.upsertAccount({
      id, email: "sender@example.com", smtpHost: "smtp.example.com", smtpPort: 465,
      encryptedPass: "plain-password", imapHost: "imap.example.com", imapPort: 993,
    });
    expect(result).toMatchObject({ success: true, data: { imapHost: "imap.example.com", imapPort: 993 } });
    expect(await Account.listAccounts()).toMatchObject({ success: true, data: [{ imapHost: "imap.example.com", imapPort: 993 }] });
    expect(h.createTransport).not.toHaveBeenCalled();
  });
});
