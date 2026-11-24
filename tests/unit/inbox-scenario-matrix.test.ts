import { describe, expect, it } from 'vitest';
import { classifyInboxByRule } from '../../src/main/core/inbox-analysis-rules';
import { mockInboxAnalysis } from '../../src/main/core/inbox-analysis-mock';
import { inboxAnalysisAdmitsAttention, inboxAnalysisAdmitsTodo, type InboxAnalysisView } from '../../src/shared/inbox';

interface Scenario {
  key: string;
  fromEmail: string;
  subject: string;
  preview: string;
  classification: string;
  myRole?: string;
  internal?: boolean;
  ccOnly?: boolean;
  expectedSource: 'rule' | 'ai';
  expectedCategory: string;
  todo: boolean;
  attention: boolean;
}

const SCENARIOS: Scenario[] = [
  { key: 'quote_request', fromEmail: 'buyer@customer.test', subject: '[MOCK:quote_request] RFQ', preview: 'Please quote Shanghai to Rotterdam.', classification: 'replied', expectedSource: 'ai', expectedCategory: 'quote_request', todo: true, attention: false },
  { key: 'schedule_request', fromEmail: 'buyer@customer.test', subject: '[MOCK:schedule_request] Sailing', preview: 'Please confirm the sailing and cut-off.', classification: 'replied', expectedSource: 'ai', expectedCategory: 'schedule_request', todo: true, attention: false },
  { key: 'order_followup', fromEmail: 'buyer@customer.test', subject: '[MOCK:order_followup] Update', preview: 'Any update on our booking?', classification: 'replied', expectedSource: 'ai', expectedCategory: 'order_followup', todo: true, attention: false },
  { key: 'complaint', fromEmail: 'buyer@customer.test', subject: '[MOCK:complaint] Delay', preview: 'We were not informed about the delay.', classification: 'replied', expectedSource: 'ai', expectedCategory: 'complaint', todo: true, attention: false },
  { key: 'cooperation', fromEmail: 'buyer@customer.test', subject: '[MOCK:cooperation] Partnership', preview: 'We would like to explore cooperation.', classification: 'replied', expectedSource: 'ai', expectedCategory: 'cooperation', todo: true, attention: false },
  { key: 'reply_needed', fromEmail: 'buyer@customer.test', subject: '[MOCK:reply_needed] Question', preview: 'Could you clarify this point?', classification: 'replied', expectedSource: 'ai', expectedCategory: 'reply_needed', todo: false, attention: true },
  { key: 'internal_request', fromEmail: 'colleague@yqn.com', subject: '[MOCK:internal_request] 请确认客户运价', preview: '请确认客户运价后再回复我。', classification: 'replied', internal: true, expectedSource: 'ai', expectedCategory: 'reply_needed', todo: false, attention: true },
  { key: 'rate_update', fromEmail: 'rate.desk@yqn.com', subject: '[MOCK:rate_update] 运价更新', preview: '阳明海运更新 WCSA FAK 运价，有效期至 11 月 17 日。', classification: 'replied', internal: true, expectedSource: 'rule', expectedCategory: 'rate_update', todo: false, attention: false },
  { key: 'marketing', fromEmail: 'newsletter@vendor.test', subject: '[MOCK:marketing] Newsletter', preview: 'Weekly update. Unsubscribe from this list.', classification: 'other', expectedSource: 'rule', expectedCategory: 'marketing', todo: false, attention: false },
  { key: 'invoice', fromEmail: 'billing@vendor.test', subject: '[MOCK:invoice] Invoice overdue', preview: 'Invoice INV-1 is overdue. Payment due today.', classification: 'other', expectedSource: 'rule', expectedCategory: 'invoice', todo: false, attention: true },
  { key: 'bounce', fromEmail: 'mailer-daemon@vendor.test', subject: '[MOCK:bounce] Delivery failed', preview: 'The recipient address was rejected.', classification: 'bounce', expectedSource: 'rule', expectedCategory: 'notification', todo: false, attention: true },
  { key: 'autoreply', fromEmail: 'auto-reply@customer.test', subject: '[MOCK:autoreply] Out of office', preview: 'This is an automated out-of-office response.', classification: 'autoreply', expectedSource: 'rule', expectedCategory: 'notification', todo: false, attention: false },
  { key: 'cc_only', fromEmail: 'buyer@customer.test', subject: '[MOCK:cc_only] Copy', preview: 'You are copied for reference only.', classification: 'replied', ccOnly: true, myRole: 'cc', expectedSource: 'rule', expectedCategory: 'other', todo: false, attention: false },
  { key: 'ambiguous', fromEmail: 'buyer@customer.test', subject: '[MOCK:ambiguous] Quick question', preview: 'Let us know what you think.', classification: 'replied', expectedSource: 'ai', expectedCategory: 'other', todo: false, attention: false },
];

function analyze(scenario: Scenario): { source: 'rule' | 'ai'; view: InboxAnalysisView } {
  const input = {
    fromEmail: scenario.fromEmail,
    subject: scenario.subject,
    bodyPreview: scenario.preview,
    classification: scenario.classification,
    senderIsInternal: scenario.internal,
    isCcOnly: scenario.ccOnly,
  };
  const rule = classifyInboxByRule(input);
  const draft = rule ?? { ...mockInboxAnalysis(scenario.subject), source: 'ai' as const };
  return {
    source: rule ? 'rule' : 'ai',
    view: {
      messageId: 1,
      category: draft.category,
      priority: draft.priority,
      requiresAction: draft.requiresAction,
      summary: draft.summary,
      nextAction: draft.nextAction,
      dueHint: draft.dueHint,
      confidence: draft.confidence,
      evidence: draft.evidence,
      source: rule ? 'rule' : 'ai',
      analyzerVersion: 'test',
      status: 'ready',
      error: null,
      updatedAt: '2026-11-23T00:00:00.000Z',
    },
  };
}

describe('inbox scenario matrix', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.key} routes to the expected inbox bucket`, () => {
      const { source, view } = analyze(scenario);
      const admission = { internal: Boolean(scenario.internal), ccOnly: Boolean(scenario.ccOnly) };
      expect(source).toBe(scenario.expectedSource);
      expect(view.category).toBe(scenario.expectedCategory);
      expect(inboxAnalysisAdmitsTodo(view, admission)).toBe(scenario.todo);
      expect(inboxAnalysisAdmitsAttention(view, admission)).toBe(scenario.attention);
    });
  }
});
