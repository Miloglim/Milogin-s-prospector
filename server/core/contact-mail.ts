import type { CenterContact } from './center-contacts';
import type { Result } from './crm';

export const CONTACT_MAIL_ROUTE = '/api/crm/contact-mail-events';
export const CONTACT_MAIL_LIMITS = { key: 256, mailboxKey: 128, subject: 998, preview: 2000, email: 254, recipients: 100, history: 200, bodyBytes: 65536 } as const;
export const CONTACT_MAIL_KINDS = ['received', 'sent', 'replied', 'autoreply', 'bounced', 'cc'] as const;
export type ContactMailKind = typeof CONTACT_MAIL_KINDS[number];
export const MAIL_CLASSIFICATIONS = ['other', 'replied', 'autoreply', 'bounced'] as const;
export type MailClassification = typeof MAIL_CLASSIFICATIONS[number];
export interface MailClassificationCorrection { previousEventKey: string | null; classification: MailClassification; }
export interface ContactMailEventInput {
  contactId: number; customerId: string; eventKey: string; mailboxKey: string; messageKey: string;
  kind: ContactMailKind; direction: 'inbound' | 'outbound'; occurredAt: string;
  subject: string; preview: string; fromEmail: string; toEmails: string[]; ccEmails: string[];
  /** Confirmed SMTP acceptance; only outbound sent facts may advance the current send round. */
  advanceSendStage?: boolean;
  /** Append-only inbound classification correction; the center verifies the preceding correction key. */
  correction?: MailClassificationCorrection;
}
/** Metadata only. Body, attachments, provider credentials and ownership assertions are never accepted. */
export interface ContactMailEvent extends ContactMailEventInput {
  correctionRevision?: number;
  eventId: string; actorId: string; recordedAt: string; activityId: string | null;
}
export interface ContactMailEventReceipt {
  eventId: string; duplicate: boolean; contact: CenterContact; event: ContactMailEvent;
}
export interface ContactMailRepository {
  recordContactMailEvent(hash: string, input: ContactMailEventInput): Promise<Result<ContactMailEventReceipt>>;
}
