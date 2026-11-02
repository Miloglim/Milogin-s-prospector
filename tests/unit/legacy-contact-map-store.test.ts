import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from 'sql.js';
import { resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { createLegacyContactMapStore } from '../../src/main/adapters/legacy-contact-map-store.adapter';

let SQL: SqlJsStatic;
const databases: SqlDatabase[] = [];
beforeAll(async () => { SQL = await initSqlJs({ locateFile: file => resolve('node_modules/sql.js/dist', file) }); });
afterEach(() => { for (const db of databases) db.close(); databases.length = 0; });

function fixture() {
  const raw = new SQL.Database(); databases.push(raw);
  raw.run('CREATE TABLE contacts(id INTEGER PRIMARY KEY,email TEXT)');
  raw.run('INSERT INTO contacts(id,email) VALUES(1,\'owned@example.test\'),(2,\'other@example.test\'),(3,\'ambiguous@example.test\')');
  const db = {
    exec: (sql: string) => { raw.run(sql); },
    prepare(sql: string) {
      const all = (...args: unknown[]) => {
        const statement = raw.prepare(sql);
        try { statement.bind(args as never); const rows: unknown[] = []; while (statement.step()) rows.push(statement.getAsObject()); return rows; }
        finally { statement.free(); }
      };
      return { all, get: (...args: unknown[]) => all(...args)[0], run: (...args: unknown[]) => { raw.run(sql, args as never); return { changes: raw.getRowsModified() }; } };
    },
    transaction: (work: (...args: unknown[]) => unknown) => (...args: unknown[]) => { raw.run('BEGIN'); try { const value = work(...args); raw.run('COMMIT'); return value; } catch (error) { raw.run('ROLLBACK'); throw error; } },
  } as unknown as Database;
  const store = createLegacyContactMapStore(db);
  return { raw, store };
}

describe('legacy contact physical cleanup', () => {
  it('deletes only the local contact uniquely mapped to the deleted center reference', () => {
    const { raw, store } = fixture();
    const now = '2026-11-02T00:00:00.000Z';
    store.reconcile([
      { customerId: 'customer-1', contactId: 11, email: 'owned@example.test' },
      { customerId: 'customer-2', contactId: 12, email: 'other@example.test' },
      { customerId: 'customer-3', contactId: 13, email: 'ambiguous@example.test' },
      { customerId: 'customer-4', contactId: 14, email: 'ambiguous@example.test' },
    ], now);
    const removed = store.purgeMappedContacts([{ customerId: 'customer-1', contactId: 11 }], ids => {
      for (const id of ids) raw.run('DELETE FROM contacts WHERE id=?', [id]);
      return true;
    });
    expect(removed).toEqual([1]);
    expect(raw.exec('SELECT id FROM contacts ORDER BY id')[0]?.values).toEqual([[2], [3]]);
    expect(store.localContactIds([{ customerId: 'customer-1', contactId: 11 }])).toEqual([]);

    expect(store.purgeMappedContacts([{ customerId: 'customer-2', contactId: 12 }], () => false)).toEqual([]);
    expect(store.localContactIds([{ customerId: 'customer-2', contactId: 12 }])).toEqual([2]);
  });
});
