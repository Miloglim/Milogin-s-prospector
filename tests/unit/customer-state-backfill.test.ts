import { describe, expect, it } from 'vitest';
import { planCustomerStatusBackfill } from '../../server/core/customer-state-backfill';

const signal = (key: string, occurredAt: string, proposedStatus: 'contacted' | 'replied' | 'quoting' | 'won_pending' | 'won' | 'lost', allowRegression = false) => ({
  key, occurredAt, proposedStatus, source: 'activity' as const, sourceId: key, evidence: [], payload: {}, allowRegression,
});

describe('customer status backfill plan', () => {
  it('orders historical signals and ignores automatic regressions', () => {
    const plan = planCustomerStatusBackfill([
      signal('reply', '2026-01-02T00:00:00.000Z', 'replied'),
      signal('send', '2026-01-01T00:00:00.000Z', 'contacted'),
      signal('bounce-like-old-status', '2026-01-03T00:00:00.000Z', 'contacted'),
      signal('quote', '2026-01-04T00:00:00.000Z', 'quoting'),
    ]);
    expect(plan.events.map(event => event.status)).toEqual(['contacted', 'replied', 'quoting']);
    expect(plan.finalStatus).toBe('quoting');
    expect(plan.skipped).toBe(1);
  });

  it('allows an explicit correction signal to move backward', () => {
    const plan = planCustomerStatusBackfill([
      signal('pending', '2026-01-01T00:00:00.000Z', 'won_pending'),
      signal('cancel', '2026-01-02T00:00:00.000Z', 'replied', true),
    ]);
    expect(plan.events.map(event => [event.previousStatus, event.status])).toEqual([['uncontacted', 'won_pending'], ['won_pending', 'replied']]);
    expect(plan.finalStatus).toBe('replied');
  });
});
