import { afterEach, beforeAll, expect, it } from 'vitest';
import initSqlJs, { type Database as SqlDatabase, type SqlJsStatic } from 'sql.js';
import { resolve } from 'node:path';
import type { Database } from 'better-sqlite3';
import { SqliteContactMirrorStore } from '../../src/main/adapters/contact-mirror-store.adapter';
import type { ContactCommandRow } from '../../src/main/core/contact-commands';
import { createContactCommandService } from '../../src/main/services/contact-command.service';
import type { CenterContactDetail } from '../../server/core/contact-assignments';
import { success } from '../../server/core/crm';

let SQL: SqlJsStatic;
const databases = new Map<string, SqlDatabase>();
const preparedQueries: string[]=[];
const alice = { baseUrl: 'https://center.test', userId: 'alice', permissionKey: 'sales' };
beforeAll(async () => { SQL = await initSqlJs({ locateFile: file => resolve('node_modules/sql.js/dist', file) }); });
afterEach(() => { for (const db of databases.values()) db.close(); databases.clear();preparedQueries.length=0; });
function open(ctx: typeof alice): Database {
  const key = JSON.stringify([ctx.baseUrl, ctx.userId]);
  let raw = databases.get(key);
  if (!raw) { raw = new SQL.Database(); databases.set(key, raw); }
  const db = raw;
  return {
    exec: (sql: string) => { db.run(sql); },
    prepare(sql: string) {
      preparedQueries.push(sql);
      const all = (...args: unknown[]) => {
        const statement = db.prepare(sql);
        try { statement.bind(args as never); const rows: unknown[] = []; while (statement.step()) rows.push(statement.getAsObject()); return rows; }
        finally { statement.free(); }
      };
      return { all, get: (...args: unknown[]) => all(...args)[0], run: (...args: unknown[]) => { db.run(sql, args as never); return { changes: db.getRowsModified() }; } };
    },
    transaction: (work: () => void) => () => { db.run('BEGIN'); try { work(); db.run('COMMIT'); } catch (error) { db.run('ROLLBACK'); throw error; } },
  } as unknown as Database;
}
it('persists across store recreation and isolates account, center and permission', () => {
  const row = { id: 'contact-command:one', status: 'pending', action: 'update', input: { contactId: 7, customerId: 'customer-a', expectedVersion: 3, idempotencyKey: 'stable-key', fields: { phone: '123' } }, createdAt: '2026-10-16T00:00:00Z' };
  const first = new SqliteContactMirrorStore(open);
  first.putCommand(alice, row as never);
  const second = new SqliteContactMirrorStore(open);
  expect(second.commandRows(alice)).toEqual([row]);
  expect(second.commandRows({ ...alice, userId: 'bob' })).toEqual([]);
  expect(second.commandRows({ ...alice, baseUrl: 'https://another.test' })).toEqual([]);
  expect(second.commandRows({ ...alice, permissionKey: 'admin' })).toEqual([]);
  second.putCommand(alice, { ...row, status: 'conflict' } as never);
  expect(second.commandRows(alice)).toHaveLength(1);
  expect(second.commandRows(alice)[0]?.status).toBe('conflict');
  second.removeCommand(alice, row.id);
  expect(first.commandRows(alice)).toEqual([]);
});
it('rolls back a failed group update instead of leaving half a rebased command chain', () => {
  const store=new SqliteContactMirrorStore(open);
  const row={id:'contact-command:one',status:'pending',action:'update',input:{contactId:7,customerId:'customer-a',expectedVersion:3,idempotencyKey:'stable-key',fields:{phone:'123'}},createdAt:'2026-10-16T00:00:00Z'};
  store.putCommand(alice,row as never);
  expect(()=>store.commandTransaction(alice,()=>{store.putCommand(alice,{...row,status:'conflict'} as never);throw new Error('disk failure');})).toThrow('disk failure');
  expect(store.commandRows(alice)).toEqual([row]);
});

