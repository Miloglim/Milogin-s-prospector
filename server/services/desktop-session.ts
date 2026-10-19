import { AUTH_LIMITS, BOOTSTRAP_LOGIN_MIN, isAccountEmail, isNewAccountPassword, type ClockPort, type PasswordPort, type TokenPort } from '../core/auth';
import { DESKTOP_SESSION_LIMITS, type DesktopSessionRepository, type DesktopLoginResponse } from '../core/desktop-session';
import { failure, success, type Result } from '../core/crm';
import type { Identity } from '../core/auth';
import type { OfflineAccessIssuer } from '../core/offline-access';

const MILLISECONDS_PER_SECOND = 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const unauthorized = () => failure('UNAUTHORIZED', '登录信息无效或会话已失效');
const validToken = (token: unknown): token is string => typeof token === 'string' && token.length === AUTH_LIMITS.tokenCharacters && TOKEN_PATTERN.test(token);
function object(input: unknown, keys: string[]): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input) && !Object.keys(input).some(key => !keys.includes(key)) ? input as Record<string, unknown> : null;
}
export function createDesktopSessionService(repo: DesktopSessionRepository, passwords: PasswordPort & { hash(password: string): Promise<string> }, tokens: TokenPort, clock: ClockPort, ttlSeconds: number, offlineIssuer?: OfflineAccessIssuer) {
  const date = (seconds: number) => new Date(clock.now() + seconds * MILLISECONDS_PER_SECOND).toISOString();
  function loginResponse(token: string, refreshToken: string, expiresAt: string, identity: Identity, absoluteExpiresAt?: string): Result<DesktopLoginResponse> {
    try {
      const offlineAccess = identity.mustChangePassword ? undefined : offlineIssuer?.issue(identity, clock.now(), Date.parse(absoluteExpiresAt ?? expiresAt));
      return success({ token, refreshToken, expiresAt, identity, ...(offlineAccess ? { offlineAccess } : {}) });
    } catch { return failure('UNAVAILABLE', '离线授权暂不可用'); } // Crypto failures must not expose key diagnostics.
  }
  async function me(token: string) {
    if (!validToken(token)) return unauthorized();
    const identity = await repo.desktopIdentity(tokens.hash(token));
    return !identity.ok ? identity : identity.data ? success(identity.data) : unauthorized();
  }
  return {
    me,
    async register(input: unknown) {
      const value = object(input, ['email', 'password']);
      if (!value || !isAccountEmail(value.email) || !isNewAccountPassword(value.password)) return failure('INVALID_INPUT', '请输入有效邮箱，密码至少6位，仅允许英文字母和数字');
      if (!repo.createSalesAccount) return failure('UNAVAILABLE', '注册暂不可用');
      try { return await repo.createSalesAccount({ email: value.email.trim().toLowerCase(), passwordHash: await passwords.hash(value.password) }); }
      catch { return failure('UNAVAILABLE', '注册暂不可用，请稍后重试'); } // Do not include credentials or crypto diagnostics in responses.
    },
    async login(input: unknown): Promise<Result<DesktopLoginResponse>> {
      const value = object(input, ['email', 'password']);
      if (!value || typeof value.email !== 'string' || value.email!==value.email.trim() || !EMAIL_PATTERN.test(value.email.trim()) || value.email.length > AUTH_LIMITS.emailMax || typeof value.password !== 'string' || value.password.length < BOOTSTRAP_LOGIN_MIN || value.password.length > AUTH_LIMITS.passwordMax) return failure('INVALID_INPUT', '登录参数无效');
      const credential = await repo.credential(value.email.trim().toLowerCase());
      if (!credential.ok) return credential;
      try {
        const verified = await passwords.verify(value.password, credential.data?.passwordHash ?? '');
        if (!verified || !credential.data?.active || (value.password.length < AUTH_LIMITS.passwordMin && !credential.data.mustChangePassword)) return unauthorized();
      } catch { return failure('UNAVAILABLE', '登录校验暂不可用'); } // Fail closed; crypto errors may contain secrets.
      const token = tokens.create(), refreshToken = tokens.create(), expiresAt = date(ttlSeconds);
      const absoluteExpiresAt = date(DESKTOP_SESSION_LIMITS.absolute_seconds);
      const session = await repo.createDesktopSession({ tokenHash: tokens.hash(token), refreshHash: tokens.hash(refreshToken), userId: credential.data.userId, securityRevision: credential.data.securityRevision, expiresAt, idleExpiresAt: date(DESKTOP_SESSION_LIMITS.idle_seconds), absoluteExpiresAt });
      return !session.ok ? session : session.data ? loginResponse(token, refreshToken, expiresAt, session.data, absoluteExpiresAt) : unauthorized();
    },
    async refresh(input: unknown): Promise<Result<DesktopLoginResponse>> {
      const value = object(input, ['refreshToken']);
      if (!value || !validToken(value.refreshToken)) return failure('INVALID_INPUT', '续期参数无效');
      const token = tokens.create(), refreshToken = tokens.create(), expiresAt = date(ttlSeconds);
      const session = await repo.rotateDesktopSession(tokens.hash(value.refreshToken), { tokenHash: tokens.hash(token), refreshHash: tokens.hash(refreshToken), expiresAt, idleExpiresAt: date(DESKTOP_SESSION_LIMITS.idle_seconds) });
      return !session.ok ? session : session.data ? loginResponse(token, refreshToken, session.data.expiresAt, session.data.identity, session.data.absoluteExpiresAt) : unauthorized();
    },
    async logout(input: unknown) {
      const value = object(input, ['refreshToken']);
      return value && validToken(value.refreshToken) ? repo.revokeDesktopSession(tokens.hash(value.refreshToken)) : failure('INVALID_INPUT', '退出参数无效');
    },
    async changePassword(token: string, input: unknown) {
      const value = object(input, ['currentPassword', 'newPassword']);
      if (!value || typeof value.currentPassword !== 'string' || !value.currentPassword.length || value.currentPassword.length > AUTH_LIMITS.passwordMax || !isNewAccountPassword(value.newPassword) || value.newPassword === value.currentPassword) return failure('INVALID_INPUT', '新密码至少6位，仅允许英文字母和数字，且必须与当前密码不同');
      const identity = await me(token);
      if (!identity.ok) return identity;
      const credential = await repo.credential(identity.data.email);
      if (!credential.ok) return credential;
      if (!credential.data?.active) return unauthorized();
      try {
        if (!await passwords.verify(value.currentPassword, credential.data.passwordHash)) return unauthorized();
        return await repo.changePassword(tokens.hash(token), credential.data.passwordHash, credential.data.securityRevision, await passwords.hash(value.newPassword), 'api');
      } catch { return failure('UNAVAILABLE', '改密暂不可用'); } // Never log passwords or crypto errors.
    },
  };
}
export type DesktopSessionService = ReturnType<typeof createDesktopSessionService>;




