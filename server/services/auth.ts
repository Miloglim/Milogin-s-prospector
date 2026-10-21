import { success, failure, type Result } from "../core/crm";
import { AUTH_LIMITS, CRM_CAPABILITIES,BOOTSTRAP_LOGIN_MIN, type AuthRepository, type PasswordPort, type TokenPort, type ClockPort, type Identity, type LoginResponse } from "../core/auth";
import { normalizeAccountProfilePatch } from "../core/account-profile";
import { isGrowthEventInput } from "../core/account-growth";

const MILLISECONDS_PER_SECOND = 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
export function createAuthService(repo: AuthRepository, passwords: PasswordPort, tokens: TokenPort, clock: ClockPort, ttlSeconds: number) {
  const unauthorized = () => failure("UNAUTHORIZED", "登录信息无效或会话已失效");
  async function me(token: string,client:"api"|"browser"='api'): Promise<Result<Identity>> {
    if(token.length !== AUTH_LIMITS.tokenCharacters || !TOKEN_PATTERN.test(token)) return unauthorized();
    const result = await repo.identity(tokens.hash(token),client);
    if(!result.ok) return result;
    if(result.data?.mustChangePassword&&client==='api')return failure('PASSWORD_CHANGE_REQUIRED','请先在管理页面修改初始密码');
    return result.data ? success(result.data) : unauthorized();
  }
  return {
    ready: () => repo.ready(),
    async login(input: unknown,client:"api"|"browser"='api'): Promise<Result<LoginResponse>> {
      if(!input || typeof input!=="object" || Array.isArray(input)) return failure("INVALID_INPUT","登录参数无效");
      const value = input as Record<string,unknown>;
      if(Object.keys(value).some(key => key!=="email" && key!=="password")
        || typeof value.email!=="string" || typeof value.password!=="string"
        || value.email.length>AUTH_LIMITS.emailMax || value.email!==value.email.trim()||!EMAIL_PATTERN.test(value.email.trim())
        || value.password.length<BOOTSTRAP_LOGIN_MIN || value.password.length>AUTH_LIMITS.passwordMax) return failure("INVALID_INPUT","登录参数无效");
      const credential = await repo.credential(value.email.trim().toLowerCase());
      if(!credential.ok) return credential;
      if(value.password.length<AUTH_LIMITS.passwordMin&&!credential.data?.mustChangePassword)return unauthorized();
      let verified: boolean;
      try { verified = await passwords.verify(value.password,credential.data?.passwordHash ?? ""); }
      catch { return failure("UNAVAILABLE","登录校验暂不可用，请稍后重试"); } // crypto capacity/errors fail closed, no input/hash in error
      if(!verified || !credential.data?.active) return unauthorized();
      if(credential.data.mustChangePassword&&client==='api')return failure('PASSWORD_CHANGE_REQUIRED','请先在管理页面修改初始密码');
      const token = tokens.create(), expiresAt = new Date(clock.now()+ttlSeconds*MILLISECONDS_PER_SECOND).toISOString();
      const session = await repo.createSession({tokenHash:tokens.hash(token),userId:credential.data.userId,securityRevision:credential.data.securityRevision,expiresAt,client});
      if(!session.ok) return session;
      return session.data ? success({token,expiresAt,identity:session.data}) : unauthorized();
    },
    me,
    async accountProfile(token: string) {
      const identity=await me(token);
      if(!identity.ok)return identity;
      if(!repo.accountProfile)return failure('UNAVAILABLE','账号资料暂不可用');
      const result=await repo.accountProfile(tokens.hash(token));
      if(!result.ok)return result;
      return result.data?.userId===identity.data.userId?success(result.data):unauthorized();
    },
    async updateAccountProfile(token: string,input: unknown) {
      const identity=await me(token);
      if(!identity.ok)return identity;
      if(!repo.updateAccountProfile)return failure('UNAVAILABLE','账号资料写入暂不可用');
      let patch;
      try { patch=normalizeAccountProfilePatch(input); }
      catch(error) { return failure('INVALID_INPUT',error instanceof Error?error.message:'账号资料参数无效'); }
      const result=await repo.updateAccountProfile(tokens.hash(token),patch);
      if(!result.ok)return result;
      return result.data?.userId===identity.data.userId?success(result.data):unauthorized();
    },
    async accountGrowth(token: string,input: unknown) {
      const identity=await me(token);
      if(!identity.ok)return identity;
      if(!repo.recordGrowthEvent)return failure('UNAVAILABLE','成长记账暂不可用');
      if(!isGrowthEventInput(input))return failure('INVALID_INPUT','成长事件参数无效');
      return repo.recordGrowthEvent(tokens.hash(token),input);
    },
    async logout(token: string,client:"api"|"browser"='api'): Promise<Result<void>> {
      const identity = await me(token,client);
      return identity.ok ? repo.revoke(tokens.hash(token)) : identity;
    },
    async users(token: string): Promise<Result<Identity[]>> {
      const identity = await me(token);
      if(!identity.ok) return identity;
      if(identity.data.mustChangePassword)return failure('PASSWORD_CHANGE_REQUIRED','请先修改初始密码');
      return identity.data.identityAdmin ? repo.listUsers(tokens.hash(token)) : failure("FORBIDDEN","无账号管理权限");
    },
    async crmAccess(token: string): Promise<Result<{ capabilities: string[] }>> {
      const identity = await me(token);
      if(!identity.ok) return identity;
      if(identity.data.mustChangePassword)return failure('PASSWORD_CHANGE_REQUIRED','请先修改初始密码');
      if(!identity.data.crmRoles.length) return failure("FORBIDDEN","无 CRM 产品准入");
      const alias:Record<string,string>={'crm:manage':'access.manage','leads:import':'leads.import','leads:publish':'leads.publish','leads:review':'followups.read','leads:claim':'leads.claim','leads:develop':'leads.develop','crm:audit':'audit.read'};
      return success({capabilities:[...new Set(identity.data.crmRoles.flatMap(role => [...CRM_CAPABILITIES[role]]))]
        .filter(cap=>identity.data.crmCapabilities==null||identity.data.crmCapabilities.includes(alias[cap]!))});
    },
    async navigatorAccess(token: string) {
      if(!repo.navigatorAccess) return failure('UNAVAILABLE','Navigator 授权暂不可用');
      const access=await repo.navigatorAccess(tokens.hash(token));
      if(!access.ok) return access;
      return access.data ? success(access.data) : failure('FORBIDDEN','无 Navigator 产品准入');
    },
  };
}
export type AuthService = ReturnType<typeof createAuthService>;


