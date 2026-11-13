import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ fail: false }));

vi.mock('../../src/main/db', () => ({
  getRawDb: () => ({
    prepare(sql: string) {
      return {
        get() {
          if (state.fail) throw new Error('fixture read failure');
          if (sql.includes('templates')) return { count: 2 };
          if (sql.includes('inbox_labels')) return { count: 3 };
          if (sql.includes('send_queue')) return { count: 4 };
          if (sql.includes('send_campaigns')) return { count: 5 };
          if (sql.includes('inbox_classification_changes')) return { count: 6 };
          return { count: 0 };
        },
      };
    },
  }),
}));

import { inspectLocalHandoffData } from '../../src/main/services/device-handoff.service';

describe('device handoff local inspection', () => {
  beforeEach(() => { state.fail = false; });

  it('reports local migration blockers without exposing row contents', () => {
    const result = inspectLocalHandoffData();
    expect(result.counts).toMatchObject({ templates: 2, inboxLabels: 3, queuedSends: 4, activeCampaigns: 5, pendingMailChanges: 6 });
    expect(result.blockers).toEqual([]);
  });

  it('fails closed with a migration blocker when local data cannot be read', () => {
    state.fail = true;
    const result = inspectLocalHandoffData();
    expect(result.blockers).toEqual(['原电脑本地数据暂时无法读取，请确认数据已经同步后再继续']);
  });
});
