import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {readTestDatabaseConfig} from '../../server/adapters/postgres/config';
import {PostgresNotificationRepository} from '../../server/adapters/postgres/notification-repository';
import {PostgresLeadRepository} from '../../server/adapters/postgres/lead-repository';
import {PostgresAuthRepository} from '../../server/adapters/postgres/auth-repository';
import {PostgresCrmRepository} from '../../server/adapters/postgres/repository';
import {PostgresTeamRepository} from '../../server/adapters/postgres/team-repository';
import {PostgresContactMailAnalysisRepository} from '../../server/adapters/postgres/contact-mail-analysis-repository';
import {PostgresTeamAttentionRepository} from '../../server/adapters/postgres/team-attention-repository';
import {PostgresTaskRepository} from '../../server/adapters/postgres/task-repository';
import {migrateLeadMatchSchema} from '../../server/adapters/postgres/lead-match-schema';
import {TEAM_ATTENTION_EVENTS} from '../../server/core/team-attention';
import {tokenAdapter} from '../../server/adapters/password';
import {createServer} from 'node:http';
import {createEventsHandler} from '../../server/transport/events-http';
import {createNotificationService} from '../../server/services/notifications';
const tokens={hash:(v:string)=>v,create:()=>''};
describe('notification bounded contract',()=>{
 it('rejects malformed cursors and devices before touching storage',async()=>{
  const repo={feed:()=>{throw Error('must not call');}} as any;
  const service=createNotificationService(repo,tokens);
  expect((await service.feed('token',{deviceId:'device',after:'-1',limit:50})).ok).toBe(false);
  expect((await service.feed('token',{deviceId:'',after:'0',limit:50})).ok).toBe(false);
 });
});
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('actual PostgreSQL durable notifications',()=>{
 const log={write:()=>{}},op=randomUUID(),sales=randomUUID(),other=randomUUID(),key=randomUUID();
 let pool:Pool,repo:PostgresNotificationRepository,customer:string,companyId:number,hash:string,raw:string,opHash:string,memberHash:string;
 beforeAll(async()=>{
  pool=new Pool(readTestDatabaseConfig());
  expect(await new PostgresCrmRepository(pool,log).migrate()).toMatchObject({ok:true});
  expect(await new PostgresAuthRepository(pool,log).migrate()).toMatchObject({ok:true});
  const leadRepo=new PostgresLeadRepository(pool,log);
  expect(await leadRepo.migrate()).toMatchObject({ok:true});
  expect(await new PostgresTeamRepository(pool,log).migrate()).toMatchObject({ok:true});
  expect(await leadRepo.migrateAssignmentState()).toMatchObject({ok:true});
  const matchDb=await pool.connect();
  try{await matchDb.query('BEGIN');expect(await migrateLeadMatchSchema(matchDb)).toMatchObject({ok:true});await matchDb.query('COMMIT');}finally{matchDb.release();}
  expect(await new PostgresTaskRepository(pool,log).migrate()).toMatchObject({ok:true});
  expect(await new PostgresContactMailAnalysisRepository(pool,log).migrate()).toMatchObject({ok:true});
  repo=new PostgresNotificationRepository(pool,log);
  expect(await repo.migrate()).toMatchObject({ok:true});
  for(const [user,role,scope] of [[op,'operations','shared'],[sales,'sales','own'],[other,'sales','own']]){
   await pool.query('INSERT INTO public.identity_users(user_id,display_name) VALUES($1,$2)',[user,'synthetic notification']);await pool.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[user,role]);await pool.query("INSERT INTO public.identity_product_access(user_id,product_id,scope) VALUES($1,'crm',$2)",[user,scope]);
  }
  raw=randomBytes(32).toString('base64url');hash=tokenAdapter.hash(raw);await pool.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')",[hash,sales]);
  opHash=tokenAdapter.hash(randomBytes(32).toString('base64url'));memberHash=tokenAdapter.hash(randomBytes(32).toString('base64url'));await pool.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api'),($3,$4,1,now()+interval '1 hour','api')",[opHash,op,memberHash,other]);
  const company=await pool.query('INSERT INTO companies(name) VALUES($1) RETURNING id',['notification synthetic '+key]);companyId=company.rows[0].id;const c=await pool.query("INSERT INTO crm_customers(company_id,source,customer_key,source_detail,state,created_by) VALUES($1,$2,$2,'synthetic','published',$3) RETURNING customer_id",[company.rows[0].id,key,op]);customer=c.rows[0].customer_id;
 },30000);
 afterAll(async()=>{await pool?.end();});
 async function event(type='crm.lead.published',db:Pool|import('pg').PoolClient=pool){const result=await db.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload) VALUES($1,$2,'crm',1,$3,$4) RETURNING event_id",[type,op,customer,JSON.stringify({customerId:customer,version:1})]);return result.rows[0].event_id;}
 async function recipientEvent(type:string,recipients:string[]){const requestId=randomUUID(),result=await pool.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,'crm',1,$3,$4,$5::uuid[]) RETURNING event_id",[type,op,customer,JSON.stringify({customerId:customer,version:1,requestId,contactName:'Synthetic'}),recipients]);return {id:result.rows[0].event_id as string,requestId};}
 it('projects expired and transfer assignment events for explicit recipients without ordinary contact access',async()=>{
  const expired=await recipientEvent('crm.contact.assignment.expired',[sales]),transfer=await recipientEvent('crm.contact.assignment.transfer_requested',[sales]);expect((await repo.dispatch()).ok).toBe(true);
  const feed=await repo.feed(hash,{deviceId:'assignment-events',after:'0',limit:100,latest:true});if(!feed.ok)throw Error(feed.error.message);expect(feed.data.items.filter(item=>item.requestId===expired.requestId||item.requestId===transfer.requestId).map(item=>item.eventType)).toEqual(expect.arrayContaining(['crm.contact.assignment.expired','crm.contact.assignment.transfer_requested']));
  const ids=[expired.id,transfer.id];await pool.query('DELETE FROM crm_event_deliveries WHERE event_id=ANY($1::uuid[])',[ids]);await pool.query('DELETE FROM crm_notification_consumed WHERE event_id=ANY($1::uuid[])',[ids]);await pool.query('DELETE FROM public.identity_outbox WHERE event_id=ANY($1::uuid[])',[ids]);
 });
 it('projects team attention to the direct supervisor with server-derived open access',async()=>{
  await pool.query("INSERT INTO crm_org_units(kind,name) VALUES('company','Synthetic Attention Company') ON CONFLICT DO NOTHING");
  const root=(await pool.query("SELECT unit_id FROM crm_org_units WHERE kind='company' LIMIT 1")).rows[0].unit_id;
  const teamId=randomUUID();await pool.query("INSERT INTO crm_org_units(unit_id,kind,parent_unit_id,name,created_by) VALUES($1,'sales_team',$2,$3,$4)",[teamId,root,'Attention Team '+key.slice(0,8),op]);
  await pool.query("INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary) VALUES($1,$2,'leader',true),($3,$2,'member',false)",[sales,teamId,other]);
  const contact=(await pool.query('INSERT INTO contacts(email,company_id,first_name) VALUES($1,$2,$3) RETURNING id',[`attention-${key}@example.invalid`,companyId,'Attention'])).rows[0].id;
  await pool.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)',[customer,contact]);
  const itemId=randomUUID();await pool.query("INSERT INTO crm_team_attention_items(item_id,target_member_user_id,source_supervisor_user_id,customer_id,contact_id,reason,priority) VALUES($1,$2,$3,$4,$5,'important_reply','urgent')",[itemId,other,sales,customer,contact]);
  const attentionRepo=new PostgresTeamAttentionRepository(pool,log),query={limit:25,offset:0,targetMemberUserId:other};
  const memberView=await attentionRepo.list(memberHash,query);expect(memberView).toMatchObject({ok:true,data:{scope:'member',items:[{canResolve:true,canAcknowledge:false,canDismiss:false}]}});
  const supervisorView=await attentionRepo.list(hash,query);expect(supervisorView).toMatchObject({ok:true,data:{scope:'supervisor',items:[{canResolve:false,canAcknowledge:true,canDismiss:true}]}});
  const oversightView=await attentionRepo.list(opHash,query);expect(oversightView).toMatchObject({ok:true,data:{scope:'oversight',items:[{canResolve:false,canAcknowledge:false,canDismiss:false}]}});
  expect(await attentionRepo.transition(opHash,{itemId,action:'dismiss',expectedVersion:1,idempotencyKey:randomUUID()})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
  const event=(await pool.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,customer_id,payload,recipient_user_ids) VALUES($1,$2,'crm',1,$3,$4,$5::uuid[]) RETURNING event_id",[TEAM_ATTENTION_EVENTS.opened,sales,customer,JSON.stringify({attentionItemId:itemId,attentionVersion:1,attentionStatus:'open',targetMemberUserId:other,sourceSupervisorUserId:sales,reason:'important_reply'}),[sales,other]])).rows[0].event_id;
  expect((await repo.dispatch()).ok).toBe(true);
  const feed=await repo.feed(hash,{deviceId:'team-attention-events',after:'0',limit:100,latest:true});if(!feed.ok)throw Error(feed.error.message);
  const projected=feed.data.items.find(item=>item.eventType===TEAM_ATTENTION_EVENTS.opened&&item.taskId===itemId);expect(projected).toMatchObject({canOpen:true,contactId:contact,customerId:customer});
  const delivery=await pool.query("SELECT delivery_id FROM crm_event_deliveries WHERE event_id=$1 AND recipient_user_id=$2",[event,sales]);expect((await repo.read(hash,delivery.rows[0].delivery_id)).ok).toBe(true);
  await pool.query("DELETE FROM crm_org_assignments WHERE user_id=$1 AND unit_id=$2 AND role='leader'",[sales,teamId]);
  expect(await repo.read(hash,delivery.rows[0].delivery_id)).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
  const revoked=await repo.feed(hash,{deviceId:'team-attention-events',after:'0',limit:100,latest:true});if(!revoked.ok)throw Error(revoked.error.message);expect(revoked.data.items.find(item=>item.taskId===itemId)).toMatchObject({canOpen:false,customerId:''});
  await pool.query('DELETE FROM crm_notification_reads WHERE delivery_id=$1',[delivery.rows[0].delivery_id]);await pool.query('DELETE FROM crm_event_deliveries WHERE event_id=$1',[event]);await pool.query('DELETE FROM crm_notification_consumed WHERE event_id=$1',[event]);await pool.query('DELETE FROM public.identity_outbox WHERE event_id=$1',[event]);
  await pool.query('DELETE FROM crm_team_attention_items WHERE item_id=$1',[itemId]);await pool.query('DELETE FROM crm_customer_contacts WHERE customer_id=$1 AND contact_id=$2',[customer,contact]);await pool.query('DELETE FROM contacts WHERE id=$1',[contact]);await pool.query('DELETE FROM crm_org_assignments WHERE unit_id=$1',[teamId]);await pool.query('DELETE FROM crm_org_units WHERE unit_id=$1',[teamId]);
 },30000);
 it('crash rollback creates no feed gap; consumer repeat deduplicates; independent devices replay',async()=>{
  const tx=await pool.connect();await tx.query('BEGIN');const discarded=await event('crm.lead.published',tx);await tx.query('ROLLBACK');tx.release();expect((await pool.query('SELECT 1 FROM public.identity_outbox WHERE event_id=$1',[discarded])).rows).toHaveLength(0);
  const id=await event();expect((await repo.dispatch()).ok).toBe(true);expect((await repo.dispatch()).ok).toBe(true);
  const first=await repo.feed(hash,{deviceId:'desktop-a',after:'0',limit:50});expect(first.ok).toBe(true);if(!first.ok)throw Error('feed');expect(first.data.items.filter(n=>n.customerId===customer)).toHaveLength(1);
  const second=await repo.feed(hash,{deviceId:'desktop-b',after:'0',limit:50});expect(second).toEqual(first);
  expect((await pool.query('SELECT * FROM crm_event_deliveries WHERE event_id=$1 AND recipient_user_id=$2',[id,sales])).rows).toHaveLength(1);
  expect((await repo.read(hash,first.data.items[0]!.id)).ok).toBe(true);const read=await repo.feed(hash,{deviceId:'desktop-b',after:'0',limit:50});expect(read.ok&&read.data.items[0]!.read).toBe(true);
 },15000);
 it('marks every current user delivery read in one idempotent command',async()=>{
  await event();await event();expect((await repo.dispatch()).ok).toBe(true);
  const bulk=await repo.readAll(hash);expect(bulk.ok&&bulk.data.marked).toBeGreaterThanOrEqual(2);
  const again=await repo.readAll(hash);expect(again).toEqual({ok:true,data:{marked:0}});
  const feed=await repo.feed(hash,{deviceId:'read-all',after:'0',limit:50});expect(feed.ok).toBe(true);if(!feed.ok)throw Error('feed');
  expect(feed.data.items.filter(n=>n.customerId===customer).every(n=>n.read)).toBe(true);
 });
 it('out-of-order event transactions receive ordered committed user cursors',async()=>{
  const tx=await pool.connect();await tx.query('BEGIN');const late=await event('crm.lead.published',tx);const earlier=await event();expect((await repo.dispatch()).ok).toBe(true);await tx.query('COMMIT');tx.release();expect((await repo.dispatch()).ok).toBe(true);
  const rows=await pool.query('SELECT event_id,delivery_seq::text FROM crm_event_deliveries WHERE recipient_user_id=$1 AND event_id=ANY($2::uuid[]) ORDER BY delivery_seq',[sales,[late,earlier]]);expect(rows.rows.map(r=>r.event_id)).toEqual([earlier,late]);
 });
 it('does not notify the creator about their own customer creation event',async()=>{
  const id=await event('crm.customer.created');expect((await repo.dispatch()).ok).toBe(true);
  const delivery=await pool.query('SELECT 1 FROM crm_event_deliveries WHERE event_id=$1 AND recipient_user_id=$2',[id,op]);expect(delivery.rows).toHaveLength(0);
 });
 it('ignores management payloads and restart does not duplicate committed projections',async()=>{
  const id=await pool.query("INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision,payload) VALUES('identity.product.updated',$1,'crm',1,$2) RETURNING event_id",[op,JSON.stringify({sensitive:'must never project'})]);await repo.dispatch();const restart=new PostgresNotificationRepository(pool,log);await restart.dispatch();expect((await pool.query('SELECT * FROM crm_event_deliveries WHERE event_id=$1',[id.rows[0].event_id])).rows).toEqual([]);
 });
 it('rolls back head allocation and deliveries when consumer crashes before marking consumed',async()=>{
  const id=await event(),name='notif_failure_'+randomUUID().replaceAll('-','');
  const before=await pool.query('SELECT delivery_seq::text FROM crm_feed_heads WHERE user_id=$1',[sales]);
  // Fault is restricted to this synthetic UUID in the guarded test database.
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${id}'::uuid THEN RAISE EXCEPTION 'synthetic notification crash'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON crm_notification_consumed FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{expect((await repo.dispatch()).ok).toBe(false);expect((await pool.query('SELECT * FROM crm_event_deliveries WHERE event_id=$1',[id])).rows).toEqual([]);expect((await pool.query('SELECT delivery_seq::text FROM crm_feed_heads WHERE user_id=$1',[sales])).rows).toEqual(before.rows);}
  finally{await pool.query(`DROP TRIGGER ${name} ON crm_notification_consumed`);await pool.query(`DROP FUNCTION ${name}()`);}
  expect((await repo.dispatch()).ok).toBe(true);const after=await pool.query('SELECT delivery_seq::text FROM crm_feed_heads WHERE user_id=$1',[sales]);expect(BigInt(after.rows[0].delivery_seq)).toBe(BigInt(before.rows[0].delivery_seq)+1n);
 });
 it('streams only cursor hints and closes after capability revocation',async()=>{
  const handler=createEventsHandler(createNotificationService(repo,tokenAdapter));const server=createServer((req,res)=>{void handler(req,res);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
   const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;const marked=await fetch(`${base}/api/crm/notifications/read-all`,{method:'POST',headers:{Authorization:`Bearer ${raw}`}});expect(await marked.json()).toMatchObject({ok:true,data:{marked:expect.any(Number)}});
   const url=`${base}/api/crm/events?deviceId=sse-test&after=0`;const response=await fetch(url,{headers:{Authorization:`Bearer ${raw}`}});expect(response.status).toBe(200);const reader=response.body!.getReader();const frame=new TextDecoder().decode((await reader.read()).value);expect(frame).toContain('event: change');expect(frame).not.toContain(customer);expect(frame).not.toContain('sensitive');
   await pool.query("UPDATE public.identity_product_access SET capabilities='[]' WHERE user_id=$1 AND product_id='crm'",[sales]);expect((await reader.read()).done).toBe(true);
   await pool.query("UPDATE public.identity_product_access SET capabilities=NULL WHERE user_id=$1 AND product_id='crm'",[sales]);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 },10000);
 it('keeps only the latest 100 messages and persists read state across devices and restarts',async()=>{
  const ids:string[]=[];try{
   for(let index=0;index<105;index++)ids.push(await event('crm.lead.published'));
   for(let index=0;index<3;index++)expect((await repo.dispatch()).ok).toBe(true);
   const latest=await repo.feed(hash,{deviceId:'latest-a',after:'0',limit:100,latest:true});if(!latest.ok)throw Error(latest.error.message);
   const watermark=await repo.watermark(hash);if(!watermark.ok)throw Error(watermark.error.message);
   expect(latest.data.items).toHaveLength(100);expect(latest.data.hasMore).toBe(false);expect(BigInt(latest.data.nextCursor)).toBe(BigInt(watermark.data));
   const retained=await pool.query('SELECT count(*)::int AS count FROM crm_event_deliveries WHERE recipient_user_id=$1',[sales]);expect(retained.rows[0].count).toBe(100);
   const first=latest.data.items[0]!;expect((await repo.read(hash,first.id)).ok).toBe(true);
   const restarted=new PostgresNotificationRepository(pool,log);const otherDevice=await restarted.feed(hash,{deviceId:'latest-b',after:'0',limit:100,latest:true});if(!otherDevice.ok)throw Error(otherDevice.error.message);
   expect(otherDevice.data.items).toHaveLength(100);expect(otherDevice.data.items.find(item=>item.id===first.id)?.read).toBe(true);
  }finally{
   await pool.query('DELETE FROM crm_notification_reads WHERE delivery_id IN(SELECT delivery_id FROM crm_event_deliveries WHERE event_id=ANY($1::uuid[]))',[ids]);
   await pool.query('DELETE FROM crm_event_deliveries WHERE event_id=ANY($1::uuid[])',[ids]);
   await pool.query('DELETE FROM crm_notification_consumed WHERE event_id=ANY($1::uuid[])',[ids]);
   await pool.query('DELETE FROM public.identity_outbox WHERE event_id=ANY($1::uuid[])',[ids]);
  }
 },30000);
 it('old events are filtered by current owner and advance scanned cursor; revoked capability/access/password deny',async()=>{
  await pool.query("UPDATE crm_customers SET state='owned',owner_user_id=$2 WHERE customer_id=$1",[customer,other]);const feed=await repo.feed(hash,{deviceId:'desktop-a',after:'0',limit:50});expect(feed.ok&&feed.data.items.filter(item=>item.customerId===customer)).toEqual([]);expect(feed.ok&&BigInt(feed.data.nextCursor)>0n).toBe(true);
  await pool.query('UPDATE public.identity_users SET must_change_password=true WHERE user_id=$1',[sales]);expect(await repo.watermark(hash)).toMatchObject({ok:false,error:{code:'PASSWORD_CHANGE_REQUIRED'}});await pool.query('UPDATE public.identity_users SET must_change_password=false WHERE user_id=$1',[sales]);
  await pool.query("UPDATE public.identity_product_access SET active=false WHERE user_id=$1 AND product_id='crm'",[sales]);expect((await repo.feed(hash,{deviceId:'desktop-a',after:'0',limit:50})).ok).toBe(false);
 },10000);
});
