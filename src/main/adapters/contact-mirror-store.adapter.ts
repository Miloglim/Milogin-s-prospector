import type { Database } from 'better-sqlite3';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { CenterContact, CenterContactPage, CenterContactQuery } from '../../../server/core/center-contacts';
import type { CenterContactRef, CenterContactDetail } from '../../../server/core/contact-assignments';
import { CONTACT_COMMAND_PREFIX, CONTACT_COMMAND_RETENTION, contactCommandFingerprint, contactCommandAllowed, contactAccessFingerprint, type ContactCommand, type ContactCommandReceipt, type ContactCommandAction, type ContactCommandInput, type ContactCommandDuplicate } from '../core/contact-commands';
import { contactDetailSnapshot, contactMirrorPage } from '../core/contact-mirror';
import { accountProfileRoot } from './desktop-local-scope.adapter';
import { CONTACT_MIRROR_LIMITS, normalizedContactEmail, type QueuedContactMailEvent, type ContactMirrorContext, type ContactMirrorStore, type ContactMailLink, type ContactMailLinkInput } from '../core/contact-mirror';
import { Log } from '../logger';

function corruptSqlite(error: unknown): boolean {
  return !!error && typeof error === 'object' && ['SQLITE_CORRUPT', 'SQLITE_NOTADB'].includes(String((error as { code?: unknown }).code));
}

