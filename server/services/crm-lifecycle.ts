import { failure, success, type Result } from '../core/crm';
import { LIFECYCLE_LIMITS as L, type ContactDelete, type CompanyCreate, type CompanyDelete, type CompanyQuery, type LifecycleRepository } from '../core/crm-lifecycle';
import type { TokenPort } from '../core/auth';
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
const text=(v:unknown,max:number,min=1):v is string=>typeof v==='string'&&v.trim().length>=min&&v.length<=max;
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const invalid=()=>failure('INVALID_INPUT','资料操作参数无效');
export function contactDelete(v:unknown):Result<ContactDelete>{
 if(!record(v)||!keys(v,['contacts','idempotencyKey'])||!text(v.idempotencyKey,L.key)||!Array.isArray(v.contacts)||!v.contacts.length||v.contacts.length>L.batch||v.contacts.some(r=>!record(r)||!keys(r,['contactId','customerId','expectedVersion'])||!positive(r.contactId)||!uuid(r.customerId)||!positive(r.expectedVersion))||new Set(v.contacts.map(r=>r.contactId)).size!==v.contacts.length)return invalid();
 return success(v as unknown as ContactDelete);
}
export function companyCreate(v:unknown):Result<CompanyCreate>{
 if(!record(v)||!keys(v,['name','domain','idempotencyKey'])||!text(v.name,L.text)||!text(v.idempotencyKey,L.key)||v.domain!==undefined&&v.domain!==null&&(!text(v.domain,L.text)||!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(v.domain.trim())))return invalid();
 return success({name:v.name.trim(),domain:typeof v.domain==='string'?v.domain.trim().toLowerCase():null,idempotencyKey:v.idempotencyKey});
}
export function companyDelete(v:unknown):Result<CompanyDelete>{
 return record(v)&&keys(v,['companyId','expectedRevision','idempotencyKey'])&&positive(v.companyId)&&text(v.expectedRevision,L.text)&&text(v.idempotencyKey,L.key)?success(v as unknown as CompanyDelete):invalid();
}
export function companyQuery(v:unknown):Result<CompanyQuery>{
 if(!record(v)||!keys(v,['search','scope','limit','offset']))return invalid();
 const q={search:v.search??'',scope:v.scope??'all',limit:v.limit??L.page,offset:v.offset??0};
 return text(q.search,L.text,0)&&['all','personal','assigned'].includes(String(q.scope))&&positive(q.limit)&&Number(q.limit)<=L.pageMax&&Number.isSafeInteger(q.offset)&&Number(q.offset)>=0?success(q as CompanyQuery):invalid();
}
export function companyRef(v:unknown):Result<{companyId:number;scope:CompanyQuery['scope']}>{
 return record(v)&&keys(v,['companyId','scope'])&&positive(v.companyId)&&['all','personal','assigned'].includes(String(v.scope??'all'))?success({companyId:Number(v.companyId),scope:(v.scope??'all') as CompanyQuery['scope']}):invalid();
}
export function createLifecycleService(repo:Partial<LifecycleRepository>,tokens:TokenPort){
 function run<I,T>(token:string,v:unknown,parse:(v:unknown)=>Result<I>,send:(hash:string,input:I)=>Promise<Result<T>>|undefined):Promise<Result<T>>{if(!/^[A-Za-z0-9_-]{43}$/.test(token))return Promise.resolve(failure('UNAUTHORIZED','会话无效'));const p=parse(v);return p.ok?send(tokens.hash(token),p.data)??Promise.resolve(failure('UNAVAILABLE','资料操作尚未开放')):Promise.resolve(p);}
 return {deleteContacts:(t:string,v:unknown)=>run(t,v,contactDelete,(h,i)=>repo.deleteContacts?.(h,i)),createCompany:(t:string,v:unknown)=>run(t,v,companyCreate,(h,i)=>repo.createCompany?.(h,i)),deleteCompany:(t:string,v:unknown)=>run(t,v,companyDelete,(h,i)=>repo.deleteCompany?.(h,i)),companies:(t:string,v:unknown)=>run(t,v,companyQuery,(h,i)=>repo.companies?.(h,i)),companyDetail:(t:string,v:unknown)=>run(t,v,companyRef,(h,i)=>repo.companyDetail?.(h,i))};
}
