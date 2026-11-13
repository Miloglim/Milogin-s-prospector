export const MAIL_ANALYSIS_QUEUE_DDL = `
CREATE TABLE IF NOT EXISTS mail_analysis_jobs (
  job_key TEXT PRIMARY KEY NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','running','retrying','completed','failed')),
  attempt INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mail_analysis_jobs_status
  ON mail_analysis_jobs(status, next_attempt_at, created_at);
`;
