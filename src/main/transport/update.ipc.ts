import { ipcMain } from "electron";
import { IPC } from "../contract";
import {
  listVersions,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  setUpdateChannel,
  getUpdateChannel,
} from "../updater";

// ── 自动更新 IPC 注册层 ──
// 只做通道注册与参数转接，业务逻辑在 updater.ts（transport 不写业务）
export function registerUpdateIPC() {
  ipcMain.handle(IPC.UPDATE.LIST_VERSIONS, listVersions);
  ipcMain.handle(IPC.UPDATE.CHECK, checkForUpdate);
  ipcMain.handle(IPC.UPDATE.DOWNLOAD, downloadUpdate);
  ipcMain.handle(IPC.UPDATE.INSTALL, installUpdate);
  ipcMain.handle(IPC.UPDATE.SET_CHANNEL, (_e, ch: string) => setUpdateChannel(ch));
  ipcMain.handle(IPC.UPDATE.GET_CHANNEL, getUpdateChannel);
}
