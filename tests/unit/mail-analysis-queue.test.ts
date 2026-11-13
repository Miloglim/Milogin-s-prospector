import { describe, expect, it, vi } from 'vitest';
import {
  createMailAnalysisQueueService,
  type MailAnalysisQueueInput,
  type MailAnalysisQueueStore,
  type MailAnalysisQueueStoredJob,
} from '../../src/main/services/mail-analysis-queue.service';

function input(): MailAnalysisQueueInput {
  return {
    event: {
      eventId: 'event-1', contactId: 7, customerId: 'customer-1', mailboxKey: 'buyer@example.test',
      messageKey: 'message-1', kind: 'replied', direction: 'inbound', occurredAt: '2026-11-10T00:00:00Z',
      subject: 'Quote', preview: 'Please quote Shanghai to Rotterdam', fromEmail: 'buyer@example.test',
      toEmails: ['sales@example.test'], ccEmails: [], digest: 'digest-1', contentHash: 'hash-1',
    },
    analysis: {
      eventId: 'event-1', contactId: 7, customerId: 'customer-1', mailboxKey: 'buyer@example.test',
      messageKey: 'message-1', contentHash: 'hash-1', inputSequence: 1, source: 'rule', relevance: 'customer_business',
      classification: 'replied', contactState: 'replied', summary: 'Quote request', signals: [],
      requiresAction: true, nextAction: 'Reply with quote', priority: 'important', dueHint: null,
      confidence: 0.8, evidence: [], humanLocked: false, analyzerVersion: 'fixture', createdAt: '2026-11-10T00:00:00Z',
    },
    contactState: 'replied',
  } as unknown as MailAnalysisQueueInput;
}

function memoryStore(jobs = new Map<string, MailAnalysisQueueStoredJob>()): MailAnalysisQueueStore & { jobs: typeof jobs } {
  return {
    jobs,
    save(job) { jobs.set(job.key, { ...job, input: structuredClone(job.input) }); },
    recoverable() { return [...jobs.values()].filter(job => job.status === 'pending' || job.status === 'retrying' || job.status === 'running'); },
    prune() {},
  };
}

const draft = {
  classification: 'replied' as const,
  relevance: 'customer_business' as const,
  summary: '客户询价',
  signals: [],
  actionability: { requiresAction: true, nextAction: '回复报价', priority: 'important' as const, dueHint: null },
  confidence: 0.9,
  evidence: ['Please quote'],
  analyzerVersion: 'fixture-ai',
};

describe('persistent mail analysis queue', () => {
  it('persists state transitions until completion', async () => {
    const store = memoryStore();
    const queue = createMailAnalysisQueueService({ store, analyzer: { analyze: vi.fn(async () => draft) } });

    expect(queue.enqueue(input(), async () => ({ ok: true }))).toBe(true);
    await queue.waitForIdle();

    const [job] = [...store.jobs.values()];
    expect(job).toMatchObject({ status: 'completed', attempt: 1 });
    queue.stop();
  });

  it('restores pending work after a process restart', async () => {
    const payload = input();
    const key = `${payload.analysis.contentHash}:${payload.event.eventId}:${payload.analysis.inputSequence}`;
    const store = memoryStore(new Map([[key, {
      key, input: payload, status: 'running' as const, attempt: 1, nextAttemptAt: null, lastError: null,
    }]]));
    const submit = vi.fn(async () => ({ ok: true }));
    const queue = createMailAnalysisQueueService({ store, analyzer: { analyze: vi.fn(async () => draft) } });

    expect(queue.restore(submit)).toBe(1);
    await queue.waitForIdle();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(store.jobs.get(key)?.status).toBe('completed');
    queue.stop();
  });
});
