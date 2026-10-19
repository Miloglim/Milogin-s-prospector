import type { Database as RawDb } from 'better-sqlite3';
import type { CenterContact } from '../../../server/core/center-contacts';
import { LEGACY_CONTACT_MAP_DDL, mapLegacyContacts, type LegacyContactMapRow } from '../core/legacy-contact-map';

export function createLegacyContactMapStore(raw: RawDb) {
  raw.exec(LEGACY_CONTACT_MAP_DDL);
  const reconcile = (center: CenterContact[], matchedAt: string): void => {
    const local = raw.prepare('SELECT id AS localContactId, email FROM contacts WHERE email IS NOT NULL AND length(trim(email)) > 0').all() as Array<{ localContactId: number; email: string }>;
    const rows = mapLegacyContacts(local, center.map(row => ({ customerId: row.customerId, contactId: row.contactId, email: row.email })), matchedAt);
    const write = raw.transaction((items: LegacyContactMapRow[]) => {
      raw.prepare('DELETE FROM crm_legacy_contact_map WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id=local_contact_id)').run();
      const stmt = raw.prepare(`INSERT INTO crm_legacy_contact_map(local_contact_id,center_customer_id,center_contact_id,state,reason,matched_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(local_contact_id) DO UPDATE SET center_customer_id=excluded.center_customer_id,center_contact_id=excluded.center_contact_id,state=excluded.state,reason=excluded.reason,matched_at=excluded.matched_at`);
      for (const item of items) stmt.run(item.localContactId, item.centerCustomerId ?? null, item.centerContactId ?? null, item.state, item.reason ?? null, item.matchedAt ?? matchedAt);
    });
    write(rows);
  };
  const get = (localContactId: number): LegacyContactMapRow | undefined => {
    const row = raw.prepare('SELECT local_contact_id AS localContactId,center_customer_id AS centerCustomerId,center_contact_id AS centerContactId,state,reason,matched_at AS matchedAt FROM crm_legacy_contact_map WHERE local_contact_id=?').get(localContactId) as LegacyContactMapRow | undefined;
    return row;
  };
  return { reconcile, get };
}
