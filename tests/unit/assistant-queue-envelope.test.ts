import { describe, expect, it } from 'vitest';
import { assistantQueueItems } from '../../src/renderer/lib/assistant-queue';

const item = { reminderId: 'queue:t', kind: 'task', title: 't', detail: 'd', target: 'inbox:1', priority: 2, source: 'rule', createdAt: '2026-11-23T08:00:00Z' };

describe('assistant queue envelope', () => {
  it('accepts the shared Result envelope', () => {
    expect(assistantQueueItems({ success: true, data: [item] })).toEqual([item]);
  });

  it('accepts legacy ok envelopes and rejects failures', () => {
    expect(assistantQueueItems({ ok: true, data: [item] })).toEqual([item]);
    expect(assistantQueueItems({ success: false, error: 'x' })).toBeNull();
    expect(assistantQueueItems({ success: true, data: null })).toBeNull();
  });
});
