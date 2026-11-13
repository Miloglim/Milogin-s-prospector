import { describe, expect, it } from 'vitest';
import { classifyInboxByRule } from '../../src/main/core/inbox-analysis-rules';

const base = {
  fromEmail: 'buyer@customer.test',
  subject: 'RFQ Shanghai to Rotterdam',
  bodyPreview: 'Please quote 2x40HQ.',
  classification: 'replied',
};

describe('inbox deterministic classification rules', () => {
  it('keeps bounce handling actionable without calling the model', () => {
    expect(classifyInboxByRule({ ...base, classification: 'bounce', subject: 'Delivery failed' })).toMatchObject({
      category: 'notification', priority: 'important', requiresAction: true, source: 'rule',
    });
  });

  it('routes newsletters to marketing instead of sending them to AI', () => {
    expect(classifyInboxByRule({
      ...base,
      fromEmail: 'newsletter@vendor.test',
      subject: 'Weekly market newsletter',
      bodyPreview: 'Unsubscribe from this list.',
    })).toMatchObject({ category: 'marketing', requiresAction: false });
  });

  it('recognizes verification notices as no-action notifications', () => {
    expect(classifyInboxByRule({
      ...base,
      fromEmail: 'no-reply@service.test',
      subject: '登录验证码',
      bodyPreview: '验证码 583921，10 分钟内有效。',
    })).toMatchObject({ category: 'notification', priority: 'important', requiresAction: false });
  });

  it('makes overdue invoices actionable while receipts stay informational', () => {
    expect(classifyInboxByRule({
      ...base,
      fromEmail: 'billing@vendor.test',
      subject: 'Invoice overdue',
      bodyPreview: 'Payment due today.',
    })).toMatchObject({ category: 'invoice', requiresAction: true, priority: 'important' });
    expect(classifyInboxByRule({
      ...base,
      fromEmail: 'receipts@vendor.test',
      subject: 'Payment received',
      bodyPreview: 'Your receipt is attached.',
    })).toMatchObject({ category: 'invoice', requiresAction: false });
  });

  it('classifies same-domain periodic rate updates without treating them as customer inquiries', () => {
    expect(classifyInboxByRule({
      ...base,
      fromEmail: 'katey_huang@yqn.com',
      senderIsInternal: true,
      subject: '阳明海运更新WCSA的FAK运价，有效期2026年11月13日至17日',
      bodyPreview: '新增Caldera为POD。',
    })).toMatchObject({ category: 'rate_update', requiresAction: false, priority: 'normal', source: 'rule' });
  });

  it('still leaves an explicit internal action request for the AI analyzer', () => {
    expect(classifyInboxByRule({
      ...base,
      fromEmail: 'colleague@yqn.com',
      senderIsInternal: true,
      subject: '请确认客户运价',
      bodyPreview: 'Please confirm the customer quote today.',
    })).toBeNull();
  });

  it('leaves customer inquiry mail for the AI analyzer', () => {
    expect(classifyInboxByRule(base)).toBeNull();
  });
});
