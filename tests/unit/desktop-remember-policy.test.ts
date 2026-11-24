import {describe,it,expect,vi} from 'vitest';
import {createDesktopSessionService} from '../../server/services/desktop-session';
import type {DesktopSessionRepository} from '../../server/core/desktop-session';
import {failure,success} from '../../server/core/crm';

function loginService(credential: Awaited<ReturnType<DesktopSessionRepository['credential']>>, verified=true) {
  const repo={credential:async()=>credential} as unknown as DesktopSessionRepository;
  return createDesktopSessionService(repo,{verify:async()=>verified,hash:async()=> 'hash'},{create:()=> 'a'.repeat(43),hash:x=>x},{now:()=>0},3600);
}

describe('desktop remembered credential lifetime',()=>{
 it('keeps a valid session usable when the optional presence heartbeat fails',async()=>{
  const identity={userId:'a',email:'a@example.invalid',displayName:'A',emailVerified:true,identityAdmin:false,crmRoles:['sales' as const]};
  const repo={desktopIdentity:async()=>success(identity),touchPresence:async()=>failure('DATABASE_ERROR','presence unavailable')} as unknown as DesktopSessionRepository;
  const service=createDesktopSessionService(repo,{verify:async()=>true,hash:async()=> 'hash'},{create:()=> 'a'.repeat(43),hash:x=>x},{now:()=>0},3600);
  expect(await service.me('a'.repeat(43))).toEqual(success(identity));
 });
 it('rejects malformed desktop metadata before accessing credentials',async()=>{
  const credential=vi.fn(async()=>success(null));
  const repo={credential} as unknown as DesktopSessionRepository;
  const service=createDesktopSessionService(repo,{verify:async()=>true,hash:async()=> 'hash'},{create:()=> 'a'.repeat(43),hash:x=>x},{now:()=>0},3600);
  const result=await service.login({email:'a@example.invalid',password:'fixture123',desktop:{product:'crm',deviceId:'bad id',deviceName:'PC\nforged',platform:'win32',appVersion:'0.67.0'}});
  expect(result).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});expect(credential).not.toHaveBeenCalled();
 });
 it('issues fifteen-day idle and ninety-day absolute deadlines; refresh only supplies an idle deadline',async()=>{
  const day=24*60*60*1000;
  let now=Date.UTC(2026,9,14);
  const identity={userId:'a',email:'a@example.invalid',displayName:'A',emailVerified:true,identityAdmin:false,crmRoles:[]};
  const create=vi.fn(async()=>success(identity));
  const rotate=vi.fn(async()=>success({identity,expiresAt:new Date(now+3600000).toISOString()}));
  const repo={credential:async()=>success({userId:'a',passwordHash:'hash',active:true,securityRevision:1}),createDesktopSession:create,rotateDesktopSession:rotate} as unknown as DesktopSessionRepository;
  const service=createDesktopSessionService(repo,{verify:async()=>true,hash:async()=> 'hash'},{create:()=> 'a'.repeat(43),hash:x=>x},{now:()=>now},3600);
  const desktop={product:'crm' as const,deviceId:'desktop-device-a',deviceName:'Office PC',platform:'win32',appVersion:'0.67.0'};
  expect((await service.login({email:identity.email,password:'fixture123',desktop})).ok).toBe(true);
  expect(create.mock.calls[0]).toEqual([expect.objectContaining({idleExpiresAt:new Date(now+15*day).toISOString(),absoluteExpiresAt:new Date(now+90*day).toISOString(),desktop})]);
  now+=10*day;
  expect((await service.refresh({refreshToken:'a'.repeat(43)})).ok).toBe(true);
  const rotation=rotate.mock.calls[0] as unknown as [string,Record<string,unknown>];
  expect(rotation[1].idleExpiresAt).toBe(new Date(now+15*day).toISOString());
  expect(rotation[1]).not.toHaveProperty('absoluteExpiresAt');
 });
  it.each([
    ['unknown account', success(null), true, 'ACCOUNT_NOT_FOUND'],
    ['missing center password', success({userId:'a',passwordHash:null,active:true,securityRevision:1}), true, 'ACCOUNT_NOT_CONFIGURED'],
    ['disabled account', success({userId:'a',passwordHash:'hash',active:false,securityRevision:1}), true, 'ACCOUNT_DISABLED'],
    ['wrong password', success({userId:'a',passwordHash:'hash',active:true,securityRevision:1}), false, 'INVALID_CREDENTIALS'],
  ])('returns an actionable %s login result',async(_label,credential,verified,code)=>{
    const result=await loginService(credential as never,verified as boolean).login({email:'a@example.invalid',password:'fixture123'});
    expect(result).toMatchObject({ok:false,error:{code}});
  });
});
