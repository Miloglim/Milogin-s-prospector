import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { eq } from "drizzle-orm";

// ═══════════════════════════════════════════════════════════════════
// generate_draft 回信模式（docs/agent-draft-reply-spec.md）
// 钉住用户实测缺口：「第一封，以运去哪的身份回复他」——agent 读完邮件
// 只能给策略给不出草稿，因为 generateEmailDraft 看不到来信内容。
// 回信模式 = 传 messageId：取信→HTML 清洗→prompt 带来信全文→Re: 主题，
// 收件人 matchedContactId 优先、否则 fromEmail 精确匹配（禁模糊）。
// ═══════════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => {},
  getRawDb: () => null,
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
// LLM mock：回信/开发信都返回固定草稿文本，捕获入参做断言
const replyFn = vi.fn(async () => ({
  success: true as const,
  data: "SUBJECT: Re: Quote request 40HQ\n\nDear Juan, please find our rate below...",
}));
const draftFn = vi.fn(async () => ({
  success: true as const,
  data: "SUBJECT: Following up — ACME Corp\n\nHope all is well...",
}));
vi.mock("../../src/main/services/ai.service", () => ({
  summarizeEmail: vi.fn(),
  generateBackcheckReport: vi.fn(),
  generateEmailDraft: (...a: unknown[]) => draftFn(...(a as [])),
  generateEmailReply: (...a: unknown[]) => replyFn(...(a as [])),
  searchCompany: vi.fn(),
}));

const live = { rows: [] as Array<Record<string, unknown>> };
vi.mock("../../src/main/adapters/navigator-quotes.adapter", () => ({
  listQuotes: async () => ({ success: true, data: live.rows }),
  countQuotes: async () => live.rows.length,
}));
const authState = vi.hoisted(() => ({ epoch: 1 }));
vi.mock("../../src/main/adapters/navigator-auth.adapter", () => ({
  requireNavigatorAuthorization: async () => ({ ok: true, data: { authenticated: true } }),
  navigatorAuthorizationEpoch: () => authState.epoch, onNavigatorIdentityChanged: () => () => {}, navigatorHasAuthorization: () => true,
}));

