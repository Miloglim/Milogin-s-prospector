// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HomeCards } from '../../src/renderer/pages/assistant/HomeCards';

describe('contact auto-development focused page', () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  it('renders only the automatic development card', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => root.render(<QueryClientProvider client={client}><HomeCards onSend={() => {}} autoDevelopmentOnly /></QueryClientProvider>));
    expect(host.textContent).toContain('自动开发信');
    expect(host.textContent).not.toContain('运价查询');
    expect(host.textContent).not.toContain('今日邮箱概览');
    client.clear();
  });
});
