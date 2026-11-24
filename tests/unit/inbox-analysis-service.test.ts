import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  aiConfigured: false,
  modelCalls: 0,
  rows: new Map<number, Record<string, unknown>>(),
  analyses: new Map<number, Record<string, unknown>>(),
  contextRows: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/main/db', () => ({
  getRawDb: () => ({
    prepare(sql: string) {
      if (sql.includes('LEFT JOIN email_accounts')) {
        return { get: (id: number) => state.rows.get(Number(id)) };
      }
      if (sql.includes('a.analyzer_version<>?')) {
        return { all: () => [] };
      }
      if (sql.includes('LEFT JOIN inbox_mail_analyses')) {
        if (sql.includes('analysisSummary')) return { all: () => state.contextRows };
        return {
          all: (limit: number) => [...state.rows.keys()].slice(0, limit).map(id => ({ id })),
        };
      }
      if (sql.includes('INSERT INTO inbox_mail_analyses')) {
        return {
          run: (...values: unknown[]) => state.analyses.set(Number(values[0]), {
            message_id: values[0], content_hash: values[1], category: values[2], priority: values[3],
            requires_action: values[4], summary: values[5], next_action: values[6], due_hint: values[7],
            confidence: values[8], evidence_json: values[9], source: values[10],
            analyzer_version: values[11], status: values[12], error: values[13],
          }),
        };
      }
      return { run: () => undefined, all: () => [] };
    },
  }),
  getDb: () => null,
  saveDatabase: () => undefined,
}));

vi.mock('../../src/main/services/ai.service', () => ({
  isAiConfigured: () => state.aiConfigured,
  chatJson: vi.fn(async () => {
    state.modelCalls++;
    return {
      success: true,
      data: {
        category: 'other', priority: 'normal', requiresAction: false, summary: 'model result',
        nextAction: null, dueHint: null, confidence: 0.8, evidence: [],
      },
    };
  }),
}));

import { createInboxAnalysisService } from '../../src/main/services/inbox-analysis.service';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    accountId: 1,
    accountEmail: 'sales@example.test',
    fromEmail: 'mailer-daemon@example.test',
    subject: 'Delivery failed',
    bodyPreview: 'The recipient address was rejected.',
    classification: 'bounce',
    myRole: 'to',
    receivedAt: '2026-11-10T00:00:00Z',
    ...overrides,
  };
}

