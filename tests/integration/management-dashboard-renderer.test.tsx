// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ProductManagement } from '../../admin-web/product-management';
import { api, ApiError } from '../../admin-web/api';
import type { Identity } from '../../server/core/auth';

const identity: Identity = { userId: 'admin', email: 'admin@example.invalid', displayName: '管理员', emailVerified: true, identityAdmin: true, mustChangePassword: false, crmRoles: ['admin'] };
const snapshot = { generatedAt: '2026-10-13T06:00:00.000Z', overview: { databases: 3, healthy: 2, activeUsers: 4, customers: 12, openTasks: 2, pendingEvents: 1 }, databases: [{ id: 'crm', name: 'Prospector 业务库', kind: 'PostgreSQL', state: 'healthy' as const, records: 12, updatedAt: null, detail: '客户', recordLabel: '客户' }], flows: [{ id: 'import', label: '导入 → 客户库', state: 'healthy' as const, records: 4, updatedAt: null, detail: '导入批次', recordLabel: '导入批次', timeLabel: '最近导入', stages: ['文件解析', '字段校验', '客户入库'] }], alerts: [], receipts: [] };
const navigatorSnapshot = { service: { status: 'ok' as const, backend: 'postgres', port: 8795 }, counts: { rates: 12, currentRates: 9, space: 3, groups: 4, activeGroups: 4, carriers: 2, pendingAwaiting: 5, pendingFailed: 1, reviewIssuesOpen: 2 }, latestMessage: '2026-10-19 10:00:00', entryUrl: 'http://127.0.0.1:8795' };

describe('Prospector management dashboard', () => {
  let root: Root; let host: HTMLDivElement;
  afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.restoreAllMocks(); });
  it('renders overview and switches to the data flow tag', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    vi.spyOn(api, 'dashboard').mockResolvedValue(snapshot);
    vi.spyOn(api, 'products').mockResolvedValue([{ productId: 'navigator', name: 'Navigator', connected: true, description: '中心身份、产品准入和运价库账号授权已接入', capabilities: [], roles: ['admin'], scope: 'summary' }]);
    vi.spyOn(api, 'users').mockResolvedValue({ items: [], total: 5 });
    vi.spyOn(api, 'navigatorDashboard').mockResolvedValue(navigatorSnapshot);
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => { root.render(<ProductManagement identity={identity} />); await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain('运行总览'); expect(host.textContent).toContain('导入 → 客户库');
    await act(async () => { root.render(<ProductManagement identity={identity} product="navigator" />); });
    expect(host.textContent).toContain('有效运价'); expect(host.textContent).toContain('待核问题'); expect(host.textContent).toContain('打开 Navigator 运价库'); expect(host.textContent).not.toContain('导入 → 客户库');
    await act(async () => { root.render(<ProductManagement identity={identity} product="prospector" />); });
    expect(host.textContent).toContain('运行总览');
    await act(async () => { (Array.from(host.querySelectorAll('button')).find(button => button.textContent === '数据流') as HTMLButtonElement).click(); });
    expect(host.textContent).toContain('文件解析'); expect(host.textContent).toContain('字段校验');
    vi.mocked(api.dashboard).mockRejectedValue(new ApiError('无数据看板权限',403));
    await act(async () => { (Array.from(host.querySelectorAll('button')).find(button => button.textContent?.replace(/\s/g,'') === '刷新') as HTMLButtonElement).click(); });
    expect(host.textContent).toContain('无数据看板权限'); expect(host.textContent).not.toContain('文件解析');
  });
});
