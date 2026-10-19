import {failure,success,type Result} from '../core/crm';
import type {TokenPort} from '../core/auth';
import {CONTACT_SHARED_FIELDS,type ContactShareCreate,type ContactShareDecision,type ContactShareUpdate,type ContactShareQuery,type ContactSharingRepository} from '../core/contact-sharing';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const LIMITS={page:50,max:100,key:128};
function record(v:unknown):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v);}
function uuid(v:unknown):boolean{return typeof v==='string'&&UUID.test(v);}
function positive(v:unknown):boolean{return Number.isSafeInteger(v)&&Number(v)>0;}
function keys(v:Record<string,unknown>,allowed:string[]):boolean{return Object.keys(v).every(k=>allowed.includes(k));}
function invalid<T>():Result<T>{return failure('INVALID_INPUT','共享参数无效');}
function version(v:Record<string,unknown>):boolean{return positive(v.expectedVersion)&&typeof v.idempotencyKey==='string'&&v.idempotencyKey.trim().length>0&&v.idempotencyKey.length<=LIMITS.key;}
function grant(v:Record<string,unknown>):boolean{return Array.isArray(v.editableFields)&&v.editableFields.every(f=>CONTACT_SHARED_FIELDS.includes(f as never))&&new Set(v.editableFields).size===v.editableFields.length&&typeof v.canFollowup==='boolean'&&typeof v.canChangeStage==='boolean';}
export function contactShareCreate(v:unknown):Result<ContactShareCreate>{return record(v)&&keys(v,['contactId','customerId','expectedVersion','targetUserId','editableFields','canFollowup','canChangeStage','idempotencyKey'])&&positive(v.contactId)&&uuid(v.customerId)&&uuid(v.targetUserId)&&version(v)&&grant(v)?success(v as unknown as ContactShareCreate):invalid();}
export function contactShareDecision(v:unknown):Result<ContactShareDecision>{return record(v)&&keys(v,['shareId','expectedVersion','idempotencyKey'])&&uuid(v.shareId)&&version(v)?success(v as unknown as ContactShareDecision):invalid();}
export function contactShareUpdate(v:unknown):Result<ContactShareUpdate>{return record(v)&&keys(v,['shareId','expectedVersion','idempotencyKey','editableFields','canFollowup','canChangeStage'])&&uuid(v.shareId)&&version(v)&&grant(v)?success(v as unknown as ContactShareUpdate):invalid();}
export function contactShareQuery(v:unknown):Result<ContactShareQuery>{
 if(!record(v)||!keys(v,['view','status','contactId','customerId','limit','offset']))return invalid();
 const q={view:v.view??'incoming',limit:v.limit??LIMITS.page,offset:v.offset??0,...(v.status!==undefined?{status:v.status}:{}),...(v.contactId!==undefined?{contactId:v.contactId}:{}),...(v.customerId!==undefined?{customerId:v.customerId}:{})};
 if(!['incoming','outgoing'].includes(String(q.view))||!positive(q.limit)||Number(q.limit)>LIMITS.max||!Number.isSafeInteger(q.offset)||Number(q.offset)<0||v.status!==undefined&&!['pending','accepted','rejected','revoked'].includes(String(v.status))||v.contactId!==undefined&&!positive(v.contactId)||v.customerId!==undefined&&!uuid(v.customerId))return invalid();return success(q as ContactShareQuery);
}
export function createContactSharingService(repo:ContactSharingRepository,tokens:TokenPort){
 function run<T,I>(token:string,v:unknown,parse:(v:unknown)=>Result<I>,work:(hash:string,i:I)=>Promise<Result<T>>):Promise<Result<T>>{if(!/^[A-Za-z0-9_-]{43}$/.test(token))return Promise.resolve(failure('UNAUTHORIZED','会话无效'));const p=parse(v);return p.ok?work(tokens.hash(token),p.data):Promise.resolve(p);}
 return {shares:(t:string,v:unknown)=>run(t,v,contactShareQuery,(h,i)=>repo.shares(h,i)),createShare:(t:string,v:unknown)=>run(t,v,contactShareCreate,(h,i)=>repo.createShare(h,i)),decideShare:(t:string,a:'accept'|'reject'|'revoke',v:unknown)=>run(t,v,contactShareDecision,(h,i)=>repo.decideShare(h,a,i)),updateShare:(t:string,v:unknown)=>run(t,v,contactShareUpdate,(h,i)=>repo.updateShare(h,i)),shareMembers:(t:string)=>run(t,{},()=>success({}),(h)=>repo.shareMembers(h))};
}
export type ContactSharingService=ReturnType<typeof createContactSharingService>;
