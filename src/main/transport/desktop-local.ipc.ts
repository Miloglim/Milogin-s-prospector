import { ipcMain } from 'electron';
import { IPC } from '../contract';
import type { DesktopLocalScope, LocalScopeFailure } from '../adapters/desktop-local-scope.adapter';

function localChannels(): string[] {
  return Object.entries(IPC)
    .filter(([domain]) => domain !== 'ONLINE' && domain !== 'UPDATE')
    .flatMap(([, channels]) => Object.values(channels));
}

/** All personal calls fail closed before a verified, bound profile is initialized. */
export function registerLockedLocalIPC(version: string, failure: () => LocalScopeFailure): void {
  ipcMain.handle(IPC.SYSTEM.APP_VERSION, () => ({ success: true, data: version }));
  for (const channel of localChannels()) {
    if (channel !== IPC.SYSTEM.APP_VERSION) ipcMain.handle(channel, failure);
  }
}

/** Registration is synchronous; startup owns service loading and database readiness. */
export function registerGuardedLocalIPC(scope: DesktopLocalScope, registrars: Array<() => void>): void {
  for (const channel of localChannels()) {
    // 重启确认属于会话级通道，不能随账号本地资料切换移除。
    if (channel !== IPC.SYSTEM.RESTART_CONFIRM) ipcMain.removeHandler(channel);
  }
  // The main-process guard covers configuration, diagnostics and import handlers too.
  const originalHandle = ipcMain.handle;
  ipcMain.handle = (channel, listener) => originalHandle.call(ipcMain, channel, scope.guard(listener, channel));
  try {
    for (const register of registrars) register();
  } finally {
    ipcMain.handle = originalHandle;
  }
}
