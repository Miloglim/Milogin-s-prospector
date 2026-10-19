import { CONTACT_MAIL_LIMITS, type ContactMailEventInput } from './contact-mail';
import type { Result } from './crm';

/** A single authorized attempt, not reusable permission to send or read a contact. */
export const SEND_ACCEPTANCE_ROUTES = {
  authorize: '/api/crm/send-authorizations',
  accept: '/api/crm/send-acceptances',
} as const;
export const SEND_AUTHORIZATION_LIMITS = {
  attempt_seconds: 600,
  clock_skew_seconds: 60,
  recipients: 100,
  sendKey: 256,
  // An actual acceptance may carry one earlier immutable IMAP observation.
  bodyBytes: CONTACT_MAIL_LIMITS.bodyBytes + CONTACT_MAIL_LIMITS.bodyBytes,
} as const;
export interface SendAuthorizationTarget {
  contactId: number;
  customerId: string;
  email: string;
}
export interface SendAuthorizationInput {
  sendKey: string;
  fromEmail: string;
  subject: string;
  recipients: SendAuthorizationTarget[];
  ccEmails?: string[];
}
export interface SendAuthorization {
  authorizationId: string;
  contactId: number;
  customerId: string;
  recipientEmail: string;
  fromEmail: string;
  subject: string;
  issuedAt: string;
  expiresAt: string;
}
export interface SendAcceptanceInput {
  authorizationId: string;
  event: ContactMailEventInput;
  /** Prior IMAP metadata, used only to match an already stored immutable fact. */
  observedEvent?: ContactMailEventInput;
}
/** No contact data: successful archiving must never resurrect revoked visibility. */
export interface SendAcceptanceReceipt {
  eventId: string;
  duplicate: boolean;
  archivedAfterRevocation: boolean;
}
export interface SendAcceptanceRepository {
  authorizeSend(hash: string, input: SendAuthorizationInput): Promise<Result<SendAuthorization[]>>;
  acceptSend(hash: string, input: SendAcceptanceInput): Promise<Result<SendAcceptanceReceipt>>;
}
