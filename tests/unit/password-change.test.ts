import {describe,it,expect} from 'vitest';
import {createPasswordChangeService} from '../../server/services/password-change';
import {success} from '../../server/core/crm';
import {createAuthService} from '../../server/services/auth';
import {BOOTSTRAP_ADMIN_EMAIL} from '../../server/core/auth';
describe('mandatory password change service',()=>{
 it('permits short browser login only for bootstrap identity still awaiting change',async()=>{
  let pending=true;const identity:any={userId:'id',email:BOOTSTRAP_ADMIN_EMAIL,crmRoles:[],identityAdmin:true,mustChangePassword:true};
  const repo:any={credential:async()=>success({userId:'id',active:true,passwordHash:'hash',securityRevision:1,mustChangePassword:pending}),createSession:async()=>success(identity)};
  const auth=createAuthService(repo,{verify:async()=>true},{create:()=> 'a'.repeat(43),hash:v=>v},{now:()=>0},1);
  expect((await auth.login({email:BOOTSTRAP_ADMIN_EMAIL,password:'abcdef'},'browser')).ok).toBe(true);
  expect((await auth.login({email:BOOTSTRAP_ADMIN_EMAIL,password:'abcdef'})).ok).toBe(false);
  pending=false;expect((await auth.login({email:BOOTSTRAP_ADMIN_EMAIL,password:'abcdef'},'browser')).ok).toBe(true);
 });
 it('verifies current password, rejects reuse, and hashes only valid replacement',async()=>{
  let writes=0;const identity={userId:'id',email:'test@example.invalid',identityAdmin:true,crmRoles:[],mustChangePassword:true};
  const auth:any={me:async()=>success(identity)},credentials:any={credential:async()=>success({passwordHash:'old-hash',securityRevision:1,active:true})};
  const repo:any={changePassword:async()=>{writes++;return success(undefined);}},passwords={verify:async(p:string)=>p==='current-value',hash:async()=> 'new-hash'};
  const service=createPasswordChangeService(repo,credentials,passwords,{create:()=>'',hash:v=>v},auth);
  expect((await service.change('token',{currentPassword:'wrong-password',newPassword:'replacementvalue'})).ok).toBe(false);
  expect((await service.change('token',{currentPassword:'current-value',newPassword:'current-value'})).ok).toBe(false);
  expect((await service.change('token',{currentPassword:'current-value',newPassword:'short'})).ok).toBe(false);expect((await service.change('token',{currentPassword:'current-value',newPassword:'abc!12'})).ok).toBe(false);
  expect(writes).toBe(0);expect((await service.change('token',{currentPassword:'current-value',newPassword:'replacementvalue'})).ok).toBe(true);expect(writes).toBe(1);
 });
});



