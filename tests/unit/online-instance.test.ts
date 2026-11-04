import { describe, expect, it, vi } from 'vitest';
import { resolveOnlineInstanceId } from '../../server/adapters/online-instance';

describe('online runtime instance id', () => {
  it('keeps a valid launcher-provided instance id', () => {
    const configured = 'a'.repeat(64);
    const generate = vi.fn(() => 'b'.repeat(64));

    expect(resolveOnlineInstanceId({ PROSPECTOR_ONLINE_INSTANCE: configured }, generate)).toBe(configured);
    expect(generate).not.toHaveBeenCalled();
  });

  it('generates an instance id when the container starts the server directly', () => {
    const generated = 'b'.repeat(64);

    expect(resolveOnlineInstanceId({}, () => generated)).toBe(generated);
  });

  it('rejects an explicitly configured invalid instance id', () => {
    expect(() => resolveOnlineInstanceId({ PROSPECTOR_ONLINE_INSTANCE: 'pod-name' }, () => 'b'.repeat(64)))
      .toThrow('本节点启动标识无效');
  });
});
