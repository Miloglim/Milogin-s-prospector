import {AUTH_LIMITS,isNewAccountPassword,type AuthRepository,type TokenPort} from '../core/auth';
import {failure} from '../core/crm';
import type {PasswordChangeRepository} from '../core/password-change';
import type {AuthService} from './auth';
interface PasswordCrypto {verify(password:string,hash:string):Promise<boolean>;hash(password:string):Promise<string>;}
export function createPasswordChangeService(repo:PasswordChangeRepository,authRepo:AuthRepository,passwords:PasswordCrypto,tokens:TokenPort,auth:AuthService){
 return {async change(token:string,input:unknown){
  if(!input||typeof input!=='object'||Array.isArray(input))return failure('INVALID_INPUT','改密请求无效');
  const value=input as Record<string,unknown>;
  if(Object.keys(value).some(k=>k!=='currentPassword'&&k!=='newPassword')||typeof value.currentPassword!=='string'||!value.currentPassword.length||value.currentPassword.length>AUTH_LIMITS.passwordMax
   ||!isNewAccountPassword(value.newPassword)||value.newPassword===value.currentPassword)return failure('INVALID_INPUT','新密码至少6位，仅允许英文字母和数字，且必须与当前密码不同');
  const identity=await auth.me(token,'browser');if(!identity.ok)return identity;
  const credential=await authRepo.credential(identity.data.email);if(!credential.ok)return credential;
  if(!credential.data?.active)return failure('UNAUTHORIZED','会话已失效');
  try{
   if(!await passwords.verify(value.currentPassword,credential.data.passwordHash))return failure('UNAUTHORIZED','当前密码不正确');
   return await repo.changePassword(tokens.hash(token),credential.data.passwordHash,credential.data.securityRevision,await passwords.hash(value.newPassword));
  }catch{return failure('UNAVAILABLE','改密暂不可用，请稍后重试');} // Never expose submitted passwords or crypto errors.
 }};
}
export type PasswordChangeService=ReturnType<typeof createPasswordChangeService>;

