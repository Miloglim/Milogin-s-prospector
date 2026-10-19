import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state=vi.hoisted(()=>({dbPath:'',db:null as unknown}));
vi.mock('../../src/main/config',async original=>({...(await original<object>()),get DB_PATH(){return state.dbPath;}}));
vi.mock('../../src/main/logger',()=>({Log:{info(){},warn(){},error(){},debug(){}}}));
vi.mock('../../src/main/db',()=>({getDb:()=>state.db,getRawDb:()=>({prepare:()=>({run:()=>({changes:0})})}),saveDatabase:()=>{}}));
const roots:string[]=[];
afterEach(()=>{for(const root of roots)rmSync(root,{recursive:true,force:true});roots.length=0;});

it('reads the selected account body path rather than the anonymous path captured when modules load',async()=>{
  const root=mkdtempSync(join(tmpdir(),'prospector-body-scope-'));roots.push(root);
  const anonymous=join(root,'anonymous','data'),account=join(root,'account','data');
  for(const dir of [anonymous,account])mkdirSync(join(dir,'bodies'),{recursive:true});
  writeFileSync(join(anonymous,'bodies','1.html'),'anonymous history');
  writeFileSync(join(account,'bodies','1.html'),'selected account body');
  state.dbPath=join(anonymous,'prospector.db');
  const {readLocalBodyHtml}=await import('../../src/main/services/inbox.service');
  expect(readLocalBodyHtml(1)).toBe('anonymous history');
  state.dbPath=join(account,'prospector.db');
  expect(readLocalBodyHtml(1)).toBe('selected account body');
});

it('archives cleanup metadata under the selected account without writing the anonymous directory',async()=>{
  vi.resetModules();
  const root=mkdtempSync(join(tmpdir(),'prospector-body-scope-'));roots.push(root);
  const anonymous=join(root,'anonymous','data'),account=join(root,'account','data');
  for(const dir of [anonymous,account])mkdirSync(dir,{recursive:true});
  let read=0;
  const oldRow={id:1,fromEmail:'synthetic@example.invalid',fromName:'test',subject:'scope archive',bodyPreview:'synthetic',classification:'replied',matchedContactId:null,receivedAt:'2026-10-15T00:00:00Z',accountId:1};
  const chain:any={from:()=>chain,where:()=>chain,orderBy:()=>chain,all:()=>read++===0?Array.from({length:2001},()=>oldRow):[],run:()=>({changes:1})};
  state.db={select:()=>chain,delete:()=>chain};
  state.dbPath=join(anonymous,'prospector.db');
  const {cleanupInbox}=await import('../../src/main/services/inbox.service');
  state.dbPath=join(account,'prospector.db');cleanupInbox();
  expect(existsSync(join(anonymous,'inbox-archive.jsonl'))).toBe(false);
  expect(readFileSync(join(account,'inbox-archive.jsonl'),'utf8')).toContain('scope archive');
});

it('loads per-account deleted-mail keys and discards a cache belonging to another selected path',async()=>{
  const root=mkdtempSync(join(tmpdir(),'prospector-body-scope-'));roots.push(root);
  const anonymous=join(root,'anonymous','data'),account=join(root,'account','data');
  for(const dir of [anonymous,account])mkdirSync(dir,{recursive:true});
  writeFileSync(join(anonymous,'inbox-deleted.json'),JSON.stringify(['1|same-message']));
  writeFileSync(join(account,'inbox-deleted.json'),JSON.stringify(['2|account-message']));
  state.dbPath=join(anonymous,'prospector.db');
  const {isDeleted}=await import('../../src/main/services/inbox.service');
  expect(isDeleted('1|same-message')).toBe(true);
  state.dbPath=join(account,'prospector.db');
  expect(isDeleted('1|same-message')).toBe(false);
  expect(isDeleted('2|account-message')).toBe(true);
});
