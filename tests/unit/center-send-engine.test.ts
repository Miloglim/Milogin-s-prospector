import { describe, it, expect, vi, beforeAll } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as path from "path";
import * as schema from "../../src/main/db/schema";

// ═══════════════════════════════════════════════════════════════
// 中断批次启动确认（P0-01）：
//   · 批次真实启动时写 config.runningBatch、结束/取消时清除；
//   · 退出/崩溃后标志残留 → 启动只认领标记，绝不自动外发；
//   · 用户确认后才由主进程调用 resumeQueue(batchId) 恢复原批次；
//   · 两步式手动入队（autoStart=false）不写标志 → 重启不被误自动启动。
//   dryRun 配置下 runBatchLoop 首轮无 await，同步跑完 —— 断言确定性有保障。
// ═══════════════════════════════════════════════════════════════

type Driz = ReturnType<typeof drizzle<typeof schema>>;
const h = { db: null as unknown as Driz, cfg: null as Record<string, unknown>, persistFails: false };

vi.mock("../../src/main/db", () => ({
  getDb: () => h.db,
  saveDatabase: () => {},
  getRawDb: () => ({
    prepare: (_sql: string) => ({ all: () => [], get: () => null }),
    transaction: (fn: () => void) => () => { if (h.persistFails) throw Error('synthetic disk failure'); return fn(); },
  }),
}));
vi.mock("../../src/main/config", () => ({
  DEFAULT_SCHEDULE: { timeWindowEnabled: true, startHour: 9, endHour: 8, groupSize: 20, groupDelayMinSeconds: 0, groupDelayMaxSeconds: 0 },
  loadConfig: () => h.cfg,
  saveConfig: () => {},
  APP_ROOT: "/tmp/sandbox",
  DB_PATH: "/tmp/sandbox/db",
  getResourcesRoot: () => "/tmp/sandbox/assets",
}));
vi.mock("../../src/main/logger", () => ({
  Log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock("../../src/main/services/inbox.service", () => ({
  writeBodyForLastInsert: async () => {},
}));

const DDL = `
CREATE TABLE email_accounts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE, provider text DEFAULT 'smtp' NOT NULL,
  smtp_host text, smtp_port integer, imap_host text, imap_port integer,
  encrypted_pass text NOT NULL, display_name text, signature text,
  consecutive_fails integer DEFAULT 0 NOT NULL,
  circuit_open_at text, circuit_reset_after text, circuit_reason text,
  last_fetch_error text, last_fetch_at text, fetch_fail_count integer DEFAULT 0 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE send_queue (
  id text PRIMARY KEY NOT NULL, batch_id text NOT NULL, campaign_id text,
  company_name text, company_id integer, recipients text NOT NULL,
  account_id integer NOT NULL, account_email text,
  subject text, tpl_body text, contact_vars text,
  send_mode text DEFAULT 'bcc' NOT NULL,
  status text DEFAULT 'pending' NOT NULL, error text, error_kind text, sent_at text,
  tpl_name text, country text, language text, cc text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
`;

let SQLLIB: Awaited<ReturnType<typeof initSqlJs>>;
type SendService = typeof import("../../src/main/services/send.service");
let S: SendService;

/** 模拟一次干净重启：全新内存库 + 全新 send.service 模块实例 */
async function restartWith(opts: {
  rows: Array<{ id: string; status: string }>;
  runningBatch?: { batchId: string; startedAt: string } | null;
}): Promise<void> {
  h.persistFails = false;
  const raw = new SQLLIB.Database();
  raw.run(DDL);
  h.db = drizzle(raw, { schema });
  h.cfg = {
    fromName: "Sandbox", schedule: { timeWindowEnabled: true, startHour: 9, endHour: 8, groupSize: 20, groupDelayMinSeconds: 0, groupDelayMaxSeconds: 0 },
    test: { email: "self@test.local", company: "Test Co", enabled: true, dryRun: true },
    crm: { followupDays: {}, todoAdvanceDays: 2, autoArchiveDays: 30 },
    sendQuota: { dailyLimit: 0, firstSendAt: null, sentToday: 0 },
    runningBatch: opts.runningBatch ?? null,
  };
  const db = h.db;
  db.insert(schema.emailAccounts).values({ email: "sender@test.local", encryptedPass: "x" } as never).run();
  for (const r of opts.rows) {
    db.insert(schema.sendQueue).values({
      id: r.id, batchId: "batch-ab12cd34",
      recipients: JSON.stringify([{ contactId: 1, email: "a@b.c", name: "A" }]),
      accountId: 1, status: r.status, createdAt: new Date().toISOString(),
    }).run();
  }
  vi.resetModules();
  S = await import("../../src/main/services/send.service");
  S.setSaveConfigFn(c => { h.cfg = c as Record<string, unknown>; }); // 与生产 registerSendIPC 同款注入
}

beforeAll(async () => {
  if (!SQLLIB) SQLLIB = await initSqlJs({ locateFile: f => path.resolve(process.cwd(), "node_modules/sql.js/dist", f) });
});


const centerRow = { id: 1, centerReference: { contactId: 1, customerId: 'center-customer' }, centerScope: 'scope-A', companyId: 1, companyName: 'CENTER COMPANY', email: 'center@example.test', firstName: 'Center', lastName: 'Contact', language: 'EN', stage: 'cold', country: null, title: null, phone: null };
const ref = { contactId: 1, customerId: 'center-customer' };
async function centerPort(denied = false, recordFails = false, rows = false) {
  const C = await import('../../src/main/services/center-send.service');
  const authorize = vi.fn(async () => denied ? { success: false as const, error: 'revoked' } : { success: true as const, data: undefined });
  const record = vi.fn(async () => recordFails ? { success: false as const, error: 'sync offline' } : { success: true as const, data: undefined });
  C.setCenterSendPort({ contacts: () => ({ success: true, data: rows ? [centerRow as never] : [] }), authorize, record,
    stats: () => ({ success: true, data: { neverIds: rows ? [1] : [101], lastSent: [], inCampaign: [] } }), lastAccounts: () => new Map() });
  return { authorize, record };
}
function markCenter(status = 'pending') {
  h.db.update(schema.sendQueue).set({ status, recipients: JSON.stringify([{ contactId: 1, email: 'center@example.test', name: 'Center', centerReference: ref }]), contactVars: JSON.stringify({ __centerScope: 'scope-A' }) }).run();
}
async function settle() { await vi.advanceTimersByTimeAsync(20); }
describe('explicit center sending identity', () => {
  it('does not report enqueue success or retain a ghost batch when queue persistence fails', async () => {
    await restartWith({ rows: [] }); await centerPort(false, false, true);
    const queue = S.buildDynamicQueue([1], 'Hello', 'Body', undefined, undefined, [ref]);
    expect(queue.success).toBe(true); if (!queue.success) throw Error(queue.error);
    const before = S.getSendStatus(); h.persistFails = true;
    expect(await S.startQueue(queue.data, false)).toMatchObject({ success: false, error: expect.stringContaining('保存') });
    expect(S.getSendStatus()).toEqual(before);
    expect(h.db.select().from(schema.sendQueue).all()).toEqual([]);
  });
  it('records no sent facts when SMTP accepts only CC and rejects every selected center recipient', async () => {
    await restartWith({ rows: [{ id: 'none-accepted', status: 'pending' }] }); markCenter();
    (h.cfg.test as { dryRun: boolean }).dryRun = false; const port = await centerPort();
    const smtp = vi.fn(async () => ({ success: true as const, data: { messageId: 'cc-only', accepted: ['cc@example.test'], rejected: [centerRow.email] } })); S.setSendBccFn(smtp);
    vi.useFakeTimers(); try { S.resumeQueue(); await settle(); expect(smtp).toHaveBeenCalledOnce(); expect(port.record).not.toHaveBeenCalled(); expect(h.db.select().from(schema.sendQueue).all()[0]?.status).toBe('failed'); }
    finally { S.cancelSend(); await settle(); vi.useRealTimers(); }
  });
  it('records only actually accepted center BCC recipients and keeps the group sent without resending the rejected subset', async () => {
    await restartWith({ rows: [{ id: 'partial', status: 'pending' }] }); markCenter();
    h.db.update(schema.sendQueue).set({ recipients: JSON.stringify([{ contactId: 1, email: centerRow.email, name: 'One', centerReference: ref }, { contactId: 2, email: 'rejected@example.test', name: 'Two', centerReference: { contactId: 2, customerId: 'customer-two' } }]) }).run();
    (h.cfg.test as { dryRun: boolean }).dryRun = false; const port = await centerPort();
    const smtp = vi.fn(async () => ({ success: true as const, data: { messageId: 'partial-accepted', accepted: [centerRow.email.toUpperCase()], rejected: ['rejected@example.test'] } })); S.setSendBccFn(smtp);
    vi.useFakeTimers(); try {
      S.resumeQueue(); await settle(); expect(smtp).toHaveBeenCalledOnce();
      expect(port.record).toHaveBeenCalledWith(expect.objectContaining({ recipients: [expect.objectContaining({ centerReference: ref })], advanceSendStage: true }));
      expect(h.db.select().from(schema.sendQueue).all()[0]).toMatchObject({ status: 'sent', error: expect.stringContaining('1/2') });
      expect(S.resumeQueue()).toMatchObject({ success: false });
    } finally { S.cancelSend(); await settle(); vi.useRealTimers(); }
  });
  it('does not record a quick recipient rejected while only its CC was accepted', async () => {
    await restartWith({ rows: [] }); (h.cfg.test as { dryRun: boolean }).dryRun = false; const port = await centerPort(false, false, true);
    S.setSendBccFn(async () => ({ success: true, data: { messageId: 'only-cc', accepted: ['cc@example.test'], rejected: [centerRow.email] } }));
    expect(await S.sendTestMessage({ to: centerRow.email, accountId: 1, centerReference: ref })).toMatchObject({ success: false });
    expect(port.record).not.toHaveBeenCalled();
  });
  it('makes quick accepted receipt persistence failure visible without suggesting resend', async () => {
    await restartWith({ rows: [] }); (h.cfg.test as { dryRun: boolean }).dryRun = false; await centerPort(false, true, true);
    S.setSendBccFn(async () => ({ success: true, data: { messageId: 'quick-confirmed' } }));
    expect(await S.sendTestMessage({ to: centerRow.email, accountId: 1, centerReference: ref })).toMatchObject({ success: false, error: expect.stringContaining('请勿重复发送') });
  });
  it('preserves the existing pause between center recipient groups', async () => {
    await restartWith({ rows: [{ id: 'one', status: 'pending' }, { id: 'two', status: 'pending' }] }); markCenter();
    (h.cfg.test as { dryRun: boolean }).dryRun = false;
    Object.assign(h.cfg.schedule as object, { groupDelayMinSeconds: 5, groupDelayMaxSeconds: 5 });
    await centerPort(); const smtp = vi.fn(async () => ({ success: true as const, data: { messageId: 'accepted' } })); S.setSendBccFn(smtp);
    vi.useFakeTimers();
    try { S.resumeQueue(); await settle(); expect(smtp).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(2000); expect(smtp).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(4000); expect(smtp).toHaveBeenCalledTimes(2); }
    finally { S.cancelSend(); await settle(); vi.useRealTimers(); }
  });
  it('account cleanup during in-flight SMTP records its accepted receipt without mutating the replacement account queue', async () => {
    await restartWith({ rows: [{ id: 'accepted-old', status: 'pending' }] }); markCenter();
    (h.cfg.test as { dryRun: boolean }).dryRun = false; const port = await centerPort();
    const oldDb = h.db; let accept!: (v: { success: true; data: { messageId: string } }) => void;
    S.setSendBccFn(() => new Promise(resolve => { accept = resolve; }));
    vi.useFakeTimers();
    try {
      S.resumeQueue(); await settle(); S.cleanupSendEngine();
      const replacement = new SQLLIB.Database(); replacement.run(DDL); h.db = drizzle(replacement, { schema });
      h.db.insert(schema.sendQueue).values({ id: 'accepted-old', batchId: 'new-account', recipients: '[]', accountId: 1, status: 'pending' }).run();
      accept({ success: true, data: { messageId: 'old-account-accepted' } }); await settle();
      expect(port.record).toHaveBeenCalledOnce(); expect(oldDb.select().from(schema.sendQueue).all()[0]?.status).toBe('sent');
      expect(h.db.select().from(schema.sendQueue).all()[0]?.status).toBe('pending');
    } finally { S.cancelSend(); await settle(); vi.useRealTimers(); }
  });
  it('legacy bucket display reads the active center source without accessing local contacts', async () => {
    await restartWith({ rows: [] }); await centerPort(false, false, true);
    expect(S.getTimeBuckets().data?.find(b => b.key === 'never')?.contacts).toEqual([{ id: 1 }]);
    expect(S.getStageBuckets().data?.find(b => b.key === 'cold')?.contacts).toEqual([{ id: 1 }]);
    expect(S.getSendTimeBuckets().success).toBe(true);
  });
  it('all builders use exact center identity and center company variables without legacy tables', async () => {
    await restartWith({ rows: [] }); await centerPort(false, false, true);
    for (const result of [S.buildQueue([], [{ subject: '{{company}}', body: 'Body' }], [1], [ref]), S.buildAdaptiveQueue([], [1], [ref]), S.buildDynamicQueue([1], '{{company}}', 'Body', undefined, 'individual', [ref])]) {
      expect(result).toMatchObject({ success: true, data: [expect.objectContaining({ companyName: 'CENTER COMPANY', centerScope: 'scope-A', recipients: [expect.objectContaining({ centerReference: ref })] })] });
    }
  });
  it('quick center sends authorize and record without advancing campaign stage or touching numeric legacy contacts', async () => {
    await restartWith({ rows: [] }); (h.cfg.test as { dryRun: boolean }).dryRun = false;
    const port = await centerPort(false, false, true);
    S.setSendBccFn(async () => ({ success: true, data: { messageId: 'quick-accepted' } }));
    expect(await S.sendTestMessage({ to: centerRow.email, accountId: 1, centerReference: ref, contactId: 999, subject: '{{company}}' })).toMatchObject({ success: true });
    expect(port.authorize).toHaveBeenCalledOnce(); expect(port.record).toHaveBeenCalledWith(expect.objectContaining({ subject: 'CENTER COMPANY', advanceSendStage: false }));
  });
  it('uses the center picker facts rather than local same-number records', async () => {
    await restartWith({ rows: [] }); await centerPort();
    expect(S.getPickerStats()).toEqual({ success: true, data: { neverIds: [101], lastSent: [], inCampaign: [] } });
  });
  it('blocks unresolved explicit refs without looking up numeric legacy ids', async () => {
    await restartWith({ rows: [] }); await centerPort();
    expect(S.buildDynamicQueue([1], 'Subject', 'Body', undefined, undefined, [ref])).toMatchObject({ success: false });
  });
  it('does not turn interrupted center sending into pending', async () => {
    await restartWith({ rows: [{ id: 'unknown', status: 'sending' }] }); markCenter('sending');
    const result = S.getQueueItems(); expect(result.data?.[0]).toMatchObject({ status: 'failed', errorKind: 'blocked', centerScope: 'scope-A' });
    expect(h.db.select().from(schema.sendQueue).all()[0]?.status).toBe('failed');
  });
  it('checks live authority immediately before SMTP and refuses revoked recipients', async () => {
    await restartWith({ rows: [{ id: 'revoked', status: 'pending' }] }); markCenter();
    (h.cfg.test as { dryRun: boolean }).dryRun = false;
    const port = await centerPort(true); const smtp = vi.fn(); S.setSendBccFn(smtp);
    vi.useFakeTimers(); try { S.resumeQueue(); await settle(); expect(port.authorize).toHaveBeenCalledOnce(); expect(smtp).not.toHaveBeenCalled(); expect(h.db.select().from(schema.sendQueue).all()[0]?.status).toBe('failed'); }
    finally { S.cancelSend(); await settle(); vi.useRealTimers(); }
  });
  it('persists sending first, preserves SMTP accepted fact when central recording fails and never retries', async () => {
    await restartWith({ rows: [{ id: 'accepted', status: 'pending' }] }); markCenter();
    (h.cfg.test as { dryRun: boolean }).dryRun = false;
    const port = await centerPort(false, true);
    const smtp = vi.fn(async () => { expect(h.db.select().from(schema.sendQueue).all()[0]?.status).toBe('sending'); return { success: true as const, data: { messageId: 'synthetic-accepted' } }; }); S.setSendBccFn(smtp);
    vi.useFakeTimers(); try { S.resumeQueue(); await settle(); expect(smtp).toHaveBeenCalledOnce(); expect(port.record).toHaveBeenCalledWith(expect.objectContaining({ centerScope: 'scope-A', advanceSendStage: true, messageId: 'synthetic-accepted' })); expect(h.db.select().from(schema.sendQueue).all()[0]?.status).toBe('sent'); expect(S.resumeQueue()).toMatchObject({ success: false }); }
    finally { S.cancelSend(); await settle(); vi.useRealTimers(); }
  });
  it('does not retry ambiguous transport failure for a center queue', async () => {
    await restartWith({ rows: [{ id: 'ambiguous', status: 'pending' }] }); markCenter();
    (h.cfg.test as { dryRun: boolean }).dryRun = false; await centerPort();
    const smtp = vi.fn(async () => ({ success: false as const, error: 'ECONNRESET' })); S.setSendBccFn(smtp);
    vi.useFakeTimers(); try { S.resumeQueue(); await vi.advanceTimersByTimeAsync(20000); expect(smtp).toHaveBeenCalledOnce(); expect(h.db.select().from(schema.sendQueue).all()[0]).toMatchObject({ status: 'failed', errorKind: 'blocked' }); }
    finally { S.cancelSend(); await settle(); vi.useRealTimers(); }
  });
  it('quick center dry-run records no confirmed receipt', async () => {
    await restartWith({ rows: [] }); const port = await centerPort(); const smtp = vi.fn(); S.setSendBccFn(smtp);
    expect(await S.sendTestMessage({ to: 'center@example.test', accountId: 1, centerReference: ref })).toMatchObject({ success: true });
    expect(smtp).not.toHaveBeenCalled(); expect(port.record).not.toHaveBeenCalled();
  });
});

