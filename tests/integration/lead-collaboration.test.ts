import {describe,it,beforeAll,afterAll,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {readTestDatabaseConfig} from '../../server/adapters/postgres/config';
import {PostgresCrmRepository} from '../../server/adapters/postgres/repository';
import {PostgresAuthRepository} from '../../server/adapters/postgres/auth-repository';
import {PostgresLeadRepository} from '../../server/adapters/postgres/lead-repository';
import {PostgresNotificationRepository} from '../../server/adapters/postgres/notification-repository';
import {capabilitiesFor} from '../../server/core/admin';
import {tokenAdapter} from '../../server/adapters/password';
import type {Result} from '../../server/core/crm';
import type {CrmRole} from '../../server/core/auth';
import {createLeadService} from '../../server/services/leads';
import {createContactAssignmentService} from '../../server/services/contact-assignments';
const TIMEOUT=30000,SESSION_SECONDS=3600;
const log={write:()=>{}};
function unwrap<T>(r:Result<T>):T{if(!r.ok)throw Error(`${r.error.code}: ${r.error.message}`);return r.data;}
let pool:Pool,repo:PostgresLeadRepository,service:ReturnType<typeof createLeadService>,ops:string,salesA:string,salesB:string,opsId:string,aId:string,bId:string;
const source=`m2-${randomUUID()}`;
async function fixture(role:CrmRole){const id=randomUUID(),token=randomBytes(32).toString('base64url');await pool.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)',[id,`synthetic ${role}`]);await pool.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[id,role]);await pool.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)",[id,role==='operations'?'shared':'own',JSON.stringify(capabilitiesFor([role]))]);await pool.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+$3*interval '1 second','api')",[tokenAdapter.hash(token),id,SESSION_SECONDS]);return {id,token};}
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('M2 real PostgreSQL lead ownership',()=>{
 beforeAll(async()=>{pool=new Pool(readTestDatabaseConfig());unwrap(await new PostgresCrmRepository(pool,log).migrate());unwrap(await new PostgresAuthRepository(pool,log).migrate());repo=new PostgresLeadRepository(pool,log);unwrap(await repo.migrate());unwrap(await new PostgresNotificationRepository(pool,log).migrate());service=createLeadService(repo,tokenAdapter);const o=await fixture('operations'),a=await fixture('sales'),b=await fixture('sales');ops=o.token;opsId=o.id;salesA=a.token;aId=a.id;salesB=b.token;bId=b.id;},TIMEOUT);
 afterAll(async()=>{await pool?.end();});
 it('imports a flat lead sheet into one company with separate channels and per-contact sources',async()=>{
  const companyName=`Flat company ${source}`;
  const rows=[
   {customerKey:`flat-${source}`,companyName,country:'Brazil',customerType:'代理',businessType:'海运',website:'https://example.invalid',name:'Alice',email:`flat-a-${source}@example.invalid`,phone:'+55 111',whatsapp:'+55 222',sourceLevel1:'展会',sourceLevel2:'上海展'},
   {customerKey:`flat-${source}`,companyName,country:'Brazil',customerType:'代理',name:'Bob',email:'',phone:'+55 333',whatsapp:'+55 444',sourceLevel1:'网络',sourceLevel2:'LinkedIn'},
  ];
  const input={source:`flat-${source}`,sourceDetail:'synthetic flat sheet',companyMatching:true,idempotencyKey:randomUUID(),rows};
  const result=unwrap(await service.importRows(ops,input));
  expect(result.rows.map(row=>row.status)).toEqual(['created','created']);
  expect(result.rows[0]!.customerId).toBe(result.rows[1]!.customerId);
  const stored=await pool.query(`SELECT co.customer_type,co.industry,co.domain,ct.first_name,ct.phone,ct.whatsapp,ct.source_level1,ct.source_level2 FROM contacts ct JOIN companies co ON co.id=ct.company_id WHERE co.name=$1 ORDER BY ct.id`,[companyName]);
  expect(stored.rows).toEqual([
   {customer_type:'代理',industry:'海运',domain:'https://example.invalid',first_name:'Alice',phone:'+55 111',whatsapp:'+55 222',source_level1:'展会',source_level2:'上海展'},
   {customer_type:'代理',industry:'海运',domain:'https://example.invalid',first_name:'Bob',phone:'+55 333',whatsapp:'+55 444',source_level1:'网络',source_level2:'LinkedIn'},
  ]);
  const listed=unwrap(await service.contacts(ops,{search:companyName,clientType:'agent',limit:25,offset:0}));
  expect(listed.items).toHaveLength(2);expect(listed.items.every(row=>row.clientType==='agent')).toBe(true);
  expect(listed.items.every(row=>row.businessType==='海运'&&row.website==='https://example.invalid')).toBe(true);
  expect(listed.items.find(row=>row.firstName==='Alice')).toMatchObject({phone:'+55 111',whatsapp:'+55 222',sourceLevel1:'展会',sourceLevel2:'上海展'});
  expect(unwrap(await service.importRows(ops,{...input,idempotencyKey:randomUUID()})).rows.map(row=>row.status)).toEqual(['duplicate','duplicate']);
  const conflict=unwrap(await service.importRows(ops,{...input,idempotencyKey:randomUUID(),rows:[{...rows[0]!,customerType:'直客',email:`flat-conflict-${source}@example.invalid`}]}));
  expect(conflict.rows[0]!.status).toBe('restricted_conflict');
  expect((await pool.query('SELECT customer_type FROM companies WHERE name=$1',[companyName])).rows[0].customer_type).toBe('代理');
 });
 it('isolates oversized row errors, normalizes evidence keys and retries corrected rows without duplicating successful customers',async()=>{
  const item={customerKey:' normalized ',companyName:'Synthetic normalized',email:`NORMAL-${source}@example.invalid`};
  const input={source:`repair-${source}`,sourceDetail:'import repair fixture',idempotencyKey:randomUUID(),rows:[item,{...item}, {customerKey:'fix',companyName:'x'.repeat(501),email:`fix-${source}@example.invalid`}]};
  const receipt=unwrap(await service.importRows(ops,input));expect(receipt.rows.map(row=>row.status)).toEqual(['created','duplicate','invalid']);
  expect(unwrap(await service.importRows(ops,input))).toEqual(receipt);
  const fixed={...input,idempotencyKey:randomUUID(),rows:[{customerKey:'fix',companyName:'Synthetic fixed',email:`fix-${source}@example.invalid`}]};
  const correction=unwrap(await service.importRows(ops,fixed));expect(correction.rows[0]!.status).toBe('created');expect(unwrap(await service.importRows(ops,fixed))).toEqual(correction);
  const count=await pool.query('SELECT count(*)::int AS count FROM crm_customers WHERE source=$1',[input.source]);expect(count.rows[0].count).toBe(2);
  const stored=await pool.query('SELECT customer_key FROM crm_customers WHERE customer_id=$1',[receipt.rows[0]!.customerId]);expect(stored.rows[0].customer_key).toBe('normalized');
 });
 it('preserves mixed raw rows, groups contacts by evidence keys, and retries exactly once',async()=>{
  const input={source,sourceDetail:'synthetic import',idempotencyKey:randomUUID(),mapping:{companyName:'Company'},rows:[{customerKey:'one',companyName:'Synthetic one',email:`a-${source}@example.invalid`,rawRow:{Company:'Synthetic one',Original:'<script>source</script>'}},{customerKey:'one',companyName:'Synthetic one',email:`b-${source}@example.invalid`},{customerKey:'bad',companyName:'',email:'bad'}]};
  const result=unwrap(await service.importRows(ops,input));expect(result.rows.map(r=>r.status)).toEqual(['created','created','invalid']);expect(result.rows[0]!.customerId).toBe(result.rows[1]!.customerId);expect(unwrap(await service.importRows(ops,input))).toEqual(result);expect((await service.importRows(ops,{...input,sourceDetail:'changed'})).ok).toBe(false);
  const raw=await pool.query('SELECT raw_row FROM crm_import_rows WHERE row_id=$1',[result.rows[0]!.rowId]);expect(raw.rows[0].raw_row.rawRow.Original).toBe('<script>source</script>');
  expect((await service.publish(ops,result.batchId,{rowIds:result.rows.map(r=>r.rowId),expectedVersion:1,idempotencyKey:randomUUID()})).ok).toBe(false);
  unwrap(await service.publish(ops,result.batchId,{rowIds:result.rows.slice(0,2).map(r=>r.rowId),expectedVersion:1,idempotencyKey:randomUUID()}));
  const id=result.rows[0]!.customerId!;const preview=unwrap(await service.detail(salesA,id));expect(preview.contacts).toEqual([]);expect(preview.activities).toEqual([]);expect(preview.customerKey).toBe('');const contacts=createContactAssignmentService(repo,tokenAdapter),detail=unwrap(await service.detail(ops,id));
  const selected={customerId:id,contactId:detail.contacts[0]!.contactId};
  const pending=unwrap(await contacts.createAssignments(ops,{contacts:[{...selected,expectedVersion:1}],targetUserId:aId,notifyUserIds:[],idempotencyKey:randomUUID()})).items[0]!;
  expect(await contacts.contactDetail(salesA,selected)).toMatchObject({error:{code:'NOT_FOUND'}});
  const decision={requestId:pending.requestId,expectedVersion:1,idempotencyKey:randomUUID()};
  const accepted=await Promise.all([contacts.decide(salesA,'accept',decision),contacts.decide(salesA,'accept',decision)]);
  expect(accepted.every(x=>x.ok)).toBe(true);expect(unwrap(accepted[0]!)).toEqual(unwrap(accepted[1]!));
  expect(await contacts.decide(salesB,'accept',decision)).toMatchObject({error:{code:'NOT_FOUND'}});
  expect(await contacts.contactDetail(salesB,selected)).toMatchObject({error:{code:'NOT_FOUND'}});
  expect(await contacts.contactDetail(salesA,{customerId:id,contactId:detail.contacts[1]!.contactId})).toMatchObject({error:{code:'NOT_FOUND'}});
  const current=unwrap(await contacts.contactDetail(salesA,selected));
  const follow={...selected,expectedVersion:current.contact.contactVersion!,idempotencyKey:randomUUID(),note:'Synthetic shared feedback',stage:'quoting' as const};
  const feedback=unwrap(await contacts.contactFollowup(salesA,follow));expect(unwrap(await contacts.contactFollowup(salesA,follow))).toEqual(feedback);
  expect(unwrap(await contacts.contactDetail(ops,selected)).activities[0]!.note).toBe(follow.note);
  const events=(await pool.query('SELECT event_type FROM identity.outbox WHERE customer_id=$1',[id])).rows.map(x=>x.event_type);
  expect(events.sort()).toEqual(['crm.contact.assignment.accepted','crm.contact.assignment.requested','crm.contact.followup','crm.customer.created','crm.customer.updated','crm.lead.published']);
  expect((await pool.query('SELECT count(*)::int n FROM crm_shared_activities WHERE contact_id=$1 AND note=$2',[selected.contactId,follow.note])).rows[0].n).toBe(1);
  await pool.query("UPDATE identity.product_access SET capabilities=$2 WHERE user_id=$1 AND product_id='crm'",[aId,JSON.stringify(['leads.claim'])]);
  expect(await contacts.contactDetail(salesA,selected)).toMatchObject({error:{code:'NOT_FOUND'}});
  await pool.query("UPDATE identity.product_access SET capabilities=$2 WHERE user_id=$1 AND product_id='crm'",[aId,JSON.stringify(capabilitiesFor(['sales']))]);
 },TIMEOUT);
 it('fails closed on existing private contacts without exposing identifiers',async()=>{const email=`private-${source}@example.invalid`;await pool.query('INSERT INTO contacts(email,first_name) VALUES($1,$2)',[email,'PRIVATE_SECRET']);const receipt=unwrap(await service.importRows(ops,{source,sourceDetail:'private conflict',idempotencyKey:randomUUID(),rows:[{customerKey:'private',companyName:'synthetic',email}]}));expect(receipt.rows[0]).toMatchObject({status:'restricted_conflict'});expect(receipt.rows[0]!.customerId).toBeUndefined();expect(JSON.stringify(receipt)).not.toContain('PRIVATE_SECRET');});
 it('concurrent imports share only the exact source key and report duplicate emails per row',async()=>{const input={source,sourceDetail:'duplicate source evidence',idempotencyKey:randomUUID(),rows:[{customerKey:'concurrent',companyName:'same company label',email:`concurrent-${source}@example.invalid`}]};const receipts=await Promise.all([service.importRows(ops,input),service.importRows(ops,{...input,idempotencyKey:randomUUID()})]);const a=unwrap(receipts[0]!),b=unwrap(receipts[1]!);expect([a.rows[0]!.status,b.rows[0]!.status].sort()).toEqual(['created','duplicate']);expect(a.rows[0]!.customerId).toBe(b.rows[0]!.customerId);const foreign=unwrap(await service.importRows(ops,{...input,source:`other-${source}`,idempotencyKey:randomUUID()}));expect(foreign.rows[0]!.status).toBe('restricted_conflict');expect(foreign.rows[0]!.customerId).toBeUndefined();});
 it('cached imports recheck effective role grants and current capabilities',async()=>{const input={source,sourceDetail:'receipt authorization',idempotencyKey:randomUUID(),rows:[{customerKey:'cached',companyName:'cached synthetic',email:`cached-${source}@example.invalid`}]};unwrap(await service.importRows(ops,input));await pool.query("UPDATE identity.product_access SET capabilities=$2 WHERE user_id=$1 AND product_id='crm'",[opsId,JSON.stringify(['leads.publish'])]);try{expect((await service.importRows(ops,input))).toMatchObject({error:{code:'FORBIDDEN'}});}finally{await pool.query("UPDATE identity.product_access SET capabilities=$2 WHERE user_id=$1 AND product_id='crm'",[opsId,JSON.stringify(capabilitiesFor(['operations']))]);}await pool.query("UPDATE identity.product_access SET capabilities=$2,scope='shared' WHERE user_id=$1 AND product_id='crm'",[aId,JSON.stringify(['leads.import','leads.claim','leads.develop'])]);try{expect((await service.importRows(salesA,input))).toMatchObject({error:{code:'FORBIDDEN'}});}finally{await pool.query("UPDATE identity.product_access SET capabilities=$2,scope='own' WHERE user_id=$1 AND product_id='crm'",[aId,JSON.stringify(capabilitiesFor(['sales']))]);}});
 it('isolates sales search/counts and blocks current product, password and session revocations',async()=>{expect((await service.list(salesB,{view:'operations',search:'',limit:25,offset:0})).ok).toBe(false);await pool.query("UPDATE identity.product_access SET active=false WHERE user_id=$1 AND product_id='crm'",[bId]);expect((await service.bootstrap(salesB)).ok).toBe(false);await pool.query("UPDATE identity.product_access SET active=true WHERE user_id=$1 AND product_id='crm'",[bId]);await pool.query('UPDATE identity.users SET must_change_password=true WHERE user_id=$1',[bId]);expect((await service.bootstrap(salesB)).ok).toBe(false);await pool.query('UPDATE identity.users SET must_change_password=false,security_revision=security_revision+1 WHERE user_id=$1',[bId]);expect((await service.bootstrap(salesB)).ok).toBe(false);});
 it('rolls back lead changes when atomic outbox insertion fails',async()=>{const receipt=unwrap(await service.importRows(ops,{source,sourceDetail:'atomic rollback',idempotencyKey:randomUUID(),rows:[{customerKey:'rollback',companyName:'synthetic rollback',email:`rollback-${source}@example.invalid`}]}));const id=receipt.rows[0]!.customerId!;await pool.query("CREATE OR REPLACE FUNCTION crm_m2_test_outbox_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; RETURN NEW; END $$");
  // Trigger is scoped to this single synthetic ID and removed in finally, never real data.
  const trigger=`m2_test_${id.replace(/-/g,'')}`;await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON identity.outbox FOR EACH ROW WHEN (NEW.customer_id='${id}'::uuid) EXECUTE FUNCTION crm_m2_test_outbox_failure()`);
  // An invalid row must abort the whole publish without partial published customers.
  try{const bad=await service.publish(ops,receipt.batchId,{rowIds:[receipt.rows[0]!.rowId],expectedVersion:1,idempotencyKey:randomUUID()});expect(bad).toMatchObject({error:{code:'DATABASE_ERROR'}});const row=await pool.query('SELECT state,version FROM crm_customers WHERE customer_id=$1',[id]);expect(row.rows[0]).toEqual({state:'draft',version:1});}finally{await pool.query(`DROP TRIGGER ${trigger} ON identity.outbox`);}
 });
 it('stores unmapped columns as a searchable multiline contact remark',async()=>{
  const companyName=`Remark company ${source}`;
  const email=`remark-${source}@example.invalid`;
  const rawRow={Company:companyName,Email:email,Phone:'+1 555',Profile:'first line\nsecond line',Associations:'WCA','Member years':'3',Fax:'(N/A)'};
  const receipt=unwrap(await service.importRows(ops,{source:`remark-${source}`,sourceDetail:'remark test',idempotencyKey:randomUUID(),mapping:{companyName:'Company',email:'Email',phone:'Phone'},rows:[{customerKey:`remark-${source}`,companyName,email,phone:'+1 555',rawRow}]}));
  expect(receipt.rows[0]!.status).toBe('created');
  const stored=await pool.query('SELECT extra FROM contacts WHERE email=$1',[email]);
  expect(stored.rows[0].extra).toEqual({note:'Profile：first line\nsecond line\nAssociations：WCA\nMember years：3'});
  const found=unwrap(await service.contacts(ops,{search:'second line',limit:25,offset:0}));
  expect(found.items.some(row=>row.email===email)).toBe(true);
 });
});
