// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { ONLINE_CHANNELS, type LeadIngressDecisionDTO, type LeadIngressDecisionQuery } from '../../src/shared/online-crm';
import { conflictTargetForAttempt, LeadIngressConflictDrawer, type LeadIngressConflictTarget } from '../../src/renderer/pages/customers/LeadIngressConflictDrawer';
import { createCenterImportPort } from '../../src/renderer/pages/customers/centerContactPort';

vi.mock('antd', async () => {
  const React = await import('react');
  const Button = ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children}</button>;
  const Radio = Object.assign(({ children, value }: { children: React.ReactNode; value?: unknown }) => <label><input type="radio" value={value as string | number | undefined} />{children}</label>, {
    Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Button: ({ children }: { children: React.ReactNode }) => <label>{children}</label>,
  });
  return {
    Alert: ({ message }: { message: string }) => <div role="alert">{message}</div>,
    Button,
    Drawer: ({ children, footer, open }: { children: React.ReactNode; footer?: React.ReactNode; open: boolean }) => open ? <div>{children}{footer}</div> : null,
    Radio,
    Spin: () => <span>加载中</span>,
    Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  };
});

const candidate = {
  contactId: 7,
  customerId: '11111111-1111-4111-8111-111111111111',
  companyId: 17,
  label: 'Fixture Logistics',
  domain: 'fixture.invalid',
  country: 'BR',
  score: 0.93,
  level: 'exact_domain' as const,
};

