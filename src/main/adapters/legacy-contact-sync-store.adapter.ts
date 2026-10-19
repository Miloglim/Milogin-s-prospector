import type { Database as RawDb } from 'better-sqlite3';
import { LEGACY_CONTACT_SYNC_DDL, type LegacyContactExportRow } from '../core/legacy-contact-sync';

const LIMIT = 200;

export function createLegacyContactSyncStore(raw: RawDb) {
  raw.exec(LEGACY_CONTACT_SYNC_DDL);
  const enqueueUnmatched = (): number => raw.transaction(() => {
    const rows = raw.prepare(`SELECT c.id AS localContactId, c.company_id AS companyId, COALESCE(co.name,'') AS companyName,
      c.email, c.first_name AS firstName, c.last_name AS lastName, c.title, c.phone, c.linkedin AS linkedinUrl,
      c.country, c.client_type AS clientType, c.language, c.stage, c.status, c.tags, c.source
      FROM contacts c LEFT JOIN companies co ON co.id=c.company_id
      JOIN crm_legacy_contact_map m ON m.local_contact_id=c.id AND m.state='unmatched'
      WHERE NOT EXISTS (SELECT 1 FROM crm_legacy_contact_sync q WHERE q.local_contact_id=c.id AND q.status IN ('pending','synced'))
      AND length(trim(COALESCE(c.email,'')))>0 AND length(trim(COALESCE(co.name,'')))>0`).all() as Array<Record<string, unknown>>;
    const stmt = raw.prepare(`INSERT INTO crm_legacy_contact_sync(local_contact_id,payload,status,attempts)
      VALUES(?,?, 'pending',0) ON CONFLICT(local_contact_id) DO NOTHING`);
    let count = 0;
    for (const row of rows) {
      const payload = JSON.stringify({ ...row, tags: typeof row.tags === 'string' ? safeTags(row.tags) : [] });
      count += stmt.run(row.localContactId, payload).changes;
    }
    return count;
  })();
  const pending = (): Array<{ localContactId: number; payload: LegacyContactExportRow; attempts: number }> => {
    const rows = raw.prepare(`SELECT local_contact_id AS localContactId,payload,attempts FROM crm_legacy_contact_sync WHERE status='pending' ORDER BY local_contact_id LIMIT ?`).all(LIMIT) as Array<{localContactId:number;payload:string;attempts:number}>;
    return rows.map(row => ({ localContactId: row.localContactId, payload: JSON.parse(row.payload) as LegacyContactExportRow, attempts: row.attempts }));
  };
  const mark = (localContactIds: number[], status: 'synced' | 'failed', error?: string): void => {
    const stmt = raw.prepare(`UPDATE crm_legacy_contact_sync SET status=?,attempts=attempts+1,last_error=?,synced_at=CASE WHEN ?='synced' THEN CURRENT_TIMESTAMP ELSE synced_at END WHERE local_contact_id=?`);
    raw.transaction(() => { for (const id of localContactIds) stmt.run(status, error ?? null, status, id); })();
  };
  const defer = (localContactIds: number[], error: string): void => {
    const stmt = raw.prepare('UPDATE crm_legacy_contact_sync SET last_error=? WHERE local_contact_id=? AND status=\'pending\'');
    raw.transaction(() => { for (const id of localContactIds) stmt.run(error, id); })();
  };
  return { enqueueUnmatched, pending, mark, defer };
}

function safeTags(value: string): string[] {
  try { const parsed = JSON.parse(value) as unknown; return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []; }
  catch { /* 旧库中的损坏标签只影响标签字段，不能阻断联系人同步。 */ return []; }
}
