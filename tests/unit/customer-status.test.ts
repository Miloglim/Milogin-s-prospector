import { describe, expect, it } from 'vitest';
import { customerStatusChange } from '../../server/core/customer-status';
import { customerJourneyView } from '../../server/core/customer-state';

describe('customer status command', () => {
  it('advances touch signals without regressing relationship evidence', () => {
    expect(customerStatusChange({ touchStatuses: ['uncontacted'], nextTouchStatus: 'contacted' })).toMatchObject({ before: 'uncontacted', after: 'contacted', changed: true });
    expect(customerStatusChange({ touchStatuses: ['contacted'], nextTouchStatus: 'replied' })).toMatchObject({ before: 'contacted', after: 'replied', changed: true });
    expect(customerStatusChange({ relationshipStage: 'quoting', touchStatuses: ['contacted'], nextTouchStatus: 'replied' })).toMatchObject({ before: 'quoting', after: 'quoting', changed: false });
  });

  it('keeps quote, trial, won, lost and AI pending precedence', () => {
    expect(customerStatusChange({ relationshipStage: 'reaching', nextRelationshipStage: 'quoting' })).toMatchObject({ after: 'quoting', changed: true });
    expect(customerStatusChange({ relationshipStage: 'quoting', nextRelationshipStage: 'trial' })).toMatchObject({ after: 'negotiating', changed: true });
    expect(customerStatusChange({ relationshipStage: 'trial', nextRelationshipStage: 'cooperating' })).toMatchObject({ after: 'won', changed: true });
    expect(customerStatusChange({ relationshipStage: 'quoting', nextRelationshipStage: 'lost' })).toMatchObject({ after: 'lost', changed: true });
    expect(customerStatusChange({ relationshipStage: 'quoting', aiDealPending: true, nextTouchStatus: 'replied' })).toMatchObject({ before: 'won_pending', after: 'won_pending', changed: false });
  });

  it('does not treat a bounce as a successful touch', () => {
    expect(customerStatusChange({ touchStatuses: ['uncontacted'], nextTouchStatus: 'bounced' })).toMatchObject({ before: 'uncontacted', after: 'uncontacted', changed: false });
    expect(customerStatusChange({ touchStatuses: ['replied'], nextTouchStatus: 'bounced' })).toMatchObject({ before: 'replied', after: 'replied', changed: false });
  });

  it('lets the unified status projection override compatibility fields', () => {
    expect(customerJourneyView({ status: 'won_pending', relationshipStage: 'quoting', sourceLabel: '状态账本' })).toMatchObject({ state: 'won_pending', source: '状态账本' });
  });
});
