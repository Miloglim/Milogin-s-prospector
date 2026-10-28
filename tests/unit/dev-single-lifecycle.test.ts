import { describe, expect, it, vi } from 'vitest';
import { preserveServerForRelaunch } from '../../scripts/dev-single-lifecycle.mjs';

describe('development launcher lifecycle', () => {
  it('keeps the page server for an account-switch relaunch', async () => {
    const stop = vi.fn();
    expect(await preserveServerForRelaunch({
      probe: () => true,
      stop,
      graceMs: 0,
      probeIntervalMs: 0,
    })).toBe(true);
    expect(stop).not.toHaveBeenCalled();
  });

  it('stops the page server when no replacement window appears', async () => {
    const stop = vi.fn();
    expect(await preserveServerForRelaunch({
      probe: () => false,
      stop,
      graceMs: 0,
      probeIntervalMs: 0,
    })).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });
});
