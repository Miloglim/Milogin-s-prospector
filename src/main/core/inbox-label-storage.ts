export const INBOX_LABEL_DDL = `
CREATE TABLE IF NOT EXISTS inbox_labels (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL,
  color text NOT NULL,
  source text DEFAULT 'user' NOT NULL,
  status text DEFAULT 'active' NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_labels_name ON inbox_labels(lower(name));
CREATE TABLE IF NOT EXISTS inbox_message_labels (
  message_id integer NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  label_id integer NOT NULL REFERENCES inbox_labels(id) ON DELETE CASCADE,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (message_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_inbox_message_labels_label ON inbox_message_labels(label_id, message_id);
CREATE TABLE IF NOT EXISTS inbox_label_operations (
  operation_key text PRIMARY KEY NOT NULL,
  result_json text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_label_candidates (
  label_id integer NOT NULL REFERENCES inbox_labels(id) ON DELETE CASCADE,
  message_id integer NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  PRIMARY KEY (label_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_inbox_label_candidates_message ON inbox_label_candidates(message_id);
CREATE TABLE IF NOT EXISTS inbox_pinned_messages (
  message_id integer PRIMARY KEY NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_folder_suggestion_dismissals (
  normalized_name text PRIMARY KEY NOT NULL,
  dismissed_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
`;
