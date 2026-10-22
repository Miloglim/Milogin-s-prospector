// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api, ApiError } from '../../admin-web/api';
import { OperationsManagement } from '../../admin-web/operations-management';
import type { Identity } from '../../server/core/auth';
import type { OperationsSummary } from '../../server/core/management-dashboard';

const identity: Identity = { userId: 'admin', email: 'admin@example.invalid', displayName: '管理员', emailVerified: true, identityAdmin: true, mustChangePassword: false, crmRoles: ['admin'] };
const snapshot: OperationsSummary = {
  generatedAt: '2026-10-21T10:00:00.000Z', version: '0.55.0-alpha.1', uptime_seconds: 3660,
  checks: [
    { id: 'center', label: '中心服务', state: 'healthy', value: 'v0.55.0-alpha.1', valueLabel: '当前版本', detail: '中心 API 与管理工作台正常响应' },
    { id: 'database', label: 'PostgreSQL', state: 'healthy', value: '128 MB', valueLabel: '数据库大小', detail: '中心业务库连接正常' },
    { id: 'disk', label: '服务器磁盘', state: 'healthy', value: '40.0%', valueLabel: '已使用', detail: '可用 60 GB / 100 GB' },
    { id: 'navigator', label: 'Navigator', state: 'healthy', value: '正常', valueLabel: '服务状态', detail: 'PostgreSQL后端可用' },
    { id: 'backup', label: '自动备份', state: 'not_connected', value: '未接入', valueLabel: '备份监控', detail: '尚未读取服务器备份目录' },
  ],
};

describe('system operations dashboard', () => {
  let root: Root; let host: HTMLDivElement;
  afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.restoreAllMocks(); });
  it('renders read-only service and capacity checks', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    vi.spyOn(api, 'operations').mockResolvedValue(snapshot);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => { root.render(<OperationsManagement identity={identity} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('中心服务'); expect(host.textContent).toContain('PostgreSQL');
    expect(host.textContent).toContain('Navigator'); expect(host.textContent).toContain('自动备份');
    expect(host.textContent).toContain('1小时 1分钟');
    vi.mocked(api.operations).mockRejectedValue(new ApiError('系统运行暂不可用', 503));
    await act(async () => { (Array.from(host.querySelectorAll('button')).find(button => button.textContent?.replace(/\s/g, '') === '刷新') as HTMLButtonElement).click(); });
    expect(host.textContent).toContain('刷新失败，当前显示上次数据');
  });
});
