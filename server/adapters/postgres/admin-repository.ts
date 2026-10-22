import {createHash,randomUUID} from 'node:crypto';
import {readFile,statfs} from 'node:fs/promises';
import path from 'node:path';
import type {Pool,PoolClient} from 'pg';
import {success,failure,type Result,type LogSink} from '../../core/crm';
import {capabilitiesFor,effectiveCapabilitiesFor,productPermissionsFor,type AdminRepository,type AdminCommand,type ChallengeDraft,type ManagedUser,type UserPage,type UserQuery,type ProductInfo,type SessionInfo,type AuditInfo,type DataScope} from '../../core/admin';
import type {CrmRole} from '../../core/auth';
import {ADMIN_SQL,ADMIN_VERSION,ADMIN_LOCK} from './admin-schema';
import {USER_LIFECYCLE_SQL,USER_LIFECYCLE_VERSION} from './user-lifecycle-schema';
import {NAVIGATOR_ACCESS_SQL,NAVIGATOR_ACCESS_VERSION,NAVIGATOR_PRODUCT_SQL,NAVIGATOR_PRODUCT_VERSION} from './navigator-access-schema';
import {assertCenterDatabasePool} from './config';
import { canReadManagementDashboard, DASHBOARD_LIMITS, OPERATIONS_LIMITS, type ManagementDashboard, type ManagementDashboardRepository, type OperationsCheck, type OperationsSummary } from '../../core/management-dashboard';

type DB=Pool|PoolClient;
interface Actor {userId:string;identityAdmin:boolean;roles:CrmRole[];capabilities:string[];scope:DataScope;}
const MAX_AUDIT_ROWS=100;
const BYTES_PER_KIBIBYTE=1024;
const PERCENT_SCALE=100;
const DECIMAL_PLACES=1;
const PACKAGE_FILE='package.json';
const DISK_PATH=process.platform==='win32'?path.parse(process.cwd()).root:'/';
const PERSON=`u.user_id AS "userId",u.display_name AS "displayName",e.email,e.verified_at IS NOT NULL AS "emailVerified",
 u.identity_admin AS "identityAdmin",u.active,u.management_revision AS revision,
 COALESCE(a.active,true) AS "accessActive",COALESCE(a.scope,CASE
  WHEN EXISTS(SELECT 1 FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active AND g.role='admin') THEN 'summary'
  WHEN EXISTS(SELECT 1 FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active AND g.role='operations') THEN 'shared' ELSE 'own' END) AS scope,a.capabilities,
 ARRAY(SELECT role FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' ORDER BY role) AS "crmRoles",
 (SELECT g.role FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='navigator' AND g.active AND g.role IN ('operations','sales') ORDER BY CASE g.role WHEN 'operations' THEN 0 ELSE 1 END LIMIT 1) AS "navigatorRole",
 COALESCE((SELECT na.active FROM identity.product_access na WHERE na.user_id=u.user_id AND na.product_id='navigator'),false) AS "navigatorActive"`;
