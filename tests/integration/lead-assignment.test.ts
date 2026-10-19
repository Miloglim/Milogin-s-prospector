import {describe,it,beforeAll,afterAll,expect} from 'vitest';
import {Pool} from 'pg';
import {createServer} from 'node:http';
import {createContactAssignmentService} from '../../server/services/contact-assignments';
import {createContactAssignmentHandler} from '../../server/transport/contact-assignments-http';
import {createCrmHandler} from '../../server/transport/crm-http';
import {randomUUID,randomBytes} from 'node:crypto';
import {readTestDatabaseConfig} from '../../server/adapters/postgres/config';
import {PostgresCrmRepository} from '../../server/adapters/postgres/repository';
import {PostgresAuthRepository} from '../../server/adapters/postgres/auth-repository';
import {PostgresLeadRepository} from '../../server/adapters/postgres/lead-repository';
import {PostgresNotificationRepository} from '../../server/adapters/postgres/notification-repository';
import {capabilitiesFor} from '../../server/core/admin';
import {tokenAdapter} from '../../server/adapters/password';
import {createLeadService} from '../../server/services/leads';
import type {Result} from '../../server/core/crm';
import type {CrmRole} from '../../server/core/auth';
const TIMEOUT=30000,SESSION_SECONDS=3600;const log={write:()=>{}};
function unwrap<T>(r:Result<T>):T{if(!r.ok)throw Error(`${r.error.code}: ${r.error.message}`);return r.data;}
type Member={id:string;token:string};let pool:Pool,repo:PostgresLeadRepository,notifications:PostgresNotificationRepository,service:ReturnType<typeof createLeadService>,ops:Member,sales:Member,extra:Member,other:Member,admin:Member;
let actions:ReturnType<typeof createContactAssignmentService>;
const source=`r3-${randomUUID()}`;
async function fixture(role:CrmRole){const id=randomUUID(),token=randomBytes(32).toString('base64url');await pool.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)',[id,`${source} ${role}`]);await pool.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[id,role]);await pool.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)",[id,role==='operations'?'shared':role==='admin'?'summary':'own',JSON.stringify(capabilitiesFor([role]))]);await pool.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+$3*interval '1 second','api')",[tokenAdapter.hash(token),id,SESSION_SECONDS]);return {id,token};}
async function lead(){const key=randomUUID();return unwrap(await service.importRows(ops.token,{source,sourceDetail:'synthetic',idempotencyKey:key,rows:[{customerKey:key,companyName:'R3_SECRET_COMPANY',email:`${key}@example.invalid`}]}));}
async function feed(m:Member){return unwrap(await notifications.feed(tokenAdapter.hash(m.token),{deviceId:'r3',after:'0',limit:100}));}
async function dispatchAll(){for(let n=0;n<20;n++)unwrap(await notifications.dispatch());}
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('R3 directed assignment PostgreSQL',()=>{
 beforeAll(async()=>{pool=new Pool(readTestDatabaseConfig());unwrap(await new PostgresCrmRepository(pool,log).migrate());unwrap(await new PostgresAuthRepository(pool,log).migrate());repo=new PostgresLeadRepository(pool,log);unwrap(await repo.migrate());notifications=new PostgresNotificationRepository(pool,log);unwrap(await notifications.migrate());service=createLeadService(repo,tokenAdapter);actions=createContactAssignmentService(repo,tokenAdapter);ops=await fixture('operations');sales=await fixture('sales');extra=await fixture('auditor');other=await fixture('sales');admin=await fixture('admin');},TIMEOUT);
 afterAll(async()=>{await pool?.end();});
 it('paginates product members, marks sales only, and rejects sales directory access',async()=>{const page=unwrap(await service.members(ops.token,{search:source,limit:2,offset:0}));expect(page.total).toBe(5);expect(page.items).toHaveLength(2);const all=unwrap(await service.members(ops.token,{search:source,limit:100,offset:0}));expect(all.items.find(x=>x.userId===sales.id)?.assignable).toBe(true);expect(all.items.find(x=>x.userId===extra.id)?.assignable).toBe(false);expect((await service.members(sales.token,{search:'',limit:10,offset:0}))).toMatchObject({error:{code:'FORBIDDEN'}});expect((await service.members(ops.token,{search:'',limit:101,offset:0})).ok).toBe(false);});
 async function selected(){const r=await lead(),customerId=r.rows[0]!.customerId!,d=unwrap(await service.detail(ops.token,customerId));return {customerId,contactId:d.contacts[0]!.contactId};}
 function command(ref:{customerId:string;contactId:number}){return {contacts:[{...ref,expectedVersion:1}],targetUserId:sales.id,notifyUserIds:[extra.id,admin.id],idempotencyKey:randomUUID()};}
 it('requires acceptance, deduplicates requests and projects explicit extras safely',async()=>{
  const ref=await selected(),input=command(ref),request=unwrap(await actions.createAssignments(ops.token,input)).items[0]!;
  expect(request.status).toBe('pending');expect(unwrap(await actions.createAssignments(ops.token,input)).items[0]!.requestId).toBe(request.requestId);
  expect(await actions.contactDetail(sales.token,ref)).toMatchObject({error:{code:'NOT_FOUND'}});
  const decision={requestId:request.requestId,expectedVersion:1,idempotencyKey:randomUUID()};
  expect(await actions.decide(other.token,'accept',decision)).toMatchObject({error:{code:'NOT_FOUND'}});
  const accepted=unwrap(await actions.decide(sales.token,'accept',decision));expect(accepted.status).toBe('accepted');expect(unwrap(await actions.decide(sales.token,'accept',decision))).toEqual(accepted);
  const detail=unwrap(await actions.contactDetail(sales.token,ref));expect(detail.contact.ownerUserId).toBe(sales.id);
  expect(await actions.contactDetail(other.token,ref)).toMatchObject({error:{code:'NOT_FOUND'}});
  expect(await actions.contactDetail(extra.token,ref)).toMatchObject({error:{code:'NOT_FOUND'}});
  const event=await pool.query("SELECT * FROM identity.outbox WHERE customer_id=$1 AND event_type='crm.contact.assignment.requested'",[ref.customerId]);expect(event.rows).toHaveLength(1);expect(event.rows[0].recipient_user_ids.sort()).toEqual([ops.id,sales.id,extra.id,admin.id].sort());
  await dispatchAll();const notice=(await feed(extra)).items.find(x=>x.requestId===request.requestId)!;expect(notice).toMatchObject({canOpen:false,customerId:'',version:0});expect(JSON.stringify(notice)).not.toContain('@example.invalid');
  expect((await feed(sales)).items).toContainEqual(expect.objectContaining({customerId:ref.customerId,canOpen:true}));expect((await feed(other)).items.some(x=>x.requestId===request.requestId)).toBe(false);
  unwrap(await notifications.read(tokenAdapter.hash(extra.token),notice.id));
  unwrap(await actions.contactFollowup(sales.token,{...ref,expectedVersion:detail.contact.contactVersion,idempotencyKey:randomUUID(),note:'R3 synthetic feedback'}));
  expect(unwrap(await actions.contactDetail(ops.token,ref)).activities[0]!.note).toBe('R3 synthetic feedback');await dispatchAll();expect((await feed(ops)).items).toContainEqual(expect.objectContaining({customerId:ref.customerId,eventType:'crm.contact.followup'}));
  await pool.query("UPDATE identity.product_access SET active=false WHERE user_id=$1 AND product_id='crm'",[extra.id]);try{expect((await notifications.feed(tokenAdapter.hash(extra.token),{deviceId:'r3',after:'0',limit:100})).ok).toBe(false);expect((await notifications.read(tokenAdapter.hash(extra.token),notice.id)).ok).toBe(false);}finally{await pool.query("UPDATE identity.product_access SET active=true WHERE user_id=$1 AND product_id='crm'",[extra.id]);}
 },TIMEOUT);
 it('serializes competing requests and rejects unauthorized, stale and revoked targets',async()=>{
  const ref=await selected(),input=command(ref);
  expect(await actions.createAssignments(sales.token,input)).toMatchObject({error:{code:'FORBIDDEN'}});
  expect((await actions.createAssignments(ops.token,{...input,targetUserId:extra.id})).ok).toBe(false);
  await pool.query('UPDATE identity.users SET active=false WHERE user_id=$1',[sales.id]);try{expect(await actions.createAssignments(ops.token,input)).toMatchObject({error:{code:'INVALID_INPUT'}});}finally{await pool.query('UPDATE identity.users SET active=true WHERE user_id=$1',[sales.id]);}
  expect(await actions.createAssignments(ops.token,{...input,contacts:[{...ref,expectedVersion:2}]})).toMatchObject({error:{code:'CONFLICT'}});
  const results=await Promise.all([actions.createAssignments(ops.token,input),actions.createAssignments(ops.token,{...input,idempotencyKey:randomUUID(),targetUserId:other.id})]);expect(results.filter(x=>x.ok)).toHaveLength(1);
  expect((await pool.query("SELECT 1 FROM crm_contact_assignment_requests WHERE contact_id=$1 AND status='pending'",[ref.contactId])).rows).toHaveLength(1);
  const protectedRef=await selected();await pool.query("UPDATE identity.product_access SET capabilities='[]' WHERE user_id=$1 AND product_id='crm'",[ops.id]);try{expect(await actions.createAssignments(ops.token,command(protectedRef))).toMatchObject({error:{code:'FORBIDDEN'}});}finally{await pool.query("UPDATE identity.product_access SET capabilities=$2 WHERE user_id=$1 AND product_id='crm'",[ops.id,JSON.stringify(capabilitiesFor(['operations']))]);}
 },TIMEOUT);
 it('rolls back a pending request when its outbox insert fails',async()=>{
  const ref=await selected(),trigger=`r3_${ref.customerId.replace(/-/g,'')}`;
  await pool.query("CREATE OR REPLACE FUNCTION crm_r3_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; RETURN NEW; END $$");await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON identity.outbox FOR EACH ROW WHEN (NEW.customer_id='${ref.customerId}'::uuid) EXECUTE FUNCTION crm_r3_failure()`);
  try{expect(await actions.createAssignments(ops.token,command(ref))).toMatchObject({error:{code:'DATABASE_ERROR'}});expect(unwrap(await actions.contactDetail(ops.token,ref)).contact).toMatchObject({contactVersion:1,ownerUserId:null});expect((await pool.query('SELECT 1 FROM crm_contact_assignment_requests WHERE contact_id=$1',[ref.contactId])).rows).toHaveLength(0);}finally{await pool.query(`DROP TRIGGER ${trigger} ON identity.outbox`);}
 },TIMEOUT);
 it('routes member lookup, request and acceptance over HTTP and blocks the retired direct assignment route',async()=>{
  const crm=createCrmHandler(service),contacts=createContactAssignmentHandler(actions),server=createServer((req,res)=>{void (req.url?.startsWith('/api/crm/contact')?contacts:crm)(req,res);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`,headers={authorization:`Bearer ${ops.token}`,'content-type':'application/json'};
   expect(await (await fetch(`${base}/api/crm/members?search=${source}&limit=2&offset=1`,{headers})).json()).toMatchObject({ok:true,data:{total:5}});
   const ref=await selected();const response=await fetch(base+'/api/crm/contact-assignments',{method:'POST',headers,body:JSON.stringify(command(ref))});const body=await response.json();expect(body.ok).toBe(true);
   const decision={requestId:body.data.items[0].requestId,expectedVersion:1,idempotencyKey:randomUUID()};
   const bad=await fetch(`${base}/api/crm/contact-assignments/${decision.requestId}/accept`,{method:'POST',headers:{...headers,authorization:`Bearer ${sales.token}`},body:JSON.stringify({...decision,requestId:randomUUID()})});expect(await bad.json()).toMatchObject({error:{code:'INVALID_INPUT'}});
   const accepted=await fetch(`${base}/api/crm/contact-assignments/${decision.requestId}/accept`,{method:'POST',headers:{...headers,authorization:`Bearer ${sales.token}`},body:JSON.stringify(decision)});expect(await accepted.json()).toMatchObject({ok:true,data:{status:'accepted'}});
   const retired=await fetch(`${base}/api/crm/leads/${ref.customerId}/assign`,{method:'POST',headers,body:JSON.stringify({customerId:ref.customerId,expectedVersion:1,idempotencyKey:randomUUID(),salesUserId:sales.id,notifyUserIds:[]})});expect(await retired.json()).toMatchObject({error:{code:'CONFLICT'}});
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 },TIMEOUT);
});
