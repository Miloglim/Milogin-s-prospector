import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { INBOX_TODO_DDL } from '../../src/main/core/inbox-todo-storage';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

describe('inbox todo storage', () => {
  it('creates message-scoped todo state and rejects unknown states', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('CREATE TABLE inbox_messages(id INTEGER PRIMARY KEY); INSERT INTO inbox_messages(id) VALUES(1)');
    db.exec(INBOX_TODO_DDL);
    db.prepare('INSERT INTO inbox_todo_states(message_id,state,operation_key) VALUES(?,?,?)').run(1, 'done', 'operation-1');
    expect(db.prepare('SELECT state FROM inbox_todo_states WHERE message_id=1').get()).toMatchObject({ state: 'done' });
    expect(() => db.prepare('INSERT INTO inbox_todo_states(message_id,state,operation_key) VALUES(?,?,?)').run(1, 'unknown', 'operation-2')).toThrow();
    db.close();
  });
});
