import type { ImportRequest, ImportRow } from '../../../server/core/leads';
import { normalizeLegacyEmail } from './legacy-contact-map';

/** Local queue table. The payload stays in the account's SQLite profile until center receipt. */
export const LEGACY_CONTACT_SYNC_DDL = `CREATE TABLE IF NOT EXISTS crm_legacy_contact_sync (
  local_contact_id INTEGER PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','synced','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  synced_at TEXT
);`;

/** The fields needed to turn one legacy SQLite row into a center personal lead row. */
export interface LegacyContactExportRow {
  localContactId: number;
  companyId?: number | null;
  companyName: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  title?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  country?: string | null;
  clientType?: string | null;
  language?: string | null;
  stage?: string | null;
  status?: string | null;
  tags?: string[] | null;
  source?: string | null;
}

export function legacyContactImportRow(row: LegacyContactExportRow): ImportRow | undefined {
  const email = normalizeLegacyEmail(row.email);
  const companyName = row.companyName.trim();
  if (!email || !companyName) return undefined;
  return {
    customerKey: `legacy-company-${row.companyId ?? row.localContactId}`,
    companyName,
    email,
    ...(row.firstName ? { firstName: row.firstName.trim() } : {}),
    ...(row.lastName ? { lastName: row.lastName.trim() } : {}),
    ...(row.title ? { title: row.title.trim() } : {}),
    ...(row.phone ? { phone: row.phone.trim() } : {}),
    ...(row.linkedinUrl ? { linkedinUrl: row.linkedinUrl.trim() } : {}),
    ...(row.country ? { country: row.country.trim() } : {}),
    ...(row.clientType ? { clientType: row.clientType.trim() } : {}),
    ...(row.language ? { language: row.language.trim() } : {}),
    ...(row.stage ? { stage: row.stage.trim() } : {}),
    ...(row.status ? { status: row.status.trim() } : {}),
    ...(row.tags?.length ? { tags: row.tags.map(tag => tag.trim()).filter(Boolean) } : {}),
    rawRow: { localContactId: row.localContactId, legacySource: row.source ?? 'manual' },
  };
}

/** Build a bounded, personal-only import envelope. No network or database IO occurs here. */
export function buildLegacyPersonalImport(rows: LegacyContactExportRow[], batchKey: string): ImportRequest {
  const mapped = rows.map(legacyContactImportRow).filter((row): row is ImportRow => !!row);
  return {
    source: 'legacy-sqlite',
    sourceDetail: 'Prospector 旧联系人',
    idempotencyKey: `legacy-import-${batchKey}`,
    kind: 'personal',
    rows: mapped,
  };
}
