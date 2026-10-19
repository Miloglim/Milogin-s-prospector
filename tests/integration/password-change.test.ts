import {describe,it,beforeAll,afterAll,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {readTestDatabaseConfig} from '../../server/adapters/postgres/config';
import {PostgresAuthRepository} from '../../server/adapters/postgres/auth-repository';
import {PostgresAdminRepository} from '../../server/adapters/postgres/admin-repository';
import {PasswordAdapter,tokenAdapter} from '../../server/adapters/password';
import {createAuthService} from '../../server/services/auth';
import {createAdminService} from '../../server/services/admin';
import {createPasswordChangeService} from '../../server/services/password-change';
import {createOnlineServer} from '../../server/transport/http';
import {createAdminHandler} from '../../server/transport/admin-http';
import {createAdminStatic} from '../../server/adapters/admin-static';
import {LoginRateGate} from '../../server/adapters/login-rate';
import {ONLINE_DEFAULTS} from '../../server/core/auth';
const TIMEOUT=30000,TTL=3600,log={write:()=>{}},clock={now:()=>Date.now()};
const userId=randomUUID(),email=`forced-${userId}@example.invalid`,initial=randomBytes(24).toString('hex'),replacement=randomBytes(24).toString('hex');
let pool:Pool,repo:PostgresAuthRepository,crypto:PasswordAdapter,auth:ReturnType<typeof createAuthService>,server:ReturnType<typeof createOnlineServer>,base:string,token:string,other:string;
async function call(route:string,input?:unknown,csrf=true){const response=await fetch(base+route,{method:input===undefined?'GET':'POST',headers:{Origin:base,Cookie:`milogin_admin=${token}`,...(input===undefined?{}:{'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':tokenAdapter.hash(`csrf:${token}`)}:{})})},...(input===undefined?{}:{body:JSON.stringify(input)})});return {status:response.status,body:await response.json() as any};}
async function start(){const admin=createAdminService(new PostgresAdminRepository(pool,log),repo,crypto,tokenAdapter,clock,auth),gate=new LoginRateGate(ONLINE_DEFAULTS,clock);server=createOnlineServer(auth,gate,ONLINE_DEFAULTS,log,'forced-test',createAdminHandler(auth,admin,tokenAdapter,gate,ONLINE_DEFAULTS,createAdminStatic(),createPasswordChangeService(repo,repo,crypto,tokenAdapter,auth)));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('actual mandatory password-change boundary',()=>{
 beforeAll(async()=>{pool=new Pool(readTestDatabaseConfig());repo=new PostgresAuthRepository(pool,log);expect((await repo.migrate()).ok).toBe(true);crypto=new PasswordAdapter(2);await crypto.initialize();expect((await repo.ensureFixture({userId,email,displayName:'forced synthetic',identityAdmin:true,crmRoles:['admin'],passwordHash:await crypto.hash(initial),mustChangePassword:true})).ok).toBe(true);auth=createAuthService(repo,crypto,tokenAdapter,clock,TTL);for(const key of ['token','other']){const result=await auth.login({email,password:initial},'browser');if(!result.ok)throw Error('test login failed');if(key==='token')token=result.data.token;else other=result.data.token;}await start();},TIMEOUT);
 afterAll(async()=>{if(server?.listening)await close();await pool?.end();});
 it('allows me/logout but blocks every administration path and API login before change',async()=>{
  expect((await call('/admin-api/me')).body.data.identity.mustChangePassword).toBe(true);
  for(const route of ['/admin-api/users?search=&limit=25&offset=0','/admin-api/products','/admin-api/audit','/admin-api/sessions?userId='+userId]){const r=await call(route);expect(r.status).toBe(403);expect(r.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');}
  expect((await auth.login({email,password:initial})).ok).toBe(false);expect((await new PostgresAdminRepository(pool,log).users(tokenAdapter.hash(token),{search:'',limit:25,offset:0})).ok).toBe(false);
 });
 it('rejects missing CSRF, wrong current password and weak/reused replacement',async()=>{
  expect((await call('/admin-api/password',{currentPassword:initial,newPassword:replacement},false)).status).toBe(403);
  expect((await call('/admin-api/password',{currentPassword:'wrong-password-value',newPassword:replacement})).status).toBe(401);
  expect((await call('/admin-api/password',{currentPassword:initial,newPassword:'short'})).status).toBe(400);
  expect((await call('/admin-api/password',{currentPassword:initial,newPassword:initial})).status).toBe(400);
  expect((await auth.me(token,'browser')).ok).toBe(true);
 },TIMEOUT);
 it('changes atomically, revokes all sessions, retires initial password and survives restart',async()=>{
  expect((await call('/admin-api/password',{currentPassword:initial,newPassword:replacement})).status).toBe(200);
  expect((await auth.me(token,'browser')).ok).toBe(false);expect((await auth.me(other,'browser')).ok).toBe(false);
  expect((await auth.login({email,password:initial},'browser')).ok).toBe(false);
  expect((await repo.ensureFixture({userId,email,displayName:'must not reset',identityAdmin:true,crmRoles:['admin'],passwordHash:await crypto.hash(initial),mustChangePassword:true})).ok).toBe(true);
  await close();await start();const result=await auth.login({email,password:replacement},'browser');expect(result.ok).toBe(true);if(!result.ok)throw Error('new password failed');token=result.data.token;
  expect(result.data.identity.mustChangePassword).toBe(false);expect((await call('/admin-api/users?limit=25&offset=0')).status).toBe(200);
  expect((await auth.login({email,password:replacement})).ok).toBe(true);
 },TIMEOUT);
});
