import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const runtime=vi.hoisted(()=>({root:'',secure:true}));
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()},app:{getPath:()=>runtime.root},safeStorage:{isEncryptionAvailable:()=>runtime.secure,getSelectedStorageBackend:()=> 'dpapi',encryptString:(v:string)=>Buffer.from('cipher:'+v),decryptString:(v:Buffer)=>{if(!v.toString().startsWith('cipher:'))throw new Error('invalid cipher');return v.toString().slice(7);}}}));
vi.mock('../../src/main/logger',()=>({Log:{error:vi.fn(),warn:vi.fn()}}));
import {createOnlineSessionStore} from '../../src/main/adapters/online-session-store.adapter';
import type {SavedOnlineSession} from '../../src/main/adapters/online-session-store.adapter';
import {OnlineCrmAdapter} from '../../src/main/adapters/online-crm.adapter';
const base='http://127.0.0.1:55844';
const saved=(id:string,autoLogin=true):SavedOnlineSession=>({baseUrl:base,userId:id,email:`${id}@example.invalid`,refreshToken:`refresh-${id}`,autoLogin});
describe('system-encrypted login presets',()=>{
 beforeEach(async()=>{runtime.root=await mkdtemp(join(tmpdir(),'prospector-login-test-'));runtime.secure=true;});
 afterEach(async()=>{await rm(runtime.root,{recursive:true,force:true});});
 it('switching accounts preserves both credentials and prevents automatic restoration after restart',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a'));await store.save(saved('b',false));
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true,data:{token:'bearer-b',refreshToken:'rotated-b',expiresAt:new Date(Date.now()+3600000).toISOString(),identity:{userId:'b',email:'b@example.invalid',displayName:'B',crmRoles:['sales']}}})));
  const client=new OnlineCrmAdapter(fetcher as unknown as typeof fetch,store);
  const b=(await store.list!()).accounts.find(a=>a.email.startsWith('b@'))!;
  expect((await client.loginAccount({accountId:b.accountId,autoLogin:false})).ok).toBe(true);
  fetcher.mockClear();expect((await client.logout({switchAccount:true})).ok).toBe(true);
  expect(client.currentIdentity()).toBeNull();expect(fetcher).not.toHaveBeenCalled();
  const restarted=createOnlineSessionStore();expect(await restarted.load()).toBeNull();
  expect((await restarted.list!()).accounts.every(a=>a.remembered)).toBe(true);
  expect((await restarted.load(b.accountId))?.refreshToken).toBe('rotated-b');
 });
 it('rejects malformed switch requests without clearing credentials',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a'));
  const client=new OnlineCrmAdapter(fetch,store);
  expect((await client.logout({switchAccount:'yes'} as never)).ok).toBe(false);
  expect((await store.list!()).accounts[0].remembered).toBe(true);
 });
 it('keeps both accounts across a new store and exposes no credentials in metadata',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a'));await store.save(saved('b'));
  const next=createOnlineSessionStore(),list=await next.list!();expect(list.accounts.map(a=>a.email).sort()).toEqual(['a@example.invalid','b@example.invalid']);
  expect(JSON.stringify(list)).not.toContain('refresh-');expect((await next.load())?.userId).toBe('b');
  expect((await next.load(list.accounts.find(a=>a.email.startsWith('a@'))!.accountId))?.userId).toBe('a');
 });
 it('remembering a credential without automatic login does not restore at startup',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a',false));expect(await store.load()).toBeNull();
  const list=await store.list!();expect(list.accounts[0]).toMatchObject({remembered:true,autoLogin:false});expect((await store.load(list.accounts[0].accountId))?.refreshToken).toBe('refresh-a');
 });
 it('logout clears only the current credential and preserves preset and other account',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a'));await store.save(saved('b'));await store.clear();
  const list=await store.list!();expect(list.accounts).toHaveLength(2);expect(list.accounts.find(a=>a.email.startsWith('b@'))).toMatchObject({remembered:false,autoLogin:false});
  expect(await createOnlineSessionStore().load()).toBeNull();expect((await store.load(list.accounts.find(a=>a.email.startsWith('a@'))!.accountId))?.userId).toBe('a');
 });
 it('removing a preset deletes only it, with no fallback auto-login to a different account',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a'));await store.save(saved('b'));const b=(await store.list!()).accounts.find(a=>a.email.startsWith('b@'))!;
  await store.remove!(b.accountId);expect((await store.list!()).accounts.map(a=>a.email)).toEqual(['a@example.invalid']);expect(await store.load()).toBeNull();
 });
 it('records a successful non-remembered login without keeping its previous credential',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a'));await store.record!({baseUrl:base,userId:'a',email:'a@example.invalid'});
  expect((await store.list!()).accounts[0]).toMatchObject({remembered:false,autoLogin:false});expect(await store.load()).toBeNull();
 });
 it('migrates the legacy single credential without losing it',async()=>{
  const old={baseUrl:base,userId:'legacy',refreshToken:'legacy-refresh'};await writeFile(join(runtime.root,'prospector-refresh.enc'),Buffer.from('cipher:'+JSON.stringify(old)));
  const store=createOnlineSessionStore();expect(await store.load()).toMatchObject(old);await store.save(saved('b'));
  expect((await store.list!()).accounts).toHaveLength(2);expect((await readFile(join(runtime.root,'prospector-refresh.enc'))).toString()).not.toContain('password');
 });
 it('serializes concurrent updates so neither account disappears',async()=>{
  const store=createOnlineSessionStore();await Promise.all([store.save(saved('a')),store.save(saved('b'))]);expect((await store.list!()).accounts).toHaveLength(2);
 });
 it('never writes credentials when system encryption is unavailable',async()=>{
  runtime.secure=false;const store=createOnlineSessionStore();await expect(store.save(saved('a'))).rejects.toThrow();expect(await store.load()).toBeNull();
  await expect(readFile(join(runtime.root,'prospector-refresh.enc'))).rejects.toMatchObject({code:'ENOENT'});
 });
 it('manual remembered login uses refresh only, honors auto-login choice and isolates logout',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a'));await store.save(saved('b',false));
  const fetcher=vi.fn(async(_url:string,init?:RequestInit)=>{const id=JSON.parse(String(init?.body)).refreshToken.endsWith('a')?'a':'b';return new Response(JSON.stringify({ok:true,data:{token:'bearer-'+id,refreshToken:'rotated-'+id,expiresAt:new Date(Date.now()+3600000).toISOString(),identity:{userId:id,email:`${id}@example.invalid`,displayName:id,emailVerified:true,identityAdmin:false,crmRoles:['sales']}}}));});
  const client=new OnlineCrmAdapter(fetcher as unknown as typeof fetch,store);
  expect((await client.restore()).ok).toBe(true);expect(fetcher).not.toHaveBeenCalled();
  const account=(await client.accounts()).data!.accounts.find(a=>a.email.startsWith('b@'))!;
  expect((await client.loginAccount({accountId:account.accountId,autoLogin:false})).ok).toBe(true);expect(client.currentIdentity()?.userId).toBe('b');
  expect(fetcher.mock.calls[0][0]).toContain('/refresh');expect(JSON.stringify(fetcher.mock.calls)).not.toContain('password');
  // Logout endpoint is also real transport-shaped, without exposing its payload to renderer.
  fetcher.mockImplementation(async()=>new Response(JSON.stringify({ok:true,data:null})));
  await client.logout();expect((await store.list!()).accounts.find(a=>a.email.startsWith('a@'))?.remembered).toBe(true);expect((await store.list!()).accounts.find(a=>a.email.startsWith('b@'))?.remembered).toBe(false);
 });
 it('a revoked preset loses its credentials, never switches to another account',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a'));await store.save(saved('b',false));
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:false,error:{code:'UNAUTHORIZED',message:'revoked'}})));
  const client=new OnlineCrmAdapter(fetcher as unknown as typeof fetch,store),b=(await store.list!()).accounts.find(a=>a.email.startsWith('b@'))!;
  expect((await client.loginAccount({accountId:b.accountId,autoLogin:true})).ok).toBe(false);expect(client.currentIdentity()).toBeNull();
  expect((await store.list!()).accounts.find(a=>a.email.startsWith('b@'))?.remembered).toBe(false);expect((await store.list!()).accounts.find(a=>a.email.startsWith('a@'))?.remembered).toBe(true);
 });
 it('rejects a refresh for a different identity before saving or admitting it',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a'));
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true,data:{token:'wrong-token',refreshToken:'wrong-refresh',identity:{userId:'wrong',email:'wrong@example.invalid',crmRoles:['sales']}}})));
  const client=new OnlineCrmAdapter(fetcher as unknown as typeof fetch,store);
  expect((await client.restore()).ok).toBe(false);expect(client.currentIdentity()).toBeNull();
  expect((await store.list!()).accounts).toHaveLength(1);expect((await store.list!()).accounts[0].remembered).toBe(false);
 });
 it('auto restoration stays at the password-change gate and never grants local authority',async()=>{
  const store=createOnlineSessionStore();await store.save(saved('a'));
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({ok:true,data:{token:'restricted',refreshToken:'restricted-refresh',expiresAt:new Date(Date.now()+3600000).toISOString(),identity:{userId:'a',email:'a@example.invalid',emailVerified:true,displayName:'A',identityAdmin:true,crmRoles:['admin'],mustChangePassword:true}}})));
  const client=new OnlineCrmAdapter(fetcher as unknown as typeof fetch,store),state=await client.restore();
  expect(state.ok&&state.data.identity?.mustChangePassword).toBe(true);expect(client.currentIdentity()).toBeNull();
  expect((await client.removeAccount((await store.list!()).accounts[0].accountId)).ok).toBe(false);
 });
});
