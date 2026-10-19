import {sharedAccessSql} from './contact-sharing-sql';
import type { PoolClient } from 'pg';
import { failure, success, type Result } from '../../core/crm';
import type { ContactDelete,ContactDeleteReceipt,CompanyCreate,CompanyDelete,CompanyQuery,CompanyPage,CompanyDetail,CenterCompany } from '../../core/crm-lifecycle';
import { CONTACT_OWNER_SQL,contactManager,loadContactIn,canReadContact,canDeleteContact,recordContactEventIn,lifecycleCached,listContactsIn } from './contact-assignment-repository';
import type { LeadActor } from './lead-repository';

const DETAIL_SCAN_PAGES=100;
const CONTACT_PAGE_SIZE=100;
const global=(a:LeadActor)=>a.roles.includes('admin')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('leads.read.all');
const creator=(a:LeadActor,co:{createdBy:string|null})=>global(a)||co.createdBy===a.userId&&a.capabilities.includes('leads.create')&&a.capabilities.includes('leads.develop');
const createAllowed=(a:LeadActor)=>a.capabilities.includes('leads.create')&&a.capabilities.includes('leads.develop');
/** Every count and company entry uses the same contact authorization and origin filter. */
function contactGuard(a:LeadActor,scope:CompanyQuery['scope']){
 const auth=global(a)?'TRUE':`((${contactManager(a)?'TRUE':'FALSE'} AND c.origin='operations') OR (${a.capabilities.includes('leads.develop')?'TRUE':'FALSE'} AND (${CONTACT_OWNER_SQL}=$1 OR ${sharedAccessSql('$1',CONTACT_OWNER_SQL)})))`;
 const origin=scope==='personal'?`c.origin='personal' AND ${CONTACT_OWNER_SQL}=$1`:scope==='assigned'?`c.origin='operations' AND (${CONTACT_OWNER_SQL}=$1 OR ${sharedAccessSql('$1',CONTACT_OWNER_SQL)})`:'TRUE';
 return `ct.crm_deleted_at IS NULL AND ${auth} AND (${origin})`;
}
function projection(a:LeadActor,scope:CompanyQuery['scope']){
 const count=`(SELECT count(*)::int FROM contacts ct JOIN crm_customer_contacts cc ON cc.contact_id=ct.id JOIN crm_customers c ON c.customer_id=cc.customer_id WHERE c.company_id=co.id AND ${contactGuard(a,scope)})`;
 const empty="NOT EXISTS(SELECT 1 FROM contacts WHERE company_id=co.id) AND NOT EXISTS(SELECT 1 FROM crm_customers WHERE company_id=co.id)";
 return `co.id AS "companyId",co.name,co.customer_type AS "customerType",co.domain,co.industry,co.country,co.size,co.updated_at::text AS revision,co.created_at AS "createdAt",co.updated_at AS "updatedAt",${count} AS "contactCount",((${global(a)?'TRUE':'FALSE'} OR co.crm_created_by=$1 AND ${createAllowed(a)?'TRUE':'FALSE'}) AND ${empty}) AS "canDelete"`;
}
function visibility(a:LeadActor,scope:CompanyQuery['scope']){
 const emptyOwn=scope==='assigned'?'FALSE':`(co.crm_created_by=$1 AND ${a.capabilities.includes('leads.develop')?'TRUE':'FALSE'})`;
 const ownCustomer=scope==='all'&&contactManager(a)?`EXISTS(SELECT 1 FROM crm_customers c WHERE c.company_id=co.id AND c.origin='operations')`:'FALSE';
 return `co.crm_deleted_at IS NULL AND (${global(a)&&scope==='all'?'TRUE':'FALSE'} OR ${emptyOwn} OR ${ownCustomer} OR EXISTS(SELECT 1 FROM contacts ct JOIN crm_customer_contacts cc ON cc.contact_id=ct.id JOIN crm_customers c ON c.customer_id=cc.customer_id WHERE c.company_id=co.id AND ${contactGuard(a,scope)}))`;
}
function mapped(co:CenterCompany):CenterCompany{return {...co,canDelete:!!co.canDelete,createdAt:new Date(co.createdAt).toISOString(),updatedAt:new Date(co.updatedAt).toISOString()};}
export async function companiesIn(c:PoolClient,a:LeadActor,q:CompanyQuery):Promise<Result<CompanyPage>>{
 if(!global(a)&&!contactManager(a)&&!a.capabilities.includes('leads.develop'))return failure('FORBIDDEN','无公司查询权限');
 const where=`WHERE ${visibility(a,q.scope)} AND (co.name ILIKE $2 ESCAPE '!' OR co.domain ILIKE $2 ESCAPE '!')`,args=[a.userId,`%${q.search.replace(/[!%_]/g,'!$&')}%`];
 const count=await c.query(`SELECT count(*)::int AS n FROM companies co ${where}`,args);
 const rows=await c.query(`SELECT ${projection(a,q.scope)} FROM companies co ${where} ORDER BY co.updated_at DESC,co.id DESC LIMIT $3 OFFSET $4`,[...args,q.limit,q.offset]);
 return success({items:rows.rows.map(mapped),total:count.rows[0].n});
}
export async function companyDetailIn(c:PoolClient,a:LeadActor,input:{companyId:number;scope:CompanyQuery['scope']}):Promise<Result<CompanyDetail>>{
 const co=(await c.query(`SELECT ${projection(a,input.scope)} FROM companies co WHERE co.id=$2 AND ${visibility(a,input.scope)}`,[a.userId,input.companyId])).rows[0];
 if(!co)return failure('NOT_FOUND','公司不存在');
 const contacts:CompanyDetail['contacts']=[];
 for(let page=0;page<DETAIL_SCAN_PAGES;page++){
  const r=await listContactsIn(c,a,{search:'',scope:input.scope,limit:CONTACT_PAGE_SIZE,offset:contacts.length},input.companyId);
  if(!r.ok)return r;contacts.push(...r.data.items);if(contacts.length>=r.data.total)return success({company:mapped(co),contacts});
 }
 return failure('UNAVAILABLE','公司联系人过多，请在联系人列表筛选查看');
}
async function companyEvent(c:PoolClient,a:LeadActor,type:string,companyId:number){await c.query("INSERT INTO identity.outbox(event_type,user_id,product_id,revision,payload,recipient_user_ids) VALUES($1,$2,'crm',1,$3,$4::uuid[])",[type,a.userId,JSON.stringify({companyId}),[a.userId]]);}
export async function createCompanyIn(c:PoolClient,a:LeadActor,input:CompanyCreate):Promise<Result<CompanyDetail>>{
 if(!createAllowed(a))return failure('FORBIDDEN','无公司创建权限');
 return lifecycleCached(c,a,'company-create',input,async()=>{
  if((await c.query('SELECT 1 FROM companies WHERE crm_created_by=$1 AND lower(btrim(name))=lower(btrim($2)) AND crm_deleted_at IS NULL',[a.userId,input.name])).rowCount)return failure('CONFLICT','已有同名公司');
  const co=(await c.query('INSERT INTO companies(name,domain,crm_created_by) VALUES($1,$2,$3) RETURNING id',[input.name,input.domain??null,a.userId])).rows[0];
  await companyEvent(c,a,'crm.company.created',co.id);return companyDetailIn(c,a,{companyId:co.id,scope:'all'});
 },old=>companyDetailIn(c,a,{companyId:old.company.companyId,scope:'all'}));
}
export async function deleteCompanyIn(c:PoolClient,a:LeadActor,input:CompanyDelete):Promise<Result<{companyId:number}>>{
 const co=(await c.query('SELECT crm_created_by AS "createdBy",crm_deleted_at,updated_at::text AS revision FROM companies WHERE id=$1 FOR UPDATE',[input.companyId])).rows[0];
 if(!co||!creator(a,co))return failure('NOT_FOUND','公司不存在或不可删除');
 return lifecycleCached(c,a,`company-delete:${input.companyId}`,input,async()=>{
  if(co.crm_deleted_at||co.revision!==input.expectedRevision)return failure('CONFLICT','公司资料已变化，请刷新重试');
  // Existing customer foreign keys cover tasks, opportunities, assignment and customer history.
  if((await c.query('SELECT 1 FROM contacts WHERE company_id=$1 UNION ALL SELECT 1 FROM crm_customers WHERE company_id=$1 LIMIT 1',[input.companyId])).rowCount)return failure('CONFLICT','公司有关联资料，不能删除');
  await c.query('UPDATE companies SET crm_deleted_at=clock_timestamp(),crm_deleted_by=$2,updated_at=clock_timestamp() WHERE id=$1',[input.companyId,a.userId]);
  await companyEvent(c,a,'crm.company.deleted',input.companyId);return success({companyId:input.companyId});
 });
}
export async function deleteContactsIn(c:PoolClient,a:LeadActor,input:ContactDelete):Promise<Result<ContactDeleteReceipt>>{
 const contacts:Array<NonNullable<Awaited<ReturnType<typeof loadContactIn>>>>=[];
 for(const ref of [...input.contacts].sort((x,y)=>x.contactId-y.contactId)){
  const ct=await loadContactIn(c,ref,true,true);if(!ct||!canReadContact(a,ct)||!canDeleteContact(a,ct))return failure('FORBIDDEN','所选联系人不可删除；分配线索须由来源管理员处理，待接受请求须先撤回');contacts.push(ct);
 }
 return lifecycleCached(c,a,'contact-delete',input,async()=>{
  for(const ct of contacts){const expected=input.contacts.find(r=>r.contactId===ct.contactId)!.expectedVersion;
   const state=(await c.query('SELECT crm_deleted_at FROM contacts WHERE id=$1',[ct.contactId])).rows[0];
   if(state.crm_deleted_at||ct.contactVersion!==expected)return failure('CONFLICT','联系人已变化，请刷新重选');
  }
  const deleted:ContactDeleteReceipt['deleted']=[];
  for(const ct of contacts){const version=ct.contactVersion!+1;await c.query('UPDATE contacts SET crm_deleted_at=clock_timestamp(),crm_deleted_by=$2,crm_contact_version=$3,updated_at=clock_timestamp() WHERE id=$1',[ct.contactId,a.userId,version]);await recordContactEventIn(c,a,ct,'crm.contact.deleted',version);deleted.push({contactId:ct.contactId,customerId:ct.customerId,contactVersion:version});}
  return success({deleted});
 });
}
