import { describe, expect, it, vi } from 'vitest';
import { createAdminService } from '../../server/services/admin';
import { success } from '../../server/core/crm';
const userId='11111111-1111-4111-8111-111111111111';
function setup(){
 const mutate=vi.fn().mockResolvedValue(success(undefined));
 const hash=vi.fn(async(value:string)=>`hash:${value}`);
 const verify=vi.fn(async()=>true);
 const service=createAdminService({mutate} as any,{credential:async()=>success({active:true,passwordHash:'hash'})} as any,
  {verify,hash},{create:()=> 'a'.repeat(43),hash:v=>v},{now:()=>0},
  {me:async()=>success({email:'actor@example.invalid',identityAdmin:true,mustChangePassword:false})} as any);
 return {service,mutate,hash,verify};
}
describe('user lifecycle command boundary',()=>{
 it('creates a role-selected account with the administrator-provided initial password',async()=>{
  const {service,mutate,hash}=setup();
  expect((await service.mutate('session',{action:'user.create',email:'new@example.invalid',role:'operations',reason:'create'},'Abc123')).ok).toBe(true);
  expect(hash).toHaveBeenCalledWith('Abc123');
  expect(mutate).toHaveBeenCalledWith('session',expect.objectContaining({action:'user.create'}),undefined,'hash:Abc123');
  expect((await service.mutate('session',{action:'user.update',userId,revision:1,active:true,identityAdmin:false,reason:'save'},undefined)).ok).toBe(true);
 });
 it('rejects account creation without a valid initial password',async()=>{
  const {service,mutate}=setup();
  expect((await service.mutate('session',{action:'user.create',email:'new@example.invalid',role:'operations',reason:'create'},undefined)).ok).toBe(false);
  expect((await service.mutate('session',{action:'user.create',email:'new@example.invalid',role:'operations',reason:'create'},'123')).ok).toBe(false);
  expect(mutate).not.toHaveBeenCalled();
 });
 it('deletes after one confirmation without password reauthentication or reason',async()=>{
  const {service,mutate,verify}=setup();
  expect((await service.mutate('session',{action:'user.delete',userId,revision:1},undefined)).ok).toBe(true);
  expect(verify).not.toHaveBeenCalled();
  expect(mutate).toHaveBeenCalledWith('session',expect.objectContaining({action:'user.delete',reason:'用户管理中心删除'}));
 });
 it('treats a legacy empty deletion reason as omitted',async()=>{
  const {service,mutate,verify}=setup();
  expect((await service.mutate('session',{action:'user.delete',userId,revision:1,reason:''},undefined)).ok).toBe(true);
  expect(verify).not.toHaveBeenCalled();
  expect(mutate).toHaveBeenCalledWith('session',expect.objectContaining({action:'user.delete',reason:'用户管理中心删除'}));
 });
 it('restores an archived account with a new initial password',async()=>{
  const {service,mutate,hash,verify}=setup();
  const command={action:'user.restore',userId,revision:2,reason:'restore'};
  expect((await service.mutate('session',command,'New123')).ok).toBe(true);
  expect(hash).toHaveBeenCalledWith('New123');
  expect(verify).not.toHaveBeenCalled();
  expect(mutate).toHaveBeenCalledWith('session',command,undefined,'hash:New123');
  expect((await service.mutate('session',command,undefined)).ok).toBe(false);
 });
 it('binds password reset to an immutable account ID and one-time challenge',async()=>{
  const {service,mutate}=setup();const command={action:'user.reset-password',userId,revision:1,reason:'requested'};
  const result=await service.mutate('session',command,'synthetic-password');
  expect(result.ok).toBe(true);if(result.ok)expect(result.data.challengeToken).toHaveLength(43);
  expect(mutate).toHaveBeenCalledWith('session',command,expect.objectContaining({userId,purpose:'recover'}));
 });
 it('rejects client-supplied reset email or privilege flags',async()=>{
  const {service,mutate}=setup();
  expect((await service.mutate('session',{action:'user.reset-password',userId,revision:1,reason:'x',email:'other@example.invalid'},'synthetic-password')).ok).toBe(false);
  expect((await service.mutate('session',{action:'user.delete',userId,revision:1,reason:'x',identityAdmin:true},undefined)).ok).toBe(false);
  expect(mutate).not.toHaveBeenCalled();
 });
});
