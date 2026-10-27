import type { CrmStage, JsonObject, Result } from './crm';
import type { DataScope } from './admin';
import type { WorkbookImportRequest, WorkbookImportReceipt } from './customer-import';
import type { CenterContactQuery, CenterContactPage, CenterContactGroupQuery, CenterContactGroupPage } from './center-contacts';
import { IMPORT_REMARK_MAX } from './lead-import-fields';
export const LEAD_LIMITS={batchRows:200,bodyBytes:1048576,text:500,note:IMPORT_REMARK_MAX,page:25,pageMax:100,key:128,notifyMax:20} as const;
export const LEAD_ROUTES={bootstrap:'/api/crm/bootstrap',imports:'/api/crm/imports',leads:'/api/crm/leads',members:'/api/crm/members',assignAction:'assign'} as const;
export type LeadState='draft'|'published'|'owned'|'paused';
export interface ImportRow {customerKey:string;companyName:string;email:string;name?:string;country?:string;customerType?:string;businessType?:string;website?:string;firstName?:string;lastName?:string;title?:string;phone?:string;whatsapp?:string;linkedinUrl?:string;language?:string;clientType?:string;sourceLevel1?:string;sourceLevel2?:string;stage?:string;status?:string;tags?:string[];rawRow?:JsonObject;remark?:string;}
const IMPORT_EMAIL_MAX = 254;
/** Display and center validation share one rule; row errors do not invalidate unrelated rows. */
export function importRowIssue(row: ImportRow): string | undefined {
 if (!row.customerKey.trim()) return '缺少客户编号';
 if (!row.companyName.trim()) return '缺少公司名称';
 if (row.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email.trim())) return '邮箱格式无效';
 if (!row.email.trim() && ![row.name,row.firstName,row.lastName,row.phone,row.whatsapp].some(value=>value?.trim())) return '至少填写联系人姓名、电话、WhatsApp或邮箱之一';
 if (row.customerKey.length > LEAD_LIMITS.key) return '客户编号过长';
 if (row.email.length > IMPORT_EMAIL_MAX) return '邮箱过长';
 if (row.customerType?.trim() && !['代理','直客'].includes(row.customerType.trim())) return '客户类型只能填写代理或直客';
 if ([row.companyName,row.name,row.country,row.customerType,row.businessType,row.website,row.firstName,row.lastName,row.title,row.phone,row.whatsapp,row.linkedinUrl,row.language,row.clientType,row.sourceLevel1,row.sourceLevel2,row.stage,row.status].some(value => value !== undefined && value.length > LEAD_LIMITS.text)) return '公司或联系人字段过长';
 if (row.tags !== undefined && (!Array.isArray(row.tags) || row.tags.length > LEAD_LIMITS.pageMax || row.tags.some(tag=>typeof tag !== 'string' || !tag.trim() || tag.length > LEAD_LIMITS.text))) return '联系人标签无效';
 if (row.remark !== undefined && (typeof row.remark !== 'string' || row.remark.length > IMPORT_REMARK_MAX)) return '未匹配字段备注过长';
 return undefined;
}
export interface ImportRequest {source:string;sourceDetail:string;idempotencyKey:string;rows:ImportRow[];mapping?:Record<string,string>;kind?:'personal'|'operations';companyMatching?:boolean;}
export interface CustomerContactInput {email:string;name?:string;country?:string;phone?:string;whatsapp?:string;title?:string;}
export interface CustomerProfile {customerType?:'代理'|'直客'|string;businessType?:string;developmentRestriction?:string;sourceCreatedAt?:string;}
export interface CustomerCreate extends CustomerProfile {companyName:string;country?:string;source:string;sourceDetail:string;contacts:CustomerContactInput[];idempotencyKey:string;}
export interface CustomerUpdate extends LeadCommand,CustomerProfile {companyName:string;country?:string;contacts:Array<CustomerContactInput & {contactId?:number}>;}
export interface LeadCommand {customerId:string;expectedVersion:number;idempotencyKey:string;}
export interface AssignRequest extends LeadCommand {salesUserId:string;notifyUserIds:string[];}
export interface CrmMember {userId:string;displayName:string;assignable:boolean;}
export interface MemberQuery {search:string;limit:number;offset:number;}
export interface MemberPage {items:CrmMember[];total:number;}
export interface PublishRequest {rowIds:string[];expectedVersion:number;idempotencyKey:string;}
export const FOLLOWUP_METHODS = ['email','phone','visit','other','note'] as const;
export type FollowupMethod = typeof FOLLOWUP_METHODS[number];
export const CONTACT_TOUCH_STATUSES = ['uncontacted','contacted','replied','bounced','autoreply'] as const;
export type ContactTouchStatus = typeof CONTACT_TOUCH_STATUSES[number];
/** Contact state is the admission criterion; a relationship stage is not proof of contact. */
export const FOLLOWUP_TOUCH_STATUSES: readonly ContactTouchStatus[] = ['contacted', 'replied', 'bounced', 'autoreply'];
export function hasContactedCustomer(contacts: readonly {touchStatus?:ContactTouchStatus}[]):boolean {
 return contacts.some(contact => contact.touchStatus !== undefined && FOLLOWUP_TOUCH_STATUSES.includes(contact.touchStatus));
}
export function customerBoardStage(customer: Pick<LeadPreview,'stage'|'hasContacted'>):CrmStage|undefined {
 return customer.hasContacted ? customer.stage && customer.stage !== 'cold' ? customer.stage : 'reaching' : undefined;
}
export const FOLLOWUP_METHOD_LABELS: Record<FollowupMethod | 'legacy',string> = {email:'邮件',phone:'电话',visit:'拜访',other:'其他联系',note:'备注',legacy:'历史记录'};
export const CONTACT_TOUCH_LABELS: Record<ContactTouchStatus,string> = {uncontacted:'未触达',contacted:'已触达',replied:'已回复',bounced:'退信',autoreply:'自动回复'};
export type CustomerStage = CrmStage | 'cold';
export const FOLLOWUP_TIME_LIMITS = {future_skew_seconds:60} as const;
export interface FollowupRequest extends LeadCommand {opportunityId?:string;note:string;stage?:CustomerStage;method?:FollowupMethod;occurredAt?:string;contactId?:number;contactStatus?:ContactTouchStatus;}
export interface ImportReceiptRow {rowId:string;index:number;status:'created'|'duplicate'|'invalid'|'restricted_conflict';customerId?:string;message?:string;}
export interface ImportReceipt {batchId:string;version:number;rows:ImportReceiptRow[];}
export interface LeadPreview {customerId:string;companyName:string;country:string|null;state:LeadState;version:number;contactCount:number;origin?:'personal'|'operations';stage?:CrmStage|'cold';ownerUserId?:string|null;source?:string;primaryContactName?:string|null;primaryContactEmail?:string|null;ownerName?:string|null;recentActivityAt?:string|null;hasContacted?:boolean;}
export interface LeadContact {contactId:number;email:string;name:string|null;country:string|null;phone?:string|null;whatsapp?:string|null;title?:string|null;touchStatus?:ContactTouchStatus;}
export interface LeadActivity {mailEventId?:string|null;mailSuperseded?:boolean;opportunityId?:string|null;opportunityTitle?:string|null;id:string;actorId:string;note:string;stage:CustomerStage|null;createdAt:string;actorName?:string|null;method?:FollowupMethod|'legacy';occurredAt?:string;recordedAt?:string;contactId?:number|null;contactName?:string|null;contactStatus?:ContactTouchStatus|null;}
export interface LeadDetail extends LeadPreview,CustomerProfile {source:string;sourceDetail:string;customerKey:string;ownerUserId:string|null;contacts:LeadContact[];activities:LeadActivity[];canEdit?:boolean;canFollowup?:boolean;canAssign?:boolean;stageNeedsReview?:boolean;}
export interface LeadQuery {view:'pool'|'mine'|'operations'|'personal'|'assigned'|'all';search:string;limit:number;offset:number;assignment?:'unassigned'|'assigned';stage?:CrmStage|'cold';followupOnly?:boolean;}
export interface LeadPage {items:LeadPreview[];total:number;}
export interface LeadBootstrap {userId:string;capabilities:string[];scope:DataScope;summary:{pool:number;mine:number};feedCursor:string;}
export interface PublishReceipt {batchId:string;version:number;publishedCustomerIds:string[];}
export interface LeadRepository {
 listContacts?(hash:string,query:CenterContactQuery):Promise<Result<CenterContactPage>>;
 listContactGroups?(hash:string,query:CenterContactGroupQuery):Promise<Result<CenterContactGroupPage>>;
 bootstrap(hash:string):Promise<Result<LeadBootstrap>>;importRows(hash:string,input:ImportRequest):Promise<Result<ImportReceipt>>;
 importWorkbook?(hash:string,input:WorkbookImportRequest):Promise<Result<WorkbookImportReceipt>>;
 publish(hash:string,batchId:string,input:PublishRequest):Promise<Result<PublishReceipt>>;
 list(hash:string,query:LeadQuery):Promise<Result<LeadPage>>;detail(hash:string,id:string):Promise<Result<LeadDetail>>;
 claim(hash:string,input:LeadCommand):Promise<Result<LeadDetail>>;followup(hash:string,input:FollowupRequest):Promise<Result<LeadDetail>>;
 createCustomer?(hash:string,input:CustomerCreate):Promise<Result<LeadDetail>>;
 updateCustomer?(hash:string,input:CustomerUpdate):Promise<Result<LeadDetail>>;
 assign?(hash:string,input:AssignRequest):Promise<Result<LeadDetail>>;
 members?(hash:string,query:MemberQuery):Promise<Result<MemberPage>>;
}

