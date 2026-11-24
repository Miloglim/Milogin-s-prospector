import { ipcMain, shell } from "electron";
import { IPC } from "../contract";
import type { QuoteFilters } from "../services/rate-sync.service";
import { listQuotes } from "../adapters/navigator-quotes.adapter";
import { navigatorStatus, loginNavigator, logoutNavigator, fetchNavigatorImage, fetchNavigatorOptions } from "../adapters/navigator-auth.adapter";
import { clearNavigatorPartnerKey, ensureNavigatorPartnerKey, navigatorPartnerStatus, saveNavigatorPartnerKey } from "../adapters/navigator-partner.adapter";
import { okResult, failResult } from "../errors";

export function registerRatesIPC() {
  // Compatibility failure: the old channel can never trigger an anonymous mirror.
  ipcMain.handle(IPC.RATES.SYNC, () => failResult("运价已改为登录后实时查询，无需同步镜像"));

  // 条件查价
  ipcMain.handle(IPC.RATES.LIST, (_e, filters: QuoteFilters) => listQuotes(filters || {}));

  // 镜像统计
  ipcMain.handle(IPC.RATES.STATUS, () => navigatorStatus());
  const effectiveStatus = async () => {
    const oauth = await navigatorStatus();
    if (oauth.ok && oauth.data?.authenticated) return oauth;
    const partner = await navigatorPartnerStatus();
    if (partner.configured) return { ok: true as const, data: { authenticated: true, baseUrl: partner.baseUrl || '' } };
    return oauth;
  };
  ipcMain.handle(IPC.RATES.NAVIGATOR_STATUS, effectiveStatus);
  ipcMain.handle(IPC.RATES.PARTNER_STATUS, () => navigatorPartnerStatus());
  ipcMain.handle(IPC.RATES.PARTNER_ENSURE, async () => {
    try { const baseUrl = await ensureNavigatorPartnerKey(); return { ok: true as const, data: { configured: true, baseUrl } }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : 'Navigator 接口凭证获取失败' }; }
  });
  ipcMain.handle(IPC.RATES.PARTNER_SAVE, async (_e, key: string) => {
    try { const baseUrl = await saveNavigatorPartnerKey(String(key || '')); return { ok: true as const, data: { configured: true, baseUrl } }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : 'Navigator 接口凭证保存失败' }; }
  });
  ipcMain.handle(IPC.RATES.PARTNER_CLEAR, async () => { await clearNavigatorPartnerKey(); return { ok: true as const, data: { configured: false } }; });
  ipcMain.handle(IPC.RATES.NAVIGATOR_LOGIN, () => loginNavigator());
  ipcMain.handle(IPC.RATES.NAVIGATOR_LOGOUT, () => logoutNavigator());
  ipcMain.handle(IPC.RATES.IMAGE, (_e, name: string) => fetchNavigatorImage(name));
  ipcMain.handle(IPC.RATES.OPTIONS, () => fetchNavigatorOptions());

  // 在系统浏览器打开台账工作台（board_server 自带 web 界面；地址跟随 RATES_REMOTE_URL，不硬编码）。
  // 先探测局域网可达：不通就不开浏览器（免得留一个白屏标签），把错误回给界面提示。
  ipcMain.handle(IPC.RATES.OPEN_BOARD, async () => {
    const status = await effectiveStatus();
    if (!status.ok || !status.data?.baseUrl) return failResult(status.error || "请配置 Navigator 地址");
    await shell.openExternal(status.data.baseUrl);
    return okResult(undefined);
  });

}
