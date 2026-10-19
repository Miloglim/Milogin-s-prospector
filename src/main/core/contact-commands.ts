import type { CenterContactDetail, CenterContactUpdate, CenterContactFollowup } from '../../../server/core/contact-assignments';
import type { ContactMirrorContext } from './contact-mirror';
import type { ErrorCode } from '../../../server/core/crm';
import { canEditContactFields } from './contact-permissions';
export const CONTACT_COMMAND_LIMITS = { batch: 50 } as const;
export const CONTACT_COMMAND_PREFIX = 'contact-command:';
export const CONTACT_COMMAND_RETENTION = { days: 30, batch: 100, millisecondsPerDay: 86_400_000 } as const;
const FOLLOWUP_STATUS = {contacted:'reached',replied:'replied',uncontacted:'',unreachable:null} as const;
export type ContactCommandAction = 'update' | 'followups';
export type ContactCommandInput = CenterContactUpdate | CenterContactFollowup;
export interface ContactCommandContext extends ContactMirrorContext { active(): boolean; online(): boolean; }
export interface ContactCommandRow {
 id: string; action: ContactCommandAction; input: ContactCommandInput;
 status: 'pending' | 'conflict' | 'failed' | 'confirmed'; createdAt: string;
 predecessorId?: string; attempted?: boolean; error?: string; errorCode?: ErrorCode; discardable?: boolean;
 retiredKeys?: string[];
 history?: ContactCommandInput[];
 confirmedAt?: string;
}
export interface ContactCommandReceipt {
 kind: 'receipt'; id: string; action: ContactCommandAction; status: 'confirmed';
 contactId: number; customerId: string; confirmedAt: string; inputDigest: string;
 idempotencyKey: string; retiredKeys?: string[];
}
export interface ContactCommandDuplicate { matches: boolean; confirmed: boolean; row?: ContactCommandRow; }
export type ContactCommand = ContactCommandRow;
/** Each operation is scoped by center, account and permission fingerprint. Implementations persist synchronously. */
export interface ContactCommandStore {
 list(ctx: ContactMirrorContext): ContactCommandRow[];
 put(ctx: ContactMirrorContext, row: ContactCommandRow): void;
 remove(ctx: ContactMirrorContext, id: string): void;
 transaction?(ctx: ContactMirrorContext, work: () => void): void;
 unresolved?(ctx: ContactMirrorContext): ContactCommandRow[];
 get?(ctx: ContactMirrorContext, id: string): ContactCommandRow | undefined;
 confirmed?(ctx: ContactMirrorContext, id: string): boolean;
 duplicate?(ctx: ContactMirrorContext, action: ContactCommandAction, input: ContactCommandInput): ContactCommandDuplicate | undefined;
 maintain?(ctx: ContactMirrorContext, now: string): void;
}
export function sameContact(a: { contactId:number; customerId:string }, b: { contactId:number; customerId:string }): boolean {
 return a.contactId === b.contactId && a.customerId === b.customerId;
}
/** Object key order cannot turn an identical retry into a different payload. */
export function contactCommandFingerprint(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(contactCommandFingerprint).join(',')}]`;
 if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${contactCommandFingerprint(item)}`).join(',')}}`;
 return JSON.stringify(value) ?? 'undefined';
}
/** Authorization/ownership can change without increasing a contact's content version. */
export function contactAccessFingerprint(detail: CenterContactDetail): string {
 const row=detail.contact;
 return contactCommandFingerprint([row.customerId,row.companyId,row.ownerUserId,row.origin,row.state,row.isShared,
  detail.permissions??row.permissions,detail.canEdit,detail.canFollowup,detail.canAssign,detail.canDelete,detail.canSendMail]);
}
export function contactCommandAllowed(detail: CenterContactDetail, action: ContactCommandAction, input: ContactCommandInput): boolean {
 if(action==='update')return canEditContactFields({...detail.contact,canEdit:detail.canEdit,permissions:detail.permissions??detail.contact.permissions},Object.keys((input as CenterContactUpdate).fields));
 const permissions=detail.permissions??detail.contact.permissions,followup=input as CenterContactFollowup;
 const needsFollowup=followup.stage===undefined||followup.method!=='note'||followup.contactStatus!==undefined;
 return (!needsFollowup||(permissions?.canFollowup??detail.canFollowup)===true)&&(followup.stage===undefined||(permissions?permissions.canChangeStage:detail.canEdit));
}
/** Drafts are derived; confirmed mirror rows and center versions are never overwritten by local edits. */
export function contactCommandDetail(confirmed: CenterContactDetail, rows: ContactCommandRow[]): CenterContactDetail {
 const pending = rows.filter(row=>row.status !== 'confirmed' && sameContact(row.input,confirmed.contact));
 const detail:CenterContactDetail = structuredClone(confirmed);
 delete detail.localSync;
 for (const row of pending) {
  if (row.status === 'failed') continue;
  if (row.action === 'update') {
   const { preferences, ...fields } = (row.input as CenterContactUpdate).fields;
   Object.assign(detail.contact, fields);
   if (preferences !== undefined) detail.contact.extra = { ...detail.contact.extra, preferences };
  } else {
   const input = row.input as CenterContactFollowup;
   detail.activities.unshift({id:row.id,actorId:'',note:input.note,stage:input.stage??null,createdAt:row.createdAt,method:input.method??'other',occurredAt:input.occurredAt??row.createdAt,recordedAt:row.createdAt,contactId:input.contactId,contactStatus:input.contactStatus??null});
   if (input.stage) detail.contact.relationshipStage = input.stage;
   if (input.method !== 'note') {
    const occurredAt = input.occurredAt ?? row.createdAt;
    if (!detail.contact.lastFollowupAt || occurredAt >= detail.contact.lastFollowupAt) {
     detail.contact.lastFollowupAt = occurredAt; detail.contact.lastFollowupNote = input.note;
     if (input.contactStatus) {
      detail.contact.touchStatus = input.contactStatus;
      const status=FOLLOWUP_STATUS[input.contactStatus];if(status!==null)detail.contact.status=status;
     }
    }
   }
  }
  detail.contact.contactVersion = row.input.expectedVersion + 1;
 }
 if (pending.length) {
  const issue = pending.find(row=>row.status==='conflict') ?? pending.find(row=>row.status==='failed');
  detail.localSync = { pending:pending.length, state:issue?.status==='conflict'?'conflict':issue?'failed':'pending', ...(issue?.error?{message:issue.error}:{}) };
 }
 return detail;
}
