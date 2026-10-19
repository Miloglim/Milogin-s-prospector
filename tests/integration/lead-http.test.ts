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
import {createCrmHandler} from '../../server/transport/crm-http';
import type {Result} from '../../server/core/crm';
const TIMEOUT=30000;
function unwrap<T>(r:Result<T>):T{if(!r.ok)throw Error(r.error.code);return r.data;}
let pool:Pool,server:Server,base:string,api:string,browser:string;
const log={write:()=>{}};
async function request(path:string,input?:unknown,token=api){const r=await fetch(base+path,{method:input===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:r.status,body:await r.json() as any};}
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('M2 real HTTP lead contract',()=>{
 beforeAll(async()=>{pool=new Pool(readTestDatabaseConfig());unwrap(await new PostgresCrmRepository(pool,log).migrate());unwrap(await new PostgresAuthRepository(pool,log).migrate());const repo=new PostgresLeadRepository(pool,log);unwrap(await repo.migrate());unwrap(await new PostgresNotificationRepository(pool,log).migrate());const id=randomUUID();await pool.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)',[id,'synthetic http operations']);await pool.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm','operations')",[id]);await pool.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm','shared',$2)",[id,JSON.stringify(capabilitiesFor(['operations']))]);api=randomBytes(32).toString('base64url');browser=randomBytes(32).toString('base64url');for(const [token,client] of [[api,'api'],[browser,'browser']])await pool.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour',$3)",[tokenAdapter.hash(token!),id,client]);const handler=createCrmHandler(createLeadService(repo,tokenAdapter));server=createServer((req,res)=>{void handler(req,res);});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;},TIMEOUT);
 afterAll(async()=>{if(server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}await pool?.end();});
 it('rejects browser-resource tokens, missing sessions and unknown fields',async()=>{expect((await request('/api/crm/bootstrap',undefined,browser)).status).toBe(401);expect((await request('/api/crm/bootstrap',undefined,'')).status).toBe(401);expect((await request('/api/crm/imports',{unexpected:'field'})).status).toBe(400);expect((await request('/api/crm/leads?view=operations&limit=101')).status).toBe(400);});
 it('imports and publishes via bounded DTOs with pool preview and detail separation',async()=>{const source=`http-${randomUUID()}`;const imported=await request('/api/crm/imports',{source,sourceDetail:'synthetic http',idempotencyKey:randomUUID(),rows:[{customerKey:'one',companyName:'http synthetic',email:`${source}@example.invalid`}]});expect(imported.status).toBe(200);const receipt=imported.body.data;const pub=await request(`/api/crm/imports/${receipt.batchId}/publish`,{rowIds:[receipt.rows[0].rowId],expectedVersion:1,idempotencyKey:randomUUID()});expect(pub.status).toBe(200);const list=await request('/api/crm/leads?view=operations&search=http%20synthetic');expect(list.status).toBe(200);expect(list.body.data.items.some((x:any)=>x.customerId===receipt.rows[0].customerId)).toBe(true);expect(list.body.data.items[0].contacts).toBeUndefined();const detail=await request(`/api/crm/leads/${receipt.rows[0].customerId}`);expect(detail.body.data.contacts[0].email).toBe(`${source}@example.invalid`);});
 it('rejects mismatching resource ids and request bodies larger than 1 MiB',async()=>{expect((await request(`/api/crm/leads/${randomUUID()}/claim`,{customerId:randomUUID(),expectedVersion:1,idempotencyKey:randomUUID()})).status).toBe(400);expect((await request('/api/crm/imports',{source:'x'.repeat(1048576)})).status).toBe(413);});
});
