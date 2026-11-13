export const INBOX_ANALYSIS_DDL = `
CREATE TABLE IF NOT EXISTS inbox_mail_analyses (
  message_id INTEGER PRIMARY KEY REFERENCES inbox_messages(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  requires_action INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  next_action TEXT,
  due_hint TEXT,
  confidence REAL NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'ai',
  analyzer_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inbox_mail_analyses_status
  ON inbox_mail_analyses(status, updated_at DESC);
`;