function quarantineMirror(file: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${file}${suffix}`;
    if (existsSync(source)) renameSync(source, `${file}.corrupt-${stamp}${suffix}`);
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS crm_contact_mirror_meta (
  id INTEGER PRIMARY KEY CHECK(id=1), permission_key TEXT NOT NULL, format_version INTEGER NOT NULL,
  sync_cursor TEXT
);
CREATE TABLE IF NOT EXISTS crm_contact_mirror (
  contact_id INTEGER PRIMARY KEY, customer_id TEXT NOT NULL, email_normalized TEXT,
  snapshot TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS crm_contact_mirror_email ON crm_contact_mirror(email_normalized);
CREATE INDEX IF NOT EXISTS crm_contact_mirror_customer ON crm_contact_mirror(customer_id,contact_id);
CREATE TABLE IF NOT EXISTS crm_contact_details (
  contact_id INTEGER NOT NULL, customer_id TEXT NOT NULL, permission_key TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY(contact_id,customer_id)
);
CREATE TABLE IF NOT EXISTS crm_contact_mail_links (
  message_key TEXT NOT NULL, local_mail_id INTEGER NOT NULL, mail_account_id INTEGER NOT NULL,
  mailbox TEXT NOT NULL, contact_id INTEGER NOT NULL, customer_id TEXT NOT NULL, role TEXT NOT NULL,
  PRIMARY KEY(message_key,contact_id,customer_id,role)
);
CREATE INDEX IF NOT EXISTS crm_contact_mail_links_local ON crm_contact_mail_links(local_mail_id);
CREATE TABLE IF NOT EXISTS crm_contact_mail_events (
  event_key TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT
);
CREATE INDEX IF NOT EXISTS crm_contact_mail_events_pending ON crm_contact_mail_events(status);
CREATE TABLE IF NOT EXISTS crm_contact_commands (
  permission_key TEXT NOT NULL, command_id TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(permission_key,command_id)
);
CREATE INDEX IF NOT EXISTS crm_contact_commands_status ON crm_contact_commands(json_extract(payload,'$.status'),permission_key);
CREATE INDEX IF NOT EXISTS crm_contact_commands_key ON crm_contact_commands(permission_key,COALESCE(json_extract(payload,'$.input.idempotencyKey'),json_extract(payload,'$.idempotencyKey')));
CREATE INDEX IF NOT EXISTS crm_contact_commands_retired ON crm_contact_commands(permission_key) WHERE json_type(payload,'$.retiredKeys')='array';
CREATE INDEX IF NOT EXISTS crm_contact_commands_predecessor ON crm_contact_commands(permission_key,json_extract(payload,'$.predecessorId')) WHERE json_extract(payload,'$.status') IN ('pending','conflict','failed');
CREATE INDEX IF NOT EXISTS crm_contact_commands_retention ON crm_contact_commands(permission_key,json_extract(payload,'$.confirmedAt')) WHERE json_extract(payload,'$.status')='confirmed' AND json_type(payload,'$.input')='object';
`;
const LINKS_SELECT = `SELECT message_key AS messageKey,local_mail_id AS localMailId,mail_account_id AS mailAccountId,
  mailbox,contact_id AS contactId,customer_id AS customerId,role FROM crm_contact_mail_links`;
// Bump when a center projection fix requires one authoritative full rescan.
const READ_FORMAT_VERSION = 2;
const contactValue = (field: string) => `json_extract(snapshot,'$.${field}')`;
const UPDATED_ORDER = `crm_contact_time(${contactValue('updatedAt')}) DESC,contact_id DESC`;
const FOLLOWUP_PREDICATE = `${contactValue('touchStatus')} IN ('contacted','replied','bounced','autoreply')`;
const FOLLOWUP_ORDER = `crm_contact_time(${contactValue('lastFollowupAt')}) DESC,${UPDATED_ORDER}`;
const SEARCH_FIELDS = ['email', 'firstName', 'lastName', 'title', 'companyName'] as const;
const searchValue = (field: string) => `crm_contact_lower(${contactValue(field)})`;
const PAGE_INDEXES = `
CREATE INDEX IF NOT EXISTS crm_contact_mirror_page ON crm_contact_mirror(${UPDATED_ORDER});
CREATE INDEX IF NOT EXISTS crm_contact_mirror_followup_page ON crm_contact_mirror(${FOLLOWUP_ORDER}) WHERE ${FOLLOWUP_PREDICATE};
CREATE INDEX IF NOT EXISTS crm_contact_mirror_source_page ON crm_contact_mirror(${contactValue('origin')},${contactValue('ownerUserId')},${UPDATED_ORDER});
CREATE INDEX IF NOT EXISTS crm_contact_mirror_search_page ON crm_contact_mirror(${SEARCH_FIELDS.map(searchValue).join(',')},${UPDATED_ORDER});
`;
const UNRESOLVED_COMMAND = "json_extract(payload,'$.status') IN ('pending','conflict','failed')";
const commandDigest=(input:ContactCommandInput)=>createHash('sha256').update(contactCommandFingerprint(input)).digest('hex');
// An authorization permits archiving a historical send, never restored contact access.
const UNAUTHORIZED_MAIL_FILTER = "NOT (json_extract(payload,'$.kind')='sent' AND json_extract(payload,'$.direction')='outbound' AND COALESCE(length(json_extract(payload,'$.sendAuthorizationId')),0)>0)";
function eventIdentity(event: QueuedContactMailEvent): string {
  return JSON.stringify([event.eventKey, event.mailboxKey, event.messageKey, event.contactId, event.customerId,
    event.kind, event.direction, event.occurredAt, event.fromEmail, event.toEmails, event.ccEmails,event.correction]);
}
function mailMetadata(event:QueuedContactMailEvent):string {
  return JSON.stringify([eventIdentity(event),event.subject,event.preview]);
}

/** Structured authorized snapshots share crm-offline.db, never legacy contacts. */
export class SqliteContactMirrorStore implements ContactMirrorStore {
  private readonly initialized = new WeakSet<Database>();
  constructor(private readonly open: (context: ContactMirrorContext) => Database) {}

  commandRows(ctx: ContactMirrorContext): ContactCommand[] {
    const rows = this.database(ctx).prepare("SELECT payload FROM crm_contact_commands WHERE permission_key=? AND json_type(payload,'$.input')='object' ORDER BY rowid").all(ctx.permissionKey ?? '') as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload) as ContactCommand);
  }

  unresolvedCommands(ctx: ContactMirrorContext): ContactCommand[] {
    const rows=this.database(ctx).prepare(`SELECT payload FROM crm_contact_commands WHERE permission_key=? AND ${UNRESOLVED_COMMAND} ORDER BY rowid`).all(ctx.permissionKey??'') as {payload:string}[];
    return rows.map(row=>JSON.parse(row.payload) as ContactCommand);
  }

  getCommand(ctx:ContactMirrorContext,id:string):ContactCommand|undefined {
    const row=this.database(ctx).prepare("SELECT payload FROM crm_contact_commands WHERE permission_key=? AND command_id=? AND json_type(payload,'$.input')='object'").get(ctx.permissionKey??'',id) as {payload:string}|undefined;
    return row?JSON.parse(row.payload) as ContactCommand:undefined;
  }

  commandConfirmed(ctx:ContactMirrorContext,id:string):boolean {
    return !!this.database(ctx).prepare("SELECT 1 FROM crm_contact_commands WHERE permission_key=? AND command_id=? AND json_extract(payload,'$.status')='confirmed'").get(ctx.permissionKey??'',id);
  }

  findCommandDuplicate(ctx:ContactMirrorContext,action:ContactCommandAction,input:ContactCommandInput):ContactCommandDuplicate|undefined {
    const db=this.database(ctx),permission=ctx.permissionKey??'',key=input.idempotencyKey;
    // Current keys and original command IDs use indexes; only explicitly retired-key rows need a membership scan.
    const direct=db.prepare("SELECT payload FROM crm_contact_commands WHERE permission_key=? AND command_id=? UNION SELECT payload FROM crm_contact_commands WHERE permission_key=? AND COALESCE(json_extract(payload,'$.input.idempotencyKey'),json_extract(payload,'$.idempotencyKey'))=?").all(permission,`${CONTACT_COMMAND_PREFIX}${key}`,permission,key) as {payload:string}[];
    const retired=db.prepare("SELECT payload FROM crm_contact_commands WHERE permission_key=? AND json_type(payload,'$.retiredKeys')='array' AND EXISTS(SELECT 1 FROM json_each(json_extract(payload,'$.retiredKeys')) WHERE value=?)").all(permission,key) as {payload:string}[];
    const rows=[...direct,...retired].map(item=>JSON.parse(item.payload) as ContactCommand|ContactCommandReceipt);
    if(!rows.length)return undefined;
    const matches=rows.every(row=>row.action===action&&('input' in row?contactCommandFingerprint(row.input)===contactCommandFingerprint(input):row.inputDigest===commandDigest(input)));
    const row=rows.find(row=>'input' in row) as ContactCommand|undefined;
    return {matches,confirmed:rows.every(row=>row.status==='confirmed'),...(row?{row}:{})};
  }

  /** A bounded transaction replaces old confirmed content, never idempotency evidence. */
  maintainCommands(ctx:ContactMirrorContext,now:string):void {
    const instant=Date.parse(now);if(!Number.isFinite(instant))throw new Error('命令保留期时间无效');
    const cutoff=new Date(instant-CONTACT_COMMAND_RETENTION.days*CONTACT_COMMAND_RETENTION.millisecondsPerDay).toISOString();
    const db=this.database(ctx),permission=ctx.permissionKey??'';
    db.transaction(()=>{
      // Separate equality/range searches keep idle maintenance independent of total confirmed history.
      const select="SELECT payload FROM crm_contact_commands c INDEXED BY crm_contact_commands_retention WHERE permission_key=? AND json_extract(payload,'$.status')='confirmed' AND json_type(payload,'$.input')='object' AND ";
      // Unary + removes the TEXT column affinity so SQLite can use the JSON-expression key as well as permission_key.
      const eligible=" AND NOT EXISTS(SELECT 1 FROM crm_contact_commands child INDEXED BY crm_contact_commands_predecessor WHERE child.permission_key=c.permission_key AND json_extract(child.payload,'$.predecessorId')=+c.command_id AND json_extract(child.payload,'$.status') IN ('pending','conflict','failed')) ORDER BY json_extract(payload,'$.confirmedAt') LIMIT ?";
      const legacy=db.prepare(select+"json_extract(payload,'$.confirmedAt') IS NULL"+eligible).all(permission,CONTACT_COMMAND_RETENTION.batch) as {payload:string}[];
      const aged=db.prepare(select+"json_extract(payload,'$.confirmedAt')<=?"+eligible).all(permission,cutoff,CONTACT_COMMAND_RETENTION.batch-legacy.length) as {payload:string}[];
      const rows=[...legacy,...aged];
      for(const item of rows){
        const row=JSON.parse(item.payload) as ContactCommand;
        if(!row.confirmedAt){this.putCommand(ctx,{...row,confirmedAt:now});continue;}
        const confirmedAt=Date.parse(row.confirmedAt);if(!Number.isFinite(confirmedAt)||confirmedAt>instant-CONTACT_COMMAND_RETENTION.days*CONTACT_COMMAND_RETENTION.millisecondsPerDay)continue;
        const receipt:ContactCommandReceipt={kind:'receipt',id:row.id,action:row.action,status:'confirmed',contactId:row.input.contactId,customerId:row.input.customerId,confirmedAt:row.confirmedAt,inputDigest:commandDigest(row.input),idempotencyKey:row.input.idempotencyKey,...(row.retiredKeys?.length?{retiredKeys:row.retiredKeys}:{})};
        db.prepare('UPDATE crm_contact_commands SET payload=? WHERE permission_key=? AND command_id=? AND payload=?').run(JSON.stringify(receipt),permission,row.id,item.payload);
      }
    })();
  }

  putCommand(ctx: ContactMirrorContext, row: ContactCommand): void {
    this.database(ctx).prepare('INSERT INTO crm_contact_commands(permission_key,command_id,payload) VALUES(?,?,?) ON CONFLICT(permission_key,command_id) DO UPDATE SET payload=excluded.payload').run(ctx.permissionKey ?? '', row.id, JSON.stringify(row));
  }

  removeCommand(ctx: ContactMirrorContext, id: string): void {
    this.database(ctx).prepare('DELETE FROM crm_contact_commands WHERE permission_key=? AND command_id=?').run(ctx.permissionKey ?? '', id);
  }

  commandTransaction(ctx: ContactMirrorContext, work: () => void): void {
    this.database(ctx).transaction(work)();
  }

  private database(ctx: ContactMirrorContext): Database {
    if (!ctx.baseUrl?.trim() || !ctx.userId?.trim()) throw new Error('联系人镜像必须绑定中心账号');
    const db = this.open(ctx);
    if (!this.initialized.has(db)) {
      // Register before opening expression indexes, including on a reopened cache.
      // Compatibility-only in-memory drivers can retain the original array path.
      if (typeof db.function === 'function') {
        db.function('crm_contact_lower', { deterministic: true }, (value: string | null) => value?.toLowerCase() ?? null);
        db.function('crm_contact_time', { deterministic: true }, (value: string | null) => value ? Date.parse(value) : Number.NEGATIVE_INFINITY);
      }
      db.exec(SCHEMA);
      const columns = db.prepare('PRAGMA table_info(crm_contact_mirror_meta)').all() as Array<{ name: string }>;
      if (!columns.some(column => column.name === 'sync_cursor')) db.exec('ALTER TABLE crm_contact_mirror_meta ADD COLUMN sync_cursor TEXT');
      if (typeof db.function === 'function') db.exec(PAGE_INDEXES);
      this.initialized.add(db);
    }
    return db;
  }

  private writeContacts(db: Database, contacts: CenterContact[]): void {
    const statement = db.prepare(`INSERT INTO crm_contact_mirror(contact_id,customer_id,email_normalized,snapshot)
      VALUES(?,?,?,?) ON CONFLICT(contact_id) DO UPDATE SET customer_id=excluded.customer_id,
      email_normalized=excluded.email_normalized,snapshot=excluded.snapshot`);
    for (const contact of contacts) {
      const old = db.prepare('SELECT snapshot FROM crm_contact_mirror WHERE contact_id=?').get(contact.contactId) as { snapshot: string } | undefined;
      if (old) {
        const previous = JSON.parse(old.snapshot) as CenterContact;
        if ((contact.contactVersion ?? contact.customerVersion) < (previous.contactVersion ?? previous.customerVersion) || (contact.contactVersion ?? contact.customerVersion) === (previous.contactVersion ?? previous.customerVersion) && contact.customerVersion < previous.customerVersion) continue;
      }
      statement.run(contact.contactId, contact.customerId, normalizedContactEmail(contact.email), JSON.stringify(contact));
    }
  }

  replaceContacts(ctx: ContactMirrorContext, contacts: CenterContact[]): void {
    const db = this.database(ctx);
    db.transaction(() => {
      // Read and diff under the same transaction: another WAL writer cannot turn this
      // comparison into a stale successful commit. Unchanged snapshots need no JSON decode.
      const stored = db.prepare('SELECT contact_id,snapshot FROM crm_contact_mirror').all() as { contact_id: number; snapshot: string }[];
      const snapshots = new Map(stored.map(row => [row.contact_id, row.snapshot]));
      const previous = new Map<number, CenterContact>(), received = new Map<number, CenterContact>();
      const write = db.prepare(`INSERT INTO crm_contact_mirror(contact_id,customer_id,email_normalized,snapshot)
        VALUES(?,?,?,?) ON CONFLICT(contact_id) DO UPDATE SET customer_id=excluded.customer_id,
        email_normalized=excluded.email_normalized,snapshot=excluded.snapshot`);
      const remove = db.prepare('DELETE FROM crm_contact_mirror WHERE contact_id=?');
      const invalidateDetail = db.prepare('DELETE FROM crm_contact_details WHERE contact_id=?');
      for (const row of contacts) {
        const snapshot = JSON.stringify(row), oldSnapshot = snapshots.get(row.contactId);
        if (oldSnapshot !== undefined && oldSnapshot !== snapshot) {
          const old = previous.get(row.contactId) ?? JSON.parse(oldSnapshot) as CenterContact;
          previous.set(row.contactId, old);
          if (contactAccessFingerprint(contactDetailSnapshot(old)) !== contactAccessFingerprint(contactDetailSnapshot(row))) invalidateDetail.run(row.contactId);
        }
        // A full scan is authoritative even at lower/equal versions. Only duplicate IDs
        // inside that incoming scan retain the original writeContacts version precedence.
        const seen = received.get(row.contactId);
        if (seen && ((row.contactVersion ?? row.customerVersion) < (seen.contactVersion ?? seen.customerVersion) || (row.contactVersion ?? row.customerVersion) === (seen.contactVersion ?? seen.customerVersion) && row.customerVersion < seen.customerVersion)) continue;
        received.set(row.contactId, row);
        if ((seen ? JSON.stringify(seen) : oldSnapshot) !== snapshot) write.run(row.contactId, row.customerId, normalizedContactEmail(row.email), snapshot);
      }
      for (const row of stored) if (!received.has(row.contact_id)) remove.run(row.contact_id);
      db.prepare('DELETE FROM crm_contact_details WHERE permission_key<>? OR NOT EXISTS(SELECT 1 FROM crm_contact_mirror m WHERE m.contact_id=crm_contact_details.contact_id AND m.customer_id=crm_contact_details.customer_id)').run(ctx.permissionKey ?? '');
      db.prepare("UPDATE crm_contact_mail_events SET status='blocked',error='联系人已删除或不再授权' WHERE status='pending' AND "+UNAUTHORIZED_MAIL_FILTER+" AND NOT EXISTS(SELECT 1 FROM crm_contact_mirror m WHERE m.contact_id=json_extract(crm_contact_mail_events.payload,'$.contactId') AND m.customer_id=json_extract(crm_contact_mail_events.payload,'$.customerId'))").run();
      const format = contacts.every(row => row.assignmentStatus !== undefined) ? READ_FORMAT_VERSION : 0;
      db.prepare('INSERT INTO crm_contact_mirror_meta(id,permission_key,format_version,sync_cursor) VALUES(1,?,?,NULL) ON CONFLICT(id) DO UPDATE SET permission_key=excluded.permission_key,format_version=excluded.format_version,sync_cursor=NULL').run(ctx.permissionKey ?? '', format);
      this.retireCommands(ctx,previous);
    })();
  }

  /** Losing access never destroys user input or silently requeues it after a regrant. */
  private retireCommands(ctx:ContactMirrorContext, previous?:Map<number,CenterContact>):void {
    const stored=this.database(ctx).prepare("SELECT permission_key,payload FROM crm_contact_commands WHERE json_extract(payload,'$.status') IN ('pending','conflict')").all() as {permission_key:string;payload:string}[];
    for(const item of stored){
      const command=JSON.parse(item.payload) as ContactCommand;
      if(command.status==='confirmed'||command.status==='failed')continue;
      const row=this.contact(ctx,command.input),old=previous?.get(command.input.contactId);
      if(item.permission_key===(ctx.permissionKey??'')&&row&&(!old||old.ownerUserId===row.ownerUserId&&old.customerId===row.customerId)&&contactCommandAllowed(contactDetailSnapshot(row),command.action,command.input))continue;
      this.putCommand({...ctx,permissionKey:item.permission_key},{...command,status:'failed',error:'联系人已移出授权范围或权限已变化',errorCode:row?'FORBIDDEN':'NOT_FOUND',discardable:!command.attempted});
    }
  }

  ready(ctx: ContactMirrorContext): boolean {
    const meta = this.database(ctx).prepare('SELECT permission_key,format_version FROM crm_contact_mirror_meta WHERE id=1').get() as { permission_key: string; format_version: number } | undefined;
    return meta?.format_version === READ_FORMAT_VERSION && meta.permission_key === (ctx.permissionKey ?? '');
  }

  incrementalState(ctx: ContactMirrorContext): { cursor: string | null; permissionKey: string } {
    const row = this.database(ctx).prepare('SELECT permission_key,format_version,sync_cursor FROM crm_contact_mirror_meta WHERE id=1').get() as { permission_key: string; format_version: number; sync_cursor: string | null } | undefined;
    const usable = row?.format_version === READ_FORMAT_VERSION && row.permission_key === (ctx.permissionKey ?? '');
    return { cursor: usable ? row.sync_cursor : null, permissionKey: row?.permission_key ?? '' };
  }

  saveIncrementalCursor(ctx: ContactMirrorContext, cursor: string): void {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(cursor)) throw new Error('联系人变化游标无效');
    this.database(ctx).prepare('UPDATE crm_contact_mirror_meta SET sync_cursor=? WHERE id=1 AND permission_key=? AND format_version=?').run(cursor, ctx.permissionKey ?? '', READ_FORMAT_VERSION);
  }

  invalidateContacts(ctx: ContactMirrorContext): void {
    const db = this.database(ctx);
    db.transaction(() => { db.prepare('DELETE FROM crm_contact_mirror_meta').run(); db.prepare('DELETE FROM crm_contact_mirror').run(); db.prepare('DELETE FROM crm_contact_details').run();this.retireCommands(ctx); })();
  }

  upsertContacts(ctx: ContactMirrorContext, contacts: CenterContact[]): void {
    const db = this.database(ctx);
    db.transaction(() => {
      const previous=new Map(this.contacts(ctx).map(row=>[row.contactId,row]));
      this.writeContacts(db, contacts);
      let changed=false;
      for(const incoming of contacts){
        const old=previous.get(incoming.contactId),current=this.contact(ctx,incoming);
        if(old&&current&&contactAccessFingerprint(contactDetailSnapshot(old))!==contactAccessFingerprint(contactDetailSnapshot(current))){
          changed=true;db.prepare('DELETE FROM crm_contact_details WHERE contact_id=?').run(current.contactId);
        }
      }
      if(changed)this.retireCommands(ctx,previous);
    })();
  }

  contacts(ctx: ContactMirrorContext): CenterContact[] {
    const rows = this.database(ctx).prepare('SELECT snapshot FROM crm_contact_mirror ORDER BY contact_id').all() as { snapshot: string }[];
    return rows.map(row => JSON.parse(row.snapshot) as CenterContact);
  }

  /** SQL filters/counts first; only this page's immutable snapshots are decoded. */
  page(ctx: ContactMirrorContext, query: CenterContactQuery): CenterContactPage {
    const db = this.database(ctx);
    if (typeof db.function !== 'function') return contactMirrorPage(this.contacts(ctx), query, ctx.userId);
    const conditions: string[] = [], parameters: (string | number)[] = [];
    if (query.scope === 'personal') {
      conditions.push(`${contactValue('origin')}='personal' AND ${contactValue('ownerUserId')}=?`); parameters.push(ctx.userId);
    }
    if (query.scope === 'assigned') {
      conditions.push(`((${contactValue('origin')}='operations' AND ${contactValue('ownerUserId')}=?) OR ${contactValue('isShared')}=1)`); parameters.push(ctx.userId);
    }
    if (query.assignment === 'accepted') conditions.push(`${contactValue('assignmentStatus')}='accepted'`);
    if (query.followupOnly) conditions.push(FOLLOWUP_PREDICATE);
    if (query.crmStage) {
      conditions.push(`COALESCE(${contactValue('relationshipStage')},CASE WHEN ${FOLLOWUP_PREDICATE} THEN 'reaching' ELSE 'cold' END)=?`); parameters.push(query.crmStage);
    }
    for (const field of ['touchStatus', 'stage', 'status', 'clientType', 'country', 'language'] as const) {
      if (query[field]) { conditions.push(`${contactValue(field)}=?`); parameters.push(query[field]!); }
    }
    if (query.tags) {
      conditions.push(`EXISTS(SELECT 1 FROM json_each(${contactValue('tags')}) WHERE value=?)`); parameters.push(query.tags);
    }
    const search = query.search.trim().toLowerCase();
    if (search) {
      conditions.push(`(${SEARCH_FIELDS.map(field => `instr(${searchValue(field)},?)>0`).join(' OR ')})`);
      parameters.push(...SEARCH_FIELDS.map(() => search));
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    // A leading wildcard search scans pre-normalized independent fields, never JS callbacks per row.
    const source = `crm_contact_mirror${search ? ' INDEXED BY crm_contact_mirror_search_page' : ''}`;
    // Deferred read transactions share one snapshot without preventing WAL writers.
    return db.transaction(() => {
      const total = (db.prepare(`SELECT COUNT(*) AS total FROM ${source}${where}`).get(...parameters) as { total: number }).total;
      const rows = db.prepare(`SELECT snapshot FROM ${source}${where} ORDER BY ${query.followupOnly ? FOLLOWUP_ORDER : UPDATED_ORDER} LIMIT ? OFFSET ?`).all(...parameters, query.limit, query.offset) as { snapshot: string }[];
      return { items: rows.map(row => JSON.parse(row.snapshot) as CenterContact), total };
    })();
  }

  contact(ctx: ContactMirrorContext, ref: CenterContactRef): CenterContact | undefined {
    const row = this.database(ctx).prepare('SELECT snapshot FROM crm_contact_mirror WHERE contact_id=? AND customer_id=?').get(ref.contactId, ref.customerId) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as CenterContact : undefined;
  }

  detail(ctx: ContactMirrorContext, ref: CenterContactRef): CenterContactDetail | undefined {
    const row = this.database(ctx).prepare('SELECT snapshot FROM crm_contact_details WHERE contact_id=? AND customer_id=? AND permission_key=?').get(ref.contactId, ref.customerId, ctx.permissionKey ?? '') as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as CenterContactDetail : undefined;
  }

  saveDetail(ctx: ContactMirrorContext, detail: CenterContactDetail): void {
    const db = this.database(ctx);
    db.transaction(() => {
      const current = this.contact(ctx, detail.contact);
      if (!current || (detail.contact.contactVersion ?? detail.contact.customerVersion) < (current.contactVersion ?? current.customerVersion) || (detail.contact.contactVersion ?? detail.contact.customerVersion) === (current.contactVersion ?? current.customerVersion) && detail.contact.customerVersion < current.customerVersion) return;
      this.writeContacts(db, [detail.contact]);
      db.prepare('INSERT INTO crm_contact_details(contact_id,customer_id,permission_key,snapshot) VALUES(?,?,?,?) ON CONFLICT(contact_id,customer_id) DO UPDATE SET permission_key=excluded.permission_key,snapshot=excluded.snapshot').run(detail.contact.contactId, detail.contact.customerId, ctx.permissionKey ?? '', JSON.stringify(detail));
      if(contactAccessFingerprint(contactDetailSnapshot(current))!==contactAccessFingerprint(contactDetailSnapshot(detail.contact)))this.retireCommands(ctx,new Map([[current.contactId,current]]));
    })();
  }

  forgetContact(ctx: ContactMirrorContext, ref: CenterContactRef): void {
    const db = this.database(ctx);
    db.transaction(() => { db.prepare('DELETE FROM crm_contact_mirror WHERE contact_id=? AND customer_id=?').run(ref.contactId, ref.customerId); db.prepare('DELETE FROM crm_contact_details WHERE contact_id=? AND customer_id=?').run(ref.contactId, ref.customerId); db.prepare("UPDATE crm_contact_mail_events SET status='blocked',error='联系人已删除或不再授权' WHERE status='pending' AND "+UNAUTHORIZED_MAIL_FILTER+" AND json_extract(payload,'$.contactId')=? AND json_extract(payload,'$.customerId')=?").run(ref.contactId,ref.customerId);this.retireCommands(ctx); })();
  }

  findByEmail(ctx: ContactMirrorContext, email: string): CenterContact[] {
    const normalized = normalizedContactEmail(email);
    if (!normalized) return [];
    const rows = this.database(ctx).prepare('SELECT snapshot FROM crm_contact_mirror WHERE email_normalized=? ORDER BY contact_id').all(normalized) as { snapshot: string }[];
    return rows.map(row => JSON.parse(row.snapshot) as CenterContact);
  }

  linkMail(ctx: ContactMirrorContext, link: ContactMailLinkInput): void {
    const db = this.database(ctx);
    if (link.event && (link.event.contactId !== link.contactId || link.event.customerId !== link.customerId || link.event.messageKey !== link.messageKey)) {
      throw new Error('邮件事件与联系人关联不一致');
    }
    db.transaction(() => {
      if(link.event?.correction){
        const same=db.prepare('SELECT payload FROM crm_contact_mail_events WHERE event_key=?').get(link.event.eventKey) as {payload:string}|undefined;
        const head=same?JSON.parse(same.payload) as QueuedContactMailEvent:undefined;
        const last=head?undefined:db.prepare("SELECT event_key FROM crm_contact_mail_events WHERE json_extract(payload,'$.mailboxKey')=? AND json_extract(payload,'$.messageKey')=? AND json_extract(payload,'$.contactId')=? AND json_extract(payload,'$.customerId')=? AND json_type(payload,'$.correction')='object' ORDER BY rowid DESC LIMIT 1").get(link.event.mailboxKey,link.event.messageKey,link.contactId,link.customerId) as {event_key:string}|undefined;
        link={...link,event:{...link.event,correction:{...link.event.correction,previousEventKey:head?.correction?.previousEventKey??last?.event_key??null}}};
      }
      const payload = link.event ? JSON.stringify(link.event) : null;
      const prior = link.event ? db.prepare('SELECT payload FROM crm_contact_mail_events WHERE event_key=?').get(link.event.eventKey) as { payload: string } | undefined : undefined;
      if (prior && link.event) {
        // Preserve the first append-only fact. Lazy body enrichment may improve the
        // preview or subject, but must not rewrite an acknowledged server payload.
        const previousEvent=JSON.parse(prior.payload) as QueuedContactMailEvent;
        // SMTP and the provider's Sent copy may use different timestamps/headers.
        // A confirmed receipt anchors the same mailbox/message/contact fact.
        const confirmSent=(!!link.event.sendAuthorizationId||link.event.advanceSendStage===true||previousEvent.advanceSendStage===true)&&previousEvent.kind==='sent'&&previousEvent.direction==='outbound'&&link.event.kind==='sent'&&link.event.direction==='outbound'&&previousEvent.eventKey===link.event.eventKey&&previousEvent.mailboxKey===link.event.mailboxKey&&previousEvent.messageKey===link.event.messageKey&&previousEvent.contactId===link.event.contactId&&previousEvent.customerId===link.event.customerId;
        if(previousEvent.sendAuthorizationId&&link.event.sendAuthorizationId&&previousEvent.sendAuthorizationId!==link.event.sendAuthorizationId)throw new Error('重复邮件发送授权冲突');
        if (!confirmSent && eventIdentity(previousEvent) !== eventIdentity(link.event)) throw new Error('重复邮件事件键内容冲突');
        const priorLink = db.prepare(`${LINKS_SELECT} WHERE message_key=? AND contact_id=? AND customer_id=? LIMIT 1`).get(link.messageKey, link.contactId, link.customerId) as ContactMailLink | undefined;
        if (priorLink && ((!link.event.correction&&priorLink.role !== link.role) || priorLink.mailAccountId !== link.mailAccountId || priorLink.mailbox !== link.mailbox)) throw new Error('重复邮件事件关联身份冲突');
        const saved = JSON.parse(prior.payload) as QueuedContactMailEvent;
        // An actual SMTP receipt can confirm a previously observed Sent fact.
        // Preserve its original metadata so the server's append-only digest still matches.
        const confirmStage=link.event.advanceSendStage===true&&saved.advanceSendStage!==true;
        const attachAuthorization=!!link.event.sendAuthorizationId&&!saved.sendAuthorizationId&&saved.kind==='sent'&&saved.direction==='outbound';
        const {sendAuthorizationId:_authorization,smtpAcceptance:_acceptance,...actual}=link.event;
        const acceptance=attachAuthorization&&mailMetadata(saved)!==mailMetadata(actual)?{smtpAcceptance:actual}:{};
        if(confirmStage||attachAuthorization)db.prepare("UPDATE crm_contact_mail_events SET payload=?,status='pending',error=NULL WHERE event_key=?").run(JSON.stringify({...saved,...(confirmStage?{advanceSendStage:true}:{}),...(attachAuthorization?{sendAuthorizationId:link.event.sendAuthorizationId}:{}),...acceptance}),link.event.eventKey);
      }
      db.prepare(`INSERT INTO crm_contact_mail_links(message_key,local_mail_id,mail_account_id,mailbox,contact_id,customer_id,role)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(message_key,contact_id,customer_id,role) DO UPDATE SET
        local_mail_id=excluded.local_mail_id,mail_account_id=excluded.mail_account_id,mailbox=excluded.mailbox`).run(
        link.messageKey, link.localMailId, link.mailAccountId, link.mailbox, link.contactId, link.customerId, link.role);
      if (!link.event) return;
      if (!prior) db.prepare('INSERT INTO crm_contact_mail_events(event_key,payload) VALUES(?,?)').run(link.event.eventKey, payload);
    })();
  }

  linksForMessage(ctx: ContactMirrorContext, messageKey: string): ContactMailLink[] {
    return this.database(ctx).prepare(`${LINKS_SELECT} WHERE message_key=? ORDER BY contact_id,role`).all(messageKey) as ContactMailLink[];
  }

  linksForLocalMessage(ctx: ContactMirrorContext, localMailId: number): ContactMailLink[] {
    return this.database(ctx).prepare(`${LINKS_SELECT} WHERE local_mail_id=? ORDER BY contact_id,role`).all(localMailId) as ContactMailLink[];
  }

  pendingEvents(ctx: ContactMirrorContext, limit = CONTACT_MIRROR_LIMITS.pending): QueuedContactMailEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('待同步邮件分页无效');
    const rows = this.database(ctx).prepare("SELECT payload FROM crm_contact_mail_events WHERE status='pending' ORDER BY rowid LIMIT ?").all(limit) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload) as QueuedContactMailEvent);
  }

  acknowledgeEvent(ctx: ContactMirrorContext, eventKey: string, postedEvent?: QueuedContactMailEvent): void {
    const db=this.database(ctx);
    // A newer SMTP confirmation may have upgraded the fact while POST was in flight.
    // The old response must not consume that still-unsubmitted payload.
    if(postedEvent)db.prepare("UPDATE crm_contact_mail_events SET status='acknowledged',error=NULL WHERE event_key=? AND payload=?").run(eventKey,JSON.stringify(postedEvent));
    else db.prepare("UPDATE crm_contact_mail_events SET status='acknowledged',error=NULL WHERE event_key=?").run(eventKey);
  }
  eventAcknowledged(ctx: ContactMirrorContext, eventKey: string): boolean {
    const row = this.database(ctx).prepare('SELECT status FROM crm_contact_mail_events WHERE event_key=?').get(eventKey) as {status:string}|undefined;
    return row?.status === 'acknowledged';
  }

  failEvent(ctx: ContactMirrorContext, eventKey: string, message: string): void {
    this.database(ctx).prepare("UPDATE crm_contact_mail_events SET status='failed',error=? WHERE event_key=? AND status='pending'").run(message, eventKey);
  }
}

