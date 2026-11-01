import { describe, expect, it } from 'vitest';
import type { ContactMailEventReceipt } from '../../server/core/contact-mail';
import type { ContactMailAnalysisSubmission, MailAnalysisResult } from '../../server/core/mail-analysis';
import { contactMailAnalysisCorrection, contactMailAnalysisSubmission } from '../../server/services/contact-mail-analysis';
import { createMailAnalysisQueueService, type MailAnalysisDraft, type MailAnalysisQueueInput } from '../../src/main/services/mail-analysis-queue.service';

function queueInput(): MailAnalysisQueueInput {
  const event = {
    eventId: 'evt-1', actorId: 'user-1', contactId: 1, customerId: '00000000-0000-4000-8000-000000000001',
    eventKey: 'event-key', mailboxKey: 'mailbox', messageKey: 'message', kind: 'replied', direction: 'inbound',
    occurredAt: '2026-01-01T00:00:00.000Z', subject: 'Re: Quotation request', preview: 'Please quote',
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

function draft(version = 'ai-v1'): MailAnalysisDraft {
  return {
    classification: 'replied', relevance: 'customer_business', summary: '客户要求报价',
    signals: [{ code: 'quote_request', label: '报价请求', confidence: 0.93, evidence: 'quote' }],
    actionability: { requiresAction: true, nextAction: '回复客户询价', priority: 'important', dueHint: '24 小时内' },
    confidence: 0.93, evidence: ['quote'], analyzerVersion: version,
  } satisfies Omit<MailAnalysisResult, 'source' | 'contactState'>;
}

describe('contact mail analysis contracts and queue', () => {
  it('reports a disabled queue without external AI', () => {
    const queue = createMailAnalysisQueueService();
    expect(queue.status()).toMatchObject({ enabled: false, pending: 0, running: 0, failed: 0 });
    expect(queue.enqueue(queueInput(), async () => ({ ok: true }))).toBe(false);
  });

  it('deduplicates enqueue and submits one stable AI revision', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let calls = 0;
    const submitted: ContactMailAnalysisSubmission[] = [];
    const queue = createMailAnalysisQueueService({ analyzer: { analyze: async () => { calls++; await gate; return draft(); } } });
    const input = queueInput();
    const submit = async (value: ContactMailAnalysisSubmission) => { submitted.push(value); return { ok: true as const }; };
    expect(queue.enqueue(input, submit)).toBe(true);
    expect(queue.enqueue(input, submit)).toBe(false);
    release();
    await queue.waitForIdle();
    expect(calls).toBe(1);
    expect(submitted).toHaveLength(1);
    expect(queue.enqueue(input, submit)).toBe(false);
    expect(submitted[0]).toMatchObject({ contentHash: input.event.contentHash, idempotencyKey: `ai:ai-v1:${input.event.contentHash}:10`, result: { analyzerVersion: 'ai-v1' } });
    expect(queue.status()).toMatchObject({ completed: 1, failed: 0 });
  });

  it('retries failures and surfaces timeout without blocking the mail event', async () => {
    let attempts = 0;
    const retryQueue = createMailAnalysisQueueService({
      timeoutMs: 200,
      maxAttempts: 3,
      retryDelayMs: 1,
      analyzer: { analyze: async () => { attempts++; if (attempts < 3) throw new Error('temporary'); return draft('ai-v2'); } },
    });
    expect(retryQueue.enqueue(queueInput(), async () => ({ ok: true }))).toBe(true);
    await retryQueue.waitForIdle();
    expect(attempts).toBe(3);
    expect(retryQueue.status()).toMatchObject({ completed: 1, failed: 0 });

    const timeoutQueue = createMailAnalysisQueueService({
      timeoutMs: 10,
      maxAttempts: 2,
      retryDelayMs: 1,
      analyzer: { analyze: async () => new Promise<MailAnalysisDraft>(() => {}) },
    });
    expect(timeoutQueue.enqueue(queueInput(), async () => ({ ok: true }))).toBe(true);
    await timeoutQueue.waitForIdle();
    expect(timeoutQueue.status()).toMatchObject({ completed: 0, failed: 1, lastError: 'AI 分析超时' });
  });

  it('rejects raw body and attachment fields at the center contract', () => {
    const input = queueInput();
    const ai = {
      contactId: input.analysis.contactId, customerId: input.analysis.customerId, mailboxKey: input.analysis.mailboxKey,
      messageKey: input.analysis.messageKey, contentHash: input.analysis.contentHash, inputSequence: 11,
      idempotencyKey: 'ai-1', result: draft(), rawBody: 'must never leave local storage',
    };
    expect(contactMailAnalysisSubmission(ai)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const correction = {
      ...input.analysis, expectedCurrentId: input.analysis.analysisId, idempotencyKey: 'human-1',
      requiresAction: true, nextAction: '回复客户', attachments: [{ name: 'quote.pdf' }],
    };
    expect(contactMailAnalysisCorrection(correction)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
  });
});
