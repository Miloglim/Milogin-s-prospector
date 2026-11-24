import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import {
  SAMPLE_MAIL_LIMITS,
  type SampleMailPackageMeta,
  type SampleMailUpload,
} from '../../core/sample-mail';
import { assertCenterDatabasePool } from './config';
import { SAMPLE_MAIL_SCHEMA_SQL, SAMPLE_MAIL_SCHEMA_VERSION } from './sample-mail-schema';

const SAMPLE_ROOT = process.env.PROSPECTOR_SAMPLE_MAIL_ROOT ?? join(process.cwd(), 'data', 'sample-mail');
const SCHEMA_LOCK = 19041075;
const BASE64_CHARS = /^[A-Za-z0-9+/]+={0,2}$/;

interface SampleActor { userId: string; identityAdmin: boolean }
interface SampleRow {
  packageId: string; accountEmail: string; filename: string; messageCount: number;
  bytes: string | number; sha256: string; storageKey: string; rangeFrom: string | null;
  rangeTo: string | null; note: string; createdAt: Date; expiresAt: Date;
}

const meta = (row: SampleRow): SampleMailPackageMeta => ({
  packageId: String(row.packageId),
  accountEmail: String(row.accountEmail),
  filename: String(row.filename),
  messageCount: Number(row.messageCount),
  bytes: Number(row.bytes),
  sha256: String(row.sha256),
  rangeFrom: row.rangeFrom ?? null,
  rangeTo: row.rangeTo ?? null,
  note: String(row.note ?? ''),
  createdAt: new Date(row.createdAt).toISOString(),
  expiresAt: new Date(row.expiresAt).toISOString(),
});

const COLUMNS = `package_id AS "packageId",account_email AS "accountEmail",filename,message_count AS "messageCount",
  bytes,sha256,storage_key AS "storageKey",range_from AS "rangeFrom",range_to AS "rangeTo",note,
  created_at AS "createdAt",expires_at AS "expiresAt"`;
const SELECT = `SELECT ${COLUMNS} FROM crm_sample_mail_packages`;

