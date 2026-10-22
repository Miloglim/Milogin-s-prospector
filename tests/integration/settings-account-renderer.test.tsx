// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsPage } from '../../src/renderer/pages/settings/SettingsPage';

vi.mock('../../src/renderer/components/RichTextEditor', () => ({
  RichTextEditor: ({ value, onChange }: { value?: string; onChange?: (value: string) => void }) => (
    <textarea value={value || ''} onChange={event => onChange?.(event.target.value)} />
  ),
}));

describe('mail account settings renderer', () => {
  let root: Root;
  let host: HTMLDivElement;
  let invoke: ReturnType<typeof vi.fn>;
  const account = {
    id: 9,
    email: 'detected@example.invalid',
    provider: 'smtp',
    smtpHost: 'smtp.example.invalid',
    smtpPort: 465,
    imapHost: 'imap.example.invalid',
    imapPort: 993,
    displayName: null,
    signature: null,
    consecutiveFails: 0,
    isActive: 1,
    circuitOpenAt: null,
    circuitResetAfter: null,
    circuitReason: null,
    lastFetchError: '账号密码解密失败: 解密失败',
    lastFetchAt: null,
    fetchFailCount: 5,
  };
  const flush = () => new Promise(resolve => setTimeout(resolve, 80));

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    invoke = vi.fn(async (channel: string) => {
      if (channel === 'accounts:list') return { success: true, data: [account] };
      if (channel === 'system:getConfig') return { success: true, data: { general: {}, sendQuota: { dailyLimit: 800, firstSendAt: null, sentToday: 0 }, schedule: { groupSize: 20, groupDelayMinSeconds: 30, groupDelayMaxSeconds: 60 }, crm: {} } };
      if (channel === 'accounts:upsert') return { success: true, data: { ...account, email: 'corrected@example.invalid' } };
      if (channel === 'ai:endpointStatus') return { success: true, data: { profiles: [], endpoint: { hasBaseUrl: false, hasKey: false } } };
      if (channel === 'system:appVersion') return { success: true, data: 'test' };
      return { success: true, data: [] };
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke, on: () => () => {} } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={qc}><SettingsPage /></QueryClientProvider>));
    await act(flush);
  }

  it('edits and saves an existing detected account without re-entering the password', async () => {
    await mount();
    const edit = Array.from(document.querySelectorAll('button')).find(button => button.textContent === '编辑');
    expect(edit).toBeTruthy();
    await act(async () => { edit!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });

    const modal = document.querySelector('.ant-modal') as HTMLElement;
    const email = modal.querySelector('input[id="email"]') as HTMLInputElement;
    const smtp = modal.querySelector('input[id="smtpHost"]') as HTMLInputElement;
    expect(email.value).toBe(account.email);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(email, 'corrected@example.invalid');
      email.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(smtp, 'smtp.corrected.invalid');
      smtp.dispatchEvent(new Event('input', { bubbles: true }));
      await flush();
    });

    const save = modal.querySelector('.ant-modal-footer .ant-btn-primary');
    expect(save).toBeTruthy();
    await act(async () => { save!.dispatchEvent(new MouseEvent('click', { bubbles: true })); await flush(); });
    expect(invoke).toHaveBeenCalledWith('accounts:upsert', expect.objectContaining({
      id: 9,
      email: 'corrected@example.invalid',
      smtpHost: 'smtp.corrected.invalid',
      imapHost: 'imap.example.invalid',
    }));
    expect(invoke.mock.calls.find(call => call[0] === 'accounts:upsert')?.[1]).not.toHaveProperty('password');
  });
});
