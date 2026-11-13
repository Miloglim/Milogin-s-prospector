import { describe, expect, it } from 'vitest';
import { failResult, okResult } from '../../src/main/errors';
import type { ContactMailEventReceipt } from '../../server/core/contact-mail';
import {
  AI_MAIL_ANALYZER_VERSION,
  createMailAnalysisAnalyzer,
  draftFromModelOutput,
} from '../../src/main/services/mail-analysis-analyzer.service';
import type { MailAnalysisQueueInput } from '../../src/main/services/mail-analysis-queue.service';

function input(): MailAnalysisQueueInput {
  const event = {
    eventId: 'evt-1', actorId: 'user-1', contactId: 1, customerId: '00000000-0000-4000-8000-000000000001',
    eventKey: 'event-key', mailboxKey: 'mailbox', messageKey: 'message', kind: 'replied', direction: 'inbound',
    occurredAt: '2026-01-01T00:00:00.000Z', subject: 'Re: Quotation request', preview: 'Please quote FOB Shanghai to Rotterdam.',
    fromEmail: 'buyer@customer.test', toEmails: ['sales@agency.test'], ccEmails: [], recordedAt: '2026-01-01T00:00:01.000Z',
    activityId: 'activity', contentHash: 'a'.repeat(64),
  } satisfies ContactMailEventReceipt['event'];
  const analysis = {
    analysisId: '00000000-0000-4000-8000-000000000002', actorId: 'user-1', eventId: event.eventId,
    contactId: 1, customerId: event.customerId, mailboxKey: event.mailboxKey, messageKey: event.messageKey,
    contentHash: event.contentHash, threadKey: 'quotation request', analyzerVersion: 'mechanical-v1', inputSequence: 10,
    source: 'rule', relevance: 'customer_business', classification: 'replied', contactState: 'replied',
    summary: 'Quotation request', signals: [], requiresAction: false, nextAction: null, priority: 'normal', dueHint: null,
    confidence: 0.99, evidence: [], humanLocked: false, supersedesId: null, isCurrent: true, createdAt: event.recordedAt,
  } satisfies ContactMailEventReceipt['analysis'];
  return { event, analysis, contactState: 'replied' };
}

describe('AI mail analysis adapter', () => {
  it('maps a structured model response into the existing analysis contract', () => {
    const draft = draftFromModelOutput({
      summary: '客户要求上海到鹿特丹的 FOB 报价',
      signals: [{ code: 'quote_request', label: '报价请求', confidence: 0.93, evidence: 'Please quote FOB Shanghai' }],
      requiresAction: true,
      nextAction: '回复客户报价',
      priority: 'important',
      dueHint: '24小时内',
      confidence: 0.93,
      evidence: ['Please quote FOB Shanghai'],
    }, input());

    expect(draft).toMatchObject({
      classification: 'replied',
      relevance: 'customer_business',
      actionability: { requiresAction: true, nextAction: '回复客户报价', priority: 'important', dueHint: '24小时内' },
      confidence: 0.93,
      analyzerVersion: AI_MAIL_ANALYZER_VERSION,
    });
  });

  it('clears action fields when the model says no action is needed', () => {
    const draft = draftFromModelOutput({
      summary: '客户仅确认收到', signals: [], requiresAction: false,
      nextAction: '不应保留', priority: 'urgent', dueHint: '今天', confidence: 0.8, evidence: [],
    }, input());
    expect(draft.actionability).toEqual({ requiresAction: false, nextAction: null, priority: 'normal', dueHint: null });
  });

  it('falls back to a safe next action when the model asks for action without one', () => {
    const draft = draftFromModelOutput({
      summary: '客户提出投诉', signals: [{ code: 'complaint', label: '投诉', confidence: 0.9, evidence: 'complaint' }],
      requiresAction: true, nextAction: '', priority: 'urgent', confidence: 0.9, evidence: [],
    }, input());
    expect(draft.actionability.nextAction).toBe('优先处理客户问题');
  });

  it('rejects a non-object model response and surfaces model failures', async () => {
    expect(() => draftFromModelOutput('not json', input())).toThrow('AI 邮件分析返回不是对象');
    const analyzer = createMailAnalysisAnalyzer({
      analyzeJson: async () => failResult('模型端点未配置'),
    });
    await expect(analyzer.analyze(input(), new AbortController().signal)).rejects.toThrow('模型端点未配置');
  });

  it('passes through a valid model result through the analyzer port', async () => {
    const analyzer = createMailAnalysisAnalyzer({
      analyzeJson: async () => okResult({
        summary: '客户询价', signals: [{ code: 'price_inquiry', label: '询价', confidence: 0.88, evidence: 'price' }],
        requiresAction: true, nextAction: '回复询价', priority: 'normal', confidence: 0.88, evidence: ['price'],
      }),
    });
    await expect(analyzer.analyze(input(), new AbortController().signal)).resolves.toMatchObject({
      relevance: 'customer_business', actionability: { requiresAction: true, nextAction: '回复询价' },
    });
  });
});
