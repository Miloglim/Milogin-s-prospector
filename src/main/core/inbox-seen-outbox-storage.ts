export const INBOX_SEEN_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS inbox_seen_outbox (
  account_id INTEGER NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(account_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_inbox_seen_outbox_updated
  ON inbox_seen_outbox(account_id, updated_at ASC);
`;
