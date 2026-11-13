import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { INBOX_LABEL_DDL } from '../../src/main/core/inbox-label-storage';

const root = resolve(__dirname, '../..');
const storage = readFileSync(resolve(root, 'src/main/core/inbox-label-storage.ts'), 'utf8');
const schema = readFileSync(resolve(root, 'src/main/db/schema-sql.ts'), 'utf8');
const database = readFileSync(resolve(root, 'src/main/db/index.ts'), 'utf8');
const contract = readFileSync(resolve(root, 'src/main/contract.ts'), 'utf8');

describe('inbox user label storage contract', () => {
  it('defines durable labels and message-label links', () => {
    expect(storage).toContain('CREATE TABLE IF NOT EXISTS inbox_labels');
    expect(storage).toContain('CREATE TABLE IF NOT EXISTS inbox_message_labels');
    expect(storage).toContain('CREATE TABLE IF NOT EXISTS inbox_label_operations');
    expect(storage).toContain('CREATE TABLE IF NOT EXISTS inbox_label_candidates');
    expect(storage).toContain('CREATE TABLE IF NOT EXISTS inbox_pinned_messages');
    expect(storage).toContain('CREATE TABLE IF NOT EXISTS inbox_folder_suggestion_dismissals');
    expect(storage).toContain('REFERENCES inbox_messages(id) ON DELETE CASCADE');
    expect(storage).toContain('REFERENCES inbox_labels(id) ON DELETE CASCADE');
    expect(storage).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_labels_name');
    expect(schema).toContain('${INBOX_LABEL_DDL}');
    expect(database).toContain("step('v0.71-inbox-labels'");
    expect(database).toContain("step('v0.71-inbox-label-operations'");
    expect(database).toContain("step('v0.72-inbox-folders'");
  });

  it('exposes explicit IPC channels for label management', () => {
    for (const channel of ['LABELS', 'LABEL_SAVE', 'LABEL_DELETE', 'MESSAGE_LABELS', 'FOLDER_SUGGEST', 'FOLDER_CONFIRM', 'PIN_MESSAGE']) expect(contract).toContain(`${channel}:`);
  });

  it('executes folder, candidate, dismissal and pin tables against SQLite', async () => {
    const SQL = await initSqlJs({ locateFile: file => resolve(root, 'node_modules/sql.js/dist', file) });
    const db = new SQL.Database();
    db.run('CREATE TABLE inbox_messages (id integer PRIMARY KEY NOT NULL)');
    db.run(INBOX_LABEL_DDL);
    db.run("INSERT INTO inbox_messages(id) VALUES(1),(2)");
    db.run("INSERT INTO inbox_labels(name,color,source,status) VALUES('Acme','#2563eb','ai','suggested')");
    db.run('INSERT INTO inbox_label_candidates(label_id,message_id) VALUES(1,1),(1,2)');
    db.run('INSERT INTO inbox_pinned_messages(message_id) VALUES(1)');
    db.run("INSERT INTO inbox_folder_suggestion_dismissals(normalized_name) VALUES('other')");
    expect(db.exec('SELECT source,status FROM inbox_labels')[0]!.values[0]).toEqual(['ai', 'suggested']);
    expect(db.exec('SELECT COUNT(*) FROM inbox_label_candidates')[0]!.values[0]![0]).toBe(2);
    expect(db.exec('SELECT COUNT(*) FROM inbox_pinned_messages')[0]!.values[0]![0]).toBe(1);
    db.close();
  });
});
