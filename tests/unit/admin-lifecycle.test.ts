import { describe, expect, it, vi } from 'vitest';
import { createAdminService } from '../../server/services/admin';
import { success } from '../../server/core/crm';
const userId='11111111-1111-4111-8111-111111111111';
function setup(){
 const mutate=vi.fn().mockResolvedValue(success(undefined));
 const hash=vi.fn(async(value:string)=>`hash:${value}`);
 const service=createAdminService({mutate} as any,{credential:async()=>success({active:true,passwordHash:'hash'})} as any,
  {verify:async()=>true,hash},{create:()=> 'a'.repeat(43),hash:v=>v},{now:()=>0},
  {me:async()=>success({email:'actor@example.invalid',identityAdmin:true,mustChangePassword:false})} as any);
 return {service,mutate,hash};
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
 it('accepts deletion with version and audit reason',async()=>{
  const {service,mutate}=setup();const command={action:'user.delete',userId,revision:1,reason:'departed'};
  expect((await service.mutate('session',command,'synthetic-password')).ok).toBe(true);
  expect(mutate).toHaveBeenCalledWith('session',command);
 });
 it('allows an omitted deletion reason and records a neutral audit value',async()=>{
  const {service,mutate}=setup();
  expect((await service.mutate('session',{action:'user.delete',userId,revision:1},'synthetic-password')).ok).toBe(true);
  expect(mutate).toHaveBeenCalledWith('session',expect.objectContaining({action:'user.delete',reason:'未填写删除原因'}));
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
  expect((await service.mutate('session',{action:'user.delete',userId,revision:1,reason:'x',identityAdmin:true},'synthetic-password')).ok).toBe(false);
  expect(mutate).not.toHaveBeenCalled();
 });
});
