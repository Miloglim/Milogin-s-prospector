import { describe, expect, it } from 'vitest';
import {
  actionabilityFor,
  mailRelevanceFor,
  mailThreadKey,
  mechanicalMailAnalysis,
  newerAnalysisWins,
  shouldCreateTaskSuggestion,
  taskSuggestionKey,
  touchesContactFacts,
} from '../../server/core/mail-analysis';

describe('mail business analysis', () => {
  it('keeps unrelated mail out of customer facts and tasks', () => {
    const relevance = mailRelevanceFor({ classification: 'other', matchedContact: false, internal: false });
    const actionability = actionabilityFor({ relevance, classification: 'other', intent: null, confidence: 1 });
    expect(relevance).toBe('unknown');
    expect(actionability.requiresAction).toBe(false);
    expect(shouldCreateTaskSuggestion({ relevance, actionability, confidence: 1, source: 'rule' })).toBe(false);
    expect(touchesContactFacts('other')).toBe(false);
  });

  it('creates a task suggestion only for strong customer business actions', () => {
    const relevance = mailRelevanceFor({ classification: 'replied', matchedContact: true, internal: false });
    const actionability = actionabilityFor({ relevance, classification: 'replied', intent: 'quote_request', confidence: 0.91 });
    expect(actionability).toMatchObject({ requiresAction: true, nextAction: '回复客户询价', priority: 'important' });
    expect(shouldCreateTaskSuggestion({ relevance, actionability, confidence: 0.91, source: 'ai' })).toBe(true);
    expect(touchesContactFacts('replied')).toBe(true);
  });

  it('does not turn a plain reply, automatic reply, or vendor mail into a task', () => {
    for (const intent of [null, 'no_action', 'other'] as const) {
      const actionability = actionabilityFor({ relevance: 'customer_business', classification: 'replied', intent, confidence: 0.99 });
      expect(actionability.requiresAction).toBe(false);
      expect(shouldCreateTaskSuggestion({ relevance: 'customer_business', actionability, confidence: 0.99, source: 'rule' })).toBe(false);
    }
    const automatic = actionabilityFor({ relevance: 'customer_business', classification: 'autoreply', intent: 'quote_request', confidence: 0.99 });
    expect(automatic.requiresAction).toBe(false);
    const vendor = actionabilityFor({ relevance: 'vendor', classification: 'replied', intent: 'quote_request', confidence: 0.99 });
    expect(vendor.requiresAction).toBe(false);
  });

  it('maps sent, personal reply, bounce and autoreply to distinct contact facts', () => {
    expect(mechanicalMailAnalysis({ kind: 'sent', direction: 'outbound', subject: 'Hello', preview: '', fromEmail: 'sales@agency.test', toEmails: ['buyer@customer.test'], ccEmails: [], matchedContact: true, primaryEmail: 'buyer@customer.test', internal: false })).toMatchObject({ contactState: 'contacted', relevance: 'customer_business' });
    expect(mechanicalMailAnalysis({ kind: 'sent', direction: 'outbound', subject: 'Quotation for your review', preview: 'Please see our quote', fromEmail: 'sales@agency.test', toEmails: ['buyer@customer.test'], ccEmails: [], matchedContact: true, primaryEmail: 'buyer@customer.test', internal: false })).toMatchObject({ contactState: 'contacted', actionability: { requiresAction: false } });
    expect(mechanicalMailAnalysis({ kind: 'replied', direction: 'inbound', subject: 'Re: quotation', preview: 'Please quote 2 containers', fromEmail: 'buyer@customer.test', toEmails: ['sales@agency.test'], ccEmails: [], matchedContact: true, primaryEmail: 'buyer@customer.test', internal: false })).toMatchObject({ contactState: 'replied', signals: [{ code: 'quote_request' }], actionability: { requiresAction: true } });
    expect(mechanicalMailAnalysis({ kind: 'bounced', direction: 'inbound', subject: 'Delivery status notification', preview: 'mailbox unavailable', fromEmail: 'mailer-daemon@customer.test', toEmails: ['sales@agency.test'], ccEmails: [], matchedContact: true, primaryEmail: 'buyer@customer.test', internal: false })).toMatchObject({ contactState: 'bounced', classification: 'bounced' });
    expect(mechanicalMailAnalysis({ kind: 'autoreply', direction: 'inbound', subject: 'Out of office', preview: '', fromEmail: 'buyer@customer.test', toEmails: ['sales@agency.test'], ccEmails: [], matchedContact: true, primaryEmail: 'buyer@customer.test', internal: false })).toMatchObject({ contactState: 'autoreply', actionability: { requiresAction: false } });
  });

  it('deduplicates the same thread action while treating Re/Fwd prefixes as one thread', () => {
    expect(mailThreadKey('Re: Fwd: Quotation request', 'm1')).toBe('quotation request');
    const left = taskSuggestionKey({ actorId: 'u1', contactId: 1, threadKey: mailThreadKey('Quotation request', 'm1'), actionCode: 'quote_request' });
    const right = taskSuggestionKey({ actorId: 'u1', contactId: 1, threadKey: mailThreadKey('Re: Quotation request', 'm2'), actionCode: 'quote_request' });
    expect(left).toBe(right);
  });

  it('lets human conclusions win and keeps out-of-order AI revisions in history', () => {
    expect(newerAnalysisWins({ source: 'ai', inputSequence: 20, analyzerVersion: 'ai-v2' }, { source: 'rule', inputSequence: 10, analyzerVersion: 'mechanical-v1', humanLocked: false })).toBe(true);
    expect(newerAnalysisWins({ source: 'ai', inputSequence: 5, analyzerVersion: 'ai-v3' }, { source: 'ai', inputSequence: 10, analyzerVersion: 'ai-v2', humanLocked: false })).toBe(false);
    expect(newerAnalysisWins({ source: 'human', inputSequence: 1, analyzerVersion: 'human-v1' }, { source: 'ai', inputSequence: 99, analyzerVersion: 'ai-v3', humanLocked: false })).toBe(true);
    expect(newerAnalysisWins({ source: 'ai', inputSequence: 100, analyzerVersion: 'ai-v4' }, { source: 'human', inputSequence: 1, analyzerVersion: 'human-v1', humanLocked: true })).toBe(false);
  });
});
