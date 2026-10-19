import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {failure,success,type Result} from '../../core/crm';
import {globalContactActor,sourceContactManager} from '../../core/contact-permissions';
import {CONTACT_SHARED_FIELDS,CONTACT_SHARING_EVENTS as EVENTS,type ContactShare,type ContactShareCreate,type ContactShareDecision,type ContactShareUpdate,type ContactShareQuery,type ContactShareGrant} from '../../core/contact-sharing';
import type {LeadActor} from './lead-repository';
import {CONTACT_OWNER_SQL,loadContactIn,canReadContact,contactPermissionsFor,lifecycleCached,recordContactEventIn} from './contact-assignment-repository';
import {validShareSql} from './contact-sharing-sql';
import {effectiveCapabilitiesFor} from '../../core/admin';
const SELECT=`SELECT sh.share_id AS "shareId",sh.contact_id AS "contactId",sh.customer_id AS "customerId",sh.grantor_user_id AS "grantorUserId",gu.display_name AS "grantorName",sh.target_user_id AS "targetUserId",tu.display_name AS "targetName",COALESCE(NULLIF(concat_ws(' ',ct.first_name,ct.last_name),''),'联系人') AS "contactName",co.name AS "companyName",sh.editable_fields AS "editableFields",sh.can_followup AS "canFollowup",sh.can_change_stage AS "canChangeStage",sh.status,sh.version,sh.created_at AS "createdAt",(${validShareSql(CONTACT_OWNER_SQL)}) AS valid,c.created_by,c.origin FROM crm_contact_shares sh JOIN contacts ct ON ct.id=sh.contact_id JOIN crm_customers c ON c.customer_id=sh.customer_id JOIN companies co ON co.id=c.company_id JOIN identity.users gu ON gu.user_id=sh.grantor_user_id JOIN identity.users tu ON tu.user_id=sh.target_user_id`;
type Row=ContactShare&{valid:boolean;created_by:string;origin:string};
function manage(a:LeadActor,r:Row):boolean{return globalContactActor(a)||sourceContactManager(a,{...r,ownerUserId:r.grantorUserId})||r.grantorUserId===a.userId&&r.valid;}
function map(a:LeadActor,r:Row):ContactShare{const {valid:_,created_by:__,origin:___,...share}=r;const status=!r.valid&&['pending','accepted'].includes(r.status)?'revoked':r.status;return {...share,status,createdAt:new Date(r.createdAt).toISOString(),canAccept:status==='pending'&&r.targetUserId===a.userId&&a.capabilities.includes('leads.develop'),canReject:status==='pending'&&r.targetUserId===a.userId,canManage:['pending','accepted'].includes(status)&&manage(a,r)};}
async function row(c:PoolClient,id:string,lock=false):Promise<Row|undefined>{return (await c.query(`${SELECT} WHERE sh.share_id=$1 ${lock?'FOR UPDATE OF sh':''}`,[id])).rows[0];}
async function result(c:PoolClient,a:LeadActor,id:string):Promise<Result<ContactShare>>{const r=await row(c,id);return !r||!manage(a,r)&&r.targetUserId!==a.userId?failure('NOT_FOUND','共享请求不存在'):success(map(a,r));}
async function event(c:PoolClient,a:LeadActor,r:ContactShare,type:string){const ct=await loadContactIn(c,r);await c.query("INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,'crm',$3,$4,$5,$6::uuid[])",[type,a.userId,r.version,r.customerId,JSON.stringify({shareId:r.shareId,contactId:r.contactId,customerId:r.customerId,version:r.version,companyName:r.companyName,contactName:r.contactName}),[...new Set([a.userId,r.grantorUserId,r.targetUserId,...(ct?[ct.created_by]:[])])].sort()]);}
function allowedGrant(a:LeadActor,ct:NonNullable<Awaited<ReturnType<typeof loadContactIn>>>,i:ContactShareGrant):boolean{const p=contactPermissionsFor(a,ct);return p.canShare&&i.editableFields.every(f=>CONTACT_SHARED_FIELDS.includes(f as never)&&p.editableFields.includes(f))&&(!i.canFollowup||p.canFollowup)&&(!i.canChangeStage||p.canChangeStage);}
export async function shareMembersIn(c:PoolClient,a:LeadActor){
 if(!a.capabilities.includes('leads.develop'))return failure('FORBIDDEN','无共享权限');
 const rows=await c.query("SELECT u.user_id AS \"userId\",u.display_name AS \"displayName\",pa.capabilities,ARRAY(SELECT role FROM identity.product_grants WHERE user_id=u.user_id AND product_id='crm' AND active) AS roles FROM identity.users u JOIN identity.product_access pa ON pa.user_id=u.user_id AND pa.product_id='crm' AND pa.active WHERE u.active AND NOT u.must_change_password AND u.user_id<>$1",[a.userId]);
 return success(rows.rows.filter(m=>m.roles.includes('sales')&&effectiveCapabilitiesFor(m.roles,m.capabilities).includes('leads.develop')).map(m=>({userId:m.userId,displayName:m.displayName})));
}
export async function sharesIn(c:PoolClient,a:LeadActor,q:ContactShareQuery){
 if(!a.capabilities.includes('leads.develop'))return failure('FORBIDDEN','无共享访问权限');
 const permission=q.view==='incoming'?'sh.target_user_id=$1':`(sh.grantor_user_id=$1 OR $2::boolean OR ($3::boolean AND c.origin='operations'))`;
 const effectiveStatus=`CASE WHEN sh.status IN ('pending','accepted') AND NOT (${validShareSql(CONTACT_OWNER_SQL)}) THEN 'revoked' ELSE sh.status END`;
 const where=`WHERE ct.crm_deleted_at IS NULL AND co.crm_deleted_at IS NULL AND ${permission} AND ($4::text IS NULL OR (${effectiveStatus})=$4) AND ($5::integer IS NULL OR sh.contact_id=$5) AND ($6::uuid IS NULL OR sh.customer_id=$6)`;
 const params=[a.userId,globalContactActor(a),a.roles.includes('operations')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('leads.assign'),q.status??null,q.contactId??null,q.customerId??null];
 // Bind all positions even for incoming, so PostgreSQL can infer unused parameters.
 const filter=where.replace('WHERE ct.crm_deleted_at','WHERE $2::boolean IS NOT NULL AND $3::boolean IS NOT NULL AND ct.crm_deleted_at');
 const rows=await c.query(`${SELECT} ${filter} ORDER BY sh.created_at DESC,sh.share_id DESC LIMIT $7 OFFSET $8`,[...params,q.limit,q.offset]);
 const count=await c.query(`SELECT count(*)::int AS n FROM (${SELECT} ${filter}) q`,params);return success({items:rows.rows.map(r=>map(a,r)),total:count.rows[0].n});
}
export async function createShareIn(c:PoolClient,a:LeadActor,input:ContactShareCreate):Promise<Result<ContactShare>>{
 const ct=await loadContactIn(c,input,true);if(!ct||!canReadContact(a,ct)||!allowedGrant(a,ct,input))return failure('FORBIDDEN','没有所选共享权限');
 const eligible=await shareMembersIn(c,a);if(!eligible.ok)return eligible;if(!eligible.data.some(m=>m.userId===input.targetUserId))return failure('INVALID_INPUT','接收用户不可用');
 return lifecycleCached(c,a,'contact-share:create',input,async()=>{
  if(ct.contactVersion!==input.expectedVersion)return failure('CONFLICT','联系人已变化，请刷新重试');
  // Stale grants cannot block a fresh invitation after ownership/authorization changes.
  await c.query(`UPDATE crm_contact_shares sh SET status='revoked',version=sh.version+1,updated_at=now(),decided_at=now() FROM crm_customers c WHERE sh.contact_id=$1 AND sh.customer_id=c.customer_id AND sh.status IN ('pending','accepted') AND NOT (${validShareSql(CONTACT_OWNER_SQL.replaceAll('ct.id','sh.contact_id'))})`,[input.contactId]);
  if((await c.query("SELECT 1 FROM crm_contact_shares WHERE contact_id=$1 AND target_user_id=$2 AND status IN ('pending','accepted')",[input.contactId,input.targetUserId])).rowCount)return failure('CONFLICT','该用户已有共享邀请或协作权限');
  const id=randomUUID();await c.query('INSERT INTO crm_contact_shares(share_id,contact_id,customer_id,grantor_user_id,target_user_id,editable_fields,can_followup,can_change_stage) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',[id,input.contactId,input.customerId,a.userId,input.targetUserId,JSON.stringify(input.editableFields),input.canFollowup,input.canChangeStage]);
  const r=await result(c,a,id);if(r.ok)await event(c,a,r.data,EVENTS.requested);return r;
 },old=>result(c,a,old.shareId));
}
export async function decideShareIn(c:PoolClient,a:LeadActor,action:'accept'|'reject'|'revoke',input:ContactShareDecision):Promise<Result<ContactShare>>{
 const r=await row(c,input.shareId,true);if(!r||(action==='revoke'?!manage(a,r)&&!(r.targetUserId===a.userId&&['accepted','revoked'].includes(r.status)):r.targetUserId!==a.userId))return failure('NOT_FOUND','共享请求不存在');
 return lifecycleCached(c,a,`contact-share:${action}`,input,async()=>{
  if(r.version!==input.expectedVersion||(action==='revoke'?!['pending','accepted'].includes(r.status):r.status!=='pending'))return failure('CONFLICT','共享状态已变化');
  if(action==='accept'){
   const ct=await loadContactIn(c,r,true);if(!ct||!r.valid||(!a.capabilities.includes('leads.develop')||!a.roles.includes('sales')))return failure('FORBIDDEN','共享授权已失效');
  }
  const status=action==='accept'?'accepted':action==='reject'?'rejected':'revoked';await c.query('UPDATE crm_contact_shares SET status=$2,version=version+1,updated_at=now(),decided_at=now() WHERE share_id=$1',[r.shareId,status]);
  await c.query('UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1',[r.contactId]);
  const next=await result(c,a,r.shareId);if(next.ok){await event(c,a,next.data,EVENTS[status]);const ct=await loadContactIn(c,r);if(ct)await recordContactEventIn(c,a,ct,'crm.contact.updated',ct.contactVersion??1);}return next;
 },old=>result(c,a,old.shareId));
}
export async function updateShareIn(c:PoolClient,a:LeadActor,input:ContactShareUpdate):Promise<Result<ContactShare>>{
 const r=await row(c,input.shareId,true);if(!r||!manage(a,r))return failure('NOT_FOUND','共享请求不存在');
 const ct=await loadContactIn(c,r,true);if(!ct||!r.valid)return failure('FORBIDDEN','共享授权已失效');
 // Managers may narrow or revoke; expanding is still bounded by the current grantor's fixed assigned-user field ceiling.
 const allowed=contactPermissionsFor({...a,userId:r.grantorUserId,roles:['sales'],scope:'own',capabilities:['leads.develop']},ct);
 if(input.editableFields.some(f=>!CONTACT_SHARED_FIELDS.includes(f as never)||!allowed.editableFields.includes(f)))return failure('FORBIDDEN','不能授予所选字段权限');
 return lifecycleCached(c,a,'contact-share:update',input,async()=>{
  if(r.version!==input.expectedVersion||!['pending','accepted'].includes(r.status))return failure('CONFLICT','共享状态已变化');
  await c.query('UPDATE crm_contact_shares SET editable_fields=$2::jsonb,can_followup=$3,can_change_stage=$4,version=version+1,updated_at=now() WHERE share_id=$1',[r.shareId,JSON.stringify(input.editableFields),input.canFollowup,input.canChangeStage]);
  await c.query('UPDATE contacts SET crm_contact_version=crm_contact_version+1,updated_at=now() WHERE id=$1',[r.contactId]);
  const next=await result(c,a,r.shareId);if(next.ok)await event(c,a,next.data,EVENTS.updated);return next;
 },old=>result(c,a,old.shareId));
}
