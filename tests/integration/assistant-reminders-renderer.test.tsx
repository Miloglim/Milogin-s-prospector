// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App as AntApp } from 'antd';
import { AssistantReminders } from '../../src/renderer/components/AssistantReminders';

const snapshot = {
  reminders: [{ reminderId: 'r1', title: '报价待你确认：Acme', detail: 'Shanghai → Santos · CMA', target: 'team_review', priority: 2, source: 'ai', createdAt: '2026-11-18T01:00:00.000Z' }],
  settings: { enabled: true, intervalMinutes: 60, checks: { mail: true, task: true, quoteReview: true, stalled: true } },
  lastCheckedAt: '2026-11-18T01:00:00.000Z', lastError: null, aiConfigured: true, due: false,
};

describe('assistant reminders card', () => {
  let root: Root; let host: HTMLDivElement;
  const invoke = vi.fn(async (channel: string) => channel === 'assistant:snapshot' ? { success: true, data: snapshot } : { success: true, data: null });

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke, on: () => () => {} } });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(<AntApp><AssistantReminders /></AntApp>));
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); invoke.mockClear(); window.location.hash = ''; });

  it('renders the assistant queue and jumps to the source', async () => {
    expect(host.textContent).toContain('报价确认');
    expect(host.textContent).toContain('Acme');
    expect(host.textContent).not.toContain('模型整理');
    expect(host.textContent).not.toContain('提醒设置');
    const row = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === '去回复')!;
    await act(async () => row.click());
    expect(window.location.hash).toBe('#/team?section=workspace');
  });

  it('hands the top item to the assistant when asked', async () => {
    const onSend = vi.fn();
    await act(async () => root.render(<AntApp><AssistantReminders onSend={onSend} /></AntApp>));
    const ask = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === '让助手帮我')!;
    await act(async () => ask.click());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0]?.[0]).toContain('报价待你确认：Acme');
  });

  it('opens reminder settings from the card', async () => {
    const settings = host.querySelector<HTMLButtonElement>('button[aria-label="提醒设置"]')!;
    await act(async () => settings.click());
    expect(document.body.textContent).toContain('提醒设置');
    expect(document.body.textContent).toContain('模型整理间隔');
    expect(document.body.textContent).toContain('提醒来源');
  });

  it('previews every card style and the collapsed volume state', async () => {
    const preview = host.querySelector<HTMLButtonElement>('button[aria-label="卡片预览"]')!;
    await act(async () => preview.click());
    expect(document.body.textContent).toContain('四种行动卡');
    expect(document.body.textContent).toContain('客户回复');
    expect(document.body.textContent).toContain('报价确认');
    expect(document.body.textContent).toContain('到期待办');
    expect(document.body.textContent).toContain('停滞跟进');
    expect(document.body.textContent).toContain('展开其余 2 件');
  });
});
