import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { createLegacyContactSyncStore } from '../../src/main/adapters/legacy-contact-sync-store.adapter';
import { LEGACY_CONTACT_MAP_DDL } from '../../src/main/core/legacy-contact-map';

let SqlJs: typeof import('sql.js').default;
beforeAll(async () => { SqlJs = await initSqlJs({ locateFile: file => `${process.cwd()}/node_modules/sql.js/dist/${file}` }); });

function rawShim(raw: SqlJsDatabase) {
  return {
    exec: (sql: string) => raw.run(sql),
    prepare(sql: string) {
      const all = (...params: unknown[]) => { const statement = raw.prepare(sql); statement.bind(params as never); const rows: unknown[] = []; while (statement.step()) rows.push(statement.getAsObject()); statement.free(); return rows; };
      return {
        all,
        get: (...params: unknown[]) => { const rows = all(...params) as unknown[]; return rows[0] ?? undefined; },
        run: (...params: unknown[]) => { raw.run(sql, params as never[]); return { changes: raw.getRowsModified() }; },
      };
    },
    transaction: (fn: () => void) => () => fn(),
  };
}

describe('legacy contact sync queue', () => {
  it('enqueues only unmatched contacts and settles successful receipts', () => {
    const db = rawShim(new SqlJs.Database());
    db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE contacts(id INTEGER PRIMARY KEY, company_id INTEGER, email TEXT, first_name TEXT, last_name TEXT, title TEXT, phone TEXT, linkedin TEXT, country TEXT, client_type TEXT, language TEXT, stage TEXT, status TEXT, tags TEXT, source TEXT);
      ${LEGACY_CONTACT_MAP_DDL}
      INSERT INTO companies(id,name) VALUES(1,'Acme');
      INSERT INTO contacts(id,company_id,email,first_name,tags,source) VALUES(7,1,'a@example.com','Ana','["priority"]','manual');
      INSERT INTO crm_legacy_contact_map(local_contact_id,state,matched_at) VALUES(7,'unmatched','2026-10-16');`);
    const store = createLegacyContactSyncStore(db as never);
    expect(store.enqueueUnmatched()).toBe(1);
    expect(store.enqueueUnmatched()).toBe(0);
    expect(store.pending()).toMatchObject([{ localContactId: 7, payload: { companyName: 'Acme', email: 'a@example.com', tags: ['priority'] } }]);
    store.mark([7], 'synced');
    expect(store.pending()).toEqual([]);
  });

  it('keeps a deferred item pending for a later retry', () => {
    const db = rawShim(new SqlJs.Database());
    db.exec(`CREATE TABLE companies(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE contacts(id INTEGER PRIMARY KEY, company_id INTEGER, email TEXT, first_name TEXT, last_name TEXT, title TEXT, phone TEXT, linkedin TEXT, country TEXT, client_type TEXT, language TEXT, stage TEXT, status TEXT, tags TEXT, source TEXT);
      ${LEGACY_CONTACT_MAP_DDL}
      INSERT INTO companies(id,name) VALUES(1,'Acme');
      INSERT INTO contacts(id,company_id,email) VALUES(7,1,'a@example.com');
      INSERT INTO crm_legacy_contact_map(local_contact_id,state,matched_at) VALUES(7,'unmatched','2026-10-16');`);
    const store = createLegacyContactSyncStore(db as never);
    store.enqueueUnmatched();
    store.defer([7], 'center offline');
    expect(store.pending()[0]?.attempts).toBe(0);
    expect(db.prepare('SELECT last_error FROM crm_legacy_contact_sync WHERE local_contact_id=7').get()).toEqual({ last_error: 'center offline' });
  });
});
