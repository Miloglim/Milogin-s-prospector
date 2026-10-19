import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresCrmRepository } from '../../server/adapters/postgres/repository';
import { PostgresAuthRepository } from '../../server/adapters/postgres/auth-repository';
import { PostgresAdminRepository } from '../../server/adapters/postgres/admin-repository';
import { PasswordAdapter, tokenAdapter } from '../../server/adapters/password';
import { LoginRateGate } from '../../server/adapters/login-rate';
import { createAuthService } from '../../server/services/auth';
import { createDesktopSessionService } from '../../server/services/desktop-session';
import { createDesktopAuthHandler } from '../../server/transport/desktop-auth-http';
import { createOnlineServer } from '../../server/transport/http';
import { API_ROUTES, ONLINE_DEFAULTS } from '../../server/core/auth';
import { DESKTOP_AUTH_ROUTES as ROUTES } from '../../server/core/desktop-session';

const TIMEOUT_MS = 30000;
const SECOND_MS = 1000;
const logs: string[] = [];
const log = { write: (_level: string, _context: string, message: string) => { logs.push(message); } };
const password = randomBytes(24).toString('hex');
const clock = { now: () => Date.now() };
const users = { a: randomUUID(), b: randomUUID(), restricted: randomUUID(), admin: randomUUID() };
const prefix = `desktop-${Date.now()}`;
const email = (key: keyof typeof users) => `${prefix}-${key}@example.invalid`;
let pool: Pool, repo: PostgresAuthRepository, passwords: PasswordAdapter;
let server: ReturnType<typeof createOnlineServer>, base: string;
async function start() {
  const gate = new LoginRateGate({ ...ONLINE_DEFAULTS, login_max_attempts: 64 }, clock);
  const auth = createAuthService(repo, passwords, tokenAdapter, clock, ONLINE_DEFAULTS.session_ttl_seconds);
  const desktop = createDesktopSessionService(repo, passwords, tokenAdapter, clock, ONLINE_DEFAULTS.session_ttl_seconds);
  server = createOnlineServer(auth, gate, ONLINE_DEFAULTS, log, 'desktop-test', undefined, undefined, createDesktopAuthHandler(desktop, gate, ONLINE_DEFAULTS));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP address missing');
  base = `http://127.0.0.1:${address.port}`;
}
async function close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
async function request(route: string, body?: unknown, token?: string) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
}
async function login(key: keyof typeof users = 'a', suppliedPassword = password) {
  const result = await request(ROUTES.login, { email: email(key), password: suppliedPassword });
  expect(result.status).toBe(200);
  expect(result.body.data.identity.userId).toBe(users[key]);
  return result.body.data as { token: string; refreshToken: string; expiresAt: string; identity: any };
}
const refresh = (refreshToken: string) => request(ROUTES.refresh, { refreshToken });

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('desktop sessions real HTTP + isolated PostgreSQL', () => {
  beforeAll(async () => {
    execFileSync(process.execPath, ['scripts/crm-postgres.mjs', 'start'], { timeout: TIMEOUT_MS, stdio: 'pipe', windowsHide: true });
    pool = new Pool(readTestDatabaseConfig());
    expect((await new PostgresCrmRepository(pool, log).migrate()).ok).toBe(true);
    repo = new PostgresAuthRepository(pool, log);
    expect((await repo.migrate()).ok).toBe(true);
    passwords = new PasswordAdapter(ONLINE_DEFAULTS.password_concurrency);
    await passwords.initialize();
    const hash = await passwords.hash(password);
    for (const key of Object.keys(users) as (keyof typeof users)[]) expect((await repo.ensureFixture({ userId: users[key], email: email(key), displayName: key, identityAdmin: key === 'admin', crmRoles: [key === 'admin' ? 'admin' : 'sales'], passwordHash: hash, mustChangePassword: key === 'restricted' })).ok).toBe(true);
    await start();
  }, TIMEOUT_MS);
  afterAll(async () => { if (server?.listening) await close(); await pool?.end(); });

  it('self-registers one normal sales identity atomically, rejects role injection and concurrent duplicates', async () => {
    const registrationEmail = `${prefix}-registered@example.invalid`;
    expect((await request(ROUTES.register, { email: registrationEmail, password: 'short' })).status).toBe(400);
    expect((await request(ROUTES.register, { email: registrationEmail, password, role: 'admin' })).status).toBe(400);
    const responses = await Promise.all([request(ROUTES.register, { email: registrationEmail.toUpperCase(), password }), request(ROUTES.register, { email: registrationEmail, password })]);
    expect(responses.map(result => result.status).sort()).toEqual([200, 409]);
    const account = await request(ROUTES.login, { email: registrationEmail, password });
    expect(account.status).toBe(200);
    expect(account.body.data.identity).toMatchObject({ email: registrationEmail, identityAdmin: false, emailVerified: false, crmRoles: ['sales'] });
    const scope = await pool.query("SELECT scope,active FROM identity.product_access WHERE user_id=$1 AND product_id='crm'", [account.body.data.identity.userId]);
    expect(scope.rows).toEqual([{ scope: 'own', active: true }]);
    expect((await request(API_ROUTES.users, undefined, account.body.data.token)).status).toBe(403);
    const saved = await pool.query('SELECT password_hash FROM identity.credentials WHERE user_id=$1', [account.body.data.identity.userId]);
    expect(saved.rows[0].password_hash).not.toBe(password);
    expect(await passwords.verify(password, saved.rows[0].password_hash)).toBe(true);
    const audit = await pool.query("SELECT action FROM identity.management_audit WHERE target_id=$1 AND action='identity.register'", [account.body.data.identity.userId]);
    expect(audit.rows).toHaveLength(1);
  });

  it('persists only hashes, restores after server restart and rotates with one concurrent winner', async () => {
    const session = await login();
    const saved = await pool.query('SELECT s.session_id,s.token_hash,r.token_hash AS refresh_hash FROM identity.sessions s JOIN identity.desktop_refresh_tokens r USING(session_id) WHERE s.token_hash=$1', [tokenAdapter.hash(session.token)]);
    expect(saved.rows[0].refresh_hash).toBe(tokenAdapter.hash(session.refreshToken));
    expect(JSON.stringify(saved.rows)).not.toContain(session.refreshToken);
    await close(); await start();
    expect((await request(ROUTES.me, undefined, session.token)).status).toBe(200);
    const results = await Promise.all([refresh(session.refreshToken), refresh(session.refreshToken)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 401]);
    const winner = results.find(result => result.status === 200)!.body.data;
    expect(winner.identity.userId).toBe(users.a);
    expect(winner.refreshToken).not.toBe(session.refreshToken);
    expect((await request(API_ROUTES.me, undefined, session.token)).status).toBe(401);
    expect((await request(API_ROUTES.me, undefined, winner.token)).status).toBe(200);
    expect((await refresh(session.refreshToken)).status).toBe(401);
    expect((await request(ROUTES.me, undefined, winner.token)).status).toBe(200);
    expect((await pool.query('SELECT session_id FROM identity.sessions WHERE token_hash=$1', [tokenAdapter.hash(winner.token)])).rows[0].session_id).toBe(saved.rows[0].session_id);
  });
  it('logout revokes the entire rotated family but preserves another device and account', async () => {
    const session = await login(), second = await login(), other = await login('b');
    const rotated = (await refresh(session.refreshToken)).body.data;
    expect((await request(ROUTES.logout, { refreshToken: session.refreshToken })).status).toBe(200);
    expect((await refresh(rotated.refreshToken)).status).toBe(401);
    expect((await request(ROUTES.me, undefined, rotated.token)).status).toBe(401);
    expect((await request(ROUTES.me, undefined, second.token)).status).toBe(200);
    expect((await request(ROUTES.me, undefined, other.token)).body.data.userId).toBe(users.b);
  });
  it('allows renewal after bearer expires but enforces idle and absolute expiry', async () => {
    const expiredBearer = await login();
    await pool.query("UPDATE identity.sessions SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE token_hash=$1", [tokenAdapter.hash(expiredBearer.token)]);
    expect((await refresh(expiredBearer.refreshToken)).status).toBe(200);
    for (const column of ['idle_expires_at', 'absolute_expires_at']) {
      const session = await login();
      await pool.query(`UPDATE identity.desktop_refresh_tokens SET idle_expires_at=now()-interval '1 second'${column === 'absolute_expires_at' ? ",absolute_expires_at=now()-interval '1 second'" : ''} WHERE token_hash=$1`, [tokenAdapter.hash(session.refreshToken)]);
      expect((await refresh(session.refreshToken)).status).toBe(401);
    }
    const nearAbsolute = await login();
    await pool.query("UPDATE identity.desktop_refresh_tokens SET idle_expires_at=now()+interval '30 seconds',absolute_expires_at=now()+interval '30 seconds' WHERE token_hash=$1", [tokenAdapter.hash(nearAbsolute.refreshToken)]);
    const rotated = (await refresh(nearAbsolute.refreshToken)).body.data;
    expect(new Date(rotated.expiresAt).getTime() - Date.now()).toBeLessThan(31 * SECOND_MS);
  });
  it('honors admin stable-session revoke, account disable and security revision', async () => {
    const auth = createAuthService(repo, passwords, tokenAdapter, clock, ONLINE_DEFAULTS.session_ttl_seconds);
    const admin = await auth.login({ email: email('admin'), password }, 'browser');
    expect(admin.ok).toBe(true);
    if (!admin.ok) throw new Error('admin login failed');
    const session = await login();
    const id = (await pool.query('SELECT session_id FROM identity.sessions WHERE token_hash=$1', [tokenAdapter.hash(session.token)])).rows[0].session_id;
    const rotated = (await refresh(session.refreshToken)).body.data;
    expect((await new PostgresAdminRepository(pool, log).mutate(tokenAdapter.hash(admin.data.token), { action: 'session.revoke', userId: users.a, sessionId: id, reason: 'isolated desktop session test' })).ok).toBe(true);
    expect((await refresh(rotated.refreshToken)).status).toBe(401);
    for (const change of ['active=false', 'security_revision=security_revision+1']) {
      const target = await login('b');
      await pool.query(`UPDATE identity.users SET ${change} WHERE user_id=$1`, [users.b]);
      expect((await refresh(target.refreshToken)).status).toBe(401);
      expect((await request(ROUTES.me, undefined, target.token)).status).toBe(401);
      await pool.query('UPDATE identity.users SET active=true WHERE user_id=$1', [users.b]);
    }
  });
  it('supports restricted first-password change without granting CRM and revokes every old session', async () => {
    const restricted = await login('restricted'), second = await login('restricted');
    expect(restricted.identity.mustChangePassword).toBe(true);
    expect((await request(ROUTES.me, undefined, restricted.token)).status).toBe(200);
    expect((await request(API_ROUTES.me, undefined, restricted.token)).body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await request(API_ROUTES.crmAccess, undefined, restricted.token)).status).toBe(403);
    const nextPassword = randomBytes(24).toString('hex');
    expect((await request(ROUTES.password, { currentPassword: 'incorrect-password', newPassword: nextPassword }, restricted.token)).status).toBe(401);
    expect((await request(ROUTES.me, undefined, restricted.token)).status).toBe(200);
    expect((await request(ROUTES.password, { currentPassword: password, newPassword: nextPassword }, restricted.token)).status).toBe(200);
    expect((await refresh(second.refreshToken)).status).toBe(401);
    expect((await request(ROUTES.me, undefined, restricted.token)).status).toBe(401);
    expect((await login('restricted', nextPassword)).identity.mustChangePassword).toBe(false);
  }, TIMEOUT_MS);
  it('rejects browser/legacy impersonation, malformed or forged refresh and privilege injection', async () => {
    const legacy = await request(API_ROUTES.login, { email: email('a'), password });
    expect((await request(ROUTES.me, undefined, legacy.body.data.token)).status).toBe(401);
    expect((await refresh(randomBytes(32).toString('base64url'))).status).toBe(401);
    expect((await request(ROUTES.refresh, { refreshToken: 'short' })).status).toBe(400);
    expect((await request(ROUTES.login, { email: email('a'), password, role: 'admin' })).status).toBe(400);
    expect(logs.join('\n')).not.toContain(password);
    expect((await repo.migrate()).ok).toBe(true);
  });
  it('re-reads current product capabilities on renewal and does not resurrect revoked product access', async () => {
    const session = await login('b');
    await pool.query('UPDATE identity.product_grants SET active=false WHERE user_id=$1', [users.b]);
    const rotated = await refresh(session.refreshToken);
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.identity.crmRoles).toEqual([]);
    expect((await request(API_ROUTES.crmAccess, undefined, rotated.body.data.token)).status).toBe(403);
    expect(logs.join('\n')).not.toContain(rotated.body.data.token);
    expect(logs.join('\n')).not.toContain(rotated.body.data.refreshToken);
  });
});
