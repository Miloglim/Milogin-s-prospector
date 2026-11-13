import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { INBOX_SEEN_OUTBOX_DDL } from '../../src/main/core/inbox-seen-outbox-storage';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

describe('inbox seen outbox storage', () => {
  it('persists one pending seen write per account and message', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec('CREATE TABLE email_accounts(id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO email_accounts(id) VALUES(1)').run();
    db.exec(INBOX_SEEN_OUTBOX_DDL);
    db.prepare('INSERT INTO inbox_seen_outbox(account_id,message_id) VALUES(?,?)').run(1, 'message-a');
    db.prepare('INSERT INTO inbox_seen_outbox(account_id,message_id) VALUES(?,?) ON CONFLICT(account_id,message_id) DO UPDATE SET attempts=attempts+1').run(1, 'message-a');
    expect(db.prepare('SELECT account_id AS accountId,message_id AS messageId,attempts FROM inbox_seen_outbox').all()).toEqual([{ accountId: 1, messageId: 'message-a', attempts: 1 }]);
    db.close();
  });
});
