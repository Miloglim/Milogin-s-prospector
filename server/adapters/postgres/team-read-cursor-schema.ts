export const TEAM_READ_CURSOR_VERSION = '072-team-message-read-cursor';

export const TEAM_READ_CURSOR_SQL = `
ALTER TABLE crm_team_message_reads
  ADD COLUMN IF NOT EXISTS last_read_message_id uuid REFERENCES crm_team_messages(message_id);

UPDATE crm_team_message_reads receipt
SET last_read_message_id = (
  SELECT m.message_id
  FROM crm_team_messages m
  WHERE m.team_id=receipt.team_id
    AND ((m.sender_user_id=receipt.user_id AND m.recipient_user_id=receipt.peer_user_id)
      OR (m.sender_user_id=receipt.peer_user_id AND m.recipient_user_id=receipt.user_id))
    AND m.created_at<=receipt.last_read_at
  ORDER BY m.created_at DESC,m.message_id DESC
  LIMIT 1
)
WHERE receipt.last_read_message_id IS NULL;
`;
