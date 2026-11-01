// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContactMailAnalysisQuery, ContactMailAnalysisRecord, ContactMailAnalysisView } from '../../src/shared/online-crm';
import { ONLINE_CHANNELS } from '../../src/shared/online-crm';
import { MailAnalysisPanel, mailAnalysisListIndicator } from '../../src/renderer/pages/customers/CenterContactDetail';

vi.mock('../../src/renderer/IdentityContext', () => ({
  useIdentity: () => ({ identity: { userId: 'fixture-user', crmRoles: ['sales'] }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }),
}));

vi.mock('antd', async importOriginal => {
  const actual = await importOriginal<typeof import('antd')>();
  const Button = ({ children, onClick, disabled, ...props }: { children?: ReactNode; onClick?: () => void; disabled?: boolean; [key: string]: unknown }) =>
    <button aria-label={props['aria-label'] as string | undefined} disabled={disabled} onClick={onClick}>{children}</button>;
  const field = ({ value, onChange, disabled, maxLength, ...props }: { value?: string; onChange?: (event: { target: { value: string } }) => void; disabled?: boolean; maxLength?: number; [key: string]: unknown }) =>
    <input aria-label={props['aria-label'] as string | undefined} disabled={disabled} maxLength={maxLength} value={value ?? ''} onChange={event => onChange?.({ target: { value: event.target.value } })} />;
  const Input = Object.assign(field, { TextArea: field });
  const Select = ({ value, onChange, disabled, options = [], ...props }: { value?: string; onChange?: (value: string) => void; disabled?: boolean; options?: Array<{ value: string; label: ReactNode }>; [key: string]: unknown }) =>
    <select aria-label={props['aria-label'] as string | undefined} disabled={disabled} value={value ?? ''} onChange={event => onChange?.(event.target.value)}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>;
  return {
    ...actual,
    Button,
    Input,
    Select,
    Tag: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    message: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  };
});

const key: ContactMailAnalysisQuery = {
  contactId: 41,
  customerId: '11111111-1111-4111-8111-111111111111',
  mailboxKey: 'mailbox:fixture',
  messageKey: 'message:fixture',
  contentHash: 'a'.repeat(64),
  includeHistory: true,
  historyLimit: 20,
};

function record(overrides: Partial<ContactMailAnalysisRecord> = {}): ContactMailAnalysisRecord {
  return {
    ...key,
    analysisId: 'analysis-current',
    actorId: 'fixture-user',
    eventId: 'event-1',
    threadKey: 'quote-request',
    analyzerVersion: 'fixture-v1',
    inputSequence: 20,
    source: 'ai',
    relevance: 'customer_business',
    classification: 'replied',
    contactState: 'replied',
    summary: '客户要求两个 40HQ 的报价',
    signals: [{ code: 'quote_request', label: '报价请求', confidence: 0.94, evidence: 'quote two 40HQ' }],
    requiresAction: true,
    nextAction: '回复客户询价',
    priority: 'important',
    dueHint: '24 小时内',
    confidence: 0.94,
    evidence: ['quote two 40HQ'],
    humanLocked: false,
    supersedesId: null,
    isCurrent: true,
    createdAt: '2026-10-30T02:00:00.000Z',
    ...overrides,
  };
}

