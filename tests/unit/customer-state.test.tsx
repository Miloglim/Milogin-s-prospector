import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { customerJourneyView } from '../../server/core/customer-state';
import { CustomerStateChain } from '../../src/renderer/pages/customers/CustomerStateChain';

describe('customer journey state chain', () => {
  it('uses AI pending confirmation before every older relationship signal', () => {
    const view = customerJourneyView({ relationshipStage: 'quoting', touchStatuses: ['replied'], aiDealPending: true });
    expect(view.state).toBe('won_pending');
    expect(view.source).toBe('AI 识别');
    expect(view.steps.find(step => step.key === 'won_pending')?.status).toBe('current');
  });

  it('maps replies, quoting, trial, cooperation and loss consistently', () => {
    expect(customerJourneyView({ touchStatuses: ['replied'] }).state).toBe('replied');
    expect(customerJourneyView({ relationshipStage: 'quoting' }).state).toBe('quoting');
    expect(customerJourneyView({ relationshipStage: 'trial' }).state).toBe('negotiating');
    expect(customerJourneyView({ relationshipStage: 'cooperating' }).state).toBe('won');
    expect(customerJourneyView({ relationshipStage: 'lost' }).lost).toBe(true);
    expect(customerJourneyView({ touchStatuses: ['bounced'] }).state).toBe('uncontacted');
  });

  it('renders the chain with the current label', () => {
    const html = renderToStaticMarkup(<CustomerStateChain facts={{ relationshipStage: 'quoting', aiDealPending: false }} compact />);
    expect(html).toContain('客户状态');
    expect(html).toContain('询价/报价');
    expect(html).toContain('is-current');
    expect(html).toContain('aria-current="step"');
  });

  it('exposes correction and history actions when a center customer is available', () => {
    const html = renderToStaticMarkup(<CustomerStateChain customerId="34a47fcb-4ffe-4add-bfaf-c8cc35cff890" facts={{ relationshipStage: 'quoting' }} compact />);
    expect(html).toContain('纠正客户状态');
    expect(html).toContain('查看客户状态记录');
  });
});