export class PostgresSampleMailRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) {
    assertCenterDatabasePool(pool);
  }

  async migrate(): Promise<Result<void>> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
      await client.query(SAMPLE_MAIL_SCHEMA_SQL);
      await client.query('COMMIT');
      return success(undefined);
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { /* transaction already disposed */ }
      this.log.write('ERROR', 'sample-mail.migrate', `样例邮件迁移失败 ${SAMPLE_MAIL_SCHEMA_VERSION} (${error instanceof Error ? error.name : 'unknown'})`);
      return failure('DATABASE_ERROR', '样例邮件迁移失败');
    } finally {
      client?.release();
    }
  }

  private async actor(client: PoolClient, tokenHash: string): Promise<SampleActor | null> {
    const row = (await client.query(`SELECT u.user_id AS "userId",u.identity_admin AS "identityAdmin"
      FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
      WHERE s.token_hash=$1 AND s.client='api' AND s.revoked_at IS NULL AND s.expires_at>now()
        AND u.active AND NOT u.must_change_password AND s.security_revision=u.security_revision`, [tokenHash])).rows[0];
    return row ? { userId: String(row.userId), identityAdmin: Boolean(row.identityAdmin) } : null;
  }

  private async authorize<T>(tokenHash: string, work: (client: PoolClient, actor: SampleActor) => Promise<Result<T>>): Promise<Result<T>> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const actor = await this.actor(client, tokenHash);
      if (!actor) return failure('FORBIDDEN', '当前账号没有样例邮件权限');
      return await work(client, actor);
    } catch (error) {
      this.log.write('ERROR', 'sample-mail.auth', `样例邮件鉴权失败 (${error instanceof Error ? error.message : 'unknown'})`);
      return failure('DATABASE_ERROR', '样例邮件鉴权失败');
    } finally {
      client?.release();
    }
  }

  upload(tokenHash: string, input: SampleMailUpload): Promise<Result<SampleMailPackageMeta>> {
    return this.authorize(tokenHash, async (client, actor) => {
      if (!BASE64_CHARS.test(input.base64)) return failure('INVALID_INPUT', '样例内容编码无效');
      const data = Buffer.from(input.base64, 'base64');
      if (!data.length || data.length > SAMPLE_MAIL_LIMITS.packageBytes) return failure('INVALID_INPUT', '样例包大小无效');
      const sha256 = createHash('sha256').update(data).digest('hex');
      const duplicate = (await client.query(`${SELECT} WHERE owner_user_id=$1 AND sha256=$2 AND deleted_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 1`, [actor.userId, sha256])).rows[0] as SampleRow | undefined;
      if (duplicate) return success(meta(duplicate));
      const packageId = randomUUID();
      const storageKey = `${actor.userId}/${packageId}.json`;
      const target = join(SAMPLE_ROOT, storageKey);
      const temp = `${target}.${randomUUID()}.tmp`;
      await mkdir(dirname(target), { recursive: true });
      await writeFile(temp, data, { mode: 0o600 });
      await rename(temp, target);
      const inserted = (await client.query(`INSERT INTO crm_sample_mail_packages
        (package_id,owner_user_id,account_email,filename,message_count,bytes,sha256,storage_key,range_from,range_to,note,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now() + ($12 || ' days')::interval)
        RETURNING ${COLUMNS}`,
      [packageId, actor.userId, input.accountEmail.trim().toLowerCase(), input.filename.trim(), input.messageCount,
        data.length, sha256, storageKey, input.rangeFrom ?? null, input.rangeTo ?? null, (input.note ?? '').trim(),
        String(SAMPLE_MAIL_LIMITS.retention_days)])).rows[0] as SampleRow;
      const stale = (await client.query(`SELECT package_id AS "packageId",storage_key AS "storageKey" FROM (
          SELECT package_id,storage_key,row_number() OVER (ORDER BY created_at DESC) AS rn
          FROM crm_sample_mail_packages WHERE owner_user_id=$1 AND deleted_at IS NULL AND expires_at>now()
        ) ranked WHERE rn > $2`, [actor.userId, SAMPLE_MAIL_LIMITS.max_packages_per_owner])).rows as Array<{ packageId: string; storageKey: string }>;
      for (const row of stale) {
        await client.query('UPDATE crm_sample_mail_packages SET deleted_at=now() WHERE package_id=$1', [row.packageId]);
        await unlink(join(SAMPLE_ROOT, String(row.storageKey))).catch(() => { /* file already gone */ });
      }
      return success(meta(inserted));
    });
  }

  list(tokenHash: string): Promise<Result<SampleMailPackageMeta[]>> {
    return this.authorize(tokenHash, async (client, actor) => {
      const rows = (await client.query(`${SELECT}
        WHERE deleted_at IS NULL AND expires_at>now() ${actor.identityAdmin ? '' : 'AND owner_user_id=$1'}
        ORDER BY created_at DESC LIMIT 200`, actor.identityAdmin ? [] : [actor.userId])).rows as SampleRow[];
      return success(rows.map(meta));
    });
  }

  read(tokenHash: string, packageId: string): Promise<Result<{ meta: SampleMailPackageMeta; data: Uint8Array }>> {
    return this.authorize(tokenHash, async (client, actor) => {
      const row = (await client.query(`${SELECT} WHERE package_id=$1 AND deleted_at IS NULL AND expires_at>now()`, [packageId])).rows[0] as SampleRow | undefined;
      if (!row) return failure('NOT_FOUND', '样例包不存在或已过期');
      if (!actor.identityAdmin && String((await client.query('SELECT owner_user_id FROM crm_sample_mail_packages WHERE package_id=$1', [packageId])).rows[0]?.owner_user_id) !== actor.userId) {
        return failure('FORBIDDEN', '无权读取该样例包');
      }
      try { return success({ meta: meta(row), data: await readFile(join(SAMPLE_ROOT, row.storageKey)) }); }
      catch { return failure('NOT_FOUND', '样例包内容不存在'); }
    });
  }

  remove(tokenHash: string, packageId: string): Promise<Result<void>> {
    return this.authorize(tokenHash, async (client, actor) => {
      const row = (await client.query('SELECT owner_user_id AS "owner",storage_key AS "key" FROM crm_sample_mail_packages WHERE package_id=$1 AND deleted_at IS NULL', [packageId])).rows[0];
      if (!row) return failure('NOT_FOUND', '样例包不存在');
      if (!actor.identityAdmin && String(row.owner) !== actor.userId) return failure('FORBIDDEN', '无权删除该样例包');
      await client.query('UPDATE crm_sample_mail_packages SET deleted_at=now() WHERE package_id=$1', [packageId]);
      await unlink(join(SAMPLE_ROOT, String(row.key))).catch(() => { /* file already gone */ });
      return success(undefined);
    });
  }
}
