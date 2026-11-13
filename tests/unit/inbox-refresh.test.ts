import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
import { emailAccounts } from "../../src/main/db/schema/accounts";
import { INBOX_TODO_DDL } from "../../src/main/core/inbox-todo-storage";

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
    transaction: (fn: () => unknown) => () => {
      h.raw.run('BEGIN');
      try {
        const result = fn();
        h.raw.run('COMMIT');
        return result;
      } catch (error) {
        h.raw.run('ROLLBACK');
        throw error;
      }
    },
  }),
  saveDatabase: () => {},
}));
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../src/main/logger", () => ({
  Log: log,
}));
vi.mock("../../src/main/services/suggestion-bus", () => ({ nudge: () => {} }));

const Inbox = await import("../../src/main/services/inbox.service");
afterEach(() => { Inbox.setInboxNetworkAllowed(() => true); Inbox.setInboxCenterContactPort(null); Inbox.stopAutoFetch(); vi.useRealTimers(); });
let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;

beforeAll(async () => {
  SQLLIB = await initSqlJs({ locateFile: file => path.resolve(process.cwd(), "node_modules/sql.js/dist", file) });
});

beforeEach(() => {
  Object.values(log).forEach(mock => mock.mockClear());
  const raw: SqlJsDatabase = new SQLLIB.Database();
  h.raw = raw;
  raw.run(BASE_SCHEMA_SQL);
  raw.run(INBOX_TODO_DDL);
  raw.run('ALTER TABLE inbox_messages ADD COLUMN intent TEXT');
  h.db = drizzle(raw, { schema });
  h.db.insert(emailAccounts).values({ email: "sales@example.com", encryptedPass: "x", imapHost: "imap.example.com", imapPort: 993, isActive: 1 }).run();
  Inbox.setImapFetchFn(async () => ({ success: true, data: [] }));
});

describe('收件箱待办批量状态', () => {
  it('批量标记待办且重复请求保持幂等', () => {
    for (const id of [810001, 810002]) {
      h.db.insert(schema.inboxMessages).values({ id, accountId: 1, messageId: `todo-${id}`, fromEmail: 'buyer@example.test', classification: 'replied', receivedAt: '2026-10-14T00:00:00Z' }).run();
    }
    const input = { messageIds: [810001, 810002, 810001], state: 'done' as const, idempotencyKey: 'batch-request-1' };

    expect(Inbox.setInboxTodoStateBatch(input)).toEqual({ success: true, data: { updated: 2, state: 'done' } });
    expect(Inbox.setInboxTodoStateBatch(input)).toEqual({ success: true, data: { updated: 2, state: 'done' } });

    const rows: Array<{ messageId: number; state: string }> = [];
    const statement = h.raw.prepare('SELECT message_id AS messageId,state FROM inbox_todo_states ORDER BY message_id');
    while (statement.step()) rows.push(statement.getAsObject() as { messageId: number; state: string });
    statement.free();
    expect(rows).toEqual([
      { messageId: 810001, state: 'done' },
      { messageId: 810002, state: 'done' },
    ]);
  });
});

