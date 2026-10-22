import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from 'sql.js';
import { resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import type { CenterContact } from '../../server/core/center-contacts';
import type { CenterContactDetail } from '../../server/core/contact-assignments';
import type { ContactMailEventInput } from '../../server/core/contact-mail';
import type { QueuedContactMailEvent } from '../../src/main/core/contact-mirror';
import { SqliteContactMirrorStore } from '../../src/main/adapters/contact-mirror-store.adapter';
import { contactDetailSnapshot } from '../../src/main/core/contact-mirror';

let SQL: SqlJsStatic;
const databases = new Map<string, SqlDatabase>();
const alice = { baseUrl: 'https://center.test', userId: 'alice' };
const bob = { ...alice, userId: 'bob' };
const otherCenter = { ...alice, baseUrl: 'https://another.test' };
beforeAll(async () => { SQL = await initSqlJs({ locateFile: file => resolve('node_modules/sql.js/dist', file) }); });
afterEach(() => { for (const db of databases.values()) db.close(); databases.clear(); });
function open(ctx: typeof alice): Database {
  const key = JSON.stringify([ctx.baseUrl, ctx.userId]);
  let raw = databases.get(key);
  if (!raw) { raw = new SQL.Database(); databases.set(key, raw); }
  const db = raw;
  return {
    exec: (sql: string) => { db.run(sql); },
    prepare(sql: string) {
      const all = (...args: unknown[]) => {
        const statement = db.prepare(sql);
        try { statement.bind(args as never); const rows: unknown[] = []; while (statement.step()) rows.push(statement.getAsObject()); return rows; }
        finally { statement.free(); }
      };
      return { all, get: (...args: unknown[]) => all(...args)[0], run: (...args: unknown[]) => { db.run(sql, args as never); return { changes: db.getRowsModified() }; } };
    },
    transaction: (fn: () => unknown) => () => { db.run('BEGIN'); try { const value = fn(); db.run('COMMIT'); return value; } catch (error) { db.run('ROLLBACK'); throw error; } },
  } as unknown as Database;
}
function contact(contactId = 7, email: string | null = ' Alice@Example.test '): CenterContact {
  return { contactId, customerId: 'customer-a', customerVersion: 2, contactVersion: 3, companyId: 4, companyName: 'Acme', email,
    firstName: null, lastName: null, title: null, phone: null, linkedinUrl: null, country: null, clientType: null, language: null,
    stage: 'cold', status: '', tags: [], extra: { reminder: 'keep' }, touchStatus: 'uncontacted', assignee: '', source: 'manual', sourceDetail: null,
    createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z', ownerUserId: 'alice', ownerName: null, origin: 'personal', state: 'owned' };
}
function event(eventKey = 'event-1'): ContactMailEventInput {
  return { contactId: 7, customerId: 'customer-a', eventKey, mailboxKey: 'account-inbox', messageKey: 'stable-1', kind: 'received', direction: 'inbound',
    occurredAt: '2026-10-14T00:00:00Z', subject: 'hello', preview: 'summary', fromEmail: 'alice@example.test', toEmails: ['me@example.test'], ccEmails: [] };
}
function link(eventInput:QueuedContactMailEvent = event()) { return { messageKey: 'stable-1', localMailId: 7, mailAccountId: 2, mailbox: 'INBOX', contactId: 7, customerId: 'customer-a', role: 'primary' as const, event: eventInput }; }

describe('account scoped structured contact mirror', () => {
  it.each(['detail','base'] as const)('retires prior commands after %s downgrade or transfer and never revives them on regrant',path=>{
    for(const change of [{canEdit:false},{ownerUserId:'bob'}]){
      const store=new SqliteContactMirrorStore(open),row={...contact(),assignmentStatus:null,canEdit:true};store.replaceContacts(alice,[row]);
      const input={contactId:7,customerId:'customer-a',expectedVersion:3,idempotencyKey:'queued-before-access-change',fields:{firstName:'old intent'}};
      store.putCommand(alice,{id:'contact-command:old',action:'update',input,status:'pending',createdAt:'2026-10-16T00:00:00Z'});
      if(path==='detail'){store.saveDetail(alice,contactDetailSnapshot({...row,...change}));store.saveDetail(alice,contactDetailSnapshot(row));}
      else{store.upsertContacts(alice,[{...row,...change}]);store.upsertContacts(alice,[row]);}
      expect(store.commandRows(alice)[0]).toMatchObject({status:'failed',discardable:true,input});
    }
  });
  it.each(['detail','base'] as const)('ignores stale %s access changes and preserves pending commands on ordinary content updates',path=>{
    const store=new SqliteContactMirrorStore(open),row={...contact(),assignmentStatus:null,canEdit:true};store.replaceContacts(alice,[row]);
    const input={contactId:7,customerId:'customer-a',expectedVersion:3,idempotencyKey:'queued',fields:{firstName:'old intent'}};
    store.putCommand(alice,{id:'contact-command:old',action:'update',input,status:'pending',createdAt:'2026-10-16T00:00:00Z'});
    const save=(value:CenterContact)=>path==='detail'?store.saveDetail(alice,contactDetailSnapshot(value)):store.upsertContacts(alice,[value]);
    save({...row,contactVersion:2,canEdit:false});save({...row,contactVersion:4,title:'current'});
    expect(store.commandRows(alice)[0]).toMatchObject({status:'pending',input});expect(store.contact(alice,row)?.canEdit).toBe(true);
  });
  it('cannot revive old permission commands when the account loses and later regains its role',()=>{
    const store=new SqliteContactMirrorStore(open),sales={...alice,permissionKey:'sales'},viewer={...alice,permissionKey:'viewer'};
    const row={...contact(),assignmentStatus:null,canEdit:true};store.replaceContacts(sales,[row]);
    const input={contactId:7,customerId:'customer-a',expectedVersion:3,idempotencyKey:'local',fields:{firstName:'keep my input'}};
    store.putCommand(sales,{id:'contact-command:local',action:'update',input,status:'pending',createdAt:'2026-10-16T00:00:00Z'});
    store.replaceContacts(viewer,[]);store.replaceContacts(sales,[row]);expect(store.commandRows(sales)[0]).toMatchObject({status:'failed',input});
  });
  it('retires unsent commands on complete removal, retaining payload across regrant',()=>{
    const store=new SqliteContactMirrorStore(open);const row={...contact(),assignmentStatus:null,canEdit:true};store.replaceContacts(alice,[row]);
    const input={contactId:7,customerId:'customer-a',expectedVersion:3,idempotencyKey:'local',fields:{firstName:'keep my input'}};
    store.putCommand(alice,{id:'contact-command:local',action:'update',input,status:'pending',createdAt:'2026-10-16T00:00:00Z'});
    store.replaceContacts(alice,[]);expect(store.commandRows(alice)[0]).toMatchObject({status:'failed',discardable:true,input});
    store.replaceContacts(alice,[row]);expect(store.commandRows(alice)[0]).toMatchObject({status:'failed',input});
  });
  it('keeps downgrade readable and marks affected edits without deleting input',()=>{
    const store=new SqliteContactMirrorStore(open);const row={...contact(),assignmentStatus:null,canEdit:true};store.replaceContacts(alice,[row]);
    const input={contactId:7,customerId:'customer-a',expectedVersion:3,idempotencyKey:'local',fields:{firstName:'keep my input'}};
    store.putCommand(alice,{id:'contact-command:local',action:'update',input,status:'pending',attempted:true,createdAt:'2026-10-16T00:00:00Z'});
    store.replaceContacts(alice,[{...row,canEdit:false}]);expect(store.contact(alice,row)?.canEdit).toBe(false);
    expect(store.commandRows(alice)[0]).toMatchObject({status:'failed',discardable:false,input});
  });
  it('keeps preauthorized sent facts uploadable after a full scan or individual revocation',()=>{
    const store=new SqliteContactMirrorStore(open);
    const sent={...event(),kind:'sent' as const,direction:'outbound' as const,sendAuthorizationId:'grant-one'};
    store.replaceContacts(alice,[contact()]);store.linkMail(alice,link(sent));
    store.replaceContacts(alice,[]);expect(store.pendingEvents(alice)).toEqual([sent]);
    store.forgetContact(alice,contact());expect(store.pendingEvents(alice)).toEqual([sent]);
    expect(store.contacts(alice)).toEqual([]);
  });
  it('upgrades a previously observed Sent fact with its grant and rejects grant substitution',()=>{
    const store=new SqliteContactMirrorStore(open);
    const sent={...event(),kind:'sent' as const,direction:'outbound' as const};
    store.linkMail(alice,link(sent));store.acknowledgeEvent(alice,sent.eventKey,sent);
    const authorized={...sent,sendAuthorizationId:'grant-one'};
    store.linkMail(alice,link(authorized));
    expect(store.pendingEvents(alice)).toEqual([authorized]);
    store.acknowledgeEvent(alice,sent.eventKey,sent);
    expect(store.eventAcknowledged(alice,sent.eventKey)).toBe(false);
    expect(()=>store.linkMail(alice,link({...authorized,sendAuthorizationId:'grant-two',advanceSendStage:true}))).toThrow('授权');
    store.acknowledgeEvent(alice,sent.eventKey,authorized);
    store.linkMail(alice,link(sent));expect(store.eventAcknowledged(alice,sent.eventKey)).toBe(true);
  });
  it('preserves the original IMAP fact separately from actual SMTP time and accepted envelope',()=>{
    const store=new SqliteContactMirrorStore(open);
    const imap={...event(),kind:'sent' as const,direction:'outbound' as const,toEmails:['accepted@test.invalid','rejected@test.invalid']};
    store.linkMail(alice,link(imap));store.acknowledgeEvent(alice,imap.eventKey,imap);
    const actual={...imap,occurredAt:'2026-10-14T00:05:00Z',toEmails:['accepted@test.invalid'],preview:'Actual SMTP body',advanceSendStage:true};
    store.linkMail(alice,link({...actual,sendAuthorizationId:'grant-one'}));
    const expected={...imap,advanceSendStage:true,sendAuthorizationId:'grant-one',smtpAcceptance:actual};
    expect(store.pendingEvents(alice)).toEqual([expected]);
    store.acknowledgeEvent(alice,imap.eventKey,imap);
    expect(store.eventAcknowledged(alice,imap.eventKey)).toBe(false);
    store.linkMail(alice,link(imap));expect(store.pendingEvents(alice)).toEqual([expected]);
  });
  it('persists a serial correction parent chain and replays exact payload after restart',()=>{
    const store=new SqliteContactMirrorStore(open);
    const correction=(key:string,classification:'other'|'autoreply')=>({...event(key),kind:classification==='other'?'received' as const:'autoreply' as const,correction:{previousEventKey:null,classification}});
    store.linkMail(alice,link(correction('change-a','autoreply')));
    store.linkMail(alice,link(correction('change-b','other')));
    store.linkMail(alice,link(correction('change-a','autoreply')));
    const restored=new SqliteContactMirrorStore(open);
    expect(restored.pendingEvents(alice)).toMatchObject([{eventKey:'change-a',correction:{previousEventKey:null}},{eventKey:'change-b',correction:{previousEventKey:'change-a'}}]);
    expect(restored.pendingEvents(bob)).toEqual([]);
  });
  it('upgrades an acknowledged Sent fact to a confirmed SMTP stage receipt without replacing its first metadata', () => {
    const store = new SqliteContactMirrorStore(open);
    const sent = {...event(),kind:'sent' as const,direction:'outbound' as const};
    store.linkMail(alice,link(sent));store.acknowledgeEvent(alice,sent.eventKey);
    expect(store.eventAcknowledged(alice,sent.eventKey)).toBe(true);
    store.linkMail(alice,link({...sent,advanceSendStage:true,preview:'enriched preview',occurredAt:'2026-10-14T00:00:02Z'}));
    expect(store.eventAcknowledged(alice,sent.eventKey)).toBe(false);
    expect(store.pendingEvents(alice)).toEqual([{...sent,advanceSendStage:true}]);
    store.acknowledgeEvent(alice,sent.eventKey,sent);
    expect(store.eventAcknowledged(alice,sent.eventKey)).toBe(false);
    expect(store.pendingEvents(alice)).toHaveLength(1);
    store.acknowledgeEvent(alice,sent.eventKey,{...sent,advanceSendStage:true});
    store.linkMail(alice,link({...sent,advanceSendStage:true}));
    expect(store.eventAcknowledged(alice,sent.eventKey)).toBe(true);
    store.linkMail(alice,link({...sent,occurredAt:'2026-10-14T00:00:03Z'}));
    expect(store.eventAcknowledged(alice,sent.eventKey)).toBe(true);
  });
  it('stores details atomically, rejects stale receipts and prevents cached permissions crossing scope', () => {
    const store = new SqliteContactMirrorStore(open);
    const scoped = { ...alice, permissionKey: 'sales' };
    const row = { ...contact(), assignmentStatus: null, canEdit: true };
    store.replaceContacts(scoped, [row]);
    const detail = { contact: row, company: { companyId: 4, name: 'Acme', domain: null, backcheckData: null }, activities: [], mailEvents: [], mailAvailable: true, mailEventLimit: 200, canEdit: true, canFollowup: true, canAssign: false } as CenterContactDetail;
    store.saveDetail(scoped, detail); expect(store.detail(scoped, row)?.contact).toEqual(row);
    store.saveDetail(scoped, { ...detail, contact: { ...row, contactVersion: 2, firstName: 'stale' } });
    expect(store.contact(scoped, row)?.firstName).toBeNull(); expect(store.detail({ ...scoped, permissionKey: 'changed' }, row)).toBeUndefined();
    store.upsertContacts(scoped, [{ ...row, contactVersion: 5, firstName: 'confirmed' }]);
    store.upsertContacts(scoped, [{ ...row, contactVersion: 3, firstName: 'old' }]);
    expect(store.contact(scoped, row)?.firstName).toBe('confirmed');
    store.forgetContact(scoped, row); expect(store.contact(scoped, row)).toBeUndefined(); expect(store.detail(scoped, row)).toBeUndefined();
  });
  it('prunes saved detail and quarantines excluded pending events without erasing evidence', () => {
    const store = new SqliteContactMirrorStore(open); const row = { ...contact(), assignmentStatus: null };
    store.replaceContacts(alice, [row]); store.saveDetail(alice, { contact: row } as CenterContactDetail); store.linkMail(alice, link());
    store.replaceContacts(alice, []); expect(store.detail(alice, row)).toBeUndefined(); expect(store.pendingEvents(alice)).toHaveLength(0);expect(open(alice).prepare('SELECT status,payload FROM crm_contact_mail_events').get()).toMatchObject({status:'blocked',payload:JSON.stringify(event())});
  });
  it('marks only complete compatible snapshots ready and binds readiness to permissions', () => {
    const store = new SqliteContactMirrorStore(open);
    const scoped = { ...alice, permissionKey: 'sales' };
    expect(store.ready(scoped)).toBe(false);
    store.upsertContacts(scoped, [{ ...contact(), assignmentStatus: null }]);
    expect(store.ready(scoped)).toBe(false);
    store.replaceContacts(scoped, [{ ...contact(), assignmentStatus: null }]);
    expect(store.ready(scoped)).toBe(true);
    expect(store.ready({ ...scoped, permissionKey: 'changed' })).toBe(false);
    store.replaceContacts(scoped, []); expect(store.ready(scoped)).toBe(true);
    store.invalidateContacts(scoped); expect(store.ready(scoped)).toBe(false);
  });
  it('requires a fresh full scan for old snapshots missing accepted assignment semantics', () => {
    const store = new SqliteContactMirrorStore(open);
    store.replaceContacts(alice, [contact()]); expect(store.ready(alice)).toBe(false);
  });
  it('preserves full nullable snapshots and finds all normalized email candidates', () => {
    const store = new SqliteContactMirrorStore(open);
    store.replaceContacts(alice, [contact(), contact(8, null), contact(9, 'alice@example.test')]);
    expect(store.contacts(alice)).toEqual([contact(), contact(8, null), contact(9, 'alice@example.test')]);
    expect(store.findByEmail(alice, ' ALICE@EXAMPLE.TEST ')).toEqual([contact(), contact(9, 'alice@example.test')]);
    expect(store.findByEmail(alice, '')).toEqual([]);
    expect(store.contact(alice, { contactId: 8, customerId: 'customer-a' })).toEqual(contact(8, null));
    expect(store.contact(alice, { contactId: 8, customerId: 'wrong' })).toBeUndefined();
  });
  it('updates a snapshot by its center contact ID and refreshes the email index', () => {
    const store = new SqliteContactMirrorStore(open);
    store.replaceContacts(alice, [contact(), contact(8, null)]);
    const updated = { ...contact(), email: 'new@example.test', contactVersion: 4, extra: { changed: true } };
    store.upsertContacts(alice, [updated]);
    expect(store.findByEmail(alice, 'alice@example.test')).toEqual([]);
    expect(store.findByEmail(alice, 'new@example.test')).toEqual([updated]);
    expect(store.contacts(alice)).toHaveLength(2);
  });
  it('discards an incremental cursor when the mirror format is obsolete', () => {
    const store = new SqliteContactMirrorStore(open);
    store.replaceContacts(alice, [{ ...contact(), assignmentStatus: null }]);
    store.saveIncrementalCursor(alice, '42');
    expect(store.incrementalState(alice)).toMatchObject({ cursor: '42' });
    open(alice).prepare('UPDATE crm_contact_mirror_meta SET format_version=1 WHERE id=1').run();
    expect(store.incrementalState(alice).cursor).toBeNull();
  });
  it('isolates accounts and centers, including matching center IDs', () => {
    const store = new SqliteContactMirrorStore(open);
    store.replaceContacts(alice, [contact()]); store.replaceContacts(bob, [{ ...contact(), email: 'bob@example.test' }]);
    store.linkMail(alice, link());
    expect(store.findByEmail(bob, 'alice@example.test')).toEqual([]);
    expect(store.contacts(otherCenter)).toEqual([]);
    expect(store.linksForMessage(bob, 'stable-1')).toEqual([]);
    expect(store.pendingEvents(otherCenter)).toEqual([]);
  });
  it('retains mail associations and blocked evidence while excluding removed contacts from upload', () => {
    const store = new SqliteContactMirrorStore(open);
    store.replaceContacts(alice, [contact()]); store.linkMail(alice, link()); store.replaceContacts(alice, [contact(8, null)]);
    expect(store.contacts(alice)).toEqual([contact(8, null)]);
    expect(store.linksForMessage(alice, 'stable-1')).toEqual([{ ...link(), event: undefined }]);
    expect(store.pendingEvents(alice)).toEqual([]);expect(open(alice).prepare('SELECT status,payload FROM crm_contact_mail_events').get()).toMatchObject({status:'blocked',payload:JSON.stringify(event())});
  });
  it('keeps the previous complete snapshot when replacement fails halfway', () => {
    const store = new SqliteContactMirrorStore(open);
    store.replaceContacts(alice, [contact()]);
    const invalid = contact(9); invalid.extra.circular = invalid.extra;
    expect(() => store.replaceContacts(alice, [contact(8, null), invalid])).toThrow();
    expect(store.contacts(alice)).toEqual([contact()]);
  });
  it('reads associations by local mail source and bounds persistent queue pages', () => {
    const store = new SqliteContactMirrorStore(open);
    store.linkMail(alice, link());
    store.linkMail(alice, { ...link(), localMailId: 8, messageKey: 'stable-2', role: 'cc', event: { ...event('event-2'), messageKey: 'stable-2', kind: 'cc' } });
    expect(store.linksForLocalMessage(alice, 7)).toEqual([{ ...link(), event: undefined }]);
    expect(store.linksForLocalMessage(alice, 8)[0]?.role).toBe('cc');
    expect(store.pendingEvents(alice, 1)).toEqual([event()]);
    expect(store.pendingEvents(alice)).toHaveLength(2);
    expect(() => store.pendingEvents(alice, 0)).toThrow(/分页/);
  });
  it('rejects empty account identities before opening any database', () => {
    const store = new SqliteContactMirrorStore(open);
    expect(() => store.contacts({ ...alice, userId: '' })).toThrow(/账号/);
    expect(databases.size).toBe(0);
  });
  it('persists replay safely and does not requeue acknowledged events', () => {
    const store = new SqliteContactMirrorStore(open);
    store.linkMail(alice, link()); store.linkMail(alice, link());
    expect(store.linksForMessage(alice, 'stable-1')).toHaveLength(1);
    expect(store.pendingEvents(alice)).toEqual([event()]);
    store.acknowledgeEvent(alice, 'event-1'); store.linkMail(alice, link());
    expect(store.pendingEvents(alice)).toEqual([]);
  });
  it('preserves the first immutable event when a later preview or subject is enhanced', () => {
    const store = new SqliteContactMirrorStore(open);
    store.linkMail(alice, link());
    expect(() => store.linkMail(alice, link({ ...event(), subject: 'expanded subject', preview: 'fuller extracted preview' }))).not.toThrow();
    expect(store.pendingEvents(alice)).toEqual([event()]);
    store.acknowledgeEvent(alice, 'event-1');
    expect(() => store.linkMail(alice, link({ ...event(), preview: 'another enhancement' }))).not.toThrow();
    expect(store.pendingEvents(alice)).toEqual([]);
  });
  it.each([{ mailboxKey: 'other-account' }, { occurredAt: '2026-10-13T00:00:00Z' }, { fromEmail: 'stranger@example.test' }, { toEmails: ['someone@example.test'] }, { ccEmails: ['someone@example.test'] }, { kind: 'cc' as const }, { direction: 'outbound' as const }])('rejects a same event key attached to different facts %j', fields => {
    const store = new SqliteContactMirrorStore(open);
    store.linkMail(alice, link());
    expect(() => store.linkMail(alice, link({ ...event(), ...fields }))).toThrow(/重复|冲突/);
    expect(store.pendingEvents(alice)).toEqual([event()]);
  });
  it.each([{ role: 'to' as const }, { mailAccountId: 3 }, { mailbox: 'SENT' }])('rejects a same event key attached to a different local role or mailbox %j', fields => {
    const store = new SqliteContactMirrorStore(open);
    store.linkMail(alice, link());
    expect(() => store.linkMail(alice, { ...link(), ...fields })).toThrow(/冲突/);
    expect(store.linksForLocalMessage(alice, 7)).toEqual([{ ...link(), event: undefined }]);
  });
  it('retains failed events durably without automatic replay', () => {
    const store = new SqliteContactMirrorStore(open);
    store.linkMail(alice, link()); store.failEvent(alice, 'event-1', 'permission revoked'); store.linkMail(alice, link());
    expect(store.pendingEvents(alice)).toEqual([]);
    const raw = databases.get(JSON.stringify([alice.baseUrl, alice.userId]))!;
    expect(raw.exec('SELECT status, error FROM crm_contact_mail_events')[0].values).toEqual([['failed', 'permission revoked']]);
  });
  it('rolls back the association when its event key conflicts', () => {
    const store = new SqliteContactMirrorStore(open);
    store.linkMail(alice, link());
    expect(() => store.linkMail(alice, { ...link(), messageKey: 'stable-2', event: { ...event(), messageKey: 'stable-2' } })).toThrow(/重复|冲突/);
    expect(store.linksForMessage(alice, 'stable-2')).toEqual([]);
    expect(store.pendingEvents(alice)).toEqual([event()]);
  });
  it('never adopts a matching legacy numeric contact ID', () => {
    const raw = open(alice);
    raw.exec("CREATE TABLE contacts(id INTEGER PRIMARY KEY,email TEXT); INSERT INTO contacts VALUES(7,'legacy@example.test')");
    const store = new SqliteContactMirrorStore(open);
    store.replaceContacts(alice, [contact()]); store.linkMail(alice, link());
    expect(raw.prepare('SELECT * FROM contacts').all()).toEqual([{ id: 7, email: 'legacy@example.test' }]);
    expect(store.findByEmail(alice, 'legacy@example.test')).toEqual([]);
  });
});
