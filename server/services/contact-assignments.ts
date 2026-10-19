import {failure,success,type Result,CRM_STAGES} from '../core/crm';
import type {TokenPort} from '../core/auth';
import {FOLLOWUP_METHODS,CONTACT_TOUCH_STATUSES,FOLLOWUP_TIME_LIMITS} from '../core/leads';
import {CONTACT_ASSIGNMENT_LIMITS as L,type ContactAssignmentRepository,type ContactAssignmentCreate,type ContactAssignmentDecision,type ContactAssignmentQuery,type CenterCompanyUpdate,type CenterContactRef,type CenterContactUpdate,type CenterContactFollowup} from '../core/contact-assignments';
import {createLifecycleService} from './crm-lifecycle';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MILLISECONDS_PER_SECOND=1000;
const EMAIL_LIMIT=254;
const TIME_LIMIT={hour:24,minute:60,second:60};
const UPDATE_FIELDS=['email','firstName','lastName','title','phone','whatsapp','sourceLevel1','sourceLevel2','linkedinUrl','country','clientType','language','stage','status','tags','preferences'];
function record(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function keys(v:Record<string,unknown>,allowed:string[]){return Object.keys(v).every(k=>allowed.includes(k));}
function text(v:unknown,max:number,min=1):v is string{return typeof v==='string'&&v.trim().length>=min&&v.length<=max;}
function uuid(v:unknown):v is string{return typeof v==='string'&&UUID.test(v);}
function positive(v:unknown):v is number{return Number.isSafeInteger(v)&&Number(v)>0;}
function version(v:Record<string,unknown>){return positive(v.expectedVersion)&&text(v.idempotencyKey,L.key);}
function ref(v:Record<string,unknown>){return positive(v.contactId)&&uuid(v.customerId);}
function invalid<T>():Result<T>{return failure('INVALID_INPUT','联系人或分配参数无效');}
export function contactRef(v:unknown):Result<CenterContactRef>{return record(v)&&keys(v,['contactId','customerId'])&&ref(v)?success(v as unknown as CenterContactRef):invalid();}
const COMPANY_FIELDS = ['customerType','name','domain','country','industry','size','backcheckData'];
const COMPANY_REPORT_MAX = 100000;
export function companyUpdate(v: unknown): Result<CenterCompanyUpdate> {
 if (!record(v) || !keys(v,['contactId','customerId','expectedRevision','idempotencyKey','fields']) || !ref(v) || !text(v.idempotencyKey,L.key) || !text(v.expectedRevision,L.text) || !record(v.fields) || !Object.keys(v.fields).length || !keys(v.fields,COMPANY_FIELDS)) return invalid();
 for (const [field,value] of Object.entries(v.fields)) {
  if (field === 'customerType' && value!==null && value!=='代理' && value!=='直客') return invalid();
  if (field === 'backcheckData') { if (value !== null && (!record(value) || JSON.stringify(value).length > COMPANY_REPORT_MAX)) return invalid(); }
  else if (field === 'name' ? !text(value,L.text) : value !== null && !text(value,L.text,0)) return invalid();
 }
 return success(v as unknown as CenterCompanyUpdate);
}
export function contactAssignmentCreate(v:unknown):Result<ContactAssignmentCreate>{
 if(!record(v)||!keys(v,['contacts','targetUserId','notifyUserIds','idempotencyKey'])||!uuid(v.targetUserId)||!text(v.idempotencyKey,L.key)||!Array.isArray(v.contacts)||!v.contacts.length||v.contacts.length>L.batch||v.contacts.some(x=>!record(x)||!keys(x,['contactId','customerId','expectedVersion'])||!ref(x)||!positive(x.expectedVersion))||new Set(v.contacts.map(x=>x.contactId)).size!==v.contacts.length||!Array.isArray(v.notifyUserIds)||v.notifyUserIds.length>L.notify||v.notifyUserIds.some(x=>!uuid(x))||new Set(v.notifyUserIds).size!==v.notifyUserIds.length)return invalid();return success(v as unknown as ContactAssignmentCreate);
}
export function contactAssignmentDecision(v:unknown):Result<ContactAssignmentDecision>{return record(v)&&keys(v,['requestId','expectedVersion','idempotencyKey'])&&uuid(v.requestId)&&version(v)?success(v as unknown as ContactAssignmentDecision):invalid();}
export function contactAssignmentQuery(v:unknown):Result<ContactAssignmentQuery>{
 if(!record(v)||!keys(v,['view','status','search','limit','offset','requestId'])||v.requestId!==undefined&&!uuid(v.requestId))return invalid();const query={view:v.view??'incoming',status:v.status??'pending',search:v.search??'',limit:v.limit??L.page,offset:v.offset??0,...(v.requestId!==undefined?{requestId:v.requestId}:{})};
 if(!['incoming','outgoing'].includes(query.view as string)||!['pending','accepted','rejected','cancelled'].includes(query.status as string)||!text(query.search,L.text,0)||!positive(query.limit)||Number(query.limit)>L.pageMax||!Number.isSafeInteger(query.offset)||Number(query.offset)<0)return invalid();return success({...query,search:query.search.trim()} as ContactAssignmentQuery);
}
export function contactUpdate(v:unknown):Result<CenterContactUpdate>{
 if(!record(v)||!keys(v,['contactId','customerId','expectedVersion','idempotencyKey','fields'])||!ref(v)||!version(v)||!record(v.fields)||!Object.keys(v.fields).length||!keys(v.fields,UPDATE_FIELDS))return invalid();
 for(const [key,value] of Object.entries(v.fields)){
  if(key==='tags'){if(!Array.isArray(value)||value.length>L.pageMax||value.some(x=>!text(x,L.text))||new Set(value).size!==value.length)return invalid();continue;}
  if(key==='preferences'){if(!Array.isArray(value)||value.length>L.preferences||value.some(x=>!text(x,L.preferenceText))||new Set(value).size!==value.length)return invalid();continue;}
  if(value!==null&&!text(value,L.text,0)||['stage','status'].includes(key)&&value===null)return invalid();
  if(key==='email'&&typeof value==='string'&&value.trim()&&(value.length>EMAIL_LIMIT||!/^\S+@[^\s@]+\.[^\s@]+$/.test(value.trim())))return invalid();
 }return success(v as unknown as CenterContactUpdate);
}
function occurrence(v:unknown){
 if(typeof v!=='string')return false;const p=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(v);if(!p)return false;const d=new Date(`${p[1]}-${p[2]}-${p[3]}T00:00:00Z`);return d.getUTCFullYear()===Number(p[1])&&d.getUTCMonth()+1===Number(p[2])&&d.getUTCDate()===Number(p[3])&&Number(p[4])<TIME_LIMIT.hour&&Number(p[5])<TIME_LIMIT.minute&&Number(p[6])<TIME_LIMIT.second&&(p[8]===undefined||Number(p[8])<TIME_LIMIT.hour&&Number(p[9])<TIME_LIMIT.minute)&&Number.isFinite(Date.parse(v))&&Date.parse(v)<=Date.now()+FOLLOWUP_TIME_LIMITS.future_skew_seconds*MILLISECONDS_PER_SECOND;
}
export function contactFollowup(v:unknown):Result<CenterContactFollowup>{
 if(!record(v)||!keys(v,['contactId','customerId','expectedVersion','idempotencyKey','note','stage','method','occurredAt','contactStatus'])||!ref(v)||!version(v)||!text(v.note,L.note)||v.stage!==undefined&&!['cold',...CRM_STAGES].includes(v.stage as never)||v.method!==undefined&&!FOLLOWUP_METHODS.includes(v.method as never)||v.occurredAt!==undefined&&!occurrence(v.occurredAt)||v.contactStatus!==undefined&&(!CONTACT_TOUCH_STATUSES.includes(v.contactStatus as never)||v.method==='note'))return invalid();return success(v as unknown as CenterContactFollowup);
}
export function createContactAssignmentService(repo:ContactAssignmentRepository,tokens:TokenPort){
 function run<T,I>(token:string,v:unknown,validate:(v:unknown)=>Result<I>,work:(hash:string,input:I)=>Promise<Result<T>>):Promise<Result<T>>{if(!/^[A-Za-z0-9_-]{43}$/.test(token))return Promise.resolve(failure('UNAUTHORIZED','会话无效'));const parsed=validate(v);return parsed.ok?work(tokens.hash(token),parsed.data):Promise.resolve(parsed);}
 return {...createLifecycleService(repo,tokens),companyUpdate:(t:string,v:unknown)=>run(t,v,companyUpdate,(h,i)=>repo.companyUpdate?.(h,i) ?? Promise.resolve(failure('UNAVAILABLE','公司资料保存尚未开放'))),contactDetail:(t:string,v:unknown)=>run(t,v,contactRef,(h,i)=>repo.contactDetail(h,i)),contactUpdate:(t:string,v:unknown)=>run(t,v,contactUpdate,(h,i)=>repo.contactUpdate(h,i)),contactFollowup:(t:string,v:unknown)=>run(t,v,contactFollowup,(h,i)=>repo.contactFollowup(h,i)),assignments:(t:string,v:unknown)=>run(t,v,contactAssignmentQuery,(h,i)=>repo.contactAssignments(h,i)),createAssignments:(t:string,v:unknown)=>run(t,v,contactAssignmentCreate,(h,i)=>repo.createContactAssignments(h,i)),decide:(t:string,action:'accept'|'reject'|'cancel',v:unknown)=>run(t,v,contactAssignmentDecision,(h,i)=>repo.decideContactAssignment(h,action,i))};
}
export type ContactAssignmentService=ReturnType<typeof createContactAssignmentService>;
