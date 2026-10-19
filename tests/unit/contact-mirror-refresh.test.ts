import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import type { Database } from 'better-sqlite3';
import type { CenterContact } from '../../server/core/center-contacts';
import type { ContactCommand } from '../../src/main/core/contact-commands';
import { contactDetailSnapshot } from '../../src/main/core/contact-mirror';
import { SqliteContactMirrorStore } from '../../src/main/adapters/contact-mirror-store.adapter';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const ctx = { baseUrl: 'https://center.test', userId: 'alice', permissionKey: 'sales' };
const databases: NativeDatabase[] = [], directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases) db.close(); databases.length = 0;
  for (const directory of directories) rmSync(directory, { recursive: true, force: true }); directories.length = 0;
});
function fixture(raw = new DatabaseSync(':memory:')) {
  databases.push(raw);
  const db = {
    exec: (sql: string) => raw.exec(sql), prepare: (sql: string) => raw.prepare(sql),
    function: (name: string, options: object, fn: (...args: never[]) => unknown) => raw.function(name, options, fn as never),
    transaction: (work: () => unknown) => () => {
      raw.exec('BEGIN');
      try { const result = work(); raw.exec('COMMIT'); return result; }
      catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  } as unknown as Database;
  const store = new SqliteContactMirrorStore(() => db);
  store.ready(ctx);
  return { raw, db, store };
}
function row(contactId: number, fields: Partial<CenterContact> = {}): CenterContact {
  return { contactId, customerId: `customer-${contactId}`, customerVersion: 2, contactVersion: 3,
    companyId: 4, companyName: 'Acme', email: `${contactId}@example.test`, firstName: null, lastName: null,
    title: null, phone: null, linkedinUrl: null, country: null, clientType: null, language: null,
    stage: 'cold', status: '', tags: [], extra: {}, touchStatus: 'uncontacted', assignee: '', source: 'manual',
    sourceDetail: null, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z',
    ownerUserId: 'alice', ownerName: null, origin: 'personal', state: 'owned', assignmentStatus: null, canEdit: true, ...fields };
}
function command(contact: CenterContact, status: ContactCommand['status'] = 'pending', attempted = false): ContactCommand {
  return { id: `command-${contact.contactId}`, action: 'update', status, attempted, createdAt: '2026-10-16T00:00:00Z',
    input: { contactId: contact.contactId, customerId: contact.customerId, expectedVersion: 3,
      idempotencyKey: `key-${contact.contactId}`, fields: { firstName: 'preserve input' } } };
}
function audit(raw: NativeDatabase) {
  raw.exec(`CREATE TABLE mirror_changes(operation TEXT,contact_id INTEGER);
    CREATE TRIGGER refresh_insert AFTER INSERT ON crm_contact_mirror BEGIN INSERT INTO mirror_changes VALUES('insert',NEW.contact_id); END;
    CREATE TRIGGER refresh_update AFTER UPDATE ON crm_contact_mirror BEGIN INSERT INTO mirror_changes VALUES('update',NEW.contact_id); END;
    CREATE TRIGGER refresh_delete AFTER DELETE ON crm_contact_mirror BEGIN INSERT INTO mirror_changes VALUES('delete',OLD.contact_id); END;`);
  return () => raw.prepare('SELECT operation,contact_id FROM mirror_changes ORDER BY contact_id,operation').all();
}

describe('authoritative contact mirror refresh', () => {
  it('does not mutate unchanged rows or rebuild their expression indexes', () => {
    const { store, raw } = fixture(), rows = [row(1), row(2)];
    store.replaceContacts(ctx, rows);
    store.saveDetail(ctx, contactDetailSnapshot(rows[0]));
    const changes = audit(raw);
    // An index callback failing on an unchanged row also proves no hidden index rewrite occurs.
    raw.function('crm_contact_lower', { deterministic: true }, (_value: string | null) => { throw new Error('unchanged index rewritten'); });
    expect(() => store.replaceContacts(ctx, [...rows].reverse())).not.toThrow();
    expect(changes()).toEqual([]);
    expect(store.contacts(ctx)).toEqual(rows);
    expect(store.detail(ctx, rows[0])?.contact).toEqual(rows[0]);
    expect(store.ready(ctx)).toBe(true);
  });

  it('writes only changed/new/missing rows and accepts equal or lower authoritative versions', () => {
    const { store, raw } = fixture(), original = [row(1), row(2), row(3), row(4)];
    store.replaceContacts(ctx, original); const changes = audit(raw);
    const equal = row(2, { email: ' NEW@EXAMPLE.TEST ', firstName: 'equal version' });
    const lower = row(3, { customerVersion: 1, contactVersion: 1, firstName: 'lower version' });
    store.replaceContacts(ctx, [original[0], equal, lower, row(5)]);
    expect(changes()).toEqual([
      { operation: 'update', contact_id: 2 }, { operation: 'update', contact_id: 3 },
      { operation: 'delete', contact_id: 4 }, { operation: 'insert', contact_id: 5 },
    ]);
    expect(store.contacts(ctx)).toEqual([original[0], equal, lower, row(5)]);
    expect(store.findByEmail(ctx, 'new@example.test')).toEqual([equal]);
    expect(store.findByEmail(ctx, '2@example.test')).toEqual([]);
    expect(store.page(ctx, { search: 'lower version', offset: 0, limit: 10 }).items).toEqual([lower]);
  });

  it('preserves full-replacement duplicate ID precedence instead of comparing against prior cache versions', () => {
    const { store } = fixture(); store.replaceContacts(ctx, [row(1, { contactVersion: 20 })]);
    store.replaceContacts(ctx, [row(1, { contactVersion: 2 }), row(1, { contactVersion: 1 }), row(1, { contactVersion: 2, title: 'last equal' })]);
    expect(store.contact(ctx, row(1))).toEqual(row(1, { contactVersion: 2, title: 'last equal' }));
  });

  it('clears lost details and retires pending/conflict commands without losing their input', () => {
    const { store } = fixture(), rows = [row(1), row(2), row(3), row(4), row(5)];
    store.replaceContacts(ctx, rows);
    rows.forEach(contact => { store.saveDetail(ctx, contactDetailSnapshot(contact)); store.putCommand(ctx, command(contact, contact.contactId === 3 ? 'conflict' : 'pending', contact.contactId === 3)); });
    store.replaceContacts(ctx, [rows[0], row(2, { ownerUserId: 'bob' }), row(3, { canEdit: false }), row(4, { customerId: 'other-customer' })]);
    expect(store.detail(ctx, rows[0])).toBeDefined();
    for (const contact of rows.slice(1)) expect(store.detail(ctx, contact)).toBeUndefined();
    const commands = store.commandRows(ctx);
    expect(commands[0].status).toBe('pending');
    for (const contact of rows.slice(1)) {
      expect(commands.find(item => item.id === `command-${contact.contactId}`)).toMatchObject({
        status: 'failed', discardable: contact.contactId !== 3, input: command(contact).input,
        errorCode: contact.contactId >= 4 ? 'NOT_FOUND' : 'FORBIDDEN',
      });
    }
    store.replaceContacts(ctx, rows);
    expect(store.commandRows(ctx).slice(1).every(item => item.status === 'failed')).toBe(true);
  });

  it('runs permission-key cleanup even when every serialized contact stays unchanged', () => {
    const { store, raw } = fixture(), contact = row(1); store.replaceContacts(ctx, [contact]);
    store.saveDetail(ctx, contactDetailSnapshot(contact)); store.putCommand(ctx, command(contact));
    const changes = audit(raw), viewer = { ...ctx, permissionKey: 'viewer' };
    store.replaceContacts(viewer, [contact]);
    expect(changes()).toEqual([]);
    expect(store.detail(viewer, contact)).toBeUndefined();
    expect(store.commandRows(ctx)[0]).toMatchObject({ status: 'failed', input: command(contact).input });
    expect(store.ready(ctx)).toBe(false); expect(store.ready(viewer)).toBe(true);
  });

  it('blocks removed-contact mail while preserving the authorized outbound archive exception', () => {
    const { store, raw } = fixture(), contact = row(1); store.replaceContacts(ctx, [contact]);
    const events = [
      { eventKey: 'inbound', kind: 'received', direction: 'inbound' },
      { eventKey: 'plain-sent', kind: 'sent', direction: 'outbound' },
      { eventKey: 'archive', kind: 'sent', direction: 'outbound', sendAuthorizationId: 'authorized-test-send' },
      { eventKey: 'wrong-direction', kind: 'sent', direction: 'inbound', sendAuthorizationId: 'authorized-test-send' },
    ];
    const insert = raw.prepare('INSERT INTO crm_contact_mail_events(event_key,payload) VALUES(?,?)');
    events.forEach(event => insert.run(event.eventKey, JSON.stringify({ ...event, contactId: 1, customerId: 'customer-1' })));
    store.replaceContacts(ctx, []);
    expect(raw.prepare('SELECT event_key,status FROM crm_contact_mail_events ORDER BY event_key').all()).toEqual([
      { event_key: 'archive', status: 'pending' }, { event_key: 'inbound', status: 'blocked' },
      { event_key: 'plain-sent', status: 'blocked' }, { event_key: 'wrong-direction', status: 'blocked' },
    ]);
    expect(store.contacts(ctx)).toEqual([]); expect(store.ready(ctx)).toBe(true);
  });

  it('rolls back contacts, details, mail status, metadata and command retirement together', () => {
    const { store, raw } = fixture(), rows = [row(1), row(2)]; store.replaceContacts(ctx, rows);
    store.saveDetail(ctx, contactDetailSnapshot(rows[0])); store.putCommand(ctx, command(rows[0]));
    raw.prepare('INSERT INTO crm_contact_mail_events(event_key,payload) VALUES(?,?)').run('pending', JSON.stringify({ contactId: 2, customerId: 'customer-2', kind: 'received', direction: 'inbound' }));
    raw.exec("CREATE TRIGGER reject_retirement BEFORE UPDATE ON crm_contact_commands BEGIN SELECT RAISE(ABORT,'forced retirement failure'); END");
    expect(() => store.replaceContacts({ ...ctx, permissionKey: 'viewer' }, [row(1, { canEdit: false })])).toThrow('forced retirement failure');
    expect(store.contacts(ctx)).toEqual(rows); expect(store.ready(ctx)).toBe(true);
    expect(store.detail(ctx, rows[0])).toBeDefined(); expect(store.commandRows(ctx)[0].status).toBe('pending');
    expect(raw.prepare('SELECT status FROM crm_contact_mail_events').get()).toEqual({ status: 'pending' });
  });

  it('does not commit a stale diff when a second WAL connection writes after its comparison read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'prospector-refresh-')); directories.push(directory);
    const file = join(directory, 'isolated.db');
    const reader = fixture(new DatabaseSync(file)); reader.raw.exec('PRAGMA journal_mode=WAL');
    const writer = fixture(new DatabaseSync(file)), contact = row(1);
    reader.store.replaceContacts(ctx, [contact]);
    const prepare = reader.db.prepare.bind(reader.db); let interleaved = false;
    vi.spyOn(reader.db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (sql.startsWith('SELECT') && sql.includes('FROM crm_contact_mirror') && !interleaved) {
        const all = statement.all.bind(statement);
        statement.all = ((...parameters: unknown[]) => {
          const result = all(...parameters);
          if (!interleaved) { interleaved = true; writer.store.replaceContacts(ctx, [row(1, { title: 'second writer' }), row(2)]); }
          return result;
        }) as typeof statement.all;
      }
      return statement;
    }) as typeof reader.db.prepare);
    expect(() => reader.store.replaceContacts(ctx, [row(1, { title: 'stale refresh' })])).toThrow();
    expect(interleaved).toBe(true);
    expect(writer.store.contacts(ctx)).toEqual([row(1, { title: 'second writer' }), row(2)]);
  });
});
