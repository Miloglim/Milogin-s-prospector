import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { extractSignature } from "../../src/main/core/signature";
const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../../src/main/db", () => ({ getDb: () => h.db, saveDatabase: () => {} }));
vi.mock("../../src/main/logger", () => ({ Log: { debug: vi.fn(), error: vi.fn() } }));
const { enrichMatchedMail } = await import("../../src/main/services/enrichment.service");
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const body = "Hello\nBest regards,\nAlice\nSales Manager\nACME Logistics Ltd\nTel: +55 11 1234 5678";
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => {
  const raw = new SQL.Database(); raw.run(BASE_SCHEMA_SQL); raw.run("ALTER TABLE inbox_messages ADD COLUMN intent text"); h.db = drizzle(raw, { schema });
  h.db.insert(schema.companies).values({ id: 1, name: "ACME Logistics" }).run();
  h.db.insert(schema.contacts).values({ id: 1, email: "alice@acme.com" }).run();
  h.db.insert(schema.inboxMessages).values({ id: 1, accountId: 1, fromEmail: "alice@acme.com", classification: "replied", matchedContactId: 1, receivedAt: new Date().toISOString() }).run();
});
it("空字段补全、公司唯一匹配、24h 内跳过", () => {
  expect(enrichMatchedMail(1, body)).toEqual({ success: true, data: true });
  const contact = h.db.select().from(schema.contacts).get();
  expect(contact.title).toBe("Sales Manager"); expect(contact.phone).toBe("+55 11 1234 5678"); expect(contact.companyId).toBe(1);
  expect(enrichMatchedMail(1, body)).toEqual({ success: true, data: false });
});
it("不覆盖人工字段、不新建猜测公司", () => {
  h.db.update(schema.contacts).set({ title: "Manual", phone: "Manual" }).run();
  enrichMatchedMail(1, body.replace("ACME Logistics Ltd", "Unknown Logistics Ltd"));
  const c = h.db.select().from(schema.contacts).get();
  expect(c.title).toBe("Manual"); expect(c.phone).toBe("Manual"); expect(c.companyId).toBeNull();
  expect(h.db.select().from(schema.companies).all()).toHaveLength(1);
});
it("抄送匹配/发信/退信不拿第三人的签名填客户", () => {
  h.db.update(schema.inboxMessages).set({ fromEmail: "someone@acme.com" }).run();
  expect(enrichMatchedMail(1, body)).toEqual({ success: true, data: false });
  h.db.update(schema.inboxMessages).set({ fromEmail: "alice@acme.com", classification: "bounce" }).run();
  expect(enrichMatchedMail(1, body)).toEqual({ success: true, data: false });
});
it("公司候选不唯一时留空", () => {
  h.db.insert(schema.companies).values({ name: "ACME Logistics" }).run();
  enrichMatchedMail(1, body);
  expect(h.db.select().from(schema.contacts).get().companyId).toBeNull();
});
it("20 个合成签名与拒识样本（不冒充真实邮件验证）", () => {
  const signoffs = ["Best regards", "Kind regards", "Regards", "Sincerely", "祝好"];
  for (const signoff of signoffs) expect(extractSignature(body.replace("Best regards", signoff)).title).toBe("Sales Manager");
  for (const title of ["Operations Manager", "CEO", "Director", "Sales Executive", "销售经理"]) expect(extractSignature(body.replace("Sales Manager", title)).title).toBe(title);
  for (const bad of ["Hello sales manager", "Regards\nSantos $1200", "Hello\nOn Monday wrote:\n" + body, "Hello\nFrom: alice\n" + body, "Best regards\n1234"]) expect(extractSignature(bad).title).toBeUndefined();
  for (const bad of ["Tel: 123", "Tel: 12345678901234567", "Invoice: 12345678", "Phone: abc", "2026-10-09"]) expect(extractSignature("Regards\n" + bad).phone).toBeUndefined();
});

it("本地化引用头阻止历史公司串入当前发件人", () => {
  for (const header of [
    "De: Bob <bob@example.test>\nEnviada em: Tuesday\nPara: Alice",
    "De:\nBob <bob@example.test>\nEnviado el: Tuesday",
    "Von: Bob <bob@example.test>\nGesendet: Tuesday",
    "Da: Bob <bob@example.test>\nInviato: Tuesday",
    "Sender:Bob<bob@example.test>\nDate:Tuesday",
    "From: Bob <bob@example.test>", "发件人：Bob", "> Best regards",
  ]) {
    expect(extractSignature("Thank you\n\n" + header + "\n" + body)).toEqual({});
    expect(extractSignature(header + "\n" + body)).toEqual({});
    expect(extractSignature(body + "\n" + header + "\nRegards\nOther Logistics Ltd").company).toBe("ACME Logistics Ltd");
  }
});

it("历史签名不回填空联系人公司", () => {
  const text = "Thanks\nDe: Bob <bob@example.test>\nEnviada em: Tuesday\n" + body;
  expect(enrichMatchedMail(1, text)).toEqual({ success: true, data: false });
  expect(h.db.select().from(schema.contacts).get().companyId).toBeNull();
});

it("组合落款、姓名内联职位与空行不消耗签名窗口", () => {
  for (const signoff of ["Tks & B.Rgds.", "Thanks & Regards,", "Best regards/ Saludos cordiales/ Atenciosamente，"]) {
    const text = `Hello\n${signoff}\n\nAlice | Sales Manager\n\nACME Logistics Ltd\n\nAddress: Example\n\nE-mail: alice@example.test\n\nMobile / WhatsApp / Wechat ：+55 11 1234 5678`;
    expect(extractSignature(text)).toEqual({ title: "Sales Manager", company: "ACME Logistics Ltd", phone: "+55 11 1234 5678" });
  }
  expect(extractSignature("****************Best regards,Alice | Sales Supervisor\nACME Logistics Ltd").title).toBe("Sales Supervisor");
  expect(extractSignature("Best regards\nAlice | 华南财务经理 Financial Manager").title).toBe("华南财务经理 Financial Manager");
});

it("号码格式去重但不同电话、双语公司和多个职位继续拒识", () => {
  expect(extractSignature(body + "\nMobile: +55 (11) 1234-5678").phone).toBeTruthy();
  expect(extractSignature(body + "\nMobile: +55 11 9876 5432").phone).toBeUndefined();
  expect(extractSignature(body + "\n艾克物流有限公司").company).toBeUndefined();
  expect(extractSignature(body + "\nBob | CEO").title).toBeUndefined();
  expect(extractSignature("Best regards for the invoice\nCompany: Not A Signature")).toEqual({});
});

it("组合落款不能跨本地化历史引用提取", () => {
  const quoted = "Thanks & Regards,\nDe: Bob <bob@example.test>\nEnviada em: Tuesday\n" + body;
  const fields = extractSignature(quoted);
  expect(fields.company).toBeUndefined();
  expect(fields.phone).toBeUndefined();
});