describe("手动抓取收件箱", () => {
  it('没有启用的收信账号时直接返回可操作提示，不发起协议抓取', async () => {
    const fetch = vi.fn(async () => ({ success: true as const, data: [] }));
    Inbox.setImapFetchFn(fetch);
    h.raw.run('DELETE FROM email_accounts');

    expect(await Inbox.refreshInbox()).toEqual({
      success: false,
      error: '没有可收取的邮箱账号，请先在设置中添加并启用收发信账号',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves an unmatched correction stream pending without blocking another message or crossing account scope',async()=>{
    let userId='actor-a';const center={contactId:7,customerId:'customer-center',email:'buyer@buyer.example'} as import('../../src/shared/online-crm').CenterContact;
    const stored=vi.fn(async()=>({success:true as const,data:undefined}));
    Inbox.setInboxCenterContactPort({context:()=>({baseUrl:'https://center.example.test',userId}),findByEmail:(_ctx,email)=>email===center.email?[center]:[],storeMail:stored});
    for(const [id,email] of [[700004,'missing@example.test'],[700005,center.email!]] as const)h.db.insert(schema.inboxMessages).values({id,accountId:1,messageId:`mail-${id}`,fromEmail:email,to:'sales@example.com',classification:'other',receivedAt:'2026-10-14T00:00:00Z'}).run();
    Inbox.classifyMessage(700004,'autoreply');Inbox.classifyMessage(700004,'other');Inbox.classifyMessage(700005,'replied');
    await Inbox.replayInboxCenterClassificationChanges();
    expect(h.db.select().from(schema.inboxClassificationChanges).all().map(row=>row.status)).toEqual(['pending','pending','queued']);
    stored.mockClear();userId='actor-b';
    expect((await Inbox.replayInboxCenterClassificationChanges()).success).toBe(true);expect(stored).not.toHaveBeenCalled();
  });
  it('persists IMAP seen writeback until the server acknowledges it', () => {
    h.db.insert(schema.inboxMessages).values({ id: 91, accountId: 1, messageId: 'persistent-seen-message', fromEmail: 'sender@example.test', receivedAt: '2026-11-12T00:00:00Z', isRead: 0 }).run();
    expect(Inbox.markRead(91).success).toBe(true);
    expect(Inbox.listPendingSeen(1)).toEqual([{ messageId: 'persistent-seen-message' }]);
    Inbox.failPendingSeen(1, 'persistent-seen-message', 'temporary network failure');
    expect(Inbox.pendingSeenMessageIds(1).has('persistent-seen-message')).toBe(true);
    Inbox.ackPendingSeen(1, 'persistent-seen-message');
    expect(Inbox.listPendingSeen(1)).toEqual([]);
  });
  it('does not let an older automatic match overwrite a later manual classification',async()=>{
    const context={baseUrl:'https://center.example.test',userId:'actor-a'};
    const center={contactId:7,customerId:'customer-center',email:'buyer@buyer.example'} as import('../../src/shared/online-crm').CenterContact;
    let release!:()=>void;const started=new Promise<void>(resolve=>{release=resolve;});
    let finish!:()=>void;const gate=new Promise<{success:true;data:undefined}>(resolve=>{finish=()=>resolve({success:true,data:undefined});});
    const storeMail=vi.fn().mockImplementationOnce(()=>{release();return gate;}).mockResolvedValue({success:true,data:undefined});
    Inbox.setInboxCenterContactPort({context:()=>context,findByEmail:()=>[center],storeMail});
    h.db.insert(schema.inboxMessages).values({id:700003,accountId:1,messageId:'stale-classification',fromEmail:center.email!,to:'sales@example.com',classification:'other',receivedAt:'2026-10-14T00:00:00Z'}).run();
    const automatic=Inbox.syncInboxCenterMessage(700003,{classify:()=> 'replied'});await started;
    Inbox.classifyMessage(700003,'other');await Inbox.replayInboxCenterClassificationChanges();finish();
    expect(await automatic).toMatchObject({success:true,data:{classification:'other'}});
    expect(h.db.select().from(schema.inboxMessages).get()?.classification).toBe('other');
  });
  it('persists rapid manual correction intents, survives a stopped replay and keeps other manual through rescans',async()=>{
    const context={baseUrl:'https://center.example.test',userId:'actor-a'};
    const center={contactId:7,customerId:'customer-center',email:'buyer@buyer.example'} as import('../../src/shared/online-crm').CenterContact;
    let blocked=true;const events:import('../../server/core/contact-mail').ContactMailEventInput[]=[];
    const port={context:()=>context,findByEmail:()=>[center],storeMail:vi.fn(async(_ctx:unknown,input:any)=>{if(blocked)return {success:false as const,error:'offline'};events.push(input.event);return {success:true as const,data:undefined};})};
    Inbox.setInboxCenterContactPort(port);
    h.db.insert(schema.inboxMessages).values({id:700002,accountId:1,messageId:'manual-corrections',fromEmail:center.email!,to:'sales@example.com',classification:'replied',receivedAt:'2026-10-14T00:00:00Z'}).run();
    expect(Inbox.classifyMessage(700002,'autoreply').success).toBe(true);
    expect(Inbox.classifyMessage(700002,'other').success).toBe(true);
    expect(Inbox.classifyMessage(700002,'autoreply').success).toBe(true);
    expect(Inbox.classifyMessage(700002,'sent').success).toBe(false);
    await Inbox.replayInboxCenterClassificationChanges();
    expect(h.db.select().from(schema.inboxClassificationChanges).all().map(row=>row.status)).toEqual(['pending','pending','pending']);
    blocked=false;Inbox.setInboxCenterContactPort(null);Inbox.setInboxCenterContactPort(port);
    expect((await Inbox.replayInboxCenterClassificationChanges()).success).toBe(true);
    expect(events.map(event=>event.correction?.classification)).toEqual(['autoreply','other','autoreply']);
    expect(new Set(events.map(event=>event.eventKey)).size).toBe(3);
    expect(events.every(event=>event.occurredAt==='2026-10-14T00:00:00Z')).toBe(true);
    Inbox.classifyMessage(700002,'other');await Inbox.replayInboxCenterClassificationChanges();
    await Inbox.reconcileInboxCenterContacts();
    expect(h.db.select().from(schema.inboxMessages).get()?.classification).toBe('other');
    expect(events.filter(event=>event.correction).at(-1)?.correction?.classification).toBe('other');
    expect(h.db.select().from(schema.inboxClassificationChanges).all().every(row=>row.status==='queued')).toBe(true);
  });
  it('does not create ordinary mail facts when repeatedly scanning a manually classified message',async()=>{
    const context={baseUrl:'https://center.example.test',userId:'actor-a'};
    const center={contactId:7,customerId:'customer-center',email:'buyer@buyer.example'} as import('../../src/shared/online-crm').CenterContact;
    const facts=new Map<string,unknown>();
    const storeMail=vi.fn(async(_ctx:unknown,input:any)=>{if(input.recordEvent!==false)facts.set(input.event.eventKey,input.event);return {success:true as const,data:undefined};});
    Inbox.setInboxCenterContactPort({context:()=>context,findByEmail:()=>[center],storeMail});
    h.db.insert(schema.inboxMessages).values({id:700006,accountId:1,messageId:'manual-no-new-facts',fromEmail:center.email!,to:'sales@example.com',classification:'replied',receivedAt:'2026-10-14T00:00:00Z'}).run();
    Inbox.classifyMessage(700006,'other');await Inbox.replayInboxCenterClassificationChanges();
    expect(facts.size).toBe(1);
    await Inbox.reconcileInboxCenterContacts();await Inbox.reconcileInboxCenterContacts();
    expect(facts.size).toBe(1);expect(h.db.select().from(schema.inboxMessages).get()?.classification).toBe('other');
  });
  it('persists center sender metadata after IMAP storage without touching same-number local contacts', async () => {
    h.db.insert(schema.companies).values({ id: 1, name: 'Unrelated legacy company' }).run();
    h.db.insert(schema.contacts).values({ id: 7, companyId: 1, email: 'unrelated@local.example', status: 'pending' }).run();
    const center = { contactId: 7, customerId: 'customer-center', email: 'buyer@buyer.example', companyName: 'Center company', status: 'pending', tags: [] } as import('../../src/shared/online-crm').CenterContact;
    const stored = vi.fn(async () => ({ success: true as const, data: undefined }));
    const context = { baseUrl: 'https://center.example.test', userId: 'actor-a' };
    Inbox.setInboxCenterContactPort({ context: () => context, contacts: () => [center], findByEmail: (_ctx, email) => email === center.email ? [center] : [], storeMail: stored });
    Inbox.setImapFetchFn(async () => {
      h.db.insert(schema.inboxMessages).values({ id: 700001, accountId: 1, messageId: 'synthetic-center-regression', fromEmail: 'buyer@buyer.example', to: 'sales@example.com', classification: 'other', subject: 'Business update', bodyPreview: 'Short synthetic preview', receivedAt: '2026-10-14T00:00:00Z' }).run();
      return { success: true, data: h.db.select().from(schema.inboxMessages).all() };
    });
    const fetched = await Inbox.fetchInbox();
    expect(fetched).toMatchObject({ success: true, data: [{ classification: 'replied', matchedContactId: null, relatedContactIds: null }] });
    expect(stored).toHaveBeenCalledWith(context, expect.objectContaining({ localMessageId: 700001, event: expect.objectContaining({ contactId: 7, customerId: 'customer-center', kind: 'replied' }) }));
    expect(h.db.select().from(schema.contacts).all()[0]?.status).toBe('pending');
    expect(h.db.select().from(schema.interactions).all()).toEqual([]);
    const matchList = await Inbox.listInboxCenterMatchContacts();
    expect(matchList).toMatchObject({ success: true, data: [{ id: 7, centerReference: { contactId: 7, customerId: 'customer-center' } }] });
    Inbox.classifyMessage(700001, 'other');
    await vi.waitFor(() => expect(stored.mock.calls.at(-1)?.[1].event.kind).toBe('received'));
    expect(h.db.select().from(schema.contacts).all()[0]?.status).toBe('pending');
  });
  it('reconciles old persisted mail in bounded pages and refuses center list fallback without an active identity', async () => {
    const context = { baseUrl: 'https://center.example.test', userId: 'actor-a' };
    const center = { contactId: 7, customerId: 'customer-center', email: 'buyer@buyer.example' } as import('../../src/shared/online-crm').CenterContact;
    const stored = vi.fn(async () => ({ success: true as const, data: undefined }));
    Inbox.setInboxCenterContactPort({ context: () => context, findByEmail: () => [center], storeMail: stored });
    for (const id of [100, 101, 102]) h.db.insert(schema.inboxMessages).values({ id, accountId: 1, messageId: `synthetic-history-${id}`, fromEmail: 'buyer@buyer.example', classification: 'other', receivedAt: '2026-10-14T00:00:00Z' }).run();
    const page = await Inbox.reconcileInboxCenterContacts({ limit: 2 });
    expect(page).toEqual({ success: true, data: { processed: 2, nextAfterId: 101, hasMore: true } });
    expect(await Inbox.reconcileInboxCenterContacts({ limit: 2, afterId: 101 })).toEqual({ success: true, data: { processed: 1, nextAfterId: 102, hasMore: false } });
    expect(stored).toHaveBeenCalledTimes(3);
    expect(stored.mock.calls.map(call => call[1].event.kind)).toEqual(['replied', 'replied', 'replied']);
    expect(h.db.select().from(schema.inboxMessages).all().map(row => row.classification)).toEqual(['replied', 'replied', 'replied']);
    expect(await Inbox.reconcileInboxCenterContacts({ limit: 501 })).toMatchObject({ success: false });
    Inbox.setInboxCenterContactPort({ context: () => null, findByEmail: () => [], storeMail: stored });
    expect(await Inbox.listInboxCenterMatchContacts()).toMatchObject({ success: false });
  });
  it('keeps the same Message-ID and bounce in separate mailboxes while deduplicating within one mailbox', () => {
    h.db.insert(emailAccounts).values({ id: 2, email: 'second@example.com', encryptedPass: 'fixture' }).run();
    for (const [id, accountId] of [[100, 1], [101, 1], [102, 2]]) {
      h.db.insert(schema.inboxMessages).values({ id, accountId, messageId: 'same-mail-two-mailboxes', fromEmail: 'sender@example.test', classification: 'other', receivedAt: '2020-01-01T00:00:00Z' }).run();
    }
    for (const [id, accountId] of [[200, 1], [201, 1], [202, 2]]) {
      h.db.insert(schema.inboxMessages).values({ id, accountId, messageId: `bounce-${id}`, fromEmail: 'postmaster@example.test', classification: 'bounce', subject: 'Same NDR subject', receivedAt: '2020-01-02T00:00:00Z' }).run();
    }
    Inbox.cleanupInbox();
    expect(h.db.select({ id: schema.inboxMessages.id }).from(schema.inboxMessages).all().map(row => row.id)).toEqual([100, 102, 200, 202]);
  });
  it('offline manual/automatic refresh and uncached body reads never call IMAP', async () => {
    const fetch = vi.fn(async () => ({ success: true as const, data: [] }));
    const body = vi.fn(async () => ({ success: true as const, data: 'remote' }));
    const deep = vi.fn(async () => 0);
    Inbox.setImapFetchFn(fetch);
    Inbox.setImapFetchBodyFn(body);
    Inbox.setPostFetchAdapters({ isPop3Port: () => false, backfillBounceDeep: deep, detectSent: deep });
    Inbox.setInboxNetworkAllowed(() => false);
    h.db.insert(schema.inboxMessages).values({ id: 987654321, accountId: 1, messageId: 'synthetic-offline-body', fromEmail: 'synthetic@example.test', receivedAt: '2026-10-12T00:00:00Z', bodyPreview: 'cached preview' }).run();
    expect(await Inbox.getBody(987654321)).toEqual({ success: true, data: 'cached preview' });
    expect(await Inbox.refreshInbox()).toMatchObject({ success: false });
    await Inbox.prefetchRecentBodies();
    vi.useFakeTimers();
    Inbox.startAutoFetch(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
    expect(deep).not.toHaveBeenCalled();
  });
  it("仍会在返回列表后触发退信深补和 Sent 探测", async () => {
    const backfillBounceDeep = vi.fn(async () => 0);
    const detectSent = vi.fn(async () => 0);
    Inbox.setPostFetchAdapters({ isPop3Port: () => false, backfillBounceDeep, detectSent });

    const result = await Inbox.refreshInbox();
    await vi.waitFor(() => expect(backfillBounceDeep).toHaveBeenCalledOnce());

    expect(result.success).toBe(true);
    expect(detectSent).toHaveBeenCalledOnce();
  });

  it("退信深补仍在运行时不会阻塞拉取结果，且十分钟内重复拉取不重跑", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const backfillBounceDeep = vi.fn(async () => { await gate; return 0; });
    const detectSent = vi.fn(async () => 0);
    Inbox.setPostFetchAdapters({ isPop3Port: () => false, backfillBounceDeep, detectSent });

    const first = await Inbox.refreshInbox();
    expect(first.success).toBe(true);
    await vi.waitFor(() => expect(backfillBounceDeep).toHaveBeenCalledOnce());

    const second = await Inbox.refreshInbox();
    expect(second.success).toBe(true);
    expect(backfillBounceDeep).toHaveBeenCalledOnce();
    expect(detectSent).toHaveBeenCalledOnce();

    release();
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it("全部收信账号失败时返回真实错误，并停止本轮收信后处理", async () => {
    const backfillBounceDeep = vi.fn(async () => 0);
    const detectSent = vi.fn(async () => 0);
    const health: unknown[] = [];
    Inbox.setPostFetchAdapters({ isPop3Port: () => false, backfillBounceDeep, detectSent });
    Inbox.setInboxPushFn((channel, data) => { if (channel === 'inbox:health') health.push(data); });
    Inbox.setImapFetchFn(async () => ({ success: false as const, error: 'IMAP 登录失败：邮箱服务商拒绝了该账号。' }));

    const result = await Inbox.refreshInbox();

    expect(result).toEqual({ success: false, error: 'IMAP 登录失败：邮箱服务商拒绝了该账号。' });
    expect(backfillBounceDeep).not.toHaveBeenCalled();
    expect(detectSent).not.toHaveBeenCalled();
    expect(health).toHaveLength(1);
    expect(h.db.select().from(emailAccounts).get()).toMatchObject({
      fetchFailCount: 1,
      lastFetchError: 'IMAP 登录失败：邮箱服务商拒绝了该账号。',
    });
  });

  it("自动抓取失败时记录真实错误并停止后续同步", async () => {
    Inbox.setImapFetchFn(async () => ({ success: false as const, error: 'IMAP 登录失败：邮箱服务商拒绝了该账号。' }));

    Inbox.startAutoFetch(60_000);

    await vi.waitFor(() => {
      expect(log.warn).toHaveBeenCalledWith("inbox.auto", "自动抓取失败：IMAP 登录失败：邮箱服务商拒绝了该账号。");
    });
  });

  it('automatic fetch emits a complete phase so the inbox does not remain in background fetching', async () => {
    const phases: string[] = [];
    Inbox.setInboxPushFn((channel, data) => {
      if (channel === 'inbox:fetchProgress') phases.push((data as { phase: string }).phase);
    });

    Inbox.startAutoFetch(60_000);

    await vi.waitFor(() => expect(phases.at(-1)).toBe('complete'));
  });

  it("跳过仅发信账号，不触发抓取、退信深补或 Sent 探测", async () => {
    h.db.insert(emailAccounts).values({ email: "send-only@example.com", encryptedPass: "x", isActive: 1 }).run();
    const fetch = vi.fn(async () => ({ success: true as const, data: [] }));
    const backfillBounceDeep = vi.fn(async () => 0);
    const detectSent = vi.fn(async () => 0);
    Inbox.setImapFetchFn(fetch);
    Inbox.setPostFetchAdapters({ isPop3Port: () => false, backfillBounceDeep, detectSent });

    await Inbox.refreshInbox();
    await vi.waitFor(() => expect(backfillBounceDeep).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledOnce();
    expect(detectSent).toHaveBeenCalledOnce();
    const accounts = h.db.select().from(emailAccounts).all();
    expect(accounts.find(a => a.email === "send-only@example.com")?.fetchFailCount).toBe(0);

    await Inbox.fetchInbox(accounts.find(a => a.email === "send-only@example.com")!.id);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
