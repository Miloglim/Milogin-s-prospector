export const INBOX_TODO_DDL = `
CREATE TABLE IF NOT EXISTS inbox_todo_states (
  message_id INTEGER PRIMARY KEY REFERENCES inbox_messages(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('open','done')),
  operation_key TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inbox_todo_states_state
  ON inbox_todo_states(state, updated_at DESC);
`;