function view(current = record(), overrides: Partial<ContactMailAnalysisView> = {}): ContactMailAnalysisView {
  return {
    current,
    history: [],
    canCorrect: true,
    access: 'normal',
    taskSuggestion: current.relevance === 'customer_business' && current.requiresAction ? {
      key: 'task-1', actionCode: 'quote_request', nextAction: current.nextAction || '回复客户', priority: current.priority, dueHint: current.dueHint,
    } : null,
    ...overrides,
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('contact mail analysis renderer', () => {
  let root: Root;
  let host: HTMLDivElement;
  let qc: QueryClient;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    qc.clear();
  });

  async function mount(invoke: ReturnType<typeof vi.fn>, readOnly = false) {
    (window as typeof window & { api: { invoke: ReturnType<typeof vi.fn> } }).api = { invoke };
    await act(async () => {
      root.render(<QueryClientProvider client={qc}>
        <MailAnalysisPanel queryInput={key} readOnly={readOnly} />
      </QueryClientProvider>);
      await flush();
    });
    await act(flush);
  }

  it('renders the current summary, structured signals, action, source and one bounded style block', async () => {
    const data = view();
    const invoke = vi.fn(async (channel: string) => channel === ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS
      ? { ok: true as const, data }
      : { ok: false as const, error: { code: 'UNAVAILABLE', message: 'queue unavailable' } });
    await mount(invoke);
    expect(host.textContent).toContain('客户要求两个 40HQ 的报价');
    expect(host.textContent).toContain('报价请求');
    expect(host.textContent).toContain('待处理 · 重要');
    expect(host.textContent).toContain('AI');
    expect(host.textContent).toContain('客户业务');
    expect(host.querySelector('style')?.textContent).toContain('.mail-analysis-panel{display:grid;gap:8px;min-width:0;overflow-x:hidden');
    expect(host.querySelector('style')?.textContent).toContain('@media(max-width:824px){.mail-analysis-form{grid-template-columns:1fr}');
  });

  it('shows the human lock and keeps a late AI result in history without reactivating its task', async () => {
    const human = record({ analysisId: 'human-current', source: 'human', humanLocked: true, requiresAction: false, summary: '人工确认无需继续跟进', createdAt: '2026-10-30T03:00:00.000Z' });
    const lateAI = record({ analysisId: 'ai-late', source: 'ai', isCurrent: false, inputSequence: 21, summary: '晚到 AI 仍认为需要报价', createdAt: '2026-10-30T04:00:00.000Z' });
    const data = view(human, { taskSuggestion: null, history: [lateAI] });
    const invoke = vi.fn(async (channel: string) => channel === ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS
      ? { ok: true as const, data }
      : { ok: false as const, error: { code: 'UNAVAILABLE', message: 'queue unavailable' } });
    await mount(invoke);
    expect(host.textContent).toContain('人工确认');
    expect(host.textContent).toContain('人工确认无需继续跟进');
    expect(host.textContent).toContain('晚到 AI 仍认为需要报价');
    expect(host.textContent).toContain('晚到');
    expect(host.textContent).not.toContain('待处理');
    expect(mailAnalysisListIndicator(data)).toBe('人工确认无需继续跟进');
  });

  it('keeps internal mail neutral and suppresses task and contact-state action chips', async () => {
    const internal = record({ source: 'rule', relevance: 'internal', classification: 'other', contactState: null, summary: '内部交接邮件', signals: [], requiresAction: true, nextAction: '不应出现', confidence: 0.95 });
    const data = view(internal, { taskSuggestion: { key: 'bad', actionCode: 'other', nextAction: '不应出现', priority: 'urgent', dueHint: null } });
    const invoke = vi.fn(async (channel: string) => channel === ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS
      ? { ok: true as const, data }
      : { ok: false as const, error: { code: 'UNAVAILABLE', message: 'queue unavailable' } });
    await mount(invoke);
    expect(host.textContent).toContain('内部邮件');
    expect(host.textContent).toContain('内部交接邮件');
    expect(host.textContent).not.toContain('待处理');
    expect(host.textContent).not.toContain('不应出现');
    expect(mailAnalysisListIndicator(data)).toBe('内部邮件 · 内部交接邮件');
  });

  it('reuses the same correction key after an unknown result, sends metadata only and visibly locks after recovery', async () => {
    const ai = view();
    let correctionWrites = 0;
    let current = ai;
    const invoke = vi.fn(async (channel: string, input?: unknown) => {
      if (channel === ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS_QUEUE) return { ok: false as const, error: { code: 'UNAVAILABLE', message: 'queue unavailable' } };
      if (channel === ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS) return { ok: true as const, data: current };
      if (channel === ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS_CORRECT) {
        correctionWrites++;
        if (correctionWrites === 1) return { ok: false as const, error: { code: 'UNAVAILABLE', message: '响应丢失' } };
        const inputRecord = input as Record<string, unknown>;
        const human = record({
          analysisId: 'analysis-human', source: 'human', humanLocked: true, summary: String(inputRecord.summary || ai.current.summary),
          relevance: inputRecord.relevance as ContactMailAnalysisRecord['relevance'], classification: inputRecord.classification as ContactMailAnalysisRecord['classification'],
          requiresAction: Boolean(inputRecord.requiresAction), nextAction: String(inputRecord.nextAction || ''), priority: inputRecord.priority as ContactMailAnalysisRecord['priority'],
        });
        current = view(human, { history: [ai.current] });
        return { ok: true as const, data: human };
      }
      return { ok: false as const, error: { code: 'UNEXPECTED', message: 'unexpected channel' } };
    });
    await mount(invoke);
    const edit = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '修正')!;
    await act(async () => { edit.click(); await flush(); });
    const save = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '保存修正')!;
    await act(async () => { save.click(); await flush(); });
    await act(async () => { save.click(); await flush(); });
    const writes = invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS_CORRECT);
    expect(writes).toHaveLength(2);
    expect((writes[0]![1] as Record<string, unknown>).idempotencyKey).toBe((writes[1]![1] as Record<string, unknown>).idempotencyKey);
    expect(writes[0]![1]).not.toHaveProperty('rawBody');
    expect(writes[0]![1]).not.toHaveProperty('attachments');
    expect(current.current.source).toBe('human');
    await act(flush);
    expect(host.textContent).toContain('人工确认');
  });

  it('removes every correction control in supervisor monitor mode', async () => {
    const data = view(record({ source: 'rule' }), { access: 'monitor', canCorrect: false });
    const invoke = vi.fn(async (channel: string) => channel === ONLINE_CHANNELS.CONTACT_MAIL_ANALYSIS
      ? { ok: true as const, data }
      : { ok: false as const, error: { code: 'UNAVAILABLE', message: 'queue unavailable' } });
    await mount(invoke, true);
    expect(host.querySelector('[aria-label="邮件分析"]')).not.toBeNull();
    expect(host.querySelector('[data-readonly="true"]')).not.toBeNull();
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent === '修正')).toBe(false);
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent === '保存修正')).toBe(false);
  });
});