function decision(action: 'attach_company' | 'create_new' | 'restore'): LeadIngressDecisionDTO {
  return {
    decisionId: '22222222-2222-4222-8222-222222222222',
    ingressSource: 'flat_import',
    idempotencyKey: 'attempt:0',
    status: 'needs_resolution',
    level: 'exact_domain',
    action: null,
    suggestedActions: [action],
    candidate,
    candidates: [candidate],
    version: 4,
    message: '域名与现有公司一致',
    createdAt: '2026-10-30T00:00:00.000Z',
    resolvedAt: null,
  };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('lead ingress conflict drawer', () => {
  let root: Root;
  let host: HTMLDivElement;
  let qc: QueryClient;
  const target = (source: LeadIngressDecisionQuery['source'] = 'flat_import'): LeadIngressConflictTarget => ({ source, idempotencyKey: 'attempt:0', rowLabel: '第 2 行' });

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

  async function mount(invoke: ReturnType<typeof vi.fn>, source: LeadIngressDecisionQuery['source'] = 'flat_import', onResolved = vi.fn()) {
    await act(async () => {
      root.render(<QueryClientProvider client={qc}>
        <LeadIngressConflictDrawer target={target(source)} invoke={invoke as never} onClose={() => {}} onResolved={onResolved} />
      </QueryClientProvider>);
      await flush();
    });
    await act(flush);
    return onResolved;
  }

  it.each(['flat_import', 'workbook_import', 'api_contact_update'] as const)('loads a conflict through the %s entry', async source => {
    const invoke = vi.fn(async (channel: string) => channel === ONLINE_CHANNELS.LEAD_INGRESS_DECISION
      ? { ok: true as const, data: decision('create_new') }
      : { ok: false as const, error: { code: 'UNEXPECTED', message: 'unexpected write' } });
    await mount(invoke, source);
    expect(invoke).toHaveBeenCalledWith(ONLINE_CHANNELS.LEAD_INGRESS_DECISION, { source, idempotencyKey: 'attempt:0' });
    expect(host.textContent).toContain('第 2 行');
    expect(host.textContent).toContain('域名与现有公司一致');
  });

  it('renders only the server-provided candidate summary', async () => {
    const visibleDecision = decision('attach_company');
    visibleDecision.candidates = [{ ...candidate, email: 'private@example.invalid', notes: 'hidden owner note', ownerName: 'Private Owner' } as typeof candidate];
    const invoke = vi.fn(async (channel: string) => channel === ONLINE_CHANNELS.LEAD_INGRESS_DECISION
      ? { ok: true as const, data: visibleDecision }
      : { ok: false as const, error: { code: 'UNEXPECTED', message: 'unexpected write' } });
    await mount(invoke);
    expect(host.textContent).toContain('Fixture Logistics');
    expect(host.textContent).toContain('fixture.invalid');
    expect(host.textContent).not.toContain('private@example.invalid');
    expect(host.textContent).not.toContain('hidden owner note');
    expect(host.textContent).not.toContain('Private Owner');
  });

  it('shows a clear terminal duplicate reason without exposing a resolve action', async () => {
    const duplicate = { ...decision('create_new'), status: 'duplicate' as const, suggestedActions: [], candidates: [], candidate: undefined, level: 'exact_email' as const, message: '邮箱已存在，不能重复新建' };
    const invoke = vi.fn(async (channel: string) => channel === ONLINE_CHANNELS.LEAD_INGRESS_DECISION
      ? { ok: true as const, data: duplicate }
      : { ok: false as const, error: { code: 'UNEXPECTED', message: 'unexpected write' } });
    await mount(invoke);
    expect(host.textContent).toContain('邮箱已存在，不能重复新建');
    expect(Array.from(host.querySelectorAll('button')).some(button => button.textContent === '确认处理')).toBe(false);
  });

  it.each([
    ['attach_company', '关联现有公司'],
    ['create_new', '作为新记录'],
    ['restore', '恢复已删除联系人'],
  ] as const)('resolves with the %s decision', async (action, label) => {
    const onResolved = vi.fn();
    const invoke = vi.fn(async (channel: string) => channel === ONLINE_CHANNELS.LEAD_INGRESS_DECISION
      ? { ok: true as const, data: decision(action) }
      : { ok: true as const, data: { decision: decision(action), customerId: candidate.customerId, companyId: candidate.companyId, contactIds: [candidate.contactId] } });
    await mount(invoke, 'flat_import', onResolved);
    expect(host.textContent).toContain(label);
    const submit = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '确认处理')!;
    await act(async () => { submit.click(); await flush(); });
    const write = invoke.mock.calls.find(call => call[0] === ONLINE_CHANNELS.LEAD_INGRESS_RESOLVE)![1] as Record<string, unknown>;
    expect(write).toMatchObject({ action, expectedVersion: 4 });
    expect(onResolved).toHaveBeenCalledTimes(1);
  });

  it('retains the same resolution key after an unknown transport outcome and invalidates caches', async () => {
    let writes = 0;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === ONLINE_CHANNELS.LEAD_INGRESS_DECISION) return { ok: true as const, data: decision('attach_company') };
      writes++;
      if (writes === 1) return { ok: false as const, error: { code: 'UNAVAILABLE', message: '响应丢失' } };
      return { ok: true as const, data: { decision: decision('attach_company'), customerId: candidate.customerId, companyId: candidate.companyId, contactIds: [candidate.contactId] } };
    });
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const onResolved = await mount(invoke);
    const submit = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '确认处理')!;
    await act(async () => { submit.click(); await flush(); });
    await act(async () => { submit.click(); await flush(); });
    const calls = invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.LEAD_INGRESS_RESOLVE);
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toEqual(calls[1]![1]);
    expect(onResolved).toHaveBeenCalledTimes(1);
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey?.[0]);
    for (const key of ['center-contacts', 'center-companies', 'center-contact-groups', 'center-import-batches']) expect(invalidated).toContain(key);
  });

  it('uses the same per-row attempt key as the center importer and keeps the 824px drawer bounded', () => {
    expect(conflictTargetForAttempt('workbook_import', 'a'.repeat(160), 12).idempotencyKey).toBe(`${'a'.repeat(120)}:12`);
    const css = readFileSync('src/renderer/pages/customers/customers.css', 'utf8');
    expect(css).toContain('.lead-ingress-conflict-body{display:grid;gap:12px;min-width:0;overflow-x:hidden}');
    expect(css).toContain('@media(max-width:824px){.lead-ingress-action-group{grid-template-columns:1fr}');
  });

  it('resumes a flat import after the resolved conflict without resending the blocked batch', async () => {
    const refresh = vi.fn();
    const preview = { headers: ['Company', 'Email'], rows: [
      { Company: 'Created Company', Email: 'created@example.invalid' },
      { Company: 'Conflict Company', Email: 'conflict@example.invalid' },
    ], fileName: 'fixture.csv' };
    const invoke = vi.fn(async (channel: string) => {
      if (channel === ONLINE_CHANNELS.PREVIEW) return { ok: true as const, data: preview };
      return { ok: true as const, data: {
        batchId: 'batch-a', version: 1, rows: [
          { rowId: 'row-0', index: 0, status: 'created', customerId: candidate.customerId },
          { rowId: 'row-1', index: 1, status: 'restricted_conflict', message: '公司已存在', conflict: { decisionId: '33333333-3333-4333-8333-333333333333', level: 'exact_company', candidates: [candidate] } },
        ],
      } };
    });
    const port = createCenterImportPort(invoke as never, true, refresh);
    const parsed = await port.preview({ type: 'csv', data: 'Company,Email' });
    expect(parsed.success).toBe(true);
    const result = await port.execute({ type: 'csv', data: 'Company,Email', mapping: parsed.data!.suggestedMapping });
    expect(result.conflict?.rowLabel).toBe('第 3 行');
    expect(result.conflict?.idempotencyKey).toMatch(/:1$/);
    const resumed = await port.continueAfterConflict!(result.conflict!);
    expect(resumed).toMatchObject({ success: true, data: { imported: 2, skipped: 0 } });
    expect(invoke.mock.calls.filter(call => call[0] === ONLINE_CHANNELS.IMPORT)).toHaveLength(1);
  });
});
