export const INBOX_CONVERSATION_STATE_DDL = `
CREATE TABLE IF NOT EXISTS inbox_conversation_states (
  conversation_key TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('todo','needs_reply','waiting_other','important')),
  source_message_id INTEGER REFERENCES inbox_messages(id) ON DELETE SET NULL,
  operation_key TEXT NOT NULL UNIQUE,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inbox_conversation_states_state
  ON inbox_conversation_states(state, updated_at DESC);
`;
