import type {
  ContactMailAnalysisSubmission,
  MailAnalysisQueueStatus,
  MailAnalysisResult,
  MailContactState,
} from '../../../server/core/mail-analysis';
import type { ContactMailEventReceipt } from '../../../server/core/contact-mail';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const REMEMBERED_COMPLETIONS = 2048;

export interface MailAnalysisQueueInput {
  event: ContactMailEventReceipt['event'];
  analysis: ContactMailEventReceipt['analysis'];
  contactState: MailContactState | null;
}

export interface MailAnalysisDraft extends Omit<MailAnalysisResult, 'source' | 'contactState'> {}

export interface MailAnalysisAnalyzerPort {
  analyze(input: MailAnalysisQueueInput, signal: AbortSignal): Promise<MailAnalysisDraft>;
}

export interface MailAnalysisQueueOptions {
  analyzer?: MailAnalysisAnalyzerPort;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

type SubmitAnalysis = (input: ContactMailAnalysisSubmission) => Promise<{ ok: boolean; error?: { message: string } }>;

interface QueueItem {
  key: string;
  input: MailAnalysisQueueInput;
  submit: SubmitAnalysis;
}

export interface MailAnalysisQueueService {
  enqueue(input: MailAnalysisQueueInput, submit: SubmitAnalysis): boolean;
  status(): MailAnalysisQueueStatus;
  waitForIdle(): Promise<void>;
  stop(): void;
}

export function createMailAnalysisQueueService(options: MailAnalysisQueueOptions = {}): MailAnalysisQueueService {
  const analyzer = options.analyzer;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const queued: QueueItem[] = [];
  const known = new Set<string>();
  const completionOrder: string[] = [];
  const controllers = new Set<AbortController>();
  const idleWaiters = new Set<() => void>();
  let running = 0;
  let retrying = 0;
  let completed = 0;
  let failed = 0;
  let lastError: string | null = null;
  let stopped = false;

  const wakeIdle = () => {
    if (running || queued.length || retrying) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const analyzeWithTimeout = async (item: QueueItem): Promise<MailAnalysisDraft> => {
    const controller = new AbortController();
    controllers.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        analyzer!.analyze(item.input, controller.signal),
        new Promise<MailAnalysisDraft>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('AI 分析超时'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      controllers.delete(controller);
    }
  };

  const submitOnce = async (item: QueueItem): Promise<boolean> => {
    let attempt = 0;
    while (attempt < maxAttempts && !stopped) {
      attempt++;
      try {
        const draft = await analyzeWithTimeout(item);
        if (stopped) return false;
        const inputSequence = item.input.analysis.inputSequence;
        const submission: ContactMailAnalysisSubmission = {
          contactId: item.input.analysis.contactId,
          customerId: item.input.analysis.customerId,
          mailboxKey: item.input.analysis.mailboxKey,
          messageKey: item.input.analysis.messageKey,
          contentHash: item.input.analysis.contentHash,
          inputSequence,
          idempotencyKey: `ai:${draft.analyzerVersion}:${item.input.analysis.contentHash}:${inputSequence}`,
          result: {
            classification: draft.classification,
            relevance: draft.relevance,
            summary: draft.summary,
            signals: draft.signals,
            actionability: draft.actionability,
            confidence: draft.confidence,
            evidence: draft.evidence,
            analyzerVersion: draft.analyzerVersion,
          },
        };
        const receipt = await item.submit(submission);
        if (receipt.ok) return true;
        lastError = receipt.error?.message ?? 'AI 分析保存失败';
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'AI 分析失败';
      }
      if (attempt < maxAttempts && !stopped) {
        retrying++;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs * attempt));
        retrying--;
      }
    }
    return false;
  };

  const drain = async () => {
    if (running || stopped) return;
    running = 1;
    while (queued.length && !stopped) {
      const item = queued.shift()!;
      const ok = await submitOnce(item);
      if (ok) completed++; else if (!stopped) failed++;
      if (ok) {
        completionOrder.push(item.key);
        if (completionOrder.length > REMEMBERED_COMPLETIONS) {
          const expired = completionOrder.shift();
          if (expired) known.delete(expired);
        }
      } else if (!stopped) {
        known.delete(item.key);
      }
    }
    running = 0;
    wakeIdle();
  };

  return {
    enqueue(input, submit) {
      if (!analyzer || stopped || input.analysis.relevance !== 'customer_business') return false;
      const key = [input.analysis.contentHash, input.event.eventId, String(input.analysis.inputSequence)].join(':');
      if (known.has(key)) return false;
      known.add(key);
      queued.push({ key, input, submit });
      void drain();
      return true;
    },
    status() {
      return { enabled: !!analyzer && !stopped, pending: queued.length, running, retrying, completed, failed, lastError };
    },
    waitForIdle() {
      if (!running && !queued.length && !retrying) return Promise.resolve();
      return new Promise(resolve => idleWaiters.add(resolve));
    },
    stop() {
      stopped = true;
      for (const controller of controllers) controller.abort();
      queued.length = 0;
      known.clear();
      completionOrder.length = 0;
      wakeIdle();
    },
  };
}
