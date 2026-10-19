/** Desktop mirrors the pure center contracts; credentials never leave main. */
import type { Identity } from '../../server/core/auth';
import type { LeadDetail, ImportReceipt } from '../../server/core/leads';
export { hasContactedCustomer, customerBoardStage } from '../../server/core/leads';
export type { Result, CrmStage } from '../../server/core/crm';
export { importRowIssue, LEAD_LIMITS } from '../../server/core/leads';
export { FOLLOWUP_METHODS, FOLLOWUP_METHOD_LABELS, CONTACT_TOUCH_STATUSES, CONTACT_TOUCH_LABELS } from '../../server/core/leads';
export type { FollowupMethod, ContactTouchStatus, CustomerStage } from '../../server/core/leads';
export type { Identity } from '../../server/core/auth';
export { CRM_ROLE_LABELS, identityRoleLabel } from '../../server/core/auth';
export { AUTH_LIMITS } from '../../server/core/auth';
export type { ImportRow, ImportRequest, ImportReceipt, PublishRequest, PublishReceipt, LeadQuery, LeadPage, LeadDetail, LeadBootstrap, LeadCommand, FollowupRequest } from '../../server/core/leads';
export type { CustomerCreate, CustomerUpdate, CustomerContactInput } from '../../server/core/leads';
export type { CenterContact, CenterContactPage, CenterContactQuery } from '../../server/core/center-contacts';
/** Display is derived from contact facts; it never writes an imported legacy status or invents an invalid-email result. */
export function centerContactDisplayStatus(row: { status?: string | null; touchStatus?: string | null }): string {
  if (row.status === 'autoreply' || row.status === 'bounced') return row.status;
  if (row.touchStatus === 'contacted') return 'reached';
  if (row.touchStatus === 'replied') return 'replied';
  if (row.touchStatus === 'uncontacted') return '';
  return row.status ?? '';
}
export type { ContactMailEvent, ContactMailEventInput, ContactMailEventReceipt } from '../../server/core/contact-mail';
export { CENTER_CONTACT_ROUTE, CENTER_CONTACT_LIMITS, CENTER_CONTACT_FILTERS, centerContactQuery, centerContactPath } from '../../server/core/center-contacts';
export type { ContactAssignment, ContactAssignmentStatus, ContactAssignmentPage, ContactAssignmentQuery, ContactAssignmentCreate, ContactAssignmentDecision, ContactAssignmentReceipt, CenterCompanyUpdate, CenterContactRef, CenterContactDetail, CenterContactUpdate, CenterContactFollowup } from '../../server/core/contact-assignments';
export { CONTACT_ASSIGNMENT_ROUTES, CONTACT_ASSIGNMENT_LIMITS } from '../../server/core/contact-assignments';
export type { ContactPermissions, ContactShareGrant, ContactShareStatus, ContactShare, ContactShareCreate, ContactShareDecision, ContactShareUpdate, ContactShareQuery, ContactSharePage, ContactShareMember } from '../../server/core/contact-sharing';
export { CONTACT_SHARING_ROUTES, CONTACT_SHARING_EVENTS, CONTACT_SHARED_FIELDS } from '../../server/core/contact-sharing';
export type ContactShareDecisionInput = import('../../server/core/contact-sharing').ContactShareDecision & { action: 'accept' | 'reject' | 'revoke' };
export type { AssignRequest, CrmMember, MemberQuery, MemberPage } from '../../server/core/leads';
export interface OnlineLogin { baseUrl: string; email: string; password: string; remember?: boolean; autoLogin?: boolean; }
/** Public preset metadata only; secrets remain in main's system-encrypted store. */
export interface LoginAccount { accountId: string; baseUrl: string; email: string; remembered: boolean; autoLogin: boolean; lastUsedAt: number; }
export interface SavedAccountLogin { accountId: string; autoLogin: boolean; }
export interface OnlineLogout { switchAccount?: boolean; }
export interface LoginAccountQuery { accounts: LoginAccount[]; selectedAccountId?: string; }
export interface OnlineRegistration { email: string; password: string; }
export type { RegisteredAccount } from '../../server/core/desktop-session';
export interface OnlineSessionSnapshot { identity: Identity | null; remembered: boolean; baseUrl: string; localAvailable?: boolean; connection?: 'online' | 'offline'; offlineExpiresAt?: string; }
export interface OnlinePasswordChange { currentPassword: string; newPassword: string; }
export interface ImportPreview { headers: string[]; rows: Record<string, string>[]; fileName: string; rowNumbers?: number[]; sheets?: import('../../server/core/customer-import').ImportSheetPreview[]; }
export type { ImportSheetPreview, WorkbookImportRow, WorkbookImportRequest, WorkbookImportReceipt, WorkbookReceiptRow, WorkbookMapping, WorkbookPlanRow, WorkbookImportPlan } from '../../server/core/customer-import';
export { WORKBOOK_IMPORT_ROUTE, WORKBOOK_LIMITS } from '../../server/core/customer-import';
export { autoWorkbookMapping, buildWorkbookPlan, workbookRowIssue, prepareWorkbookRequests } from '../../server/core/customer-import';
export type { Notification as OnlineNotification, FeedPage as OnlineFeed } from '../../server/core/notifications';
export interface OnlineFeedRequest { reset?:boolean; }
export interface CrmSyncIssue { id:string; customerId?:string; status:'failed'|'conflict'; message:string; local?:LeadDetail; central?:LeadDetail; receipt?:ImportReceipt; replayOnly?:boolean; contact?:{contactId:number;customerId:string;name:string;action:'update'|'followups';fields?:Record<string,unknown>;note?:string;centralFields?:Record<string,unknown>}; }
export interface CrmSyncStatus { connection:'online'|'offline'; syncing:boolean; pending:number; failed:number; conflicts:number; lastSyncedAt?:string; lastError?:string; issues:CrmSyncIssue[]; }
export interface CrmSyncResolve { id:string; action:'retry'|'use-central'; }
export type {ContactDelete,ContactDeleteReceipt,CompanyCreate,CompanyDelete,CompanyQuery,CompanyPage as CenterCompanyPage,CompanyDetail as CenterCompanyDetail,CenterCompany} from '../../server/core/crm-lifecycle';
export const ONLINE_CHANNELS = {
  CONTACT_SHARES:'online:contact-shares', CONTACT_SHARE_CREATE:'online:contact-share-create', CONTACT_SHARE_DECIDE:'online:contact-share-decide', CONTACT_SHARE_UPDATE:'online:contact-share-update', CONTACT_SHARE_MEMBERS:'online:contact-share-members',
 CONTACT_DELETE:'online:contact-delete',COMPANY_LIST:'online:company-list',COMPANY_DETAIL:'online:company-detail',COMPANY_CREATE:'online:company-create',COMPANY_DELETE:'online:company-delete',
  REGISTER:'online:register', LOGIN:'online:login', LOGOUT:'online:logout', STATUS:'online:status', RESTORE:'online:restore', PASSWORD:'online:password', BOOTSTRAP:'online:bootstrap',
  ACCOUNT_LIST:'online:account-list', ACCOUNT_LOGIN:'online:account-login', ACCOUNT_REMOVE:'online:account-remove',
  PREVIEW:'online:preview', IMPORT:'online:import', PUBLISH:'online:publish',
  WORKBOOK_PREVIEW:'online:workbook-preview', WORKBOOK_IMPORT:'online:workbook-import',
  SYNC_STATUS:'online:sync-status', SYNC_NOW:'online:sync-now', SYNC_RESOLVE:'online:sync-resolve',
  LIST:'online:list', DETAIL:'online:detail', FOLLOWUP:'online:followup',
  CONTACT_LIST:'online:contact-list',
  COMPANY_UPDATE:'online:company-update', CONTACT_DETAIL:'online:contact-detail', CONTACT_UPDATE:'online:contact-update', CONTACT_FOLLOWUP:'online:contact-followup',
  ASSIGNMENT_LIST:'online:assignment-list', ASSIGNMENT_CREATE:'online:assignment-create',
  ASSIGNMENT_ACCEPT:'online:assignment-accept', ASSIGNMENT_REJECT:'online:assignment-reject', ASSIGNMENT_CANCEL:'online:assignment-cancel',
  CREATE_CUSTOMER:'online:customer-create', UPDATE_CUSTOMER:'online:customer-update',
  MEMBERS:'online:members',
  FEED:'online:feed', READ:'online:read',
  TASK_LIST:'online:task-list', TASK_CREATE:'online:task-create',
  TASK_RESCHEDULE:'online:task-reschedule', TASK_COMPLETE:'online:task-complete',
  OPPORTUNITY_LIST:'online:opportunity-list', OPPORTUNITY_CREATE:'online:opportunity-create',
  OPPORTUNITY_DETAIL:'online:opportunity-detail', OPPORTUNITY_STAGE:'online:opportunity-stage',
} as const;
export const ONLINE_LIMITS = { timeoutMs:10000, responseBytes:1048576, fileBytes:10485760, fileRows:10000, batchRows:200, feedPage:50, pollMs:5000, defaultUrl:'http://127.0.0.1:55844' } as const;

export interface ImportFileContent { type: "csv" | "xlsx" | "tsv"; data: string; encoding?:'base64'; }
export type { FollowupTask, TaskQuery, TaskPage, TaskCreate, TaskReschedule, TaskComplete } from '../../server/core/tasks';
export { TASK_LIMITS, TASK_DUE_EVENT } from '../../server/core/tasks';
export type { Opportunity, OpportunityStage, OpportunityHistory, OpportunityPage, OpportunityCreate, OpportunityUpdateStage, OpportunityQuery } from '../../server/core/opportunities';
export { OPPORTUNITY_ROUTES, OPPORTUNITY_LIMITS, OPPORTUNITY_STAGES, OPPORTUNITY_STAGE_LABELS, OPPORTUNITY_EVENTS } from '../../server/core/opportunities';
