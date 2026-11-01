import { describe, expect, it, vi } from 'vitest';
import { success } from '../../server/core/crm';
import {
  canTransitionTeamAttention,
  mailTaskAdmissionFor,
  type TeamAttentionRepository,
} from '../../server/core/team-attention';
import { createTeamAttentionService } from '../../server/services/team-attention';

const base = {
  relevance: 'customer_business' as const,
  classification: 'replied' as const,
  source: 'ai' as const,
  confidence: 0.94,
  requiresAction: true,
  nextAction: '回复客户询价',
  signals: [{ code: 'quote_request' as const, confidence: 0.94 }],
};

describe('CP5 mail task admission', () => {
  it('auto-creates only fixed strong actions', () => {
    expect(mailTaskAdmissionFor(base)).toBe('create');
    expect(mailTaskAdmissionFor({ ...base, signals: [{ code: 'complaint', confidence: 0.91 }] })).toBe('create');
    expect(mailTaskAdmissionFor({ ...base, signals: [{ code: 'schedule_request', confidence: 0.94 }] })).toBe('suggest');
    expect(mailTaskAdmissionFor({ ...base, confidence: 0.7, signals: [{ code: 'quote_request', confidence: 0.7 }] })).toBe('suggest');
  });

  it('keeps human confirmation and bounce correction explicit', () => {
    expect(mailTaskAdmissionFor({ ...base, source: 'human', confidence: 1 })).toBe('create');
    expect(mailTaskAdmissionFor({ ...base, classification: 'bounced', confidence: 0.9, signals: [] })).toBe('create');
  });

  it('never creates tasks for no-action or unrelated mail', () => {
    expect(mailTaskAdmissionFor({ ...base, requiresAction: false, nextAction: null, signals: [] })).toBe('none');
    expect(mailTaskAdmissionFor({ ...base, relevance: 'vendor' })).toBe('none');
    expect(mailTaskAdmissionFor({ ...base, relevance: 'internal' })).toBe('none');
  });
});

describe('CP5 attention state machine and service validation', () => {
  const repo = {
    list: vi.fn(async () => success({ scope: 'member' as const, items: [], total: 0, counts: { open: 0, acknowledged: 0, resolved: 0, dismissed: 0 } })),
    create: vi.fn(),
    transition: vi.fn(async () => success({} as never)),
  } satisfies TeamAttentionRepository;
  const tokens = { hash: (token: string) => createHash(token), create: () => '' };
  const service = createTeamAttentionService(repo, tokens);

  it('allows acknowledge from open and resolve before a terminal state', () => {
    expect(canTransitionTeamAttention('open', 'acknowledge')).toBe(true);
    expect(canTransitionTeamAttention('acknowledged', 'resolve')).toBe(true);
    expect(canTransitionTeamAttention('open', 'resolve')).toBe(true);
    expect(canTransitionTeamAttention('resolved', 'dismiss')).toBe(false);
    expect(canTransitionTeamAttention('dismissed', 'acknowledge')).toBe(false);
  });

  it('rejects malformed pagination and resolve without a result', async () => {
    expect(await service.list('x'.repeat(43), { limit: 0, offset: 0 })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    const id = '00000000-0000-4000-8000-000000000001';
    expect(await service.transition('x'.repeat(43), id, 'resolve', { action: 'resolve', expectedVersion: 1, idempotencyKey: 'resolve-1' })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });
});

function createHash(value: string): string {
  return value.padEnd(64, '0').slice(0, 64);
}
