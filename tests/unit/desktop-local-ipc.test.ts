import { beforeEach, describe, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return { handlers, ipcMain: {
    handle: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => { handlers.set(channel, listener); }),
    removeHandler: vi.fn((channel: string) => { handlers.delete(channel); }),
  } };
});
vi.mock('electron', () => ({ ipcMain: electron.ipcMain }));
import { IPC } from '../../src/main/contract';
import { registerGuardedLocalIPC, registerLockedLocalIPC } from '../../src/main/transport/desktop-local.ipc';
import type { DesktopLocalScope } from '../../src/main/adapters/desktop-local-scope.adapter';
const failure = { success: false as const, code: 'UNAUTHORIZED' as const, error: 'synthetic login required' };
beforeEach(() => { electron.handlers.clear(); vi.clearAllMocks(); });

describe('central desktop local IPC boundary', () => {
  it('locks every personal channel without overriding online or updater channels', () => {
    const online = vi.fn();
    electron.handlers.set(IPC.ONLINE.STATUS, online);
    registerLockedLocalIPC('synthetic-version', () => failure);
    for (const [domain, channels] of Object.entries(IPC)) {
      if (domain === 'ONLINE' || domain === 'UPDATE') continue;
      for (const channel of Object.values(channels)) {
        const result = electron.handlers.get(channel)!();
        expect(result).toEqual(channel === IPC.SYSTEM.APP_VERSION ? { success: true, data: 'synthetic-version' } : failure);
      }
    }
    expect(electron.handlers.get(IPC.ONLINE.STATUS)).toBe(online);
    expect(electron.handlers.has(IPC.UPDATE.CHECK)).toBe(false);
  });

  it('wraps all registered legacy handlers before exposing them and restores Electron registration', async () => {
    registerLockedLocalIPC('synthetic-version', () => failure);
    const original = electron.ipcMain.handle;
    const guard = vi.fn((handler: (...args: unknown[]) => unknown) => handler);
    registerGuardedLocalIPC({ guard } as unknown as DesktopLocalScope, [
      () => electron.ipcMain.handle(IPC.SYSTEM.GET_CONFIG, () => 'synthetic config'),
      () => electron.ipcMain.handle(IPC.CONTACTS.LIST, () => 'synthetic contacts'),
    ]);
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenCalledWith(expect.any(Function), IPC.SYSTEM.GET_CONFIG);
    expect(guard).toHaveBeenCalledWith(expect.any(Function), IPC.CONTACTS.LIST);
    expect(electron.ipcMain.handle).toBe(original);
    expect(await electron.handlers.get(IPC.SYSTEM.GET_CONFIG)!()).toBe('synthetic config');
    expect(electron.handlers.has(IPC.INBOX.FETCH)).toBe(false);
  });

  it('restores the original registration method if a registrar fails', () => {
    const original = electron.ipcMain.handle;
    const guard = (handler: (...args: unknown[]) => unknown) => handler;
    expect(() => registerGuardedLocalIPC({ guard } as unknown as DesktopLocalScope, [
      () => { throw new Error('synthetic registration error'); },
    ])).toThrow('synthetic registration error');
    expect(electron.ipcMain.handle).toBe(original);
  });
});
