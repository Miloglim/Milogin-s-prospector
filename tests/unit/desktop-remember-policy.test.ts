import {describe,it,expect,vi} from 'vitest';
import {createDesktopSessionService} from '../../server/services/desktop-session';
import type {DesktopSessionRepository} from '../../server/core/desktop-session';
import {success} from '../../server/core/crm';

describe('desktop remembered credential lifetime',()=>{
 it('issues fifteen-day idle and ninety-day absolute deadlines; refresh only supplies an idle deadline',async()=>{
  const day=24*60*60*1000;
  let now=Date.UTC(2026,9,14);
  const identity={userId:'a',email:'a@example.invalid',displayName:'A',emailVerified:true,identityAdmin:false,crmRoles:[]};
  const create=vi.fn(async()=>success(identity));
  const rotate=vi.fn(async()=>success({identity,expiresAt:new Date(now+3600000).toISOString()}));
  const repo={credential:async()=>success({userId:'a',passwordHash:'hash',active:true,securityRevision:1}),createDesktopSession:create,rotateDesktopSession:rotate} as unknown as DesktopSessionRepository;
  const service=createDesktopSessionService(repo,{verify:async()=>true,hash:async()=> 'hash'},{create:()=> 'a'.repeat(43),hash:x=>x},{now:()=>now},3600);
  expect((await service.login({email:identity.email,password:'fixture123'})).ok).toBe(true);
  expect(create.mock.calls[0]).toEqual([expect.objectContaining({idleExpiresAt:new Date(now+15*day).toISOString(),absoluteExpiresAt:new Date(now+90*day).toISOString()})]);
  now+=10*day;
  expect((await service.refresh({refreshToken:'a'.repeat(43)})).ok).toBe(true);
  const rotation=rotate.mock.calls[0] as unknown as [string,Record<string,unknown>];
  expect(rotation[1].idleExpiresAt).toBe(new Date(now+15*day).toISOString());
  expect(rotation[1]).not.toHaveProperty('absoluteExpiresAt');
 });
});
