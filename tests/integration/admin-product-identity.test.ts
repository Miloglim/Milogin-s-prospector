import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresAdminRepository } from '../../server/adapters/postgres/admin-repository';
import { capabilitiesFor, productPermissionsFor, type AdminCommand } from '../../server/core/admin';

describe.runIf(process.env.PROSPECTOR_A2_TEST === '1')('A2 PostgreSQL rollback-only identity permissions', () => {
  let pool: Pool, client: PoolClient, repo: PostgresAdminRepository, actorId: string, targetId: string, hash: string;
  const logs: string[] = [];
  beforeEach(async () => {
    pool = new Pool(readTestDatabaseConfig()); client = await pool.connect(); await client.query('BEGIN');
    const accounts = JSON.parse(readFileSync('.work/pg-crm/online-fixtures.json', 'utf8')).accounts;
    actorId = accounts.find((account: any) => account.email === 'agent-admin@example.invalid').userId;
    targetId = accounts.find((account: any) => account.email === 'agent-user@example.invalid').userId;
    await client.query('UPDATE identity.users SET identity_admin=true,active=true,must_change_password=false WHERE user_id=$1', [actorId]);
    await client.query("DELETE FROM identity.product_grants WHERE user_id=$1 AND product_id='crm'", [actorId]);
    await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm','admin')", [actorId]);
    await client.query("INSERT INTO identity.product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm','summary',$2) ON CONFLICT(user_id,product_id) DO UPDATE SET active=true,scope='summary',capabilities=EXCLUDED.capabilities", [actorId, JSON.stringify(productPermissionsFor('admin').capabilities)]);
    hash = createHash('sha256').update(randomUUID()).digest('hex');
    await client.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) SELECT $1,user_id,security_revision,now()+interval '1 hour','browser' FROM identity.users WHERE user_id=$2", [hash, actorId]);
    const wrapped = { options: pool.options, connect: async () => ({ release: () => {}, query: async (sql: string, params?: any[]) => {
      if (sql === 'BEGIN') return client.query('SAVEPOINT a2_operation');
      if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT a2_operation');
      if (sql === 'ROLLBACK') { await client.query('ROLLBACK TO SAVEPOINT a2_operation'); return client.query('RELEASE SAVEPOINT a2_operation'); }
      return client.query(sql, params);
    } }) };
    repo = new PostgresAdminRepository(wrapped as any, { write: (_level, _context, message) => logs.push(message) });
  });
  afterEach(async () => { if (client) { await client.query('ROLLBACK'); client.release(); } await pool?.end(); expect(logs.splice(0)).toEqual([]); });
  async function command(role: 'sales' | 'operations' | 'admin' | 'auditor', userId = targetId): Promise<AdminCommand> {
    const revision = (await client.query('SELECT management_revision FROM identity.users WHERE user_id=$1', [userId])).rows[0].management_revision;
    return { action: 'product.update', userId, revision, productId: 'crm', active: true, role, roles: ['sales'], capabilities: ['leads.claim'], scope: 'own', reason: 'A2 rollback verification' };
  }
  it('persists one identity and server-derived capabilities even when compatible fields disagree', async () => {
    const before = (await client.query('SELECT identity_admin FROM identity.users WHERE user_id=$1', [targetId])).rows[0];
    const input = await command('operations'); expect((await repo.mutate(hash, input)).ok).toBe(true);
    expect((await client.query("SELECT role FROM identity.product_grants WHERE user_id=$1 AND product_id='crm'", [targetId])).rows).toEqual([{ role: 'operations' }]);
    expect((await client.query("SELECT scope,capabilities FROM identity.product_access WHERE user_id=$1 AND product_id='crm'", [targetId])).rows[0]).toEqual({ scope: 'shared', capabilities: productPermissionsFor('operations').capabilities });
    expect((await repo.mutate(hash, input)).ok).toBe(false);
    expect((await repo.mutate(hash, await command('admin'))).ok).toBe(true);
    expect((await client.query('SELECT identity_admin FROM identity.users WHERE user_id=$1', [targetId])).rows[0]).toEqual(before);
    expect((await client.query("SELECT count(*)::int AS total FROM identity.management_audit WHERE target_id=$1 AND reason='A2 rollback verification'", [targetId])).rows[0].total).toBe(2);
  });
  it('preserves legacy array capability requests without silently normalizing historical users', async () => {
    const explicit = await command('sales'); const { role: _role, ...legacy } = explicit;
    expect((await repo.mutate(hash, legacy)).ok).toBe(true);
    expect((await client.query("SELECT capabilities FROM identity.product_access WHERE user_id=$1 AND product_id='crm'", [targetId])).rows[0].capabilities).toEqual(['leads.claim']);
  });
  it('blocks restricted delegation, self elevation and inactive product managers', async () => {
    await client.query('UPDATE identity.users SET identity_admin=false WHERE user_id=$1', [actorId]);
    await client.query("UPDATE identity.product_access SET capabilities=$2 WHERE user_id=$1 AND product_id='crm'", [actorId, JSON.stringify(capabilitiesFor(['admin']))]);
    expect((await repo.mutate(hash, await command('operations'))).ok).toBe(false);
    const explicit = await command('operations'); const { role: _role, ...legacy } = explicit;
    expect((await repo.mutate(hash, { ...legacy, roles: ['operations', 'sales'], capabilities: capabilitiesFor(['operations', 'sales']), scope: 'shared' })).ok).toBe(false);
    expect((await repo.mutate(hash, await command('admin', actorId))).ok).toBe(false);
    await client.query("UPDATE identity.product_access SET capabilities=$2 WHERE user_id=$1 AND product_id='crm'", [actorId, JSON.stringify(productPermissionsFor('admin').capabilities)]);
    expect((await repo.mutate(hash, await command('operations'))).ok).toBe(true);
    await client.query("UPDATE identity.product_access SET active=false WHERE user_id=$1 AND product_id='crm'", [actorId]);
    expect((await repo.mutate(hash, await command('sales'))).ok).toBe(false);
  });
  it('creates new accounts with one role and a complete fixed identity, entirely inside rollback', async () => {
    for (const role of ['operations', 'sales', 'admin', 'auditor'] as const) {
      const email = `a2-${randomUUID()}@example.invalid`;
      expect((await repo.mutate(hash, { action: 'user.create', role, email, reason: 'A2 rollback verification' }, undefined, 'synthetic-hash')).ok).toBe(true);
      const user = (await client.query('SELECT u.user_id,u.must_change_password FROM identity.users u JOIN identity.login_emails e USING(user_id) WHERE e.email=$1', [email])).rows[0];
      expect(user.must_change_password).toBe(true);
      expect((await client.query('SELECT role FROM identity.product_grants WHERE user_id=$1', [user.user_id])).rows).toEqual([{ role }]);
      expect((await client.query("SELECT scope,capabilities FROM identity.product_access WHERE user_id=$1 AND product_id='crm'", [user.user_id])).rows[0]).toEqual({ scope: productPermissionsFor(role).scope, capabilities: productPermissionsFor(role).capabilities });
    }
  });
});
