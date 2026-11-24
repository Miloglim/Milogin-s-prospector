import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';

export const TASK_MAIL_LINK_VERSION = '073-task-mail-link';

export const TASK_MAIL_LINK_SQL = `
ALTER TABLE crm_followup_tasks
  ADD COLUMN IF NOT EXISTS source_message_key text,
  DROP CONSTRAINT IF EXISTS crm_followup_tasks_source_kind_check,
  ADD CONSTRAINT crm_followup_tasks_source_kind_check CHECK(source_kind IS NULL OR source_kind IN ('mail_analysis','mail_manual')),
  DROP CONSTRAINT IF EXISTS crm_followup_tasks_mail_source_complete,
  ADD CONSTRAINT crm_followup_tasks_mail_source_complete CHECK(
    source_kind IS DISTINCT FROM 'mail_analysis' OR (
      source_suggestion_id IS NOT NULL AND source_analysis_id IS NOT NULL
      AND source_contact_id IS NOT NULL AND btrim(source_thread_key)<>''
      AND btrim(source_action_code)<>'' AND source_responsible_user_id IS NOT NULL
    )
  );
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_followup_tasks_open_mail_message
  ON crm_followup_tasks(customer_id,source_message_key)
  WHERE source_kind='mail_manual' AND source_message_key IS NOT NULL AND status='open';
`;

export async function migrateTaskMailLinkSchema(client: PoolClient): Promise<Result<void>> {
  const checksum = createHash('sha256').update(TASK_MAIL_LINK_SQL).digest('hex');
  const old = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [TASK_MAIL_LINK_VERSION]);
  if (old.rows.length) return old.rows[0].checksum === checksum ? success(undefined) : failure('CONFLICT', '任务邮件关联迁移校验不一致');
  await client.query(TASK_MAIL_LINK_SQL);
  await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [TASK_MAIL_LINK_VERSION, checksum]);
  return success(undefined);
}