const confirmedCommand = (id: string, extra: Partial<ContactCommandRow> = {}): ContactCommandRow => ({
  id:`contact-command:${id}`,status:'confirmed',action:'update',
  input:{contactId:7,customerId:'customer-a',expectedVersion:3,idempotencyKey:id,fields:{phone:'private payload'}},
  createdAt:'2026-01-01T00:00:00Z',confirmedAt:'2026-01-02T00:00:00Z',...extra,
});
it('compacts only aged confirmed payloads and preserves replay and retired-key rejection across restart', () => {
  const store=new SqliteContactMirrorStore(open),row=confirmedCommand('old',{retiredKeys:['retired'],history:[{contactId:7,customerId:'customer-a',expectedVersion:2,idempotencyKey:'retired',fields:{phone:'older secret'}}]});
  store.putCommand(alice,row);store.maintainCommands(alice,'2026-03-01T00:00:00Z');
  expect(store.commandRows(alice)).toEqual([]);
  const raw=databases.get(JSON.stringify([alice.baseUrl,alice.userId]))!.exec('SELECT payload FROM crm_contact_commands')[0].values.flat().join('');
  expect(raw).not.toContain('private payload');expect(raw).not.toContain('older secret');
  const restored=new SqliteContactMirrorStore(open);
  expect(restored.findCommandDuplicate(alice,'update',row.input)).toMatchObject({matches:true,confirmed:true});
  expect(restored.findCommandDuplicate(alice,'update',{...row.input,fields:{phone:'different'}})).toMatchObject({matches:false});
  expect(restored.findCommandDuplicate(alice,'update',{...row.input,idempotencyKey:'retired'})).toMatchObject({matches:false});
  expect(restored.findCommandDuplicate({...alice,permissionKey:'other'},'update',row.input)).toBeUndefined();
  expect(restored.commandConfirmed(alice,row.id)).toBe(true);
});
it('keeps unresolved inputs, confirmed predecessor evidence and a full interval for legacy confirmations',()=>{
  const store=new SqliteContactMirrorStore(open),parent=confirmedCommand('parent'),legacy=confirmedCommand('legacy',{confirmedAt:undefined});
  const pending=confirmedCommand('pending',{status:'pending',predecessorId:parent.id,attempted:true});
  const failed=confirmedCommand('failed',{status:'failed'}),conflict=confirmedCommand('conflict',{status:'conflict'});
  for(const row of [parent,legacy,pending,failed,conflict])store.putCommand(alice,row);
  store.maintainCommands(alice,'2026-03-01T00:00:00Z');
  expect(store.commandRows(alice)).toHaveLength(5);
  expect(store.commandRows(alice).find(row=>row.id===legacy.id)?.confirmedAt).toBe('2026-03-01T00:00:00Z');
  expect(store.unresolvedCommands(alice)).toEqual([pending,failed,conflict]);
  store.maintainCommands(alice,'2026-03-02T00:00:00Z');expect(store.commandRows(alice)).toHaveLength(5);
});
it('does not compact a recently confirmed old draft, wrong scope, invalid timestamp or unknown delivery',()=>{
  const store=new SqliteContactMirrorStore(open),now='2026-03-01T00:00:00Z';
  const recent=confirmedCommand('recent',{confirmedAt:'2026-02-28T00:00:00Z'}),invalid=confirmedCommand('invalid',{confirmedAt:'bad-date'}),unknown=confirmedCommand('unknown',{status:'pending',attempted:true});
  for(const row of [recent,invalid,unknown])store.putCommand(alice,row);
  store.putCommand({...alice,permissionKey:'admin'},confirmedCommand('other'));
  store.maintainCommands(alice,now);
  expect(store.commandRows(alice)).toHaveLength(3);expect(store.commandRows({...alice,permissionKey:'admin'})).toHaveLength(1);
  expect(()=>store.maintainCommands(alice,'bad-date')).toThrow();
});
it('uses permanent receipts for authorized duplicate replay and predecessor progression without reading confirmed history',async()=>{
  const store=new SqliteContactMirrorStore(open),customerId='00000000-0000-4000-8000-000000000007';
  const row=confirmedCommand('old',{input:{...confirmedCommand('old').input,customerId}});
  store.putCommand(alice,row);store.maintainCommands(alice,'2026-03-01T00:00:00Z');
  let detail={contact:{contactId:7,customerId,contactVersion:4,extra:{}},activities:[],canEdit:true,canFollowup:true} as unknown as CenterContactDetail;
  let sends=0;const ctx={...alice,active:()=>true,online:()=>false};
  const service=createContactCommandService({context:()=>ctx,store:{
    list:()=>{throw new Error('confirmed history hot path');},unresolved:ctx=>store.unresolvedCommands(ctx),get:(ctx,id)=>store.getCommand(ctx,id),confirmed:(ctx,id)=>store.commandConfirmed(ctx,id),duplicate:(ctx,action,input)=>store.findCommandDuplicate(ctx,action,input),maintain:(ctx,now)=>store.maintainCommands(ctx,now),put:(ctx,row)=>store.putCommand(ctx,row),remove:(ctx,id)=>store.removeCommand(ctx,id),transaction:(ctx,work)=>store.commandTransaction(ctx,work),
  },detail:()=>detail,send:async()=>{sends++;return success({...detail,contact:{...detail.contact,contactVersion:5}});},refresh:async()=>success(detail),save:(_ctx,value)=>{detail=value;},forget:()=>{},key:()=> 'next',now:()=> '2026-03-01T00:00:00Z',report:error=>{throw error;}});
  expect(await service.write('update',row.input)).toMatchObject({ok:true});expect(sends).toBe(0);
  expect(await service.write('update',{...row.input,fields:{phone:'different'}})).toMatchObject({ok:false,error:{code:'CONFLICT'}});
  const child=confirmedCommand('next',{status:'pending',predecessorId:row.id,input:{...row.input,idempotencyKey:'next',expectedVersion:4}});
  store.putCommand(alice,child);ctx.online=()=>true;
  expect(await service.sync()).toMatchObject({ok:true});expect(sends).toBe(1);expect(service.status()).toMatchObject({pending:0});
  expect(service.detail(ctx,detail).localSync).toBeUndefined();
});
it('rechecks permanent key reservations inside the write transaction across independent store instances',async()=>{
  const store=new SqliteContactMirrorStore(open),other=new SqliteContactMirrorStore(open),customerId='00000000-0000-4000-8000-000000000007';
  const incoming={...confirmedCommand('race').input,customerId};
  const winner=confirmedCommand('race',{input:{...incoming,fields:{phone:'other process'}}});
  const detail={contact:{contactId:7,customerId,contactVersion:3,extra:{}},activities:[],canEdit:true} as unknown as CenterContactDetail;
  const ctx={...alice,active:()=>true,online:()=>false};let injected=false;
  const service=createContactCommandService({context:()=>ctx,store:{
    list:ctx=>store.commandRows(ctx),unresolved:ctx=>store.unresolvedCommands(ctx),duplicate:(ctx,action,input)=>store.findCommandDuplicate(ctx,action,input),
    put:(ctx,row)=>store.putCommand(ctx,row),remove:(ctx,id)=>store.removeCommand(ctx,id),
    transaction:(ctx,work)=>{if(!injected){injected=true;other.putCommand(ctx,winner);other.maintainCommands(ctx,'2026-03-01T00:00:00Z');}store.commandTransaction(ctx,work);},
  },detail:()=>detail,send:async()=>success(detail),refresh:async()=>success(detail),save:()=>{},forget:()=>{},key:()=> 'new',now:()=> '2026-03-01T00:00:00Z',report:error=>{throw error;}});
  expect(await service.write('update',incoming)).toMatchObject({ok:false,error:{code:'CONFLICT'}});
  expect(store.findCommandDuplicate(alice,'update',winner.input)).toMatchObject({matches:true,confirmed:true});
  expect(store.unresolvedCommands(alice)).toEqual([]);
});
it('uses both indexed keys in the correlated unresolved-predecessor lookup',()=>{
  const store=new SqliteContactMirrorStore(open);store.putCommand(alice,confirmedCommand('plan'));store.maintainCommands(alice,'2026-03-01T00:00:00Z');
  const query=preparedQueries.find(sql=>sql.startsWith('SELECT payload')&&sql.includes('child INDEXED BY'))!;
  const plan=open(alice).prepare('EXPLAIN QUERY PLAN '+query).all(alice.permissionKey,100) as {detail:string}[];
  expect(plan.find(row=>row.detail.includes('child USING INDEX crm_contact_commands_predecessor'))?.detail).toContain('permission_key=? AND <expr>=?');
});
