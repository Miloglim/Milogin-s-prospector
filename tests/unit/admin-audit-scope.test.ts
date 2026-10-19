import { describe, expect, it, vi } from 'vitest';
import { createAdminService } from '../../server/services/admin';
import { PostgresAdminRepository } from '../../server/adapters/postgres/admin-repository';
import { CRM_TEST_DATABASE, CRM_TEST_HOST, CRM_TEST_PORT } from '../../server/adapters/postgres/config';
import { success } from '../../server/core/crm';

const userId = '11111111-1111-4111-8111-111111111111';
describe('management audit identity filter', () => {
  it('validates identity IDs and forwards them without substituting names', async () => {
    const audit = vi.fn().mockResolvedValue(success([]));
    const service = createAdminService({ audit } as any, {} as any, {} as any,
      { hash: (token: string) => token } as any, {} as any,
      { me: async () => success({ mustChangePassword: false }) } as any);
    expect((await service.audit('session', 'crm', 'Same Name')).ok).toBe(false);
    expect(audit).not.toHaveBeenCalled();
    expect((await service.audit('session', 'crm', userId)).ok).toBe(true);
    expect(audit).toHaveBeenCalledWith('session', 'crm', userId);
  });

  function repository(identityAdmin: boolean, capabilities: string[]) {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM identity.sessions')) return { rows: [{ userId, identityAdmin, enabled: true, roles: ['auditor'], scope: 'own', capabilities }] };
      return { rows: [] };
    });
    const pool = { options: { host: CRM_TEST_HOST, port: CRM_TEST_PORT, database: CRM_TEST_DATABASE, user: CRM_TEST_DATABASE }, connect: async () => ({ query, release: vi.fn() }) };
    return { repo: new PostgresAdminRepository(pool as any, { write: vi.fn() }), query };
  }
  it('filters actor or target by UUID within the authorized product scope', async () => {
    const { repo, query } = repository(false, ['audit.read']);
    expect((await repo.audit('hash', 'crm', userId)).ok).toBe(true);
    const call = query.mock.calls.find(([sql]) => sql.includes('identity.management_audit'));
    expect(call?.[0]).toContain('a.product_id IS NOT DISTINCT FROM $1');
    expect(call?.[0]).toContain('a.actor_id=$3::uuid OR a.target_id=$3::uuid');
    expect(call?.[1]).toEqual(['crm', expect.any(Number), userId]);
  });
  it('does not grant identity or product auditing through the identity filter', async () => {
    const { repo, query } = repository(false, []);
    expect((await repo.audit('hash', undefined, userId)).ok).toBe(false);
    expect((await repo.audit('hash', 'crm', userId)).ok).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes('identity.management_audit'))).toBe(false);
  });
});
