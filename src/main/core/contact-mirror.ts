import type { CenterContact, CenterContactPage, CenterContactQuery } from '../../../server/core/center-contacts';
import { FOLLOWUP_TOUCH_STATUSES } from '../../../server/core/leads';
import type { CenterContactRef, CenterContactDetail } from '../../../server/core/contact-assignments';
import { CONTACT_MAIL_LIMITS, type ContactMailEventInput } from '../../../server/core/contact-mail';

export const CONTACT_MIRROR_LIMITS = { pending: 100, busyTimeoutMs: 5000 } as const;
export interface ContactMirrorContext { baseUrl: string; userId: string; permissionKey?: string; }
/** Local upload envelope only. The ordinary mail API never accepts this authorization field. */
export interface QueuedContactMailEvent extends ContactMailEventInput {
  sendAuthorizationId?: string;
  /** Actual SMTP envelope when an earlier immutable IMAP observation differs. */
  smtpAcceptance?: ContactMailEventInput;
}
export type ContactMailRole = 'primary' | 'to' | 'cc' | 'bounce';
/** Explicit center references never become a legacy contacts foreign key. */
export interface ContactMailLink extends CenterContactRef {
  messageKey: string; localMailId: number; mailAccountId: number; mailbox: string; role: ContactMailRole;
}
export interface ContactMailLinkInput extends ContactMailLink { event?: QueuedContactMailEvent; }
/** The caller replaces snapshots only after a complete authorized center scan. */
export interface ContactMirrorStore {
  ready(context: ContactMirrorContext): boolean;
  invalidateContacts(context: ContactMirrorContext): void;
  replaceContacts(context: ContactMirrorContext, contacts: CenterContact[]): void;
  upsertContacts(context: ContactMirrorContext, contacts: CenterContact[]): void;
  contacts(context: ContactMirrorContext): CenterContact[];
  contact(context: ContactMirrorContext, reference: CenterContactRef): CenterContact | undefined;
  detail(context: ContactMirrorContext, reference: CenterContactRef): CenterContactDetail | undefined;
  saveDetail(context: ContactMirrorContext, detail: CenterContactDetail): void;
  forgetContact(context: ContactMirrorContext, reference: CenterContactRef): void;
  findByEmail(context: ContactMirrorContext, email: string): CenterContact[];
  linkMail(context: ContactMirrorContext, link: ContactMailLinkInput): void;
  linksForMessage(context: ContactMirrorContext, messageKey: string): ContactMailLink[];
  linksForLocalMessage(context: ContactMirrorContext, localMailId: number): ContactMailLink[];
  pendingEvents(context: ContactMirrorContext, limit?: number): QueuedContactMailEvent[];
  acknowledgeEvent(context: ContactMirrorContext, eventKey: string, postedEvent?: QueuedContactMailEvent): void;
  eventAcknowledged?(context: ContactMirrorContext, eventKey: string): boolean;
  failEvent(context: ContactMirrorContext, eventKey: string, message: string): void;
  incrementalState?(context: ContactMirrorContext): { cursor: string | null; permissionKey: string };
  saveIncrementalCursor?(context: ContactMirrorContext, cursor: string): void;
}

export function normalizedContactEmail(email: string | null): string | null {
  return email?.trim().toLowerCase() || null;
}

/** The latest authorized base always wins over older supplementary snapshots. */
export function contactDetailSnapshot(contact: CenterContact, cached?: CenterContactDetail): CenterContactDetail {
  const supplement = cached?.company.companyId === contact.companyId ? cached : undefined;
  return {
    ...(supplement ?? { company: { companyId: contact.companyId, name: contact.companyName, domain: null, backcheckData: null }, activities: [], mailAvailable: true, mailEvents: [], mailEventLimit: CONTACT_MAIL_LIMITS.history }),
    contact, supplementAvailable: !!supplement,
    permissions: contact.permissions, canSendMail: contact.canSendMail,
    canDelete: contact.canDelete === true, canEdit: contact.canEdit === true, canFollowup: contact.canFollowup === true, canAssign: contact.canAssign === true,
  };
}

/** The input is already the account-authorized projection, never an unfiltered center dump. */
export function contactMirrorPage(rows: CenterContact[], query: CenterContactQuery, userId: string): CenterContactPage {
  const search = query.search.trim().toLowerCase();
  const stage = (row: CenterContact) => row.relationshipStage ?? (FOLLOWUP_TOUCH_STATUSES.includes(row.touchStatus) ? 'reaching' : 'cold');
  const time = (value: string | null | undefined) => value ? Date.parse(value) : Number.NEGATIVE_INFINITY;
  const descendingTime = (left: string | null | undefined, right: string | null | undefined) => {
    const a = time(left), b = time(right); return a === b ? 0 : a > b ? -1 : 1;
  };
  const filtered = rows.filter(row => {
    if (query.scope === 'personal' && (row.origin !== 'personal' || row.ownerUserId !== userId)) return false;
    if (query.scope === 'assigned' && ((row.origin !== 'operations' || row.ownerUserId !== userId) && row.isShared !== true)) return false;
    if (query.assignment === 'accepted' && row.assignmentStatus !== 'accepted') return false;
    if (query.followupOnly && !FOLLOWUP_TOUCH_STATUSES.includes(row.touchStatus)) return false;
    if (query.crmStage && stage(row) !== query.crmStage) return false;
    if (query.touchStatus && row.touchStatus !== query.touchStatus) return false;
    if (query.stage && row.stage !== query.stage || query.status && row.status !== query.status || query.tags && !row.tags.includes(query.tags) || query.clientType && row.clientType !== query.clientType || query.country && row.country !== query.country || query.language && row.language !== query.language) return false;
    return !search || [row.email, row.firstName, row.lastName, row.title, row.companyName].some(value => value?.toLowerCase().includes(search));
  });
  filtered.sort((a, b) => (query.followupOnly ? descendingTime(a.lastFollowupAt, b.lastFollowupAt) : 0) || descendingTime(a.updatedAt, b.updatedAt) || b.contactId - a.contactId);
  return { items: filtered.slice(query.offset, query.offset + query.limit), total: filtered.length };
}
