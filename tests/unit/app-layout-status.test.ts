import { describe, expect, it } from 'vitest';
import { GLOBAL_STATUS_TOAST_DURATION_SECONDS, globalStatusNotices } from '../../src/renderer/components/layout/app-layout-status';

describe('global app status notices', () => {
  it('uses a five-second floating notice and preserves the three shell states', () => {
    expect(GLOBAL_STATUS_TOAST_DURATION_SECONDS).toBe(5);
    expect(globalStatusNotices({ offline: true, centerUnavailable: false, localAvailable: true, pathname: '/inbox' })).toEqual([
      { key: 'offline', type: 'warning', content: '离线 · 本地工作区' },
    ]);
    expect(globalStatusNotices({ offline: false, centerUnavailable: true, localAvailable: true, pathname: '/customers' })).toEqual([
      { key: 'center-unavailable', type: 'info', content: '此页面需要连接服务器' },
    ]);
    expect(globalStatusNotices({ offline: false, centerUnavailable: false, localAvailable: false, pathname: '/rates' })).toEqual([
      { key: 'feature-unavailable', type: 'info', content: '此功能暂未开放' },
    ]);
  });

  it('does not show the unavailable feature notice for locally available routes', () => {
    expect(globalStatusNotices({ offline: false, centerUnavailable: false, localAvailable: false, pathname: '/messages' })).toEqual([]);
  });
});