describe('local inbox analysis routing', () => {
  beforeEach(() => {
    state.aiConfigured = false;
    state.modelCalls = 0;
    state.rows.clear();
    state.analyses.clear();
    state.contextRows = [];
  });

  afterEach(() => {
    delete process.env.PROSPECTOR_MAIL_AI_MODE;
  });

  it('processes high-confidence rules without a configured model', async () => {
    state.rows.set(1, row());
    const service = createInboxAnalysisService();

    expect(service.enqueueRecent()).toBe(1);
    await vi.waitFor(() => expect(state.analyses.get(1)?.status).toBe('ready'));

    expect(state.analyses.get(1)).toMatchObject({ source: 'rule', category: 'notification', requires_action: 1 });
    expect(state.modelCalls).toBe(0);
    service.stop();
  });

  it('passes recent contact history into the AI prompt', async () => {
    state.aiConfigured = true;
    state.rows.set(2, row({
      id: 2,
      fromEmail: 'buyer@example.test',
      subject: 'Re: shipment',
      bodyPreview: 'Please confirm the latest schedule.',
      classification: 'replied',
    }));
    state.contextRows = [{
      subject: 'Original inquiry',
      bodyPreview: 'Shanghai to Rotterdam',
      classification: 'replied',
      receivedAt: '2026-11-09T00:00:00Z',
      analysisSummary: `客户先询问上海到鹿特丹船期${'长'.repeat(300)}TAIL_SHOULD_NOT_APPEAR`,
      analysisCategory: 'schedule_request',
      analysisConfidence: 0.88,
    }];
    const analyzeJson = vi.fn(async (_system: string, user: string) => {
      expect(user).toContain('最近往来上下文');
      expect(user).toContain('客户先询问上海到鹿特丹船期');
      expect(user).not.toContain('TAIL_SHOULD_NOT_APPEAR');
      return {
        success: true as const,
        data: {
          category: 'schedule_request', priority: 'important', requiresAction: true,
          summary: '客户看起来在确认上海到鹿特丹的船期', nextAction: '核对船期后回复',
          dueHint: null, confidence: 0.82, evidence: ['Please confirm the latest schedule.'],
        },
      };
    });
    const service = createInboxAnalysisService({ model: { analyzeJson } });

    expect(service.enqueueRecent()).toBe(1);
    await vi.waitFor(() => expect(state.analyses.get(2)?.status).toBe('ready'));

    expect(analyzeJson).toHaveBeenCalledTimes(1);
    expect(state.analyses.get(2)).toMatchObject({ source: 'ai', category: 'schedule_request' });
    service.stop();
  });

  it('uses the internal-domain rate update rule without calling AI', async () => {
    state.rows.set(3, row({
      id: 3,
      accountEmail: 'sales@yqn.com',
      fromEmail: 'katey_huang@yqn.com',
      subject: '阳明海运更新WCSA的FAK运价，有效期11月13日至17日',
      bodyPreview: '新增Caldera为POD。',
      classification: 'replied',
    }));
    const service = createInboxAnalysisService();

    expect(service.enqueueRecent()).toBe(1);
    await vi.waitFor(() => expect(state.analyses.get(3)?.status).toBe('ready'));

    expect(state.analyses.get(3)).toMatchObject({ source: 'rule', category: 'rate_update', requires_action: 0 });
    expect(state.modelCalls).toBe(0);
    service.stop();
  });

  it('routes cc-only copies without calling AI or requesting action', async () => {
    state.aiConfigured = true;
    state.rows.set(4, row({
      id: 4,
      fromEmail: 'buyer@example.test',
      subject: 'Please quote Shanghai to Rotterdam',
      bodyPreview: '2x40HQ urgently.',
      classification: 'other',
      myRole: 'cc',
    }));
    const service = createInboxAnalysisService();

    expect(service.enqueueRecent()).toBe(1);
    await vi.waitFor(() => expect(state.analyses.get(4)?.status).toBe('ready'));

    expect(state.analyses.get(4)).toMatchObject({ source: 'rule', category: 'other', requires_action: 0 });
    expect(state.modelCalls).toBe(0);
    service.stop();
  });

  it('leaves AI-only mail unqueued when the development AI mode is off', () => {
    process.env.PROSPECTOR_MAIL_AI_MODE = 'off';
    state.aiConfigured = true;
    state.rows.set(5, row({
      id: 5,
      fromEmail: 'buyer@example.test',
      subject: 'Please quote Shanghai to Rotterdam',
      bodyPreview: '2x40HQ urgently.',
      classification: 'replied',
    }));
    const service = createInboxAnalysisService();

    expect(service.enqueueRecent()).toBe(0);
    expect(service.status().enabled).toBe(false);
    service.stop();
  });

  it('uses deterministic mock analysis without a configured model', async () => {
    process.env.PROSPECTOR_MAIL_AI_MODE = 'mock';
    state.aiConfigured = false;
    state.rows.set(6, row({
      id: 6,
      fromEmail: 'buyer@example.test',
      subject: '[MOCK:quote_request] RFQ Shanghai to Rotterdam',
      bodyPreview: 'Please quote 2x40HQ.',
      classification: 'replied',
    }));
    const service = createInboxAnalysisService();

    expect(service.enqueueRecent()).toBe(1);
    await vi.waitFor(() => expect(state.analyses.get(6)?.status).toBe('ready'));

    expect(state.analyses.get(6)).toMatchObject({ source: 'mock', category: 'quote_request', requires_action: 1 });
    expect(state.analyses.get(6)?.analyzer_version).toBe('inbox-ai-v4-mock');
    expect(state.modelCalls).toBe(0);
    service.stop();
  });
});
