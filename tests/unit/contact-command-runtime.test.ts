import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }));
vi.mock('../../src/main/logger', () => ({ Log: { error: vi.fn() } }));
import { OnlineCrmAdapter } from '../../src/main/adapters/online-crm.adapter';
import { success } from '../../server/core/crm';

it('merges contact status into the existing sync IPC and routes only contact command resolutions', async () => {
  const ctx = { userId: 'alice', baseUrl: 'http://127.0.0.1:55844', permissionKey: 'sales', active: () => true, online: () => true };
  const legacy = { status: vi.fn(async () => success({ connection: 'online', syncing: false, pending: 2, failed: 0, conflicts: 0, issues: [] })), sync: vi.fn(), resolve: vi.fn(async () => success(undefined)) };
  const adapter = new OnlineCrmAdapter(fetch, undefined, undefined, legacy as never);
  vi.spyOn(adapter as never, 'crmContext').mockReturnValue(ctx);
  const commands = { status: () => ({ syncing: false, pending: 3, failed: 0, conflicts: 1, issues: [{ id: 'contact-command:one', status: 'conflict', message: 'conflict' }] }), sync: vi.fn(async () => success(undefined)), resolve: vi.fn(async () => success(undefined)) };
  adapter.setContactSync(commands as never);
  expect(await adapter.syncStatus()).toMatchObject({ ok: true, data: { pending: 5, conflicts: 1, issues: [{ id: 'contact-command:one' }] } });
  await adapter.syncNow();
  expect(commands.sync).toHaveBeenCalledTimes(1);
  await adapter.syncResolve({ id: 'contact-command:one', action: 'retry' });
  expect(commands.resolve).toHaveBeenCalledTimes(1);
  expect(legacy.resolve).not.toHaveBeenCalled();
  await adapter.syncResolve({ id: 'legacy-one', action: 'use-central' });
  expect(legacy.resolve).toHaveBeenCalledTimes(1);
});
