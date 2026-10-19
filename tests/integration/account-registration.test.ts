import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresAuthRepository } from '../../server/adapters/postgres/auth-repository';
import { PasswordAdapter, tokenAdapter } from '../../server/adapters/password';
import { LoginRateGate } from '../../server/adapters/login-rate';
import { createAuthService } from '../../server/services/auth';
import { createDesktopSessionService } from '../../server/services/desktop-session';
import { createDesktopAuthHandler } from '../../server/transport/desktop-auth-http';
import { createOnlineServer } from '../../server/transport/http';
import { ONLINE_DEFAULTS } from '../../server/core/auth';

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === '1')('registration real HTTP and PostgreSQL policy', () => {
  let pool: Pool, server: ReturnType<typeof createOnlineServer>, base: string;
  const log = { write: () => {} };
  beforeAll(async () => {
    pool = new Pool(readTestDatabaseConfig());
    const repo = new PostgresAuthRepository(pool, log), passwords = new PasswordAdapter(2), clock = { now: () => Date.now() };
    await passwords.initialize();
    const auth = createAuthService(repo, passwords, tokenAdapter, clock, ONLINE_DEFAULTS.session_ttl_seconds);
    const desktop = createDesktopSessionService(repo, passwords, tokenAdapter, clock, ONLINE_DEFAULTS.session_ttl_seconds);
    const gate = new LoginRateGate({ ...ONLINE_DEFAULTS, login_max_attempts: 64 }, clock);
    server = createOnlineServer(auth, gate, ONLINE_DEFAULTS, log, 'registration-test', undefined, undefined, createDesktopAuthHandler(desktop, gate, ONLINE_DEFAULTS));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    await pool?.end();
  });
  async function register(email: string, password: string) {
    return fetch(`${base}/api/auth/desktop/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  }
  it.each(['abc!123', 'abc 123', '密码123456', '12345'])('rejects invalid password without creating any identity: %j', async password => {
    const email = `${randomUUID()}@example.invalid`;
    expect((await register(email, password)).status).toBe(400);
    expect((await pool.query('SELECT 1 FROM identity.login_emails WHERE email=$1', [email])).rows).toEqual([]);
  });
  it('rejects Chinese email and creates one ordinary user for a valid plus-address', async () => {
    expect((await register(`中文${randomUUID()}@example.invalid`, 'Abc123')).status).toBe(400);
    const email = `New.Name+${randomUUID()}@example.invalid`;
    expect((await register(email, 'Abc123')).status).toBe(200);
    const rows = (await pool.query(`SELECT u.identity_admin,g.role FROM identity.users u JOIN identity.login_emails e USING(user_id)
      JOIN identity.product_grants g USING(user_id) WHERE e.email=$1`, [email.toLowerCase()])).rows;
    expect(rows).toEqual([{ identity_admin: false, role: 'sales' }]);
    const response = await fetch(`${base}/api/auth/desktop/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Abc123' }) });
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.identity.crmRoles).toEqual(['sales']);
  });
});
