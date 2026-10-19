import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { tokenAdapter } from '../../server/adapters/password';
import { capabilitiesFor } from '../../server/core/admin';
import { createLeadService } from '../../server/services/leads';
import { createOfflineCrmService } from '../../src/main/services/offline-crm.service';
import { emptyOfflineCrmState, type OfflineCrmContext, type CrmNetwork } from '../../src/main/core/offline-crm';
import { failure, type Result } from '../../server/core/crm';
import type { LeadDetail, LeadQuery, ImportReceipt } from '../../server/core/leads';
function unwrap<T>(result:Result<T>):T {if(!result.ok)throw Error(`${result.error.code}: ${result.error.message}`);return result.data;}
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('offline CRM against isolated PostgreSQL',()=>{
  it('creates, imports, replays lost responses, maps contacts and retains version conflicts with full rollback',async()=>{
    const pool=new Pool(readTestDatabaseConfig());const client=await pool.connect();
    const counts=async()=>{const row=await client.query('SELECT (SELECT count(*) FROM identity.users) AS users,(SELECT count(*) FROM crm_customers) AS customers,(SELECT count(*) FROM contacts) AS contacts,(SELECT count(*) FROM crm_import_batches) AS batches,(SELECT count(*) FROM crm_shared_activities) AS activities');return row.rows[0];};
    const before=await counts();
    await client.query('BEGIN');
    try {
      const userId=randomUUID(),token=randomBytes(32).toString('base64url'),capabilities=capabilitiesFor(['sales']);
      await client.query('INSERT INTO identity.users(user_id,display_name) VALUES($1,$2)',[userId,'Synthetic offline CRM']);
      await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm','sales')",[userId]);
      await client.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm','own',$2)",[userId,JSON.stringify(capabilities)]);
      await client.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,1,now()+interval '1 hour','api')",[tokenAdapter.hash(token),userId]);
      // Real repositories keep their transaction boundaries via savepoints; fixture outer transaction always rolls back.
      const facade={options:pool.options,connect:async()=>({query:(sql:string,args?:unknown[])=>client.query(sql==='BEGIN'?'SAVEPOINT offline_call':sql==='COMMIT'?'RELEASE SAVEPOINT offline_call':sql==='ROLLBACK'?'ROLLBACK TO SAVEPOINT offline_call':sql,args),release:()=>{}})} as unknown as Pool;
      const center=createLeadService(new PostgresLeadRepository(facade,{write:()=>{}}),tokenAdapter);
      let state=emptyOfflineCrmState('sales');
      state.bootstrap=unwrap(await center.bootstrap(token));state.views.personal=[];state.views.assigned=[];state.views.pool=[];
      const store={load:()=>structuredClone(state),save:(_ctx:OfflineCrmContext,next:typeof state)=>{state=structuredClone(next);}};
      const service=()=>createOfflineCrmService(store,randomUUID,()=>new Date().toISOString());
      const ctx:OfflineCrmContext={userId,baseUrl:'http://127.0.0.1:55844',permissionKey:'sales',active:()=>true,online:()=>false};
      const unreachable:CrmNetwork=async()=>failure('UNAVAILABLE','offline');
      let loseResponse=true;
      const network:CrmNetwork=async<T>(method:string,path:string,body?:unknown):Promise<Result<T>>=>{
        let result:Result<unknown>;
        const url=new URL(path,'http://fixture');
        if(method==='POST'&&path==='/api/crm/leads')result=await center.createCustomer(token,body);
        else if(method==='POST'&&path==='/api/crm/imports')result=await center.importRows(token,body);
        else if(method==='POST'&&path.endsWith('/followups'))result=await center.followup(token,body);
        else if(method==='POST'&&path.endsWith('/update'))result=await center.updateCustomer(token,body);
        else if(path==='/api/crm/bootstrap')result=await center.bootstrap(token);
        else if(url.pathname==='/api/crm/leads')result=await center.list(token,{view:url.searchParams.get('view') as LeadQuery['view'],search:'',limit:100,offset:Number(url.searchParams.get('offset'))});
        else result=await center.detail(token,url.pathname.split('/')[4]!);
        if(method==='POST'&&result.ok&&loseResponse){loseResponse=false;return failure('UNAVAILABLE','lost response after commit');}
        return result as Result<T>;
      };
      const s=service();
      const local=unwrap(await s.request<LeadDetail>(ctx,'POST','/api/crm/leads',{companyName:'Synthetic offline company',source:'offline-test',sourceDetail:'rollback fixture',contacts:[{email:`offline-${randomUUID()}@example.invalid`,name:'Synthetic person'}],idempotencyKey:randomUUID()},unreachable));
      unwrap(await s.request(ctx,'POST',`/api/crm/leads/${local.customerId}/followups`,{customerId:local.customerId,expectedVersion:1,idempotencyKey:randomUUID(),note:'Offline call',method:'phone',contactId:local.contacts[0]!.contactId,contactStatus:'contacted'},unreachable));
      const online={...ctx,online:()=>true};await s.sync(online,network,true);expect(state.outbox).toHaveLength(2);
      await service().sync(online,network,true);expect(state.outbox).toHaveLength(0);
      const id=state.aliases[local.customerId]!;const remote=unwrap(await center.detail(token,id));
      expect(remote.contacts[0]!.touchStatus).toBe('contacted');expect(remote.activities.filter(a=>a.note==='Offline call')).toHaveLength(1);
      const query={view:'personal' as const,search:'',limit:1,offset:0,followupOnly:true};
      const board=unwrap(await center.list(token,query));
      expect(board.total).toBe(1);expect(board.items[0]!.hasContacted).toBe(true);
      expect(unwrap(await center.list(token,{...query,stage:'reaching'})).total).toBe(1);
      expect((await client.query('SELECT count(*)::int AS n FROM crm_customers WHERE created_by=$1',[userId])).rows[0].n).toBe(1);
      const imported=unwrap(await s.request<ImportReceipt>(ctx,'POST','/api/crm/imports',{source:'offline-table',sourceDetail:'single table',kind:'personal',idempotencyKey:randomUUID(),rows:[{customerKey:'row1',companyName:'Synthetic imported',email:`import-${randomUUID()}@example.invalid`,rawRow:{name:'Synthetic imported'}}]},unreachable));
      await s.sync(online,network,true);expect(state.outbox).toHaveLength(0);expect(state.aliases[imported.rows[0]!.customerId!]).toBeDefined();
      expect(unwrap(await center.list(token,{...query,followupOnly:false,limit:100})).total).toBe(2);
      expect(unwrap(await center.list(token,query)).total).toBe(1);
      const cached=state.customers[id]!;
      unwrap(await s.request(ctx,'POST',`/api/crm/leads/${id}/followups`,{customerId:id,expectedVersion:cached.version,idempotencyKey:randomUUID(),note:'Retain conflict'},unreachable));
      unwrap(await center.followup(token,{customerId:id,expectedVersion:remote.version,idempotencyKey:randomUUID(),note:'Concurrent central change'}));
      await s.sync(online,network,true);expect(state.outbox[0]!.status).toBe('conflict');expect(state.customers[id]!.activities[0]!.note).toBe('Retain conflict');
      unwrap(await s.resolve(online,{id:state.outbox[0]!.id,action:'use-central'},network));expect(state.outbox).toHaveLength(0);expect(state.customers[id]!.activities[0]!.note).toBe('Concurrent central change');
    } finally {await client.query('ROLLBACK');expect(await counts()).toEqual(before);client.release();await pool.end();}
  },30000);
});