const DDL = `
CREATE TABLE companies (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, name text NOT NULL, domain text, industry text,
  country text, size text, backcheck_data text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE contacts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, email text NOT NULL UNIQUE, company_id integer,
  first_name text, last_name text, title text, phone text, linkedin text, country text,
  client_type text, language text, stage text DEFAULT 'cold', status text DEFAULT '', tags text,
  extra text DEFAULT '{}', assignee text DEFAULT '', source text DEFAULT 'manual', source_detail text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE inbox_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, account_id integer NOT NULL, message_id text,
  from_email text NOT NULL, from_name text, subject text, body_preview text, classification text,
   intent text,
  "to" text, cc text, my_role text, matched_contact_id integer, related_contact_ids text,
  is_read integer DEFAULT 0 NOT NULL, received_at text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE agent_conversations (
  id text PRIMARY KEY NOT NULL, title text DEFAULT '新对话' NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE agent_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, conversation_id text NOT NULL,
  role text NOT NULL, content text NOT NULL, created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE agent_tool_calls (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, conversation_id text NOT NULL, tool_name text NOT NULL,
  side_effect text NOT NULL, args_json text, result_json text, approval text NOT NULL, error text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
CREATE TABLE agent_working_memory (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL, conversation_id text NOT NULL,
  kind text NOT NULL, ref_id text NOT NULL, tool_name text NOT NULL,
  context_line text NOT NULL, payload_json text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL, updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

function newSandbox(): Driz {
  const raw: SqlJsDatabase = new SQLLIB.Database();
  raw.run(DDL);
  const db = drizzle(raw, { schema });
  h.db = db;
  db.insert(schema.companies).values([{ name: "ACME Corp" }]).run();
  const acme = db.select().from(schema.companies).where(eq(schema.companies.name, "ACME Corp")).get()!.id;
  db.insert(schema.contacts).values([
    { email: "juan@acme.com", firstName: "Juan", lastName: "Garcia", companyId: acme, country: "Mexico" },
  ]).run();
  db.insert(schema.inboxMessages).values([
    { accountId: 1, fromEmail: "juan@acme.com", fromName: "Juan Garcia",
      subject: "Quote request 40HQ",
      bodyPreview: "<div dir=\"ltr\"><p>Hello,</p><p>We need a rate for <b>2x40HQ</b> to Veracruz.</p></div>",
      classification: "inquiry", matchedContactId: 1, isRead: 0, receivedAt: "2026-09-07T08:15:00Z" },
    { accountId: 1, fromEmail: "Stranger@unknown.io", fromName: "New Lead",
      subject: "Partnership inquiry",
      bodyPreview: "<p>Hi, we are a forwarder in Nairobi.</p>",
      classification: "inquiry", isRead: 0, receivedAt: "2026-09-07T09:00:00Z" },
    { accountId: 1, fromEmail: "x@y.com", fromName: "Empty",
      subject: "Re: Quote request 40HQ",
      bodyPreview: "   ",
      classification: "inquiry", isRead: 0, receivedAt: "2026-09-07T10:00:00Z" },
  ]).run();
  return db;
}

type ToolLike = { invoke: (rc: unknown, input: string, details?: unknown) => Promise<string> };
const call = (t: ToolLike, args: unknown): Promise<string> => t.invoke({}, JSON.stringify(args));

const { buildHarnessTools } = await import("../../src/main/services/agent/tools");

const ctx = { conversationId: "test-conv", counts: new Map<string, number>(), failures: new Map<string, number>() };
let toolByName: Record<string, ToolLike> = {};
const T = (name: string): ToolLike => toolByName[name]!;

describe("generate_draft 回信模式", () => {
  beforeAll(async () => {
    if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
  });
  beforeEach(() => {
    newSandbox();
    authState.epoch = 1;
    live.rows = [];
    ctx.counts.clear();
    ctx.failures.clear();
    replyFn.mockClear();
    const all = buildHarnessTools(ctx) as unknown as ToolLike[];
    toolByName = Object.fromEntries(all.map(t => [t.name ?? "", t]));
  });

  it("闭环：工作台历史价与实时价不同 → 回信只用实时价与来信要素", async () => {
    // 预置一条与来信柜型(40HQ)匹配的运价到会话工作台（如此前 quote_search 查到的）
    h.db!.insert(schema.agentWorkingMemory).values({
      conversationId: "test-conv", kind: "rates", refId: "r-veracruz-40hq", toolName: "quote_search",
      contextLine: "运价 宁波→VERACRUZ 40HQ：2 条，最低 $8,800",
      payloadJson: JSON.stringify({
        pod: "VERACRUZ", container: "40HQ", total: 2,
        rows: [
          { carrier: "MSK", container: "40HQ", pol: "宁波", pod: "VERACRUZ", price: 8800, validFrom: "9/8", validTo: "9/14", note: null },
          { carrier: "EMC", container: "40HQ", pol: "宁波", pod: "VERACRUZ", price: 9200, validFrom: null, validTo: null, note: null },
        ],
      }),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();

    h.db.update(schema.inboxMessages).set({ bodyPreview: "Please quote 2x40HQ. POD: VERACRUZ" }).where(eq(schema.inboxMessages.id, 1)).run();
    live.rows = [{ carrier: "MSK", container: "40HQ", pol: "宁波", podRaw: "VERACRUZ", oceanUsd: 8100 },
      { carrier: "EMC", container: "40HQ", pol: "宁波", podRaw: "VERACRUZ", oceanUsd: 9200 }];
    const out = JSON.parse(await call(T("generate_draft"), { messageId: 1 })) as { ratesUsed?: number };
    expect(replyFn).toHaveBeenCalledTimes(1);
    const arg = replyFn.mock.calls[0]![0] as {
      rates?: Array<{ carrier: string | null; price: number | null }> | null;
      emailFacts?: { container?: string | null } | null;
    };
    expect(arg.emailFacts?.container).toBe("40HQ");          // 来信要素已解析并传入
    expect(Array.isArray(arg.rates)).toBe(true);
    expect(arg.rates).toHaveLength(2);                        // 工作台真价被程序化拉进起草
    expect(arg.rates![0]!.price).toBe(8100); // 使用实时新价，忽略工作台历史 8800
    expect(out.ratesUsed).toBe(2);                            // 出参回显用了几条真价
  });

  it("询价邮件但工作台无匹配价 → 不编造，出参带 notice 提示先查价", async () => {
    const out = JSON.parse(await call(T("generate_draft"), { messageId: 1 })) as { notice?: string; ratesUsed?: number };
    const arg = replyFn.mock.calls[0]![0] as { rates?: unknown[] | null };
    expect(arg.rates == null || (arg.rates as unknown[]).length === 0).toBe(true);
    expect(out.ratesUsed).toBeUndefined();
    expect(out.notice).toContain("不编");                       // 不编造；指路口径随台账自查/同步/行情演进
  });

  it("传 messageId：prompt 带来信纯文本（去 HTML），主题强制 Re:，收件人走关联联系人", async () => {
    const out = JSON.parse(await call(T("generate_draft"), { messageId: 1 })) as {
      subject: string; body: string; contactId: number | null; language: string;
      actions: Array<{ label: string }>;
    };
    expect(replyFn).toHaveBeenCalledTimes(1);
    const arg = replyFn.mock.calls[0]![0] as { bodyText: string; fromEmail: string; subject: string | null; companyName: string; contactName: string };
    expect(arg.bodyText).toContain("2x40HQ");
    expect(arg.bodyText).not.toContain("<div");          // HTML 标签已清洗
    expect(arg.bodyText).not.toContain("<b>");
    expect(arg.fromEmail).toBe("juan@acme.com");
    expect(arg.subject).toBe("Quote request 40HQ");
    expect(arg.companyName).toBe("ACME Corp");           // 关联联系人档案补全
    expect(arg.contactName).toBe("Juan Garcia");
    expect(out.subject).toBe("Re: Quote request 40HQ");  // 无 Re: 前缀 → 补上
    expect(out.contactId).toBe(1);                       // matchedContactId 命中 → 有入队按钮
    expect(out.actions.map(a => a.label)).toContain("入队发给这位联系人");
  });

  it("来信邮箱不在联系人库：照常出稿，contactId 为空、只有存素材库动作（禁模糊匹配）", async () => {
    const out = JSON.parse(await call(T("generate_draft"), { messageId: 2 })) as {
      contactId: number | null; actions: Array<{ label: string }>;
    };
    const arg = replyFn.mock.calls[0]![0] as { companyName: string; contactName: string };
    expect(arg.companyName).toBe("New Lead");            // 库里没有 → 退回来信人信息
    expect(arg.contactName).toBe("New Lead");
    expect(out.contactId).toBeNull();
    expect(out.actions.map(a => a.label)).toEqual(["存入素材库"]);
  });

  it("邮件不存在 → not_found；正文为空 → empty_body，都不调 LLM", async () => {
    const miss = JSON.parse(await call(T("generate_draft"), { messageId: 999 })) as { error?: string };
    expect((miss.error as { message: string }).message).toContain("不存在");
    const empty = JSON.parse(await call(T("generate_draft"), { messageId: 3 })) as { error?: string };
    expect((empty.error as { message: string }).message).toContain("正文");
    expect(replyFn).not.toHaveBeenCalled();
  });

  it("已有 Re: 前缀的主题不重复加", async () => {
    h.db!.insert(schema.inboxMessages).values({
      accountId: 1, fromEmail: "juan@acme.com", fromName: "Juan Garcia",
      subject: "Re: Quote request 40HQ", bodyPreview: "<p>Any update?</p>",
      classification: "reply", isRead: 0, receivedAt: "2026-09-07T11:00:00Z",
    }).run();
    const out = JSON.parse(await call(T("generate_draft"), { messageId: 4 })) as { subject: string };
    expect(out.subject).toBe("Re: Quote request 40HQ");
  });
  it("a delayed quote draft from account A cannot create actions or context after switching to B", async () => {
    const { dropActionsForConversation } = await import("../../src/main/services/agent/actions");
    dropActionsForConversation(ctx.conversationId);
    h.db.update(schema.inboxMessages).set({ bodyPreview: "Please quote 2x40HQ. POD: VERACRUZ" }).where(eq(schema.inboxMessages.id, 1)).run();
    live.rows = [{ carrier: "MSK", container: "40HQ", podRaw: "VERACRUZ", oceanUsd: 8100 }];
    let release!: (value: { success: true; data: string }) => void;
    let started!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    replyFn.mockImplementationOnce(() => new Promise(resolve => { release = resolve; started(); }));
    const pending = call(T("generate_draft"), { messageId: 1 });
    await waiting;
    authState.epoch++;
    release({ success: true, data: "SUBJECT: Quote\n\nRate USD 8100 from account A" });
    const out = JSON.parse(await pending);
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("navigator_identity_changed");
    expect(out.actions).toBeUndefined();
    expect(dropActionsForConversation(ctx.conversationId)).toBe(0);
    expect(h.db.select().from(schema.agentWorkingMemory).all()).toHaveLength(0);
    expect(h.db.select().from(schema.agentToolCalls).all()).toHaveLength(0);
  });

});
