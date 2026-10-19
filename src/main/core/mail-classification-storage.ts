export const MAIL_CLASSIFICATION_CHANGES_DDL=`CREATE TABLE IF NOT EXISTS inbox_classification_changes (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  change_key text NOT NULL UNIQUE,
  center_scope text NOT NULL,
  message_id integer NOT NULL,
  source_json text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
);`;
