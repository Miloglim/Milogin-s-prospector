import type { Database as RawDb } from 'better-sqlite3';
import { LEGACY_MAIL_SYNC_DDL, legacyMailEventInput, type LegacyMailExportRow } from '../core/legacy-mail-sync';

const LIMIT = 100;

export function createLegacyMailSyncStore(raw: RawDb) {
  raw.exec(LEGACY_MAIL_SYNC_DDL);
  const enqueueMapped = (): number => raw.transaction(() => {
    const rows = raw.prepare(`SELECT i.id AS localEventId,'interaction' AS source,i.contact_id AS localContactId,
      m.center_contact_id AS centerContactId,m.center_customer_id AS centerCustomerId,
      CASE i.type WHEN 'sent' THEN 'sent' WHEN 'replied' THEN 'replied' WHEN 'bounced' THEN 'bounced' WHEN 'autoreply' THEN 'autoreply' END AS kind,
      i.direction,i.created_at AS occurredAt,i.subject,i.body_preview AS preview,i.message_id AS messageKey,
      CAST(COALESCE(i.account_id,0) AS TEXT) AS mailboxKey,CASE WHEN i.direction='outbound' THEN COALESCE(ea.email,c.email) ELSE c.email END AS fromEmail,
      CASE WHEN i.direction='outbound' THEN c.email ELSE COALESCE(ea.email,'') END AS toEmail
      FROM interactions i JOIN contacts c ON c.id=i.contact_id JOIN crm_legacy_contact_map m ON m.local_contact_id=c.id AND m.state='mapped'
      LEFT JOIN email_accounts ea ON ea.id=i.account_id
      WHERE i.type IN ('sent','replied','bounced','autoreply')
      UNION ALL
      SELECT i.id AS localEventId,'inbox' AS source,i.matched_contact_id AS localContactId,
      m.center_contact_id AS centerContactId,m.center_customer_id AS centerCustomerId,'received' AS kind,'inbound' AS direction,
      i.received_at AS occurredAt,i.subject,i.body_preview AS preview,i.message_id AS messageKey,
      CAST(i.account_id AS TEXT) AS mailboxKey,i.from_email AS fromEmail,i."to" AS toEmail
      FROM inbox_messages i JOIN contacts c ON c.id=i.matched_contact_id JOIN crm_legacy_contact_map m ON m.local_contact_id=c.id AND m.state='mapped'
      WHERE COALESCE(i.classification,'other')='other'`).all() as Array<Record<string, unknown>>;
    const stmt = raw.prepare(`INSERT INTO crm_legacy_mail_sync(event_key,payload,status,attempts) VALUES(?,?, 'pending',0) ON CONFLICT(event_key) DO NOTHING`);
    let count = 0;
    for (const row of rows) {
      const converted = legacyMailEventInput({
        localEventId: Number(row.localEventId), source: row.source as 'interaction'|'inbox', localContactId: Number(row.localContactId),
        centerContactId: Number(row.centerContactId), centerCustomerId: String(row.centerCustomerId), kind: row.kind as LegacyMailExportRow['kind'],
        direction: row.direction as LegacyMailExportRow['direction'], occurredAt: String(row.occurredAt), subject: row.subject as string|null,
        preview: row.preview as string|null, messageKey: row.messageKey as string|null, mailboxKey: row.mailboxKey as string|null,
        fromEmail: String(row.fromEmail ?? ''), toEmails: splitAddresses(row.toEmail), ccEmails: [],
      });
      count += stmt.run(converted.eventKey, JSON.stringify(converted)).changes;
    }
    return count;
  })();
  const pending = (): Array<{ eventKey: string; payload: ReturnType<typeof legacyMailEventInput> }> => (raw.prepare('SELECT event_key AS eventKey,payload FROM crm_legacy_mail_sync WHERE status=\'pending\' ORDER BY event_key LIMIT ?').all(LIMIT) as Array<{eventKey:string;payload:string}>).map(row => ({ eventKey: row.eventKey, payload: JSON.parse(row.payload) }));
  const mark = (eventKey: string, status: 'synced'|'failed', error?: string): void => { raw.prepare(`UPDATE crm_legacy_mail_sync SET status=?,attempts=attempts+1,last_error=?,synced_at=CASE WHEN ?='synced' THEN CURRENT_TIMESTAMP ELSE synced_at END WHERE event_key=?`).run(status,error??null,status,eventKey); };
  const defer = (eventKey: string, error: string): void => { raw.prepare('UPDATE crm_legacy_mail_sync SET last_error=? WHERE event_key=? AND status=\'pending\'').run(error,eventKey); };
  return { enqueueMapped, pending, mark, defer };
}

function splitAddresses(value: unknown): string[] {
  return typeof value === 'string' ? value.split(/[;,]/).map(item => item.trim()).filter(Boolean) : [];
}