export function createContactMirrorStore(parent: string) {
  const databases = new Map<string, Database>();
  const store = new SqliteContactMirrorStore(ctx => {
    const root = accountProfileRoot(parent, ctx);
    const file = join(root, 'crm-offline.db');
    let db = databases.get(file);
    if (!db) {
      mkdirSync(root, { recursive: true });
      // Native driver is loaded only when a verified account first uses the mirror.
      const Constructor = require('better-sqlite3') as typeof import('better-sqlite3');
      try {
        db = new Constructor(file);
        const check = db.pragma('quick_check', { simple: true });
        if (check !== 'ok') throw Object.assign(new Error(String(check)), { code: 'SQLITE_CORRUPT' });
      } catch (error) {
        if (db) { try { db.close(); } catch { /* The original corruption remains quarantined below. */ } }
        if (!corruptSqlite(error)) throw error;
        quarantineMirror(file);
        Log.error('contact.mirror', `联系人镜像损坏，已备份并重建: ${file}`);
        db = new Constructor(file);
      }
      db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma(`busy_timeout=${CONTACT_MIRROR_LIMITS.busyTimeoutMs}`);
      databases.set(file, db);
    }
    return db;
  });
  return { store, close: () => { for (const db of databases.values()) db.close(); databases.clear(); } };
}
