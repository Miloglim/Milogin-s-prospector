import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import type { ContactChangePage, ContactChangeQuery, ContactChangeRepository } from '../../core/contact-change-feed';
import { CONTACT_CHANGE_LOCK, CONTACT_CHANGE_SQL, CONTACT_CHANGE_VERSION } from './contact-change-schema';
import { assertCenterDatabasePool } from './config';
import { authorizeLeadActor, type LeadActor } from './lead-repository';
import { canReadContact, contactDetailIn, loadContactIn } from './contact-assignment-repository';
import { tokenAdapter } from '../password';

const CONTACT_CHANGE_MAX = 9223372036854775807n;
const TOMBSTONE_EVENTS = new Set(['crm.contact.deleted', 'crm.contact.share.revoked']);
export class PostgresContactChangeRepository implements ContactChangeRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) { assertCenterDatabasePool(pool); }
  private async tx<T>(fn: (db: PoolClient) => Promise<Result<T>>): Promise<Result<T>> {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); await db.query('SELECT pg_advisory_xact_lock($1)', [CONTACT_CHANGE_LOCK]); const result = await fn(db); await db.query(result.ok ? 'COMMIT' : 'ROLLBACK'); return result; }
    catch { try { await db.query('ROLLBACK'); } catch { this.log.write('ERROR', 'contact-change.rollback', '联系人变化回滚失败'); } this.log.write('ERROR', 'contact-change.pg', '联系人变化数据库操作失败'); return failure('DATABASE_ERROR', '联系人变化服务暂不可用'); }
    finally { db.release(); }
  }
  async migrate(): Promise<Result<void>> { return this.tx(async db => { const checksum = createHash('sha256').update(CONTACT_CHANGE_SQL).digest('hex'); const old = await db.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [CONTACT_CHANGE_VERSION]); if (old.rows.length && old.rows[0].checksum !== checksum) return failure('CONFLICT', '联系人变化迁移校验不一致'); if (!old.rows.length) { await db.query(CONTACT_CHANGE_SQL); await db.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [CONTACT_CHANGE_VERSION, checksum]); } return success(undefined); }); }
  async feed(hash: string, q: ContactChangeQuery): Promise<Result<ContactChangePage>> { return this.tx(async db => {
    const actor = await authorizeLeadActor(db, hash); if (!actor) return failure('UNAUTHORIZED', 'CRM会话或产品准入已失效');
    const head = await db.query('SELECT COALESCE(max(change_seq),0)::text AS high FROM crm_contact_changes'); const high = head.rows[0].high as string;
    if (BigInt(q.after) > BigInt(high)) return success({ items: [], nextCursor: high, hasMore: false, resyncRequired: true, headCursor: high });
    const rows = await db.query('SELECT change_seq::text AS cursor,event_id::text AS "eventId",contact_id AS "contactId",customer_id AS "customerId",event_type AS "eventType",version FROM crm_contact_changes WHERE recipient_user_id=$1 AND change_seq>$2 ORDER BY change_seq LIMIT $3', [actor.userId, q.after, q.limit]);
    const items = [] as ContactChangePage['items']; let cursor = q.after;
    for (const row of rows.rows) {
      cursor = row.cursor;
      const current = await loadContactIn(db, { contactId: row.contactId, customerId: row.customerId });
      if (current && canReadContact(actor, current)) {
        const detail = await contactDetailIn(db, actor, { contactId: row.contactId, customerId: row.customerId });
        if (detail.ok) { items.push({ cursor, eventId: row.eventId, eventType: row.eventType, contactId: row.contactId, customerId: row.customerId, version: row.version, kind: 'upsert', contact: detail.data.contact }); }
      } else if (TOMBSTONE_EVENTS.has(row.eventType) || !current || (current && !canReadContact(actor, current))) {
        items.push({ cursor, eventId: row.eventId, eventType: row.eventType, contactId: row.contactId, customerId: row.customerId, version: row.version, kind: 'tombstone' });
      }
      if (items.length >= q.limit) break;
    }
    if (!rows.rows.length) cursor = high;
    return success({ items, nextCursor: cursor, hasMore: BigInt(cursor) < BigInt(high), headCursor: high });
  }); }
}
