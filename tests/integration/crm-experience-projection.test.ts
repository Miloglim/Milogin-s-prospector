import {describe,it,beforeAll,afterAll,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {readTestDatabaseConfig} from '../../server/adapters/postgres/config';
import {PostgresCrmRepository} from '../../server/adapters/postgres/repository';
import {PostgresAuthRepository} from '../../server/adapters/postgres/auth-repository';
import {PostgresLeadRepository} from '../../server/adapters/postgres/lead-repository';
import {PostgresNotificationRepository} from '../../server/adapters/postgres/notification-repository';
import {tokenAdapter} from '../../server/adapters/password';
import {capabilitiesFor} from '../../server/core/admin';
import {createLeadService} from '../../server/services/leads';
import {createNotificationService} from '../../server/services/notifications';
import {createContactAssignmentService} from '../../server/services/contact-assignments';
import {createContactAssignmentHandler} from '../../server/transport/contact-assignments-http';
import {createCrmHandler} from '../../server/transport/crm-http';
import {createEventsHandler} from '../../server/transport/events-http';
import type {Result} from '../../server/core/crm';
import type {CrmRole} from '../../server/core/auth';
const TIMEOUT=30000,ROW_COUNT=31,PAGE_SIZE=25;
const source=`ux-${randomUUID()}`,log={write:()=>{}};
type Member={id:string;token:string;name:string};
let pool:Pool,server:Server,base:string,service:ReturnType<typeof createLeadService>,notifications:PostgresNotificationRepository;
let actions:ReturnType<typeof createContactAssignmentService>;
let ops:Member,sales:Member,other:Member,extra:Member;
function unwrap<T>(r:Result<T>):T{if(!r.ok)throw Error(r.error.code);return r.data;}
async function member(role:CrmRole):Promise<Member>{
 const id=randomUUID(),token=randomBytes(32).toString('base64url'),name=`${source} ${role}`;
 await pool.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)',[id,name]);
 await pool.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[id,role]);
 await pool.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)",[id,role==='operations'?'shared':'own',JSON.stringify(capabilitiesFor([role]))]);
 await pool.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')",[tokenAdapter.hash(token),id]);
 return {id,token,name};
}
async function get(path:string,actor:Member=ops){const response=await fetch(base+path,{headers:{authorization:`Bearer ${actor.token}`}});return {status:response.status,body:await response.json() as any};}
async function dispatch(){
 // A batch containing only non-projected management events returns zero deliveries but may leave later events queued.
 while(true){unwrap(await notifications.dispatch());const remaining=await pool.query('SELECT 1 FROM identity.outbox o WHERE NOT EXISTS(SELECT 1 FROM crm_notification_consumed c WHERE c.event_id=o.event_id) LIMIT 1');if(!remaining.rows.length)return;}
}
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('CRM experience authorized PostgreSQL/HTTP projections',()=>{
 beforeAll(async()=>{
  pool=new Pool(readTestDatabaseConfig());unwrap(await new PostgresCrmRepository(pool,log).migrate());unwrap(await new PostgresAuthRepository(pool,log).migrate());
  const leads=new PostgresLeadRepository(pool,log);unwrap(await leads.migrate());notifications=new PostgresNotificationRepository(pool,log);unwrap(await notifications.migrate());
  service=createLeadService(leads,tokenAdapter);actions=createContactAssignmentService(leads,tokenAdapter);ops=await member('operations');sales=await member('sales');other=await member('sales');extra=await member('auditor');
  const contacts=createContactAssignmentHandler(actions),crm=createCrmHandler(service),events=createEventsHandler(createNotificationService(notifications,tokenAdapter));
  server=createServer((request,response)=>{void (request.url?.startsWith('/api/crm/notifications')?events:request.url?.startsWith('/api/crm/contacts/')||request.url?.startsWith('/api/crm/contact-assignments')?contacts:crm)(request,response);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 },TIMEOUT);
 afterAll(async()=>{if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}await pool?.end();});
 it('filters full authorized results before count and pagination and preserves public pool redaction',async()=>{
  const rows=Array.from({length:ROW_COUNT},(_,index)=>({customerKey:randomUUID(),companyName:`${source} Company ${index}`,email:`${randomUUID()}@example.invalid`}));
  const imported=unwrap(await service.importRows(ops.token,{source,sourceDetail:'Synthetic UX',idempotencyKey:randomUUID(),rows}));
  const query=`/api/crm/leads?view=operations&search=${source}&limit=${PAGE_SIZE}&assignment=unassigned&stage=cold`;
  const first=await get(query);expect(first.body.data.total).toBe(ROW_COUNT);expect(first.body.data.items).toHaveLength(PAGE_SIZE);
  const second=await get(query+`&offset=${PAGE_SIZE}`);expect(second.body.data.total).toBe(ROW_COUNT);expect(second.body.data.items).toHaveLength(ROW_COUNT-PAGE_SIZE);
  expect(new Set([...first.body.data.items,...second.body.data.items].map(x=>x.customerId)).size).toBe(ROW_COUNT);
  expect((await get(query,sales)).status).toBe(403);expect((await get(`/api/crm/leads?view=assigned&search=${source}`,other)).body.data.total).toBe(0);
  for(const suffix of ['assignment=wrong','stage=wrong','assignment=','stage='])expect((await get(`/api/crm/leads?view=operations&${suffix}`)).status).toBe(400);
  const pausedId=imported.rows[ROW_COUNT-1]!.customerId!;
  await pool.query("UPDATE crm_customers SET state='paused' WHERE customer_id=$1",[pausedId]);
  expect((await get(query)).body.data.total).toBe(ROW_COUNT-1);
  const operations=(await get(`/api/crm/leads?view=operations&search=${source}&limit=100`)).body.data;expect(operations.total).toBe(ROW_COUNT);expect(operations.items).toContainEqual(expect.objectContaining({customerId:pausedId,state:'paused'}));
  expect(unwrap(await service.detail(ops.token,pausedId)).canAssign).toBe(false);
  const assignedId=imported.rows[0]!.customerId!,poolId=imported.rows[1]!.customerId!;
  const detail=unwrap(await service.detail(ops.token,assignedId)),ref={customerId:assignedId,contactId:detail.contacts[0]!.contactId};
  const pending=unwrap(await actions.createAssignments(ops.token,{contacts:[{...ref,expectedVersion:1}],targetUserId:sales.id,notifyUserIds:[],idempotencyKey:randomUUID()})).items[0]!;
  unwrap(await actions.decide(sales.token,'accept',{requestId:pending.requestId,expectedVersion:1,idempotencyKey:randomUUID()}));
  unwrap(await actions.contactFollowup(sales.token,{...ref,expectedVersion:2,idempotencyKey:randomUUID(),note:'A real synthetic activity',stage:'quoting',method:'email',contactStatus:'contacted'}));
  const contactQuery=`/api/crm/contacts?search=${source}&limit=${PAGE_SIZE}`;
  const page=await get(contactQuery),next=await get(contactQuery+`&offset=${PAGE_SIZE}`);expect(page.body.data.total).toBe(ROW_COUNT);expect(page.body.data.items).toHaveLength(PAGE_SIZE);expect(next.body.data.items).toHaveLength(ROW_COUNT-PAGE_SIZE);
  expect(new Set([...page.body.data.items,...next.body.data.items].map((x:any)=>x.contactId)).size).toBe(ROW_COUNT);
  const assigned=await get(`/api/crm/contacts?search=${source}&assignment=accepted&crmStage=quoting`);expect(assigned.body.data.total).toBe(1);expect(assigned.body.data.items[0]).toMatchObject({customerId:assignedId,ownerName:sales.name,relationshipStage:'quoting'});
  expect(unwrap(await actions.contactDetail(ops.token,ref)).activities[0]!.note).toBe('A real synthetic activity');
  expect((await get(`/api/crm/contacts?scope=assigned&search=${source}`,sales)).body.data.total).toBe(1);expect((await get(`/api/crm/contacts?scope=assigned&search=${source}`,other)).body.data.total).toBe(0);
  unwrap(await service.publish(ops.token,imported.batchId,{rowIds:[imported.rows[1]!.rowId],expectedVersion:1,idempotencyKey:randomUUID()}));
  const published=(await get(`/api/crm/leads?view=pool&search=${source}`,other)).body.data.items.find((x:any)=>x.customerId===poolId);
  expect(published).toBeTruthy();for(const field of ['ownerName','recentActivityAt','stage','primaryContactEmail'])expect(published).not.toHaveProperty(field);
  expect((await get('/api/crm/leads?view=pool&stage=quoting',other)).status).toBe(400);
 },TIMEOUT);
 it('returns current authorized summaries and exact timeline notes without notify-only contact access',async()=>{
  const imported=unwrap(await service.importRows(ops.token,{source,sourceDetail:'Synthetic UX',idempotencyKey:randomUUID(),rows:[{customerKey:randomUUID(),companyName:'UX confidential company',email:`${randomUUID()}@example.invalid`}]}));
  const id=imported.rows[0]!.customerId!,d=unwrap(await service.detail(ops.token,id)),ref={customerId:id,contactId:d.contacts[0]!.contactId};
  const pending=unwrap(await actions.createAssignments(ops.token,{contacts:[{...ref,expectedVersion:1}],targetUserId:sales.id,notifyUserIds:[extra.id],idempotencyKey:randomUUID()})).items[0]!;
  unwrap(await actions.decide(sales.token,'accept',{requestId:pending.requestId,expectedVersion:1,idempotencyKey:randomUUID()}));
  unwrap(await actions.contactFollowup(sales.token,{...ref,expectedVersion:2,idempotencyKey:randomUUID(),note:'First exact activity'}));
  unwrap(await actions.contactFollowup(sales.token,{...ref,expectedVersion:3,idempotencyKey:randomUUID(),note:'Second exact activity'}));
  const detail=unwrap(await actions.contactDetail(ops.token,ref));expect(detail.activities.map(x=>x.note).sort()).toEqual(['First exact activity','Second exact activity']);expect(detail.activities.map(x=>x.actorName)).toEqual([sales.name,sales.name]);
  await pool.query('UPDATE companies SET name=$2 WHERE id=(SELECT company_id FROM crm_customers WHERE customer_id=$1)',[id,'UX current company']);await pool.query('UPDATE identity.users SET display_name=$2 WHERE user_id=$1',[sales.id,'Current actor name']);await dispatch();
  const url='/api/crm/notifications?deviceId=ux&after=0&limit=100',feed=(await get(url,sales)).body.data.items.filter((x:any)=>x.customerId===id);
  expect(feed).toHaveLength(4);expect(feed.every((x:any)=>x.summary.companyName==='UX current company')).toBe(true);expect(feed.filter((x:any)=>x.eventType==='crm.contact.followup').every((x:any)=>x.summary.actorName==='Current actor name')).toBe(true);
  const notify=(await get(url,extra)).body.data.items.find((x:any)=>x.requestId===pending.requestId);expect(notify).toMatchObject({canOpen:false,customerId:'',version:0,assignmentStatus:'accepted',summary:{companyName:'UX current company'}});expect(JSON.stringify(notify)).not.toContain('@example.invalid');expect(notify).not.toHaveProperty('contactId');
  const payloads=(await pool.query('SELECT payload FROM identity.outbox WHERE customer_id=$1',[id])).rows;expect(JSON.stringify(payloads)).not.toContain('exact activity');
  await pool.query('UPDATE crm_contact_assignment_requests SET target_user_id=$2 WHERE request_id=$1',[pending.requestId,other.id]);
  const revoked=(await get(url,sales)).body.data.items.filter((x:any)=>x.requestId===pending.requestId);expect(revoked.length).toBeGreaterThan(0);expect(revoked.every((x:any)=>!x.canOpen&&x.customerId==='')).toBe(true);expect((await get(url,sales)).body.data.items.some((x:any)=>x.customerId===id&&x.eventType==='crm.contact.followup')).toBe(false);
  expect((await get(`/api/crm/contacts/${ref.contactId}?customerId=${id}`,sales)).status).toBe(404);
  await pool.query("UPDATE identity.product_access SET active=false WHERE user_id=$1 AND product_id='crm'",[extra.id]);expect((await get(url,extra)).status).toBe(403);
 },TIMEOUT);
});
