import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { createHash,randomUUID } from 'node:crypto';
import { Pool,type PoolClient } from 'pg';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresTaskRepository,canProjectTaskDue } from '../../server/adapters/postgres/task-repository';
import { PostgresNotificationRepository } from '../../server/adapters/postgres/notification-repository';
import { createTaskService } from '../../server/services/tasks';
import { capabilitiesFor } from '../../server/core/admin';
import type { CrmRole } from '../../server/core/auth';
import type { FollowupTask } from '../../server/core/tasks';
import type { Result } from '../../server/core/crm';
const enabled=process.env.PROSPECTOR_TASK_TEST==='1';
const log={write:()=>{}};
const tokens={hash:(token:string)=>createHash('sha256').update(token).digest('hex')};
function unwrap<T>(r:Result<T>):T{if(!r.ok)throw Error(`${r.error.code}: ${r.error.message}`);return r.data;}
type User={id:string;token:string;hash:string;roles:CrmRole[];scope:'own'|'shared'|'summary';capabilities:string[]};
describe.skipIf(!enabled)('followup tasks PostgreSQL rollback-only',()=>{
 let pool:Pool,c:PoolClient,repo:PostgresTaskRepository,service:ReturnType<typeof createTaskService>,wrapped:Pool,sales:User,other:User,ops:User,admin:User;
 beforeEach(async()=>{
  pool=new Pool(readTestDatabaseConfig());c=await pool.connect();await c.query('BEGIN');
  // All repository COMMITs release a savepoint; the outer transaction always rolls back.
  wrapped={options:pool.options,connect:async()=>({release:()=>{},query:async(sql:string,p?:unknown[])=>{
   if(sql==='BEGIN')return c.query('SAVEPOINT task_operation');
   if(sql==='COMMIT')return c.query('RELEASE SAVEPOINT task_operation');
   if(sql==='ROLLBACK'){await c.query('ROLLBACK TO SAVEPOINT task_operation');return c.query('RELEASE SAVEPOINT task_operation');}
   return c.query(sql,p);
  }})} as unknown as Pool;
  repo=new PostgresTaskRepository(wrapped,log);service=createTaskService(repo,tokens as never);unwrap(await repo.migrate());
  sales=await user('sales');other=await user('sales');ops=await user('operations');admin=await user('admin');
 });
 afterEach(async()=>{if(c){await c.query('ROLLBACK');c.release();}if(pool)await pool.end();});
 async function user(role:CrmRole):Promise<User>{
  const id=randomUUID(),token=Buffer.from(randomUUID()+randomUUID()).toString('base64url').slice(0,43),hash=tokens.hash(token),scope=role==='sales'?'own':role==='admin'?'summary':'shared',capabilities=capabilitiesFor([role]);
  await c.query('INSERT INTO identity.users(user_id,display_name,active) VALUES($1,$2,true)',[id,'Rollback task user']);
  await c.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[id,role]);
  await c.query("INSERT INTO identity.product_access(user_id,product_id,scope) VALUES($1,'crm',$2)",[id,scope]);
  await c.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) SELECT $1,user_id,security_revision,now()+interval '1 hour','api' FROM identity.users WHERE user_id=$2",[hash,id]);
  return {id,token,hash,roles:[role],scope,capabilities};
 }
 async function customer(owner=sales,creator=sales){const co=await c.query("INSERT INTO companies(name) VALUES('Rollback task customer') RETURNING id");const r=await c.query("INSERT INTO crm_customers(company_id,source,customer_key,source_detail,state,owner_user_id,created_by,origin) VALUES($1,'rollback-task',$2,'synthetic','owned',$3,$4,$5) RETURNING customer_id",[co.rows[0].id,randomUUID(),owner.id,creator.id,creator===owner?'personal':'operations']);return r.rows[0].customer_id as string;}
 async function task(id?:string):Promise<FollowupTask>{const customerId=id??await customer();return unwrap(await service.create(sales.token,{customerId,title:'Call synthetic customer',dueAt:'2020-01-01T00:00:00Z',expectedCustomerVersion:1,idempotencyKey:randomUUID()}));}
 function command(t:FollowupTask){return {taskId:t.taskId,expectedVersion:t.version,idempotencyKey:randomUUID()};}
 async function event(t:FollowupTask){return (await c.query("SELECT * FROM identity.outbox WHERE customer_id=$1 AND event_type='crm.task.due' ORDER BY (payload->>'taskVersion')::int,event_id",[t.customerId])).rows.at(-1);}
 async function notificationRepo(){const n=new PostgresNotificationRepository(wrapped,log);await c.query('INSERT INTO crm_notification_consumed(event_id) SELECT event_id FROM identity.outbox WHERE NOT EXISTS(SELECT 1 FROM crm_notification_consumed x WHERE x.event_id=identity.outbox.event_id)');return n;}
 it('creates once, retries after customer version advances, and rejects conflicting reuse',async()=>{
  const id=await customer(),input={customerId:id,title:'Call synthetic customer',dueAt:'2020-01-01T00:00:00Z',expectedCustomerVersion:1,idempotencyKey:randomUUID()};
  const first=unwrap(await service.create(sales.token,input));await c.query('UPDATE crm_customers SET version=version+1 WHERE customer_id=$1',[id]);
  expect(unwrap(await service.create(sales.token,input)).taskId).toBe(first.taskId);
  expect(await service.create(sales.token,{...input,title:'changed'})).toMatchObject({error:{code:'CONFLICT'}});
  expect((await c.query('SELECT 1 FROM crm_followup_tasks WHERE customer_id=$1',[id])).rows).toHaveLength(1);
 });
 it('deduplicates durable due notices across restart and invalidates old due notice after postponement',async()=>{
  const t=await task();expect(unwrap(await repo.processDue(50))).toBeGreaterThanOrEqual(1);const old=await event(t);
  expect(await canProjectTaskDue(c,old,{...sales,userId:sales.id})).toBe(true);
  unwrap(await new PostgresTaskRepository(wrapped,log).processDue(50));expect((await c.query('SELECT 1 FROM crm_task_due_receipts WHERE task_id=$1',[t.taskId])).rows).toHaveLength(1);
  const input={...command(t),dueAt:'2099-01-01T00:00:00Z'},later=unwrap(await service.reschedule(sales.token,input));
  expect(later.version).toBe(2);expect(unwrap(await service.reschedule(sales.token,input)).taskId).toBe(t.taskId);
  expect(await canProjectTaskDue(c,old,{...sales,userId:sales.id})).toBe(false);
  await repo.processDue(50);expect((await c.query('SELECT 1 FROM crm_task_due_receipts WHERE task_id=$1',[t.taskId])).rows).toHaveLength(1);
 });
 it('records completion feedback once and rejects new completion or stale commands',async()=>{
  const t=await task();unwrap(await repo.processDue(50));const old=await event(t),input={...command(t),feedback:'Called; agreed another meeting'};
  const complete=unwrap(await service.complete(sales.token,input));expect(complete).toMatchObject({status:'completed',completedBy:sales.id,feedback:input.feedback,version:2});expect(complete.completedAt).toBeTruthy();
  expect(unwrap(await service.complete(sales.token,input))).toEqual(complete);
  expect(await service.complete(sales.token,{...input,idempotencyKey:randomUUID()})).toMatchObject({error:{code:'CONFLICT'}});
  expect(await service.reschedule(sales.token,{...command(t),dueAt:'2099-01-01T00:00:00Z'})).toMatchObject({error:{code:'CONFLICT'}});
  expect(await canProjectTaskDue(c,old,{...sales,userId:sales.id})).toBe(false);
 });
 it('applies scope before count and pagination; importer reads progress but cannot complete assigned tasks',async()=>{
  const id=await customer(sales,ops),t=await task(id);expect(unwrap(await service.detail(ops.token,t.taskId)).canManage).toBe(false);
  expect(unwrap(await service.list(ops.token,{customerId:id,limit:25,offset:0})).total).toBe(1);
  expect(unwrap(await service.list(other.token,{customerId:id,limit:25,offset:0}))).toEqual({items:[],total:0});
  expect(await service.detail(other.token,t.taskId)).toMatchObject({error:{code:'NOT_FOUND'}});
  expect(await service.complete(ops.token,{...command(t),feedback:'no'})).toMatchObject({error:{code:'FORBIDDEN'}});
  expect(unwrap(await service.list(admin.token,{customerId:id,limit:25,offset:0})).total).toBe(1);
  await c.query("UPDATE identity.product_access SET capabilities='[\"leads.import\"]' WHERE user_id=$1 AND product_id='crm'",[ops.id]);
  expect(unwrap(await service.list(ops.token,{customerId:id,limit:25,offset:0}))).toEqual({items:[],total:0});
 });
 it('derives new responsibility atomically on transfer and never revives old notices after transfer back',async()=>{
  const t=await task();unwrap(await repo.processDue(50));const old=await event(t);
  await c.query('UPDATE crm_customers SET owner_user_id=$2,version=version+1 WHERE customer_id=$1',[t.customerId,other.id]);
  expect(await service.detail(sales.token,t.taskId)).toMatchObject({error:{code:'NOT_FOUND'}});
  expect(unwrap(await service.detail(other.token,t.taskId))).toMatchObject({version:2,responsibleUserId:other.id,canManage:true});
  expect(await canProjectTaskDue(c,old,{...sales,userId:sales.id})).toBe(false);unwrap(await repo.processDue(50));
  expect((await event(t)).recipient_user_ids).toEqual([other.id]);
  await c.query('UPDATE crm_customers SET owner_user_id=$2,version=version+1 WHERE customer_id=$1',[t.customerId,sales.id]);
  expect(unwrap(await service.detail(sales.token,t.taskId)).version).toBe(3);
  expect(await canProjectTaskDue(c,old,{...sales,userId:sales.id})).toBe(false);unwrap(await repo.processDue(50));
  expect((await c.query('SELECT task_version FROM crm_task_due_receipts WHERE task_id=$1 ORDER BY task_version',[t.taskId])).rows).toEqual([{task_version:1},{task_version:2},{task_version:3}]);
 });
 it('stops actions and notices for inactive/revoked accounts then backfills eligible due tasks',async()=>{
  const t=await task();await c.query('UPDATE identity.users SET active=false WHERE user_id=$1',[sales.id]);
  expect(await service.complete(sales.token,{...command(t),feedback:'no'})).toMatchObject({error:{code:'UNAUTHORIZED'}});await repo.processDue(50);expect(await event(t)).toBeUndefined();
  await c.query('UPDATE identity.users SET active=true WHERE user_id=$1',[sales.id]);await c.query("UPDATE identity.product_access SET active=false WHERE user_id=$1 AND product_id='crm'",[sales.id]);await repo.processDue(50);expect(await event(t)).toBeUndefined();
  await c.query("UPDATE identity.product_access SET active=true,capabilities='[\"leads.claim\"]' WHERE user_id=$1 AND product_id='crm'",[sales.id]);await repo.processDue(50);expect(await event(t)).toBeUndefined();
  await c.query("UPDATE identity.product_access SET capabilities=NULL WHERE user_id=$1 AND product_id='crm'",[sales.id]);await repo.processDue(50);expect(await event(t)).toBeTruthy();
 });
 it('bounds due batches and rolls back event+receipt together on outbox failure',async()=>{
  const t=await task();await task();const count=unwrap(await repo.processDue(1));expect(count).toBe(1);unwrap(await repo.processDue(1));
  const next=await task();await c.query("CREATE FUNCTION crm_b3_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$");
  await c.query(`CREATE TRIGGER crm_b3_outbox_failure BEFORE INSERT ON identity.outbox FOR EACH ROW WHEN (NEW.customer_id='${next.customerId}'::uuid) EXECUTE FUNCTION crm_b3_outbox_failure()`);
  expect(await repo.processDue(50)).toMatchObject({error:{code:'DATABASE_ERROR'}});
  expect(await event(next)).toBeUndefined();expect((await c.query('SELECT 1 FROM crm_task_due_receipts WHERE task_id=$1',[next.taskId])).rows).toHaveLength(0);
  await c.query('DROP TRIGGER crm_b3_outbox_failure ON identity.outbox');expect((await repo.processDue(50)).ok).toBe(true);
  expect((await c.query('SELECT 1 FROM crm_task_due_receipts WHERE task_id=$1',[t.taskId])).rows).toHaveLength(1);
 });
 it('skips an older revoked unassigned administrator task before bounded pagination',async()=>{
  const id=await customer(ops,ops);await c.query("UPDATE crm_customers SET owner_user_id=NULL,state='draft',origin='operations' WHERE customer_id=$1",[id]);
  const blocked=unwrap(await service.create(ops.token,{customerId:id,title:'Old operations task',dueAt:'2010-01-01T00:00:00Z',expectedCustomerVersion:1,idempotencyKey:randomUUID()}));
  await c.query("UPDATE identity.product_access SET capabilities='[\"leads.develop\"]' WHERE user_id=$1 AND product_id='crm'",[ops.id]);
  const live=await task();expect(unwrap(await repo.processDue(1))).toBe(1);expect(await event(blocked)).toBeUndefined();expect(await event(live)).toBeTruthy();
 });
 it('database rejects null completion feedback and migration remains repeatable',async()=>{
  const t=await task();await c.query('SAVEPOINT bad_completion');
  await expect(c.query("UPDATE crm_followup_tasks SET status='completed',completed_by=$2,completed_at=now() WHERE task_id=$1",[t.taskId,sales.id])).rejects.toMatchObject({code:'23514'});
  await c.query('ROLLBACK TO SAVEPOINT bad_completion');await c.query('RELEASE SAVEPOINT bad_completion');
  unwrap(await repo.migrate());expect(unwrap(await service.detail(sales.token,t.taskId))).toMatchObject({status:'open',version:1});
 });
 it('projects persistent feed only to current responsible and suppresses already dispatched notices after postponement',async()=>{
  const n=await notificationRepo(),t=await task();unwrap(await repo.processDue(50));unwrap(await n.dispatch());
  const feed=unwrap(await n.feed(sales.hash,{deviceId:'rollback-b3',after:'0',limit:100}));const notice=feed.items.find(x=>x.customerId===t.customerId&&x.eventType==='crm.task.due');expect(notice).toBeTruthy();
  expect(unwrap(await n.feed(other.hash,{deviceId:'rollback-b3',after:'0',limit:100})).items.some(x=>x.customerId===t.customerId)).toBe(false);
  unwrap(await service.reschedule(sales.token,{...command(t),dueAt:'2099-01-01T00:00:00Z'}));
  expect(unwrap(await n.feed(sales.hash,{deviceId:'rollback-b3',after:'0',limit:100})).items.some(x=>x.customerId===t.customerId)).toBe(false);
  expect(await n.read(sales.hash,notice!.id)).toMatchObject({error:{code:'NOT_FOUND'}});
 });
});
