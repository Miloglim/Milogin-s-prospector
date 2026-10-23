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
  async function register(email: string, password: string, product?: 'crm' | 'navigator') {
    return fetch(`${base}/api/auth/desktop/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, ...(product ? { product } : {}) }) });
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
    const rows = (await pool.query(`SELECT u.identity_admin,g.product_id,g.role FROM identity.users u JOIN identity.login_emails e USING(user_id)
      JOIN identity.product_grants g USING(user_id) WHERE e.email=$1 ORDER BY g.product_id`, [email.toLowerCase()])).rows;
    expect(rows).toEqual([
      { identity_admin: false, product_id: 'crm', role: 'sales' },
      { identity_admin: false, product_id: 'navigator', role: 'sales' },
    ]);
    const response = await fetch(`${base}/api/auth/desktop/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Abc123' }) });
    expect(response.status).toBe(200);
    expect((await response.json() as any).data.identity.crmRoles).toEqual(['sales']);
  });
  it('creates both sales products when registration comes from Navigator', async () => {
    const email = `Navigator.${randomUUID()}@example.invalid`.toLowerCase();
    expect((await register(email, 'Abc123', 'navigator')).status).toBe(200);
    const grants = (await pool.query(`SELECT g.product_id,g.role,a.active,a.scope FROM identity.users u JOIN identity.login_emails e USING(user_id)
      JOIN identity.product_grants g USING(user_id) LEFT JOIN identity.product_access a ON a.user_id=u.user_id AND a.product_id=g.product_id
      WHERE e.email=$1 ORDER BY g.product_id`, [email])).rows;
    expect(grants).toEqual([
      { product_id: 'crm', role: 'sales', active: true, scope: 'own' },
      { product_id: 'navigator', role: 'sales', active: true, scope: 'own' },
    ]);
    const login = await fetch(`${base}/api/auth/desktop/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Abc123' }) });
    const token = (await login.json() as any).data.token;
    const access = await fetch(`${base}/api/navigator/access`, { headers: { Authorization: `Bearer ${token}` } });
    expect(access.status).toBe(200);
    expect((await access.json() as any).data).toMatchObject({ email, role: 'sales' });
  });
  it('restores a soft-deleted identity when registering the same email again', async () => {
    const email = `restore.${randomUUID()}@example.invalid`.toLowerCase();
    expect((await register(email, 'Abc123')).status).toBe(200);
    const before = (await pool.query('SELECT user_id,security_revision FROM identity.users u JOIN identity.login_emails e USING(user_id) WHERE e.email=$1', [email])).rows[0];
    await pool.query('UPDATE identity.users SET deleted_at=now(),active=false WHERE user_id=$1',[before.user_id]);
    await pool.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[before.user_id]);
    expect((await register(email, 'Def456', 'navigator')).status).toBe(200);
    const after = (await pool.query('SELECT user_id,active,deleted_at,security_revision FROM identity.users u JOIN identity.login_emails e USING(user_id) WHERE e.email=$1', [email])).rows[0];
    expect(after).toMatchObject({ user_id:before.user_id,active:true,deleted_at:null });
    expect(after.security_revision).toBeGreaterThan(before.security_revision);
    const grants = (await pool.query('SELECT product_id,role FROM identity.product_grants WHERE user_id=$1 ORDER BY product_id',[before.user_id])).rows;
    expect(grants).toEqual([{product_id:'crm',role:'sales'},{product_id:'navigator',role:'sales'}]);
    const login = await fetch(`${base}/api/auth/desktop/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Def456' }) });
    expect(login.status).toBe(200);
  });
});
