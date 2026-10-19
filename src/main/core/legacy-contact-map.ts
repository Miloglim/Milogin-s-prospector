export type LegacyContactMapState = 'mapped' | 'ambiguous' | 'unmatched';

/** SQLite projection used only for exact legacy-to-center identity mapping. */
export const LEGACY_CONTACT_MAP_DDL = `CREATE TABLE IF NOT EXISTS crm_legacy_contact_map (
  local_contact_id INTEGER PRIMARY KEY NOT NULL,
  center_customer_id TEXT,
  center_contact_id INTEGER,
  state TEXT NOT NULL,
  reason TEXT,
  matched_at TEXT NOT NULL,
  UNIQUE(center_customer_id, center_contact_id)
);`;

export interface LegacyContactMapRow {
  localContactId: number;
  centerCustomerId?: string;
  centerContactId?: number;
  state: LegacyContactMapState;
  reason?: string;
  matchedAt?: string;
}

export interface LegacyContactCandidate {
  localContactId: number;
  email: string;
}

export interface CenterContactCandidate {
  customerId: string;
  contactId: number;
  email?: string | null;
}

export function normalizeLegacyEmail(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

export function mapLegacyContacts(local: LegacyContactCandidate[], center: CenterContactCandidate[], matchedAt: string): LegacyContactMapRow[] {
  const localByEmail = new Map<string, LegacyContactCandidate[]>();
  const centerByEmail = new Map<string, CenterContactCandidate[]>();
  for (const row of local) {
    const email = normalizeLegacyEmail(row.email);
    if (!email) continue;
    const rows = localByEmail.get(email) ?? [];
    rows.push(row); localByEmail.set(email, rows);
  }
  for (const row of center) {
    const email = normalizeLegacyEmail(row.email);
    if (!email) continue;
    const rows = centerByEmail.get(email) ?? [];
    rows.push(row); centerByEmail.set(email, rows);
  }
  const result: LegacyContactMapRow[] = [];
  for (const [email, localRows] of localByEmail) {
    const centerRows = centerByEmail.get(email) ?? [];
    for (const localRow of localRows) {
      if (localRows.length !== 1 || centerRows.length !== 1) {
        result.push({ localContactId: localRow.localContactId, state: centerRows.length ? 'ambiguous' : 'unmatched', reason: centerRows.length ? '邮箱存在多个候选' : '中心暂无唯一匹配', matchedAt });
      } else {
        const matched = centerRows[0]!;
        result.push({ localContactId: localRow.localContactId, centerCustomerId: matched.customerId, centerContactId: matched.contactId, state: 'mapped', matchedAt });
      }
    }
  }
  return result;
}
