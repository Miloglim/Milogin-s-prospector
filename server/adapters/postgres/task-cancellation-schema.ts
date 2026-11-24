import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';
import { TASK_LIMITS } from '../../core/tasks';

export const TASK_CANCELLATION_VERSION = '070-task-cancellation';

const SQL = `
ALTER TABLE crm_followup_tasks DROP CONSTRAINT IF EXISTS crm_followup_tasks_status_check;
ALTER TABLE crm_followup_tasks DROP CONSTRAINT IF EXISTS crm_followup_tasks_check;
ALTER TABLE crm_followup_tasks ADD CONSTRAINT crm_followup_tasks_status_check CHECK(status IN ('open','completed','cancelled'));
ALTER TABLE crm_followup_tasks ADD CONSTRAINT crm_followup_tasks_check CHECK(
  (status='open' AND completed_at IS NULL AND completed_by IS NULL AND feedback IS NULL)
  OR (status IN ('completed','cancelled') AND completed_at IS NOT NULL AND completed_by IS NOT NULL
      AND feedback IS NOT NULL AND btrim(feedback)<>'' AND length(feedback)<=${TASK_LIMITS.feedback})
);
`;

export async function migrateTaskCancellationSchema(client: PoolClient): Promise<Result<void>> {
  const checksum = createHash('sha256').update(SQL).digest('hex');
  const old = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [TASK_CANCELLATION_VERSION]);
  if (old.rows.length) return old.rows[0].checksum === checksum ? success(undefined) : failure('CONFLICT', '任务取消迁移校验不一致');
  await client.query(SQL);
  await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [TASK_CANCELLATION_VERSION, checksum]);
  return success(undefined);
}
