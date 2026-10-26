import { describe,it,beforeAll,afterAll,expect } from "vitest";
import { Pool } from "pg";
import { randomBytes,randomUUID } from "node:crypto";
import { readTestDatabaseConfig } from "../../server/adapters/postgres/config";
import { PostgresAuthRepository } from "../../server/adapters/postgres/auth-repository";
import { PostgresCrmRepository } from "../../server/adapters/postgres/repository";
import { PostgresAdminRepository } from "../../server/adapters/postgres/admin-repository";
import { PasswordAdapter,tokenAdapter } from "../../server/adapters/password";
import { createAuthService } from "../../server/services/auth";
import { createAdminService } from "../../server/services/admin";
import { capabilitiesFor } from "../../server/core/admin";
import { ONLINE_DEFAULTS,type CrmRole } from "../../server/core/auth";
import { createOnlineServer } from '../../server/transport/http';
import { createAdminHandler } from '../../server/transport/admin-http';
import { createAdminStatic } from '../../server/adapters/admin-static';
import { LoginRateGate } from '../../server/adapters/login-rate';
import { createAdminDataBrowserService } from '../../server/services/admin-data-browser';
const TIMEOUT=30000,TTL=3600;
const log={write:()=>{}};const password=randomBytes(24).toString('hex');
let pool:Pool,authRepo:PostgresAuthRepository,repo:PostgresAdminRepository,crypto:PasswordAdapter;
let auth:ReturnType<typeof createAuthService>,admin:ReturnType<typeof createAdminService>;
let dataBrowser:ReturnType<typeof createAdminDataBrowserService>;
let manager:string,sales:string,managerId:string,salesId:string,managerEmail:string;
let server:ReturnType<typeof createOnlineServer>,base:string;
async function start(){
 const config={...ONLINE_DEFAULTS,test_mode:true},gate=new LoginRateGate(config,{now:()=>Date.now()});
 server=createOnlineServer(auth,gate,config,log,'test',createAdminHandler(auth,admin,tokenAdapter,gate,config,createAdminStatic(),undefined,undefined,dataBrowser));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};base=`http://127.0.0.1:${address.port}`;
}
async function close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
async function request(route:string,input?:unknown,token=manager){
 const response=await fetch(base+route,{method:input===undefined?'GET':'POST',headers:{Cookie:`milogin_admin=${token}`,Origin:base,...(input===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':tokenAdapter.hash(`csrf:${token}`)})},...(input===undefined?{}:{body:JSON.stringify(input)})});
 return {status:response.status,body:await response.json() as any,headers:response.headers};
}
function unwrap<T>(r:{ok:true;data:T}|{ok:false;error:unknown}):T {if(!r.ok)throw Error(`unexpected failure: ${JSON.stringify(r.error)}`);return r.data;}
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION==='1')('M1 actual PG management boundary',()=>{
  beforeAll(async()=>{
    pool=new Pool(readTestDatabaseConfig());await new PostgresCrmRepository(pool,log).migrate();authRepo=new PostgresAuthRepository(pool,log);await authRepo.migrate();
    repo=new PostgresAdminRepository(pool,log);unwrap(await repo.migrate());crypto=new PasswordAdapter(2);await crypto.initialize();
    const hash=await crypto.hash(password);
    for(const [key,roles,identityAdmin] of [['manager',['admin'],true],['sales',['sales'],false]] as [string,CrmRole[],boolean][]){
      const userId=randomUUID(),email=`m1-${userId}@example.invalid`;unwrap(await authRepo.ensureFixture({userId,email,displayName:key,identityAdmin,crmRoles:roles,passwordHash:hash}));
      auth=createAuthService(authRepo,crypto,tokenAdapter,{now:()=>Date.now()},TTL);
      const login=unwrap(await auth.login({email,password},'browser'));if(key==='manager'){manager=login.token;managerId=userId;managerEmail=email;}else{sales=login.token;salesId=userId;}
    }
    admin=createAdminService(repo,authRepo,crypto,tokenAdapter,{now:()=>Date.now()},auth);
    dataBrowser=createAdminDataBrowserService(repo,tokenAdapter);
    await start();
  },TIMEOUT);
  afterAll(async()=>{if(server?.listening)await close();await pool?.end();});
  it('separates browser/API sessions and refuses sales management',async()=>{
    expect((await auth.me(manager)).ok).toBe(false);expect((await auth.me(manager,'browser')).ok).toBe(true);
    expect((await admin.users(sales,{search:'',limit:25,offset:0})).ok).toBe(false);
    const products=unwrap(await admin.products(manager));expect(products.find(p=>p.productId==='navigator')?.connected).toBe(true);
  });
  it('browses whitelisted business rows and refuses non-super-admins',async()=>{
    const catalog=await request('/admin-api/data');
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.map((table:any)=>table.id)).toContain('identity.users');
    expect(catalog.body.data.map((table:any)=>table.id)).not.toContain('identity.credentials');
    expect(catalog.body.data.map((table:any)=>table.id)).not.toContain('public.crm_import_rows');
    const users=await request(`/admin-api/data?table=identity.users&search=${encodeURIComponent(managerId)}&limit=100&offset=0`);
    expect(users.status).toBe(200);
    expect(users.body.data.rows.some((row:any)=>row.user_id===managerId)).toBe(true);
    expect(users.body.data.columns.some((column:any)=>/password|token|secret|hash/i.test(column.key))).toBe(false);
    expect((await request('/admin-api/data?table=identity.credentials&limit=25&offset=0')).status).toBe(400);
    expect((await request('/admin-api/data?table=identity.users&sort=password_hash&limit=25&offset=0')).status).toBe(400);
    expect((await request('/admin-api/data',undefined,sales)).status).toBe(403);
  });
  it('grants Navigator access only from its own product permission and revokes immediately',async()=>{
    const managerApi=unwrap(await auth.login({email:managerEmail,password})).token;
    expect(unwrap(await auth.navigatorAccess(managerApi))).toMatchObject({userId:managerId,role:'admin'});
    expect(unwrap(await auth.navigatorAccess(manager))).toMatchObject({userId:managerId,role:'admin'});
    const target=unwrap(await admin.users(manager,{search:salesId,limit:25,offset:0})).items[0]!;
    const salesApi=unwrap(await auth.login({email:target.email,password})).token;
    expect((await auth.navigatorAccess(salesApi)).ok).toBe(false);
    unwrap(await admin.mutate(manager,{action:'navigator.update',userId:salesId,revision:target.revision,active:true,role:'sales',reason:'synthetic Navigator grant'},password));
    const response=await fetch(base+'/api/navigator/access',{headers:{Authorization:`Bearer ${salesApi}`}});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok:true,data:{userId:salesId,role:'sales'}});
    const updated=unwrap(await admin.users(manager,{search:salesId,limit:25,offset:0})).items[0]!;
    unwrap(await admin.mutate(manager,{action:'navigator.update',userId:salesId,revision:updated.revision,active:true,role:'operations',reason:'synthetic Navigator operator'},password));
    expect(unwrap(await auth.navigatorAccess(salesApi)).role).toBe('operator');
    const operator=unwrap(await admin.users(manager,{search:salesId,limit:25,offset:0})).items[0]!;
    unwrap(await admin.mutate(manager,{action:'navigator.update',userId:salesId,revision:operator.revision,active:false,role:'operations',reason:'synthetic Navigator revoke'},password));
    expect((await auth.navigatorAccess(salesApi)).ok).toBe(false);
  },TIMEOUT);
  it('does not let a CRM-only manager grant Navigator roles',async()=>{
    const userId=randomUUID(),email=`navigator-crm-${userId}@example.invalid`;
    unwrap(await authRepo.ensureFixture({userId,email,displayName:'CRM-only manager',identityAdmin:false,crmRoles:['admin'],passwordHash:await crypto.hash(password)}));
    const crmManager=unwrap(await auth.login({email,password},'browser')).token;
    const target=unwrap(await admin.users(manager,{search:salesId,limit:25,offset:0})).items[0]!;
    expect((await admin.mutate(crmManager,{action:'navigator.update',userId:salesId,revision:target.revision,active:true,role:'operations',reason:'must not delegate'},password)).ok).toBe(false);
    expect((await auth.navigatorAccess(unwrap(await auth.login({email,password})).token)).ok).toBe(false);
  },TIMEOUT);
  it('does not turn a Navigator-only grant into CRM management access',async()=>{
    const userId=randomUUID(),email=`navigator-only-${userId}@example.invalid`;
    unwrap(await authRepo.ensureFixture({userId,email,displayName:'Navigator-only member',identityAdmin:false,crmRoles:[],passwordHash:await crypto.hash(password)}));
    const member=unwrap(await admin.users(manager,{search:userId,limit:25,offset:0})).items[0]!;
    unwrap(await admin.mutate(manager,{action:'navigator.update',userId,revision:member.revision,active:true,role:'operations',reason:'synthetic product isolation'},password));
    const browser=unwrap(await auth.login({email,password},'browser')).token;
    const api=unwrap(await auth.login({email,password})).token;
    expect(unwrap(await auth.navigatorAccess(api)).role).toBe('operator');
    expect((await auth.crmAccess(api)).ok).toBe(false);
    expect((await admin.users(browser,{search:'',limit:25,offset:0,productId:'crm'})).ok).toBe(false);
  },TIMEOUT);
  it('changes scoped capabilities atomically and rejects stale revisions',async()=>{
    const target=unwrap(await admin.users(manager,{search:salesId,limit:25,offset:0})).items[0]!;
    const command={action:'product.update',userId:salesId,revision:target.revision,productId:'crm',active:true,roles:['sales'],capabilities:['leads.claim'],scope:'own',reason:'synthetic permission test'};
    expect((await admin.mutate(manager,command,password)).ok).toBe(true);
    expect((await admin.mutate(manager,command,password)).ok).toBe(false);
    const updated=unwrap(await admin.users(manager,{search:salesId,limit:25,offset:0})).items[0]!;
    expect(updated.capabilities).toEqual(['leads.claim']);
    expect((await admin.mutate(manager,{...command,revision:updated.revision,capabilities:['navigator.rates.query']},password)).ok).toBe(false);
  },TIMEOUT);
  it('requires reauthentication, forbids unsupported products and self elevation',async()=>{
    expect((await admin.mutate(manager,{action:'session.revoke',userId:salesId,sessionId:randomUUID(),reason:'test'},'wrong-password-value')).ok).toBe(false);
    expect((await admin.mutate(manager,{action:'product.update',userId:salesId,revision:1,productId:'navigator',active:true,roles:['admin'],capabilities:capabilitiesFor(['admin']),scope:'summary',reason:'test'},password)).ok).toBe(false);
  },TIMEOUT);
  it('preserves configured role templates through product disable/re-enable',async()=>{
    let user=unwrap(await admin.users(manager,{search:salesId,limit:25,offset:0})).items[0]!;
    unwrap(await admin.mutate(manager,{action:'product.update',userId:salesId,revision:user.revision,productId:'crm',active:false,roles:user.crmRoles,capabilities:user.capabilities,scope:user.scope,reason:'test suspend product'},password));
    user=unwrap(await admin.users(manager,{search:salesId,limit:25,offset:0})).items[0]!;
    expect(user.crmRoles).toEqual(['sales']);expect(user.accessActive).toBe(false);
    unwrap(await admin.mutate(manager,{action:'product.update',userId:salesId,revision:user.revision,productId:'crm',active:true,roles:user.crmRoles,capabilities:user.capabilities,scope:user.scope,reason:'test restore product'},password));
  },TIMEOUT);
  it('cannot promote an unactivated identity to a usable administrator',async()=>{
    const email=`pending-${randomUUID()}@example.invalid`;
    unwrap(await admin.mutate(manager,{action:'challenge.issue',purpose:'activate',email,displayName:'pending test',reason:'test pending'},password));
    const target=unwrap(await admin.users(manager,{search:email,limit:25,offset:0})).items[0]!;
    expect((await admin.mutate(manager,{action:'user.update',userId:target.userId,revision:target.revision,active:true,identityAdmin:true,reason:'test invalid promote'},password)).ok).toBe(false);
  },TIMEOUT);
  it('reissues activation for pending identities and invalidates the old link',async()=>{
    const email=`reissue-${randomUUID()}@example.invalid`,command={action:'challenge.issue',purpose:'activate',email,displayName:'pending reissue',reason:'test pending reissue'};
    const first=unwrap(await admin.mutate(manager,command,password));
    await pool.query("UPDATE identity.management_challenges SET expires_at=now()-interval '1 second' WHERE token_hash=$1",[tokenAdapter.hash(first.challengeToken!)]);
    const second=unwrap(await admin.mutate(manager,command,password));
    expect((await admin.consume({token:first.challengeToken,password})).ok).toBe(false);
    unwrap(await admin.consume({token:second.challengeToken,password}));
    expect((await admin.mutate(manager,command,password)).ok).toBe(false);
  },TIMEOUT);
  it('revokes selected sessions and keeps immutable management audit',async()=>{
    const sessions=unwrap(await admin.sessions(manager,salesId));expect(sessions.length).toBeGreaterThan(0);
    const selected=(await pool.query('SELECT session_id FROM identity.sessions WHERE token_hash=$1',[tokenAdapter.hash(sales)])).rows[0].session_id;expect(sessions.some(x=>x.sessionId===selected)).toBe(true);
    unwrap(await admin.mutate(manager,{action:'session.revoke',userId:salesId,sessionId:selected,reason:'test revoke'},password));
    expect((await auth.me(sales,'browser')).ok).toBe(false);
    const events=unwrap(await admin.audit(manager));expect(events.some(e=>e.action==='session.revoke')).toBe(true);
  },TIMEOUT);
  it('consumes purpose-bound activation/recovery once, without marking email verified',async()=>{
    const email=`invite-${randomUUID()}@example.invalid`;
    const issued=unwrap(await admin.mutate(manager,{action:'challenge.issue',purpose:'activate',email,displayName:'test invite',reason:'synthetic invitation'},password));
    const next=randomBytes(24).toString('hex');
    unwrap(await admin.consume({token:issued.challengeToken,password:next}));
    expect((await admin.consume({token:issued.challengeToken,password:next})).ok).toBe(false);
    const login=unwrap(await auth.login({email,password:next},'browser'));expect(login.identity.emailVerified).toBe(false);
    const recovery=unwrap(await admin.mutate(manager,{action:'challenge.issue',purpose:'recover',email,displayName:'test invite',reason:'test recovery'},password));
    unwrap(await admin.consume({token:recovery.challengeToken,password:next}));
    expect((await auth.me(login.token,'browser')).ok).toBe(false);
  },TIMEOUT);
  it('refuses last usable administrator disable',async()=>{
    const active=await pool.query('SELECT user_id,identity_admin FROM identity.users WHERE active AND identity_admin');
    const saved=active.rows.filter(row=>row.user_id!==managerId);
    try{
      for(const row of saved)await pool.query('UPDATE identity.users SET identity_admin=false WHERE user_id=$1',[row.user_id]);
      const target=unwrap(await admin.users(manager,{search:managerId,limit:25,offset:0})).items[0]!;
      expect((await admin.mutate(manager,{action:'user.update',userId:managerId,revision:target.revision,active:false,identityAdmin:true,reason:'last admin test'},password)).ok).toBe(false);
    }finally{for(const row of saved)await pool.query('UPDATE identity.users SET identity_admin=true WHERE user_id=$1',[row.user_id]);}
  },TIMEOUT);
  it('serves actual static workbench with restrictive browser headers',async()=>{
    const response=await fetch(base+'/');expect(response.status).toBe(200);expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');const html=await response.text();expect(html).toContain('/assets/');expect(html).not.toContain('gpt');
    expect((await fetch(base+'/assets/%2e%2e%2fpackage.json')).status).toBe(404);
  });
  it('performs real browser login without leaking bearer and cannot cross session resources',async()=>{
    const response=await request('/admin-api/login',{email:managerEmail,password});expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toContain('HttpOnly');expect(response.body.data.token).toBeUndefined();
    expect((await request('/admin-api/users?search='+managerId+'&limit=25&offset=0')).body.data.items[0].userId).toBe(managerId);
    const cross=await fetch(base+'/api/auth/me',{headers:{Authorization:`Bearer ${manager}`}});expect(cross.status).toBe(401);
    const apiToken=unwrap(await auth.login({email:managerEmail,password})).token;
    expect((await request('/admin-api/me',undefined,apiToken)).status).toBe(401);
  },TIMEOUT);
  it('applies HTTP revocation and preserves it across server restart',async()=>{
    const credential=await pool.query('SELECT email FROM identity.login_emails WHERE user_id=$1',[salesId]);
    const second=unwrap(await auth.login({email:credential.rows[0].email,password},'browser')).token;
    const sessions=unwrap(await admin.sessions(manager,salesId));const current=(await pool.query('SELECT session_id FROM identity.sessions WHERE token_hash=$1',[tokenAdapter.hash(second)])).rows[0].session_id;
    expect(sessions.some(s=>s.sessionId===current)).toBe(true);
    expect((await request('/admin-api/command',{command:{action:'session.revoke',userId:salesId,sessionId:current,reason:'HTTP restart test'},password})).status).toBe(200);
    await close();await start();expect((await request('/admin-api/me',undefined,second)).status).toBe(401);expect((await request('/admin-api/me')).status).toBe(200);
  },TIMEOUT);
  it('serializes simultaneous administrator disable so one usable administrator remains',async()=>{
    const saved=(await pool.query('SELECT user_id FROM identity.users WHERE active AND identity_admin')).rows;
    const peers=[] as {userId:string;token:string;revision:number}[];
    try {
      for(const key of ['race-a','race-b']){
        const userId=randomUUID(),email=`${key}-${userId}@example.invalid`;
        unwrap(await authRepo.ensureFixture({userId,email,displayName:key,identityAdmin:true,crmRoles:[],passwordHash:await crypto.hash(password)}));
        peers.push({userId,token:unwrap(await auth.login({email,password},'browser')).token,revision:1});
      }
      for(const row of saved)await pool.query('UPDATE identity.users SET identity_admin=false WHERE user_id=$1',[row.user_id]);
      const results=await Promise.all(peers.map(peer=>admin.mutate(peer.token,{action:'user.update',userId:peer.userId,revision:peer.revision,active:false,identityAdmin:false,reason:'concurrent last-admin test'},password)));
      expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.filter(r=>!r.ok)).toHaveLength(1);
      const count=await pool.query('SELECT count(*)::int AS n FROM identity.users u JOIN identity.credentials c USING(user_id) WHERE u.active AND u.identity_admin');expect(count.rows[0].n).toBe(1);
    }finally{
      for(const row of saved)await pool.query('UPDATE identity.users SET identity_admin=true WHERE user_id=$1',[row.user_id]);
      for(const peer of peers){await pool.query('UPDATE identity.users SET identity_admin=false,active=false WHERE user_id=$1',[peer.userId]);await pool.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1',[peer.userId]);}
    }
  },TIMEOUT);
});
