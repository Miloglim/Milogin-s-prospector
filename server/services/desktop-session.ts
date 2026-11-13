import { randomUUID } from 'node:crypto';
import { AUTH_LIMITS, BOOTSTRAP_LOGIN_MIN, isAccountEmail, isNewAccountPassword, type ClockPort, type PasswordPort, type TokenPort } from '../core/auth';
import { DESKTOP_DEVICE_PRODUCTS, DESKTOP_SESSION_LIMITS, REGISTRATION_PRODUCTS, type DesktopDeviceContext, type DesktopSessionRepository, type DesktopLoginResponse, type RegistrationProduct } from '../core/desktop-session';
import { failure, success, type Result } from '../core/crm';
import type { Identity } from '../core/auth';
import type { OfflineAccessIssuer } from '../core/offline-access';
import { DEVICE_HANDOFF_LIMITS, type DesktopHandoffBeginRequest, type DesktopHandoffBeginResult, type DeviceHandoffState, type DeviceHandoffSummary, type DesktopHandoffTakeoverRequest, type DesktopHandoffTokenRequest } from '../core/device-handoff';

const MILLISECONDS_PER_SECOND = 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const DEVICE_SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]+$/;
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9._-]+$/;
const DEVICE_TEXT_MAX = 120;
const APP_VERSION_MAX = 64;
const HANDOFF_REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const HANDOFF_COUNT_MAX = 1_000_000_000;
const unauthorized = () => failure('UNAUTHORIZED', '登录信息无效或会话已失效');
const validToken = (token: unknown): token is string => typeof token === 'string' && token.length === AUTH_LIMITS.tokenCharacters && TOKEN_PATTERN.test(token);
function object(input: unknown, keys: string[]): Record<string, unknown> | null {
  return input && typeof input === 'object' && !Array.isArray(input) && !Object.keys(input).some(key => !keys.includes(key)) ? input as Record<string, unknown> : null;
}
function desktopContext(input: unknown): DesktopDeviceContext | undefined | null {
  if (input === undefined) return undefined;
  const value = object(input, ['product', 'deviceId', 'deviceName', 'platform', 'appVersion', 'replaceActiveDevice']);
  const deviceName = typeof value?.deviceName === 'string' ? value.deviceName.trim() : '';
  if (!value || !DESKTOP_DEVICE_PRODUCTS.includes(value.product as never)
    || typeof value.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(value.deviceId)
    || !deviceName || deviceName.length > DEVICE_TEXT_MAX || !DEVICE_SAFE_TEXT_PATTERN.test(deviceName)
    || typeof value.platform !== 'string' || !DEVICE_CODE_PATTERN.test(value.platform) || value.platform.length > APP_VERSION_MAX
    || typeof value.appVersion !== 'string' || !DEVICE_CODE_PATTERN.test(value.appVersion) || value.appVersion.length > APP_VERSION_MAX
    || value.replaceActiveDevice !== undefined && typeof value.replaceActiveDevice !== 'boolean') return null;
  return {
    product: value.product as DesktopDeviceContext['product'], deviceId: value.deviceId, deviceName,
    platform: value.platform, appVersion: value.appVersion,
    ...(value.replaceActiveDevice === undefined ? {} : { replaceActiveDevice: value.replaceActiveDevice }),
  };
}
function handoffSummary(input: unknown): DeviceHandoffSummary | null {
  const value = object(input, ['checkedAt', 'counts', 'blockers']);
  const counts = value ? object(value.counts, ['contactPending','contactFailed','offlinePending','offlineFailed','templates','inboxLabels','queuedSends','activeCampaigns','pendingMailChanges']) : null;
  const numbers = counts ? Object.values(counts) : [];
  if (!value || !counts || typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt))
    || numbers.some(number => typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 || number > HANDOFF_COUNT_MAX)
    || !Array.isArray(value.blockers) || value.blockers.length > DEVICE_HANDOFF_LIMITS.blocker_max
    || value.blockers.some(blocker => typeof blocker !== 'string' || !blocker.trim() || blocker.length > DEVICE_HANDOFF_LIMITS.blocker_text_max || !DEVICE_SAFE_TEXT_PATTERN.test(blocker))) return null;
  return {
    checkedAt: value.checkedAt,
    counts: counts as unknown as DeviceHandoffSummary['counts'],
    blockers: value.blockers as string[],
  };
}
function handoffTokenRequest(input: unknown): DesktopHandoffTokenRequest | null {
  const value = object(input, ['handoffToken']);
  return value && validToken(value.handoffToken) ? { handoffToken: value.handoffToken } : null;
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
  function handoffSessionDraft() {
    const token = tokens.create(), refreshToken = tokens.create(), expiresAt = date(ttlSeconds);
    return {
      token, refreshToken, expiresAt,
      draft: { tokenHash: tokens.hash(token), refreshHash: tokens.hash(refreshToken), expiresAt, idleExpiresAt: date(DESKTOP_SESSION_LIMITS.idle_seconds), absoluteExpiresAt: date(DESKTOP_SESSION_LIMITS.absolute_seconds) },
    };
  }
  async function completeHandoff(input: unknown, takeoverReason?: string): Promise<Result<DesktopLoginResponse>> {
    const value = handoffTokenRequest(input);
    if (!value) return failure('INVALID_INPUT', '换机参数无效');
    const next = handoffSessionDraft();
    const completed = await repo.completeDesktopHandoff(tokens.hash(value.handoffToken), next.draft, takeoverReason);
    return !completed.ok ? completed : completed.data ? loginResponse(next.token, next.refreshToken, next.expiresAt, completed.data, next.draft.absoluteExpiresAt) : unauthorized();
  }
  return {
    me,
    async register(input: unknown) {
      const value = object(input, ['email', 'password', 'product']);
      const product = value?.product ?? 'crm';
      if (!value || !isAccountEmail(value.email) || !isNewAccountPassword(value.password)
        || !REGISTRATION_PRODUCTS.includes(product as RegistrationProduct)) return failure('INVALID_INPUT', '请输入有效邮箱，密码至少6位，仅允许英文字母和数字');
      if (!repo.createSalesAccount) return failure('UNAVAILABLE', '注册暂不可用');
      try { return await repo.createSalesAccount({ email: value.email.trim().toLowerCase(), passwordHash: await passwords.hash(value.password), product: product as RegistrationProduct }); }
      catch { return failure('UNAVAILABLE', '注册暂不可用，请稍后重试'); } // Do not include credentials or crypto diagnostics in responses.
    },
    async login(input: unknown): Promise<Result<DesktopLoginResponse>> {
      const value = object(input, ['email', 'password', 'desktop']);
      if (!value || typeof value.email !== 'string' || value.email!==value.email.trim() || !EMAIL_PATTERN.test(value.email.trim()) || value.email.length > AUTH_LIMITS.emailMax || typeof value.password !== 'string' || value.password.length < BOOTSTRAP_LOGIN_MIN || value.password.length > AUTH_LIMITS.passwordMax) return failure('INVALID_INPUT', '登录参数无效');
      const desktop = desktopContext(value.desktop);
      if (desktop === null) return failure('INVALID_INPUT', '设备信息无效');
      const credential = await repo.credential(value.email.trim().toLowerCase());
      if (!credential.ok) return credential;
      try {
        const verified = await passwords.verify(value.password, credential.data?.passwordHash ?? '');
        if (!verified || !credential.data?.active || (value.password.length < AUTH_LIMITS.passwordMin && !credential.data.mustChangePassword)) return unauthorized();
      } catch { return failure('UNAVAILABLE', '登录校验暂不可用'); } // Fail closed; crypto errors may contain secrets.
      const token = tokens.create(), refreshToken = tokens.create(), expiresAt = date(ttlSeconds);
      const absoluteExpiresAt = date(DESKTOP_SESSION_LIMITS.absolute_seconds);
      const session = await repo.createDesktopSession({ tokenHash: tokens.hash(token), refreshHash: tokens.hash(refreshToken), userId: credential.data.userId, securityRevision: credential.data.securityRevision, expiresAt, idleExpiresAt: date(DESKTOP_SESSION_LIMITS.idle_seconds), absoluteExpiresAt, ...(desktop ? { desktop } : {}) });
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
    async beginHandoff(input: unknown): Promise<Result<DesktopHandoffBeginResult>> {
      const value = object(input, ['email','password','requestKey','desktop']);
      if (!value || typeof value.email !== 'string' || value.email !== value.email.trim() || !EMAIL_PATTERN.test(value.email) || value.email.length > AUTH_LIMITS.emailMax
        || typeof value.password !== 'string' || value.password.length < BOOTSTRAP_LOGIN_MIN || value.password.length > AUTH_LIMITS.passwordMax
        || typeof value.requestKey !== 'string' || !HANDOFF_REQUEST_KEY_PATTERN.test(value.requestKey)) return failure('INVALID_INPUT', '换机参数无效');
      const desktop = desktopContext(value.desktop);
      if (!desktop) return failure('INVALID_INPUT', '设备信息无效');
      const credential = await repo.credential(value.email.toLowerCase());
      if (!credential.ok) return credential;
      try {
        const verified = await passwords.verify(value.password, credential.data?.passwordHash ?? '');
        if (!verified || !credential.data?.active || (value.password.length < AUTH_LIMITS.passwordMin && !credential.data.mustChangePassword)) return unauthorized();
      } catch { return failure('UNAVAILABLE', '登录校验暂不可用'); } // Keep crypto diagnostics and credentials out of responses.
      const handoffToken = tokens.create();
      const started = await repo.beginDesktopHandoff({
        handoffId: randomUUID(), tokenHash: tokens.hash(handoffToken), requestKey: value.requestKey,
        userId: credential.data.userId, desktop, expiresAt: date(DEVICE_HANDOFF_LIMITS.expires_seconds),
      });
      return started.ok ? success({ handoffToken, state: started.data }) : started;
    },
    async handoffStatus(input: unknown): Promise<Result<DeviceHandoffState>> {
      const value = handoffTokenRequest(input);
      return value ? repo.desktopHandoffStatus(tokens.hash(value.handoffToken)) : Promise.resolve(failure('INVALID_INPUT','换机参数无效'));
    },
    async pendingHandoff(input: unknown) {
      const value = object(input, ['refreshToken']);
      return value && validToken(value.refreshToken) ? repo.pendingDesktopHandoff(tokens.hash(value.refreshToken)) : failure('INVALID_INPUT','续期参数无效');
    },
    async prepareHandoff(input: unknown): Promise<Result<DeviceHandoffState>> {
      const value = object(input, ['refreshToken','summary']);
      const summary = value ? handoffSummary(value.summary) : null;
      return value && validToken(value.refreshToken) && summary ? repo.prepareDesktopHandoff(tokens.hash(value.refreshToken), { summary }) : failure('INVALID_INPUT','换机准备参数无效');
    },
    async completeHandoff(input: unknown) { return completeHandoff(input); },
    async takeoverHandoff(input: unknown): Promise<Result<DesktopLoginResponse>> {
      const value = object(input, ['handoffToken','reason']);
      if (!value || !validToken(value.handoffToken) || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > DEVICE_HANDOFF_LIMITS.takeover_reason_max || !DEVICE_SAFE_TEXT_PATTERN.test(value.reason)) return failure('INVALID_INPUT','接管说明无效');
      return completeHandoff({ handoffToken: value.handoffToken }, value.reason.trim());
    },
    async cancelHandoff(input: unknown) {
      const value = handoffTokenRequest(input);
      return value ? repo.cancelDesktopHandoff(tokens.hash(value.handoffToken)) : Promise.resolve(failure('INVALID_INPUT','换机参数无效'));
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




