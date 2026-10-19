import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { SendAuthorization } from '../../server/core/send-acceptance';
import { SEND_ACCEPTANCE_ROUTES } from '../../server/core/send-acceptance';
import { bindCenterSendRuntime } from '../../src/main/adapters/center-send-runtime.adapter';
import { getCenterSendPort, type CenterSendReceipt } from '../../src/main/services/center-send.service';

const h = vi.hoisted(() => ({ raw: null as any, campaign: vi.fn(), writeBody: vi.fn() }));
vi.mock('../../src/main/db', () => ({ getRawDb: () => h.raw }));
vi.mock('../../src/main/services/inbox.service', () => ({ writeBodyFile: (...args: unknown[]) => h.writeBody(...args) }));
vi.mock('../../src/main/services/campaign.service', () => ({ canSendCenterCampaignItem: (...args: unknown[]) => h.campaign(...args) }));
vi.mock('../../src/main/logger', () => ({ Log: { error: vi.fn(), warn: vi.fn() } }));
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const scope = JSON.stringify(['http://center.invalid', 'user-one']);
const receipt: CenterSendReceipt = {
  id: 'send-one', accountId: 1, centerScope: scope, companyName: 'Test', subject: 'Hello',
  recipients: [{ contactId: 7, email: 'customer@example.invalid', name: 'Customer', centerReference: { contactId: 7, customerId: 'customer-one' } }],
  body: 'Synthetic only', occurredAt: new Date().toISOString(), advanceSendStage: true, messageId: 'smtp-one',
};
const grant = (): SendAuthorization => ({
  authorizationId: 'grant-one', contactId: 7, customerId: 'customer-one', recipientEmail: 'customer@example.invalid',
  fromEmail: 'sender@example.invalid', subject: 'Hello', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
});
function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE email_accounts(id INTEGER PRIMARY KEY,email TEXT);
    INSERT INTO email_accounts VALUES(1,'sender@example.invalid');
    CREATE TABLE inbox_messages(id INTEGER PRIMARY KEY,account_id INTEGER,message_id TEXT,from_email TEXT,from_name TEXT,subject TEXT,body_preview TEXT,classification TEXT,"to" TEXT,cc TEXT,my_role TEXT,matched_contact_id INTEGER,is_read INTEGER,received_at TEXT);
    CREATE TABLE send_queue(id TEXT PRIMARY KEY,status TEXT,sent_at TEXT);`);
  h.raw = { prepare: (sql: string) => db.prepare(sql), exec: (sql: string) => db.exec(sql), transaction: <T>(fn: () => T) => () => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
  let selected: any = { baseUrl: 'http://center.invalid', userId: 'user-one', permissionKey: 'rights-one', active: () => true };
  let online = true;
  const requestLive = vi.fn(async (method: string) => method === 'POST' ? { ok: true, data: [grant()] } : { ok: true, data: { contact: { contactId: 7, customerId: 'customer-one', email: 'customer@example.invalid', canSendMail: true, permissions: { canSendMail: true } } } });
  const mirror = { linkMail: vi.fn(), eventAcknowledged: () => false, saveDetail: vi.fn(), ready: () => true, contacts: () => [], forgetContact: vi.fn() };
  const runtime = bindCenterSendRuntime({ contactReadContext: () => selected, isOnline: () => online, requestLive } as any, mirror as any, vi.fn(), vi.fn());
  return { db, mirror, runtime, port: getCenterSendPort()!, requestLive, select: (value: any) => { selected = value; }, offline: () => { online = false; } };
}
beforeEach(() => { h.campaign.mockReset().mockReturnValue({ success: true, data: undefined }); h.writeBody.mockReset(); });

describe('center send authorization runtime', () => {
  it('registers one grouped attempt after live checks and saves grants before releasing SMTP', async () => {
    const f = setup();
    expect(await f.port.authorize(receipt)).toEqual({ success: true, data: undefined });
    expect(f.requestLive).toHaveBeenNthCalledWith(2, 'POST', SEND_ACCEPTANCE_ROUTES.authorize, {
      sendKey: receipt.id, fromEmail: 'sender@example.invalid', subject: receipt.subject,
      recipients: [{ contactId: 7, customerId: 'customer-one', email: 'customer@example.invalid' }], ccEmails: [],
    });
    expect(f.db.prepare('SELECT count(*) AS n FROM crm_send_authorizations').get()).toEqual({ n: 1 });
    expect((await f.port.record(receipt)).success).toBe(true);
    expect(f.mirror.linkMail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: expect.objectContaining({ sendAuthorizationId: 'grant-one', kind: 'sent' }) }));
    f.runtime.close(); f.db.close();
  });

  it('keeps an in-flight accepted receipt in the originally captured database after account switching', async () => {
    const f = setup(); await f.port.authorize(receipt); f.runtime.close();
    h.raw = { prepare: () => { throw new Error('must not read new account database'); } };
    expect((await f.port.record(receipt)).success).toBe(true);
    const saved = JSON.parse((f.db.prepare('SELECT payload FROM crm_send_receipts').get() as any).payload);
    expect(saved.receipt.authorizations[0].authorizationId).toBe('grant-one');
    expect(f.mirror.linkMail).not.toHaveBeenCalled();
    f.db.close();
  });

  it('stops before SMTP if account context or network changes during authorization response', async () => {
    for (const change of ['identity', 'network']) {
      const f = setup();
      f.requestLive.mockImplementation(async method => {
        if (method !== 'POST') return { ok: true, data: { contact: { contactId: 7, customerId: 'customer-one', email: 'customer@example.invalid', canSendMail: true, permissions: { canSendMail: true } } } } as any;
        if (change === 'identity') f.select(null); else f.offline();
        return { ok: true, data: [grant()] } as any;
      });
      expect((await f.port.authorize(receipt)).success).toBe(false);
      expect(f.db.prepare('SELECT count(*) AS n FROM crm_send_authorizations').get()).toEqual({ n: 0 });
      f.runtime.close(); f.db.close();
    }
  });

  it('keeps pre-send permission reads out of the authoritative contact projection', async () => {
    const f = setup();
    try {
      expect((await f.port.authorize(receipt)).success).toBe(true);
      // A late pre-send read can have old editing rights even though sending is still
      // permitted. Only the guarded contact reader/sync owns mirror updates.
      expect(f.mirror.saveDetail).not.toHaveBeenCalled();
    } finally { f.runtime.close(); f.db.close(); }
  });

  it('does not mint grants for blocked campaigns or silently record a new unproven acceptance', async () => {
    const f = setup(); h.campaign.mockReturnValue({ success: false, error: 'paused' });
    expect((await f.port.authorize(receipt)).success).toBe(false);
    expect(f.requestLive).toHaveBeenCalledTimes(1);
    expect((await f.port.record(receipt)).success).toBe(false);
    expect(f.db.prepare('SELECT count(*) AS n FROM crm_send_receipts').get()).toEqual({ n: 0 });
    f.runtime.close(); f.db.close();
  });

  it('stops when the campaign is paused while awaiting the authorization response', async () => {
    const f = setup();
    f.requestLive.mockImplementation(async method => {
      if (method === 'POST') {
        h.campaign.mockReturnValue({ success: false, error: 'paused during authorization' });
        return { ok: true, data: [grant()] } as any;
      }
      return { ok: true, data: { contact: { contactId: 7, customerId: 'customer-one', email: 'customer@example.invalid', canSendMail: true, permissions: { canSendMail: true } } } } as any;
    });
    expect(await f.port.authorize(receipt)).toEqual({ success: false, error: 'paused during authorization' });
    expect(f.db.prepare('SELECT count(*) AS n FROM crm_send_authorizations').get()).toEqual({ n: 0 });
    f.runtime.close(); f.db.close();
  });

  it('blocks malformed or expired grants and a local authorization write failure', async () => {
    for (const reason of ['target', 'expired', 'sqlite']) {
      const f = setup();
      if (reason === 'sqlite') f.db.exec("CREATE TRIGGER reject_auth BEFORE INSERT ON crm_send_authorizations BEGIN SELECT RAISE(ABORT,'write failure'); END");
      f.requestLive.mockImplementation(async method => method === 'GET'
        ? { ok: true, data: { contact: { contactId: 7, customerId: 'customer-one', email: 'customer@example.invalid', canSendMail: true, permissions: { canSendMail: true } } } } as any
        : { ok: true, data: [{ ...grant(), ...(reason === 'target' ? { recipientEmail: 'wrong@example.invalid' } : reason === 'expired' ? { expiresAt: '2000-01-01T00:00:00.000Z' } : {}) }] } as any);
      expect((await f.port.authorize(receipt)).success).toBe(false);
      expect(f.db.prepare('SELECT count(*) AS n FROM crm_send_authorizations').get()).toEqual({ n: 0 });
      f.runtime.close(); f.db.close();
    }
  });

  it('archives only accepted recipients and replays persisted authorizations after restart without renewed permission reads', async () => {
    const f = setup();
    const second = { ...receipt.recipients[0]!, contactId: 8, email: 'second@example.invalid', centerReference: { contactId: 8, customerId: 'customer-one' } };
    const grouped = { ...receipt, cc: 'Coworker@example.invalid', recipients: [...receipt.recipients, second] };
    const grants = [grant(), { ...grant(), authorizationId: 'grant-two', contactId: 8, recipientEmail: second.email }];
    f.requestLive.mockImplementation(async (method, path) => method === 'POST'
      ? { ok: true, data: grants } as any
      : { ok: true, data: { contact: { contactId: path.includes('/8?') ? 8 : 7, customerId: 'customer-one', email: path.includes('/8?') ? second.email : receipt.recipients[0]!.email, canSendMail: true, permissions: { canSendMail: true } } } } as any);
    expect((await f.port.authorize(grouped)).success).toBe(true);
    expect(f.requestLive.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    expect((await f.port.record({ ...grouped, recipients: receipt.recipients })).success).toBe(true);
    expect(f.mirror.linkMail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ event: expect.objectContaining({ sendAuthorizationId: 'grant-one', toEmails: ['customer@example.invalid'], ccEmails: ['coworker@example.invalid'] }) }));
    f.mirror.linkMail.mockClear(); f.requestLive.mockClear();
    await f.runtime.replay();
    expect(f.requestLive).not.toHaveBeenCalled();
    expect(f.mirror.linkMail).toHaveBeenCalledOnce();
    expect(f.mirror.linkMail.mock.calls[0]![1].event.sendAuthorizationId).toBe('grant-one');
    f.runtime.close(); f.db.close();
  });

  it('never creates retroactive authorization for a historical receipt without a grant', async () => {
    const f = setup();
    await f.runtime.replay();
    f.db.prepare('INSERT INTO crm_send_receipts(send_key,center_scope,payload,mail_ids,recorded_at) VALUES(?,?,?,?,?)')
      .run(receipt.id, scope, JSON.stringify({ receipt, accountEmail: 'sender@example.invalid' }), '[1]', receipt.occurredAt);
    await f.runtime.replay();
    expect(f.requestLive).not.toHaveBeenCalled();
    expect(f.mirror.linkMail.mock.calls[0]![1].event).not.toHaveProperty('sendAuthorizationId');
    expect(f.db.prepare('SELECT count(*) AS n FROM crm_send_authorizations').get()).toEqual({ n: 0 });
    f.runtime.close(); f.db.close();
  });
});
