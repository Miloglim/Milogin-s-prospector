import {effectiveActivitySql,lastEffectiveFollowupSql} from './contact-mail-projection-sql';
import {refreshMailProjectionIn} from './contact-mail-correction-repository';
import {contactPermissions,sourceContactManager} from '../../core/contact-permissions';
import type {ContactPermissions,ContactShareGrant} from '../../core/contact-sharing';
import {sharedAccessSql,validShareSql} from './contact-sharing-sql';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {failure,success,type LogSink,type Result} from '../../core/crm';
import {CONTACT_ASSIGNMENT_EVENTS,isContactAssignmentTarget,type ContactAssignment,type ContactAssignmentCreate,type ContactAssignmentDecision,type ContactAssignmentGroupDecision,type ContactAssignmentGroupPage,type ContactAssignmentGroupQuery,type ContactAssignmentQuery,type CenterCompanyUpdate,type CenterContactRef,type CenterContactUpdate,type CenterContactFollowup,type CenterContactDetail,type ContactAssignmentTransfer,type ContactAssignmentExpiryInput,type ContactAssignmentExpiryReceipt,type ContactMonitorDetail,type ContactAssignmentDecisionAction} from '../../core/contact-assignments';
import {canAcceptContactAssignment,canCancelContactAssignment,canTransferContactAssignment,contactAssignmentRecipients,contactAssignmentSupervisorsFor} from '../../core/contact-assignment-state';
import type {ContactAssignmentLifecycleStatus} from '../../core/contact-assignment-state';
import type {CenterContact,CenterContactGroupDimension,CenterContactGroupPage,CenterContactGroupQuery,CenterContactQuery,CenterContactPage} from '../../core/center-contacts';
import {FOLLOWUP_TIME_LIMITS} from '../../core/leads';
import type {LeadActor} from './lead-repository';
import {CONTACT_MAIL_LIMITS} from '../../core/contact-mail';
import {contactMailEventsIn} from './contact-mail-repository';
import {migrateContactAssignmentGroups} from './contact-assignment-group-schema';
import { evaluateLeadIngressIn } from './lead-match-repository';
const MILLISECONDS_PER_SECOND=1000;
const CONTACT_ASSIGNMENT_EXPIRY_POLL_SECONDS=30;
const CONTACT_ASSIGNMENT_EXPIRY_LOCK=570058;
const FOLLOWUP_LEGACY_STATUS={contacted:'reached',replied:'replied',bounced:'bounced',autoreply:'autoreply',uncontacted:''} as const;
export const CONTACT_OWNER_SQL="COALESCE((SELECT own.owner_user_id FROM crm_contact_ownership own WHERE own.contact_id=ct.id AND own.customer_id=c.customer_id AND own.ended_at IS NULL ORDER BY own.started_at DESC,own.ownership_id DESC LIMIT 1),c.owner_user_id)";
const JOINS=`FROM contacts ct JOIN crm_customer_contacts cc ON cc.contact_id=ct.id JOIN crm_customers c ON c.customer_id=cc.customer_id JOIN companies co ON co.id=c.company_id`;
const LAST_FOLLOWUP_AT=lastEffectiveFollowupSql('occurred_at');
const LAST_FOLLOWUP_NOTE=lastEffectiveFollowupSql('note');
const PROJECTION=`ct.id AS "contactId",c.customer_id AS "customerId",c.version AS "customerVersion",ct.crm_contact_version AS "contactVersion",co.id AS "companyId",co.name AS "companyName",co.industry AS "businessType",co.domain AS website,ct.email,ct.first_name AS "firstName",ct.last_name AS "lastName",ct.title,ct.phone,ct.whatsapp,ct.linkedin AS "linkedinUrl",COALESCE(co.country,ct.country) AS country,COALESCE(CASE co.customer_type WHEN '代理' THEN 'agent' WHEN '直客' THEN 'direct' END,ct.client_type) AS "clientType",ct.language,ct.stage,ct.status,ct.tags,ct.extra,ct.crm_touch_status AS "touchStatus",ct.assignee,ct.source,ct.source_detail AS "sourceDetail",ct.source_level1 AS "sourceLevel1",ct.source_level2 AS "sourceLevel2",ct.created_at AS "createdAt",ct.updated_at AS "updatedAt",${CONTACT_OWNER_SQL} AS "ownerUserId",(SELECT u.display_name FROM public.identity_users u WHERE u.user_id=${CONTACT_OWNER_SQL}) AS "ownerName",c.origin,c.state,c.created_by,c.development_restriction,(SELECT COALESCE(jsonb_agg(jsonb_build_object('targetUserId',sh.target_user_id,'editableFields',sh.editable_fields,'canFollowup',sh.can_followup,'canChangeStage',sh.can_change_stage)),'[]'::jsonb) FROM crm_contact_shares sh WHERE sh.contact_id=ct.id AND sh.customer_id=c.customer_id AND sh.status='accepted' AND EXISTS(SELECT 1 FROM public.identity_product_grants tg WHERE tg.user_id=sh.target_user_id AND tg.product_id='crm' AND tg.role='sales' AND tg.active) AND ${validShareSql(CONTACT_OWNER_SQL)}) AS shared_grants,(SELECT COALESCE(array_agg(DISTINCT sid),'{}'::uuid[]) FROM crm_contact_assignment_requests sar CROSS JOIN LATERAL unnest(sar.supervisor_user_ids) sid WHERE sar.contact_id=ct.id AND sar.customer_id=c.customer_id AND sar.status='accepted') AS supervisor_user_ids,(SELECT ar.status FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status IN ('pending','accepted','pending_transfer')) AS active_assignment_status,(SELECT act.stage FROM crm_shared_activities act WHERE act.contact_id=ct.id AND act.customer_id=c.customer_id AND act.stage IS NOT NULL ORDER BY act.occurred_at DESC,act.id DESC LIMIT 1) AS "relationshipStage",${LAST_FOLLOWUP_AT} AS "lastFollowupAt",${LAST_FOLLOWUP_NOTE} AS "lastFollowupNote"`;
export type ContactRow=CenterContact & {created_by:string;development_restriction:string|null;active_assignment_status:string|null;supervisor_user_ids:string[];shared_grants?:Array<ContactShareGrant & {targetUserId:string}>};
const NOTIFICATION_VALUE_MAX=240;
function notificationValue(value:unknown):string|null {
 if(value===undefined||value===null||value==='')return null;
 const text=Array.isArray(value)?value.join('、'):typeof value==='object'?JSON.stringify(value):String(value);
 return text.length>NOTIFICATION_VALUE_MAX?`${text.slice(0,NOTIFICATION_VALUE_MAX)}…`:text;
}
function contactFieldValue(ct:ContactRow,key:string):unknown {
 const values:Record<string,unknown>={email:ct.email,firstName:ct.firstName,lastName:ct.lastName,title:ct.title,phone:ct.phone,whatsapp:ct.whatsapp,sourceLevel1:ct.sourceLevel1,sourceLevel2:ct.sourceLevel2,linkedinUrl:ct.linkedinUrl,country:ct.country,language:ct.language,stage:ct.stage,status:ct.status,tags:ct.tags,preferences:ct.extra?.preferences};
 return values[key];
}
function notificationValues(entries:Array<[string,unknown,unknown]>){return entries.flatMap(([field,before,after])=>JSON.stringify(before??null)===JSON.stringify(after??null)?[]:[{field,from:notificationValue(before),to:notificationValue(after)}]);}
export function contactPermissionsFor(a:LeadActor,row:ContactRow):ContactPermissions{return contactPermissions(a,{...row,shared_grant:row.shared_grants?.find(g=>g.targetUserId===a.userId)});}
export function contactManager(a:LeadActor):boolean {return ['shared','summary'].includes(a.scope)&&a.roles.includes('operations')&&a.capabilities.includes('leads.assign');}
function assignmentOversight(a:LeadActor):boolean{return ['shared','summary'].includes(a.scope)&&a.roles.includes('admin')&&a.capabilities.includes('leads.read.all');}
function all(a:LeadActor):boolean{return a.roles.includes('admin')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('leads.read.all');}
function ownManager(a:LeadActor,row:ContactRow):boolean{return sourceContactManager(a,row);}
function read(a:LeadActor,row:ContactRow):boolean{return all(a)||ownManager(a,row)||a.capabilities.includes('leads.develop')&&(row.ownerUserId===a.userId||!!row.shared_grants?.some(g=>g.targetUserId===a.userId));}
function edit(a:LeadActor,row:ContactRow):boolean{return contactPermissionsFor(a,row).editableFields.length>0;}
function assign(a:LeadActor,row:ContactRow):boolean{return contactManager(a)&&row.origin==='operations'&&!row.development_restriction?.trim()&&row.ownerUserId===null&&!row.active_assignment_status;}
export function canDeleteContact(a:LeadActor,row:ContactRow):boolean{
 if(row.active_assignment_status==='pending')return false;
 if(row.active_assignment_status==='pending_transfer')return ownManager(a,row);
 return ownManager(a,row)||row.origin==='personal'&&row.ownerUserId===a.userId&&a.capabilities.includes('leads.develop');
}
function mapped(a:LeadActor,row:ContactRow):CenterContact {const {created_by:_,development_restriction:__,active_assignment_status:___,supervisor_user_ids:_____,shared_grants:______,...ct}=row,permissions=contactPermissionsFor(a,row),assignmentStatus=row.active_assignment_status==='pending_transfer'?'accepted':row.active_assignment_status;return {...ct,assignmentStatus:assignmentStatus as CenterContact['assignmentStatus'],relationshipStage:ct.relationshipStage??(['contacted','replied','bounced','autoreply'].includes(ct.touchStatus)?'reaching':'cold'),lastFollowupAt:ct.lastFollowupAt?new Date(ct.lastFollowupAt).toISOString():null,lastFollowupNote:ct.lastFollowupNote??null,createdAt:new Date(ct.createdAt).toISOString(),updatedAt:new Date(ct.updatedAt).toISOString(),canDelete:canDeleteContact(a,row),permissions,isShared:!!row.shared_grants?.some(g=>g.targetUserId===a.userId)&&row.ownerUserId!==a.userId,canSendMail:permissions.canSendMail,canEdit:edit(a,row),canFollowup:permissions.canFollowup,canAssign:assign(a,row)};}
async function contact(c:PoolClient,input:CenterContactRef,lock=false,includeDeleted=false):Promise<ContactRow|undefined>{return (await c.query(`SELECT ${PROJECTION} ${JOINS} WHERE ct.id=$1 AND c.customer_id=$2 AND co.crm_deleted_at IS NULL ${includeDeleted?'':'AND ct.crm_deleted_at IS NULL'} ${lock?'FOR UPDATE OF ct,c':''}`,[input.contactId,input.customerId])).rows[0];}
export async function contactDetailIn(c:PoolClient,a:LeadActor,input:CenterContactRef):Promise<Result<CenterContactDetail>>{
 const ct=await contact(c,input);if(!ct||!read(a,ct))return failure('NOT_FOUND','联系人不存在');
 const co=(await c.query('SELECT customer_type AS "customerType",industry,country,size,updated_at::text AS revision,domain,backcheck_data AS "backcheckData" FROM companies WHERE id=$1',[ct.companyId])).rows[0];
 const activities=await c.query(`SELECT act.id::text,(SELECT mf.event_id::text FROM crm_contact_mail_events mf WHERE mf.activity_id=act.id LIMIT 1) AS "mailEventId",NOT (${effectiveActivitySql()}) AS "mailSuperseded",act.actor_id AS "actorId",u.display_name AS "actorName",act.note,act.stage,act.method,act.contact_id AS "contactId",act.contact_status AS "contactStatus",act.created_at AS "createdAt",act.occurred_at AS "occurredAt",act.recorded_at AS "recordedAt",ct.first_name AS "contactName" FROM crm_shared_activities act LEFT JOIN public.identity_users u ON u.user_id=act.actor_id LEFT JOIN contacts ct ON ct.id=act.contact_id WHERE act.customer_id=$1 AND act.contact_id=$2 AND act.opportunity_id IS NULL ORDER BY act.occurred_at DESC,act.id DESC`,[input.customerId,input.contactId]);
 return success({contact:mapped(a,ct),company:{companyId:ct.companyId,name:ct.companyName,domain:co.domain,backcheckData:co.backcheckData,customerType:co.customerType,industry:co.industry,country:co.country,size:co.size,revision:co.revision,canEdit:await companyEditable(c,a,ct)},activities:activities.rows.map(x=>({...x,createdAt:new Date(x.createdAt).toISOString(),occurredAt:new Date(x.occurredAt).toISOString(),recordedAt:new Date(x.recordedAt).toISOString()})),canDelete:canDeleteContact(a,ct),permissions:contactPermissionsFor(a,ct),canSendMail:contactPermissionsFor(a,ct).canSendMail,canEdit:edit(a,ct),canFollowup:contactPermissionsFor(a,ct).canFollowup,canAssign:assign(a,ct),mailAvailable:true,mailEvents:await contactMailEventsIn(c,input),mailEventLimit:CONTACT_MAIL_LIMITS.history});
}
export async function contactMonitorDetailIn(c:PoolClient,a:LeadActor,input:CenterContactRef):Promise<Result<ContactMonitorDetail>>{
 const ct=await contact(c,input);
 if(!ct||!a.capabilities.includes('leads.develop')||!ct.ownerUserId)return failure('NOT_FOUND','联系人不存在');
 const relationship=(await c.query(`SELECT 1 WHERE EXISTS(
   SELECT 1 FROM crm_contact_ownership own
   JOIN crm_org_assignments member ON member.user_id=own.owner_user_id AND member.role='member' AND member.ended_at IS NULL
   JOIN crm_org_units unit ON unit.unit_id=member.unit_id AND unit.kind='sales_team' AND unit.dissolved_at IS NULL
   JOIN crm_org_assignments leader ON leader.unit_id=unit.unit_id AND leader.role='leader' AND leader.is_primary AND leader.ended_at IS NULL
   WHERE own.contact_id=$1 AND own.customer_id=$2 AND own.ended_at IS NULL AND leader.user_id=$3
 )`,[input.contactId,input.customerId,a.userId])).rowCount;
 if(!relationship)return failure('FORBIDDEN','仅直属负责人可监督查看');
 const audit=(await c.query("INSERT INTO crm_contact_monitor_audits(actor_id,contact_id,customer_id,relationship) VALUES($1,$2,$3,'direct_leader') RETURNING audit_id::text AS id,created_at AS at",[a.userId,input.contactId,input.customerId])).rows[0];
 const co=(await c.query('SELECT domain,country FROM companies WHERE id=$1',[ct.companyId])).rows[0];
 const activities=(await c.query(`SELECT act.id::text,(SELECT mf.event_id::text FROM crm_contact_mail_events mf WHERE mf.activity_id=act.id LIMIT 1) AS "mailEventId",NOT (${effectiveActivitySql()}) AS "mailSuperseded",act.actor_id AS "actorId",u.display_name AS "actorName",act.note,act.stage,act.method,act.contact_id AS "contactId",act.contact_status AS "contactStatus",act.created_at AS "createdAt",act.occurred_at AS "occurredAt",act.recorded_at AS "recordedAt",ct.first_name AS "contactName" FROM crm_shared_activities act LEFT JOIN public.identity_users u ON u.user_id=act.actor_id LEFT JOIN contacts ct ON ct.id=act.contact_id WHERE act.customer_id=$1 AND act.contact_id=$2 AND act.opportunity_id IS NULL ORDER BY act.occurred_at DESC,act.id DESC`,[input.customerId,input.contactId])).rows;
 const safe=mapped(a,ct);
 return success({
  auditId:String(audit.id),accessedAt:new Date(audit.at).toISOString(),relationship:'direct_leader',
  contact:{contactId:safe.contactId,customerId:safe.customerId,companyId:safe.companyId,companyName:safe.companyName,email:safe.email,firstName:safe.firstName,lastName:safe.lastName,title:safe.title,phone:safe.phone,whatsapp:safe.whatsapp,country:safe.country,clientType:safe.clientType,language:safe.language,stage:safe.stage,status:safe.status,tags:safe.tags,touchStatus:safe.touchStatus,source:safe.source,sourceDetail:safe.sourceDetail,createdAt:safe.createdAt,updatedAt:safe.updatedAt,ownerUserId:safe.ownerUserId,ownerName:safe.ownerName,origin:safe.origin},
  company:{contactId:ct.contactId,customerId:ct.customerId,companyId:ct.companyId,name:ct.companyName,domain:co.domain,country:co.country},
  activities:activities.map(x=>({...x,createdAt:new Date(x.createdAt).toISOString(),occurredAt:new Date(x.occurredAt).toISOString(),recordedAt:new Date(x.recordedAt).toISOString()})),
  mailEvents:await contactMailEventsIn(c,input),mailEventLimit:CONTACT_MAIL_LIMITS.history,
 });
}
export async function listContactsIn(c:PoolClient,a:LeadActor,q:CenterContactQuery,companyId?:number):Promise<Result<CenterContactPage>>{
 const manager=contactManager(a),global=all(a),develop=a.capabilities.includes('leads.develop');if(!manager&&!global&&!develop)return failure('FORBIDDEN','无联系人查询权限');
 const filter=`WHERE ct.crm_deleted_at IS NULL AND co.crm_deleted_at IS NULL ${companyId!==undefined?`AND co.id=${companyId}`:""} AND ($1::boolean OR ($2::boolean AND c.origin='operations') OR ($3::boolean AND (${CONTACT_OWNER_SQL}=$4::uuid OR ${sharedAccessSql('$4::uuid',CONTACT_OWNER_SQL)})))
 AND (ct.email ILIKE $5 ESCAPE '!' OR ct.first_name ILIKE $5 ESCAPE '!' OR ct.last_name ILIKE $5 ESCAPE '!' OR ct.title ILIKE $5 ESCAPE '!' OR co.name ILIKE $5 ESCAPE '!' OR COALESCE(ct.extra->>'note','') ILIKE $5 ESCAPE '!')
 AND ($6::text IS NULL OR ct.stage=$6) AND ($7::text IS NULL OR ct.status=$7) AND ($8::text IS NULL OR ct.tags ? $8) AND ($9::text IS NULL OR COALESCE(CASE co.customer_type WHEN '代理' THEN 'agent' WHEN '直客' THEN 'direct' END,ct.client_type)=$9) AND ($10::text IS NULL OR COALESCE(co.country,ct.country)=$10)
 AND ($11::text='all' OR ($11='personal' AND c.origin='personal' AND ${CONTACT_OWNER_SQL}=$4::uuid) OR ($11='assigned' AND c.origin='operations' AND (${CONTACT_OWNER_SQL}=$4::uuid OR ${sharedAccessSql('$4::uuid',CONTACT_OWNER_SQL)})))
 AND ($12::text IS NULL OR ($12='accepted' AND EXISTS(SELECT 1 FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status='accepted')) OR ($12='unassigned' AND ${CONTACT_OWNER_SQL} IS NULL AND NOT EXISTS(SELECT 1 FROM crm_contact_assignment_requests ar WHERE ar.contact_id=ct.id AND ar.status='pending')))
 AND (NOT $13::boolean OR ct.crm_touch_status IN ('contacted','replied','bounced','autoreply'))
 AND ($14::text IS NULL OR COALESCE((SELECT act.stage FROM crm_shared_activities act WHERE act.contact_id=ct.id AND act.customer_id=c.customer_id AND act.stage IS NOT NULL ORDER BY act.occurred_at DESC,act.id DESC LIMIT 1),CASE WHEN ct.crm_touch_status IN ('contacted','replied','bounced','autoreply') THEN 'reaching' ELSE 'cold' END)=$14)
 AND ($15::text IS NULL OR ct.crm_touch_status=$15) AND ($16::text IS NULL OR ct.language=$16)
 AND ($17::text IS NULL OR (CASE $17::text ${Object.entries(CONTACT_GROUP_SQL).map(([dimension,value])=>`WHEN '${dimension}' THEN ${value.key}`).join(' ')} END)=$18::text)`;
 const p=[global,manager,develop,a.userId,`%${q.search.replace(/[!%_]/g,'!$&')}%`,q.stage??null,q.status??null,q.tags??null,q.clientType??null,q.country??null,q.scope??'all',q.assignment??null,q.followupOnly??false,q.crmStage??null,q.touchStatus??null,q.language??null,q.groupDimension??null,q.groupKey??null];
 // Materialize only authorized row identities before expensive display projections. Pair the
 // contact with its customer so pagination cannot grant access to a sibling association.
 const order=q.followupOnly?'page.last_followup_at DESC NULLS LAST,':'';
 const count=await c.query(`SELECT count(*)::int AS n ${JOINS} ${filter}`,p),rows=await c.query(`WITH contact_page AS MATERIALIZED (
 SELECT ct.id AS contact_id,c.customer_id,ct.updated_at ${q.followupOnly?`,${LAST_FOLLOWUP_AT} AS last_followup_at`:''}
 ${JOINS} ${filter} ORDER BY ${q.followupOnly?'last_followup_at DESC NULLS LAST,':''}ct.updated_at DESC,ct.id DESC LIMIT $19 OFFSET $20
 ) SELECT ${PROJECTION} FROM contact_page page JOIN contacts ct ON ct.id=page.contact_id JOIN crm_customer_contacts cc ON cc.contact_id=page.contact_id AND cc.customer_id=page.customer_id JOIN crm_customers c ON c.customer_id=page.customer_id JOIN companies co ON co.id=c.company_id
 ORDER BY ${order}page.updated_at DESC,page.contact_id DESC`,[...p,q.limit,q.offset]);return success({items:rows.rows.map(row=>mapped(a,row)),total:count.rows[0].n});
}
const CONTACT_GROUP_SQL: Record<CenterContactGroupDimension,{key:string;label:string}> = {
 batch:{key:"COALESCE(NULLIF(ct.source_detail,''),NULLIF(ct.source_level1,''),NULLIF(ct.source_level2,''),'unset')",label:"CASE WHEN COALESCE(NULLIF(ct.source_detail,''),NULLIF(ct.source_level1,''),NULLIF(ct.source_level2,'')) IS NULL THEN '未标记' ELSE COALESCE(NULLIF(ct.source_detail,''),NULLIF(ct.source_level1,''),NULLIF(ct.source_level2,'')) END"},
 country:{key:"COALESCE(NULLIF(co.country,''),NULLIF(ct.country,''),'unset')",label:"COALESCE(NULLIF(co.country,''),NULLIF(ct.country,''),'未标记')"},
 company:{key:'co.id::text',label:'co.name'},
 clientType:{key:"COALESCE(CASE co.customer_type WHEN '代理' THEN 'agent' WHEN '直客' THEN 'direct' END,ct.client_type,'unset')",label:"CASE COALESCE(CASE co.customer_type WHEN '代理' THEN 'agent' WHEN '直客' THEN 'direct' END,ct.client_type) WHEN 'agent' THEN '代理' WHEN 'direct' THEN '直客' ELSE '未设置' END"},
};
export async function listContactGroupsIn(c:PoolClient,a:LeadActor,q:CenterContactGroupQuery):Promise<Result<CenterContactGroupPage>>{
 const manager=contactManager(a),global=all(a),develop=a.capabilities.includes('leads.develop');if(!manager&&!global&&!develop)return failure('FORBIDDEN','无联系人查询权限');
 const expression=CONTACT_GROUP_SQL[q.dimension];
 const access=`WHERE ct.crm_deleted_at IS NULL AND co.crm_deleted_at IS NULL AND ($1::boolean OR ($2::boolean AND c.origin='operations') OR ($3::boolean AND (${CONTACT_OWNER_SQL}=$4::uuid OR ${sharedAccessSql('$4::uuid',CONTACT_OWNER_SQL)}))) AND ($5::text='all' OR ($5='personal' AND c.origin='personal' AND ${CONTACT_OWNER_SQL}=$4::uuid) OR ($5='assigned' AND c.origin='operations' AND (${CONTACT_OWNER_SQL}=$4::uuid OR ${sharedAccessSql('$4::uuid',CONTACT_OWNER_SQL)})))`;
 const rows=await c.query(`WITH grouped AS (
  SELECT ${expression.key} AS key,${expression.label} AS label,count(*)::int AS count,
   count(DISTINCT co.id)::int AS company_count,
   count(DISTINCT COALESCE(NULLIF(co.country,''),NULLIF(ct.country,'')))::int AS country_count,
   count(*) FILTER(WHERE ct.crm_touch_status IN ('contacted','replied','bounced','autoreply'))::int AS touched_count,
   bool_or(concat_ws(' ',ct.email,ct.first_name,ct.last_name,co.name,ct.title,ct.phone) ILIKE $6 ESCAPE '!') AS member_match,
   max(ct.created_at) AS latest_imported_at,
   max(ct.updated_at) AS latest_updated_at,
   (array_agg(DISTINCT co.name ORDER BY co.name) FILTER(WHERE co.name IS NOT NULL))[1:3] AS companies,
   (array_agg(DISTINCT COALESCE(NULLIF(co.country,''),NULLIF(ct.country,'')) ORDER BY COALESCE(NULLIF(co.country,''),NULLIF(ct.country,''))) FILTER(WHERE COALESCE(NULLIF(co.country,''),NULLIF(ct.country,'')) IS NOT NULL))[1:3] AS countries,
   (array_agg(DISTINCT NULLIF(ct.source_level1,'') ORDER BY NULLIF(ct.source_level1,'')) FILTER(WHERE NULLIF(ct.source_level1,'') IS NOT NULL))[1:3] AS source_level1,
   (array_agg(DISTINCT COALESCE(CASE co.customer_type WHEN '代理' THEN '代理' WHEN '直客' THEN '直客' END,ct.client_type,'未设置') ORDER BY COALESCE(CASE co.customer_type WHEN '代理' THEN '代理' WHEN '直客' THEN '直客' END,ct.client_type,'未设置')))[1:3] AS client_types
  ${JOINS} ${access} GROUP BY 1,2
 ),filtered AS (SELECT * FROM grouped WHERE ($6::text='' OR label ILIKE $6 ESCAPE '!' OR member_match))
 SELECT *,count(*) OVER()::int AS total FROM filtered ORDER BY count DESC,label LIMIT $7 OFFSET $8`,[global,manager,develop,a.userId,q.scope,q.search?`%${q.search.replace(/[!%_]/g,'!$&')}%`:'',q.limit,q.offset]);
 return success({items:rows.rows.map(row=>({key:String(row.key),label:String(row.label),count:Number(row.count),companyCount:Number(row.company_count),countryCount:Number(row.country_count),touchedCount:Number(row.touched_count),companies:(row.companies??[]) as string[],countries:(row.countries??[]) as string[],clientTypes:(row.client_types??[]) as string[],sourceLevel1:(row.source_level1??[]) as string[],latestImportedAt:row.latest_imported_at?new Date(row.latest_imported_at).toISOString():null,latestUpdatedAt:row.latest_updated_at?new Date(row.latest_updated_at).toISOString():null})),total:Number(rows.rows[0]?.total??0)});
}
async function cached<T>(c:PoolClient,a:LeadActor,operation:string,input:{idempotencyKey:string},work:()=>Promise<Result<T>>,replay?:(data:T)=>Promise<Result<T>>):Promise<Result<T>>{
 const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex'),old=(await c.query('SELECT digest,response FROM crm_lead_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3',[a.userId,operation,input.idempotencyKey])).rows[0];
 if(old)return old.digest!==digest?failure('CONFLICT','幂等键已用于不同请求'):replay?replay(old.response):success(old.response);
 const result=await work();if(result.ok)await c.query('INSERT INTO crm_lead_idempotency(actor_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)',[a.userId,operation,input.idempotencyKey,digest,JSON.stringify(result.data)]);return result;
}
async function members(c:PoolClient){return (await c.query(`SELECT u.user_id,pa.scope,pa.capabilities,EXISTS(SELECT 1 FROM crm_org_assignments leader WHERE leader.user_id=u.user_id AND leader.role='leader' AND leader.ended_at IS NULL) AS is_supervisor,ARRAY(SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active) AS roles FROM public.identity_users u JOIN public.identity_product_access pa ON pa.user_id=u.user_id AND pa.product_id='crm' AND pa.active WHERE u.active AND NOT u.must_change_password FOR SHARE OF u,pa`)).rows;}
import {effectiveCapabilitiesFor} from '../../core/admin';
function validTarget(member:Record<string,any>|undefined,actorId:string):boolean{return !!member&&isContactAssignmentTarget({userId:member.user_id,roles:member.roles,capabilities:effectiveCapabilitiesFor(member.roles,member.capabilities)},actorId);}
async function assignmentOrgContext(c:PoolClient,actorId:string,targetUserId:string):Promise<{supervisorUserIds:string[];sourceOrgUnitId:string|null;sourceOrgUnitName:string|null}>{
 const relation=(await c.query(`SELECT EXISTS(SELECT 1 FROM crm_org_assignments WHERE user_id=$1 AND role='member' AND ended_at IS NULL) AS "isMember",COALESCE(array_agg(DISTINCT leader.user_id) FILTER(WHERE leader.user_id IS NOT NULL),'{}'::uuid[]) AS "leaderUserIds" FROM crm_org_assignments member JOIN crm_org_units unit ON unit.unit_id=member.unit_id AND unit.kind='sales_team' AND unit.dissolved_at IS NULL LEFT JOIN crm_org_assignments leader ON leader.unit_id=unit.unit_id AND leader.role='leader' AND leader.is_primary AND leader.ended_at IS NULL WHERE member.user_id=$1 AND member.role='member' AND member.ended_at IS NULL`,[targetUserId])).rows[0] as {isMember:boolean;leaderUserIds:string[]};
 let source=(await c.query(`SELECT unit.unit_id AS "unitId",unit.name FROM crm_org_assignments assignment JOIN crm_org_units unit ON unit.unit_id=assignment.unit_id AND unit.kind='operations_group' AND unit.dissolved_at IS NULL WHERE assignment.user_id=$1 AND assignment.role='leader' AND assignment.ended_at IS NULL ORDER BY assignment.is_primary DESC,unit.created_at,unit.unit_id LIMIT 1`,[actorId])).rows[0] as {unitId:string;name:string}|undefined;
 if(!source)source=(await c.query(`SELECT parent.unit_id AS "unitId",parent.name FROM crm_org_assignments member JOIN crm_org_units team ON team.unit_id=member.unit_id AND team.kind='sales_team' AND team.dissolved_at IS NULL JOIN crm_org_units parent ON parent.unit_id=team.parent_unit_id AND parent.kind='operations_group' AND parent.dissolved_at IS NULL WHERE member.user_id=$1 AND member.role='member' AND member.ended_at IS NULL LIMIT 1`,[targetUserId])).rows[0] as {unitId:string;name:string}|undefined;
 return {supervisorUserIds:contactAssignmentSupervisorsFor(relation.isMember,relation.leaderUserIds ?? [],targetUserId),sourceOrgUnitId:source?.unitId??null,sourceOrgUnitName:source?.name??null};
}
const REQUEST_SELECT=`SELECT r.request_id AS "requestId",COALESCE(gm.group_id,r.request_id) AS "groupId",r.contact_id AS "contactId",r.customer_id AS "customerId",r.version,COALESCE(NULLIF(concat_ws(' ',ct.first_name,ct.last_name),''),'联系人') AS "contactName",NULL::text AS email,co.name AS "companyName",r.target_user_id AS "targetUserId",target.display_name AS "targetName",r.actor_id AS "actorId",actor.display_name AS "actorName",r.supervisor_user_ids AS "supervisorUserIds",r.source_org_unit_id AS "sourceOrgUnitId",r.source_org_unit_name AS "sourceOrgUnitName",r.previous_target_user_id AS "previousTargetUserId",r.transfer_actor_id AS "transferActorId",r.transfer_requested_at AS "transferRequestedAt",r.status,r.created_at AS "createdAt",r.expires_at AS "expiresAt",r.decided_at AS "decidedAt",c.origin FROM crm_contact_assignment_requests r LEFT JOIN crm_contact_assignment_group_members gm ON gm.request_id=r.request_id JOIN contacts ct ON ct.id=r.contact_id JOIN crm_customers c ON c.customer_id=r.customer_id JOIN companies co ON co.id=c.company_id JOIN public.identity_users target ON target.user_id=r.target_user_id JOIN public.identity_users actor ON actor.user_id=r.actor_id`;
type AssignmentRow=Omit<ContactAssignment,'status'>&{status:ContactAssignmentLifecycleStatus;origin:string};
function mapRequest(a:LeadActor,r:AssignmentRow,currentOwnerUserId?:string|null){const {origin:_,...item}=r,owner=currentOwnerUserId===undefined?(r.status==='pending_transfer'?r.previousTargetUserId:r.status==='accepted'?r.targetUserId:null):currentOwnerUserId,target=a.userId===r.targetUserId,manager=contactManager(a),actorIsRequester=r.transferActorId===a.userId||r.actorId===a.userId,transferTarget=r.status==='accepted'?'':r.targetUserId;return {...item,status:r.status,createdAt:new Date(r.createdAt).toISOString(),expiresAt:new Date(r.expiresAt).toISOString(),decidedAt:r.decidedAt?new Date(r.decidedAt).toISOString():null,transferRequestedAt:r.transferRequestedAt?new Date(r.transferRequestedAt).toISOString():null,canAccept:target&&a.capabilities.includes('leads.develop')&&canAcceptContactAssignment(r.status),canReject:target&&a.capabilities.includes('leads.develop')&&(r.status==='pending'||r.status==='pending_transfer'),canCancel:canCancelContactAssignment({status:r.status,actorIsRequester,manager}),canTransfer:canTransferContactAssignment({status:r.status,actorIsCurrentOwner:owner===a.userId,manager,targetUserId:transferTarget,currentOwnerUserId:owner})};}
async function request(c:PoolClient,a:LeadActor,id:string,decisionActorId?:string):Promise<Result<ContactAssignment>>{const row=(await c.query(`${REQUEST_SELECT} WHERE r.request_id=$1`,[id])).rows[0] as AssignmentRow|undefined;if(!row||!([row.actorId,row.targetUserId,row.transferActorId,row.previousTargetUserId,decisionActorId].includes(a.userId)||row.origin==='operations'&&(contactManager(a)||assignmentOversight(a))))return failure('NOT_FOUND','分配请求不存在');const owner=(await c.query('SELECT owner_user_id AS "ownerUserId" FROM crm_contact_ownership WHERE contact_id=$1 AND customer_id=$2 AND ended_at IS NULL',[row.contactId,row.customerId])).rows[0]?.ownerUserId??null;return success(mapRequest(a,row,owner));}
async function assignmentEvent(c:PoolClient,a:LeadActor,r:ContactAssignment,type:string,recipients:string[],activityId?:string,groupCount?:number){await c.query('INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,\'crm\',$3,$4,$5,$6::uuid[])',[type,a.userId,r.version,r.customerId,JSON.stringify({requestId:r.requestId,groupId:r.groupId,contactId:r.contactId,customerId:r.customerId,version:r.version,companyName:r.companyName,contactName:r.contactName,...(groupCount?{groupCount}:{}),...(activityId?{activityId}:{})}),[...new Set(recipients)].sort()]);}
export async function contactAssignmentsIn(c:PoolClient,a:LeadActor,q:ContactAssignmentQuery){
 if(q.view==='incoming'&&!a.capabilities.includes('leads.develop'))return failure('FORBIDDEN','无分配接收权限');
 const visible=(managerParam:string)=>q.view==='outgoing'?`(r.actor_id=$1 OR r.transfer_actor_id=$1 OR r.previous_target_user_id=$1 OR ${managerParam}::boolean AND c.origin='operations')`:`(r.target_user_id=$1 AND ${managerParam}::boolean IS NOT NULL)`;
 if(q.requestId){
  // A notification is a reference to current state; historical status/search/page hints do not hide that record.
  const rows=await c.query(`${REQUEST_SELECT} WHERE ${visible('$3')} AND r.request_id=$2`,[a.userId,q.requestId,q.view==='outgoing'&&(contactManager(a)||assignmentOversight(a))]);
  return success({items:rows.rows.map(r=>mapRequest(a,r)),total:rows.rows.length});
 }
 if(q.groupId){
  const migrated=await migrateContactAssignmentGroups(c);if(!migrated.ok)return migrated;
  const rows=await c.query(`${REQUEST_SELECT} WHERE COALESCE(gm.group_id,r.request_id)=$2 AND ${visible('$3')} ORDER BY r.created_at,r.request_id`,[a.userId,q.groupId,q.view==='outgoing'&&(contactManager(a)||assignmentOversight(a))]);
  return success({items:rows.rows.map(r=>mapRequest(a,r)),total:rows.rows.length});
 }
 const filter=`WHERE ct.crm_deleted_at IS NULL AND ${visible('$4')} AND r.status=$2 AND (co.name ILIKE $3 ESCAPE '!' OR ct.first_name ILIKE $3 ESCAPE '!' OR ct.last_name ILIKE $3 ESCAPE '!')`,p=[a.userId,q.status,`%${q.search.replace(/[!%_]/g,'!$&')}%`,q.view==='outgoing'&&(contactManager(a)||assignmentOversight(a))];
 const rows=await c.query(`${REQUEST_SELECT} ${filter} ORDER BY r.created_at DESC,r.request_id DESC LIMIT $5 OFFSET $6`,[...p,q.limit,q.offset]),count=await c.query(`SELECT count(*)::int AS n FROM crm_contact_assignment_requests r JOIN contacts ct ON ct.id=r.contact_id JOIN crm_customers c ON c.customer_id=r.customer_id JOIN companies co ON co.id=c.company_id ${filter}`,p);return success({items:rows.rows.map(r=>mapRequest(a,r)),total:count.rows[0].n});
}
export async function contactAssignmentGroupsIn(c:PoolClient,a:LeadActor,q:ContactAssignmentGroupQuery):Promise<Result<ContactAssignmentGroupPage>>{
 const migrated=await migrateContactAssignmentGroups(c);if(!migrated.ok)return migrated;
 if(q.view==='incoming'&&!a.capabilities.includes('leads.develop'))return failure('FORBIDDEN','无分配接收权限');
 const visible=q.view==='outgoing'?`(r.actor_id=$1 OR r.transfer_actor_id=$1 OR r.previous_target_user_id=$1 OR $4::boolean AND c.origin='operations')`:'(r.target_user_id=$1 AND $4::boolean IS NOT NULL)';
 const search=`%${q.search.replace(/[!%_]/g,'!$&')}%`,manager=q.view==='outgoing'&&(contactManager(a)||assignmentOversight(a));
 const rows=await c.query(`WITH grouped AS (
  SELECT COALESCE(gm.group_id,r.request_id) AS group_id,count(*)::int AS total,
   count(*) FILTER(WHERE r.status='pending')::int AS pending,count(*) FILTER(WHERE r.status='accepted')::int AS accepted,
   count(*) FILTER(WHERE r.status='rejected')::int AS rejected,count(*) FILTER(WHERE r.status='cancelled')::int AS cancelled,
   count(*) FILTER(WHERE r.status='expired')::int AS expired,count(*) FILTER(WHERE r.status='pending_transfer')::int AS pending_transfer,
   min(actor.display_name) AS actor_name,min(target.display_name) AS target_name,min(r.created_at) AS created_at,
   (array_agg(COALESCE(NULLIF(concat_ws(' ',ct.first_name,ct.last_name),''),'联系人') ORDER BY r.created_at,r.request_id))[1:5] AS contact_names,
   (array_agg(DISTINCT co.name ORDER BY co.name))[1:5] AS company_names
  FROM crm_contact_assignment_requests r LEFT JOIN crm_contact_assignment_group_members gm ON gm.request_id=r.request_id
  JOIN contacts ct ON ct.id=r.contact_id JOIN crm_customers c ON c.customer_id=r.customer_id JOIN companies co ON co.id=c.company_id
  JOIN public.identity_users actor ON actor.user_id=r.actor_id JOIN public.identity_users target ON target.user_id=r.target_user_id
  WHERE ct.crm_deleted_at IS NULL AND ${visible}
  GROUP BY COALESCE(gm.group_id,r.request_id),r.target_user_id,r.actor_id
  HAVING bool_or(r.status=$2 AND (co.name ILIKE $3 ESCAPE '!' OR ct.first_name ILIKE $3 ESCAPE '!' OR ct.last_name ILIKE $3 ESCAPE '!'))
 ) SELECT *,count(*) OVER()::int AS group_total FROM grouped ORDER BY created_at DESC,group_id DESC LIMIT $5 OFFSET $6`,[a.userId,q.status,search,manager,q.limit,q.offset]);
 const items=rows.rows.map(row=>{const pending=Number(row.pending);return {groupId:String(row.group_id),total:Number(row.total),pending,accepted:Number(row.accepted),rejected:Number(row.rejected),cancelled:Number(row.cancelled),expired:Number(row.expired),pendingTransfer:Number(row.pending_transfer),actorName:String(row.actor_name),targetName:String(row.target_name),createdAt:new Date(row.created_at).toISOString(),contactNames:row.contact_names as string[],companyNames:row.company_names as string[],canAcceptAll:pending>0&&q.view==='incoming'&&a.capabilities.includes('leads.develop'),canRejectAll:pending>0&&q.view==='incoming'&&a.capabilities.includes('leads.develop'),canCancelAll:pending>0&&contactManager(a)};});
 return success({items,total:Number(rows.rows[0]?.group_total??0)});
}
export async function createContactAssignmentsIn(c:PoolClient,a:LeadActor,input:ContactAssignmentCreate){
 const migrated=await migrateContactAssignmentGroups(c);if(!migrated.ok)return migrated;
 if(!contactManager(a))return failure('FORBIDDEN','无分配权限');
 const currentMembers=await members(c);if(!validTarget(currentMembers.find(m=>m.user_id===input.targetUserId),a.userId))return failure('INVALID_INPUT','分配成员已失效或无用户开发权限');
 const requestedSupervisors=input.supervisorUserIds??[],invalidSupervisor=requestedSupervisors.some(id=>!currentMembers.some(member=>member.user_id===id));if(invalidSupervisor)return failure('INVALID_INPUT','通知用户已失效或不在当前中心');
 const org=await assignmentOrgContext(c,a.userId,input.targetUserId),supervisorUserIds=[...new Set([...org.supervisorUserIds,...requestedSupervisors])].sort(),notifyUserIds=contactAssignmentRecipients(input.targetUserId,supervisorUserIds);
 return cached(c,a,'contact-assignments:create',input,async()=>{
  const items:ContactAssignment[]=[];const groupId=randomUUID(),ordered=[...input.contacts].sort((x,y)=>x.contactId-y.contactId);
  for(const [index,ref] of ordered.entries()){
   const ct=await contact(c,ref,true);if(!ct||!read(a,ct))return failure('NOT_FOUND','联系人不存在');
   if(ct.origin!=='operations')return failure('FORBIDDEN','个人线索不能由管理员分配');
   if(ct.development_restriction?.trim())return failure('FORBIDDEN','联系人存在开发限制');
   if(ct.ownerUserId!==null)return failure('CONFLICT','联系人已有负责人');
   if(ct.active_assignment_status)return failure('CONFLICT','联系人已有进行中的分配');
   if((await c.query("SELECT 1 FROM crm_contact_assignment_requests WHERE contact_id=$1 AND status IN ('pending','accepted','pending_transfer')",[ref.contactId])).rows.length)return failure('CONFLICT','联系人已有有效分配请求');
    const id=randomUUID();await c.query('INSERT INTO crm_contact_assignment_requests(request_id,contact_id,customer_id,target_user_id,actor_id,notify_user_ids,supervisor_user_ids,source_org_unit_id,source_org_unit_name) VALUES($1,$2,$3,$4,$5,$6::uuid[],$7::uuid[],$8,$9)',[id,ref.contactId,ref.customerId,input.targetUserId,a.userId,notifyUserIds,supervisorUserIds,org.sourceOrgUnitId,org.sourceOrgUnitName]);await c.query('INSERT INTO crm_contact_assignment_group_members(group_id,request_id) VALUES($1,$2)',[groupId,id]);const r=await request(c,a,id);if(!r.ok)return r;items.push(r.data);if(index===0)await assignmentEvent(c,a,r.data,CONTACT_ASSIGNMENT_EVENTS.requested,[a.userId,...notifyUserIds],undefined,ordered.length);
  }return success({items});
 },async old=>{const items:ContactAssignment[]=[];for(const r of old.items){const current=await request(c,a,r.requestId);if(!current.ok)return current;items.push(current.data);}return success({items});});
}
export async function decideContactAssignmentIn(c:PoolClient,a:LeadActor,action:ContactAssignmentDecisionAction,input:ContactAssignmentDecision,emitEvent=true):Promise<Result<ContactAssignment>>{
 const initial=(await c.query('SELECT * FROM crm_contact_assignment_requests WHERE request_id=$1',[input.requestId])).rows[0];
 if(!initial)return failure('NOT_FOUND','分配请求不存在');
 const initiallyAllowed=action==='cancel'?contactManager(a)||[initial.actor_id,initial.transfer_actor_id].includes(a.userId):initial.target_user_id===a.userId&&a.capabilities.includes('leads.develop');
 if(!initiallyAllowed)return failure('NOT_FOUND','分配请求不存在');
 return cached(c,a,`contact-assignment:${action}:${input.requestId}`,input,async()=>{
  const ct=await contact(c,{contactId:initial.contact_id,customerId:initial.customer_id},true);if(!ct)return failure('NOT_FOUND','联系人不存在');
  const row=(await c.query('SELECT *,expires_at<=clock_timestamp() AS expired FROM crm_contact_assignment_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
  if(!row||row.version!==input.expectedVersion)return failure('CONFLICT','分配请求状态已变化');
  if(row.expired)return failure('CONFLICT','分配请求已超时，请刷新');
  let event:string;
  if(action==='accept'){
   if(row.target_user_id!==a.userId||!a.capabilities.includes('leads.develop')||!canAcceptContactAssignment(row.status))return failure('CONFLICT','分配请求不可接收');
   const currentMembers=await members(c);if(!validTarget(currentMembers.find(m=>m.user_id===a.userId),row.actor_id))return failure('FORBIDDEN','接收权限已变化');if(ct.development_restriction?.trim())return failure('CONFLICT','联系人存在开发限制');
   if(row.status==='pending'){
    if(ct.ownerUserId!==null)return failure('CONFLICT','联系人归属已变化');
   }else if(ct.ownerUserId!==row.previous_target_user_id){
    return failure('CONFLICT','联系人当前负责人已变化');
   }
   await c.query("UPDATE crm_contact_ownership SET ended_at=clock_timestamp(),ended_reason='transfer' WHERE contact_id=$1 AND customer_id=$2 AND ended_at IS NULL",[row.contact_id,row.customer_id]);
   await c.query('INSERT INTO crm_contact_ownership(contact_id,customer_id,owner_user_id,assignment_request_id,source_org_unit_id,created_by) VALUES($1,$2,$3,$4,$5,$6)',[row.contact_id,row.customer_id,row.target_user_id,row.request_id,row.source_org_unit_id,a.userId]);
   await c.query('UPDATE crm_contact_assignment_requests SET status=\'accepted\',version=version+1,decided_at=now() WHERE request_id=$1',[row.request_id]);
   await c.query('UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1',[row.contact_id]);
   event=row.status==='pending_transfer'?CONTACT_ASSIGNMENT_EVENTS.transferred:CONTACT_ASSIGNMENT_EVENTS.accepted;
  }else if(action==='reject'){
   if(row.target_user_id!==a.userId||!a.capabilities.includes('leads.develop')||!['pending','pending_transfer'].includes(row.status))return failure('CONFLICT','分配请求不可拒绝');
   if(row.status==='pending_transfer'){
    if(!row.previous_target_user_id)return failure('CONFLICT','转交记录缺少原负责人');
    const restored=await assignmentOrgContext(c,row.actor_id,row.previous_target_user_id);
    await c.query("UPDATE crm_contact_assignment_requests SET status='accepted',target_user_id=previous_target_user_id,supervisor_user_ids=$2::uuid[],notify_user_ids=$3::uuid[],version=version+1,decided_at=now() WHERE request_id=$1",[row.request_id,restored.supervisorUserIds,contactAssignmentRecipients(row.previous_target_user_id,restored.supervisorUserIds)]);
    event=CONTACT_ASSIGNMENT_EVENTS.transferCancelled;
   }else{
    await c.query("UPDATE crm_contact_assignment_requests SET status='rejected',version=version+1,decided_at=now() WHERE request_id=$1",[row.request_id]);
    event=CONTACT_ASSIGNMENT_EVENTS.rejected;
   }
  }else{
   const actorIsRequester=[row.actor_id,row.transfer_actor_id].includes(a.userId);
   if(!canCancelContactAssignment({status:row.status,actorIsRequester,manager:contactManager(a)}))return failure('CONFLICT','分配请求不可撤回');
   if(row.status==='pending_transfer'){
    if(!row.previous_target_user_id)return failure('CONFLICT','转交记录缺少原负责人');
    const restored=await assignmentOrgContext(c,row.actor_id,row.previous_target_user_id);
    await c.query("UPDATE crm_contact_assignment_requests SET status='accepted',target_user_id=previous_target_user_id,supervisor_user_ids=$2::uuid[],notify_user_ids=$3::uuid[],version=version+1,decided_at=now() WHERE request_id=$1",[row.request_id,restored.supervisorUserIds,contactAssignmentRecipients(row.previous_target_user_id,restored.supervisorUserIds)]);
    event=CONTACT_ASSIGNMENT_EVENTS.transferCancelled;
   }else{
    await c.query("UPDATE crm_contact_assignment_requests SET status='cancelled',version=version+1,decided_at=now() WHERE request_id=$1",[row.request_id]);
    event=CONTACT_ASSIGNMENT_EVENTS.cancelled;
   }
  }
  const result=await request(c,a,input.requestId,a.userId);if(!result.ok)return result;
  if(emitEvent)await assignmentEvent(c,a,result.data,event,[row.actor_id,row.target_user_id,row.transfer_actor_id,row.previous_target_user_id,...row.notify_user_ids,...row.supervisor_user_ids].filter((id):id is string=>!!id));return result;
 },()=>request(c,a,input.requestId,a.userId));
}
export async function decideContactAssignmentGroupIn(c:PoolClient,a:LeadActor,action:ContactAssignmentDecisionAction,input:ContactAssignmentGroupDecision):Promise<Result<{items:ContactAssignment[]}>>{
 const migrated=await migrateContactAssignmentGroups(c);if(!migrated.ok)return migrated;
 const rows=(await c.query(`SELECT r.request_id,r.version,r.status,r.actor_id,r.target_user_id,r.transfer_actor_id,r.previous_target_user_id,r.notify_user_ids,r.supervisor_user_ids,c.origin FROM crm_contact_assignment_requests r LEFT JOIN crm_contact_assignment_group_members gm ON gm.request_id=r.request_id JOIN crm_customers c ON c.customer_id=r.customer_id WHERE COALESCE(gm.group_id,r.request_id)=$1 ORDER BY r.request_id FOR UPDATE OF r`,[input.groupId])).rows;
 if(!rows.length)return failure('NOT_FOUND','分配组不存在');
 if(action==='cancel'?!contactManager(a):rows.some(row=>row.target_user_id!==a.userId)||!a.capabilities.includes('leads.develop'))return failure('NOT_FOUND','分配请求不存在');
 const pendingRows=rows.filter(row=>row.status==='pending'),decided:ContactAssignment[]=[];
 for(const row of pendingRows){
  const decision={requestId:row.request_id as string,expectedVersion:Number(row.version),idempotencyKey:createHash('sha256').update(`${input.idempotencyKey}:${row.request_id}`).digest('hex')};
  const result=await decideContactAssignmentIn(c,a,action,decision,false);if(!result.ok)return result;decided.push(result.data);
 }
 if(decided.length){
  const event=action==='accept'?CONTACT_ASSIGNMENT_EVENTS.accepted:action==='reject'?CONTACT_ASSIGNMENT_EVENTS.rejected:CONTACT_ASSIGNMENT_EVENTS.cancelled;
  const recipients=[...new Set(pendingRows.flatMap(row=>[row.actor_id,row.target_user_id,row.transfer_actor_id,row.previous_target_user_id,...row.notify_user_ids,...row.supervisor_user_ids]).filter((id):id is string=>!!id))];
  await assignmentEvent(c,a,decided[0]!,event,recipients,undefined,decided.length);
 }
 const result=await contactAssignmentsIn(c,a,{view:action==='cancel'?'outgoing':'incoming',status:'pending',search:'',limit:200,offset:0,groupId:input.groupId});
 return result.ok?success({items:result.data.items}):result;
}
export async function transferContactAssignmentIn(c:PoolClient,a:LeadActor,input:ContactAssignmentTransfer):Promise<Result<ContactAssignment>>{
 const initial=(await c.query('SELECT * FROM crm_contact_assignment_requests WHERE request_id=$1',[input.requestId])).rows[0];
 if(!initial)return failure('NOT_FOUND','分配请求不存在');
 return cached(c,a,`contact-assignment:transfer:${input.requestId}`,input,async()=>{
  const ct=await contact(c,{contactId:initial.contact_id,customerId:initial.customer_id},true);if(!ct)return failure('NOT_FOUND','联系人不存在');
  const row=(await c.query('SELECT * FROM crm_contact_assignment_requests WHERE request_id=$1 FOR UPDATE',[input.requestId])).rows[0];
  if(!row||row.version!==input.expectedVersion)return failure('CONFLICT','分配请求状态已变化');
  const manager=contactManager(a),actorIsCurrentOwner=ct.ownerUserId===a.userId;
  if(!canTransferContactAssignment({status:row.status,actorIsCurrentOwner,manager,targetUserId:input.targetUserId,currentOwnerUserId:ct.ownerUserId}))return failure('FORBIDDEN','没有转交该联系人的权限');
  const currentMembers=await members(c),target=currentMembers.find(m=>m.user_id===input.targetUserId);
  if(!validTarget(target,a.userId)||input.targetUserId===ct.ownerUserId)return failure('INVALID_INPUT','转交成员已失效');
  const org=await assignmentOrgContext(c,a.userId,input.targetUserId),notifyUserIds=contactAssignmentRecipients(input.targetUserId,org.supervisorUserIds);
  await c.query("UPDATE crm_contact_assignment_requests SET status='pending_transfer',target_user_id=$2,previous_target_user_id=$3,transfer_actor_id=$4,transfer_requested_at=now(),expires_at=now()+interval '7 days',supervisor_user_ids=$5::uuid[],notify_user_ids=$6::uuid[],version=version+1,decided_at=NULL WHERE request_id=$1",[row.request_id,input.targetUserId,ct.ownerUserId,a.userId,org.supervisorUserIds,notifyUserIds]);
  const result=await request(c,a,input.requestId);if(!result.ok)return result;
  await assignmentEvent(c,a,result.data,CONTACT_ASSIGNMENT_EVENTS.transferRequested,[a.userId,ct.ownerUserId,input.targetUserId,...org.supervisorUserIds].filter((id):id is string=>!!id));return result;
 },()=>request(c,a,input.requestId));
}
export async function processExpiredAssignmentsIn(c:PoolClient,a:LeadActor,input:ContactAssignmentExpiryInput):Promise<Result<ContactAssignmentExpiryReceipt>>{
 if(!contactManager(a))return failure('FORBIDDEN','无分配管理权限');
 const due=await expireDueAssignmentsIn(c,input.limit);if(!due.ok)return due;
 const expired:ContactAssignment[]=[];
 for(const id of due.data.expiredIds){const result=await request(c,a,id);if(!result.ok)return result;expired.push(result.data);}
 return success({expired});
}

type DueAssignment={request_id:string;contact_id:number;customer_id:string;target_user_id:string;actor_id:string;previous_target_user_id:string|null;transfer_actor_id:string|null;notify_user_ids:string[];supervisor_user_ids:string[];status:string;expired:boolean};
async function expireDueAssignmentsIn(c:PoolClient,limit:number):Promise<Result<{expiredIds:string[];transferRestoredIds:string[]}>>{
 const candidates=(await c.query("SELECT request_id AS id FROM crm_contact_assignment_requests WHERE status IN ('pending','pending_transfer') AND expires_at<=clock_timestamp() ORDER BY expires_at,request_id LIMIT $1",[limit])).rows as Array<{id:string}>;
 const expiredIds:string[]=[],transferRestoredIds:string[]=[];
 for(const candidate of candidates){
  const initial=(await c.query('SELECT contact_id,customer_id FROM crm_contact_assignment_requests WHERE request_id=$1',[candidate.id])).rows[0];if(!initial)continue;
  const ct=await contact(c,{contactId:initial.contact_id,customerId:initial.customer_id},true);if(!ct)continue;
  const row=(await c.query('SELECT *,expires_at<=clock_timestamp() AS expired FROM crm_contact_assignment_requests WHERE request_id=$1 FOR UPDATE',[candidate.id])).rows[0] as DueAssignment|undefined;
  if(!row||!row.expired)continue;
  let event:string|null=null;
  if(row.status==='pending'){
   const changed=await c.query("UPDATE crm_contact_assignment_requests SET status='expired',version=version+1,decided_at=clock_timestamp() WHERE request_id=$1 AND status='pending' AND expires_at<=clock_timestamp() RETURNING request_id",[row.request_id]);
   if(changed.rowCount){expiredIds.push(row.request_id);event=CONTACT_ASSIGNMENT_EVENTS.expired;}
  }else if(row.status==='pending_transfer'&&row.previous_target_user_id){
   const restored=await assignmentOrgContext(c,row.actor_id,row.previous_target_user_id);
   const changed=await c.query("UPDATE crm_contact_assignment_requests SET status='accepted',target_user_id=previous_target_user_id,supervisor_user_ids=$2::uuid[],notify_user_ids=$3::uuid[],version=version+1,decided_at=clock_timestamp() WHERE request_id=$1 AND status='pending_transfer' AND expires_at<=clock_timestamp() RETURNING request_id",[row.request_id,restored.supervisorUserIds,contactAssignmentRecipients(row.previous_target_user_id,restored.supervisorUserIds)]);
   if(changed.rowCount){transferRestoredIds.push(row.request_id);event=CONTACT_ASSIGNMENT_EVENTS.transferCancelled;}
  }
  if(event)await assignmentEventForRequest(c,event,row.request_id);
 }
 return success({expiredIds,transferRestoredIds});
}

async function assignmentEventForRequest(c:PoolClient,type:string,requestId:string){
 const row=(await c.query(`SELECT request.request_id AS "requestId",COALESCE(group_member.group_id,request.request_id) AS "groupId",request.contact_id AS "contactId",request.customer_id AS "customerId",request.version,request.actor_id AS "actorId",request.target_user_id AS "targetId",request.previous_target_user_id AS "previousTargetId",request.transfer_actor_id AS "transferActorId",request.notify_user_ids AS "notifyUserIds",request.supervisor_user_ids AS "supervisorUserIds",COALESCE(NULLIF(concat_ws(' ',contact.first_name,contact.last_name),''),'联系人') AS "contactName",company.name AS "companyName" FROM crm_contact_assignment_requests request LEFT JOIN crm_contact_assignment_group_members group_member USING(request_id) JOIN contacts contact ON contact.id=request.contact_id JOIN crm_customers customer ON customer.customer_id=request.customer_id JOIN companies company ON company.id=customer.company_id WHERE request.request_id=$1`,[requestId])).rows[0];
 if(!row)return;
 const recipients=[row.actorId,row.targetId,row.previousTargetId,row.transferActorId,...row.notifyUserIds,...row.supervisorUserIds].filter((id:string|null):id is string=>!!id);
 const eventUserId=String(row.transferActorId??row.actorId);
 await c.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,'crm',$3,$4,$5,$6::uuid[])",[type,eventUserId,row.version,row.customerId,JSON.stringify({requestId:row.requestId,groupId:row.groupId,contactId:row.contactId,customerId:row.customerId,version:row.version,companyName:row.companyName,contactName:row.contactName}),[...new Set(recipients)].sort()]);
}

export async function processExpiredAssignmentsSystemIn(c:PoolClient,limit:number){return expireDueAssignmentsIn(c,limit);}

export function startAssignmentExpiryScheduler(pool:Pool,log:LogSink){
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,active:Promise<void>|undefined;
 const tick=()=>{
  if(stopped)return;
  active=(async()=>{
   const c=await pool.connect();
   try{
    await c.query('BEGIN');
    const lock=await c.query('SELECT pg_try_advisory_xact_lock($1) AS acquired',[CONTACT_ASSIGNMENT_EXPIRY_LOCK]);
    if(lock.rows[0]?.acquired){const result=await processExpiredAssignmentsSystemIn(c,200);if(!result.ok)throw new Error(result.error.message);}
    await c.query('COMMIT');
   }catch(error){
    try{await c.query('ROLLBACK');}catch{log.write('ERROR','contact-assignment.expiry.rollback','分配超时扫描回滚失败');}
    log.write('ERROR','contact-assignment.expiry',`分配超时扫描失败 ${error instanceof Error?error.message:String(error)}`);
   }finally{
    c.release();
    if(!stopped){timer=setTimeout(tick,CONTACT_ASSIGNMENT_EXPIRY_POLL_SECONDS*MILLISECONDS_PER_SECOND);timer.unref();}
   }
  })();
 };
 tick();return {async stop(){stopped=true;if(timer)clearTimeout(timer);await active;}};
}
export async function contactUpdateIn(c:PoolClient,a:LeadActor,input:CenterContactUpdate):Promise<Result<CenterContactDetail>>{
 const ct=await contact(c,input,true);if(!ct||!read(a,ct))return failure('NOT_FOUND','联系人不存在或不可修改');
 if('clientType' in input.fields)return failure('INVALID_INPUT','客户类型属于公司资料，请修改公司客户类型');
 if(Object.keys(input.fields).some(f=>!contactPermissionsFor(a,ct).editableFields.includes(f)))return failure('FORBIDDEN','没有所选字段的修改权限');
 if(typeof input.fields.email==='string'&&input.fields.email.trim().toLowerCase()!==(ct.email??'').trim().toLowerCase()){
  const ingress=await evaluateLeadIngressIn(c,a,{source:'api_contact_update',sourceChannel:ct.source,sourceDetail:ct.sourceDetail??'',kind:ct.origin,idempotencyKey:input.idempotencyKey,customerKey:ct.customerId,company:{name:ct.companyName,country:ct.country},contacts:[{email:input.fields.email}],target:{customerId:ct.customerId,contactId:ct.contactId,companyId:ct.companyId}});
  if(!ingress.ok)return ingress;if(ingress.data.assessment.status!=='clear')return failure('CONFLICT',`${ingress.data.assessment.message}（冲突编号 ${ingress.data.decision.decisionId}）`);
 }
 return cached(c,a,`contact-update:${input.contactId}`,input,async()=>{
  if(ct.contactVersion!==input.expectedVersion)return failure('CONFLICT','联系人版本已变化');
  const fields={email:'email',firstName:'first_name',lastName:'last_name',title:'title',phone:'phone',whatsapp:'whatsapp',sourceLevel1:'source_level1',sourceLevel2:'source_level2',linkedinUrl:'linkedin',country:'country',clientType:'client_type',language:'language',stage:'stage',status:'status',tags:'tags',preferences:'extra'} as const;
  const values: unknown[] = [input.contactId];
  const sets: string[] = [];
  const changes = notificationValues(Object.entries(input.fields).map(([key,value])=>[key,contactFieldValue(ct,key),key==='email'&&typeof value==='string'?value.trim().toLowerCase()||null:value]));
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
  await contactEvent(c,a,ct,CONTACT_ASSIGNMENT_EVENTS.updated,input.expectedVersion+1,undefined,undefined,{fields:Object.keys(input.fields),changes});return contactDetailIn(c,a,input);
 },()=>contactDetailIn(c,a,input));
}
async function contactEvent(c:PoolClient,a:LeadActor,ct:ContactRow,type:string,version:number,activityId?:string,mailEventId?:string,details:Record<string,unknown>={},extraRecipients:readonly string[]=[]){await c.query('INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,\'crm\',$3,$4,$5,$6::uuid[])',[type,a.userId,version,ct.customerId,JSON.stringify({contactId:ct.contactId,customerId:ct.customerId,version,...(activityId?{activityId}:{}),...(mailEventId?{mailEventId}:{}),...details}),[...new Set([a.userId,ct.created_by,...(ct.ownerUserId?[ct.ownerUserId]:[]),...(ct.shared_grants??[]).map(g=>g.targetUserId),...extraRecipients])].sort()]);}
export async function contactFollowupIn(c:PoolClient,a:LeadActor,input:CenterContactFollowup):Promise<Result<CenterContactDetail>>{
 const ct=await contact(c,input,true);if(!ct||!read(a,ct))return failure('NOT_FOUND','联系人不存在或不可跟进');
 const permissions=contactPermissionsFor(a,ct);if(input.stage!==undefined&&!permissions.canChangeStage||(input.stage===undefined||input.method!=='note'||input.contactStatus!==undefined)&&!permissions.canFollowup)return failure('FORBIDDEN','没有跟进或关系阶段修改权限');
 return cached(c,a,`contact-followup:${input.contactId}`,input,async()=>{
  if(ct.contactVersion!==input.expectedVersion)return failure('CONFLICT','联系人版本已变化');
  const recorded=(await c.query('SELECT clock_timestamp() AS t')).rows[0].t as Date,occurred=input.occurredAt?new Date(input.occurredAt):recorded,method=input.method??'other';
  if(!Number.isFinite(occurred.getTime())||occurred.getTime()>recorded.getTime()+FOLLOWUP_TIME_LIMITS.future_skew_seconds*MILLISECONDS_PER_SECOND||method==='note'&&input.contactStatus!==undefined)return failure('INVALID_INPUT','跟进时间或触达状态无效');
  const note=!permissions.canFollowup&&input.stage!==undefined?`关系阶段：${input.stage}`:input.note;
  const changes=notificationValues([['contactStatus',ct.touchStatus,input.contactStatus],['stage',ct.relationshipStage??null,input.stage]]);
  const activity=(await c.query('INSERT INTO crm_shared_activities(customer_id,interaction_id,actor_id,note,stage,method,occurred_at,recorded_at,created_at,contact_id,contact_status) VALUES($1,NULL,$2,$3,$4,$5,$6,$7,$7,$8,$9) RETURNING id::text',[ct.customerId,a.userId,note,input.stage??null,method,occurred,recorded,ct.contactId,input.contactStatus??null])).rows[0];
  // Only explicit user results synchronize compatible legacy display fields.
  // Unable to contact is not evidence of an invalid mailbox; notes/tags never manufacture touch.
  const legacyStatus = input.contactStatus !== undefined ? FOLLOWUP_LEGACY_STATUS[input.contactStatus] : null;
  // Relationship stage lives in the activity timeline; ordinary tags are independent customer metadata.
  await c.query('UPDATE contacts SET crm_touch_status=COALESCE($2,crm_touch_status),status=COALESCE($3,status),crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1',[ct.contactId,input.contactStatus??null,legacyStatus]);
  await refreshMailProjectionIn(c,input,ct.email);
  await contactEvent(c,a,ct,CONTACT_ASSIGNMENT_EVENTS.followup,input.expectedVersion+1,activity.id,undefined,{stage:input.stage??null,contactStatus:input.contactStatus??null,method,changes});
  return contactDetailIn(c,a,input);
 },()=>contactDetailIn(c,a,input));
}
export {contact as loadContactIn,read as canReadContact,edit as canDevelopContact,contactEvent as recordContactEventIn,cached as lifecycleCached};

async function companyEditable(c: PoolClient, a: LeadActor, ct: ContactRow): Promise<boolean> {
 const manager=ownManager(a,ct),personal=ct.origin==='personal'&&ct.ownerUserId===a.userId;
 if (!a.capabilities.includes('leads.develop') || !(manager||personal) || ct.active_assignment_status==='pending_transfer'&&!manager) return false;
 const restricted=ownManager(a,ct)
  ?await c.query("SELECT 1 FROM crm_customers WHERE company_id=$1 AND origin='personal' LIMIT 1",[ct.companyId])
  :await c.query('SELECT 1 FROM crm_customers WHERE company_id=$1 AND created_by<>$2 LIMIT 1',[ct.companyId,a.userId]);
 return !restricted.rowCount;
}
/** Shared company edits have a separate contract and revision from contact edits. */
export async function companyUpdateIn(c: PoolClient,a: LeadActor,input: CenterCompanyUpdate): Promise<Result<CenterContactDetail>> {
 const ct = await contact(c,input,true);
 if (!ct || !read(a,ct) || !await companyEditable(c,a,ct)) return failure('FORBIDDEN','没有公司资料修改权限');
 const currentCompany=(await c.query('SELECT name,domain,country FROM companies WHERE id=$1',[ct.companyId])).rows[0];
 const ingress=await evaluateLeadIngressIn(c,a,{source:'api_contact_update',sourceChannel:ct.source,sourceDetail:ct.sourceDetail??'',kind:ct.origin,idempotencyKey:input.idempotencyKey,customerKey:ct.customerId,company:{name:typeof input.fields.name==='string'?input.fields.name:currentCompany.name,domain:input.fields.domain!==undefined?input.fields.domain:currentCompany.domain,country:input.fields.country!==undefined?input.fields.country:currentCompany.country},contacts:[],target:{customerId:ct.customerId,contactId:ct.contactId,companyId:ct.companyId},checkCompany:true});
 if(!ingress.ok)return ingress;if(ingress.data.assessment.status!=='clear')return failure('CONFLICT',`${ingress.data.assessment.message}（冲突编号 ${ingress.data.decision.decisionId}）`);
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
