import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { MAIL_ANALYSIS_QUEUE_DDL } from '../../src/main/core/mail-analysis-queue-storage';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

describe('mail analysis queue storage', () => {
  it('creates the job table and rejects unknown states', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(MAIL_ANALYSIS_QUEUE_DDL);
    db.prepare("INSERT INTO mail_analysis_jobs(job_key,payload_json,status) VALUES(?,?,?)").run('job-1', '{}', 'pending');
    expect(db.prepare("SELECT status FROM mail_analysis_jobs WHERE job_key='job-1'").get()).toMatchObject({ status: 'pending' });
    expect(() => db.prepare("INSERT INTO mail_analysis_jobs(job_key,payload_json,status) VALUES(?,?,?)").run('job-2', '{}', 'unknown')).toThrow();
    db.close();
  });
});
