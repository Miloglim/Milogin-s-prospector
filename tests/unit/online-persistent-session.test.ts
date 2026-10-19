import {describe,it,expect,vi} from 'vitest';
vi.mock('electron',()=>({dialog:{showOpenDialog:vi.fn()}}));
vi.mock('../../src/main/logger',()=>({Log:{error:vi.fn(),warn:vi.fn()}}));
import {OnlineCrmAdapter} from '../../src/main/adapters/online-crm.adapter';
import type {SavedOnlineSession} from '../../src/main/adapters/online-session-store.adapter';
import {success,failure} from '../../server/core/crm';
import { generateKeyPairSync, sign } from 'node:crypto';
import { OFFLINE_ACCESS_LIMITS } from '../../server/core/offline-access';
const base='http://127.0.0.1:55844';
const identity={userId:'fixture-owner',displayName:'Fixture',email:'fixture@example.invalid',emailVerified:true,identityAdmin:false,crmRoles:['sales'] as const};
const response=(data:unknown)=>new Response(JSON.stringify(data));
const keys=generateKeyPairSync('ed25519');
function offlineGrant() {
  const now=Date.now();
  const payload=JSON.stringify({version:1,audience:'prospector-local',issuer:base,issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+OFFLINE_ACCESS_LIMITS.validity_seconds*1000).toISOString(),identity});
  return {payload,signature:sign(null,Buffer.from(payload),keys.privateKey).toString('base64url'),publicKey:keys.publicKey.export({format:'pem',type:'spki'}).toString()};
}
function setup() {
  let saved:SavedOnlineSession|null=null;
  const store={load:vi.fn(async()=>saved),save:vi.fn(async(value:SavedOnlineSession)=>{saved=value;}),clear:vi.fn(async()=>{saved=null;})};
  let serial=0;
  const session=()=>({token:`bearer-${++serial}`,refreshToken:`refresh-${serial}`,expiresAt:new Date(Date.now()+3600000).toISOString(),identity});
  const fetcher=vi.fn(async(url:string)=>response(success(url.endsWith('/login')||url.endsWith('/refresh')?session():url.endsWith('/me')?identity:undefined)));
  return {store,fetcher,saved:()=>saved,client:()=>new OnlineCrmAdapter(fetcher as unknown as typeof fetch,store)};
}
describe('global remembered session lifecycle',()=>{
  it.each(['UNAVAILABLE','DATABASE_ERROR','TIMEOUT'])('retains current identity locally during %s and recovers online',async code=>{
    const fixture=setup();const client=fixture.client();await client.login({baseUrl:base,email:identity.email,password:'fixture-only-password'});
    const normal=fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation(async()=>response(failure(code as 'UNAVAILABLE','outage')));
    const offline=await client.status();expect(offline.ok&&offline.data.connection).toBe('offline');expect(client.currentIdentity()?.userId).toBe(identity.userId);expect(client.isOnline()).toBe(false);
    expect(await client.request('POST','/api/crm/leads')).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}});
    fixture.fetcher.mockImplementation(normal);const recovered=await client.status();expect(recovered.ok&&recovered.data.connection).toBe('online');expect(client.isOnline()).toBe(true);
  });
  it('restores only signed remembered identity offline without using a grant as bearer',async()=>{
    const fixture=setup(),grant=offlineGrant();const normal=fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation(async url=>{const result=await normal(url);const value=await result.json();return response(url.endsWith('/login')||url.endsWith('/refresh')?{...value,data:{...value.data,offlineAccess:grant}}:value);});
    const first=fixture.client();await first.login({baseUrl:base,email:identity.email,password:'fixture-only-password',remember:true});first.dispose();
    expect(fixture.saved()?.trustedPublicKey).toBe(grant.publicKey);
    fixture.fetcher.mockImplementation(async()=>{throw new Error('offline');});const restored=fixture.client();const state=await restored.restore();expect(state.ok&&state.data.connection).toBe('offline');expect(restored.currentIdentity()?.userId).toBe(identity.userId);
    expect(await restored.request('POST','/api/crm/leads')).toMatchObject({ok:false,error:{code:'UNAVAILABLE'}});
  });
  it('expires current offline authority and never resurrects it after a clock rollback',async()=>{
    vi.useFakeTimers();try {
      const fixture=setup(),client=fixture.client();await client.login({baseUrl:base,email:identity.email,password:'fixture-only-password'});
      fixture.fetcher.mockImplementation(async()=>{throw new Error('offline');});await client.status();const original=Date.now();
      vi.setSystemTime(original+OFFLINE_ACCESS_LIMITS.validity_seconds*1000);expect(client.currentIdentity()).toBeNull();vi.setSystemTime(original);expect(client.currentIdentity()).toBeNull();
    }finally{vi.useRealTimers();}
  });
  it.each(['signature','user','key','expiry','rollback'])('fails closed on invalid remembered offline %s while preserving retry credentials',async kind=>{
    const fixture=setup(),grant=offlineGrant(),clock=Date.now();
    await fixture.store.save({baseUrl:base,userId:kind==='user'?'other':identity.userId,refreshToken:'fixture-refresh',offlineAccess:kind==='signature'?{...grant,payload:grant.payload+' '}:grant,trustedPublicKey:kind==='key'?'untrusted':grant.publicKey,lastSeenAt:kind==='rollback'?clock+61000:kind==='expiry'?clock+OFFLINE_ACCESS_LIMITS.validity_seconds*1000:clock});
    fixture.fetcher.mockImplementation(async()=>response(failure('DATABASE_ERROR','unavailable')));const client=fixture.client();
    expect((await client.restore()).ok).toBe(false);expect(client.currentIdentity()).toBeNull();expect(fixture.saved()).not.toBeNull();
  });
  it('offline explicit logout removes identity and restart authorization',async()=>{
    const fixture=setup(),grant=offlineGrant();await fixture.store.save({baseUrl:base,userId:identity.userId,refreshToken:'fixture-refresh',offlineAccess:grant,trustedPublicKey:grant.publicKey,lastSeenAt:Date.now()});
    fixture.fetcher.mockImplementation(async()=>{throw new Error('offline');});const client=fixture.client();expect((await client.restore()).ok).toBe(true);
    expect((await client.logout()).ok).toBe(false);expect(client.currentIdentity()).toBeNull();expect(fixture.saved()).toBeNull();expect((await fixture.client().restore()).ok).toBe(true);
  });
  it('persists an observed expiry so restarting after clock rollback cannot revive offline access',async()=>{
    vi.useFakeTimers();try {
      const fixture=setup(),grant=offlineGrant(),original=Date.now();await fixture.store.save({baseUrl:base,userId:identity.userId,refreshToken:'fixture-refresh',offlineAccess:grant,trustedPublicKey:grant.publicKey,lastSeenAt:original});
      fixture.fetcher.mockImplementation(async()=>response(failure('UNAVAILABLE','outage')));const client=fixture.client();expect((await client.restore()).ok).toBe(true);
      vi.setSystemTime(original+OFFLINE_ACCESS_LIMITS.validity_seconds*1000);expect(client.currentIdentity()).toBeNull();
      await client.status();expect(fixture.saved()!.lastSeenAt).toBe(Date.now());client.dispose();vi.setSystemTime(original);
      const next=fixture.client();expect((await next.restore()).ok).toBe(false);expect(next.currentIdentity()).toBeNull();
    }finally{vi.useRealTimers();}
  });
  it('throttles repeated local clockfloor reads while force-saving observed expiry',async()=>{
    vi.useFakeTimers();try {
      const fixture=setup(),grant=offlineGrant(),original=Date.now();await fixture.store.save({baseUrl:base,userId:identity.userId,refreshToken:'fixture-refresh',offlineAccess:grant,trustedPublicKey:grant.publicKey,lastSeenAt:original});
      fixture.fetcher.mockImplementation(async()=>response(failure('UNAVAILABLE','outage')));const client=fixture.client();await client.restore();fixture.store.save.mockClear();
      for(let offset=1;offset<=100;offset++){vi.setSystemTime(original+offset);expect(client.currentIdentity()?.userId).toBe(identity.userId);}
      await Promise.resolve();expect(fixture.store.save).not.toHaveBeenCalled();
      vi.setSystemTime(original+OFFLINE_ACCESS_LIMITS.validity_seconds*1000);expect(client.currentIdentity()).toBeNull();await client.status();expect(fixture.store.save).toHaveBeenCalledTimes(1);
    }finally{vi.useRealTimers();}
  });
  it('restores restricted identity to the password screen without unlocking local authority',async()=>{
    const fixture=setup();await fixture.store.save({baseUrl:base,userId:identity.userId,refreshToken:'fixture-refresh'});
    fixture.fetcher.mockImplementation(async()=>response(success({token:'restricted-access',refreshToken:'restricted-refresh',expiresAt:new Date(Date.now()+3600000).toISOString(),identity:{...identity,mustChangePassword:true}})));
    const client=fixture.client();const state=await client.restore();expect(state.ok&&state.data.identity?.mustChangePassword).toBe(true);expect(client.currentIdentity()).toBeNull();
  });
  it('persists refresh only, restores after app exit, and explicit logout clears it',async()=>{
    const fixture=setup();const first=fixture.client();
    expect((await first.login({baseUrl:base,email:identity.email,password:'fixture-only-password',remember:true})).ok).toBe(true);
    expect(Object.keys(fixture.saved()!).sort()).toEqual(['autoLogin','baseUrl','email','refreshToken','userId']);
    first.dispose();expect(fixture.saved()).not.toBeNull();
    const second=fixture.client();const restored=await second.restore();expect(restored.ok&&restored.data.identity?.userId).toBe(identity.userId);
    expect(fixture.fetcher.mock.calls.filter(([url])=>url.endsWith('/refresh'))).toHaveLength(1);
    expect((await second.logout()).ok).toBe(true);expect(fixture.saved()).toBeNull();
  });
  it('does not remember an unchecked login',async()=>{
    const fixture=setup();await fixture.client().login({baseUrl:base,email:identity.email,password:'fixture-only-password'});
    expect(fixture.store.save).not.toHaveBeenCalled();expect(fixture.saved()).toBeNull();
  });
  it('deduplicates simultaneous restore before rotating one-time refresh',async()=>{
    const fixture=setup();await fixture.store.save({baseUrl:base,userId:identity.userId,refreshToken:'fixture-refresh'});
    const client=fixture.client();const values=await Promise.all([client.restore(),client.restore(),client.restore()]);
    expect(values.every(value=>value.ok)).toBe(true);expect(fixture.fetcher.mock.calls.filter(([url])=>url.endsWith('/refresh'))).toHaveLength(1);
  });
  it('revocation clears cached identity and encrypted restore data',async()=>{
    const fixture=setup();const client=fixture.client();await client.login({baseUrl:base,email:identity.email,password:'fixture-only-password',remember:true});
    fixture.fetcher.mockImplementation(async()=>response(failure('UNAUTHORIZED','revoked')));
    expect((await client.status()).ok).toBe(false);expect(client.currentIdentity()).toBeNull();expect(fixture.saved()).toBeNull();
  });
  it('temporary outage retains saved credentials for retry, never claims logged-in restoration',async()=>{
    const fixture=setup();await fixture.store.save({baseUrl:base,userId:identity.userId,refreshToken:'fixture-refresh'});
    fixture.fetcher.mockImplementation(async()=>{throw new Error('offline');});const client=fixture.client();
    expect((await client.restore()).ok).toBe(false);expect(fixture.saved()).not.toBeNull();expect(client.currentIdentity()).toBeNull();
  });
  it('rejects cross-user refresh restoration',async()=>{
    const fixture=setup();await fixture.store.save({baseUrl:base,userId:'other-owner',refreshToken:'fixture-refresh'});
    const client=fixture.client();expect((await client.restore()).ok).toBe(false);expect(client.currentIdentity()).toBeNull();expect(fixture.saved()).toBeNull();
  });
  it('recovers remembered startup login through status after the center returns',async()=>{
    const fixture=setup();await fixture.store.save({baseUrl:base,userId:identity.userId,refreshToken:'fixture-refresh'});
    const normal=fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementationOnce(async()=>{throw new Error('offline');});
    const client=fixture.client();expect((await client.restore()).ok).toBe(false);
    fixture.fetcher.mockImplementation(normal);
    const state=await client.status();expect(state.ok&&state.data.identity?.userId).toBe(identity.userId);
  });
  it('finishes deleting the saved session before identity observers may terminate the process',async()=>{
    const fixture=setup();let notifications=0;
    const client=new OnlineCrmAdapter(fixture.fetcher as unknown as typeof fetch,fixture.store,()=>{if(!client.currentIdentity()){expect(fixture.saved()).toBeNull();notifications++;}});
    await client.login({baseUrl:base,email:identity.email,password:'fixture-only-password',remember:true});
    await client.logout();expect(notifications).toBeGreaterThan(0);
  });
  it('a late failed renewal disk write cannot invalidate the next account',async()=>{
    let saved:SavedOnlineSession|null=null;let rejectWrite:((error:Error)=>void)|undefined;let started:()=>void=()=>{};
    const writing=new Promise<void>(resolve=>{started=resolve;});let saves=0;
    const store={load:async()=>saved,clear:async()=>{saved=null;},save:async(value:SavedOnlineSession)=>{if(++saves===2){started();await new Promise<void>((_,reject)=>{rejectWrite=reject;});}saved=value;}};
    const other={...identity,userId:'other-owner',email:'other@example.invalid'};let meCount=0;
    const fetcher=async(url:string,init:RequestInit)=>{
      if(url.endsWith('/login')){const input=JSON.parse(init.body as string);const owner=input.email===other.email?other:identity;return response(success({token:owner.userId,refreshToken:owner.userId+'-refresh',expiresAt:new Date(Date.now()+3600000).toISOString(),identity:owner}));}
      if(url.endsWith('/refresh'))return response(success({token:identity.userId,refreshToken:'rotated',expiresAt:new Date(Date.now()+3600000).toISOString(),identity}));
      if(url.endsWith('/me')){if((init.headers as Record<string,string>).Authorization===`Bearer ${other.userId}`)return response(success(other));return response(++meCount===2?failure('UNAUTHORIZED','expired'):success(identity));}
      return response(success(undefined));
    };
    const client=new OnlineCrmAdapter(fetcher as unknown as typeof fetch,store);
    await client.login({baseUrl:base,email:identity.email,password:'fixture-only-password',remember:true});
    const old=client.status();await writing;
    const next=client.login({baseUrl:base,email:other.email,password:'fixture-only-password',remember:true});
    rejectWrite!(new Error('late disk failure'));await old;expect((await next).ok).toBe(true);
    expect(client.currentIdentity()?.userId).toBe(other.userId);expect(saved?.userId).toBe(other.userId);
  });
  it('clockfloor reads during delayed offline recovery never overwrite the rotated refresh credential',async()=>{
    vi.useFakeTimers();let releaseWrite:()=>void=()=>{};
    try {
      let saved:SavedOnlineSession|null=null,offline=false,serial=0;let started:()=>void=()=>{};
      const writing=new Promise<void>(resolve=>{started=resolve;});const blocked=new Promise<void>(resolve=>{releaseWrite=resolve;});
      const store={load:async()=>saved,clear:async()=>{saved=null;},save:async(value:SavedOnlineSession)=>{if(value.refreshToken==='refresh-2'){started();await blocked;}saved=value;}};
      const fetcher=async(url:string,init:RequestInit)=>{
        if(offline)return response(failure('UNAVAILABLE','outage'));
        if(url.endsWith('/refresh')&&JSON.parse(init.body as string).refreshToken==='refresh-1'&&serial>=2)return response(failure('UNAUTHORIZED','old refresh was consumed'));
        if(url.endsWith('/login')||url.endsWith('/refresh'))return response(success({token:`bearer-${++serial}`,refreshToken:`refresh-${serial}`,expiresAt:new Date(Date.now()+3600000).toISOString(),identity,offlineAccess:offlineGrant()}));
        return response(success(identity));
      };
      const client=new OnlineCrmAdapter(fetcher as unknown as typeof fetch,store);
      await client.login({baseUrl:base,email:identity.email,password:'fixture-only-password',remember:true});offline=true;await client.status();
      offline=false;const recovery=client.status();await writing;vi.setSystemTime(Date.now()+31000);expect(client.currentIdentity()?.userId).toBe(identity.userId);
      releaseWrite();expect((await recovery).ok).toBe(true);
      // Flush an observer-triggered floor write queued after the delayed credential write.
      await (client as unknown as {disk:Promise<void>}).disk;
      expect(saved?.refreshToken).toBe('refresh-2');client.dispose();
      const restarted=new OnlineCrmAdapter(fetcher as unknown as typeof fetch,store);expect((await restarted.restore()).ok).toBe(true);
      expect(restarted.currentIdentity()?.userId).toBe(identity.userId);
    }finally{releaseWrite();vi.useRealTimers();}
  });
  it('invalid login parameters leave the current session and identity observers intact',async()=>{
    const fixture=setup();const changed=vi.fn();const client=new OnlineCrmAdapter(fixture.fetcher as unknown as typeof fetch,fixture.store,changed);
    await client.login({baseUrl:base,email:identity.email,password:'fixture-only-password',remember:true});changed.mockClear();
    expect((await client.login({baseUrl:'http://example.invalid',email:identity.email,password:'fixture-only-password'})).ok).toBe(false);
    expect(client.currentIdentity()?.userId).toBe(identity.userId);expect(fixture.saved()?.userId).toBe(identity.userId);expect(changed).not.toHaveBeenCalled();
  });
  it('settles remote logout before notifying a listener that may exit the process',async()=>{
    const fixture=setup();let remoteDone=false;const normal=fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation(async(url:string)=>{if(url.endsWith('/logout')){await Promise.resolve();remoteDone=true;}return normal(url);});
    const client=new OnlineCrmAdapter(fixture.fetcher as unknown as typeof fetch,fixture.store,()=>{if(!client.currentIdentity()&&fixture.store.save.mock.calls.length)expect(remoteDone).toBe(true);});
    await client.login({baseUrl:base,email:identity.email,password:'fixture-only-password',remember:true});await client.logout();
  });
});
