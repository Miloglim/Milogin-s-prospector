// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisiblePolling } from '../../src/renderer/hooks/useVisiblePolling';

function setVisibility(value: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value });
  document.dispatchEvent(new Event('visibilitychange'));
}

function Probe({ callback }: { callback: () => void | Promise<void> }) {
  useVisiblePolling(callback, 5000);
  return null;
}

describe('visible polling', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    setVisibility('visible');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });
  it('pauses while hidden and refreshes immediately when visible', async () => {
    const callback = vi.fn();
    await act(async () => root.render(<Probe callback={callback} />));
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(callback).toHaveBeenCalledTimes(1);
    await act(async () => { setVisibility('hidden'); vi.advanceTimersByTime(10000); });
    expect(callback).toHaveBeenCalledTimes(1);
    await act(async () => { setVisibility('visible'); });
    expect(callback).toHaveBeenCalledTimes(2);
  });
  it('does not overlap a still-running refresh', async () => {
    let finish!: () => void;
    const callback = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    await act(async () => root.render(<Probe callback={callback} />));
    await act(async () => { vi.advanceTimersByTime(20000); });
    expect(callback).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); await Promise.resolve(); await Promise.resolve(); await vi.advanceTimersByTimeAsync(5000); });
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
