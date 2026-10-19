import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { SqliteCenterSendReceipts } from '../../src/main/adapters/center-send-receipts.adapter';
import type { CenterSendReceipt } from '../../src/main/services/center-send.service';
import type { SendAuthorization, SendAuthorizationInput } from '../../server/core/send-acceptance';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE email_accounts(id INTEGER PRIMARY KEY,email TEXT,is_active INTEGER);
    INSERT INTO email_accounts VALUES(1,'sender@example.invalid',1);
    CREATE TABLE inbox_messages(id INTEGER PRIMARY KEY,account_id INTEGER,message_id TEXT,from_email TEXT,from_name TEXT,subject TEXT,body_preview TEXT,classification TEXT,"to" TEXT,cc TEXT,my_role TEXT,matched_contact_id INTEGER,is_read INTEGER,received_at TEXT);
    CREATE TABLE send_queue(id TEXT PRIMARY KEY,status TEXT,sent_at TEXT);
    INSERT INTO send_queue VALUES('item-1','sending',NULL);`);
  const raw = { prepare: (sql: string) => db.prepare(sql), exec: (sql: string) => db.exec(sql), transaction: <T>(fn: () => T) => () => { db.exec('BEGIN'); try { const result = fn(); db.exec('COMMIT'); return result; } catch(e) { db.exec('ROLLBACK'); throw e; } } };
  return { db, store: new SqliteCenterSendReceipts(raw) };
}
const scope = JSON.stringify(['http://center.invalid', 'user-1']);
const receipt: CenterSendReceipt = { id:'item-1', centerScope:scope, accountId:1, companyName:'Fixture', subject:'Hello', body:'<p>fixture only</p>', messageId:'smtp-id-1', occurredAt:'2026-10-15T01:00:00.000Z', advanceSendStage:true, recipients:[{contactId:7,email:'customer@example.invalid',name:'Customer',centerReference:{contactId:7,customerId:'customer-uuid'}}] };
const authorizationInput: SendAuthorizationInput = {
  sendKey: receipt.id, fromEmail: 'sender@example.invalid', subject: receipt.subject,
  recipients: [{ contactId: 7, customerId: 'customer-uuid', email: 'customer@example.invalid' }],
};
const grant: SendAuthorization = {
  authorizationId: 'authorization-one', contactId: 7, customerId: 'customer-uuid',
  recipientEmail: 'customer@example.invalid', fromEmail: 'sender@example.invalid', subject: receipt.subject,
  issuedAt: '2026-10-15T00:59:00.000Z', expiresAt: '2026-10-15T01:09:00.000Z',
};

describe('durable send attempt authorizations', () => {
  it('persists exact input and grants before SMTP, with account scope isolation and immutable replay', () => {
    const { db, store } = setup();
    store.recordAuthorization(scope, authorizationInput, [grant]);
    store.recordAuthorization(scope, authorizationInput, [grant]);
    expect(store.authorization(receipt.id, scope)).toEqual({ input: authorizationInput, authorizations: [grant] });
    expect(store.authorization(receipt.id, 'another-scope')).toBeUndefined();
    expect(() => store.recordAuthorization(scope, { ...authorizationInput, subject: 'Changed' }, [grant])).toThrow();
    expect(() => store.recordAuthorization(scope, authorizationInput, [{ ...grant, authorizationId: 'different' }])).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM crm_send_authorizations').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM inbox_messages').get()).toEqual({ n: 0 });
    db.close();
  });

  it('binds a receipt only to the persisted original sender and accepted target grants', () => {
    const { db, store } = setup();
    store.recordAuthorization(scope, authorizationInput, [grant]);
    const authorized = { ...receipt, authorizations: [grant] };
    expect(store.record(authorized).receipt.authorizations).toEqual([grant]);
    expect(() => store.record({ ...authorized, subject: 'Altered' })).toThrow();
    db.close();
  });

  it('rejects missing or mismatched saved grants instead of silently falling back to unproven facts', () => {
    const { db, store } = setup();
    expect(() => store.record({ ...receipt, authorizations: [grant] })).toThrow();
    store.recordAuthorization(scope, authorizationInput, [grant]);
    expect(() => store.record(receipt)).toThrow();
    expect(() => store.record({ ...receipt, authorizations: [{ ...grant, authorizationId: 'forged' }] })).toThrow();
    expect(() => store.record({ ...receipt, authorizations: [grant], cc: 'unapproved@example.invalid' })).toThrow();
    expect(db.prepare('SELECT status FROM send_queue').get()).toEqual({ status: 'sending' });
    db.close();
  });

  it('rejects malformed grants atomically and leaves no authorization to permit SMTP', () => {
    const { db, store } = setup();
    expect(() => store.recordAuthorization(scope, authorizationInput, [])).toThrow();
    expect(() => store.recordAuthorization(scope, authorizationInput, [{ ...grant, recipientEmail: 'changed@example.invalid' }])).toThrow();
    expect(store.authorization(receipt.id, scope)).toBeUndefined();
    db.close();
  });

  it('preserves the original authorized sender if account settings change while SMTP is in flight', () => {
    const { db, store } = setup();
    store.recordAuthorization(scope, authorizationInput, [grant]);
    db.prepare('UPDATE email_accounts SET email=? WHERE id=1').run('new-sender@example.invalid');
    expect(store.record({ ...receipt, authorizations: [grant] }).accountEmail).toBe('sender@example.invalid');
    expect(db.prepare('SELECT from_email FROM inbox_messages').get()).toEqual({ from_email: 'sender@example.invalid' });
    db.close();
  });

  it('retains grants for the SMTP accepted subset without archiving rejected recipients', () => {
    const { db, store } = setup();
    const another = { ...grant, authorizationId: 'authorization-two', contactId: 8, recipientEmail: 'other@example.invalid' };
    store.recordAuthorization(scope, { ...authorizationInput, recipients: [...authorizationInput.recipients, { contactId: 8, customerId: grant.customerId, email: another.recipientEmail }] }, [grant, another]);
    const saved = store.record({ ...receipt, authorizations: [grant] });
    expect(saved.receipt.recipients).toHaveLength(1);
    expect(saved.receipt.authorizations).toEqual([grant]);
    db.close();
  });
});
describe('durable center SMTP receipts', () => {
  it('hides cleared history while retaining pending facts and sender affinity records', () => {
    const {db,store}=setup();store.record(receipt);expect(store.hideHistory(scope)).toBe(1);
    expect(store.history(scope)).toHaveLength(0);expect(store.pending(scope)).toHaveLength(1);
    expect(store.history(scope,true)).toHaveLength(1);db.close();
  });
  it('retains actual CC metadata with the local confirmed source', () => {
    const {db,store}=setup();store.record({...receipt,cc:'colleague@example.invalid'});
    expect(db.prepare('SELECT cc FROM inbox_messages').get()).toEqual({cc:'colleague@example.invalid'});db.close();
  });
  it('atomically records accepted state and mailbox source without a legacy contact FK, preserving body locally', () => {
    const {db,store}=setup(); const saved=store.record(receipt);
    expect(saved.mailIds).toHaveLength(1);
    expect(db.prepare('SELECT status FROM send_queue').get()).toEqual({status:'sent'});
    expect(db.prepare('SELECT from_email,matched_contact_id FROM inbox_messages').get()).toEqual({from_email:'sender@example.invalid',matched_contact_id:null});
    expect(store.pending(scope)[0].receipt.body).toBe(receipt.body);
    db.close();
  });
  it('replays the identical receipt without another mailbox entry and rejects a reused key with different recipients', () => {
    const {db,store}=setup(); const first=store.record(receipt);expect(store.record(receipt)).toEqual(first);
    expect(()=>store.record({...receipt,recipients:[{...receipt.recipients[0],email:'different@example.invalid'}]})).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM inbox_messages').get()).toEqual({n:1}); db.close();
  });
  it('keeps unsynced facts account scoped and only removes pending status after confirmation', () => {
    const {db,store}=setup();store.record(receipt);expect(store.pending('other')).toHaveLength(0);
    store.acknowledge(receipt.id,scope);expect(store.pending(scope)).toHaveLength(0);
    expect(db.prepare('SELECT count(*) AS n FROM crm_send_receipts').get()).toEqual({n:1});db.close();
  });
  it('rolls the queue and mailbox back together if persisting the durable receipt fails', () => {
    const {db,store}=setup();db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON crm_send_receipts BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    expect(()=>store.record(receipt)).toThrow('fixture failure');
    expect(db.prepare('SELECT status FROM send_queue').get()).toEqual({status:'sending'});
    expect(db.prepare('SELECT count(*) AS n FROM inbox_messages').get()).toEqual({n:0});db.close();
  });
});
