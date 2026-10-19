import { describe, it, expect, vi } from 'vitest';
import { createContactCommandService, type ContactCommandPort } from '../../src/main/services/contact-command.service';
import { contactCommandFingerprint, type ContactCommandRow } from '../../src/main/core/contact-commands';
import type { CenterContactDetail, CenterContactUpdate } from '../../server/core/contact-assignments';
import { success, failure } from '../../server/core/crm';
const ref = { contactId: 7, customerId: '00000000-0000-4000-8000-000000000007' };
const input: CenterContactUpdate = { ...ref, expectedVersion: 4, idempotencyKey: 'one', fields: { firstName: 'draft' } };
function fixture() {
 let active=true, online=false, sequence=0;
 let confirmed = { contact:{...ref,contactVersion:4,firstName:'central',extra:{},isShared:false}, activities:[], company:{companyId:2}, canEdit:true,canFollowup:true } as unknown as CenterContactDetail;
 const rows:ContactCommandRow[]=[];
 const ctx={baseUrl:'http://center',userId:'alice',permissionKey:'sales',active:()=>active,online:()=>online};
 const send=vi.fn(async (_action:string, wire:any)=>success({...confirmed,contact:{...confirmed.contact,...wire.fields,contactVersion:wire.expectedVersion+1}}));
 const save=vi.fn((_ctx:any,d:CenterContactDetail)=>{confirmed=d;});
 const port:ContactCommandPort={context:()=>ctx,store:{list:()=>structuredClone(rows),put:(_ctx,row)=>{const i=rows.findIndex(x=>x.id===row.id);if(i<0)rows.push(structuredClone(row));else rows[i]=structuredClone(row);},remove:(_ctx,id)=>{const i=rows.findIndex(x=>x.id===id);if(i>=0)rows.splice(i,1);}},detail:()=>confirmed,send,refresh:vi.fn(async()=>success(confirmed)),save,forget:vi.fn(),key:()=>`new-${++sequence}`,now:()=> '2026-10-16T00:00:00Z',report:vi.fn()};
 return {port,rows,ctx,send,save,service:createContactCommandService(port),get confirmed(){return confirmed;},set confirmed(v:CenterContactDetail){confirmed=v;},goOnline:()=>{online=true;},switch:()=>{active=false;}};
}
describe('durable contact commands',()=>{
 it('rechecks retry keys inside the rebase transaction after another instance confirms the same key',async()=>{
  const f=fixture();await f.service.write('update',input);f.rows[0].status='conflict';f.goOnline();
  f.port.store.unresolved=()=>structuredClone(f.rows.filter(row=>row.status!=='confirmed'));
  f.port.store.duplicate=(_ctx,action,input)=>{const row=f.rows.find(row=>row.input.idempotencyKey===input.idempotencyKey);return row?{matches:row.action===action&&contactCommandFingerprint(row.input)===contactCommandFingerprint(input),confirmed:row.status==='confirmed',row}:undefined;};
  f.port.store.transaction=(_ctx,work)=>{f.rows.push({...f.rows[0],id:'contact-command:new-1',status:'confirmed',input:{...input,idempotencyKey:'new-1',fields:{phone:'other instance'}}});work();};
  expect(await f.service.resolve({id:f.rows[0].id,action:'retry'})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
  expect(f.rows[0]).toMatchObject({status:'conflict',input});
 });
 it('starts retention time at successful confirmation, never draft creation',async()=>{
  const f=fixture();await f.service.write('update',input);f.port.now=()=> '2026-12-16T00:00:00Z';f.goOnline();
  expect(await f.service.sync()).toMatchObject({ok:true});expect(f.rows[0]).toMatchObject({status:'confirmed',confirmedAt:'2026-12-16T00:00:00Z'});
 });
 it('does not apply a receipt across remove-and-regrant with identical contact data',async()=>{
  const f=fixture();let revision=0;f.port.revision=()=>revision;await f.service.write('update',input);f.goOnline();
  f.send.mockImplementationOnce(async()=>{revision++;return success({...f.confirmed,contact:{...f.confirmed.contact,contactVersion:5}});});
  await f.service.sync();expect(f.save).not.toHaveBeenCalled();expect(f.rows[0]).toMatchObject({status:'failed',attempted:true,discardable:false,input});
 });
 it('does not dismiss uncertain delivery merely because its replay is now forbidden',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();f.send.mockResolvedValueOnce(failure('UNAVAILABLE','lost receipt') as never);await f.service.sync();
  f.send.mockResolvedValueOnce(failure('FORBIDDEN','revoked') as never);await f.service.sync();
  expect(f.rows[0]).toMatchObject({status:'failed',discardable:false,input});expect(await f.service.resolve({id:f.rows[0].id,action:'use-central'})).toMatchObject({ok:false});
 });
 it('does not save or rebase an explicit retry whose contact disappeared during refresh',async()=>{
  const f=fixture();await f.service.write('update',input);f.rows[0].status='conflict';f.goOnline();
  f.port.refresh=async()=>{f.port.detail=()=>undefined;return success(f.confirmed);};
  expect(await f.service.resolve({id:f.rows[0].id,action:'retry'})).toMatchObject({ok:false});expect(f.save).not.toHaveBeenCalled();expect(f.rows[0]).toMatchObject({status:'failed',input});
 });
 it('rejects a late success after permission downgrade without erasing readable contact or input',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();
  const accepted={...f.confirmed,contact:{...f.confirmed.contact,firstName:'accepted',contactVersion:5}};
  f.send.mockImplementationOnce(async()=>{f.confirmed={...f.confirmed,canEdit:false};return success(accepted);});
  await f.service.sync();await f.service.sync();expect(f.save).not.toHaveBeenCalled();expect(f.port.forget).not.toHaveBeenCalled();
  expect(f.rows[0]).toMatchObject({status:'failed',attempted:true,discardable:false,input});expect(f.send).toHaveBeenCalledTimes(1);
 });
 it('retains a readable downgraded contact when its unsent edit is no longer allowed',async()=>{
  const f=fixture();await f.service.write('update',input);f.confirmed={...f.confirmed,canEdit:false};f.goOnline();
  await f.service.sync();expect(f.send).not.toHaveBeenCalled();expect(f.port.forget).not.toHaveBeenCalled();expect(f.rows[0]).toMatchObject({status:'failed',discardable:true,input});
 });
 it('drops a late conflict refresh after removal and cannot revive the contact',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();f.send.mockResolvedValueOnce(failure('CONFLICT','changed') as never);
  f.port.refresh=async()=>{f.port.detail=()=>undefined;return success(f.confirmed);};
  await f.service.sync();expect(f.save).not.toHaveBeenCalled();expect(f.rows[0]).toMatchObject({status:'failed',input});
 });
 it('drops a late success after transfer even when the old reference is still readable',async()=>{
  const f=fixture();f.confirmed={...f.confirmed,contact:{...f.confirmed.contact,ownerUserId:'alice'}};await f.service.write('update',input);f.goOnline();
  const accepted={...f.confirmed,contact:{...f.confirmed.contact,contactVersion:5}};
  f.send.mockImplementationOnce(async()=>{f.confirmed={...f.confirmed,contact:{...f.confirmed.contact,ownerUserId:'bob'}};return success(accepted);});
  await f.service.sync();expect(f.save).not.toHaveBeenCalled();expect(f.rows[0]).toMatchObject({status:'failed',input});
 });
 it('keeps confirmed snapshots pure and recovers draft from durable rows after restart',async()=>{
  const f=fixture();const result=await f.service.write('update',input);expect(result).toMatchObject({ok:true,data:{contact:{firstName:'draft',contactVersion:5},localSync:{pending:1,state:'pending'}}});
  expect(f.confirmed.contact.firstName).toBe('central');expect(f.save).not.toHaveBeenCalled();expect(f.rows).toHaveLength(1);
  const restored=createContactCommandService(f.port);expect(restored.detail(f.ctx,f.confirmed).contact.firstName).toBe('draft');
 });
 it('persists before online send, serializes successor versions and never stores a draft as confirmed',async()=>{
  const f=fixture();await f.service.write('update',input);await f.service.write('update',{...input,idempotencyKey:'two',expectedVersion:5,fields:{title:'next'}});f.goOnline();
  f.send.mockImplementation(async (_a,wire)=>{expect(f.rows.find(x=>x.input.idempotencyKey===wire.idempotencyKey)?.attempted).toBe(true);return success({...f.confirmed,contact:{...f.confirmed.contact,...('fields' in wire?wire.fields:{}),contactVersion:wire.expectedVersion+1}});});
  expect(await f.service.sync()).toMatchObject({ok:true});expect(f.send.mock.calls.map(x=>x[1].expectedVersion)).toEqual([4,5]);expect(f.service.status()).toMatchObject({pending:0,conflicts:0});
 });
 it('replays the identical immutable wire after unknown delivery and forbids discarding it',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();f.send.mockResolvedValueOnce(failure('UNAVAILABLE','offline') as never);await f.service.sync();
  expect(await f.service.resolve({id:f.rows[0].id,action:'use-central'})).toMatchObject({ok:false});
  f.confirmed={...f.confirmed,contact:{...f.confirmed.contact,contactVersion:20}};await f.service.sync();expect(f.send.mock.calls.map(x=>x[1])).toEqual([input,input]);
 });
 it('rejects reused keys with other payloads and never sends twice concurrently',async()=>{
  const f=fixture();await f.service.write('update',input);expect(await f.service.write('update',{...input,fields:{title:'other'}})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
  f.goOnline();await Promise.all([f.service.sync(),f.service.sync()]);expect(f.send).toHaveBeenCalledTimes(1);
 });
 it('retains conflicting draft, stops its successor, and requires fresh permissions for retry',async()=>{
  const f=fixture();await f.service.write('update',input);await f.service.write('update',{...input,idempotencyKey:'two',expectedVersion:5});f.goOnline();f.send.mockResolvedValueOnce(failure('CONFLICT','changed') as never);await f.service.sync();
  expect(f.send).toHaveBeenCalledTimes(1);expect(f.service.detail(f.ctx,f.confirmed)).toMatchObject({contact:{firstName:'draft'},localSync:{state:'conflict'}});
  expect(await f.service.resolve({id:f.rows[0].id,action:'retry'})).toMatchObject({ok:false});
  expect(await f.service.resolve({id:f.rows[0].id,action:'use-central'})).toMatchObject({ok:true});expect(f.service.status()).toMatchObject({pending:0,conflicts:0});
 });
 it('explicit conflict retry fetches center and produces a fresh key and version',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();f.send.mockResolvedValueOnce(failure('CONFLICT','changed') as never);await f.service.sync();
  const old=f.rows[0].id;f.confirmed={...f.confirmed,contact:{...f.confirmed.contact,contactVersion:9}};
  expect(await f.service.resolve({id:old,action:'retry'})).toMatchObject({ok:true});await f.service.sync();expect(f.send.mock.calls[1][1]).toMatchObject({expectedVersion:9,idempotencyKey:'new-1',fields:input.fields});
 });
 it('rejects invalid and unauthorized local edits before enqueue',async()=>{
  const f=fixture();expect(await f.service.write('update',{...input,fields:{unsupported:'x'}})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
  f.confirmed={...f.confirmed,permissions:{editableFields:['title'],canFollowup:true,canChangeStage:false,canSendMail:false,canShare:false}};
  expect(await f.service.write('update',input)).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});expect(await f.service.write('followups',{...ref,expectedVersion:4,idempotencyKey:'follow',note:'note',stage:'reaching'})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});expect(f.rows).toHaveLength(0);
 });
 it('marks revoked access terminal, clears projection and never retries',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();f.send.mockResolvedValueOnce(failure('FORBIDDEN','revoked') as never);await f.service.sync();await f.service.sync();expect(f.port.forget).toHaveBeenCalled();expect(f.send).toHaveBeenCalledTimes(1);expect(f.service.status()).toMatchObject({failed:1});
 });
 it('does not apply in-flight receipt after account switch and retains uncertain durable command',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();f.send.mockImplementation(async()=>{f.switch();return success(f.confirmed);});await f.service.sync();expect(f.save).not.toHaveBeenCalled();expect(f.rows[0].status).toBe('pending');
 });
 it('fails safely when enqueue persistence fails',async()=>{
  const f=fixture();f.goOnline();f.port.store.put=()=>{throw Error('disk');};expect(await f.service.write('update',input)).toMatchObject({ok:false,error:{code:'DATABASE_ERROR'}});expect(f.send).not.toHaveBeenCalled();expect(f.port.report).toHaveBeenCalled();
 });
 it('permits a stage-only note with stage permission but never general followup access',async()=>{
  const f=fixture();f.confirmed={...f.confirmed,canFollowup:false,permissions:{editableFields:[],canFollowup:false,canChangeStage:true,canSendMail:false,canShare:false}};
  expect(await f.service.write('followups',{...ref,expectedVersion:4,idempotencyKey:'stage',note:'stage',method:'note',stage:'reaching'})).toMatchObject({ok:true});
  expect(await f.service.write('followups',{...ref,expectedVersion:5,idempotencyKey:'note',note:'not allowed',method:'note'})).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
 });
 it('shows default followup method and touch status consistently with center semantics',async()=>{
  const f=fixture();const result=await f.service.write('followups',{...ref,expectedVersion:4,idempotencyKey:'touch',note:'talked',contactStatus:'contacted'});
  expect(result).toMatchObject({ok:true,data:{contact:{touchStatus:'contacted',status:'reached',lastFollowupNote:'talked'},activities:[{method:'other'}]}});
 });
 it('never reuses the original conflict key after explicit retry',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();f.send.mockResolvedValueOnce(failure('CONFLICT','changed') as never);await f.service.sync();await f.service.resolve({id:f.rows[0].id,action:'retry'});
  expect(await f.service.write('update',input)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
 });
 it('does not show revoked customer values in sync issues',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();f.send.mockResolvedValueOnce(failure('FORBIDDEN','revoked') as never);await f.service.sync();f.port.detail=()=>undefined;
  expect(f.service.status().issues[0].contact).toBeUndefined();
 });
 it('reserves every prior retry key across repeated explicit conflicts',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();f.send.mockResolvedValueOnce(failure('CONFLICT','changed') as never);await f.service.sync();await f.service.resolve({id:f.rows[0].id,action:'retry'});
  const firstRetry=structuredClone(f.rows[0].input);f.send.mockResolvedValueOnce(failure('CONFLICT','changed again') as never);await f.service.sync();await f.service.resolve({id:f.rows[0].id,action:'retry'});
  expect(await f.service.write('update',{...firstRetry,expectedVersion:5})).toMatchObject({ok:false,error:{code:'CONFLICT'}});expect(f.rows).toHaveLength(1);
 });
 it('explicitly rebases a wholly unsent successor chain atomically with fresh keys and permissions',async()=>{
  const f=fixture();let inTransaction=false;
  f.port.store.transaction=(_ctx,work)=>{inTransaction=true;work();inTransaction=false;};
  await f.service.write('update',input);await f.service.write('update',{...input,expectedVersion:5,idempotencyKey:'two',fields:{title:'second'}});
  f.goOnline();f.send.mockResolvedValueOnce(failure('CONFLICT','changed') as never);await f.service.sync();
  f.confirmed={...f.confirmed,contact:{...f.confirmed.contact,contactVersion:9}};
  const put=f.port.store.put;f.port.store.put=(ctx,row)=>{expect(inTransaction).toBe(true);put(ctx,row);};
  expect(await f.service.resolve({id:f.rows[0].id,action:'retry'})).toMatchObject({ok:true});f.port.store.put=put;
  expect(f.rows.map(x=>[x.input.idempotencyKey,x.input.expectedVersion])).toEqual([['new-1',9],['new-2',10]]);
  expect(f.rows.map(x=>x.history?.[0].idempotencyKey)).toEqual(['one','two']);
  await f.service.sync();expect(f.send.mock.calls.slice(1).map(x=>x[1].expectedVersion)).toEqual([9,10]);
 });
 it('never resurrects a successor deleted by another instance while a prior receipt is in flight',async()=>{
  const f=fixture();await f.service.write('update',input);await f.service.write('update',{...input,expectedVersion:5,idempotencyKey:'two'});f.goOnline();
  f.send.mockImplementationOnce(async()=>{f.rows.splice(1,1);return success({...f.confirmed,contact:{...f.confirmed.contact,contactVersion:5}});});
  await f.service.sync();expect(f.send).toHaveBeenCalledTimes(1);expect(f.rows).toHaveLength(1);
 });
 it('two instances cannot send a discarded chain after an unrelated network wait',async()=>{
  const f=fixture();await f.service.write('update',input);await f.service.write('update',{...input,expectedVersion:5,idempotencyKey:'two'});
  f.rows[0].status='conflict';f.rows[0].attempted=true;
  f.rows.unshift({...structuredClone(f.rows[0]),id:'contact-command:unrelated',input:{...input,contactId:8,idempotencyKey:'unrelated'},status:'pending',attempted:false});
  f.port.store.transaction=(_ctx,work)=>work();f.goOnline();
  let finish!:()=>void;f.send.mockImplementationOnce((_a,wire)=>new Promise(resolve=>{finish=()=>resolve(success({...f.confirmed,contact:{...f.confirmed.contact,contactId:wire.contactId,contactVersion:5}}));}));
  const pending=f.service.sync();const other=createContactCommandService(f.port);
  expect(await other.resolve({id:'contact-command:one',action:'use-central'})).toMatchObject({ok:true});finish();await pending;
  expect(f.send).toHaveBeenCalledTimes(1);expect(f.rows.map(row=>row.id)).toEqual(['contact-command:unrelated']);
 });
 it('returns definitive online rejection and permits safe explicit dismissal before later edits',async()=>{
  const f=fixture();f.goOnline();f.send.mockResolvedValueOnce(failure('INVALID_INPUT','invalid field') as never);
  expect(await f.service.write('update',input)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
  expect(await f.service.write('update',input)).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
  expect(await f.service.resolve({id:f.rows[0].id,action:'use-central'})).toMatchObject({ok:true});
  expect(await f.service.write('update',{...input,idempotencyKey:'valid',fields:{title:'fine'}})).toMatchObject({ok:true});
 });
 it('retains an unknown command when a success receipt identifies a different contact',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();
  f.send.mockResolvedValueOnce(success({...f.confirmed,contact:{...f.confirmed.contact,contactId:8,contactVersion:5}}));
  await f.service.sync();expect(f.save).not.toHaveBeenCalled();expect(f.rows[0]).toMatchObject({status:'pending',attempted:true,input});
  expect(await f.service.resolve({id:f.rows[0].id,action:'use-central'})).toMatchObject({ok:false});
 });
 it('replays the accepted followup with the identical key after saving its receipt fails',async()=>{
  const f=fixture();const followup={...ref,expectedVersion:4,idempotencyKey:'followup-once',note:'discussed',method:'note' as const};
  await f.service.write('followups',followup);f.goOnline();
  const accepted=new Map<string,CenterContactDetail>();let inserted=0;
  f.send.mockImplementation(async(_action,wire)=>{
   if(!accepted.has(wire.idempotencyKey)){
    inserted++;accepted.set(wire.idempotencyKey,{...f.confirmed,contact:{...f.confirmed.contact,contactVersion:5},activities:[{id:'center-followup',actorId:'alice',note:'discussed',stage:null,createdAt:'2026-10-16T00:00:00Z',method:'note'}]});
   }
   return success(accepted.get(wire.idempotencyKey)!);
  });
  f.save.mockImplementationOnce(()=>{throw Error('disk after acceptance');});
  expect(await f.service.sync()).toMatchObject({ok:false,error:{code:'DATABASE_ERROR'}});expect(f.rows[0]).toMatchObject({status:'pending',attempted:true,input:followup});
  const restarted=createContactCommandService(f.port);expect(await restarted.sync()).toMatchObject({ok:true});
  expect(f.send.mock.calls.map(call=>call[1])).toEqual([followup,followup]);expect(inserted).toBe(1);expect(f.confirmed.activities).toHaveLength(1);expect(f.rows[0].status).toBe('confirmed');
 });
 it('never restores a contact removed from the authorized projection during its network request',async()=>{
  const f=fixture();await f.service.write('update',input);f.goOnline();
  f.send.mockImplementationOnce(async()=>{f.port.detail=()=>undefined;return success({...f.confirmed,contact:{...f.confirmed.contact,firstName:'accepted',contactVersion:5}});});
  await f.service.sync();await f.service.sync();expect(f.save).not.toHaveBeenCalled();expect(f.port.forget).toHaveBeenCalledWith(f.ctx,expect.objectContaining(ref));expect(f.rows[0].status).toBe('failed');expect(f.send).toHaveBeenCalledTimes(1);
 });
});
