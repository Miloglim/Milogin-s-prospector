import { BrowserWindow, ipcMain } from 'electron';
import { IPC } from '../contract';
import { EVENTS } from '../events';
import { okResult, failResult } from '../errors';
import { Log } from '../logger';
import { createAssistantService } from '../services/assistant-check.service';
import { initAssistantBus, wakeAssistant } from '../services/assistant-bus';
import { onOnlineResponse } from './online-crm.ipc';
import type { AssistantSettings, AssistantSnapshot } from '../../shared/assistant';

const ONLINE_WAKE_PATHS = ['/api/crm/tasks', '/api/crm/quote-cases', '/api/crm/sales-cases'] as const;

function broadcast(snapshot: AssistantSnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(EVENTS.ASSISTANT_UPDATED, snapshot);
  }
}

export function registerAssistantIPC(): void {
  const service = createAssistantService();
  initAssistantBus(async reason => {
    try {
      const result = await service.wake();
      if (result.ran) broadcast(result);
    } catch (error) {
      Log.warn('assistant.wake', `提醒刷新失败 (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  onOnlineResponse((_context, method, path) => {
    if (method === 'GET') return;
    if (ONLINE_WAKE_PATHS.some(prefix => path.startsWith(prefix))) wakeAssistant(`online:${path.split('?')[0]}`);
  });
  ipcMain.handle(IPC.ASSISTANT.SNAPSHOT, () => {
    try { return okResult(service.snapshot()); }
    catch (error) { Log.warn('assistant.ipc', `读取提醒失败: ${error instanceof Error ? error.message : String(error)}`); return failResult('提醒暂不可用'); }
  });
  ipcMain.handle(IPC.ASSISTANT.QUEUE, async () => {
    try { return okResult(await service.queue()); }
    catch (error) { Log.warn('assistant.ipc', `读取任务队列失败: ${error instanceof Error ? error.message : String(error)}`); return failResult('任务队列暂不可用'); }
  });
  ipcMain.handle(IPC.ASSISTANT.RUN, async (_event, force?: unknown) => {
    try { const result = await service.run(force === true); broadcast(result); return okResult(result); }
    catch (error) { Log.warn('assistant.ipc', `巡检失败: ${error instanceof Error ? error.message : String(error)}`); return failResult('巡检暂不可用'); }
  });
  ipcMain.handle(IPC.ASSISTANT.DISMISS, (_event, reminderId?: unknown) => {
    try { const snapshot = service.dismiss(typeof reminderId === 'string' ? reminderId : ''); broadcast(snapshot); return okResult(snapshot); }
    catch { return failResult('提醒暂不可用'); }
  });
  ipcMain.handle(IPC.ASSISTANT.SETTINGS_UPDATE, (_event, patch?: unknown) => {
    try {
      const value = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch as Partial<AssistantSettings> : {};
      const snapshot = service.updateSettings(value); broadcast(snapshot); return okResult(snapshot);
    } catch { return failResult('巡检设置保存失败'); }
  });
}
