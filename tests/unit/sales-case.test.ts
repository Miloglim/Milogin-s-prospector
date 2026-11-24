import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_PROPOSAL_TYPES, canActOnProposal, canTransitionSalesCase, isSalesCaseTerminal, nextSalesCaseAction, proposalActionState, salesCaseStopReason } from '../../server/core/sales-case';
import { canTransitionQuote, mergeQuoteFieldEdit, missingQuoteFields, quoteNeedsRequery } from '../../server/core/quote-case';

describe('AI sales case state machine', () => {
  it('does not pass an unused actor parameter when an admin lists cases', () => {
    const source = readFileSync(join(process.cwd(), 'server/adapters/postgres/sales-case-repository.ts'), 'utf8');
    expect(source).toContain('const limitIndex = admin ? 1 : 2;');
    expect(source).toContain('admin ? [limit, offset]');
  });
  it('keeps lead and outreach transitions explicit', () => {
    expect(canTransitionSalesCase('lead_pending', 'lead_verified')).toBe(true);
    expect(canTransitionSalesCase('lead_verified', 'outreach_running')).toBe(false);
    expect(canTransitionSalesCase('lead_verified', 'outreach_ready')).toBe(true);
    expect(canTransitionSalesCase('outreach_running', 'replied')).toBe(true);
  });
  it('treats replies, bounces and unsubscribes as stop reasons', () => {
    expect(salesCaseStopReason('reply')).toBe('customer_replied');
    expect(salesCaseStopReason('bounce')).toBe('mail_bounced');
    expect(salesCaseStopReason('unsubscribe')).toBe('unsubscribed');
  });
  it('does not continue after terminal states', () => {
    expect(isSalesCaseTerminal('won')).toBe(true);
    expect(isSalesCaseTerminal('lost')).toBe(true);
    expect(canTransitionSalesCase('won', 'outreach_running')).toBe(false);
    expect(nextSalesCaseAction({ state: 'inquiry_detected', nextAction: null })).toBe('提取运输需求');
  });
  it('supports applied deal-won proposals and cancellation', () => {
    expect(AI_PROPOSAL_TYPES).toContain('deal_won');
    expect(canActOnProposal('applied_pending_confirmation')).toBe(true);
    expect(proposalActionState('cancel')).toBe('cancelled');
  });
});

describe('quote case workflow', () => {
  it('requires route fields before automatic query', () => {
    expect(missingQuoteFields({})).toEqual(['pol', 'pod']);
    expect(missingQuoteFields({ pol: { value: 'Qingdao', source: 'email', evidence: [], confidence: 1, resolver: 'ports' } })).toEqual(['pod']);
  });
  it('marks operational field edits as user feedback and requery triggers', () => {
    const previous = { pol: { value: 'Qingdao', source: 'email' as const, evidence: [], confidence: 1, resolver: 'ports' } };
    const next = mergeQuoteFieldEdit(previous, 'containerTypes', ['40NOR']);
    expect(next.containerTypes?.source).toBe('user');
    expect(quoteNeedsRequery(previous, next)).toBe(true);
  });
  it('enforces quote review and send ordering', () => {
    expect(canTransitionQuote('draft_ready', 'review_pending')).toBe(true);
    expect(canTransitionQuote('review_pending', 'sent')).toBe(false);
    expect(canTransitionQuote('review_pending', 'approved')).toBe(true);
    expect(canTransitionQuote('approved', 'sent')).toBe(true);
  });
});
