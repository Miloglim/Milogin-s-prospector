import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASSISTANT_WAKE_DEBOUNCE_MS, cancelAssistantWake, initAssistantBus, wakeAssistant } from '../../src/main/services/assistant-bus';

describe('assistant wake bus', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cancelAssistantWake();
    vi.useRealTimers();
  });

  it('coalesces a burst of source changes into one refresh', async () => {
    const refresh = vi.fn(async () => undefined);
    initAssistantBus(refresh);

    wakeAssistant('mail');
    wakeAssistant('task');
    wakeAssistant('mail');
    expect(refresh).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(ASSISTANT_WAKE_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith('mail,task');
  });

  it('ignores writes before the assistant transport is registered', async () => {
    wakeAssistant('mail');
    await vi.advanceTimersByTimeAsync(ASSISTANT_WAKE_DEBOUNCE_MS);
    expect(vi.getTimerCount()).toBe(0);
  });
});
