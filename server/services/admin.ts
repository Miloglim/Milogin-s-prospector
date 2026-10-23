import { success,failure,type Result } from "../core/crm";
import { ADMIN_LIMITS,SCOPES,capabilitiesFor,productPermissionsFor,type AdminCommand,type AdminRepository,type UserQuery,type MutationResult } from "../core/admin";
import { AUTH_LIMITS,CRM_ROLES,isAccountEmail,isNewAccountPassword,type AuthRepository,type TokenPort,type ClockPort } from "../core/auth";
import type { AuthService } from "./auth";

interface AdminPasswords { verify(password:string,hash:string):Promise<boolean>; hash(password:string):Promise<string>; }
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MILLISECONDS=1000;
function object(v:unknown):v is Record<string,unknown> {return !!v && typeof v==='object' && !Array.isArray(v);}
function string(v:unknown,max:number):v is string {return typeof v==='string' && !!v.trim() && v.length<=max;}
function validCommand(v:unknown):v is AdminCommand {
 if(!object(v))return false;
 const allowed:Record<string,string[]>={
  'user.create':['action','email','role','reason'],
  'user.update':['action','userId','revision','active','identityAdmin','reason'],
  'navigator.update':['action','userId','revision','active','role','reason'],
  'user.delete':['action','userId','revision','reason'],
  'user.reset-password':['action','userId','revision','reason'],
  'product.update':['action','userId','revision','productId','active','roles','capabilities','scope','reason','role'],
  'session.revoke':['action','userId','sessionId','reason'],
  'challenge.issue':['action','purpose','email','displayName','reason'],
 };
 if(typeof v.action!=='string'||!allowed[v.action]||Object.keys(v).some(k=>!allowed[v.action as string]!.includes(k)))return false;
 if(v.action!=='user.delete'&&!string(v.reason,ADMIN_LIMITS.reasonMax))return false;
 if(v.action==='user.delete'&&v.reason!==undefined&&v.reason!==''&&!string(v.reason,ADMIN_LIMITS.reasonMax))return false;
 if(v.action==='user.create')return isAccountEmail(v.email)&&CRM_ROLES.includes(v.role as any);
 if(v.action==='challenge.issue')return (v.purpose==='activate'||v.purpose==='recover')&&isAccountEmail(v.email)&&string(v.displayName,ADMIN_LIMITS.displayNameMax);
 if(typeof v.userId!=='string'||!UUID.test(v.userId))return false;
 if(v.action==='session.revoke')return typeof v.sessionId==='string'&&UUID.test(v.sessionId);
 if(!Number.isSafeInteger(v.revision)||(v.revision as number)<1)return false;
 if(v.action==='user.delete'||v.action==='user.reset-password')return true;
 if(typeof v.active!=='boolean')return false;
 if(v.action==='user.update')return typeof v.identityAdmin==='boolean';
 if(v.action==='navigator.update')return v.role==='operations'||v.role==='sales';
 if(v.role!==undefined&&!CRM_ROLES.includes(v.role as any))return false;
 if(v.productId!=='crm'||!Array.isArray(v.roles)||v.roles.some(role=>!CRM_ROLES.includes(role))||new Set(v.roles).size!==v.roles.length
  ||!Array.isArray(v.capabilities)||v.capabilities.some(cap=>typeof cap!=='string'||!capabilitiesFor(v.role!==undefined?[...CRM_ROLES]:v.roles as any).includes(cap))
  ||new Set(v.capabilities).size!==v.capabilities.length||!SCOPES.includes(v.scope as any))return false;
 const scopes=v.roles.includes('admin')||v.roles.includes('auditor')?SCOPES:v.roles.includes('operations')?['own','shared']:['own'];
 return v.role!==undefined||scopes.includes(v.scope as any);
}
export function createAdminService(repo:AdminRepository,authRepo:AuthRepository,passwords:AdminPasswords,tokens:TokenPort,clock:ClockPort,auth:AuthService) {
 async function authenticated(token:string) {const result=await auth.me(token,'browser');return result.ok&&result.data.mustChangePassword?failure('PASSWORD_CHANGE_REQUIRED','请先修改初始密码'):result;}
 return {
  async users(token:string,input:unknown) {
   if(!object(input)||typeof input.search!=='string'||input.search.length>ADMIN_LIMITS.searchMax||!Number.isSafeInteger(input.limit)||(input.limit as number)<1||(input.limit as number)>ADMIN_LIMITS.pageMax
    ||!Number.isSafeInteger(input.offset)||(input.offset as number)<0||(input.productId!==undefined&&input.productId!=='crm'&&input.productId!=='navigator'))return failure('INVALID_INPUT','用户查询无效');
   const actor=await authenticated(token);return actor.ok?repo.users(tokens.hash(token),input as unknown as UserQuery):actor;
  },
  async products(token:string) {const actor=await authenticated(token);return actor.ok?repo.products(tokens.hash(token)):actor;},
  async sessions(token:string,userId:string) {if(!UUID.test(userId))return failure('INVALID_INPUT','用户标识无效');const actor=await authenticated(token);return actor.ok?repo.sessions(tokens.hash(token),userId):actor;},
  async audit(token:string,productId?:string,userId?:string) {if(productId!==undefined&&productId!=='crm'&&productId!=='navigator')return failure('INVALID_INPUT','产品无效');if(userId!==undefined&&!UUID.test(userId))return failure('INVALID_INPUT','用户标识无效');const actor=await authenticated(token);return actor.ok?repo.audit(tokens.hash(token),productId,userId):actor;},
  async mutate(token:string,input:unknown,password:unknown):Promise<Result<MutationResult>> {
   if(!validCommand(input))return failure('INVALID_INPUT','管理请求无效');
   const actor=await authenticated(token);if(!actor.ok)return actor;
   if(input.action==='user.create'){
    if(!actor.data.identityAdmin)return failure('FORBIDDEN','无创建用户权限');
    if(!isNewAccountPassword(password))return failure('INVALID_INPUT','初始密码至少6位，仅允许英文字母和数字');
    try{const result=await repo.mutate(tokens.hash(token),{...input,email:input.email.trim().toLowerCase()},undefined,await passwords.hash(password));return result.ok?success({}):result;}
    catch{return failure('UNAVAILABLE','创建用户暂不可用');} // never expose the password/hash
   }
   if(input.action==='user.update'||input.action==='product.update'||input.action==='navigator.update'){
    const command=input.action==='product.update'&&input.role!==undefined?{...input,...productPermissionsFor(input.role)}:input;
    const result=await repo.mutate(tokens.hash(token),command);return result.ok?success({}):result;
   }
   if(input.action==='user.delete'){
    const result=await repo.mutate(tokens.hash(token),{...input,reason:input.reason?.trim()||'用户管理中心删除'});
    return result.ok?success({}):result;
   }
   if(typeof password!=='string'||password.length<AUTH_LIMITS.passwordMin||password.length>AUTH_LIMITS.passwordMax)return failure('INVALID_INPUT','管理请求无效');
   const credentials=await authRepo.credential(actor.data.email);if(!credentials.ok)return credentials;
   let verified=false;
   try {verified=await passwords.verify(password,credentials.data?.passwordHash??'');}
   catch {return failure('UNAVAILABLE','重新认证暂不可用');} // never return crypto errors or credentials
   if(!verified||!credentials.data?.active)return failure('UNAUTHORIZED','重新认证失败');
   if(input.action==='challenge.issue'||input.action==='user.reset-password') {
    const raw=tokens.create(),expiresAt=new Date(clock.now()+ADMIN_LIMITS.challenge_ttl_seconds*MILLISECONDS).toISOString();
    // Identity UUIDs belong to the adapter, not the pure service. Existing user lookup is in the transaction.
    const command=input.action==='challenge.issue'?{...input,email:input.email.trim().toLowerCase()}:input;
    const result=await repo.mutate(tokens.hash(token),command,
      {tokenHash:tokens.hash(raw),userId:input.action==='user.reset-password'?input.userId:'',purpose:input.action==='user.reset-password'?'recover':input.purpose,expiresAt,email:input.action==='challenge.issue'?input.email.trim().toLowerCase():'',displayName:input.action==='challenge.issue'?input.displayName.trim():''});
    return result.ok?success({challengeToken:raw,expiresAt}):result;
   }
   const result=await repo.mutate(tokens.hash(token),input);return result.ok?success({}):result;
  },
  async consume(input:unknown):Promise<Result<void>> {
   if(!object(input)||Object.keys(input).some(k=>k!=='token'&&k!=='password')||typeof input.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(input.token)
    ||!isNewAccountPassword(input.password))return failure('INVALID_INPUT','密码至少6位，仅允许英文字母和数字');
   try {return await repo.consume(tokens.hash(input.token),await passwords.hash(input.password));}
   catch {return failure('UNAVAILABLE','密码设置暂不可用');} // fail closed without returning password/hash
  },
 };
}
export type AdminService=ReturnType<typeof createAdminService>;


