// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { OnboardingWizard } from '../../src/renderer/components/OnboardingWizard';

describe('onboarding email account password', () => {
  let root: Root;
  let host: HTMLDivElement;
  const invoke = vi.fn();

  beforeEach(async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    Object.defineProperty(window, 'api', { configurable: true, value: { invoke } });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root.render(<OnboardingWizard autoCheck={false} prefillEmail="milogin@qq.com" openSignal={1} />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    invoke.mockReset();
    vi.unstubAllGlobals();
  });

  it('keeps the mail password field visible when the email is prefilled', async () => {
    const password = host.querySelector<HTMLInputElement>('input[type="password"]');
    expect(password).not.toBeNull();
    expect(host.textContent).toContain('邮箱密码 / 授权码');
    expect(password!.placeholder).toBe('填写邮箱密码或服务商授权码');

    await act(async () => {
      Array.from(host.querySelectorAll('button')).find(button => button.textContent === '下一步')!.click();
    });

    expect(password!.placeholder).toBe('请填写邮箱密码或服务商授权码');
    expect(invoke).not.toHaveBeenCalledWith('accounts:upsert', expect.anything());
  });

  it('toggles advanced settings through the smooth controlled disclosure', async () => {
    const summary = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('高级设置'))!;
    const advanced = summary.closest('.ob-advanced')!;
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(advanced.classList.contains('open')).toBe(false);
    await act(async () => { summary.click(); });
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(advanced.classList.contains('open')).toBe(true);
    expect(host.querySelector('#ob-advanced-settings')?.getAttribute('aria-hidden')).toBe('false');
  });
});
