import type {ContactPermissions} from './contact-sharing';
import type { CenterContact } from './center-contacts';
import type { LeadActivity, CustomerStage, ContactTouchStatus, FollowupMethod } from './leads';
import type { JsonObject, Result } from './crm';
import type { ContactMailEvent } from './contact-mail';

export const CONTACT_ASSIGNMENT_ROUTES = { assignments: '/api/crm/contact-assignments', groups: '/api/crm/contact-assignments/groups', contact: '/api/crm/contacts' } as const;
export const CONTACT_ASSIGNMENT_LIMITS = { batch: 200, page: 50, pageMax: 100, notify: 20, text: 500, note: 20000, key: 128, preferences: 10, preferenceText: 200 } as const;
export const CONTACT_ASSIGNMENT_EVENTS = { requested:'crm.contact.assignment.requested', accepted:'crm.contact.assignment.accepted', rejected:'crm.contact.assignment.rejected', cancelled:'crm.contact.assignment.cancelled', updated:'crm.contact.updated', followup:'crm.contact.followup' } as const;
/** The directory and the transaction use the same eligibility rule. Roles and capabilities are center-derived. */
export function isContactAssignmentTarget(member:{userId:string;roles:readonly string[];capabilities:readonly string[];active?:boolean},actorId:string):boolean {
  return member.userId!==actorId&&member.active!==false&&member.roles.includes('sales')&&member.capabilities.includes('leads.develop');
}
export type ContactAssignmentStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled';
export interface ContactAssignment {
  requestId: string; groupId: string; contactId: number; customerId: string; version: number;
  contactName: string; email: string | null; companyName: string;
  targetUserId: string; targetName: string; actorId: string; actorName: string;
  status: ContactAssignmentStatus; createdAt: string; decidedAt: string | null;
  canAccept: boolean; canReject: boolean; canCancel: boolean;
}
export interface ContactAssignmentPage { items: ContactAssignment[]; total: number; }
export interface ContactAssignmentQuery { view: 'incoming' | 'outgoing'; status: ContactAssignmentStatus; search: string; limit: number; offset: number; requestId?: string; groupId?: string; }
export interface ContactAssignmentGroupQuery { view: 'incoming' | 'outgoing'; status: ContactAssignmentStatus; search: string; limit: number; offset: number; }
export interface ContactAssignmentGroup {
  groupId: string; total: number; pending: number; accepted: number; rejected: number; cancelled: number;
  actorName: string; targetName: string; createdAt: string; contactNames: string[]; companyNames: string[];
  canAcceptAll: boolean; canRejectAll: boolean; canCancelAll: boolean;
}
export interface ContactAssignmentGroupPage { items: ContactAssignmentGroup[]; total: number; }
export interface ContactAssignmentCreate { contacts: Array<{ contactId: number; customerId: string; expectedVersion: number }>; targetUserId: string; notifyUserIds: string[]; idempotencyKey: string; }
export interface ContactAssignmentDecision { requestId: string; expectedVersion: number; idempotencyKey: string; }
export interface ContactAssignmentGroupDecision { groupId: string; idempotencyKey: string; }
export interface ContactAssignmentReceipt { items: ContactAssignment[]; }
export interface CenterContactRef { contactId: number; customerId: string; }
export interface CenterContactDetail {
  /** Desktop-only durable local writes; absence means no pending local commands. */
  localSync?: { pending: number; state: 'pending' | 'conflict' | 'failed'; message?: string };
  /** False only for an offline base-only response; absent means the center supplied the supplements. */
  supplementAvailable?: boolean;
  contact: CenterContact; activities: LeadActivity[];
  company: { revision?: string; canEdit?: boolean; customerType?: string | null; industry?: string | null; country?: string | null; size?: string | null; companyId: number; name: string; domain: string | null; backcheckData: JsonObject | null };
  permissions?: ContactPermissions; canSendMail?: boolean; canDelete?: boolean; canEdit: boolean; canFollowup: boolean; canAssign: boolean;
  mailAvailable: boolean; mailEvents: ContactMailEvent[]; mailEventLimit: number;
}
export interface CenterContactUpdate extends CenterContactRef {
  expectedVersion: number; idempotencyKey: string;
  fields: Partial<Pick<CenterContact, 'email' | 'firstName' | 'lastName' | 'title' | 'phone' | 'whatsapp' | 'sourceLevel1' | 'sourceLevel2' | 'linkedinUrl' | 'country' | 'clientType' | 'language' | 'stage' | 'status' | 'tags'>> & { preferences?: string[] };
}
export interface CenterContactFollowup extends CenterContactRef {
  expectedVersion: number; idempotencyKey: string; note: string;
  stage?: CustomerStage; method?: FollowupMethod; occurredAt?: string; contactStatus?: ContactTouchStatus;
}
export interface CenterCompanyUpdate extends CenterContactRef {
  expectedRevision: string; idempotencyKey: string;
  fields: { customerType?: '代理' | '直客' | null; name?: string; domain?: string | null; country?: string | null; industry?: string | null; size?: string | null; backcheckData?: JsonObject | null };
}
export interface ContactAssignmentRepository extends Partial<import('./crm-lifecycle').LifecycleRepository> {
  companyUpdate?(hash: string, input: CenterCompanyUpdate): Promise<Result<CenterContactDetail>>;
  contactDetail(hash: string, input: CenterContactRef): Promise<Result<CenterContactDetail>>;
  contactUpdate(hash: string, input: CenterContactUpdate): Promise<Result<CenterContactDetail>>;
  contactFollowup(hash: string, input: CenterContactFollowup): Promise<Result<CenterContactDetail>>;
  contactAssignmentGroups(hash: string, input: ContactAssignmentGroupQuery): Promise<Result<ContactAssignmentGroupPage>>;
  contactAssignments(hash: string, input: ContactAssignmentQuery): Promise<Result<ContactAssignmentPage>>;
  createContactAssignments(hash: string, input: ContactAssignmentCreate): Promise<Result<ContactAssignmentReceipt>>;
  decideContactAssignment(hash: string, action: 'accept' | 'reject' | 'cancel', input: ContactAssignmentDecision): Promise<Result<ContactAssignment>>;
  decideContactAssignmentGroup(hash: string, action: 'accept' | 'reject' | 'cancel', input: ContactAssignmentGroupDecision): Promise<Result<ContactAssignmentReceipt>>;
}
