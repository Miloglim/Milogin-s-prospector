import { describe, expect, it } from 'vitest';
import { createOfflineCrmService } from '../../src/main/services/offline-crm.service';
import { emptyOfflineCrmState, type OfflineCrmState, type OfflineCrmContext } from '../../src/main/core/offline-crm';
import { success, failure, type Result } from '../../server/core/crm';
import type { LeadDetail } from '../../server/core/leads';

const userId = '00000000-0000-4000-8000-000000000001';
const customerId = '00000000-0000-4000-8000-000000000002';
const context: OfflineCrmContext = { userId, baseUrl: 'http://127.0.0.1:55844', permissionKey: 'sales', active: () => true, online: () => false };
const customer: LeadDetail = { customerId, companyName: 'Local Company', country: null, version: 1, origin: 'personal', ownerUserId: userId, state: 'owned', stage: 'cold', source: 'manual', sourceDetail: '', customerKey: customerId, contactCount: 1, contacts: [{contactId: 7, email: 'a@example.invalid', name: 'Alice', country: null}], activities: [], canEdit: true, canFollowup: true, canAssign: false };
function fixture() {
  let state = emptyOfflineCrmState('sales');
  state.bootstrap = {userId, capabilities: ['leads.create', 'leads.develop', 'leads.read', 'leads.import'], scope: 'own', summary: {mine:1,pool:0}, feedCursor:'0'};
  state.customers[customerId] = structuredClone(customer); state.views.personal = [customerId]; state.views.assigned=[]; state.views.pool=[];
  const store = { load: () => structuredClone(state), save: (_: OfflineCrmContext, next: OfflineCrmState) => {state = structuredClone(next);} };
  let seq = 10;
  const service = () => createOfflineCrmService(store, () => `00000000-0000-4000-8000-${String(seq++).padStart(12,'0')}`, () => '2026-10-13T00:00:00.000Z');
  return {store, service, state:()=>state};
}
const unreachable = async <T>():Promise<Result<T>> => failure('UNAVAILABLE','offline');
describe('offline CRM durable workflow', () => {
  it('opens cached bootstrap, search and detail without the center', async () => {
    const f=fixture(), s=f.service();
    expect(await s.request(context,'GET','/api/crm/bootstrap',undefined,unreachable)).toMatchObject({ok:true,data:{userId}});
    expect(await s.request(context,'GET','/api/crm/leads?view=personal&search=alice&limit=25&offset=0',undefined,unreachable)).toMatchObject({ok:true,data:{total:1}});
    expect(await s.request(context,'GET',`/api/crm/leads/${customerId}`,undefined,unreachable)).toMatchObject({ok:true,data:{contacts:[{email:'a@example.invalid'}]}});
  });
  it('filters reached-only before paging and keeps offline contact changes aligned with the center', async () => {
    const f=fixture(),s=f.service();
    const path='/api/crm/leads?view=personal&search=&limit=1&offset=0&followupOnly=true';
    expect(await s.request(context,'GET',path,undefined,unreachable)).toMatchObject({ok:true,data:{total:0,items:[]}});
    expect(await s.request(context,'GET',path.replace('&followupOnly=true',''),undefined,unreachable)).toMatchObject({ok:true,data:{total:1}});
    await s.request(context,'POST',`/api/crm/leads/${customerId}/followups`,{customerId,expectedVersion:1,idempotencyKey:'reached',method:'phone',note:'Reached customer',contactId:7,contactStatus:'contacted'},unreachable);
    expect(await f.service().request(context,'GET',path,undefined,unreachable)).toMatchObject({ok:true,data:{total:1,items:[{hasContacted:true,stage:'cold'}]}});
    expect(await s.request(context,'GET',path+'&stage=reaching',undefined,unreachable)).toMatchObject({ok:true,data:{total:1}});
    await s.request(context,'POST',`/api/crm/leads/${customerId}/followups`,{customerId,expectedVersion:2,idempotencyKey:'unreached',method:'phone',note:'No longer reached',contactId:7,contactStatus:'uncontacted'},unreachable);
    expect(await s.request(context,'GET',path,undefined,unreachable)).toMatchObject({ok:true,data:{total:0}});
  });
  it('persists an edit and followup across restart and deduplicates local retries', async () => {
    const f=fixture(), s=f.service();
    const input={...customer, companyName:'Edited', expectedVersion:1,idempotencyKey:'edit-1'};
    const update={customerId,companyName:input.companyName,contacts:customer.contacts.map(c=>({contactId:c.contactId,email:c.email,name:c.name!})),expectedVersion:1,idempotencyKey:'edit-1'};
    expect(await s.request(context,'POST',`/api/crm/leads/${customerId}/update`,update,unreachable)).toMatchObject({ok:true,data:{companyName:'Edited',version:2}});
    expect(await s.request(context,'POST',`/api/crm/leads/${customerId}/update`,update,unreachable)).toMatchObject({ok:true});
    expect(await s.request(context,'POST',`/api/crm/leads/${customerId}/followups`,{customerId,expectedVersion:2,idempotencyKey:'note-1',note:'Offline call',method:'phone'},unreachable)).toMatchObject({ok:true,data:{version:3,activities:[{note:'Offline call'}]}});
    expect(f.state().outbox).toHaveLength(2);
    expect(await f.service().request(context,'GET',`/api/crm/leads/${customerId}`,undefined,unreachable)).toMatchObject({ok:true,data:{companyName:'Edited',activities:[{note:'Offline call'}]}});
  });
  it('replays the identical wire request after a lost response and rebases only its own dependent change', async () => {
    const f=fixture(), s=f.service();
    await s.request(context,'POST',`/api/crm/leads/${customerId}/followups`,{customerId,expectedVersion:1,idempotencyKey:'first',note:'one'},unreachable);
    await s.request(context,'POST',`/api/crm/leads/${customerId}/followups`,{customerId,expectedVersion:2,idempotencyKey:'second',note:'two'},unreachable);
    const wires:unknown[]=[];let lost=true;
    const send=async <T>(method:string,path:string,body?:unknown):Promise<Result<T>>=>{
      if(method==='POST'){wires.push(structuredClone(body));if(lost){lost=false;return failure('UNAVAILABLE','lost');}const b=body as {idempotencyKey:string};return success({...customer,version:b.idempotencyKey==='first'?4:5}) as Result<T>;}
      return failure('UNAVAILABLE','no pull');
    };
    const online={...context,online:()=>true};
    await s.sync(online,send); await f.service().sync(online,send);
    expect(wires[0]).toEqual(wires[1]);expect(wires[2]).toMatchObject({expectedVersion:4,idempotencyKey:'second'});expect(f.state().outbox).toHaveLength(0);
  });
  it('keeps local changes on central version conflict and blocks dependent writes', async () => {
    const f=fixture(),s=f.service();
    await s.request(context,'POST',`/api/crm/leads/${customerId}/followups`,{customerId,expectedVersion:1,idempotencyKey:'conflict',note:'keep me'},unreachable);
    await s.sync({...context,online:()=>true},async()=>failure('CONFLICT','central changed'));
    expect(f.state().outbox).toMatchObject([{status:'conflict'}]);expect(f.state().customers[customerId]!.activities[0]!.note).toBe('keep me');
    expect(await s.status(context)).toMatchObject({ok:true,data:{conflicts:1,pending:0}});
  });
  it('rejects expired authorization, unsupported offline ownership changes and invalid input', async () => {
    const f=fixture(),s=f.service();
    expect(await s.request({...context,active:()=>false},'GET',`/api/crm/leads/${customerId}`,undefined,unreachable)).toMatchObject({ok:false,error:{code:'UNAUTHORIZED'}});
    expect(await s.request(context,'POST',`/api/crm/leads/${customerId}/claim`,{},unreachable)).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}});
    expect(await s.request(context,'POST','/api/crm/leads',{companyName:''},unreachable)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    expect(f.state().outbox).toHaveLength(0);
  });
  it('creates offline and remaps customer and contact IDs before a dependent followup', async () => {
    const f=fixture(),s=f.service();
    const created=await s.request<LeadDetail>(context,'POST','/api/crm/leads',{companyName:'New company',source:'manual',sourceDetail:'',contacts:[{email:'new@example.invalid',name:'New person'}],idempotencyKey:'new'},unreachable);
    expect(created.ok).toBe(true);if(!created.ok)return;
    await s.request(context,'POST',`/api/crm/leads/${created.data.customerId}/followups`,{customerId:created.data.customerId,expectedVersion:1,idempotencyKey:'new-note',note:'Phone call',contactId:created.data.contacts[0]!.contactId,contactStatus:'contacted'},unreachable);
    const centralId='00000000-0000-4000-8000-000000000099';
    const inputs:unknown[]=[];
    await s.sync({...context,online:()=>true},async <T>(method:string,path:string,body?:unknown):Promise<Result<T>>=>{
      if(method==='POST'){inputs.push({path,body});return success({...created.data,customerId:centralId,version:inputs.length,contacts:[{...created.data.contacts[0]!,contactId:99}]}) as Result<T>;}
      return failure('UNAVAILABLE','no pull');
    });
    expect(inputs[1]).toMatchObject({path:`/api/crm/leads/${centralId}/followups`,body:{customerId:centralId,contactId:99,expectedVersion:1}});
    expect(f.state().outbox).toHaveLength(0);
    expect(await f.service().request(context,'GET',`/api/crm/leads/${created.data.customerId}`,undefined,unreachable)).toMatchObject({ok:true,data:{customerId:centralId}});
  });
  it('imports one table locally with original rows, blocks duplicate idempotency payloads and keeps invalid receipts', async () => {
    const f=fixture(),s=f.service();
    const input={source:'file',sourceDetail:'fixture.csv',kind:'personal',idempotencyKey:'file-1',rows:[{customerKey:'1',companyName:'Imported',email:'i@example.invalid',rawRow:{company:'Imported'}},{customerKey:'2',companyName:'Invalid',email:'bad'}]};
    expect(await s.request(context,'POST','/api/crm/imports',input,unreachable)).toMatchObject({ok:true,data:{rows:[{status:'created'},{status:'invalid'}]}});
    expect(f.state().outbox[0]!.body).toEqual(input);
    expect(await s.request(context,'POST','/api/crm/imports',{...input,source:'changed'},unreachable)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
    expect(await s.request(context,'GET','/api/crm/leads?view=personal&limit=25&offset=0',undefined,unreachable)).toMatchObject({ok:true,data:{total:2}});
  });
  it('serializes simultaneous writes so neither persisted outbox entry is lost', async () => {
    const f=fixture(),s=f.service();
    const result=await Promise.all(['one','two'].map(id=>s.request(context,'POST','/api/crm/leads',{companyName:id,source:'manual',sourceDetail:'',contacts:[],idempotencyKey:id},unreachable)));
    expect(result.every(r=>r.ok)).toBe(true);expect(f.state().outbox).toHaveLength(2);
  });
  it('retries a rejected change against the reviewed central version and preserves dependent history', async () => {
    const f=fixture(),s=f.service(),online={...context,online:()=>true};
    await s.request(context,'POST',`/api/crm/leads/${customerId}/followups`,{customerId,expectedVersion:1,idempotencyKey:'conflict',note:'keep me'},unreachable);
    const remote={...customer,version:4};
    await s.sync(online,async <T>(method:string):Promise<Result<T>>=>method==='POST'?failure('CONFLICT','changed'):success(remote) as Result<T>);
    const issue=f.state().outbox[0]!.id;let posted:unknown;
    expect(await s.resolve(online,{id:issue,action:'retry'},async <T>(method:string,path:string,body?:unknown):Promise<Result<T>>=>{
      if(method==='POST'){posted=body;return success({...remote,version:5}) as Result<T>;}
      if(path===`/api/crm/leads/${customerId}`)return success(remote) as Result<T>;
      return failure('UNAVAILABLE','no pull');
    })).toMatchObject({ok:true});
    expect(posted).toMatchObject({expectedVersion:4,note:'keep me'});expect((posted as {idempotencyKey:string}).idempotencyKey).not.toBe('conflict');
  });
  it('never pulls a forbidden pool and finishes a scoped snapshot including empty pages', async () => {
    const f=fixture(),s=f.service();
    await s.sync({...context,online:()=>true},async <T>(_m:string,path:string):Promise<Result<T>>=>{
      if(path==='/api/crm/bootstrap')return success(f.state().bootstrap) as Result<T>;
      if(path.includes('view=pool'))throw Error('pool must not be requested');
      if(path.includes('view=personal'))return success({items:[customer],total:1}) as Result<T>;
      if(path.includes('view=assigned'))return success({items:[],total:0}) as Result<T>;
      return success(customer) as Result<T>;
    });
    expect(f.state().lastSyncedAt).toBe('2026-10-13T00:00:00.000Z');
  });
  it('invalidates cached data when permissions change and never delivers a late old-session response', async () => {
    const f=fixture(),s=f.service();
    expect(await s.request({...context,permissionKey:'revoked'},'GET',`/api/crm/leads/${customerId}`,undefined,unreachable)).toMatchObject({ok:false});
    expect(f.state().customers).toEqual({});
    let active=true;
    const result=await s.request({...context,online:()=>true,active:()=>active},'GET',`/api/crm/leads/${customerId}`,undefined,async <T>():Promise<Result<T>>=>{active=false;return success(customer) as Result<T>;});
    expect(result).toMatchObject({ok:false,error:{code:'UNAUTHORIZED'}});expect(f.state().customers).toEqual({});
  });
  it('does not complete an import on a truncated successful center receipt',async()=>{
    const f=fixture(),s=f.service();
    await s.request(context,'POST','/api/crm/imports',{source:'file',sourceDetail:'',kind:'personal',idempotencyKey:'truncated',rows:[{customerKey:'new',companyName:'Keep draft',email:'keep@example.invalid'}]},unreachable);
    await s.sync({...context,online:()=>true},async<T>():Promise<Result<T>>=>success({batchId:'batch',version:1,rows:[]}) as Result<T>);
    expect(f.state().outbox).toHaveLength(1);expect(f.state().outbox[0]!.status).toBe('failed');
    expect(Object.values(f.state().customers).some(c=>c.companyName==='Keep draft')).toBe(true);
  });
  it('preserves the actual offline occurrence time rather than replacing it with reconnect time',async()=>{
    const f=fixture(),s=f.service();
    await s.request(context,'POST',`/api/crm/leads/${customerId}/followups`,{customerId,expectedVersion:1,idempotencyKey:'timed',note:'Offline event'},unreachable);
    expect(f.state().outbox[0]!.body.occurredAt).toBe('2026-10-13T00:00:00.000Z');
  });
  it('keeps both operations when a new local change races a pending central acknowledgement',async()=>{
    const f=fixture(),s=f.service();
    await s.request(context,'POST',`/api/crm/leads/${customerId}/followups`,{customerId,expectedVersion:1,idempotencyKey:'first',note:'first'},unreachable);
    let finish!: (r:Result<LeadDetail>)=>void;const response=new Promise<Result<LeadDetail>>(r=>{finish=r;});
    const sync=s.sync({...context,online:()=>true},async<T>(m:string):Promise<Result<T>>=>m==='POST'?await response as Result<T>:failure('UNAVAILABLE','no pull'));
    await Promise.resolve();
    const local=s.request(context,'POST',`/api/crm/leads/${customerId}/followups`,{customerId,expectedVersion:2,idempotencyKey:'second',note:'second'},unreachable);
    finish(success({...customer,version:2,activities:[{id:'remote',actorId:userId,note:'first',stage:null,createdAt:'2026-10-13T00:00:00Z'}]}));
    await local;await sync;
    expect(f.state().outbox).toHaveLength(1);expect(f.state().outbox[0]!.body.idempotencyKey).toBe('second');expect(f.state().customers[customerId]!.activities[0]!.note).toBe('second');
  });
});
