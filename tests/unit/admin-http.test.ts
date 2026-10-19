import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import { createOnlineServer } from '../../server/transport/http';
import { createAdminHandler } from '../../server/transport/admin-http';
import { tokenAdapter } from '../../server/adapters/password';
import { ONLINE_DEFAULTS } from '../../server/core/auth';
import { success } from '../../server/core/crm';
const token='a'.repeat(43), csrf=tokenAdapter.hash(`csrf:${token}`);
const identity={userId:'test',email:'test@example.invalid',identityAdmin:true,crmRoles:[]};
let server:Server;
afterEach(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));});
async function setup(configOverride: Record<string, unknown> = {}){
 const auth:any={login:async(_:unknown,client:string)=>success({token,identity,expiresAt:new Date().toISOString(),client}),me:async()=>success(identity),logout:async()=>success(undefined)};
 const admin:any={users:async()=>success({items:[],total:0}),products:async()=>success([]),mutate:async()=>success({}),consume:async()=>success(undefined)};
 const gate={allow:()=>true},config={...ONLINE_DEFAULTS,test_mode:true,...configOverride};
 server=createOnlineServer(auth,gate,config,{write:()=>{}},'test',createAdminHandler(auth,admin,tokenAdapter,gate,config,async(_req,res)=>{res.end('workbench');}));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address() as {port:number};return `http://127.0.0.1:${address.port}`;
}
describe('same-origin browser administration boundary',()=>{
 it('proxies Navigator business summary with the current center session only',async()=>{
  const realFetch=globalThis.fetch;
  const upstream=vi.spyOn(globalThis,'fetch').mockImplementation((input,init) => {
   if(String(input)==='http://127.0.0.1:8795/api/center/navigator/dashboard') return Promise.resolve(new Response(JSON.stringify({ok:true,data:{service:{status:'ok',backend:'postgres',port:8795},counts:{rates:8,currentRates:6,space:2,groups:3,activeGroups:3,carriers:2,pendingAwaiting:1,pendingFailed:0,reviewIssuesOpen:0},latestMessage:null}}),{status:200,headers:{'content-type':'application/json'}}));
   return realFetch(input,init);
  });
  try {
   const base=await setup();
   const response=await fetch(base+'/admin-api/navigator/dashboard',{headers:{Cookie:`milogin_admin=${token}`}});
   expect(response.status).toBe(200);
   expect((await response.json()).data.counts.rates).toBe(8);
   expect(upstream).toHaveBeenCalledWith('http://127.0.0.1:8795/api/center/navigator/dashboard',expect.objectContaining({headers:expect.objectContaining({Authorization:`Bearer ${token}`})}));
  } finally { upstream.mockRestore(); }
 });
 it('serves the root, keeps session out of JSON, sets HttpOnly cookie',async()=>{
  const base=await setup();expect(await (await fetch(base)).text()).toBe('workbench');
  const response=await fetch(base+'/admin-api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({email:identity.email,password:'synthetic password'})});
  expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toContain('HttpOnly');expect(response.headers.get('set-cookie')).toContain('SameSite=Strict');
  const payload=await response.json();expect(payload.data.token).toBeUndefined();expect(payload.data.csrf).toBe(csrf);
 });
 it('rejects foreign Origin, missing CSRF, and duplicate session cookies',async()=>{
  const base=await setup(),headers={'Content-Type':'application/json',Cookie:`milogin_admin=${token}`};
  expect((await fetch(base+'/admin-api/command',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid','X-CSRF-Token':csrf},body:'{}'})).status).toBe(403);
  expect((await fetch(base+'/admin-api/command',{method:'POST',headers:{...headers,Origin:base},body:'{}'})).status).toBe(403);
  expect((await fetch(base+'/admin-api/me',{headers:{Cookie:`milogin_admin=${token}; milogin_admin=${token}`}})).status).toBe(401);
 });
 it('uses browser sessions exclusively and restricts local challenge operations',async()=>{
  const base=await setup();
  expect((await fetch(base+'/admin-api/me',{headers:{Authorization:`Bearer ${token}`}})).status).toBe(401);
  expect((await fetch(base+'/admin-api/challenge',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status).toBe(403);
  expect((await fetch(base+'/admin-api/users?limit=0',{headers:{Cookie:`milogin_admin=${token}`}})).status).toBe(400);
 });
 it('accepts only the configured HTTPS origin and marks production cookies Secure',async()=>{
  const base=await setup({test_mode:false,public_origin:'https://center.example.test'});
  const headers={'Content-Type':'application/json'};
  const body=JSON.stringify({email:identity.email,password:'synthetic password'});
  expect((await fetch(base+'/admin-api/login',{method:'POST',headers:{...headers,Origin:base},body})).status).toBe(403);
  const response=await fetch(base+'/admin-api/login',{method:'POST',headers:{...headers,Origin:'https://center.example.test'},body});
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('; Secure');
 });
});
