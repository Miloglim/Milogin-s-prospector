import { describe, expect, it, vi } from 'vitest';
import { createAuthService } from '../../server/services/auth';
import { success } from '../../server/core/crm';
describe('short initial credential is restricted to mandatory change accounts',()=>{
 it('allows any newly created email into browser password change, blocks API and later short login',async()=>{
  let mustChangePassword=true;
  const createSession=vi.fn(async()=>success({email:'new@example.invalid',mustChangePassword}));
  const repo={credential:async()=>success({userId:'id',passwordHash:'hash',active:true,securityRevision:1,mustChangePassword}),createSession};
  const auth=createAuthService(repo as any,{verify:async()=>true},{create:()=> 'a'.repeat(43),hash:v=>v},{now:()=>0},3600);
  expect((await auth.login({email:'new@example.invalid',password:'123456'},'browser')).ok).toBe(true);
  const blocked=await auth.login({email:'new@example.invalid',password:'123456'},'api');
  expect(blocked.ok).toBe(false);if(!blocked.ok)expect(blocked.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  mustChangePassword=false;
  expect((await auth.login({email:'new@example.invalid',password:'123456'},'browser')).ok).toBe(true);
  expect(createSession).toHaveBeenCalledTimes(2);
 });
});


