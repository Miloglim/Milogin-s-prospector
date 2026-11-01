import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { assessLeadIngress, validateLeadIngressDecisionQuery, validateLeadIngressResolution, type LeadIngressCandidateSnapshot, type LeadIngressInput } from '../../server/core/lead-ingress';
import { createLeadIngressHandler } from '../../server/transport/lead-http';
import type { LeadService } from '../../server/services/leads';

const input: LeadIngressInput = {
  source: 'flat_import', sourceChannel: 'synthetic-agent', sourceDetail: 'synthetic', kind: 'operations',
  idempotencyKey: 'synthetic-key', customerKey: 'synthetic-customer',
  company: { name: 'Acme Logistics Ltd', domain: 'acme.example', country: 'Brazil' },
  contacts: [{ email: 'buyer@acme.example', name: 'Buyer' }],
};
const candidate = (patch: Partial<LeadIngressCandidateSnapshot> = {}): LeadIngressCandidateSnapshot => ({
  contactId: 12, customerId: '00000000-0000-4000-8000-000000000012', companyId: 4,
  companyName: 'Acme Logistics', domain: 'acme.example', country: 'Brazil', origin: 'operations',
  ownerUserId: null, createdBy: '00000000-0000-4000-8000-000000000001', customerState: 'published',
  canResolve: true, restorable: true, level: 'exact_email', score: 1, ...patch,
});

describe('lead ingress gateway rules', () => {
  it('treats active and restricted email matches as terminal', () => {
    expect(assessLeadIngress(input, [candidate()])).toMatchObject({ status: 'duplicate', level: 'exact_email' });
    expect(assessLeadIngress(input, [candidate({ canResolve: false })])).toMatchObject({
      status: 'restricted_conflict', level: 'exact_email', candidates: [],
    });
  });

  it('requires a human decision for exact domain and strong fuzzy company matches', () => {
    expect(assessLeadIngress({ ...input, contacts: [{ email: 'other@acme.example' }] }, [candidate({ level: 'exact_domain' })])).toMatchObject({
      status: 'needs_resolution', level: 'exact_domain', suggestedActions: ['create_new', 'attach_company'],
    });
    expect(assessLeadIngress({ ...input, company: { name: 'Acme Global Logistics', country: 'Brazil' }, contacts: [{ email: 'new@other.example' }] }, [candidate({ level: 'strong_company', score: 0.9, domain: 'other.example' })])).toMatchObject({
      status: 'needs_resolution', level: 'strong_company',
    });
  });

  it('allows a different email on the same authorized company without silently merging it', () => {
    const assessment = assessLeadIngress({ ...input, contacts: [{ email: 'second@acme.example' }] }, [candidate({ level: 'exact_company' })]);
    expect(assessment.status).toBe('needs_resolution');
    expect(assessment.suggestedActions).toContain('attach_company');
  });

  it('offers only restore for a permitted soft-deleted contact', () => {
    expect(assessLeadIngress(input, [candidate({ softDeleted: true })])).toMatchObject({
      status: 'restore', suggestedActions: ['restore'],
    });
    expect(assessLeadIngress(input, [candidate({ softDeleted: true, restorable: false })])).toMatchObject({
      status: 'restricted_conflict', candidates: [],
    });
  });

  it('validates terminal resolve and lookup contracts', () => {
    expect(validateLeadIngressResolution({
      decisionId: '00000000-0000-4000-8000-000000000099', action: 'attach_company', expectedVersion: 1, idempotencyKey: 'resolve-key',
    }).ok).toBe(true);
    expect(validateLeadIngressResolution({
      decisionId: 'not-a-uuid', action: 'merge', expectedVersion: 1, idempotencyKey: 'resolve-key',
    })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(validateLeadIngressDecisionQuery('flat_import', 'synthetic-key').ok).toBe(true);
    expect(validateLeadIngressDecisionQuery('manual', '').ok).toBe(false);
  });

  it('exposes HTTP lookup and terminal resolve routes without accepting path/body drift', async () => {
    let resolved = '';
    const service = {
      leadIngressDecision: async () => ({ ok: true, data: { decisionId: 'lookup' } }),
      resolveLeadIngress: async (_token: string, value: { decisionId: string }) => {
        resolved = value.decisionId;
        return { ok: true, data: { customerId: 'customer', companyId: 1, contactIds: [] } };
      },
    } as unknown as LeadService;
    const server = createServer(createLeadIngressHandler(service));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const headers = { authorization: `Bearer ${'a'.repeat(43)}`, 'content-type': 'application/json' };
      const lookup = await (await fetch(`${base}/api/crm/lead-ingress/decision?source=flat_import&idempotencyKey=synthetic-key`, { headers })).json();
      expect(lookup).toMatchObject({ ok: true, data: { decisionId: 'lookup' } });
      const decisionId = '00000000-0000-4000-8000-000000000099';
      const resolve = await (await fetch(`${base}/api/crm/lead-ingress/resolve`, {
        method: 'POST', headers,
        body: JSON.stringify({ decisionId, action: 'create_new', expectedVersion: 1, idempotencyKey: 'resolve-key' }),
      })).json();
      expect(resolve).toMatchObject({ ok: true, data: { customerId: 'customer', companyId: 1 } });
      expect(resolved).toBe(decisionId);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
