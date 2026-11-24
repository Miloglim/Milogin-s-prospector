// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CampaignTasks } from '../../src/renderer/pages/campaigns/CampaignTasks';

describe('campaign inbox result links', () => {
  let root: Root;
  let host: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    Object.defineProperty(window, 'api', { configurable: true, value: {
      invoke: vi.fn(async (channel: string) => channel === 'send:campaigns' ? { success: true, data: [{
        id: 'campaign-1', name: 'Brazil outreach', status: 'running', autoSend: true, planRounds: 2, total: 100,
        pending: 0, queued: 0, sent: 90, replied: 2, bounced: 3, autoreply: 4, unsubscribed: 1, skipped: 0,
        touchesSent: 90, touchesPlanned: 200, queuedGroups: 0, createdAt: '2026-11-17T00:00:00Z',
      }] } : channel === 'send:campaignDetail' ? { success: true, data: {
        campaign: {
          id: 'campaign-1', name: 'Brazil outreach', status: 'running', autoSend: true, planRounds: 2, total: 100,
          pending: 0, queued: 0, sent: 90, replied: 2, bounced: 3, autoreply: 4, unsubscribed: 1, skipped: 0,
          touchesSent: 90, touchesPlanned: 200, queuedGroups: 0, createdAt: '2026-11-17T00:00:00Z',
        },
        targets: [], queue: [], raw: { accountPolicy: 'rotate' },
      } } : { success: false, error: 'fixture only' }),
      on: vi.fn(() => vi.fn()),
    } });
    window.location.hash = '#/campaigns';
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => { root.render(<QueryClientProvider client={queryClient}><CampaignTasks onCreate={() => undefined} onEdit={() => undefined} /></QueryClientProvider>); });
    await vi.waitFor(() => expect(host.textContent).toContain('已收到 2'), { timeout: 2000 });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    host.remove();
  });

  it('opens the inbox filtered to the selected campaign result', async () => {
    const reply = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.includes('已收到 2'))!;
    await act(async () => { reply.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(window.location.hash).toBe('#/inbox?campaign=campaign-1&campaignStatus=replied');
  });

  it('opens all task mail from the task detail', async () => {
    const card = Array.from(host.querySelectorAll<HTMLDivElement>('div.rounded-xl')).find(node => node.textContent?.includes('Brazil outreach'));
    expect(card).toBeTruthy();
    await act(async () => { card!.click(); });
    const detailLink = await vi.waitFor(() => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(candidate => candidate.textContent?.includes('查看任务邮件'));
      expect(button).toBeTruthy();
      return button!;
    }, { timeout: 2000 });
    await act(async () => { detailLink.click(); });
    expect(window.location.hash).toBe('#/inbox?campaign=campaign-1');
  });
});