function managed(row:any):ManagedUser {return {...row,capabilities:effectiveCapabilitiesFor(row.crmRoles,row.capabilities)};}
function formatBytes(bytes:number):string {
 const units=['B','KB','MB','GB','TB'];
 let value=bytes,index=0;
 while(value>=BYTES_PER_KIBIBYTE&&index<units.length-1){value/=BYTES_PER_KIBIBYTE;index++;}
 return `${value.toFixed(index===0?0:DECIMAL_PLACES)} ${units[index]}`;
}
async function applicationVersion():Promise<string> {
 try {
  const value=JSON.parse(await readFile(path.resolve(process.cwd(),PACKAGE_FILE),'utf8')) as {version?:unknown};
  return typeof value.version==='string'&&value.version?value.version:'unknown';
 } catch {
  // Version metadata is diagnostic only and must not hide the remaining health checks.
  return 'unknown';
 }
}
async function diskCheck():Promise<OperationsCheck> {
 try {
  const disk=await statfs(DISK_PATH);
  const total=disk.blocks*disk.bsize,free=disk.bavail*disk.bsize;
  const usedPercent=total>0?(total-free)/total*PERCENT_SCALE:PERCENT_SCALE;
  const state=usedPercent>=OPERATIONS_LIMITS.disk_offline_usage_percent?'offline':usedPercent>=OPERATIONS_LIMITS.disk_attention_usage_percent?'attention':'healthy';
  return {id:'disk',label:'服务器磁盘',state,value:`${usedPercent.toFixed(DECIMAL_PLACES)}%`,valueLabel:'已使用',detail:`可用 ${formatBytes(free)} / ${formatBytes(total)}`};
 } catch {
  // Capacity probing is optional and must not hide database or Navigator health.
  return {id:'disk',label:'服务器磁盘',state:'not_connected',value:'不可读',valueLabel:'已使用',detail:'当前运行环境未提供磁盘容量'};
 }
}
export class PostgresAdminRepository implements AdminRepository, ManagementDashboardRepository {
 constructor(private readonly pool:Pool,private readonly log:LogSink){
  assertCenterDatabasePool(pool);
 }
 private async execute<T>(action:()=>Promise<Result<T>>):Promise<Result<T>> {try{return await action();}catch(error){const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[A-Z0-9]+$/.test(error.code)?error.code:'UNKNOWN';this.log.write('ERROR','management.pg',`数据库操作失败 code=${code}`);return failure('DATABASE_ERROR','管理服务暂不可用');}}
 private async tx<T>(action:(c:PoolClient)=>Promise<Result<T>>):Promise<Result<T>> {const c=await this.pool.connect();try{await c.query('BEGIN');const r=await action(c);await c.query(r.ok?'COMMIT':'ROLLBACK');return r;}catch(error){try{await c.query('ROLLBACK');}catch{this.log.write('ERROR','management.rollback','回滚失败');}throw error;}finally{c.release();}}
 migrate():Promise<Result<void>> {return this.execute(()=>this.tx(async c=>{
  await c.query('SELECT pg_advisory_xact_lock($1)',[ADMIN_LOCK]);const hash=createHash('sha256').update(ADMIN_SQL).digest('hex');
  const existing=await c.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[ADMIN_VERSION]);
  if(existing.rows.length){if(existing.rows[0].checksum!==hash)return failure('CONFLICT','管理迁移校验不一致');}
  else {await c.query(ADMIN_SQL);await c.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[ADMIN_VERSION,hash]);this.log.write('INFO','management.migrate',`迁移完成 version=${ADMIN_VERSION}`);}
  const lifecycleHash=createHash('sha256').update(USER_LIFECYCLE_SQL).digest('hex');
  const lifecycle=await c.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[USER_LIFECYCLE_VERSION]);
  if(lifecycle.rows.length&&lifecycle.rows[0].checksum!==lifecycleHash)return failure('CONFLICT','账号生命周期迁移校验不一致');
  if(!lifecycle.rows.length){await c.query(USER_LIFECYCLE_SQL);await c.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[USER_LIFECYCLE_VERSION,lifecycleHash]);this.log.write('INFO','management.migrate',`迁移完成 version=${USER_LIFECYCLE_VERSION}`);}
  const navigatorHash=createHash('sha256').update(NAVIGATOR_ACCESS_SQL).digest('hex');
  const navigator=await c.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[NAVIGATOR_ACCESS_VERSION]);
  if(navigator.rows.length&&navigator.rows[0].checksum!==navigatorHash)return failure('CONFLICT','Navigator 授权迁移校验不一致');
  if(!navigator.rows.length){await c.query(NAVIGATOR_ACCESS_SQL);await c.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[NAVIGATOR_ACCESS_VERSION,navigatorHash]);this.log.write('INFO','management.migrate',`迁移完成 version=${NAVIGATOR_ACCESS_VERSION}`);}
  const productHash=createHash('sha256').update(NAVIGATOR_PRODUCT_SQL).digest('hex');
  const product=await c.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[NAVIGATOR_PRODUCT_VERSION]);
  if(product.rows.length&&product.rows[0].checksum!==productHash)return failure('CONFLICT','Navigator 产品迁移校验不一致');
  if(!product.rows.length){await c.query(NAVIGATOR_PRODUCT_SQL);await c.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[NAVIGATOR_PRODUCT_VERSION,productHash]);this.log.write('INFO','management.migrate',`迁移完成 version=${NAVIGATOR_PRODUCT_VERSION}`);}
  return success(undefined);
 }));}
 private async actor(c:DB,hash:string):Promise<Actor|null>{
  const result=await c.query(`SELECT u.user_id AS "userId",u.identity_admin AS "identityAdmin",a.scope,
   COALESCE(a.active,true) AS enabled,a.capabilities,
   ARRAY(SELECT role FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active ORDER BY role) AS roles
   FROM identity.sessions s JOIN identity.users u USING(user_id) LEFT JOIN identity.product_access a ON a.user_id=u.user_id AND a.product_id='crm'
   WHERE s.token_hash=$1 AND s.client='browser' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND NOT u.must_change_password AND s.security_revision=u.security_revision`,[hash]);
  const row=result.rows[0];if(!row)return null;return {...row,scope:row.scope??(row.roles.includes('admin')?'summary':row.roles.includes('operations')?'shared':'own'),roles:row.enabled?row.roles:[],capabilities:row.enabled?effectiveCapabilitiesFor(row.roles,row.capabilities):[]};
 }
 private async read<T>(hash:string,action:(c:PoolClient,actor:Actor)=>Promise<Result<T>>):Promise<Result<T>>{
  return this.execute(()=>this.tx(async c=>{await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const actor=await this.actor(c,hash);return actor?action(c,actor):failure('UNAUTHORIZED','管理会话失效');}));
 }
 users(hash:string,q:UserQuery):Promise<Result<UserPage>> {return this.read(hash,async(c,actor)=>{
  if(!actor.identityAdmin&&(q.productId!=='crm'||!actor.capabilities.includes('members.read')))return failure('FORBIDDEN','无成员读取权限');
  const filter=`WHERE u.deleted_at IS NULL AND ($1='' OR u.user_id::text=$1 OR e.email ILIKE $2 ESCAPE '\\' OR u.display_name ILIKE $2 ESCAPE '\\')
   AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id=$3 AND g.active))`;
  const p=[q.search,`%${q.search.replace(/[\\%_]/g,'\\$&')}%`,q.productId??null];
  const count=await c.query(`SELECT count(*)::int AS n FROM identity.users u JOIN identity.login_emails e USING(user_id) ${filter}`,p);
  const rows=await c.query(`SELECT ${PERSON} FROM identity.users u JOIN identity.login_emails e USING(user_id) LEFT JOIN identity.product_access a ON a.user_id=u.user_id AND a.product_id='crm' ${filter} ORDER BY u.created_at DESC,u.user_id LIMIT $4 OFFSET $5`,[...p,q.limit,q.offset]);
  return success({items:rows.rows.map(managed),total:count.rows[0].n});
 });}
 products(hash:string):Promise<Result<ProductInfo[]>>{return this.read(hash,async(c,actor)=>{
  const rows=await c.query('SELECT product_id AS "productId",name,connected,description FROM identity.products ORDER BY product_id');
  return success(rows.rows.map(row=>({...row,capabilities:row.productId==='crm'?actor.capabilities:[],roles:row.productId==='crm'?actor.roles:[],scope:row.productId==='crm'?actor.scope:'own'})));
 });}
 dashboard(hash:string):Promise<Result<ManagementDashboard>> {return this.read(hash,async(c,actor)=>{
  if(!canReadManagementDashboard(actor))return failure('FORBIDDEN','无数据看板权限');
  const [users,customers,tasks,pending,imports,deliveries,batchReceipts,eventReceipts,taskReceipts]=await Promise.all([
   c.query("SELECT count(*)::int AS n FROM identity.users WHERE active AND deleted_at IS NULL"),
   c.query("SELECT count(*)::int AS n,max(created_at) AS updated_at FROM crm_customers"),
   c.query("SELECT count(*)::int AS n,count(*) FILTER (WHERE due_at<=now())::int AS overdue,min(due_at) AS next_due FROM crm_followup_tasks WHERE status='open'"),
   c.query("SELECT count(*)::int AS n,count(*) FILTER (WHERE created_at < now()-$1 * interval '1 second')::int AS stale,min(created_at) AS oldest FROM identity.outbox o WHERE NOT EXISTS (SELECT 1 FROM crm_notification_consumed x WHERE x.event_id=o.event_id)",[DASHBOARD_LIMITS.stale_event_seconds]),
   c.query("SELECT count(*)::int AS n,max(created_at) AS updated_at FROM crm_import_batches"),
   c.query("SELECT count(*)::int AS n,max(created_at) AS updated_at FROM crm_event_deliveries"),
   c.query(`SELECT b.batch_id::text AS id,b.created_at,count(r.row_id)::int AS total,count(r.row_id) FILTER (WHERE r.status='created')::int AS created,count(r.row_id) FILTER (WHERE r.status='duplicate')::int AS duplicate,count(r.row_id) FILTER (WHERE r.status IN ('invalid','restricted_conflict'))::int AS review FROM (SELECT batch_id,created_at FROM crm_import_batches ORDER BY created_at DESC,batch_id LIMIT $1) b LEFT JOIN crm_import_rows r USING(batch_id) GROUP BY b.batch_id,b.created_at ORDER BY b.created_at DESC,b.batch_id`,[DASHBOARD_LIMITS.receipts]),
   c.query(`SELECT o.event_id::text AS id,o.created_at,x.consumed_at,(SELECT count(*)::int FROM crm_event_deliveries d WHERE d.event_id=o.event_id) AS deliveries FROM identity.outbox o LEFT JOIN crm_notification_consumed x USING(event_id) WHERE o.product_id='crm' AND o.customer_id IS NOT NULL ORDER BY o.created_at DESC,o.event_id LIMIT $1`,[DASHBOARD_LIMITS.receipts]),
   c.query(`SELECT t.task_id::text AS id,t.updated_at AS created_at,t.status,t.due_at,EXISTS(SELECT 1 FROM crm_task_due_receipts r WHERE r.task_id=t.task_id AND r.task_version=t.version) AS reminded FROM crm_followup_tasks t ORDER BY t.updated_at DESC,t.task_id LIMIT $1`,[DASHBOARD_LIMITS.receipts]),
  ]);
  const value=(r:any)=>Number(r.rows[0]?.n??0);
  const iso=(v:unknown)=>v instanceof Date?v.toISOString():typeof v==='string'?new Date(v).toISOString():null;
  const customerCount=value(customers), taskCount=value(tasks), pendingCount=value(pending), overdueCount=Number(tasks.rows[0]?.overdue??0), staleCount=Number(pending.rows[0]?.stale??0);
  const databases:ManagementDashboard['databases']=[
   {id:'identity',name:'身份数据区',kind:'中心 PostgreSQL · identity',state:'healthy',records:value(users),updatedAt:null,detail:'与业务区共用中心库；账号、产品权限与管理审计',recordLabel:'启用账号'},
   {id:'crm',name:'Prospector 业务数据区',kind:'中心 PostgreSQL · public',state:'healthy',records:customerCount,updatedAt:iso(customers.rows[0]?.updated_at),detail:'客户、联系人、跟进与协作事件；时间为最近客户创建时间',recordLabel:'客户'},
   {id:'local',name:'桌面个人数据',kind:'SQLite',state:'not_connected',records:null,updatedAt:null,detail:'尚未接入中心遥测',recordLabel:'记录'},
  ];
  const flows:ManagementDashboard['flows']=[
   {id:'import',label:'导入 → 客户库',state:'healthy',records:value(imports),updatedAt:iso(imports.rows[0]?.updated_at),detail:'已记录的中心导入批次',recordLabel:'导入批次',timeLabel:'最近导入',stages:['文件解析','字段校验','客户入库']},
   {id:'events',label:'业务事件 → 通知',state:staleCount>0?'attention':'healthy',records:value(deliveries),updatedAt:iso(deliveries.rows[0]?.updated_at),detail:pendingCount>0?`有 ${pendingCount} 条事件等待处理，${staleCount} 条超过一分钟`:'待处理队列为空',recordLabel:'通知记录',timeLabel:'最近投递',stages:['业务事件','权限投影','通知投递']},
   {id:'tasks',label:'跟进任务 → 到期提醒',state:overdueCount>0?'attention':'healthy',records:taskCount,updatedAt:iso(tasks.rows[0]?.next_due),detail:`${taskCount} 条开放任务，${overdueCount} 条已到期`,recordLabel:'开放任务',timeLabel:'最近到期',stages:['任务创建','到期扫描','提醒投递']},
  ];
  const alerts:ManagementDashboard['alerts']=[
   ...(staleCount>0?[{id:'pending-events',level:'warning' as const,title:'事件等待超过一分钟',detail:`${staleCount} 条事件尚未完成消费；消费回执不等于用户已读`}]:[]),
   ...(overdueCount>0?[{id:'open-tasks',level:'warning' as const,title:'有跟进任务已到期',detail:`${overdueCount} 条任务待处理`}]:[]),
   {id:'local-telemetry',level:'warning',title:'桌面个人数据未接入',detail:'邮件库、运价镜像等本地数据暂不纳入中心健康判断'},
  ];
  const receipts:ManagementDashboard['receipts']=[
   ...batchReceipts.rows.map(r=>({id:r.id,flowId:'import',createdAt:iso(r.created_at)!,status:r.review?'待核对':r.total?'已有回执':'暂无行回执',detail:`${r.total} 行：新增 ${r.created}，重复 ${r.duplicate}，待核对 ${r.review}`})),
   ...eventReceipts.rows.map(r=>({id:r.id,flowId:'events',createdAt:iso(r.created_at)!,status:r.consumed_at?'已消费':'待消费',detail:`${r.deliveries} 份通知投影；消费不代表已读`})),
   ...taskReceipts.rows.map(r=>({id:r.id,flowId:'tasks',createdAt:iso(r.created_at)!,status:r.status==='completed'?'已完成':r.reminded?'提醒已入队':'开放',detail:`到期 ${iso(r.due_at)}；当前版本${r.reminded?'有':'无'}提醒回执`})),
  ];
  return success({generatedAt:new Date().toISOString(),overview:{databases:databases.length,healthy:databases.filter(row=>row.state==='healthy').length,activeUsers:value(users),customers:customerCount,openTasks:taskCount,pendingEvents:pendingCount},databases,flows,alerts,receipts});
 });}
  operations(hash:string):Promise<Result<OperationsSummary>> {return this.read(hash,async(c,actor)=>{
   if(!canReadManagementDashboard(actor))return failure('FORBIDDEN','无系统运行读取权限');
   const [database,disk,version]=await Promise.all([
    c.query('SELECT pg_database_size(current_database())::bigint AS bytes'),
    diskCheck(),
    applicationVersion(),
   ]);
   const databaseBytes=Number(database.rows[0]?.bytes??0);
   return success({
    generatedAt:new Date().toISOString(),version,uptime_seconds:Math.floor(process.uptime()),
    checks:[
     {id:'center',label:'中心服务',state:'healthy',value:`v${version}`,valueLabel:'当前版本',detail:'中心 API 与管理工作台正常响应'},
     {id:'database',label:'PostgreSQL',state:'healthy',value:formatBytes(databaseBytes),valueLabel:'数据库大小',detail:'中心业务库连接正常'},
     disk,
     {id:'backup',label:'自动备份',state:'not_connected',value:'未接入',valueLabel:'备份监控',detail:'尚未读取服务器备份目录'},
    ],
   });
  });}
 sessions(hash:string,userId:string):Promise<Result<SessionInfo[]>>{return this.read(hash,async(c,actor)=>{
  if(!actor.identityAdmin&&actor.userId!==userId)return failure('FORBIDDEN','无会话管理权限');
  const rows=await c.query(`SELECT session_id AS "sessionId",client,created_at AS "createdAt",expires_at AS "expiresAt",(revoked_at IS NOT NULL OR expires_at<=now()) AS revoked FROM identity.sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,[userId,MAX_AUDIT_ROWS]);
  return success(rows.rows.map(row=>({...row,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString()})));
 });}
 audit(hash:string,productId?:string,userId?:string):Promise<Result<AuditInfo[]>>{return this.read(hash,async(c,actor)=>{
  if(productId===undefined&&!actor.identityAdmin)return failure('FORBIDDEN','无身份审计权限');
  if(productId==='navigator'&&!actor.identityAdmin&&!actor.capabilities.includes('audit.read'))return failure('FORBIDDEN','无Navigator审计权限');
  if(productId==='crm'&&!actor.capabilities.includes('audit.read'))return failure('FORBIDDEN','无产品审计权限');
  const rows=await c.query(`SELECT a.id::text,a.action,a.product_id AS "productId",a.reason,a.created_at AS "createdAt",u.display_name AS "actorName",COALESCE(t.display_name,'') AS "targetName" FROM identity.management_audit a JOIN identity.users u ON u.user_id=a.actor_id LEFT JOIN identity.users t ON t.user_id=a.target_id WHERE a.product_id IS NOT DISTINCT FROM $1 AND ($3::uuid IS NULL OR a.actor_id=$3::uuid OR a.target_id=$3::uuid) ORDER BY a.id DESC LIMIT $2`,[productId??null,MAX_AUDIT_ROWS,userId??null]);
  return success(rows.rows.map(row=>({...row,createdAt:row.createdAt.toISOString()})));
 });}
 mutate(hash:string,cmd:AdminCommand,challenge?:ChallengeDraft,initialPasswordHash?:string):Promise<Result<void>>{return this.execute(()=>this.tx(async c=>{
  // Derive again at the write boundary, including callers that bypass the service.
  if(cmd.action==='product.update'&&cmd.role!==undefined)cmd={...cmd,...productPermissionsFor(cmd.role)};
  await c.query('SELECT pg_advisory_xact_lock($1)',[ADMIN_LOCK]);
  const actor=await this.actor(c,hash);if(!actor)return failure('UNAUTHORIZED','管理会话失效');
  if(cmd.action==='product.update'){
   if(!actor.roles.includes('admin')||!actor.capabilities.includes('access.manage')||!actor.capabilities.includes('roles.manage'))return failure('FORBIDDEN','无产品授权维护权限');
   // The legacy array endpoint must respect the same delegation ceiling as identity grants.
   const delegated=actor.identityAdmin?capabilitiesFor(['admin','operations','sales','auditor']):actor.capabilities;
   if(cmd.capabilities.some(cap=>!delegated.includes(cap))||cmd.roles.includes('admin')&&!actor.roles.includes('admin'))return failure('FORBIDDEN','授权超过委托上限');
   if(cmd.userId===actor.userId&&(cmd.capabilities.some(cap=>!actor.capabilities.includes(cap))||cmd.roles.some(role=>!actor.roles.includes(role))))return failure('FORBIDDEN','不能扩大本人权限');
   const scopeRank={own:0,shared:1,summary:2};if(scopeRank[cmd.scope]>scopeRank[actor.scope])return failure('FORBIDDEN','数据范围超过委托上限');
  }else if(!actor.identityAdmin)return failure('FORBIDDEN','无身份管理权限');
  let targetId:string,productId:string|null=null;
  if(cmd.action==='user.create'){
   if(!initialPasswordHash)return failure('INVALID_INPUT','缺少初始密码摘要');
   if((await c.query('SELECT 1 FROM identity.login_emails WHERE email=$1',[cmd.email])).rows.length)return failure('CONFLICT','该邮箱已注册');
   targetId=randomUUID();productId='crm';
   const {roles,scope,capabilities}=productPermissionsFor(cmd.role);
   await c.query('INSERT INTO identity.users(user_id,display_name,identity_admin,must_change_password) VALUES($1,$2,$3,true)',[targetId,cmd.email.split('@')[0],cmd.role==='admin']);
   await c.query('INSERT INTO identity.login_emails(user_id,email) VALUES($1,$2)',[targetId,cmd.email]);
   await c.query("INSERT INTO identity.credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1')",[targetId,initialPasswordHash]);
   for(const role of roles)await c.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[targetId,role]);
   await c.query("INSERT INTO identity.product_access(user_id,product_id,active,scope,capabilities) VALUES($1,'crm',true,$2,$3)",[targetId,scope,JSON.stringify(capabilities)]);
  }else if(cmd.action==='challenge.issue'){
   if(!challenge)return failure('INVALID_INPUT','缺少用途绑定挑战');
   const existing=await c.query(`SELECT e.user_id,u.active,u.deleted_at,EXISTS(SELECT 1 FROM identity.credentials c WHERE c.user_id=e.user_id) AS credentialed FROM identity.login_emails e JOIN identity.users u USING(user_id) WHERE e.email=$1 FOR UPDATE OF u`,[cmd.email]);
   if(cmd.purpose==='activate'&&existing.rows.length&&(existing.rows[0].active||existing.rows[0].credentialed||existing.rows[0].deleted_at))return failure('CONFLICT','该邮箱已注册');
   if(cmd.purpose==='recover'&&!existing.rows.length)return failure('NOT_FOUND','未找到目标身份');
   if(cmd.purpose==='recover'&&(!existing.rows[0].active||existing.rows[0].deleted_at))return failure('FORBIDDEN','停用或已删除账号不能重置密码');
   targetId=existing.rows[0]?.user_id??randomUUID();
   if(cmd.purpose==='activate'&&!existing.rows.length){await c.query('INSERT INTO identity.users(user_id,display_name,active) VALUES($1,$2,false)',[targetId,cmd.displayName]);await c.query('INSERT INTO identity.login_emails(user_id,email) VALUES($1,$2)',[targetId,cmd.email]);}
   await c.query('UPDATE identity.management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[targetId]);
   await c.query('INSERT INTO identity.management_challenges(token_hash,user_id,purpose,issuer_id,email,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[challenge.tokenHash,targetId,cmd.purpose,actor.userId,cmd.email,challenge.expiresAt]);
   if(cmd.purpose==='recover'){
    await c.query('UPDATE identity.users SET security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1',[targetId]);
    await c.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[targetId]);
   }
  }else{
   targetId=cmd.userId;const target=await c.query('SELECT active,identity_admin,management_revision,deleted_at FROM identity.users WHERE user_id=$1 FOR UPDATE',[targetId]);if(!target.rows.length||target.rows[0].deleted_at)return failure('NOT_FOUND','目标用户不存在或已删除');
   if('revision'in cmd&&target.rows[0].management_revision!==cmd.revision)return failure('CONFLICT','资料已更新，请刷新后重试');
   if(cmd.action==='user.delete'){
    if(targetId===actor.userId)return failure('FORBIDDEN','不能删除当前登录账号');
    if(target.rows[0].active&&target.rows[0].identity_admin){
     const count=await c.query(`SELECT count(*)::int AS n FROM identity.users u JOIN identity.credentials c USING(user_id) JOIN identity.login_emails e USING(user_id) WHERE u.active AND u.identity_admin AND u.deleted_at IS NULL`);
     if(count.rows[0].n<=1)return failure('CONFLICT','必须保留至少一名有效超级管理员');
    }
    // All CRM ownership writes and this command share ADMIN_LOCK, so the check
    // and deletion serialize with assignment/claim and personal lead creation.
    const owned=await c.query('SELECT 1 FROM crm_customers WHERE owner_user_id=$1 LIMIT 1',[targetId]);
    if(owned.rows.length)return failure('CONFLICT','该用户仍有负责的线索，请先转交');
    // Identity migrations can run before the contact feature is installed.
    const assignmentTable=await c.query("SELECT to_regclass('crm_contact_assignment_requests') AS relation");
    if(assignmentTable.rows[0].relation){
     const requests=await c.query("SELECT 1 FROM crm_contact_assignment_requests WHERE status IN ('pending','accepted') AND (actor_id=$1 OR target_user_id=$1) LIMIT 1",[targetId]);
     if(requests.rows.length)return failure('CONFLICT','该用户仍有有效联系人分配，请先处理分配归属');
    }
    await c.query('UPDATE identity.users SET deleted_at=now(),active=false,security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1',[targetId]);
    await c.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[targetId]);
    await c.query('UPDATE identity.management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[targetId]);
   }else if(cmd.action==='user.reset-password'){
    if(!challenge||challenge.userId!==targetId||challenge.purpose!=='recover')return failure('INVALID_INPUT','缺少账号绑定挑战');
    if(!target.rows[0].active)return failure('FORBIDDEN','停用账号不能重置密码');
    const email=await c.query('SELECT email FROM identity.login_emails WHERE user_id=$1',[targetId]);
    if(!email.rows.length)return failure('NOT_FOUND','目标用户邮箱不存在');
    await c.query('UPDATE identity.management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[targetId]);
    await c.query("INSERT INTO identity.management_challenges(token_hash,user_id,purpose,issuer_id,email,expires_at) VALUES($1,$2,'recover',$3,$4,$5)",[challenge.tokenHash,targetId,actor.userId,email.rows[0].email,challenge.expiresAt]);
    await c.query('UPDATE identity.users SET security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1',[targetId]);
    await c.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[targetId]);
   }else if(cmd.action==='user.update'){
    if(cmd.active && !(await c.query('SELECT 1 FROM identity.credentials WHERE user_id=$1',[targetId])).rows.length)return failure('CONFLICT','待激活身份必须先使用激活链接设置密码');
    if(targetId===actor.userId&&cmd.identityAdmin&&!target.rows[0].identity_admin)return failure('FORBIDDEN','不能为本人提权');
    if(target.rows[0].active&&target.rows[0].identity_admin&&(!cmd.active||!cmd.identityAdmin)){
     const count=await c.query(`SELECT count(*)::int AS n FROM identity.users u JOIN identity.credentials c USING(user_id) JOIN identity.login_emails e USING(user_id) WHERE u.active AND u.identity_admin`);if(count.rows[0].n<=1)return failure('CONFLICT','必须保留至少一名有效超级管理员');
    }
    await c.query('UPDATE identity.users SET active=$2,identity_admin=$3,management_revision=management_revision+1,security_revision=security_revision+1 WHERE user_id=$1',[targetId,cmd.active,cmd.identityAdmin]);
    await c.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[targetId]);
    await c.query('UPDATE identity.management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[targetId]);
   }else if(cmd.action==='product.update'){
    productId='crm';await c.query('DELETE FROM identity.product_grants WHERE user_id=$1 AND product_id=$2',[targetId,productId]);
    for(const role of cmd.roles)await c.query('INSERT INTO identity.product_grants(user_id,product_id,role,active) VALUES($1,$2,$3,$4)',[targetId,productId,role,cmd.active]);
    await c.query(`INSERT INTO identity.product_access(user_id,product_id,active,scope,capabilities) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,product_id) DO UPDATE SET active=EXCLUDED.active,scope=EXCLUDED.scope,capabilities=EXCLUDED.capabilities`,[targetId,productId,cmd.active,cmd.scope,JSON.stringify(cmd.capabilities)]);
    await c.query('UPDATE identity.users SET management_revision=management_revision+1 WHERE user_id=$1',[targetId]);
   }else if(cmd.action==='navigator.update'){
    if(target.rows[0].identity_admin)return failure('FORBIDDEN','中心超级管理员自动拥有 Navigator 管理权限');
    productId='navigator';
    await c.query("DELETE FROM identity.product_grants WHERE user_id=$1 AND product_id='navigator'",[targetId]);
    await c.query("INSERT INTO identity.product_grants(user_id,product_id,role,active) VALUES($1,'navigator',$2,true)",[targetId,cmd.role]);
    await c.query("INSERT INTO identity.product_access(user_id,product_id,active,scope) VALUES($1,'navigator',$2,'own') ON CONFLICT(user_id,product_id) DO UPDATE SET active=EXCLUDED.active",[targetId,cmd.active]);
    await c.query('UPDATE identity.users SET management_revision=management_revision+1 WHERE user_id=$1',[targetId]);
   }else{const revoked=await c.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND session_id=$2 AND revoked_at IS NULL RETURNING session_id',[targetId,cmd.sessionId]);if(!revoked.rows.length)return failure('NOT_FOUND','有效会话不存在');}
  }
  await c.query('INSERT INTO identity.management_audit(actor_id,target_id,action,product_id,reason) VALUES($1,$2,$3,$4,$5)',[actor.userId,targetId,cmd.action,productId,cmd.reason]);
  await c.query(`INSERT INTO identity.outbox(event_type,user_id,product_id,revision) SELECT $2,user_id,$3,management_revision FROM identity.users WHERE user_id=$1`,[targetId,cmd.action,productId]);
  return success(undefined);
 }));}
 consume(hash:string,passwordHash:string):Promise<Result<void>>{return this.execute(()=>this.tx(async c=>{
  await c.query('SELECT pg_advisory_xact_lock($1)',[ADMIN_LOCK]);
  const challenges=await c.query(`SELECT c.* FROM identity.management_challenges c JOIN identity.users issuer ON issuer.user_id=c.issuer_id WHERE c.token_hash=$1 AND c.consumed_at IS NULL AND c.expires_at>now() AND issuer.active AND issuer.identity_admin FOR UPDATE OF c`,[hash]);
  const challenge=challenges.rows[0];if(!challenge)return failure('UNAUTHORIZED','链接已失效或已使用');
  const users=await c.query('SELECT u.active,u.deleted_at,e.email FROM identity.users u JOIN identity.login_emails e USING(user_id) WHERE u.user_id=$1 FOR UPDATE OF u',[challenge.user_id]);
  if(!users.rows.length||users.rows[0].email!==challenge.email)return failure('CONFLICT','身份信息已变化');
  if(users.rows[0].deleted_at)return failure('FORBIDDEN','已删除账号不能激活或重置密码');
  if(challenge.purpose==='recover'&&!users.rows[0].active)return failure('FORBIDDEN','停用账号不能通过密码恢复重新启用');
  await c.query(`INSERT INTO identity.credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1') ON CONFLICT(user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,changed_at=now()`,[challenge.user_id,passwordHash]);
  await c.query(`UPDATE identity.users SET active=true,must_change_password=false,security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1`,[challenge.user_id]);
  await c.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[challenge.user_id]);
  await c.query('UPDATE identity.management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[challenge.user_id]);
  await c.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,reason) VALUES($1,$2,$3,'管理挑战已消费；邮箱未验证')`,[challenge.issuer_id,challenge.user_id,`challenge.${challenge.purpose}`]);
  await c.query(`INSERT INTO identity.outbox(event_type,user_id,revision) SELECT 'identity.password.changed',user_id,management_revision FROM identity.users WHERE user_id=$1`,[challenge.user_id]);
  return success(undefined);
 }));}
}
