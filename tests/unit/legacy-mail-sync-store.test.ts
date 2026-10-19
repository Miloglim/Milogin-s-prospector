import { beforeAll, describe, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { createLegacyMailSyncStore } from '../../src/main/adapters/legacy-mail-sync-store.adapter';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;

function rawShim(db: SqlJsDatabase) {
  return {
    exec: (sql: string) => db.run(sql),
    prepare(sql: string) {
      return {
        all: (...params: unknown[]) => {
          const statement = db.prepare(sql);
          statement.bind(params as never);
          const rows: Record<string, unknown>[] = [];
          while (statement.step()) rows.push(statement.getAsObject() as Record<string, unknown>);
          statement.free();
          return rows;
        },
        run: (...params: unknown[]) => {
          db.run(sql, params as never);
          return { changes: db.getRowsModified() };
        },
      };
    },
    transaction: (work: () => number) => () => work(),
  };
}

function fixture() {
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE contacts (id INTEGER PRIMARY KEY, email TEXT NOT NULL, first_name TEXT);
    CREATE TABLE email_accounts (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE interactions (id INTEGER PRIMARY KEY, contact_id INTEGER NOT NULL, type TEXT NOT NULL,
      direction TEXT NOT NULL, created_at TEXT NOT NULL, subject TEXT, body_preview TEXT, message_id TEXT, account_id INTEGER);
    CREATE TABLE inbox_messages (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, matched_contact_id INTEGER,
      from_email TEXT NOT NULL, subject TEXT, body_preview TEXT, classification TEXT, "to" TEXT, message_id TEXT, received_at TEXT NOT NULL);
    CREATE TABLE crm_legacy_contact_map (local_contact_id INTEGER PRIMARY KEY, center_contact_id INTEGER NOT NULL,
      center_customer_id TEXT NOT NULL, state TEXT NOT NULL);
  `);
  db.run("INSERT INTO contacts VALUES (1,'client@example.invalid','Client')");
  db.run("INSERT INTO email_accounts VALUES (7,'sales@example.invalid')");
  db.run("INSERT INTO crm_legacy_contact_map VALUES (1,101,'customer-101','mapped')");
  db.run("INSERT INTO interactions VALUES (11,1,'sent','outbound','2026-10-17T08:00:00Z','Quote','private body preview','<sent-11>',7)");
  db.run("INSERT INTO interactions VALUES (12,1,'replied','inbound','2026-10-17T09:00:00Z','Reply','reply preview','<reply-12>',7)");
  db.run("INSERT INTO inbox_messages VALUES (21,7,1,'client@example.invalid','Incoming','inbox preview','other','sales@example.invalid','<inbox-21>','2026-10-17T10:00:00Z')");
  return { db, raw: rawShim(db) };
}

beforeAll(async () => {
  SQL = await initSqlJs({ locateFile: file => `node_modules/sql.js/dist/${file}` });
});

describe('legacy mail SQLite queue simulation', () => {
  it('converts local sent/replied/inbox rows, deduplicates rescans and keeps offline work pending', () => {
    const { db, raw } = fixture();
    const store = createLegacyMailSyncStore(raw as never);
    expect(store.enqueueMapped()).toBe(3);
    expect(store.enqueueMapped()).toBe(0);
    const first = store.pending();
    expect(first).toHaveLength(3);
    expect(first.map(item => item.payload.eventKey).sort()).toEqual([
      'legacy-inbox-21', 'legacy-interaction-11', 'legacy-interaction-12',
    ]);
    expect(first.find(item => item.eventKey === 'legacy-interaction-11')?.payload.preview).toBe('private body preview');
    expect(first.find(item => item.eventKey === 'legacy-interaction-11')?.payload.fromEmail).toBe('sales@example.invalid');
    expect(first.find(item => item.eventKey === 'legacy-inbox-21')?.payload.direction).toBe('inbound');
    store.mark('legacy-interaction-11', 'synced');
    store.defer('legacy-interaction-12', '中心连接中断');
    expect(store.pending().map(item => item.eventKey)).toEqual(['legacy-inbox-21', 'legacy-interaction-12']);
    db.close();
  });
});
