import {effectiveActivitySql,lastEffectiveFollowupSql} from './contact-mail-projection-sql';
import {refreshMailProjectionIn} from './contact-mail-correction-repository';
import {contactPermissions,sourceContactManager} from '../../core/contact-permissions';
import type {ContactPermissions,ContactShareGrant} from '../../core/contact-sharing';
import {sharedAccessSql,validShareSql} from './contact-sharing-sql';
import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {failure,success,type Result} from '../../core/crm';
import {CONTACT_ASSIGNMENT_EVENTS,isContactAssignmentTarget,type ContactAssignment,type ContactAssignmentCreate,type ContactAssignmentDecision,type ContactAssignmentQuery,type CenterCompanyUpdate,type CenterContactRef,type CenterContactUpdate,type CenterContactFollowup,type CenterContactDetail} from '../../core/contact-assignments';
import type {CenterContact,CenterContactQuery,CenterContactPage} from '../../core/center-contacts';
import {FOLLOWUP_TIME_LIMITS} from '../../core/leads';
import type {LeadActor} from './lead-repository';
import {CONTACT_MAIL_LIMITS} from '../../core/contact-mail';
import {contactMailEventsIn} from './contact-mail-repository';
const MILLISECONDS_PER_SECOND=1000;
const FOLLOWUP_LEGACY_STATUS={contacted:'reached',replied:'replied',bounced:'bounced',autoreply:'autoreply',uncontacted:''} as const;
export const CONTACT_OWNER_SQL="COALESCE((SELECT ar.target_user_id FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status='accepted'),c.owner_user_id)";
const JOINS=`FROM contacts ct JOIN crm_customer_contacts cc ON cc.contact_id=ct.id JOIN crm_customers c ON c.customer_id=cc.customer_id JOIN companies co ON co.id=c.company_id`;
const LAST_FOLLOWUP_AT=lastEffectiveFollowupSql('occurred_at');
const LAST_FOLLOWUP_NOTE=lastEffectiveFollowupSql('note');
const PROJECTION=`ct.id AS "contactId",c.customer_id AS "customerId",c.version AS "customerVersion",ct.crm_contact_version AS "contactVersion",co.id AS "companyId",co.name AS "companyName",co.industry AS "businessType",co.domain AS website,ct.email,ct.first_name AS "firstName",ct.last_name AS "lastName",ct.title,ct.phone,ct.whatsapp,ct.linkedin AS "linkedinUrl",COALESCE(co.country,ct.country) AS country,COALESCE(CASE co.customer_type WHEN '代理' THEN 'agent' WHEN '直客' THEN 'direct' END,ct.client_type) AS "clientType",ct.language,ct.stage,ct.status,ct.tags,ct.extra,ct.crm_touch_status AS "touchStatus",ct.assignee,ct.source,ct.source_detail AS "sourceDetail",ct.source_level1 AS "sourceLevel1",ct.source_level2 AS "sourceLevel2",ct.created_at AS "createdAt",ct.updated_at AS "updatedAt",${CONTACT_OWNER_SQL} AS "ownerUserId",(SELECT u.display_name FROM identity.users u WHERE u.user_id=${CONTACT_OWNER_SQL}) AS "ownerName",c.origin,c.state,c.created_by,c.development_restriction,(SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',sh.target_user_id,'editableFields',sh.editable_fields,'canFollowup',sh.can_followup,'canChangeStage',sh.can_change_stage)),'[]'::jsonb) FROM crm_contact_shares sh WHERE sh.contact_id=ct.id AND sh.customer_id=c.customer_id AND sh.status='accepted' AND EXISTS(SELECT 1 FROM identity.product_grants tg WHERE tg.user_id=sh.target_user_id AND tg.product_id='crm' AND tg.role='sales' AND tg.active) AND ${validShareSql(CONTACT_OWNER_SQL)}) AS shared_grants,(SELECT ar.status FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status IN ('pending','accepted')) AS active_assignment_status,(SELECT act.stage FROM crm_shared_activities act WHERE act.contact_id=ct.id AND act.customer_id=c.customer_id AND act.stage IS NOT NULL ORDER BY act.occurred_at DESC,act.id DESC LIMIT 1) AS "relationshipStage",${LAST_FOLLOWUP_AT} AS "lastFollowupAt",${LAST_FOLLOWUP_NOTE} AS "lastFollowupNote"`;
export type ContactRow=CenterContact & {created_by:string;development_restriction:string|null;active_assignment_status:string|null;shared_grants?:Array<ContactShareGrant & {targetUserId:string}>};
export function contactPermissionsFor(a:LeadActor,row:ContactRow):ContactPermissions{return contactPermissions(a,{...row,shared_grant:row.shared_grants?.find(g=>g.targetUserId===a.userId)});}
export function contactManager(a:LeadActor):boolean {return ['shared','summary'].includes(a.scope)&&a.roles.some(r=>r==='admin'||r==='operations')&&a.capabilities.includes('leads.assign');}
function all(a:LeadActor):boolean{return a.roles.includes('admin')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('leads.read.all');}
function ownManager(a:LeadActor,row:ContactRow):boolean{return sourceContactManager(a,row);}
function read(a:LeadActor,row:ContactRow):boolean{return all(a)||ownManager(a,row)||a.capabilities.includes('leads.develop')&&(row.ownerUserId===a.userId||!!row.shared_grants?.some(g=>g.targetUserId===a.userId));}
function edit(a:LeadActor,row:ContactRow):boolean{return contactPermissionsFor(a,row).editableFields.length>0;}
function assign(a:LeadActor,row:ContactRow):boolean{return contactManager(a)&&row.origin==='operations'&&!row.development_restriction?.trim()&&row.ownerUserId===null&&!row.active_assignment_status;}
export function canDeleteContact(a:LeadActor,row:ContactRow):boolean{return row.active_assignment_status!=='pending'&&(all(a)||ownManager(a,row)||row.origin==='personal'&&row.ownerUserId===a.userId&&a.capabilities.includes('leads.develop'));}
function mapped(a:LeadActor,row:ContactRow):CenterContact {const {created_by:_,development_restriction:__,active_assignment_status:___,shared_grants:____,...ct}=row;const permissions=contactPermissionsFor(a,row);return {...ct,assignmentStatus:row.active_assignment_status as CenterContact['assignmentStatus'],relationshipStage:ct.relationshipStage??(['contacted','replied','bounced','autoreply'].includes(ct.touchStatus)?'reaching':'cold'),lastFollowupAt:ct.lastFollowupAt?new Date(ct.lastFollowupAt).toISOString():null,lastFollowupNote:ct.lastFollowupNote??null,createdAt:new Date(ct.createdAt).toISOString(),updatedAt:new Date(ct.updatedAt).toISOString(),canDelete:canDeleteContact(a,row),permissions,isShared:!!row.shared_grants?.some(g=>g.targetUserId===a.userId)&&row.ownerUserId!==a.userId,canSendMail:permissions.canSendMail,canEdit:edit(a,row),canFollowup:permissions.canFollowup,canAssign:assign(a,row)};}
async function contact(c:PoolClient,input:CenterContactRef,lock=false,includeDeleted=false):Promise<ContactRow|undefined>{return (await c.query(`SELECT ${PROJECTION} ${JOINS} WHERE ct.id=$1 AND c.customer_id=$2 AND co.crm_deleted_at IS NULL ${includeDeleted?'':'AND ct.crm_deleted_at IS NULL'} ${lock?'FOR UPDATE OF ct,c':''}`,[input.contactId,input.customerId])).rows[0];}
export async function contactDetailIn(c:PoolClient,a:LeadActor,input:CenterContactRef):Promise<Result<CenterContactDetail>>{
 const ct=await contact(c,input);if(!ct||!read(a,ct))return failure('NOT_FOUND','联系人不存在');
 const co=(await c.query('SELECT customer_type AS "customerType",industry,country,size,updated_at::text AS revision,domain,backcheck_data AS "backcheckData" FROM companies WHERE id=$1',[ct.companyId])).rows[0];
 const activities=await c.query(`SELECT act.id::text,(SELECT mf.event_id::text FROM crm_contact_mail_events mf WHERE mf.activity_id=act.id LIMIT 1) AS "mailEventId",NOT (${effectiveActivitySql()}) AS "mailSuperseded",act.actor_id AS "actorId",u.display_name AS "actorName",act.note,act.stage,act.method,act.contact_id AS "contactId",act.contact_status AS "contactStatus",act.created_at AS "createdAt",act.occurred_at AS "occurredAt",act.recorded_at AS "recordedAt",ct.first_name AS "contactName" FROM crm_shared_activities act LEFT JOIN identity.users u ON u.user_id=act.actor_id LEFT JOIN contacts ct ON ct.id=act.contact_id WHERE act.customer_id=$1 AND act.contact_id=$2 AND act.opportunity_id IS NULL ORDER BY act.occurred_at DESC,act.id DESC`,[input.customerId,input.contactId]);
 return success({contact:mapped(a,ct),company:{companyId:ct.companyId,name:ct.companyName,domain:co.domain,backcheckData:co.backcheckData,customerType:co.customerType,industry:co.industry,country:co.country,size:co.size,revision:co.revision,canEdit:await companyEditable(c,a,ct)},activities:activities.rows.map(x=>({...x,createdAt:new Date(x.createdAt).toISOString(),occurredAt:new Date(x.occurredAt).toISOString(),recordedAt:new Date(x.recordedAt).toISOString()})),canDelete:canDeleteContact(a,ct),permissions:contactPermissionsFor(a,ct),canSendMail:contactPermissionsFor(a,ct).canSendMail,canEdit:edit(a,ct),canFollowup:contactPermissionsFor(a,ct).canFollowup,canAssign:assign(a,ct),mailAvailable:true,mailEvents:await contactMailEventsIn(c,input),mailEventLimit:CONTACT_MAIL_LIMITS.history});
}
export async function listContactsIn(c:PoolClient,a:LeadActor,q:CenterContactQuery,companyId?:number):Promise<Result<CenterContactPage>>{
 const manager=contactManager(a),global=all(a),develop=a.capabilities.includes('leads.develop');if(!manager&&!global&&!develop)return failure('FORBIDDEN','无联系人查询权限');
 const filter=`WHERE ct.crm_deleted_at IS NULL AND co.crm_deleted_at IS NULL ${companyId!==undefined?`AND co.id=${companyId}`:""} AND ($1::boolean OR ($2::boolean AND c.origin='operations') OR ($3::boolean AND (${CONTACT_OWNER_SQL}=$4::uuid OR ${sharedAccessSql('$4::uuid',CONTACT_OWNER_SQL)})))
 AND (ct.email ILIKE $5 ESCAPE '!' OR ct.first_name ILIKE $5 ESCAPE '!' OR ct.last_name ILIKE $5 ESCAPE '!' OR ct.title ILIKE $5 ESCAPE '!' OR co.name ILIKE $5 ESCAPE '!')
 AND ($6::text IS NULL OR ct.stage=$6) AND ($7::text IS NULL OR ct.status=$7) AND ($8::text IS NULL OR ct.tags ? $8) AND ($9::text IS NULL OR COALESCE(CASE co.customer_type WHEN '代理' THEN 'agent' WHEN '直客' THEN 'direct' END,ct.client_type)=$9) AND ($10::text IS NULL OR COALESCE(co.country,ct.country)=$10)
 AND ($11::text='all' OR ($11='personal' AND c.origin='personal' AND ${CONTACT_OWNER_SQL}=$4::uuid) OR ($11='assigned' AND c.origin='operations' AND (${CONTACT_OWNER_SQL}=$4::uuid OR ${sharedAccessSql('$4::uuid',CONTACT_OWNER_SQL)})))
 AND ($12::text IS NULL OR ($12='accepted' AND EXISTS(SELECT 1 FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status='accepted')) OR ($12='unassigned' AND ${CONTACT_OWNER_SQL} IS NULL AND NOT EXISTS(SELECT 1 FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status='pending')))
 AND (NOT $13::boolean OR ct.crm_touch_status IN ('contacted','replied','bounced','autoreply'))
 AND ($14::text IS NULL OR COALESCE((SELECT act.stage FROM crm_shared_activities act WHERE act.contact_id=ct.id AND act.customer_id=c.customer_id AND act.stage IS NOT NULL ORDER BY act.occurred_at DESC,act.id DESC LIMIT 1),CASE WHEN ct.crm_touch_status IN ('contacted','replied','bounced','autoreply') THEN 'reaching' ELSE 'cold' END)=$14)
 AND ($15::text IS NULL OR ct.crm_touch_status=$15) AND ($16::text IS NULL OR ct.language=$16)`;
 const p=[global,manager,develop,a.userId,`%${q.search.replace(/[!%_]/g,'!$&')}%`,q.stage??null,q.status??null,q.tags??null,q.clientType??null,q.country??null,q.scope??'all',q.assignment??null,q.followupOnly??false,q.crmStage??null,q.touchStatus??null,q.language??null];
 // Materialize only authorized row identities before expensive display projections. Pair the
 // contact with its customer so pagination cannot grant access to a sibling association.
 const order=q.followupOnly?'page.last_followup_at DESC NULLS LAST,':'';
 const count=await c.query(`SELECT count(*)::int AS n ${JOINS} ${filter}`,p),rows=await c.query(`WITH contact_page AS MATERIALIZED (
 SELECT ct.id AS contact_id,c.customer_id,ct.updated_at ${q.followupOnly?`,${LAST_FOLLOWUP_AT} AS last_followup_at`:''}
 ${JOINS} ${filter} ORDER BY ${q.followupOnly?'last_followup_at DESC NULLS LAST,':''}ct.updated_at DESC,ct.id DESC LIMIT $17 OFFSET $18
 ) SELECT ${PROJECTION} FROM contact_page page JOIN contacts ct ON ct.id=page.contact_id JOIN crm_customer_contacts cc ON cc.contact_id=page.contact_id AND cc.customer_id=page.customer_id JOIN crm_customers c ON c.customer_id=page.customer_id JOIN companies co ON co.id=c.company_id
 ORDER BY ${order}page.updated_at DESC,page.contact_id DESC`,[...p,q.limit,q.offset]);return success({items:rows.rows.map(row=>mapped(a,row)),total:count.rows[0].n});
}
async function cached<T>(c:PoolClient,a:LeadActor,operation:string,input:{idempotencyKey:string},work:()=>Promise<Result<T>>,replay?:(data:T)=>Promise<Result<T>>):Promise<Result<T>>{
 const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex'),old=(await c.query('SELECT digest,response FROM crm_lead_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3',[a.userId,operation,input.idempotencyKey])).rows[0];
 if(old)return old.digest!==digest?failure('CONFLICT','幂等键已用于不同请求'):replay?replay(old.response):success(old.response);
 const result=await work();if(result.ok)await c.query('INSERT INTO crm_lead_idempotency(actor_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)',[a.userId,operation,input.idempotencyKey,digest,JSON.stringify(result.data)]);return result;
}
async function members(c:PoolClient){return (await c.query(`SELECT u.user_id,pa.scope,pa.capabilities,ARRAY(SELECT g.role FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active) AS roles FROM identity.users u JOIN identity.product_access pa ON pa.user_id=u.user_id AND pa.product_id='crm' AND pa.active WHERE u.active AND NOT u.must_change_password FOR SHARE OF u,pa`)).rows;}
import {effectiveCapabilitiesFor} from '../../core/admin';
function validTarget(member:Record<string,any>|undefined,actorId:string):boolean{return !!member&&isContactAssignmentTarget({userId:member.user_id,roles:member.roles,capabilities:effectiveCapabilitiesFor(member.roles,member.capabilities)},actorId);}
const REQUEST_SELECT=`SELECT r.request_id AS "requestId",r.contact_id AS "contactId",r.customer_id AS "customerId",r.version,COALESCE(NULLIF(concat_ws(' ',ct.first_name,ct.last_name),''),'联系人') AS "contactName",NULL::text AS email,co.name AS "companyName",r.target_user_id AS "targetUserId",target.display_name AS "targetName",r.actor_id AS "actorId",actor.display_name AS "actorName",r.status,r.created_at AS "createdAt",r.decided_at AS "decidedAt",c.origin FROM crm_contact_assignment_requests r JOIN contacts ct ON ct.id=r.contact_id JOIN crm_customers c ON c.customer_id=r.customer_id JOIN companies co ON co.id=c.company_id JOIN identity.users target ON target.user_id=r.target_user_id JOIN identity.users actor ON actor.user_id=r.actor_id`;
type AssignmentRow=ContactAssignment&{origin:string};
function mapRequest(a:LeadActor,r:AssignmentRow):ContactAssignment{const {origin:_,...item}=r;return {...item,createdAt:new Date(r.createdAt).toISOString(),decidedAt:r.decidedAt?new Date(r.decidedAt).toISOString():null,canAccept:r.status==='pending'&&r.targetUserId===a.userId&&a.capabilities.includes('leads.develop'),canReject:r.status==='pending'&&r.targetUserId===a.userId&&a.capabilities.includes('leads.develop'),canCancel:r.status==='pending'&&r.origin==='operations'&&contactManager(a)};}
async function request(c:PoolClient,a:LeadActor,id:string):Promise<Result<ContactAssignment>>{const row=(await c.query(`${REQUEST_SELECT} WHERE r.request_id=$1`,[id])).rows[0] as AssignmentRow|undefined;if(!row||!([row.actorId,row.targetUserId].includes(a.userId)||row.origin==='operations'&&contactManager(a)))return failure('NOT_FOUND','分配请求不存在');return success(mapRequest(a,row));}
async function assignmentEvent(c:PoolClient,a:LeadActor,r:ContactAssignment,type:string,recipients:string[],activityId?:string){await c.query('INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,\'crm\',$3,$4,$5,$6::uuid[])',[type,a.userId,r.version,r.customerId,JSON.stringify({requestId:r.requestId,contactId:r.contactId,customerId:r.customerId,version:r.version,companyName:r.companyName,contactName:r.contactName,...(activityId?{activityId}:{})}),[...new Set(recipients)].sort()]);}
export async function contactAssignmentsIn(c:PoolClient,a:LeadActor,q:ContactAssignmentQuery){
 const column=q.view==='incoming'?'target_user_id':'actor_id';if(q.view==='outgoing'&&!contactManager(a))return failure('FORBIDDEN','无分配管理权限');if(q.view==='incoming'&&!a.capabilities.includes('leads.develop'))return failure('FORBIDDEN','无分配接收权限');
 if(q.requestId){
  // A notification is a reference to current state; historical status/search/page hints do not hide that record.
  const rows=await c.query(`${REQUEST_SELECT} WHERE (r.${column}=$1 OR $3::boolean AND c.origin='operations') AND r.request_id=$2`,[a.userId,q.requestId,q.view==='outgoing'&&contactManager(a)]);
  return success({items:rows.rows.map(r=>mapRequest(a,r)),total:rows.rows.length});
 }
 const filter=`WHERE ct.crm_deleted_at IS NULL AND (r.${column}=$1 OR $4::boolean AND c.origin='operations') AND r.status=$2 AND (co.name ILIKE $3 ESCAPE '!' OR ct.first_name ILIKE $3 ESCAPE '!' OR ct.last_name ILIKE $3 ESCAPE '!')`,p=[a.userId,q.status,`%${q.search.replace(/[!%_]/g,'!$&')}%`,q.view==='outgoing'&&contactManager(a)];
 const rows=await c.query(`${REQUEST_SELECT} ${filter} ORDER BY r.created_at DESC,r.request_id DESC LIMIT $5 OFFSET $6`,[...p,q.limit,q.offset]),count=await c.query(`SELECT count(*)::int AS n FROM crm_contact_assignment_requests r JOIN contacts ct ON ct.id=r.contact_id JOIN crm_customers c ON c.customer_id=r.customer_id JOIN companies co ON co.id=c.company_id ${filter}`,p);return success({items:rows.rows.map(r=>mapRequest(a,r)),total:count.rows[0].n});
}
export async function createContactAssignmentsIn(c:PoolClient,a:LeadActor,input:ContactAssignmentCreate){
 if(!contactManager(a))return failure('FORBIDDEN','无分配权限');
 const currentMembers=await members(c);if(!validTarget(currentMembers.find(m=>m.user_id===input.targetUserId),a.userId)||input.notifyUserIds.some(id=>!currentMembers.some(m=>m.user_id===id&&m.roles.length)))return failure('INVALID_INPUT','分配成员已失效或无用户开发权限');
 return cached(c,a,'contact-assignments:create',input,async()=>{
  const items:ContactAssignment[]=[];
  for(const ref of [...input.contacts].sort((x,y)=>x.contactId-y.contactId)){
   const ct=await contact(c,ref,true);if(!ct||!read(a,ct))return failure('NOT_FOUND','联系人不存在');if(!assign(a,ct)||ct.contactVersion!==ref.expectedVersion)return failure('CONFLICT','联系人已分配、受限或版本已变化');
   if((await c.query("SELECT 1 FROM crm_contact_assignment_requests WHERE contact_id=$1 AND status IN ('pending','accepted')",[ref.contactId])).rows.length)return failure('CONFLICT','联系人已有有效分配请求');
   const id=randomUUID();await c.query('INSERT INTO crm_contact_assignment_requests(request_id,contact_id,customer_id,target_user_id,actor_id,notify_user_ids) VALUES($1,$2,$3,$4,$5,$6::uuid[])',[id,ref.contactId,ref.customerId,input.targetUserId,a.userId,input.notifyUserIds]);const r=await request(c,a,id);if(!r.ok)return r;items.push(r.data);await assignmentEvent(c,a,r.data,CONTACT_ASSIGNMENT_EVENTS.requested,[a.userId,input.targetUserId,...input.notifyUserIds]);
  }return success({items});
 },async old=>{const items:ContactAssignment[]=[];for(const r of old.items){const current=await request(c,a,r.requestId);if(!current.ok)return current;items.push(current.data);}return success({items});});
}
export async function decideContactAssignmentIn(c:PoolClient,a:LeadActor,action:'accept'|'reject'|'cancel',input:ContactAssignmentDecision):Promise<Result<ContactAssignment>>{
 const row=(await c.query('SELECT * FROM crm_contact_assignment_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
 if(!row||(action==='cancel'?!contactManager(a):row.target_user_id!==a.userId||!a.capabilities.includes('leads.develop')))return failure('NOT_FOUND','分配请求不存在');
 return cached(c,a,`contact-assignment:${action}:${input.requestId}`,input,async()=>{
  if(row.status!=='pending'||row.version!==input.expectedVersion)return failure('CONFLICT','分配请求状态已变化');
  const ref={contactId:row.contact_id,customerId:row.customer_id},ct=await contact(c,ref,true);if(!ct||action==='cancel'&&ct.origin!=='operations')return failure('NOT_FOUND','联系人不存在');
  if(action==='accept'){
   const recipients=await members(c);if(!validTarget(recipients.find(m=>m.user_id===a.userId),row.actor_id))return failure('FORBIDDEN','接收权限已变化');if(ct.development_restriction?.trim()||ct.ownerUserId!==null)return failure('CONFLICT','联系人开发限制或归属已变化');
   await c.query('UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1',[ct.contactId]);
  }
  const status=action==='accept'?'accepted':action==='reject'?'rejected':'cancelled';await c.query('UPDATE crm_contact_assignment_requests SET status=$2,version=version+1,decided_at=now() WHERE request_id=$1',[input.requestId,status]);const result=await request(c,a,input.requestId);if(!result.ok)return result;
  await assignmentEvent(c,a,result.data,CONTACT_ASSIGNMENT_EVENTS[status],[row.actor_id,row.target_user_id,...row.notify_user_ids]);return result;
 },()=>request(c,a,input.requestId));
}
export async function contactUpdateIn(c:PoolClient,a:LeadActor,input:CenterContactUpdate):Promise<Result<CenterContactDetail>>{
 const ct=await contact(c,input,true);if(!ct||!read(a,ct))return failure('NOT_FOUND','联系人不存在或不可修改');
 if('clientType' in input.fields)return failure('INVALID_INPUT','客户类型属于公司资料，请修改公司客户类型');
 if(Object.keys(input.fields).some(f=>!contactPermissionsFor(a,ct).editableFields.includes(f)))return failure('FORBIDDEN','没有所选字段的修改权限');
 return cached(c,a,`contact-update:${input.contactId}`,input,async()=>{
  if(ct.contactVersion!==input.expectedVersion)return failure('CONFLICT','联系人版本已变化');
  const fields={email:'email',firstName:'first_name',lastName:'last_name',title:'title',phone:'phone',whatsapp:'whatsapp',sourceLevel1:'source_level1',sourceLevel2:'source_level2',linkedinUrl:'linkedin',country:'country',clientType:'client_type',language:'language',stage:'stage',status:'status',tags:'tags',preferences:'extra'} as const;
  const values: unknown[] = [input.contactId];
  const sets: string[] = [];
  for (const [key, value] of Object.entries(input.fields)) {
   if (!Object.hasOwn(fields, key)) return failure('INVALID_INPUT', '联系人字段不可修改');
   const json = key === 'tags' || key === 'preferences';
   values.push(json ? JSON.stringify(value) : key === 'email' ? typeof value === 'string' ? value.trim().toLowerCase() || null : null : value);
   // Patch only preferences; callers cannot replace unrelated provenance or import fields.
   sets.push(key === 'preferences'
    ? `extra=jsonb_set(COALESCE(extra,'{}'::jsonb),'{preferences}',$${values.length}::jsonb,true)`
    : `${fields[key as keyof typeof fields]}=$${values.length}${json ? '::jsonb' : ''}`);
  }
  await c.query(`UPDATE contacts SET ${sets.join(',')},crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1`,values);
  await contactEvent(c,a,ct,CONTACT_ASSIGNMENT_EVENTS.updated,input.expectedVersion+1);return contactDetailIn(c,a,input);
 },()=>contactDetailIn(c,a,input));
}
async function contactEvent(c:PoolClient,a:LeadActor,ct:ContactRow,type:string,version:number,activityId?:string,mailEventId?:string){await c.query('INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,\'crm\',$3,$4,$5,$6::uuid[])',[type,a.userId,version,ct.customerId,JSON.stringify({contactId:ct.contactId,customerId:ct.customerId,version,...(activityId?{activityId}:{}),...(mailEventId?{mailEventId}:{})}),[...new Set([a.userId,ct.created_by,...(ct.ownerUserId?[ct.ownerUserId]:[]),...(ct.shared_grants??[]).map(g=>g.targetUserId)])].sort()]);}
export async function contactFollowupIn(c:PoolClient,a:LeadActor,input:CenterContactFollowup):Promise<Result<CenterContactDetail>>{
 const ct=await contact(c,input,true);if(!ct||!read(a,ct))return failure('NOT_FOUND','联系人不存在或不可跟进');
 const permissions=contactPermissionsFor(a,ct);if(input.stage!==undefined&&!permissions.canChangeStage||(input.stage===undefined||input.method!=='note'||input.contactStatus!==undefined)&&!permissions.canFollowup)return failure('FORBIDDEN','没有跟进或关系阶段修改权限');
 return cached(c,a,`contact-followup:${input.contactId}`,input,async()=>{
  if(ct.contactVersion!==input.expectedVersion)return failure('CONFLICT','联系人版本已变化');
  const recorded=(await c.query('SELECT clock_timestamp() AS t')).rows[0].t as Date,occurred=input.occurredAt?new Date(input.occurredAt):recorded,method=input.method??'other';
  if(!Number.isFinite(occurred.getTime())||occurred.getTime()>recorded.getTime()+FOLLOWUP_TIME_LIMITS.future_skew_seconds*MILLISECONDS_PER_SECOND||method==='note'&&input.contactStatus!==undefined)return failure('INVALID_INPUT','跟进时间或触达状态无效');
  const note=!permissions.canFollowup&&input.stage!==undefined?`关系阶段：${input.stage}`:input.note;
  const activity=(await c.query('INSERT INTO crm_shared_activities(customer_id,interaction_id,actor_id,note,stage,method,occurred_at,recorded_at,created_at,contact_id,contact_status) VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$7,$8,$9) RETURNING id::text',[ct.customerId,a.userId,note,input.stage??null,method,occurred,recorded,ct.contactId,input.contactStatus??null])).rows[0];
  // Only explicit user results synchronize compatible legacy display fields.
  // Unable to contact is not evidence of an invalid mailbox; notes/tags never manufacture touch.
  const legacyStatus = input.contactStatus !== undefined ? FOLLOWUP_LEGACY_STATUS[input.contactStatus] : null;
  // Relationship stage lives in the activity timeline; ordinary tags are independent customer metadata.
  await c.query('UPDATE contacts SET crm_touch_status=COALESCE($2,crm_touch_status),status=COALESCE($3,status),crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1',[ct.contactId,input.contactStatus??null,legacyStatus]);
  await refreshMailProjectionIn(c,input,ct.email);
  await contactEvent(c,a,ct,CONTACT_ASSIGNMENT_EVENTS.followup,input.expectedVersion+1,activity.id);
  return contactDetailIn(c,a,input);
 },()=>contactDetailIn(c,a,input));
}
export {contact as loadContactIn,read as canReadContact,edit as canDevelopContact,contactEvent as recordContactEventIn,cached as lifecycleCached};

async function companyEditable(c: PoolClient, a: LeadActor, ct: ContactRow): Promise<boolean> {
 if (all(a)) return true;
 if (!a.capabilities.includes('leads.develop') || !(ownManager(a,ct) || ct.origin==='personal'&&ct.ownerUserId===a.userId)) return false;
 const restricted=ownManager(a,ct)
  ?await c.query("SELECT 1 FROM crm_customers WHERE company_id=$1 AND origin='personal' LIMIT 1",[ct.companyId])
  :await c.query('SELECT 1 FROM crm_customers WHERE company_id=$1 AND created_by<>$2 LIMIT 1',[ct.companyId,a.userId]);
 return !restricted.rowCount;
}
/** Shared company edits have a separate contract and revision from contact edits. */
export async function companyUpdateIn(c: PoolClient,a: LeadActor,input: CenterCompanyUpdate): Promise<Result<CenterContactDetail>> {
 const ct = await contact(c,input,true);
 if (!ct || !read(a,ct) || !await companyEditable(c,a,ct)) return failure('FORBIDDEN','没有公司资料修改权限');
 return cached(c,a,`company-update:${ct.companyId}`,input,async () => {
  const company = (await c.query('SELECT updated_at::text AS revision FROM companies WHERE id=$1 FOR UPDATE',[ct.companyId])).rows[0];
  if (company.revision !== input.expectedRevision) return failure('CONFLICT','公司资料已变化，请刷新重试');
  const columns = {name:'name',customerType:'customer_type',domain:'domain',country:'country',industry:'industry',size:'size',backcheckData:'backcheck_data'} as const;
  const values: unknown[] = [ct.companyId]; const sets: string[] = [];
  for (const [key,value] of Object.entries(input.fields)) {
   if (!Object.hasOwn(columns,key)) return failure('INVALID_INPUT','公司字段不可修改');
   values.push(key === 'backcheckData' && value !== null ? JSON.stringify(value) : value);
   sets.push(`${columns[key as keyof typeof columns]}=$${values.length}${key === 'backcheckData' ? '::jsonb' : ''}`);
  }
  await c.query(`UPDATE companies SET ${sets.join(',')},updated_at=clock_timestamp() WHERE id=$1`,values);
  await contactEvent(c,a,ct,CONTACT_ASSIGNMENT_EVENTS.updated,ct.contactVersion ?? ct.customerVersion);
  return contactDetailIn(c,a,input);
 },()=>contactDetailIn(c,a,input));
}
