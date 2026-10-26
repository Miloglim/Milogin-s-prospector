import {CONTACT_SHARING_EVENTS} from '../../core/contact-sharing';
import {loadContactIn,canReadContact} from './contact-assignment-repository';
import {createHash} from 'node:crypto';
import {CONTACT_ASSIGNMENT_EVENTS} from '../../core/contact-assignments';
const CONTACT_EVENTS:string[]=[...Object.values(CONTACT_ASSIGNMENT_EVENTS),...Object.values(CONTACT_SHARING_EVENTS)];
const CONTACT_REQUEST_EVENTS:string[]=[CONTACT_ASSIGNMENT_EVENTS.requested,CONTACT_ASSIGNMENT_EVENTS.accepted,CONTACT_ASSIGNMENT_EVENTS.rejected,CONTACT_ASSIGNMENT_EVENTS.cancelled,...Object.values(CONTACT_SHARING_EVENTS)];
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
const OPPORTUNITY_EVENT_TYPES:string[]=Object.values(OPPORTUNITY_EVENTS);
import { canProjectTaskDue } from './task-repository';
const SUMMARY_NOTE_MAX=160;
type Actor={userId:string;roles:CrmRole[];capabilities:string[];scope:DataScope};
type Customer={customer_id:string;created_by:string;owner_user_id:string|null;origin:string;state:string};
function visible(a:Actor,c:Customer,eventType:string){
 if(a.roles.includes('admin')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('leads.read.all'))return true;
 if(eventType==='crm.lead.followup'||OPPORTUNITY_EVENT_TYPES.includes(eventType)){return c.origin==='operations'&&a.roles.includes('operations')&&a.capabilities.includes('followups.read')&&['shared','summary'].includes(a.scope)||c.owner_user_id===a.userId&&a.capabilities.includes('leads.develop');}
 const ops=c.origin==='operations'&&a.roles.includes('operations')&&a.capabilities.some(v=>['leads.import','leads.publish','followups.read'].includes(v))&&(a.scope==='shared'||a.scope==='summary');
 const sales=(c.state==='published'&&a.capabilities.includes('leads.claim'))||(c.owner_user_id===a.userId&&a.capabilities.includes('leads.develop'));
 return ops||sales;
}
export class PostgresNotificationRepository implements NotificationRepository{
 constructor(private readonly pool:Pool,private readonly log:LogSink){assertCenterDatabasePool(pool);}
 private async tx<T>(fn:(db:PoolClient)=>Promise<Result<T>>):Promise<Result<T>>{
  const db=await this.pool.connect();try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock($1)',[ADMIN_LOCK]);const r=await fn(db);await db.query(r.ok?'COMMIT':'ROLLBACK');return r;}catch(e){try{await db.query('ROLLBACK');}catch{this.log.write('ERROR','notifications.rollback','通知回滚失败');}this.log.write('ERROR','notifications.pg','通知数据库操作失败');return failure('DATABASE_ERROR','通知服务暂不可用');}finally{db.release();}
 }
 async migrate(){return this.tx(async db=>{await db.query('SELECT pg_advisory_xact_lock($1)',[NOTIFICATION_LOCK]);const sum=createHash('sha256').update(NOTIFICATION_SQL).digest('hex');const old=await db.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[NOTIFICATION_VERSION]);if(old.rows.length&&old.rows[0].checksum!==sum)return failure('CONFLICT','通知迁移校验不一致');if(!old.rows.length){await db.query(NOTIFICATION_SQL);await db.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[NOTIFICATION_VERSION,sum]);}const nextSum=createHash('sha256').update(ASSIGNMENT_SQL).digest('hex');const next=await db.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[ASSIGNMENT_VERSION]);if(next.rows.length&&next.rows[0].checksum!==nextSum)return failure('CONFLICT','分配迁移校验不一致');if(!next.rows.length){await db.query(ASSIGNMENT_SQL);await db.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[ASSIGNMENT_VERSION,nextSum]);}return success(undefined);});}
 private async actor(db:PoolClient,hash:string):Promise<Result<Actor>>{
  const user=await db.query(`SELECT u.user_id,u.must_change_password FROM identity.sessions s JOIN identity.users u USING(user_id) WHERE s.token_hash=$1 AND s.client='api' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND s.security_revision=u.security_revision FOR SHARE OF s,u`,[hash]);
  if(!user.rows.length)return failure('UNAUTHORIZED','会话已失效');if(user.rows[0].must_change_password)return failure('PASSWORD_CHANGE_REQUIRED','请先修改密码');
  const actor=await this.access(db,user.rows[0].user_id);return actor?success(actor):failure('FORBIDDEN','无CRM准入');
 }
 private async access(db:PoolClient,userId:string):Promise<Actor|null>{
  const access=await db.query("SELECT scope,capabilities FROM identity.product_access WHERE user_id=$1 AND product_id='crm' AND active FOR SHARE",[userId]);
  if(!access.rows.length)return null;
  const roles=await db.query("SELECT role FROM identity.product_grants WHERE user_id=$1 AND product_id='crm' AND active FOR SHARE",[userId]);
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
 async watermark(hash:string):Promise<Result<string>>{return this.tx(async db=>{const a=await this.actor(db,hash);if(!a.ok)return a;const rows=await db.query('SELECT delivery_seq::text FROM crm_feed_heads WHERE user_id=$1',[a.data.userId]);return success(rows.rows[0]?.delivery_seq??'0');});}
 async feed(hash:string,q:FeedQuery):Promise<Result<FeedPage>>{return this.tx<FeedPage>(async db=>{
  const actor=await this.actor(db,hash);if(!actor.ok)return actor;const a=actor.data;
  const head=await db.query('SELECT delivery_seq::text FROM crm_feed_heads WHERE user_id=$1',[a.userId]);const high=head.rows[0]?.delivery_seq??'0';
  if(BigInt(q.after)>BigInt(high))return success({items:[],nextCursor:high,hasMore:false,resyncRequired:true});
  const rows=await db.query(`SELECT d.*,c.created_by,c.owner_user_id,c.origin,c.state,co.name AS company_name,o.recipient_user_ids,o.payload,u.display_name AS actor_name,act.note AS activity_note,act.opportunity_id AS activity_opportunity_id,op.opportunity_id AS projected_opportunity_id,op.title AS opportunity_title,EXISTS(SELECT 1 FROM crm_notification_reads r WHERE r.user_id=$1 AND r.delivery_id=d.delivery_id) AS read FROM crm_event_deliveries d JOIN crm_customers c USING(customer_id) JOIN identity.outbox o ON o.event_id=d.event_id JOIN companies co ON co.id=c.company_id LEFT JOIN identity.users u ON u.user_id=o.user_id LEFT JOIN crm_shared_activities act ON act.customer_id=c.customer_id AND act.actor_id=o.user_id AND act.id::text=o.payload->>'activityId' AND o.event_type='crm.lead.followup' LEFT JOIN crm_opportunities op ON op.customer_id=c.customer_id AND op.opportunity_id::text=COALESCE(act.opportunity_id::text,o.payload->>'opportunityId') WHERE d.recipient_user_id=$1 AND d.delivery_seq>$2 AND d.delivery_seq<=$3 ORDER BY d.delivery_seq LIMIT $4 FOR SHARE OF c`,[a.userId,q.after,high,NOTIFICATION_LIMITS.scanMax]);
  const items:Notification[]=[];let cursor=q.after;
  for(const r of rows.rows){cursor=String(r.delivery_seq);
   if(CONTACT_EVENTS.includes(r.event_type)){
    if(!r.recipient_user_ids?.includes(a.userId))continue;
    const contactAccess=await this.contactAccess(db,a,r.payload?.contactId,r.customer_id);
    const requestEvent=CONTACT_REQUEST_EVENTS.includes(r.event_type);
    if(!requestEvent&&!contactAccess)continue;
    const shareEvent=Object.values(CONTACT_SHARING_EVENTS).includes(r.event_type);
    const requestRow=requestEvent?(await db.query(shareEvent?'SELECT grantor_user_id AS actor_id,target_user_id,status FROM crm_contact_shares WHERE share_id=$1':'SELECT actor_id,target_user_id,status FROM crm_contact_assignment_requests WHERE request_id=$1',[shareEvent?r.payload.shareId:r.payload.requestId])).rows[0]:undefined;
    const canOpen=requestEvent?!!requestRow&&([requestRow.actor_id,requestRow.target_user_id].includes(a.userId)||shareEvent&&contactAccess):contactAccess;
    items.push({id:r.delivery_id,eventType:r.event_type,customerId:contactAccess?r.customer_id:'',version:contactAccess?r.version:0,canOpen,cursor,createdAt:new Date(r.created_at).toISOString(),read:r.read,...(requestEvent?shareEvent?{shareId:r.payload.shareId,shareStatus:requestRow?.status,shareTargetUserId:requestRow?.target_user_id}:{requestId:r.payload.requestId,assignmentStatus:requestRow?.status}:{}),...(contactAccess?{contactId:r.payload.contactId}:{}),summary:{companyName:r.company_name,actorName:r.actor_name,...(requestEvent?{contactName:r.payload.contactName}:{})}});
    if(items.length===q.limit)break;continue;
   }
   const assigned=r.event_type==='crm.lead.assigned'&&r.recipient_user_ids?.includes(a.userId);const taskDue=r.event_type===TASK_DUE_EVENT;if(taskDue&&!await canProjectTaskDue(db,r,a))continue;if(taskDue||assigned||visible(a,r,r.event_type)){const canOpen=assigned?canReadLead(a,r):true;items.push({id:r.delivery_id,eventType:r.event_type,customerId:canOpen?r.customer_id:'',version:canOpen?r.version:0,canOpen,cursor,createdAt:new Date(r.created_at).toISOString(),read:r.read,...(taskDue?{taskId:r.payload.taskId}:{}),...(r.projected_opportunity_id&&canOpen?{opportunityId:r.projected_opportunity_id}:{}),...(canReadLead(a,r)?{summary:{companyName:r.company_name,actorName:r.actor_name,...(typeof r.activity_note==='string'?{note:r.activity_note.slice(0,SUMMARY_NOTE_MAX)}:OPPORTUNITY_EVENT_TYPES.includes(r.event_type)&&r.opportunity_title?{note:r.opportunity_title.slice(0,SUMMARY_NOTE_MAX)}:{})}}:{})});if(items.length===q.limit)break;}}
  if(!rows.rows.length)cursor=high;
  await db.query(`INSERT INTO crm_device_cursors(user_id,device_id,cursor) VALUES($1,$2,$3) ON CONFLICT(user_id,device_id) DO UPDATE SET cursor=GREATEST(crm_device_cursors.cursor,excluded.cursor),updated_at=now()`,[a.userId,q.deviceId,cursor]);
  return success({items,nextCursor:cursor,hasMore:BigInt(cursor)<BigInt(high)});
 });}
 async read(hash:string,id:string):Promise<Result<void>>{return this.tx(async db=>{const actor=await this.actor(db,hash);if(!actor.ok)return actor;const rows=await db.query('SELECT c.*,d.event_type,o.recipient_user_ids,o.payload FROM crm_event_deliveries d JOIN crm_customers c USING(customer_id) JOIN identity.outbox o ON o.event_id=d.event_id WHERE d.delivery_id=$1 AND d.recipient_user_id=$2 FOR SHARE OF c',[id,actor.data.userId]);if(rows.rows[0]?.event_type===TASK_DUE_EVENT&&!await canProjectTaskDue(db,rows.rows[0],actor.data))return failure('NOT_FOUND','提醒已失效');if(!rows.rows.length||!(CONTACT_REQUEST_EVENTS.includes(rows.rows[0].event_type)&&rows.rows[0].recipient_user_ids?.includes(actor.data.userId))&&!(CONTACT_EVENTS.includes(rows.rows[0].event_type)&&await this.contactAccess(db,actor.data,rows.rows[0].payload?.contactId,rows.rows[0].customer_id))&&!(rows.rows[0].event_type==='crm.lead.assigned'&&rows.rows[0].recipient_user_ids?.includes(actor.data.userId))&&!visible(actor.data,rows.rows[0],rows.rows[0].event_type))return failure('NOT_FOUND','通知不存在');await db.query('INSERT INTO crm_notification_reads(user_id,delivery_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[actor.data.userId,id]);return success(undefined);});}
 async readAll(hash:string):Promise<Result<NotificationReadAllReceipt>>{return this.tx(async db=>{const actor=await this.actor(db,hash);if(!actor.ok)return actor;const result=await db.query('INSERT INTO crm_notification_reads(user_id,delivery_id) SELECT recipient_user_id,delivery_id FROM crm_event_deliveries WHERE recipient_user_id=$1 ON CONFLICT DO NOTHING',[actor.data.userId]);return success({marked:result.rowCount??0});});}
 async dispatch():Promise<Result<number>>{return this.tx(async db=>{
  // Serialize bounded consumers: recipient heads are always locked in stable user order.
  await db.query('SELECT pg_advisory_xact_lock($1)',[NOTIFICATION_LOCK]);
  const events=await db.query(`SELECT o.* FROM identity.outbox o WHERE NOT EXISTS(SELECT 1 FROM crm_notification_consumed x WHERE x.event_id=o.event_id) ORDER BY o.created_at,o.event_id LIMIT $1 FOR UPDATE OF o SKIP LOCKED`,[NOTIFICATION_LIMITS.dispatchBatch]);
  const recipients=await db.query('SELECT user_id FROM identity.users WHERE active AND NOT must_change_password ORDER BY user_id FOR SHARE');let count=0;
  for(const event of events.rows){
   if(event.product_id==='crm'&&['crm.customer.created','crm.lead.published','crm.lead.claimed','crm.lead.followup','crm.lead.assigned',TASK_DUE_EVENT,...OPPORTUNITY_EVENT_TYPES,...CONTACT_EVENTS].includes(event.event_type)&&event.customer_id){
    const customer=await db.query('SELECT * FROM crm_customers WHERE customer_id=$1 FOR SHARE',[event.customer_id]);
    if(customer.rows.length)for(const user of recipients.rows){if([TASK_DUE_EVENT,'crm.lead.assigned',...CONTACT_EVENTS].includes(event.event_type)&&!event.recipient_user_ids?.includes(user.user_id))continue;const a=await this.access(db,user.user_id);if(!a)continue;if(event.event_type===TASK_DUE_EVENT){if(!await canProjectTaskDue(db,event,a))continue;}else if(CONTACT_EVENTS.includes(event.event_type)){if(!CONTACT_REQUEST_EVENTS.includes(event.event_type)&&!await this.contactAccess(db,a,event.payload?.contactId,event.customer_id))continue;}else if(event.event_type!=='crm.lead.assigned'&&!visible(a,customer.rows[0],event.event_type))continue;
     const old=await db.query("SELECT 1 FROM crm_event_deliveries WHERE event_id=$1 AND recipient_user_id=$2 AND projection_type='lead'",[event.event_id,a.userId]);if(old.rows.length)continue;
     await db.query('INSERT INTO crm_feed_heads(user_id) VALUES($1) ON CONFLICT DO NOTHING',[a.userId]);
     const head=await db.query('UPDATE crm_feed_heads SET delivery_seq=delivery_seq+1 WHERE user_id=$1 RETURNING delivery_seq',[a.userId]);
     await db.query("INSERT INTO crm_event_deliveries(event_id,recipient_user_id,projection_type,delivery_seq,customer_id,event_type,version) VALUES($1,$2,'lead',$3,$4,$5,$6)",[event.event_id,a.userId,head.rows[0].delivery_seq,event.customer_id,event.event_type,Number.isSafeInteger(event.payload?.version)?event.payload.version:event.revision]);count++;
    }
   }
   // Management events have no CRM projection and are consumed without exposing their payload.
   await db.query('INSERT INTO crm_notification_consumed(event_id) VALUES($1) ON CONFLICT DO NOTHING',[event.event_id]);
  }
  return success(count);
 });}
}
