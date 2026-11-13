import {CONTACT_SHARING_EVENTS,CONTACT_TEAM_VISIBILITY_EVENT} from '../../core/contact-sharing';
import {loadContactIn,canReadContact} from './contact-assignment-repository';
import {createHash} from 'node:crypto';
import {CONTACT_ASSIGNMENT_EVENTS} from '../../core/contact-assignments';
const CONTACT_EVENTS:string[]=[...Object.values(CONTACT_ASSIGNMENT_EVENTS),...Object.values(CONTACT_SHARING_EVENTS),CONTACT_TEAM_VISIBILITY_EVENT];
const ASSIGNMENT_REQUEST_EVENTS:string[]=[CONTACT_ASSIGNMENT_EVENTS.requested,CONTACT_ASSIGNMENT_EVENTS.accepted,CONTACT_ASSIGNMENT_EVENTS.rejected,CONTACT_ASSIGNMENT_EVENTS.cancelled,CONTACT_ASSIGNMENT_EVENTS.expired,CONTACT_ASSIGNMENT_EVENTS.transferRequested,CONTACT_ASSIGNMENT_EVENTS.transferred,CONTACT_ASSIGNMENT_EVENTS.transferCancelled];
const CONTACT_REQUEST_EVENTS:string[]=[...ASSIGNMENT_REQUEST_EVENTS,...Object.values(CONTACT_SHARING_EVENTS)];
import type {Pool,PoolClient} from 'pg';
import {failure,success,type Result,type LogSink} from '../../core/crm';
import {canReadLead} from './lead-repository';
import type {DataScope} from '../../core/admin';
import {ASSIGNMENT_SQL,ASSIGNMENT_VERSION} from './assignment-schema';
import type {CrmRole} from '../../core/auth';
import {effectiveCapabilitiesFor} from '../../core/admin';
import {NOTIFICATION_LIMITS,type NotificationRepository,type FeedQuery,type FeedPage,type Notification,type NotificationReadAllReceipt} from '../../core/notifications';
import {NOTIFICATION_LOCK,NOTIFICATION_SQL,NOTIFICATION_VERSION} from './notification-schema';
import {assertCenterDatabasePool} from './config';
import {ADMIN_LOCK} from './admin-schema';
import { TASK_DUE_EVENT } from '../../core/tasks';
import { OPPORTUNITY_EVENTS } from '../../core/opportunities';
import { DEAL_OVERLAP_EVENT } from '../../core/lead-ingress';
const OPPORTUNITY_EVENT_TYPES:string[]=Object.values(OPPORTUNITY_EVENTS);
import { TEAM_ATTENTION_EVENTS } from '../../core/team-attention';
const TEAM_ATTENTION_EVENT_TYPES:string[]=Object.values(TEAM_ATTENTION_EVENTS);
import { canProjectTaskDue } from './task-repository';
const SUMMARY_NOTE_MAX=160;
const SELF_CREATED_EVENT='crm.customer.created';
type Actor={userId:string;roles:CrmRole[];capabilities:string[];scope:DataScope};
type Customer={customer_id:string;created_by:string;owner_user_id:string|null;origin:string;state:string};
function visible(a:Actor,c:Customer,eventType:string){
 if(a.roles.includes('admin')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('leads.read.all'))return true;
 if(eventType==='crm.lead.followup'||OPPORTUNITY_EVENT_TYPES.includes(eventType)){return c.origin==='operations'&&a.roles.includes('operations')&&a.capabilities.includes('followups.read')&&['shared','summary'].includes(a.scope)||c.owner_user_id===a.userId&&a.capabilities.includes('leads.develop');}
 const ops=c.origin==='operations'&&a.roles.includes('operations')&&a.capabilities.some(v=>['leads.import','leads.publish','followups.read'].includes(v))&&(a.scope==='shared'||a.scope==='summary');
 const sales=(c.state==='published'&&a.capabilities.includes('leads.claim'))||(c.owner_user_id===a.userId&&a.capabilities.includes('leads.develop'));
 return ops||sales;
}
function notificationChange(row:Record<string,any>):Notification['change']{
 const eventType=String(row.event_type??'');
 const text=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():null;
 const changes=Array.isArray(row.payload?.changes)?row.payload.changes.filter((value:unknown):value is {field:string;from:string|null;to:string|null}=>!!value&&typeof value==='object'&&!Array.isArray(value)&&typeof (value as Record<string,unknown>).field==='string'&&((value as Record<string,unknown>).from===null||typeof (value as Record<string,unknown>).from==='string')&&((value as Record<string,unknown>).to===null||typeof (value as Record<string,unknown>).to==='string')):[];
 if((eventType==='crm.lead.followup'||eventType==='crm.contact.followup')&&row.mail_event_id)return {kind:'mail',direction:text(row.mail_direction),from:text(row.mail_from_email),method:'email',note:text(row.mail_subject)||text(row.mail_preview)};
 if(eventType==='crm.lead.followup'||eventType==='crm.contact.followup')return {kind:'followup',changes,stage:text(row.activity_stage),contactStatus:text(row.activity_contact_status),method:text(row.activity_method),note:text(row.activity_note)};
 if(eventType==='crm.contact.updated')return {kind:'fields',fields:Array.isArray(row.payload?.fields)?row.payload.fields.filter((value:unknown):value is string=>typeof value==='string'):[],changes};
 if(eventType===TASK_DUE_EVENT)return {kind:'task',title:text(row.task_title)};
 if(OPPORTUNITY_EVENT_TYPES.includes(eventType))return {kind:'opportunity',title:text(row.opportunity_title)};
 if(eventType.startsWith('crm.contact.assignment.'))return {kind:'assignment'};
 if(eventType.startsWith('crm.contact.share.'))return {kind:'share'};
 return {kind:'customer'};
}
export class PostgresNotificationRepository implements NotificationRepository{
 constructor(private readonly pool:Pool,private readonly log:LogSink){assertCenterDatabasePool(pool);}
 private async tx<T>(fn:(db:PoolClient)=>Promise<Result<T>>):Promise<Result<T>>{
  const db=await this.pool.connect();try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock($1)',[ADMIN_LOCK]);const r=await fn(db);await db.query(r.ok?'COMMIT':'ROLLBACK');return r;}catch(error){try{await db.query('ROLLBACK');}catch{this.log.write('ERROR','notifications.rollback','通知回滚失败');}const code=error&&typeof error==='object'&&'code'in error?String(error.code):'UNKNOWN',message=error instanceof Error?error.message:'unknown';this.log.write('ERROR','notifications.pg',`通知数据库操作失败 code=${code} message=${message}`);return failure('DATABASE_ERROR','通知服务暂不可用');}finally{db.release();}
 }
 async migrate(){return this.tx(async db=>{await db.query('SELECT pg_advisory_xact_lock($1)',[NOTIFICATION_LOCK]);const sum=createHash('sha256').update(NOTIFICATION_SQL).digest('hex');const old=await db.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[NOTIFICATION_VERSION]);if(old.rows.length&&old.rows[0].checksum!==sum)return failure('CONFLICT','通知迁移校验不一致');if(!old.rows.length){await db.query(NOTIFICATION_SQL);await db.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[NOTIFICATION_VERSION,sum]);}const nextSum=createHash('sha256').update(ASSIGNMENT_SQL).digest('hex');const next=await db.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[ASSIGNMENT_VERSION]);if(next.rows.length&&next.rows[0].checksum!==nextSum)return failure('CONFLICT','分配迁移校验不一致');if(!next.rows.length){await db.query(ASSIGNMENT_SQL);await db.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[ASSIGNMENT_VERSION,nextSum]);}return success(undefined);});}
 private async actor(db:PoolClient,hash:string):Promise<Result<Actor>>{
  const user=await db.query(`SELECT u.user_id,u.must_change_password FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) WHERE s.token_hash=$1 AND s.client='api' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND s.security_revision=u.security_revision FOR SHARE OF s,u`,[hash]);
  if(!user.rows.length)return failure('UNAUTHORIZED','会话已失效');if(user.rows[0].must_change_password)return failure('PASSWORD_CHANGE_REQUIRED','请先修改密码');
  const actor=await this.access(db,user.rows[0].user_id);return actor?success(actor):failure('FORBIDDEN','无CRM准入');
 }
 private async access(db:PoolClient,userId:string):Promise<Actor|null>{
  const access=await db.query("SELECT scope,capabilities FROM public.identity_product_access WHERE user_id=$1 AND product_id='crm' AND active FOR SHARE",[userId]);
  if(!access.rows.length)return null;
  const roles=await db.query("SELECT role FROM public.identity_product_grants WHERE user_id=$1 AND product_id='crm' AND active FOR SHARE",[userId]);
  const list=roles.rows.map(r=>r.role as CrmRole);if(!list.length)return null;
  const explicit=access.rows[0].capabilities as string[]|null;
  const capabilities=effectiveCapabilitiesFor(list,explicit);
  if(!capabilities.length)return null;
  return {userId,roles:list,scope:access.rows[0].scope,capabilities};
 }
 private async contactAccess(db:PoolClient,a:Actor,contactId:unknown,customerId:string):Promise<boolean>{
  if(!Number.isSafeInteger(contactId))return false;
  const row=await loadContactIn(db,{contactId:Number(contactId),customerId});return !!row&&canReadContact(a,row);
 }
 private async teamAttentionAccess(db:PoolClient,a:Actor,itemId:unknown):Promise<{canOpen:boolean;version:number;contactId:number|null;contactName:string|null}>{
  if(typeof itemId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(itemId))return {canOpen:false,version:0,contactId:null,contactName:null};
  const oversight=a.roles.includes('admin')||a.roles.includes('operations');
  const row=await db.query(`SELECT i.version,i.contact_id AS "contactId",COALESCE(NULLIF(concat_ws(' ',ct.first_name,ct.last_name),''),NULLIF(ct.email,''),'联系人') AS "contactName",
    ($2::boolean OR i.target_member_user_id=$1 OR EXISTS(
      SELECT 1 FROM crm_org_assignments target
      JOIN crm_org_units team ON team.unit_id=target.unit_id AND team.kind='sales_team'
      JOIN crm_org_assignments leader ON leader.unit_id=target.unit_id AND leader.role='leader'
      WHERE target.user_id=i.target_member_user_id AND target.role='member' AND leader.user_id=$1
    )) AS "canOpen"
    FROM crm_team_attention_items i JOIN contacts ct ON ct.id=i.contact_id WHERE i.item_id=$3`,[a.userId,oversight,itemId]);
  const value=row.rows[0];return {canOpen:value?.canOpen===true,version:Number(value?.version??0),contactId:Number.isSafeInteger(value?.contactId)?Number(value.contactId):null,contactName:typeof value?.contactName==='string'?value.contactName:null};
 }
 async watermark(hash:string):Promise<Result<string>>{return this.tx(async db=>{const a=await this.actor(db,hash);if(!a.ok)return a;const rows=await db.query('SELECT delivery_seq::text FROM crm_feed_heads WHERE user_id=$1',[a.data.userId]);return success(rows.rows[0]?.delivery_seq??'0');});}
 async feed(hash:string,q:FeedQuery):Promise<Result<FeedPage>>{return this.tx<FeedPage>(async db=>{
  const actor=await this.actor(db,hash);if(!actor.ok)return actor;const a=actor.data;
  const head=await db.query('SELECT delivery_seq::text FROM crm_feed_heads WHERE user_id=$1',[a.userId]);const high=head.rows[0]?.delivery_seq??'0';
  if(BigInt(q.after)>BigInt(high))return success({items:[],nextCursor:high,hasMore:false,resyncRequired:true});
  const after=q.latest?String(BigInt(high)>BigInt(NOTIFICATION_LIMITS.history)?BigInt(high)-BigInt(NOTIFICATION_LIMITS.history):0):q.after;
  const rows=await db.query(`WITH candidates AS MATERIALIZED (SELECT d.*,c.created_by,c.owner_user_id,c.origin,c.state,co.name AS company_name,o.recipient_user_ids,o.payload,u.display_name AS actor_name,
    act.note AS activity_note,act.stage AS activity_stage,act.method AS activity_method,act.contact_status AS activity_contact_status,act.opportunity_id AS activity_opportunity_id,
    mail.event_id AS mail_event_id,mail.message_key AS mail_message_key,mail.direction AS mail_direction,mail.subject AS mail_subject,mail.preview AS mail_preview,mail.from_email AS mail_from_email,
    op.opportunity_id AS projected_opportunity_id,op.title AS opportunity_title,task.title AS task_title,
    EXISTS(SELECT 1 FROM crm_notification_reads r WHERE r.user_id=$1 AND r.delivery_id=d.delivery_id) AS read
    FROM crm_event_deliveries d JOIN crm_customers c USING(customer_id) JOIN public.identity_outbox o ON o.event_id=d.event_id JOIN companies co ON co.id=c.company_id
    LEFT JOIN public.identity_users u ON u.user_id=o.user_id
    LEFT JOIN crm_shared_activities act ON act.customer_id=c.customer_id AND act.actor_id=o.user_id AND act.id::text=o.payload->>'activityId' AND o.event_type IN ('crm.lead.followup','crm.contact.followup')
    LEFT JOIN crm_contact_mail_events mail ON mail.event_id::text=o.payload->>'mailEventId' AND o.event_type IN ('crm.lead.followup','crm.contact.followup')
    LEFT JOIN crm_opportunities op ON op.customer_id=c.customer_id AND op.opportunity_id::text=COALESCE(act.opportunity_id::text,o.payload->>'opportunityId')
    LEFT JOIN crm_followup_tasks task ON task.task_id::text=o.payload->>'taskId'
    WHERE d.recipient_user_id=$1 AND d.delivery_seq>$2 AND d.delivery_seq<=$3 AND NOT(d.event_type=$5 AND o.user_id=$1)
    ORDER BY d.delivery_seq LIMIT $4 FOR SHARE OF c),
    deduped AS (SELECT candidates.*,ROW_NUMBER() OVER (PARTITION BY recipient_user_id,
      CASE WHEN mail_message_key IS NOT NULL THEN concat_ws(':',customer_id,payload->>'contactId',
        COALESCE(NULLIF(lower(regexp_replace(btrim(COALESCE(mail_subject,'')),'^((re|res|fw|fwd|aw|sv|回复|答复|回覆|转发|轉寄)[[:space:]]*[:：][[:space:]]*)+','', 'i')),''),mail_message_key))
      ELSE delivery_id::text END
      ORDER BY delivery_seq DESC) AS duplicate_rank FROM candidates)
    SELECT * FROM deduped WHERE duplicate_rank=1 ORDER BY delivery_seq`,[a.userId,after,high,NOTIFICATION_LIMITS.scanMax,SELF_CREATED_EVENT]);
  const items:Notification[]=[];let cursor=q.after;
  for(const r of rows.rows){cursor=String(r.delivery_seq);
   if(TEAM_ATTENTION_EVENT_TYPES.includes(r.event_type)){
    if(!r.recipient_user_ids?.includes(a.userId))continue;
    const itemId=typeof r.payload?.attentionItemId==='string'?r.payload.attentionItemId:'';
    const access=await this.teamAttentionAccess(db,a,itemId);
    items.push({
      id:r.delivery_id,eventType:r.event_type as Notification['eventType'],customerId:access.canOpen?r.customer_id:'',version:access.canOpen?access.version:0,
      canOpen:access.canOpen,cursor,createdAt:new Date(r.created_at).toISOString(),read:r.read,taskId:itemId||undefined,attentionItemId:itemId||undefined,
      change:notificationChange(r),
      ...(access.canOpen&&access.contactId?{contactId:access.contactId}:{}),
      ...(access.canOpen?{summary:{companyName:r.company_name,contactName:access.contactName,actorName:r.actor_name}}:{}),
    });
    if(items.length===q.limit)break;
    continue;
   }
   if(CONTACT_EVENTS.includes(r.event_type)){
    if(!r.recipient_user_ids?.includes(a.userId))continue;
    const contactAccess=await this.contactAccess(db,a,r.payload?.contactId,r.customer_id);
    const requestEvent=CONTACT_REQUEST_EVENTS.includes(r.event_type);
    if(!requestEvent&&!contactAccess)continue;
    const shareEvent=Object.values(CONTACT_SHARING_EVENTS).includes(r.event_type);
    const requestRow=requestEvent?(await db.query(shareEvent?'SELECT grantor_user_id AS actor_id,target_user_id,status FROM crm_contact_shares WHERE share_id=$1':'SELECT actor_id,target_user_id,supervisor_user_ids,status FROM crm_contact_assignment_requests WHERE request_id=$1',[shareEvent?r.payload.shareId:r.payload.requestId])).rows[0]:undefined;
    const monitorRecipient=!!requestRow&&!shareEvent&&requestRow.supervisor_user_ids?.includes(a.userId);
    const canOpen=requestEvent?shareEvent?!!requestRow&&([requestRow.actor_id,requestRow.target_user_id].includes(a.userId)||contactAccess):!!requestRow&&r.recipient_user_ids?.includes(a.userId):contactAccess;
    const customerId=canOpen?r.customer_id:'',version=canOpen?r.version:0;
    items.push({id:r.delivery_id,eventType:r.event_type,customerId,version,canOpen,cursor,createdAt:new Date(r.created_at).toISOString(),read:r.read,change:notificationChange(r),...(canOpen?{contactOpenMode:requestEvent?(shareEvent?'contact':monitorRecipient?'monitor':'assignment'):'contact'}:{}),...(requestEvent?shareEvent?{shareId:r.payload.shareId,shareStatus:requestRow?.status,shareTargetUserId:requestRow?.target_user_id}:{requestId:r.payload.requestId,assignmentStatus:requestRow?.status,...(typeof r.payload.groupId==='string'?{assignmentGroupId:r.payload.groupId}:{}),...(Number.isSafeInteger(r.payload.groupCount)?{assignmentGroupCount:r.payload.groupCount}:{})}:{}),...(contactAccess||requestEvent&&!shareEvent?{contactId:r.payload.contactId}:{}),...(r.mail_event_id?{mailEventId:String(r.mail_event_id)}:{}),...(r.mail_message_key?{mailMessageKey:String(r.mail_message_key)}:{}),summary:{companyName:r.company_name,actorName:r.actor_name,...(requestEvent?{contactName:r.payload.contactName}:{})}});
    if(items.length===q.limit)break;continue;
   }
   const assigned=r.event_type==='crm.lead.assigned'&&r.recipient_user_ids?.includes(a.userId);const overlap=r.event_type===DEAL_OVERLAP_EVENT&&r.recipient_user_ids?.includes(a.userId);const taskDue=r.event_type===TASK_DUE_EVENT;if(taskDue&&!await canProjectTaskDue(db,r,a))continue;if(taskDue||assigned||overlap||visible(a,r,r.event_type)){const canOpen=assigned?canReadLead(a,r):true;items.push({id:r.delivery_id,eventType:r.event_type,customerId:canOpen?r.customer_id:'',version:canOpen?r.version:0,canOpen,cursor,createdAt:new Date(r.created_at).toISOString(),read:r.read,change:notificationChange(r),...(taskDue?{taskId:r.payload.taskId}:{}),...(r.projected_opportunity_id&&canOpen?{opportunityId:r.projected_opportunity_id}:{}),...(r.mail_event_id?{mailEventId:String(r.mail_event_id)}:{}),...(r.mail_message_key?{mailMessageKey:String(r.mail_message_key)}:{}),...(canReadLead(a,r)||overlap?{summary:{companyName:r.company_name,actorName:r.actor_name,...(typeof r.activity_note==='string'?{note:r.activity_note.slice(0,SUMMARY_NOTE_MAX)}:OPPORTUNITY_EVENT_TYPES.includes(r.event_type)&&r.opportunity_title?{note:r.opportunity_title.slice(0,SUMMARY_NOTE_MAX)}:{})}}:{})});if(items.length===q.limit)break;}}
  if(!rows.rows.length||q.latest)cursor=high;
  await db.query(`INSERT INTO crm_device_cursors(user_id,device_id,cursor) VALUES($1,$2,$3) ON CONFLICT(user_id,device_id) DO UPDATE SET cursor=GREATEST(crm_device_cursors.cursor,excluded.cursor),updated_at=now()`,[a.userId,q.deviceId,cursor]);
  return success({items,nextCursor:cursor,hasMore:BigInt(cursor)<BigInt(high)});
 });}
 async read(hash:string,id:string):Promise<Result<void>>{return this.tx(async db=>{
  const actor=await this.actor(db,hash);if(!actor.ok)return actor;
  const rows=await db.query('SELECT c.*,d.event_type,o.recipient_user_ids,o.payload FROM crm_event_deliveries d JOIN crm_customers c USING(customer_id) JOIN public.identity_outbox o ON o.event_id=d.event_id WHERE d.delivery_id=$1 AND d.recipient_user_id=$2 FOR SHARE OF c',[id,actor.data.userId]);
  const row=rows.rows[0];if(!row)return failure('NOT_FOUND','通知不存在');
  if(row.event_type===TASK_DUE_EVENT&&!await canProjectTaskDue(db,row,actor.data))return failure('NOT_FOUND','提醒已失效');
  let allowed=false;
  if(TEAM_ATTENTION_EVENT_TYPES.includes(row.event_type))allowed=!!row.recipient_user_ids?.includes(actor.data.userId)&&(await this.teamAttentionAccess(db,actor.data,row.payload?.attentionItemId)).canOpen;
  else if(CONTACT_REQUEST_EVENTS.includes(row.event_type))allowed=!!row.recipient_user_ids?.includes(actor.data.userId);
  else if(CONTACT_EVENTS.includes(row.event_type))allowed=await this.contactAccess(db,actor.data,row.payload?.contactId,row.customer_id);
  else if(row.event_type==='crm.lead.assigned'||row.event_type===DEAL_OVERLAP_EVENT)allowed=!!row.recipient_user_ids?.includes(actor.data.userId);
  else allowed=visible(actor.data,row,row.event_type);
  if(!allowed)return failure('NOT_FOUND','通知不存在');
  await db.query('INSERT INTO crm_notification_reads(user_id,delivery_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.data.userId,id]);return success(undefined);
 });}
 async readAll(hash:string):Promise<Result<NotificationReadAllReceipt>>{return this.tx(async db=>{const actor=await this.actor(db,hash);if(!actor.ok)return actor;const result=await db.query(`INSERT INTO crm_notification_reads(user_id,delivery_id) SELECT $1,delivery_id FROM (SELECT delivery_id FROM crm_event_deliveries WHERE recipient_user_id=$1 ORDER BY delivery_seq DESC LIMIT $2) latest ON CONFLICT DO NOTHING`,[actor.data.userId,NOTIFICATION_LIMITS.history]);return success({marked:result.rowCount??0});});}
 async dispatch():Promise<Result<number>>{return this.tx(async db=>{
  // Serialize bounded consumers: recipient heads are always locked in stable user order.
  await db.query('SELECT pg_advisory_xact_lock($1)',[NOTIFICATION_LOCK]);
  const events=await db.query(`SELECT o.* FROM public.identity_outbox o WHERE NOT EXISTS(SELECT 1 FROM crm_notification_consumed x WHERE x.event_id=o.event_id) ORDER BY o.created_at,o.event_id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,[NOTIFICATION_LIMITS.dispatchBatch]);
  const recipients=await db.query('SELECT user_id FROM public.identity_users WHERE active AND NOT must_change_password ORDER BY user_id FOR SHARE');let count=0;
  for(const event of events.rows){
   if(event.product_id==='crm'&&['crm.customer.created','crm.lead.published','crm.lead.claimed','crm.lead.followup','crm.lead.assigned',DEAL_OVERLAP_EVENT,TASK_DUE_EVENT,...OPPORTUNITY_EVENT_TYPES,...CONTACT_EVENTS,...TEAM_ATTENTION_EVENT_TYPES].includes(event.event_type)&&event.customer_id){
    const customer=await db.query('SELECT * FROM crm_customers WHERE customer_id=$1 FOR SHARE',[event.customer_id]);
    if(customer.rows.length)for(const user of recipients.rows){if(event.event_type===SELF_CREATED_EVENT&&event.user_id===user.user_id)continue;if([TASK_DUE_EVENT,'crm.lead.assigned',DEAL_OVERLAP_EVENT,...CONTACT_EVENTS,...TEAM_ATTENTION_EVENT_TYPES].includes(event.event_type)&&!event.recipient_user_ids?.includes(user.user_id))continue;const a=await this.access(db,user.user_id);if(!a)continue;if(event.event_type===TASK_DUE_EVENT){if(!await canProjectTaskDue(db,event,a))continue;}else if(CONTACT_EVENTS.includes(event.event_type)){if(!CONTACT_REQUEST_EVENTS.includes(event.event_type)&&!await this.contactAccess(db,a,event.payload?.contactId,event.customer_id))continue;}else if(TEAM_ATTENTION_EVENT_TYPES.includes(event.event_type)){if(!(await this.teamAttentionAccess(db,a,event.payload?.attentionItemId)).canOpen)continue;}else if(event.event_type!=='crm.lead.assigned'&&event.event_type!==DEAL_OVERLAP_EVENT&&!visible(a,customer.rows[0],event.event_type))continue;
     const old=await db.query("SELECT 1 FROM crm_event_deliveries WHERE event_id=$1 AND recipient_user_id=$2 AND projection_type='lead'",[event.event_id,a.userId]);if(old.rows.length)continue;
     await db.query('INSERT INTO crm_feed_heads(user_id) VALUES($1) ON CONFLICT DO NOTHING',[a.userId]);
     const head=await db.query('UPDATE crm_feed_heads SET delivery_seq=delivery_seq+1 WHERE user_id=$1 RETURNING delivery_seq',[a.userId]);
     await db.query("INSERT INTO crm_event_deliveries(event_id,recipient_user_id,projection_type,delivery_seq,customer_id,event_type,version) VALUES($1,$2,'lead',$3,$4,$5,$6)",[event.event_id,a.userId,head.rows[0].delivery_seq,event.customer_id,event.event_type,Number.isSafeInteger(event.payload?.version)?event.payload.version:event.revision]);count++;
    }
   }
   // Management events have no CRM projection and are consumed without exposing their payload.
   await db.query('INSERT INTO crm_notification_consumed(event_id) VALUES($1) ON CONFLICT DO NOTHING',[event.event_id]);
  }
  await db.query(`DELETE FROM crm_notification_reads r USING crm_event_deliveries d,crm_feed_heads h WHERE r.delivery_id=d.delivery_id AND d.recipient_user_id=h.user_id AND d.delivery_seq<=GREATEST(h.delivery_seq-$1,0)`,[NOTIFICATION_LIMITS.history]);
  await db.query(`DELETE FROM crm_event_deliveries d USING crm_feed_heads h WHERE d.recipient_user_id=h.user_id AND d.delivery_seq<=GREATEST(h.delivery_seq-$1,0)`,[NOTIFICATION_LIMITS.history]);
  return success(count);
 });}
}
