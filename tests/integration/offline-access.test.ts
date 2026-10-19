import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresCrmRepository } from '../../server/adapters/postgres/repository';
import { PostgresAuthRepository } from '../../server/adapters/postgres/auth-repository';
import { PasswordAdapter, tokenAdapter } from '../../server/adapters/password';
import { loadOfflineAccessIssuer } from '../../server/adapters/offline-access';
import { LoginRateGate } from '../../server/adapters/login-rate';
import { createDesktopSessionService } from '../../server/services/desktop-session';
import { createAuthService } from '../../server/services/auth';
import { createDesktopAuthHandler } from '../../server/transport/desktop-auth-http';
import { createOnlineServer } from '../../server/transport/http';
import { ONLINE_DEFAULTS } from '../../server/core/auth';
import { DESKTOP_AUTH_ROUTES } from '../../server/core/desktop-session';
import { OFFLINE_ACCESS_LIMITS, type OfflineAccessGrant } from '../../server/core/offline-access';

const TIMEOUT_MS = 30000;
const SECOND_MS = 1000;
const log = { write: () => {} }; // Synthetic isolated integration test never logs credentials.
const password = randomBytes(24).toString('base64url');
const userId = randomUUID(), restrictedId = randomUUID();
const email = `offline-${userId}@example.invalid`, restrictedEmail = `offline-${restrictedId}@example.invalid`;
const clock = { now: () => Date.now() };
let pool: Pool, repo: PostgresAuthRepository, passwords: PasswordAdapter;
let server: ReturnType<typeof createOnlineServer>, base: string, folder: string;
async function start() {
  const gate = new LoginRateGate(ONLINE_DEFAULTS, clock);
  const auth = createAuthService(repo, passwords, tokenAdapter, clock, ONLINE_DEFAULTS.session_ttl_seconds);
  // Issuer is resolved after ephemeral listen and before any request is accepted.
  const signer = { issue: (identity: Parameters<ReturnType<typeof loadOfflineAccessIssuer>['issue']>[0], now: number) => loadOfflineAccessIssuer(folder, base).issue(identity, now) };
  const desktop = createDesktopSessionService(repo, passwords, tokenAdapter, clock, ONLINE_DEFAULTS.session_ttl_seconds, signer);
  server = createOnlineServer(auth, gate, ONLINE_DEFAULTS, log, 'offline-synthetic-test', undefined, undefined, createDesktopAuthHandler(desktop, gate, ONLINE_DEFAULTS));
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
function validGrant(grant: OfflineAccessGrant, expectedId: string) {
  expect(verify(null, Buffer.from(grant.payload), grant.publicKey, Buffer.from(grant.signature, 'base64url'))).toBe(true);
  const payload = JSON.parse(grant.payload);
  expect(payload.issuer).toBe(base);
  expect(payload.identity.userId).toBe(expectedId);
  expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(OFFLINE_ACCESS_LIMITS.validity_seconds * SECOND_MS);
}
describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('signed offline access real HTTP and isolated PostgreSQL', () => {
  beforeAll(async () => {
    execFileSync(process.execPath, ['scripts/crm-postgres.mjs', 'start'], { timeout: TIMEOUT_MS, stdio: 'pipe', windowsHide: true });
    folder = mkdtempSync(join(tmpdir(), 'prospector-offline-http-'));
    pool = new Pool(readTestDatabaseConfig());
    expect((await new PostgresCrmRepository(pool, log).migrate()).ok).toBe(true);
    repo = new PostgresAuthRepository(pool, log);
    expect((await repo.migrate()).ok).toBe(true);
    passwords = new PasswordAdapter(ONLINE_DEFAULTS.password_concurrency);
    await passwords.initialize();
    const passwordHash = await passwords.hash(password);
    for (const restricted of [false, true]) expect((await repo.ensureFixture({ userId: restricted ? restrictedId : userId, email: restricted ? restrictedEmail : email, displayName: 'Synthetic offline test', identityAdmin: false, crmRoles: ['sales'], passwordHash, mustChangePassword: restricted })).ok).toBe(true);
    await start();
  }, TIMEOUT_MS);
  afterAll(async () => { if (server?.listening) await close(); await pool?.end(); if (folder) rmSync(folder, { recursive: true, force: true }); });
  it('signs login/refresh, keeps trust over restart, refuses grant-as-bearer and current account disable', async () => {
    const login = await request(DESKTOP_AUTH_ROUTES.login, { email, password });
    expect(login.status).toBe(200);
    validGrant(login.body.data.offlineAccess, userId);
    expect((await request(DESKTOP_AUTH_ROUTES.me, undefined, login.body.data.offlineAccess.signature)).status).toBe(401);
    await close(); await start();
    const renewed = await request(DESKTOP_AUTH_ROUTES.refresh, { refreshToken: login.body.data.refreshToken });
    expect(renewed.status).toBe(200);
    validGrant(renewed.body.data.offlineAccess, userId);
    expect(renewed.body.data.offlineAccess.publicKey).toBe(login.body.data.offlineAccess.publicKey);
    await pool.query('UPDATE identity.users SET active=false WHERE user_id=$1', [userId]);
    expect((await request(DESKTOP_AUTH_ROUTES.refresh, { refreshToken: renewed.body.data.refreshToken })).status).toBe(401);
  }, TIMEOUT_MS);
  it('never returns a lease before required password change', async () => {
    const login = await request(DESKTOP_AUTH_ROUTES.login, { email: restrictedEmail, password });
    expect(login.status).toBe(200);
    expect(login.body.data.identity.mustChangePassword).toBe(true);
    expect(login.body.data.offlineAccess).toBeUndefined();
    const renewed = await request(DESKTOP_AUTH_ROUTES.refresh, { refreshToken: login.body.data.refreshToken });
    expect(renewed.status).toBe(200);
    expect(renewed.body.data.offlineAccess).toBeUndefined();
  });
});
