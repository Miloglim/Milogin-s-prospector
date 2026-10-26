import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {Pool} from 'pg';
import {readTestDatabaseConfig} from '../../server/adapters/postgres/config';
import {PostgresNotificationRepository} from '../../server/adapters/postgres/notification-repository';
import {PostgresLeadRepository} from '../../server/adapters/postgres/lead-repository';
import {PostgresAuthRepository} from '../../server/adapters/postgres/auth-repository';
import {PostgresCrmRepository} from '../../server/adapters/postgres/repository';
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
 let pool:Pool,repo:PostgresNotificationRepository,customer:string,hash:string,raw:string;
 beforeAll(async()=>{
  pool=new Pool(readTestDatabaseConfig());expect((await new PostgresCrmRepository(pool,log).migrate()).ok).toBe(true);expect((await new PostgresAuthRepository(pool,log).migrate()).ok).toBe(true);expect((await new PostgresLeadRepository(pool,log).migrate()).ok).toBe(true);repo=new PostgresNotificationRepository(pool,log);expect((await repo.migrate()).ok).toBe(true);
  for(const [user,role,scope] of [[op,'operations','shared'],[sales,'sales','own'],[other,'sales','own']]){
   await pool.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)',[user,'synthetic notification']);await pool.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[user,role]);await pool.query("INSERT INTO identity.product_access(user_id,product_id,scope) VALUES($1,'crm',$2)",[user,scope]);
  }
  raw=randomBytes(32).toString('base64url');hash=tokenAdapter.hash(raw);await pool.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')",[hash,sales]);
  const company=await pool.query('INSERT INTO companies(name) VALUES($1) RETURNING id',['notification synthetic '+key]);const c=await pool.query("INSERT INTO crm_customers(company_id,source,customer_key,source_detail,state,created_by) VALUES($1,$2,$2,'synthetic','published',$3) RETURNING customer_id",[company.rows[0].id,key,op]);customer=c.rows[0].customer_id;
 },30000);
 afterAll(async()=>{await pool?.end();});
 async function event(type='crm.lead.published',db:Pool|import('pg').PoolClient=pool){const result=await db.query("INSERT INTO identity.outbox(event_type,user_id,product_id,revision,customer_id,payload) VALUES($1,$2,'crm',1,$3,$4) RETURNING event_id",[type,op,customer,JSON.stringify({customerId:customer,version:1})]);return result.rows[0].event_id;}
 it('crash rollback creates no feed gap; consumer repeat deduplicates; independent devices replay',async()=>{
  const tx=await pool.connect();await tx.query('BEGIN');const discarded=await event('crm.lead.published',tx);await tx.query('ROLLBACK');tx.release();expect((await pool.query('SELECT 1 FROM identity.outbox WHERE event_id=$1',[discarded])).rows).toHaveLength(0);
  const id=await event();expect((await repo.dispatch()).ok).toBe(true);expect((await repo.dispatch()).ok).toBe(true);
  const first=await repo.feed(hash,{deviceId:'desktop-a',after:'0',limit:50});expect(first.ok).toBe(true);if(!first.ok)throw Error('feed');expect(first.data.items.filter(n=>n.customerId===customer)).toHaveLength(1);
  const second=await repo.feed(hash,{deviceId:'desktop-b',after:'0',limit:50});expect(second).toEqual(first);
  expect((await pool.query('SELECT * FROM crm_event_deliveries WHERE event_id=$1 AND recipient_user_id=$2',[id,sales])).rows).toHaveLength(1);
  expect((await repo.read(hash,first.data.items[0]!.id)).ok).toBe(true);const read=await repo.feed(hash,{deviceId:'desktop-b',after:'0',limit:50});expect(read.ok&&read.data.items[0]!.read).toBe(true);
 });
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
  const id=await pool.query("INSERT INTO identity.outbox(event_type,user_id,product_id,revision,payload) VALUES('identity.product.updated',$1,'crm',1,$2) RETURNING event_id",[op,JSON.stringify({sensitive:'must never project'})]);await repo.dispatch();const restart=new PostgresNotificationRepository(pool,log);await restart.dispatch();expect((await pool.query('SELECT * FROM crm_event_deliveries WHERE event_id=$1',[id.rows[0].event_id])).rows).toEqual([]);
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
   await pool.query("UPDATE identity.product_access SET capabilities='[]' WHERE user_id=$1 AND product_id='crm'",[sales]);expect((await reader.read()).done).toBe(true);
   await pool.query("UPDATE identity.product_access SET capabilities=NULL WHERE user_id=$1 AND product_id='crm'",[sales]);
  }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 },10000);
 it('old events are filtered by current owner and advance scanned cursor; revoked capability/access/password deny',async()=>{
  await pool.query("UPDATE crm_customers SET state='owned',owner_user_id=$2 WHERE customer_id=$1",[customer,other]);const feed=await repo.feed(hash,{deviceId:'desktop-a',after:'0',limit:50});expect(feed.ok&&feed.data.items.filter(item=>item.customerId===customer)).toEqual([]);expect(feed.ok&&BigInt(feed.data.nextCursor)>0n).toBe(true);
  await pool.query('UPDATE identity.users SET must_change_password=true WHERE user_id=$1',[sales]);expect(await repo.watermark(hash)).toMatchObject({ok:false,error:{code:'PASSWORD_CHANGE_REQUIRED'}});await pool.query('UPDATE identity.users SET must_change_password=false WHERE user_id=$1',[sales]);
  await pool.query("UPDATE identity.product_access SET active=false WHERE user_id=$1 AND product_id='crm'",[sales]);expect((await repo.feed(hash,{deviceId:'desktop-a',after:'0',limit:50})).ok).toBe(false);
 });
});
