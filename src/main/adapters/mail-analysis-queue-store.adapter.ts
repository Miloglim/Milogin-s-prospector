import { getRawDb } from '../db';
import { Log } from '../logger';
import type {
  MailAnalysisJobStatus,
  MailAnalysisQueueInput,
  MailAnalysisQueueStore,
  MailAnalysisQueueStoredJob,
} from '../services/mail-analysis-queue.service';

const COMPLETED_RETENTION = "-7 days";
const FAILED_RETENTION = "-30 days";

interface JobRow {
  jobKey: string;
  payloadJson: string;
  status: MailAnalysisJobStatus;
  attempt: number;
  nextAttemptAt: string | null;
  lastError: string | null;
}

export function createMailAnalysisQueueStore(): MailAnalysisQueueStore {
  const raw = () => getRawDb();
  return {
    save(job: MailAnalysisQueueStoredJob): void {
      raw().prepare(`INSERT INTO mail_analysis_jobs
        (job_key,payload_json,status,attempt,next_attempt_at,last_error,completed_at,updated_at)
        VALUES (?,?,?,?,?,?,CASE WHEN ?='completed' THEN CURRENT_TIMESTAMP ELSE NULL END,CURRENT_TIMESTAMP)
        ON CONFLICT(job_key) DO UPDATE SET payload_json=excluded.payload_json,status=excluded.status,
          attempt=excluded.attempt,next_attempt_at=excluded.next_attempt_at,last_error=excluded.last_error,
          completed_at=CASE WHEN excluded.status='completed' THEN CURRENT_TIMESTAMP ELSE mail_analysis_jobs.completed_at END,
          updated_at=CURRENT_TIMESTAMP`)
        .run(job.key, JSON.stringify(job.input), job.status, job.attempt, job.nextAttemptAt, job.lastError, job.status);
    },
    recoverable(): MailAnalysisQueueStoredJob[] {
      raw().prepare("UPDATE mail_analysis_jobs SET status='pending',next_attempt_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE status='running'").run();
      const rows = raw().prepare(`SELECT job_key AS jobKey,payload_json AS payloadJson,status,attempt,
        next_attempt_at AS nextAttemptAt,last_error AS lastError
        FROM mail_analysis_jobs WHERE status IN ('pending','retrying')
        ORDER BY created_at,job_key LIMIT 1000`).all() as JobRow[];
      const result: MailAnalysisQueueStoredJob[] = [];
      for (const row of rows) {
        try {
          const input = JSON.parse(row.payloadJson) as MailAnalysisQueueInput;
          result.push({ key: row.jobKey, input, status: row.status, attempt: Number(row.attempt), nextAttemptAt: row.nextAttemptAt, lastError: row.lastError });
        } catch (error) {
          raw().prepare("UPDATE mail_analysis_jobs SET status='failed',last_error=?,updated_at=CURRENT_TIMESTAMP WHERE job_key=?")
            .run('持久化任务无法解析', row.jobKey);
          Log.warn('mail.analysis.queue', `分析任务恢复失败 ${row.jobKey}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return result;
    },
    prune(): void {
      raw().prepare("DELETE FROM mail_analysis_jobs WHERE status='completed' AND updated_at < datetime('now', ?)").run(COMPLETED_RETENTION);
      raw().prepare("DELETE FROM mail_analysis_jobs WHERE status='failed' AND updated_at < datetime('now', ?)").run(FAILED_RETENTION);
    },
  };
}
