export const TEAM_EMAIL_REFERENCE_VERSION = '076-team-email-reference';

export const TEAM_EMAIL_REFERENCE_SQL = `
ALTER TABLE crm_team_messages DROP CONSTRAINT IF EXISTS crm_team_messages_kind_check;
ALTER TABLE crm_team_messages ADD CONSTRAINT crm_team_messages_kind_check CHECK(kind IN ('text','attachment','email_ref'));
`;
