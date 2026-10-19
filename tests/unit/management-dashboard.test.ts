import { describe, expect, it } from 'vitest';
import { canReadManagementDashboard } from '../../server/core/management-dashboard';

describe('global dashboard read boundary', () => {
  it('refuses an own-scope account even with the metrics capability', () => {
    expect(canReadManagementDashboard({ identityAdmin: false, scope: 'own', roles: ['sales'], capabilities: ['metrics.read'] })).toBe(false);
  });
  it('refuses a shared operations account to expose global counts', () => {
    expect(canReadManagementDashboard({ identityAdmin: false, scope: 'shared', roles: ['operations'], capabilities: ['metrics.read'] })).toBe(false);
  });
  it('accepts a summary auditor with current metrics permission', () => {
    expect(canReadManagementDashboard({ identityAdmin: false, scope: 'summary', roles: ['auditor'], capabilities: ['metrics.read'] })).toBe(true);
    expect(canReadManagementDashboard({ identityAdmin: false, scope: 'summary', roles: ['auditor'], capabilities: [] })).toBe(false);
  });
});
