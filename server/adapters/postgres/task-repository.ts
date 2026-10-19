import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import { effectiveCapabilitiesFor, type DataScope } from '../../core/admin';
import type { CrmRole } from '../../core/auth';
import type { FollowupTask, TaskComplete, TaskCreate, TaskPage, TaskQuery, TaskRepository, TaskReschedule } from '../../core/tasks';
import { TASK_DUE_EVENT } from '../../core/tasks';
import { ADMIN_LOCK } from './admin-schema';
import { assertCenterDatabasePool } from './config';
import { TASK_LOCK, TASK_SQL, TASK_VERSION } from './task-schema';

interface Actor { userId:string; roles:CrmRole[]; capabilities:string[]; scope:DataScope; }
type Customer={customer_id:string;created_by:string;owner_user_id:string|null;origin:string;state:string;version:number};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function administrator(a:Actor){return a.roles.includes('admin')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('leads.read.all');}
function operations(a:Actor){return a.roles.includes('operations')&&['shared','summary'].includes(a.scope)&&a.capabilities.includes('followups.read');}
function canSee(a:Actor,c:Customer){return administrator(a)||operations(a)&&c.origin==='operations'||c.owner_user_id===a.userId&&a.capabilities.includes('leads.develop');}
function canManage(a:Actor,c:Customer){return a.capabilities.includes('leads.develop')&&(administrator(a)||operations(a)&&c.origin==='operations'&&c.owner_user_id===null||c.owner_user_id===a.userId&&canSee(a,c));}
async function access(db:PoolClient,userId:string):Promise<Actor|null>{
 const r=await db.query(`SELECT u.user_id,a.scope,a.capabilities,ARRAY(SELECT g.role FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active) AS roles FROM identity.users u JOIN identity.product_access a ON a.user_id=u.user_id AND a.product_id='crm' AND a.active WHERE u.user_id=$1 AND u.active AND NOT u.must_change_password`,[userId]);
 if(!r.rows.length)return null;
 const row=r.rows[0],roles=row.roles as CrmRole[];if(!roles.length)return null;
 return {userId:row.user_id,roles,scope:row.scope,capabilities:effectiveCapabilitiesFor(roles,row.capabilities)};
}
/** Validate current scope and revision for dispatch, unread feed and read acknowledgments. */
export async function canProjectTaskDue(db:PoolClient,event:{customer_id?:string;payload?:Record<string,unknown>;recipient_user_ids?:string[]|null},a:Actor):Promise<boolean>{
 const p=event.payload;
 if(!p||typeof p.taskId!=='string'||!UUID.test(p.taskId)||!Number.isSafeInteger(p.taskVersion)||typeof p.dueAt!=='string'||typeof p.responsibleUserId!=='string'||!event.recipient_user_ids?.includes(a.userId))return false;
 const r=await db.query(`SELECT c.*,t.version AS task_version,t.due_at,t.status,COALESCE(c.owner_user_id,c.created_by) AS responsible_user_id FROM crm_followup_tasks t JOIN crm_customers c USING(customer_id) WHERE t.task_id=$1 AND c.customer_id=$2 AND t.due_at<=clock_timestamp()`,[p.taskId,event.customer_id]);
 const row=r.rows[0];if(!row||row.status!=='open'||row.task_version!==p.taskVersion||new Date(row.due_at).toISOString()!==p.dueAt||row.responsible_user_id!==p.responsibleUserId||row.responsible_user_id!==a.userId)return false;
 const current=await access(db,a.userId);return !!current&&canManage(current,row);
}
const COLUMNS=`t.opportunity_id AS "opportunityId",(SELECT op.title FROM crm_opportunities op WHERE op.opportunity_id=t.opportunity_id AND op.customer_id=t.customer_id) AS "opportunityTitle",t.task_id AS "taskId",t.customer_id AS "customerId",t.title,t.due_at AS "dueAt",t.status,t.version,t.created_by AS "createdBy",t.created_at AS "createdAt",t.updated_at AS "updatedAt",t.completed_at AS "completedAt",t.completed_by AS "completedBy",t.feedback,COALESCE(c.owner_user_id,c.created_by) AS "responsibleUserId",u.display_name AS "responsibleName"`;
function taskRow(r:Record<string,unknown>,manage:boolean):FollowupTask {
 return {...r,dueAt:(r.dueAt as Date).toISOString(),createdAt:(r.createdAt as Date).toISOString(),updatedAt:(r.updatedAt as Date).toISOString(),completedAt:r.completedAt instanceof Date?r.completedAt.toISOString():null,canManage:manage} as FollowupTask;
}
export class PostgresTaskRepository implements TaskRepository {
 constructor(private readonly pool:Pool,private readonly log:LogSink){assertCenterDatabasePool(pool);}
 private async tx<T>(fn:(db:PoolClient)=>Promise<Result<T>>):Promise<Result<T>>{
  let db:PoolClient|undefined;
  try{db=await this.pool.connect();await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock($1)',[ADMIN_LOCK]);await db.query('SELECT pg_advisory_xact_lock($1)',[TASK_LOCK]);const result=await fn(db);await db.query(result.ok?'COMMIT':'ROLLBACK');return result;}
  catch(error){if(db)try{await db.query('ROLLBACK');}catch(rollbackError){this.log.write('ERROR','tasks.rollback',`任务回滚失败 ${rollbackError instanceof Error?rollbackError.stack??rollbackError.message:'UNKNOWN'}`);}this.log.write('ERROR','tasks.pg',`任务数据库操作失败 code=${error&&typeof error==='object'&&'code'in error?String(error.code):'UNKNOWN'} ${error instanceof Error?error.stack??error.message:'UNKNOWN'}`);return failure('DATABASE_ERROR','任务服务暂不可用');}
  finally{db?.release();}
 }
 private async actor(db:PoolClient,hash:string):Promise<Actor|null>{
  const u=await db.query(`SELECT u.user_id FROM identity.sessions s JOIN identity.users u USING(user_id) WHERE s.token_hash=$1 AND s.client='api' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND NOT u.must_change_password AND s.security_revision=u.security_revision`,[hash]);
  return u.rows.length?access(db,u.rows[0].user_id):null;
 }
 private async authorized<T>(hash:string,fn:(db:PoolClient,a:Actor)=>Promise<Result<T>>){return this.tx(async db=>{const a=await this.actor(db,hash);return a?fn(db,a):failure('UNAUTHORIZED','CRM会话或产品准入已失效');});}
 private async customer(db:PoolClient,id:string){const r=await db.query('SELECT customer_id,created_by,owner_user_id,origin,state,version FROM crm_customers WHERE customer_id=$1 FOR SHARE',[id]);return r.rows[0] as Customer|undefined;}
 private async one(db:PoolClient,id:string,a:Actor,lock=false):Promise<Result<FollowupTask>>{
  const r=await db.query(`SELECT ${COLUMNS} FROM crm_followup_tasks t JOIN crm_customers c USING(customer_id) JOIN identity.users u ON u.user_id=COALESCE(c.owner_user_id,c.created_by) WHERE t.task_id=$1 ${lock?'FOR UPDATE OF t':''}`,[id]);
  if(!r.rows.length)return failure('NOT_FOUND','任务不存在');const c=await this.customer(db,r.rows[0].customerId);if(!c||!canSee(a,c))return failure('NOT_FOUND','任务不存在');return success(taskRow(r.rows[0],canManage(a,c)));
 }
 private async cached(db:PoolClient,a:Actor,operation:string,input:{idempotencyKey:string},fn:()=>Promise<Result<FollowupTask>>):Promise<Result<FollowupTask>>{
  const digest=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const old=await db.query('SELECT digest,response FROM crm_lead_idempotency WHERE actor_id=$1 AND operation=$2 AND key=$3',[a.userId,operation,input.idempotencyKey]);
  if(old.rows.length){if(old.rows[0].digest!==digest)return failure('CONFLICT','幂等键已用于不同请求');return this.one(db,old.rows[0].response.taskId,a);}
  const result=await fn();if(result.ok)await db.query('INSERT INTO crm_lead_idempotency(actor_id,operation,key,digest,response) VALUES($1,$2,$3,$4,$5)',[a.userId,operation,input.idempotencyKey,digest,JSON.stringify({taskId:result.data.taskId})]);return result;
 }
 async migrate(){return this.tx(async db=>{const old=await db.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[TASK_VERSION]);const hash=createHash('sha256').update(TASK_SQL).digest('hex');if(old.rows.length&&old.rows[0].checksum!==hash)return failure('CONFLICT','任务迁移校验不一致');if(!old.rows.length){await db.query(TASK_SQL);await db.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[TASK_VERSION,hash]);}return success(undefined);});}
 create(hash:string,input:TaskCreate){return this.authorized(hash,async(db,a)=>{
  const c=await this.customer(db,input.customerId);if(!c||!canSee(a,c))return failure('NOT_FOUND','客户不存在');if(!canManage(a,c))return failure('FORBIDDEN','只能处理自身任务');
  return this.cached(db,a,`task:create:${input.customerId}`,input,async()=>{
   if(c.version!==input.expectedCustomerVersion)return failure('CONFLICT','客户版本已变化');
   if(input.opportunityId){const opportunity=await db.query('SELECT opportunity_id FROM crm_opportunities WHERE opportunity_id=$1 AND customer_id=$2',[input.opportunityId,input.customerId]);if(!opportunity.rows.length)return failure('INVALID_INPUT','商机不属于当前客户');}
   const responsible=c.owner_user_id??c.created_by,member=await access(db,responsible);if(!member||!canManage(member,c))return failure('CONFLICT','任务负责人已停用或无开发权限');
   const r=await db.query(`INSERT INTO crm_followup_tasks(customer_id,title,due_at,created_by,opportunity_id) VALUES($1,$2,$3,$4,$5) RETURNING task_id`,[input.customerId,input.title.trim(),input.dueAt,a.userId,input.opportunityId??null]);return this.one(db,r.rows[0].task_id,a);
  });
 });}
 list(hash:string,input:TaskQuery){return this.authorized(hash,async(db,a)=>{
  const owner=a.capabilities.includes('leads.develop'),ops=operations(a);
  const visibility=administrator(a)?'($1::uuid IS NOT NULL)':ops?`(c.origin='operations'${owner?' OR c.owner_user_id=$1':''})`:owner?'c.owner_user_id=$1':'FALSE AND $1::uuid IS NOT NULL';
  const filter=`WHERE (${visibility}) AND ($2::uuid IS NULL OR c.customer_id=$2) AND ($3::text IS NULL OR t.status=$3)`;
  const params=[a.userId,input.customerId??null,input.status??null];
  const count=await db.query(`SELECT count(*)::int AS n FROM crm_followup_tasks t JOIN crm_customers c USING(customer_id) ${filter}`,params);
  const rows=await db.query(`SELECT ${COLUMNS},c.created_by,c.owner_user_id,c.origin,c.state FROM crm_followup_tasks t JOIN crm_customers c USING(customer_id) JOIN identity.users u ON u.user_id=COALESCE(c.owner_user_id,c.created_by) ${filter} ORDER BY CASE WHEN t.status='open' THEN 0 ELSE 1 END,t.due_at,t.task_id LIMIT $4 OFFSET $5`,[...params,input.limit,input.offset]);
  return success({items:rows.rows.map(r=>{const manage=canManage(a,r);delete r.created_by;delete r.owner_user_id;delete r.origin;delete r.state;return taskRow(r,manage);}),total:count.rows[0].n} as TaskPage);
 });}
 detail(hash:string,id:string){return this.authorized(hash,(db,a)=>this.one(db,id,a));}
 reschedule(hash:string,input:TaskReschedule){return this.authorized(hash,async(db,a)=>{
  const existing=await this.one(db,input.taskId,a,true);if(!existing.ok)return existing;if(!existing.data.canManage)return failure('FORBIDDEN','只能处理自身任务');
  return this.cached(db,a,`task:reschedule:${input.taskId}`,input,async()=>{
   const r=await db.query(`UPDATE crm_followup_tasks SET due_at=$2,version=version+1,updated_at=clock_timestamp() WHERE task_id=$1 AND status='open' AND version=$3 RETURNING task_id`,[input.taskId,input.dueAt,input.expectedVersion]);if(!r.rows.length)return failure('CONFLICT','任务已完成或版本已变化');return this.one(db,input.taskId,a);
  });
 });}
 complete(hash:string,input:TaskComplete){return this.authorized(hash,async(db,a)=>{
  const existing=await this.one(db,input.taskId,a,true);if(!existing.ok)return existing;if(!existing.data.canManage)return failure('FORBIDDEN','只能处理自身任务');
  return this.cached(db,a,`task:complete:${input.taskId}`,input,async()=>{
   const r=await db.query(`UPDATE crm_followup_tasks SET status='completed',feedback=$2,completed_at=clock_timestamp(),completed_by=$3,version=version+1,updated_at=clock_timestamp() WHERE task_id=$1 AND status='open' AND version=$4 RETURNING task_id`,[input.taskId,input.feedback.trim(),a.userId,input.expectedVersion]);if(!r.rows.length)return failure('CONFLICT','任务已完成或版本已变化');return this.one(db,input.taskId,a);
  });
 });}
 async processDue(limit:number){return this.tx(async db=>{
  // Filter effective responsible access before LIMIT so revoked accounts cannot starve live due work.
  const rows=await db.query(`SELECT t.task_id,t.customer_id,t.opportunity_id,t.version,t.due_at,c.version AS customer_version,COALESCE(c.owner_user_id,c.created_by) AS responsible_user_id FROM crm_followup_tasks t JOIN crm_customers c USING(customer_id) JOIN identity.users u ON u.user_id=COALESCE(c.owner_user_id,c.created_by) JOIN identity.product_access a ON a.user_id=u.user_id AND a.product_id='crm' AND a.active WHERE t.status='open' AND t.due_at<=clock_timestamp() AND u.active AND NOT u.must_change_password AND EXISTS(SELECT 1 FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active AND g.role IN ('admin','operations','sales')) AND (a.capabilities IS NULL OR a.capabilities ? 'leads.develop') AND (c.owner_user_id=u.user_id OR c.owner_user_id IS NULL AND a.scope IN ('shared','summary') AND EXISTS(SELECT 1 FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active AND (g.role='admin' AND (a.capabilities IS NULL OR a.capabilities ? 'leads.read.all') OR g.role='operations' AND (a.capabilities IS NULL OR a.capabilities ? 'followups.read')))) AND NOT EXISTS(SELECT 1 FROM crm_task_due_receipts d WHERE d.task_id=t.task_id AND d.task_version=t.version) ORDER BY t.due_at,t.task_id LIMIT $1 FOR UPDATE OF t SKIP LOCKED`,[limit]);
  let count=0;
  for(const r of rows.rows){const c=await this.customer(db,r.customer_id),member=await access(db,r.responsible_user_id);if(!c||!member||!canManage(member,c))continue;
   const event=await db.query(`INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,'crm',$3,$4,$5,$6::uuid[]) RETURNING event_id`,[TASK_DUE_EVENT,r.responsible_user_id,r.version,r.customer_id,JSON.stringify({customerId:r.customer_id,version:r.customer_version,taskId:r.task_id,...(r.opportunity_id?{opportunityId:r.opportunity_id}:{}),taskVersion:r.version,dueAt:new Date(r.due_at).toISOString(),responsibleUserId:r.responsible_user_id}),[r.responsible_user_id]]);
   await db.query('INSERT INTO crm_task_due_receipts(task_id,task_version,responsible_user_id,event_id) VALUES($1,$2,$3,$4)',[r.task_id,r.version,r.responsible_user_id,event.rows[0].event_id]);count++;
  }
  return success(count);
 });}
}
