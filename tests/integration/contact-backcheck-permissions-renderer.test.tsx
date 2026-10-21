// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CenterContactDetail } from '../../src/renderer/pages/customers/CenterContactDetail';

vi.mock('../../src/renderer/IdentityContext', () => ({ useIdentity: () => ({ identity: { userId: 'fixture-user' }, baseUrl: 'http://fixture.invalid', status: 'authenticated' }) }));
vi.mock('../../src/renderer/components/ContactDetail', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/renderer/components/ContactDetail')>(),
  ContactDetailLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  InfoTab: () => null,
}));
vi.mock('../../src/renderer/components/CompanyBackcheck', () => ({
  COMPANY_BACKCHECK_UI_ENABLED: false,
  CompanyBackcheck: () => <div data-testid="company-backcheck">company backcheck</div>,
}));

const reference = { contactId: 42, customerId: 'customer-42' };
const detail = {
  contact: { ...reference, contactVersion: 7, companyId: 9, email: 'fixture@example.invalid', firstName: 'Fixture', clientType: 'agent', tags: [], extra: {}, touchStatus: 'contacted', status: '' },
  company: { companyId: 9, name: 'Fixture', canEdit: true, revision: '2026-10-16T00:00:00Z', backcheckData: null },
  permissions: { editableFields: [], canFollowup: false, canChangeStage: false, canSendMail: true, canShare: false },
  activities: [], canEdit: false, canFollowup: false, mailAvailable: true,
};

describe('company backcheck visibility', () => {
  let root: Root, host: HTMLDivElement, client: QueryClient, invoke: ReturnType<typeof vi.fn>;
  const flush = () => new Promise(resolve => setTimeout(resolve, 40));

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    invoke = vi.fn(async () => ({ ok: true, data: detail }));
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });

  it('keeps the backend available but removes the company backcheck tab from the UI', async () => {
    await act(async () => root.render(<QueryClientProvider client={client}><CenterContactDetail reference={reference} onClose={() => {}} /></QueryClientProvider>));
    await act(flush);
    const tabs = Array.from(host.querySelectorAll('[role="tab"]')).map(tab => tab.textContent);
    expect(tabs).toEqual(['基本信息', '往来记录']);
    expect(host.querySelector('[data-testid="company-backcheck"]')).toBeNull();
    expect(invoke.mock.calls.some(([channel]) => channel === 'ai:backcheck')).toBe(false);
  });

  it('keeps customer type and touch status out of duplicate header tags and aligns action colors', async () => {
    await act(async () => root.render(<QueryClientProvider client={client}><CenterContactDetail reference={reference} onClose={() => {}} /></QueryClientProvider>));
    await act(flush);
    expect(host.textContent).not.toContain('代理');
    expect(host.textContent).not.toContain('已触达');
    for (const label of ['带着这位联系人问 AI', '共享线索']) {
      const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      expect(button?.style.color).toBe('rgb(187, 187, 187)');
    }
  });
});
