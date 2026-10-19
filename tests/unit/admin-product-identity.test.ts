import { describe, expect, it } from 'vitest';
import { capabilitiesFor, effectiveCapabilitiesFor, productPermissionsFor, productRoleFor } from '../../server/core/admin';
import { delegationCapabilities } from '../../admin-web/permissions';
import { createAdminService } from '../../server/services/admin';
import { success } from '../../server/core/crm';

const userId = '11111111-1111-4111-8111-111111111111';
describe('single product identity', () => {
  it('keeps one persisted identity while managers inherit user development abilities', () => {
    const manager = productPermissionsFor('operations');
    expect(manager.roles).toEqual(['operations']);
    expect(manager.scope).toBe('shared');
    expect(manager.capabilities).toEqual(expect.arrayContaining(capabilitiesFor(['sales'])));
    expect(manager.capabilities).not.toContain('roles.manage');
    expect(productPermissionsFor('sales').scope).toBe('own');
    expect(productPermissionsFor('admin')).toEqual({ roles: ['admin'], capabilities: capabilitiesFor(['admin', 'operations', 'sales', 'auditor']), scope: 'summary' });
    expect(productPermissionsFor('auditor').capabilities).not.toContain('leads.develop');
  });
  it('displays legacy multiple roles in the existing priority without modifying them', () => {
    const roles = ['sales', 'auditor', 'operations'] as const;
    expect(productRoleFor([...roles])).toBe('operations');
    expect(roles).toEqual(['sales', 'auditor', 'operations']);
    expect(productRoleFor(['sales', 'admin'])).toBe('admin');
    expect(productRoleFor([])).toBeUndefined();
  });
  it('keeps legacy default grants and honors only stored capabilities allowed by explicit identities', () => {
    expect(effectiveCapabilitiesFor(['admin'], null)).toEqual(capabilitiesFor(['admin']));
    expect(effectiveCapabilitiesFor(['operations'], null)).not.toContain('leads.claim');
    expect(effectiveCapabilitiesFor(['operations'], ['leads.claim', 'roles.manage'])).toEqual(['leads.claim']);
    expect(effectiveCapabilitiesFor(['admin'], productPermissionsFor('admin').capabilities)).toEqual(productPermissionsFor('admin').capabilities);
    expect(effectiveCapabilitiesFor(['sales', 'auditor'], ['leads.claim', 'audit.read', 'roles.manage'])).toEqual(['leads.claim', 'audit.read']);
    expect(effectiveCapabilitiesFor(['sales'], [])).toEqual([]);
  });
  it('does not invent delegation powers for a restricted CRM administrator', () => {
    const actor = { accessActive: true, identityAdmin: false, crmRoles: ['admin'], capabilities: ['roles.manage', 'access.manage'], scope: 'summary' } as any;
    expect(delegationCapabilities(actor)).toEqual(actor.capabilities);
    expect(delegationCapabilities({ ...actor, identityAdmin: true })).toEqual(capabilitiesFor(['admin', 'operations', 'sales', 'auditor']));
  });
  it('derives new identity fields on the service boundary and preserves old array requests', async () => {
    const commands: unknown[] = [];
    const service = createAdminService({ mutate: async (_hash: string, command: unknown) => { commands.push(command); return success(undefined); } } as any,
      {} as any, {} as any, { hash: v => v } as any, {} as any,
      { me: async () => success({ mustChangePassword: false }) } as any);
    const legacy = { action: 'product.update', userId, revision: 1, productId: 'crm', active: true, roles: ['sales'], capabilities: ['leads.claim'], scope: 'own', reason: 'test' };
    expect((await service.mutate('token', { ...legacy, role: 'operations' }, undefined)).ok).toBe(true);
    expect(commands[0]).toEqual({ ...legacy, role: 'operations', ...productPermissionsFor('operations') });
    expect((await service.mutate('token', legacy, undefined)).ok).toBe(true);
    expect(commands[1]).toEqual(legacy);
    expect((await service.mutate('token', { ...legacy, role: 'operations', ...productPermissionsFor('operations') }, undefined)).ok).toBe(true);
    expect((await service.mutate('token', { ...legacy, role: 'owner' }, undefined)).ok).toBe(false);
    expect((await service.mutate('token', { ...legacy, role: 'sales', identityAdmin: true }, undefined)).ok).toBe(false);
  });
});
