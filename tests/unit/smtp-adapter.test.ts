import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { emailAccounts } from "../../src/main/db/schema/accounts";
import type { SendItem } from "../../src/main/services/send.service";
import { simpleParser } from "mailparser";

const h = vi.hoisted(() => ({
  db: null as unknown,
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
  netFetch: vi.fn(),
}));
vi.mock("../../src/main/db", () => ({ getDb: () => h.db }));
vi.mock("../../src/main/services/account.service", () => ({ getDecryptedPassword: () => ({ success: true, data: "test-pass" }) }));
vi.mock("../../src/main/config", () => ({ loadConfig: () => ({ fromName: "Sender" }) }));
vi.mock("../../src/main/net-proxy", () => ({ netFetch: h.netFetch }));
vi.mock("../../src/main/logger", () => ({ Log: { debug: () => {}, warn: () => {}, error: () => {} } }));
vi.mock("nodemailer", () => ({ createTransport: h.createTransport }));

let sendBcc: typeof import("../../src/main/adapters/smtp.adapter").sendBcc;
let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQLLIB = await initSqlJs({ locateFile: file => path.resolve(process.cwd(), "node_modules/sql.js/dist", file) });
});

beforeEach(async () => {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(BASE_SCHEMA_SQL);
  h.db = drizzle(raw, { schema });
  h.createTransport.mockReset();
  h.sendMail.mockReset().mockResolvedValue({ messageId: "sent-1" });
  h.close.mockReset();
  h.netFetch.mockReset();
  h.createTransport.mockReturnValue({ sendMail: h.sendMail, close: h.close });
  vi.resetModules();
  ({ sendBcc } = await import("../../src/main/adapters/smtp.adapter"));
});

function item(accountId: number, extra: Partial<SendItem & { body: string }> = {}): SendItem & { body: string } {
  return {
    id: "test", companyName: "Example", companyId: 0,
    recipients: [{ contactId: 0, email: "client@example.com", name: "Client" }],
    accountId, subject: "Hello", tplBody: "", contactVars: { email: "client@example.com" },
    status: "sending", body: "Hello", ...extra,
  };
}

function seedAccount(signature?: string): number {
  const db = h.db as ReturnType<typeof drizzle<typeof schema>>;
  db.insert(emailAccounts).values({
    email: "sender@example.com", encryptedPass: "encrypted", smtpHost: "smtp.example.com", smtpPort: 587, signature,
  }).run();
  return db.select({ id: emailAccounts.id }).from(emailAccounts).get()!.id;
}

describe("SMTP 适配器", () => {
  it("按账号启用 TLS，单发走 To，抄送走 CC", async () => {
    const result = await sendBcc(item(seedAccount(), { sendMode: "individual", cc: "audit@example.com" }));
    expect(result).toEqual({ success: true, data: { messageId: "sent-1" } });
    expect(h.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      host: "smtp.example.com", port: 587, requireTLS: true, pool: true,
    }));
    expect(h.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: ["client@example.com"], cc: ["audit@example.com"], subject: "Hello",
    }));
  });

  it("断开的池化连接只重试一次，并重建连接", async () => {
    const accountId = seedAccount();
    h.sendMail.mockRejectedValueOnce(new Error("ECONNRESET"));
    const result = await sendBcc(item(accountId));
    expect(result.success).toBe(true);
    expect(h.sendMail).toHaveBeenCalledTimes(2);
    expect(h.createTransport).toHaveBeenCalledTimes(2);
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.sendMail.mock.calls[0]?.[0]).toMatchObject({ bcc: ["client@example.com"] });
  });

  it("真实 MIME 组装后正文的 CID 引用能找到同一张图片附件（不走网络）", async () => {
    const actual = await vi.importActual<typeof import("nodemailer")>("nodemailer");
    const stream = actual.createTransport({ streamTransport: true, buffer: true });
    let raw: Buffer | undefined;
    h.createTransport.mockReturnValue({
      sendMail: async (options: Record<string, unknown>) => {
        const info = await stream.sendMail(options);
        raw = (info as { message: Buffer }).message;
        return info;
      },
      close: () => {},
    });
    const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
    const accountId = seedAccount("<p>Kind regards</p>");
    const result = await sendBcc(item(accountId, { body: `<p>Hi</p><img src="${image}">` }));
    expect(result.success).toBe(true);
    expect(raw).toBeDefined();
    const parsed = await simpleParser(raw!, { keepCidLinks: true });
    expect(parsed.html).toContain("<p>Hi</p>");
    expect(parsed.html).toContain("Kind regards");
    expect(parsed.html).not.toContain("data:image");
    expect(parsed.attachments).toHaveLength(1);
    const [attachment] = parsed.attachments;
    expect(attachment?.contentType).toBe("image/png");
    expect(attachment?.content.length).toBeGreaterThan(0);
    expect(parsed.html).toContain(`cid:${attachment!.cid}`);
  });

  it("本地图片引用被移除，不读取本地路径或发起远程请求", async () => {
    const accountId = seedAccount();
    const result = await sendBcc(item(accountId, { body: '<p>Hi</p><img src="file:///C:/secret.png">' }));
    expect(result.success).toBe(true);
    expect(h.netFetch).not.toHaveBeenCalled();
    const options = h.sendMail.mock.calls[0]?.[0] as { html: string; attachments: unknown[] };
    expect(options.html).not.toContain("file:///C:/secret.png");
    expect(options.attachments).toEqual([]);
  });
});
