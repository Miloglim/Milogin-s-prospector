import { ipcMain, shell } from "electron";
import { IPC } from "../contract";
import type { QuoteFilters } from "../services/rate-sync.service";
import { listQuotes } from "../adapters/navigator-quotes.adapter";
import { navigatorStatus, loginNavigator, logoutNavigator, fetchNavigatorImage, fetchNavigatorOptions } from "../adapters/navigator-auth.adapter";
import { okResult, failResult } from "../errors";

export function registerRatesIPC() {
  // Compatibility failure: the old channel can never trigger an anonymous mirror.
  ipcMain.handle(IPC.RATES.SYNC, () => failResult("运价已改为登录后实时查询，无需同步镜像"));

  // 条件查价
  ipcMain.handle(IPC.RATES.LIST, (_e, filters: QuoteFilters) => listQuotes(filters || {}));

  // 镜像统计
  ipcMain.handle(IPC.RATES.STATUS, () => navigatorStatus());
  ipcMain.handle(IPC.RATES.NAVIGATOR_STATUS, () => navigatorStatus());
  ipcMain.handle(IPC.RATES.NAVIGATOR_LOGIN, () => loginNavigator());
  ipcMain.handle(IPC.RATES.NAVIGATOR_LOGOUT, () => logoutNavigator());
  ipcMain.handle(IPC.RATES.IMAGE, (_e, name: string) => fetchNavigatorImage(name));
  ipcMain.handle(IPC.RATES.OPTIONS, () => fetchNavigatorOptions());

  // 在系统浏览器打开台账工作台（board_server 自带 web 界面；地址跟随 RATES_REMOTE_URL，不硬编码）。
  // 先探测局域网可达：不通就不开浏览器（免得留一个白屏标签），把错误回给界面提示。
  ipcMain.handle(IPC.RATES.OPEN_BOARD, async () => {
    const status = await navigatorStatus();
    if (!status.ok || !status.data?.baseUrl) return failResult(status.error || "请配置 Navigator 地址");
    await shell.openExternal(status.data.baseUrl);
    return okResult(undefined);
  });

}
