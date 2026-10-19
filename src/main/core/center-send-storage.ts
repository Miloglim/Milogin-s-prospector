/** Durable outbound facts are local until the center acknowledges them. Never discard as cache. */
export const CENTER_SEND_RECEIPT_DDL = `CREATE TABLE IF NOT EXISTS crm_send_receipts (
  send_key TEXT PRIMARY KEY NOT NULL,
  center_scope TEXT NOT NULL,
  payload TEXT NOT NULL,
  mail_ids TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  synced_at TEXT,
  history_hidden INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_crm_send_receipts_pending ON crm_send_receipts(center_scope,synced_at);`;
export const CENTER_SEND_RECEIPT_LIMIT = 100;
export const LOCAL_SENT_PREVIEW_LENGTH = 500;
/** Attempt metadata is durable before SMTP and is never a reusable permission grant. */
export const CENTER_SEND_AUTHORIZATION_DDL = `CREATE TABLE IF NOT EXISTS crm_send_authorizations (
  send_key TEXT NOT NULL,
  center_scope TEXT NOT NULL,
  payload TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (send_key,center_scope)
);`;
