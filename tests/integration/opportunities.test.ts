import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { createHash,randomUUID } from 'node:crypto';
import { Pool,type PoolClient } from 'pg';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresOpportunityRepository } from '../../server/adapters/postgres/opportunity-repository';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresTaskRepository } from '../../server/adapters/postgres/task-repository';
import { PostgresNotificationRepository } from '../../server/adapters/postgres/notification-repository';
import { createLeadService } from '../../server/services/leads';
import { createTaskService } from '../../server/services/tasks';
import { createOpportunityService } from '../../server/services/opportunities';
import type { CrmRole } from '../../server/core/auth';
import type { Opportunity } from '../../server/core/opportunities';
import type { Result } from '../../server/core/crm';
const enabled=process.env.PROSPECTOR_OPPORTUNITY_TEST==='1',TIMEOUT=30000;
const log={write:()=>{}},tokens={hash:(t:string)=>createHash('sha256').update(t).digest('hex')};
function unwrap<T>(r:Result<T>):T{if(!r.ok)throw Error(`${r.error.code}: ${r.error.message}`);return r.data;}
type User={id:string;token:string};
describe.skipIf(!enabled)('opportunities PostgreSQL rollback-only',()=>{
 let pool:Pool,c:PoolClient,wrapped:Pool,repo:PostgresOpportunityRepository,service:ReturnType<typeof createOpportunityService>,sales:User,other:User,ops:User,admin:User;
 beforeEach(async()=>{
  pool=new Pool(readTestDatabaseConfig());c=await pool.connect();await c.query('BEGIN');
  wrapped={options:pool.options,connect:async()=>({release:()=>{},query:async(sql:string,p?:unknown[])=>{
   if(sql==='BEGIN')return c.query('SAVEPOINT opportunity_operation');if(sql==='COMMIT')return c.query('RELEASE SAVEPOINT opportunity_operation');
   if(sql==='ROLLBACK'){await c.query('ROLLBACK TO SAVEPOINT opportunity_operation');return c.query('RELEASE SAVEPOINT opportunity_operation');}return c.query(sql,p);
  }})} as unknown as Pool;
  repo=new PostgresOpportunityRepository(wrapped,log);service=createOpportunityService(repo,tokens as never);unwrap(await repo.migrate());
  sales=await user('sales');other=await user('sales');ops=await user('operations');admin=await user('admin');
 },TIMEOUT);
 afterEach(async()=>{if(c){await c.query('ROLLBACK');c.release();}if(pool)await pool.end();},TIMEOUT);
 async function user(role:CrmRole):Promise<User>{const id=randomUUID(),token=Buffer.from(randomUUID()+randomUUID()).toString('base64url').slice(0,43);await c.query('INSERT INTO identity.users(user_id,display_name,active) VALUES($1,$2,true)',[id,'Rollback opportunity user']);await c.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[id,role]);await c.query("INSERT INTO identity.product_access(user_id,product_id,scope) VALUES($1,'crm',$2)",[id,role==='sales'?'own':role==='admin'?'summary':'shared']);await c.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) SELECT $1,user_id,security_revision,now()+interval '1 hour','api' FROM identity.users WHERE user_id=$2",[tokens.hash(token),id]);return {id,token};}
 async function customer(owner=sales,creator=sales){const co=await c.query("INSERT INTO companies(name) VALUES('Rollback opportunity customer') RETURNING id");const r=await c.query("INSERT INTO crm_customers(company_id,source,customer_key,source_detail,state,owner_user_id,created_by,origin) VALUES($1,'rollback-opportunity',$2,'synthetic','owned',$3,$4,$5) RETURNING customer_id",[co.rows[0].id,randomUUID(),owner.id,creator.id,creator===owner?'personal':'operations']);return r.rows[0].customer_id as string;}
 function creation(customerId:string,extra:Record<string,unknown>={}){return {customerId,expectedCustomerVersion:1,idempotencyKey:randomUUID(),title:'Shanghai to Hamburg',pol:'Shanghai',pod:'Hamburg',containerType:'40HC',...extra};}
 async function opportunity(customerId?:string,extra:Record<string,unknown>={}):Promise<Opportunity>{return unwrap(await service.create(sales.token,creation(customerId??await customer(),extra)));}
 function command(o:Opportunity,stage:string,extra:Record<string,unknown>={}){return {opportunityId:o.opportunityId,expectedVersion:o.version,idempotencyKey:randomUUID(),stage,...extra};}
 async function assertConstraint(sql:string,p:unknown[],code:string){await c.query('SAVEPOINT check_constraint');try{await expect(c.query(sql,p)).rejects.toMatchObject({code});}finally{await c.query('ROLLBACK TO SAVEPOINT check_constraint');await c.query('RELEASE SAVEPOINT check_constraint');}}
 it('migrates idempotently without backfill and protects required customer and immutable history',async()=>{
  const id=await customer();unwrap(await repo.migrate());expect((await c.query('SELECT 1 FROM crm_opportunities WHERE customer_id=$1',[id])).rows).toHaveLength(0);
  await assertConstraint('INSERT INTO crm_opportunities(title,created_by) VALUES($1,$2)',['No customer',sales.id],'23502');
  await assertConstraint('INSERT INTO crm_opportunities(customer_id,title,created_by) VALUES($1,$2,$3)',[randomUUID(),'Foreign customer',sales.id],'23503');
  const o=await opportunity(id);expect(o.history).toHaveLength(1);expect(o.history[0]).toMatchObject({fromStage:null,toStage:'inquiry',amount:null,currency:null});
  await assertConstraint('UPDATE crm_opportunity_stage_history SET to_stage=$2 WHERE opportunity_id=$1',[o.opportunityId,'quote_sent'],'23514');await assertConstraint('DELETE FROM crm_opportunity_stage_history WHERE opportunity_id=$1',[o.opportunityId],'23514');
 });
 it('keeps two routes independent, preserves customer stage/version, and atomically snapshots events',async()=>{
  const id=await customer(),before=(await c.query('SELECT version,relationship_stage FROM crm_customers WHERE customer_id=$1',[id])).rows[0];const a=await opportunity(id),b=await opportunity(id,{pod:'Singapore',title:'Shanghai to Singapore'});
  const next=unwrap(await service.updateStage(sales.token,command(a,'booking_confirmed',{amount:'123.45',currency:'CNY'})));expect(next.version).toBe(2);expect(next.history[1]).toMatchObject({fromStage:'inquiry',toStage:'booking_confirmed',amount:'123.45',currency:'CNY'});expect(unwrap(await service.detail(sales.token,b.opportunityId)).stage).toBe('inquiry');expect((await c.query('SELECT version,relationship_stage FROM crm_customers WHERE customer_id=$1',[id])).rows[0]).toEqual(before);
  expect(unwrap(await service.list(sales.token,{customerId:id,limit:1,offset:0}))).toMatchObject({total:2,items:[expect.anything()]});
  const events=(await c.query("SELECT payload FROM identity.outbox WHERE customer_id=$1 AND event_type='crm.opportunity.stage_changed'",[id])).rows;expect(events).toEqual([{payload:{customerId:id,version:1,opportunityId:a.opportunityId,opportunityVersion:2}}]);
 });
 it('deduplicates writes and returns current authorized data on retries, rejects payload reuse and stale writes',async()=>{
  const id=await customer(),input=creation(id);const a=unwrap(await service.create(sales.token,input));expect(unwrap(await service.create(sales.token,input)).opportunityId).toBe(a.opportunityId);expect(await service.create(sales.token,{...input,title:'Changed'})).toMatchObject({error:{code:'CONFLICT'}});
  const change=command(a,'quote_sent'),next=unwrap(await service.updateStage(sales.token,change));expect(await service.updateStage(sales.token,command(a,'negotiation'))).toMatchObject({error:{code:'CONFLICT'}});const advanced=unwrap(await service.updateStage(sales.token,command(next,'negotiation')));expect(unwrap(await service.updateStage(sales.token,change)).version).toBe(advanced.version);expect(unwrap(await service.create(sales.token,input)).version).toBe(advanced.version);expect(advanced.history).toHaveLength(3);
  await c.query("UPDATE identity.product_access SET capabilities='[\"leads.claim\"]'::jsonb WHERE user_id=$1 AND product_id='crm'",[sales.id]);expect(await service.create(sales.token,input)).toMatchObject({error:{code:'NOT_FOUND'}});expect(await service.updateStage(sales.token,change)).toMatchObject({error:{code:'NOT_FOUND'}});
 });
 it('allows forward jumps, requires won amount+currency+evidence or lost reason, prohibits reopening/backwards, and leaves same stage unchanged',async()=>{
  const a=await opportunity();expect(await service.updateStage(sales.token,command(a,'closed_won',{evidence:'PO 123'}))).toMatchObject({error:{code:'INVALID_INPUT'}});
  const quoted=unwrap(await service.updateStage(sales.token,command(a,'quote_sent',{amount:'100',currency:'EUR'})));expect(await service.updateStage(sales.token,command(quoted,'inquiry'))).toMatchObject({error:{code:'CONFLICT'}});
  const same=unwrap(await service.updateStage(sales.token,command(quoted,'quote_sent')));expect(same.version).toBe(quoted.version);expect(same.history).toHaveLength(2);expect(await service.updateStage(sales.token,command(quoted,'quote_sent',{amount:'200',currency:'EUR'}))).toMatchObject({error:{code:'INVALID_INPUT'}});
  const won=unwrap(await service.updateStage(sales.token,command(quoted,'closed_won',{evidence:'PO 123'})));expect(won).toMatchObject({amount:'100.00',currency:'EUR',evidence:'PO 123',closedBy:sales.id});expect(won.closedAt).not.toBeNull();expect(await service.updateStage(sales.token,command(won,'negotiation'))).toMatchObject({error:{code:'CONFLICT'}});expect(unwrap(await service.updateStage(sales.token,command(won,'closed_won',{evidence:'PO 123'}))).version).toBe(won.version);
  const lost=unwrap(await service.updateStage(sales.token,command(await opportunity(),'closed_lost',{lostReason:'Cancelled'})));expect(lost.lostReason).toBe('Cancelled');expect(await service.updateStage(sales.token,command(lost,'inquiry'))).toMatchObject({error:{code:'CONFLICT'}});
 });
 it('rechecks current customer visibility, manager capability, session revision and product grants',async()=>{
  const id=await customer(sales,ops),o=await opportunity(id);expect(unwrap(await service.detail(ops.token,o.opportunityId)).canManage).toBe(false);expect(await service.updateStage(ops.token,command(o,'quote_sent'))).toMatchObject({error:{code:'FORBIDDEN'}});expect(await service.detail(other.token,o.opportunityId)).toMatchObject({error:{code:'NOT_FOUND'}});expect(await service.list(other.token,{customerId:id,limit:25,offset:0})).toMatchObject({error:{code:'NOT_FOUND'}});expect(unwrap(await service.detail(admin.token,o.opportunityId)).canManage).toBe(true);
  await c.query("UPDATE identity.product_access SET capabilities='[\"leads.read.all\"]'::jsonb WHERE user_id=$1 AND product_id='crm'",[admin.id]);expect(unwrap(await service.detail(admin.token,o.opportunityId)).canManage).toBe(false);expect(await service.updateStage(admin.token,command(o,'quote_sent'))).toMatchObject({error:{code:'FORBIDDEN'}});
  await c.query('UPDATE identity.users SET security_revision=security_revision+1 WHERE user_id=$1',[sales.id]);expect(await service.detail(sales.token,o.opportunityId)).toMatchObject({error:{code:'UNAUTHORIZED'}});await c.query("UPDATE identity.product_grants SET active=false WHERE user_id=$1 AND product_id='crm'",[ops.id]);expect(await service.detail(ops.token,o.opportunityId)).toMatchObject({error:{code:'UNAUTHORIZED'}});
 });
 it('projects transferred owners and invalidates only open opportunity versions including old retries',async()=>{
  const id=await customer(sales,ops),input=creation(id),a=unwrap(await service.create(sales.token,input)),b=await opportunity(id);const won=unwrap(await service.updateStage(sales.token,command(b,'closed_won',{evidence:'PO',amount:'1',currency:'USD'})));
  await c.query('UPDATE crm_customers SET owner_user_id=$2,version=version+1 WHERE customer_id=$1',[id,other.id]);expect(await service.create(sales.token,input)).toMatchObject({error:{code:'NOT_FOUND'}});expect(unwrap(await service.detail(other.token,a.opportunityId))).toMatchObject({ownerUserId:other.id,version:2,canManage:true});expect(unwrap(await service.detail(other.token,won.opportunityId))).toMatchObject({ownerUserId:other.id,version:won.version});expect(await service.updateStage(other.token,command(a,'quote_sent'))).toMatchObject({error:{code:'CONFLICT'}});
 });
 it('rolls back row, history, idempotency and event together when outbox fails',async()=>{
  const o=await opportunity();await c.query("CREATE FUNCTION crm_opportunity_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$");await c.query(`CREATE TRIGGER crm_opportunity_test_failure BEFORE INSERT ON identity.outbox FOR EACH ROW WHEN (NEW.customer_id='${o.customerId}'::uuid) EXECUTE FUNCTION crm_opportunity_test_failure()`);const change=command(o,'quote_sent');expect(await service.updateStage(sales.token,change)).toMatchObject({error:{code:'DATABASE_ERROR'}});expect(unwrap(await service.detail(sales.token,o.opportunityId))).toMatchObject({version:1,history:[expect.anything()]});expect((await c.query('SELECT 1 FROM crm_lead_idempotency WHERE actor_id=$1 AND key=$2',[sales.id,change.idempotencyKey])).rows).toHaveLength(0);expect(await service.create(sales.token,creation(o.customerId))).toMatchObject({error:{code:'DATABASE_ERROR'}});expect((await c.query('SELECT 1 FROM crm_opportunities WHERE customer_id=$1',[o.customerId])).rows).toHaveLength(1);
 });
 it('enforces same-customer composite references for tasks and activities',async()=>{
  const o=await opportunity(),foreign=await customer();await assertConstraint('INSERT INTO crm_followup_tasks(customer_id,opportunity_id,title,due_at,created_by) VALUES($1,$2,$3,now(),$4)',[foreign,o.opportunityId,'Call',sales.id],'23503');await assertConstraint('INSERT INTO crm_shared_activities(customer_id,opportunity_id,actor_id,note) VALUES($1,$2,$3,$4)',[foreign,o.opportunityId,sales.id,'Call'],'23503');
 });
 it('links actual followup and task writes, rejects foreign opportunities, and preserves omitted associations',async()=>{
  const o=await opportunity(),foreign=await opportunity(),leads=createLeadService(new PostgresLeadRepository(wrapped,log),tokens as never),tasks=createTaskService(new PostgresTaskRepository(wrapped,log),tokens as never);
  const followup={customerId:o.customerId,expectedVersion:1,idempotencyKey:randomUUID(),note:'Call about Hamburg',method:'phone',opportunityId:o.opportunityId};
  expect(await leads.followup(sales.token,{...followup,opportunityId:foreign.opportunityId})).toMatchObject({error:{code:'INVALID_INPUT'}});
  const linked=unwrap(await leads.followup(sales.token,followup));expect(linked.activities[0]).toMatchObject({opportunityId:o.opportunityId,opportunityTitle:o.title});expect(linked.stage).toBe('cold');
  const unlinked=unwrap(await leads.followup(sales.token,{customerId:o.customerId,expectedVersion:linked.version,idempotencyKey:randomUUID(),note:'Customer-level note',method:'note'}));expect(unlinked.activities).toContainEqual(expect.objectContaining({opportunityId:null,note:'Customer-level note'}));
  const task={customerId:o.customerId,expectedCustomerVersion:unlinked.version,idempotencyKey:randomUUID(),title:'Follow Hamburg',dueAt:'2099-01-01T00:00:00Z',opportunityId:o.opportunityId};
  expect(await tasks.create(sales.token,{...task,opportunityId:foreign.opportunityId})).toMatchObject({error:{code:'INVALID_INPUT'}});expect(unwrap(await tasks.create(sales.token,task))).toMatchObject({opportunityId:o.opportunityId,opportunityTitle:o.title});
  const oldTask=unwrap(await tasks.create(sales.token,{customerId:o.customerId,expectedCustomerVersion:unlinked.version,idempotencyKey:randomUUID(),title:'Customer next step',dueAt:'2099-01-01T00:00:00Z'}));expect(oldTask.opportunityId).toBeNull();expect(unwrap(await service.detail(sales.token,o.opportunityId))).toMatchObject({stage:'inquiry',version:1});
 });
 it('dispatches both opportunity events only to authorized readers and revalidates feed/read after transfer',async()=>{
  // Keep this rollback fixture independent of administrators seeded by other suites.
  await c.query('UPDATE identity.users SET active=false WHERE user_id<>ALL($1::uuid[])',[[sales.id,ops.id,admin.id,other.id]]);
  const notifications=new PostgresNotificationRepository(wrapped,log);
  // Existing unrelated outbox events are not this rollback fixture's work.
  await c.query('INSERT INTO crm_notification_consumed(event_id) SELECT event_id FROM identity.outbox WHERE NOT EXISTS(SELECT 1 FROM crm_notification_consumed x WHERE x.event_id=identity.outbox.event_id)');
  const id=await customer(sales,ops),o=await opportunity(id);unwrap(await service.updateStage(sales.token,command(o,'quote_sent')));unwrap(await notifications.dispatch());unwrap(await notifications.dispatch());
  const query={deviceId:'opportunity-rollback',after:'0',limit:100};
  const feeds=[];for(const user of [sales,ops,admin,other])feeds.push(unwrap(await notifications.feed(tokens.hash(user.token),query)));
  for(const feed of feeds.slice(0,3)){const notices=feed.items.filter(x=>x.customerId===id);expect(notices.map(x=>x.eventType).sort()).toEqual(['crm.opportunity.created','crm.opportunity.stage_changed']);expect(notices.every(x=>x.opportunityId===o.opportunityId&&x.canOpen&&x.summary?.note===o.title)).toBe(true);}
  expect(feeds[3]!.items.some(x=>x.customerId===id)).toBe(false);const deliveries=(await c.query("SELECT recipient_user_id FROM crm_event_deliveries WHERE customer_id=$1 AND event_type IN ('crm.opportunity.created','crm.opportunity.stage_changed')",[id])).rows;expect(deliveries).toHaveLength(6);expect(deliveries.some(x=>x.recipient_user_id===other.id)).toBe(false);
  const notice=feeds[0]!.items.find(x=>x.customerId===id)!;unwrap(await notifications.read(tokens.hash(sales.token),notice.id));expect(unwrap(await notifications.feed(tokens.hash(sales.token),query)).items.find(x=>x.id===notice.id)?.read).toBe(true);expect(await notifications.read(tokens.hash(other.token),notice.id)).toMatchObject({error:{code:'NOT_FOUND'}});
  await c.query('UPDATE crm_customers SET owner_user_id=$2,version=version+1 WHERE customer_id=$1',[id,other.id]);expect(unwrap(await notifications.feed(tokens.hash(sales.token),query)).items.some(x=>x.customerId===id)).toBe(false);expect(await notifications.read(tokens.hash(sales.token),notice.id)).toMatchObject({error:{code:'NOT_FOUND'}});
 });
});
