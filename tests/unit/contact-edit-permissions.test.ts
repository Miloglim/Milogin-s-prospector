import { describe, expect, it } from 'vitest';
import { canDevelopContact } from '../../server/adapters/postgres/contact-assignment-repository';
import type { LeadActor } from '../../server/adapters/postgres/lead-repository';

const actor = (patch: Partial<LeadActor> = {}): LeadActor => ({
  userId: 'actor', roles: ['sales'], scope: 'own', capabilities: ['leads.develop'], ...patch,
});
const contact = (patch: Record<string, unknown> = {}) => ({
  created_by: 'source', ownerUserId: 'owner', origin: 'operations', ...patch,
}) as Parameters<typeof canDevelopContact>[1];

describe('contact detail editing permissions', () => {
  it('allows a global super administrator to edit and follow up another owner contact', () => {
    const admin = actor({ roles: ['admin'], scope: 'shared', capabilities: ['leads.read.all', 'leads.develop'] });
    expect(canDevelopContact(admin, contact())).toBe(true);
  });
  it('retains the development capability and global scope requirement', () => {
    expect(canDevelopContact(actor({ roles: ['admin'], scope: 'shared', capabilities: ['leads.read.all'] }), contact())).toBe(false);
    expect(canDevelopContact(actor({ roles: ['admin'], capabilities: ['leads.read.all', 'leads.develop'] }), contact())).toBe(false);
  });
  it('allows owners and every operations administrator after assignment', () => {
    expect(canDevelopContact(actor(), contact({ ownerUserId: 'actor' }))).toBe(true);
    const manager = actor({ roles: ['operations'], scope: 'shared', capabilities: ['leads.develop', 'leads.assign'] });
    expect(canDevelopContact(manager, contact({ ownerUserId: null, created_by: 'actor' }))).toBe(true);
    expect(canDevelopContact(manager, contact({ created_by: 'actor' }))).toBe(true);
    expect(canDevelopContact(manager, contact({ ownerUserId: null }))).toBe(true);
    expect(canDevelopContact(manager, contact({ origin: 'personal', ownerUserId: 'owner' }))).toBe(false);
  });
  it('never grants ordinary users edit permission for other owners', () => {
    expect(canDevelopContact(actor(), contact())).toBe(false);
    expect(canDevelopContact(actor(), contact({ ownerUserId: null }))).toBe(false);
  });
});
