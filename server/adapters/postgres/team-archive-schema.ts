export const TEAM_ARCHIVE_VERSION = '075-team-archives';

export const TEAM_ARCHIVE_SQL = `
ALTER TABLE crm_team_files DROP CONSTRAINT IF EXISTS crm_team_files_purpose_check;
ALTER TABLE crm_team_files ADD CONSTRAINT crm_team_files_purpose_check CHECK(purpose IN ('team_attachment','team_archive'));
`;
