import type { ContactMailEventInput, ContactMailKind } from '../../../server/core/contact-mail';

export const LEGACY_MAIL_SYNC_DDL = `CREATE TABLE IF NOT EXISTS crm_legacy_mail_sync (
  event_key TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','synced','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  synced_at TEXT
);`;

export interface LegacyMailExportRow {
  localEventId: number;
  source: 'interaction' | 'inbox';
  localContactId: number;
  centerContactId: number;
  centerCustomerId: string;
  kind: ContactMailKind;
  direction: 'inbound' | 'outbound';
  occurredAt: string;
  subject?: string | null;
  preview?: string | null;
  messageKey?: string | null;
  mailboxKey?: string | null;
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
}

export function legacyMailEventInput(row: LegacyMailExportRow): ContactMailEventInput {
  const eventKey = `legacy-${row.source}-${row.localEventId}`;
  return {
    contactId: row.centerContactId,
    customerId: row.centerCustomerId,
    eventKey,
    mailboxKey: (row.mailboxKey || 'legacy-local').slice(0, 128),
    messageKey: row.messageKey?.trim() || eventKey,
    kind: row.kind,
    direction: row.direction,
    occurredAt: row.occurredAt,
    subject: (row.subject ?? '').slice(0, 998),
    preview: (row.preview ?? '').slice(0, 2000),
    fromEmail: row.fromEmail.trim().toLowerCase(),
    toEmails: row.toEmails.map(email => email.trim().toLowerCase()).filter(Boolean),
    ccEmails: row.ccEmails.map(email => email.trim().toLowerCase()).filter(Boolean),
  };
}
