import { ipcMain, BrowserWindow } from "electron";
import { IPC } from "../contract";
import * as InboxService from "../services/inbox.service";
import { todayMailBrief } from "../services/mail-brief.service";
import * as SendService from "../services/send.service";
import * as CampaignService from "../services/campaign.service";
import { failResult } from "../errors";
import {
  isPop3Port,
  doFetch,
  fetchBody,
  backfillBounceDeep,
  detectSent,
  setNetPushFn,
} from "../services/inbox-net.service";

// ── 收件箱 IPC 注册层 ──
// 只做通道注册与参数转接；抓取/协议/查询业务在 services/inbox-net.service.ts 与 inbox.service.ts。

function createRendererPush() {
  return (channel: string, data: unknown) => {
    try { BrowserWindow.getAllWindows()[0]?.webContents.send(channel, data); } catch { /* */ }
  };
}

export function registerInboxIPC() {
  const pushToRenderer = createRendererPush();
  InboxService.setImapFetchFn(doFetch);
  InboxService.setImapFetchBodyFn(fetchBody);
  InboxService.setInboxPushFn(pushToRenderer);
  InboxService.setPostFetchAdapters({ isPop3Port, backfillBounceDeep, detectSent });
  setNetPushFn(pushToRenderer);
  InboxService.startAutoFetch();
  // 智能发信任务（docs/smart-send-spec.md）：注入队列入口 + 启动到期触点调度器
  CampaignService.setCampaignQueueFn((items, autoStart, opts) => SendService.startQueue(items, autoStart, opts));
  CampaignService.startCampaignScheduler();

  ipcMain.handle(IPC.INBOX.LIST, async () => {
    return InboxService.listInbox();
  });
  ipcMain.handle(IPC.INBOX.FETCH, async (_e, accountId?: number) => {
    return InboxService.refreshInbox(accountId);
  });
  ipcMain.handle(IPC.INBOX.CLASSIFY, async (_e, payload: { id: number; classification: string }) => {
    if (!payload?.id || !payload?.classification) return failResult("参数错误");
    return InboxService.classifyMessage(payload.id, payload.classification);
  });
  ipcMain.handle(IPC.INBOX.MARK_READ, async (_e, id: number) => {
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误");
    return InboxService.markRead(id);
  });
  ipcMain.handle(IPC.INBOX.DELETE, async (_e, id: number) => {
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误");
    return InboxService.deleteMessage(id);
  });
  ipcMain.handle(IPC.INBOX.DELETE_BOUNCE, async () => {
    return InboxService.deleteAllBounce();
  });
  ipcMain.handle(IPC.INBOX.BOUNCE_MATCH_STATS, async () => {
    return InboxService.bounceMatchStats();
  });
  ipcMain.handle(IPC.INBOX.BOUNCE_MATCHES, async (_e, id: number) => {
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误");
    return InboxService.bounceMatchesOf(id);
  });
  ipcMain.handle(IPC.INBOX.GET_BODY, async (_e, id: number) => {
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误");
    return await InboxService.getBody(id);
  });

  // 首页「今日邮箱概览」：只读快照，不抓取、不改已读状态（docs/home-cards-spec.md §5）
  ipcMain.handle(IPC.INBOX.TODAY_BRIEF, () => todayMailBrief());
}

export function cleanupInboxIPC() {
  InboxService.stopAutoFetch();
}
