import { describe, expect, it } from 'vitest';
import { createContactMailSyncService } from '../../src/main/services/contact-mail-sync.service';
import { success, failure } from '../../server/core/crm';
import type { CenterContact } from '../../server/core/center-contacts';
import type { ContactMailEventInput, ContactMailEventReceipt } from '../../server/core/contact-mail';
import type { CenterContactPage } from '../../server/core/center-contacts';
import type { Result } from '../../server/core/crm';

const context={baseUrl:'http://127.0.0.1:55844',userId:'u1'};
const row=(id:number)=>({contactId:id,customerId:`customer-${id}`,email:`c${id}@example.com`} as CenterContact);
function fixture(){
 let current:typeof context|null=context; let rows:CenterContact[]=[]; let events:ContactMailEventInput[]=[]; let posts=0;let reconciles=0;
 const service=createContactMailSyncService({context:()=>current,online:()=>true,
  query:async()=>success({items:[row(1)],total:1}),
  post:async(event)=>{posts++;return success({eventId:'e',duplicate:false,contact:row(event.contactId),event:{...event,eventId:'e',actorId:'u1',recordedAt:event.occurredAt,activityId:null}});},
  replace:(_ctx,value)=>{rows=value;},upsert:(_ctx,value)=>{for(const r of value)rows=[...rows.filter(x=>x.contactId!==r.contactId),r];},
  pending:()=>events,acknowledge:(_ctx,key)=>{events=events.filter(e=>e.eventKey!==key);},
  reconcile:async()=>{reconciles++;return success(undefined);},report:()=>{},
 });
 return {service,rows:()=>rows,posts:()=>posts,reconciles:()=>reconciles,setCurrent:(value:typeof current)=>{current=value;},queue:(event:ContactMailEventInput)=>{events.push(event);},pending:()=>events};
}
const event={contactId:1,customerId:'customer-1',eventKey:'evt',mailboxKey:'box',messageKey:'msg',kind:'replied',direction:'inbound',occurredAt:'2026-10-14T10:00:00Z',subject:'reply',preview:'hello',fromEmail:'c1@example.com',toEmails:['me@example.com'],ccEmails:[]} as ContactMailEventInput;
function deferred<T>() { let resolve!: (value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve}; }
function receipt(input:ContactMailEventInput,contact=row(input.contactId)):Result<ContactMailEventReceipt> {return success({eventId:'e',duplicate:false,contact,event:{...input,eventId:'e',actorId:'u1',recordedAt:input.occurredAt,activityId:null}});}
describe('explicit denial versus inflight complete refresh', () => {
 it('drops an old complete scan after relogin to the same account and permission key',async()=>{
  let active=true;const captured={...context,active:()=>active};let current=captured;let writes=0;
  const service=createContactMailSyncService({context:()=>current,online:()=>true,query:async()=>{active=false;current={...context,active:()=>true};return success({items:[row(1)],total:1});},post:async input=>receipt(input),replace:()=>{writes++;},upsert:()=>{},pending:()=>[],acknowledge:()=>{},reconcile:async()=>success(undefined),report:()=>{}});
  expect(await service.sync()).toMatchObject({ok:false,error:{code:'UNAUTHORIZED'}});expect(writes).toBe(0);
 });
 it('acks a late mail receipt without restoring privileges changed by a newer full scan',async()=>{
  const upload=deferred<Result<ContactMailEventReceipt>>();let rows=[{...row(1),canEdit:true}],pending=[event];
  const service=createContactMailSyncService({context:()=>context,online:()=>true,contains:()=>true,query:async()=>success({items:[{...row(1),canEdit:false}],total:1}),post:()=>upload.promise,replace:(_ctx,value)=>{rows=value as typeof rows;},upsert:(_ctx,value)=>{rows=value as typeof rows;},pending:()=>pending,acknowledge:()=>{pending=[];},reconcile:async()=>success(undefined),report:()=>{}});
  const flushing=service.flush();const scanning=service.sync();await Promise.resolve();upload.resolve(receipt(event,{...row(1),canEdit:true}));await flushing;await scanning;
  expect(rows[0].canEdit).toBe(false);expect(pending).toEqual([]);
 });
 it('drops a scan begun before known contact invalidation instead of resurrecting it', async () => {
  const scan=deferred<Result<CenterContactPage>>();let rows=[row(7)];
  const service=createContactMailSyncService({context:()=>context,online:()=>true,query:()=>scan.promise,post:async input=>receipt(input),replace:(_ctx,value)=>{rows=value;},upsert:()=>{},pending:()=>[],acknowledge:()=>{},reconcile:async()=>success(undefined),report:()=>{}});
  const pending=service.sync();rows=[];service.invalidate(context);scan.resolve(success({items:[row(7)],total:1}));
  expect(await pending).toMatchObject({ok:false,error:{code:'CONFLICT'}});expect(rows).toEqual([]);
 });
 it('acknowledges a committed mail fact without resurrecting its removed contact', async () => {
  const upload=deferred<Result<ContactMailEventReceipt>>();let rows=[row(1)],pending=[event];
  const service=createContactMailSyncService({context:()=>context,online:()=>true,contains:(_ctx,contact)=>rows.some(item=>item.contactId===contact.contactId&&item.customerId===contact.customerId),query:async()=>success({items:rows,total:rows.length}),post:()=>upload.promise,replace:(_ctx,value)=>{rows=value;},upsert:(_ctx,value)=>{rows=value;},pending:()=>pending,acknowledge:()=>{pending=[];},reconcile:async()=>success(undefined),report:()=>{}});
  const flushing=service.flush();rows=[];service.invalidate(context);upload.resolve(receipt(event));
  expect(await flushing).toEqual(success(undefined));expect(rows).toEqual([]);expect(pending).toEqual([]);
 });
});
describe('contact mail flow orchestration',()=>{
 it('records the center head before a complete scan as the incremental baseline',async()=>{
  let cursor:string|null=null;let heads=0;
  const service=createContactMailSyncService({context:()=>context,online:()=>true,query:async()=>success({items:[row(1)],total:1}),post:async input=>receipt(input),replace:()=>{},upsert:()=>{},pending:()=>[],acknowledge:()=>{},reconcile:async()=>success(undefined),report:()=>{},incremental:{store:{state:()=>({cursor,permissionKey:''}),upsert:()=>{},remove:()=>{},saveCursor:(_ctx,next)=>{cursor=next;},invalidate:()=>{}},head:async()=>{heads++;return '12';},fetchPage:async()=>undefined}});
  expect((await service.sync()).ok).toBe(true);expect(cursor).toBe('12');expect(heads).toBe(1);
 });
 it('acknowledges a historical send archive without restoring revoked contact data',async()=>{
  let events=[{...event,kind:'sent' as const,direction:'outbound' as const,sendAuthorizationId:'authorization-one'}];
  let upserts=0;
  const service=createContactMailSyncService({
    context:()=>context,online:()=>true,query:async()=>success({items:[],total:0}),
    post:async()=>success({eventId:'archived',duplicate:false,archivedAfterRevocation:true}),
    replace:()=>{},upsert:()=>{upserts++;},pending:()=>events,acknowledge:()=>{events=[];},
    reconcile:async()=>success(undefined),report:()=>{},
  });
  expect(await service.flush()).toEqual(success(undefined));
  expect(events).toEqual([]);
  expect(upserts).toBe(0);
 });
 it('quarantines a stale correction parent without rewriting it or blocking unrelated mail',async()=>{
  const correction={...event,eventKey:'correction-stale',correction:{previousEventKey:'old-head',classification:'replied' as const}};
  const other={...event,eventKey:'other-mail',contactId:2,customerId:'customer-2'};
  let pending=[correction,other];const failed:ContactMailEventInput[]=[];const acknowledged:string[]=[];
  const service=createContactMailSyncService({context:()=>context,online:()=>true,query:async()=>success({items:[],total:0}),post:async input=>input.correction?failure('CONFLICT','前驱已变化'):receipt(input),replace:()=>{},upsert:()=>{},pending:()=>pending,blockEvent:(_ctx,key)=>{failed.push(...pending.filter(e=>e.eventKey===key));pending=pending.filter(e=>e.eventKey!==key);},acknowledge:(_ctx,key)=>{acknowledged.push(key);pending=pending.filter(e=>e.eventKey!==key);},reconcile:async()=>success(undefined),report:()=>{}});
  expect(await service.flush()).toMatchObject({ok:false,error:{code:'CONFLICT'}});
  expect(failed).toEqual([correction]);expect(failed[0]?.correction?.previousEventKey).toBe('old-head');expect(acknowledged).toEqual(['other-mail']);
 });
 it('retains denied facts for review while continuing unrelated event uploads',async()=>{
  const denied={...event,eventKey:'sent-before-revoke',kind:'sent' as const,direction:'outbound' as const};
  const allowed={...event,eventKey:'other-contact',contactId:2,customerId:'customer-2'};
  let pending=[denied,allowed];const retained:ContactMailEventInput[]=[];const acked:string[]=[];
  const service=createContactMailSyncService({context:()=>context,online:()=>true,query:async()=>success({items:[],total:0}),post:async input=>input.eventKey===denied.eventKey?failure('FORBIDDEN','共享已撤销'):receipt(input),replace:()=>{},upsert:()=>{},pending:()=>pending,blockEvent:(_ctx,key)=>{retained.push(...pending.filter(e=>e.eventKey===key));pending=pending.filter(e=>e.eventKey!==key);},acknowledge:(_ctx,key)=>{acked.push(key);pending=pending.filter(e=>e.eventKey!==key);},reconcile:async()=>success(undefined),report:()=>{}});
  expect(await service.flush()).toMatchObject({ok:false,error:{code:'FORBIDDEN'}});
  expect(retained).toEqual([denied]);expect(acked).toEqual([allowed.eventKey]);expect(pending).toEqual([]);
 });
 it('refreshes authorized contacts before reconciliation then acknowledges real mail receipt',async()=>{const f=fixture();f.queue(event);expect((await f.service.sync()).ok).toBe(true);expect(f.rows()[0]?.contactId).toBe(1);expect(f.reconciles()).toBe(1);expect(f.posts()).toBe(1);expect(f.pending()).toHaveLength(0);});
 it('does not replace a complete mirror with failed partial scan',async()=>{let replace=0;const service=createContactMailSyncService({context:()=>context,online:()=>true,query:async(q)=>q.offset===0?success({items:[row(1)],total:2}):failure('UNAVAILABLE','offline'),post:async()=>failure('UNAVAILABLE','unused'),replace:()=>{replace++;},upsert:()=>{},pending:()=>[],acknowledge:()=>{},reconcile:async()=>success(undefined),report:()=>{}});expect((await service.sync()).ok).toBe(false);expect(replace).toBe(0);});
 it('retains unacknowledged mail after a failed upload',async()=>{let ack=0;const service=createContactMailSyncService({context:()=>context,online:()=>true,query:async()=>success({items:[],total:0}),post:async()=>failure('UNAVAILABLE','offline'),replace:()=>{},upsert:()=>{},pending:()=>[event],acknowledge:()=>{ack++;},reconcile:async()=>success(undefined),report:()=>{}});expect((await service.sync()).ok).toBe(false);expect(ack).toBe(0);});
 it('drops late previous-account contact responses before persistence',async()=>{const f=fixture();f.setCurrent(null);expect((await f.service.sync()).ok).toBe(false);expect(f.rows()).toHaveLength(0);expect(f.posts()).toBe(0);});
 it('discards an actual inflight scan when the active account changes',async()=>{
  let current:typeof context|null=context;let writes=0,posts=0,reconciles=0;const gate=deferred<Result<CenterContactPage>>();
  const service=createContactMailSyncService({context:()=>current,online:()=>true,query:()=>gate.promise,post:async input=>{posts++;return receipt(input);},replace:()=>{writes++;},upsert:()=>{writes++;},pending:()=>[event],acknowledge:()=>{writes++;},reconcile:async()=>{reconciles++;return success(undefined);},report:()=>{}});
  const running=service.sync();current={...context,userId:'u2'};gate.resolve(success({items:[row(1)],total:1}));
  expect(await running).toMatchObject({ok:false,error:{code:'UNAUTHORIZED'}});expect(writes).toBe(0);expect(posts).toBe(0);expect(reconciles).toBe(0);
 });
 it.each(['switch','close'] as const)('does not apply or acknowledge an inflight receipt after %s',async mode=>{
  let current:typeof context|null=context;let writes=0,acks=0;const gate=deferred<Result<ContactMailEventReceipt>>();const started=deferred<void>();
  const service=createContactMailSyncService({context:()=>current,online:()=>true,query:async()=>success({items:[],total:0}),post:()=>{started.resolve();return gate.promise;},replace:()=>{},upsert:()=>{writes++;},pending:()=>[event],acknowledge:()=>{acks++;},reconcile:async()=>success(undefined),report:()=>{}});
  const running=service.flush();await started.promise;current=mode==='close'?null:{...context,userId:'u2'};gate.resolve(receipt(event));
  expect(await running).toMatchObject({ok:false,error:{code:'UNAUTHORIZED'}});expect(writes).toBe(0);expect(acks).toBe(0);
 });
 it('flushes more than one hundred durable events in successive bounded pages',async()=>{
  let events=Array.from({length:205},(_,n)=>({...event,eventKey:`evt-${n}`,messageKey:`msg-${n}`}));const posted:string[]=[];let reads=0;
  const service=createContactMailSyncService({context:()=>context,online:()=>true,query:async()=>success({items:[],total:0}),post:async input=>{posted.push(input.eventKey);return receipt(input);},replace:()=>{},upsert:()=>{},pending:()=>{reads++;return events.slice(0,100);},acknowledge:(_ctx,key)=>{events=events.filter(item=>item.eventKey!==key);},reconcile:async()=>success(undefined),report:()=>{}});
  expect((await service.sync()).ok).toBe(true);expect(events).toEqual([]);expect(posted).toHaveLength(205);expect(new Set(posted).size).toBe(205);expect(reads).toBe(4);
 });
 it('shares a single inflight upload between flush and full sync',async()=>{
  let pending=[event],posts=0;const started=deferred<void>(),gate=deferred<Result<ContactMailEventReceipt>>();
  const service=createContactMailSyncService({context:()=>context,online:()=>true,query:async()=>success({items:[],total:0}),post:()=>{posts++;started.resolve();return gate.promise;},replace:()=>{},upsert:()=>{},pending:()=>pending,acknowledge:()=>{pending=[];},reconcile:async()=>success(undefined),report:()=>{}});
  const flush=service.flush();await started.promise;const scan=service.sync();gate.resolve(receipt(event));expect((await flush).ok).toBe(true);expect((await scan).ok).toBe(true);expect(posts).toBe(1);
 });
 it('preserves a newer upload receipt when an older complete scan arrives afterward',async()=>{
  const scan=deferred<Result<CenterContactPage>>();let pending=[event];let rows:CenterContact[]=[];
  const old={...row(1),contactVersion:1,email:'old@example.com'},updated={...row(1),contactVersion:2,email:'new@example.com'};
  const service=createContactMailSyncService({context:()=>context,online:()=>true,query:()=>scan.promise,post:async input=>receipt(input,updated),replace:(_ctx,value)=>{rows=value;},upsert:(_ctx,value)=>{rows=value;},pending:()=>pending,acknowledge:()=>{pending=[];},reconcile:async()=>success(undefined),report:()=>{}});
  const sync=service.sync();expect((await service.flush()).ok).toBe(true);expect(rows).toEqual([updated]);scan.resolve(success({items:[old],total:1}));await sync;
  expect(await sync).toMatchObject({ok:false,error:{code:'CONFLICT'}});expect(rows).toEqual([updated]);
 });
 it('preserves a newer manual write observed during an inflight contact scan',async()=>{
  const scan=deferred<Result<CenterContactPage>>();let rows:CenterContact[]=[];
  const old={...row(1),contactVersion:1,email:'old@example.com'},updated={...row(1),contactVersion:2,email:'new@example.com'};
  const service=createContactMailSyncService({context:()=>context,online:()=>true,query:()=>scan.promise,post:async input=>receipt(input),replace:(_ctx,value)=>{rows=value;},upsert:(_ctx,value)=>{rows=value;},pending:()=>[],acknowledge:()=>{},reconcile:async()=>success(undefined),report:()=>{}});
  const sync=service.sync();service.observe(context,{contact:updated});scan.resolve(success({items:[old],total:1}));await sync;
  expect(await sync).toMatchObject({ok:false,error:{code:'CONFLICT'}});expect(rows).toEqual([updated]);
 });
 it('does not replace a newer completed scan with an older inflight upload receipt',async()=>{
  const upload=deferred<Result<ContactMailEventReceipt>>(),started=deferred<void>(),reconciled=deferred<void>();let pending=[event];let rows:CenterContact[]=[];
  const old={...row(1),contactVersion:2,email:'old@example.com'},updated={...row(1),contactVersion:3,email:'new@example.com'};
  const service=createContactMailSyncService({context:()=>context,online:()=>true,query:async()=>success({items:[updated],total:1}),post:()=>{started.resolve();return upload.promise;},replace:(_ctx,value)=>{rows=value;},upsert:(_ctx,value)=>{rows=value;},pending:()=>pending,acknowledge:()=>{pending=[];},reconcile:async()=>{reconciled.resolve();return success(undefined);},report:()=>{}});
  const flush=service.flush();await started.promise;const sync=service.sync();await reconciled.promise;expect(rows).toEqual([updated]);upload.resolve(receipt(event,old));await flush;await sync;
  expect(rows).toEqual([updated]);
 });
 it('does not publish a complete snapshot when the center total changes between pages',async()=>{
  let replaced=0;
  const service=createContactMailSyncService({context:()=>context,online:()=>true,query:async input=>input.offset===0?success({items:[row(1)],total:2}):success({items:[],total:1}),post:async input=>receipt(input),replace:()=>{replaced++;},upsert:()=>{},pending:()=>[],acknowledge:()=>{},reconcile:async()=>success(undefined),report:()=>{}});
  expect(await service.sync()).toMatchObject({ok:false,error:{code:'CONFLICT'}});expect(replaced).toBe(0);
 });
});
