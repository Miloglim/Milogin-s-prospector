import { afterEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ search: vi.fn(), report: vi.fn(), draft: vi.fn(), summary: vi.fn() }));
vi.mock('../../src/main/services/ai.service', () => ({
  searchCompany: network.search, generateBackcheckReport: network.report,
  generateEmailDraft: network.draft, summarizeEmail: network.summary,
}));
vi.mock('../../src/main/db', () => ({ getDb: vi.fn() }));
vi.mock('../../src/main/services/artifact.service', () => ({ writeArtifact: vi.fn(() => ({ success: false })) }));
vi.mock('../../src/main/logger', () => ({ Log: { info: vi.fn(), error: vi.fn() } }));
import * as tasks from '../../src/main/services/bg-task.service';

afterEach(() => { tasks.cancelAll(); tasks.setBgTaskNetworkAllowed(() => true); vi.clearAllMocks(); });

describe('offline background AI boundary', () => {
  it('does not start any external task offline', () => {
    tasks.setBgTaskNetworkAllowed(() => false);
    expect(tasks.startTask(vi.fn(), { conversationId: 'synthetic', kind: 'draft', companies: [{ name: 'Synthetic Co' }] })).toMatchObject({ success: false });
    expect(network.draft).not.toHaveBeenCalled();
  });
  it('allows an in-flight search to settle but cancels its model stage even after reconnection', async () => {
    let finish!: (value: unknown) => void;
    network.search.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const result = tasks.startTask(vi.fn(), { conversationId: 'synthetic', kind: 'backcheck', companies: [{ name: 'Synthetic Co' }] });
    expect(result.success).toBe(true);
    expect(network.search).toHaveBeenCalledOnce();
    tasks.cancelAll();
    finish({ success: true, data: [{ title: 'Synthetic source' }] });
    await vi.waitFor(() => {
      expect(tasks.getTask(result.data!.taskId)).toMatchObject({ success: true, data: { state: 'cancelled' } });
    });
    expect(network.report).not.toHaveBeenCalled();
  });
});
