import { ipcMain, BrowserWindow } from "electron";
import { IPC } from "../contract";
import * as InboxService from "../services/inbox.service";
import { todayMailBrief } from "../services/mail-brief.service";
import * as SendService from "../services/send.service";
import * as CampaignService from "../services/campaign.service";
import { nudge as nudgeSuggestions } from "../services/suggestion-bus";
import { Log } from "../logger";
import { failResult } from "../errors";
import { getDb } from "../db";
import { emailAccounts } from "../db/schema/accounts";
import { eq } from "drizzle-orm";
import {
  isPop3Port,
  doFetch,
  fetchBody,
  backfillBounceDeep,
  detectSent,
  setNetPushFn,
} from "../services/inbox-net.service";

// ── 收件箱 IPC 注册层 ──
// 只做通道注册与参数转接；抓取/协议/查询业务在 services/inbox-net.service.ts 与 inbox.service.ts
// （transport 不 import db 的规范约束：仅 FETCH 聚合里读账号列表，属注册层编排，逻辑保持最小）

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
  setNetPushFn(pushToRenderer);
  InboxService.startAutoFetch();
  // 智能发信任务（docs/smart-send-spec.md）：注入队列入口 + 启动到期触点调度器
  CampaignService.setCampaignQueueFn((items, autoStart, opts) => SendService.startQueue(items, autoStart, opts));
  CampaignService.startCampaignScheduler();

  ipcMain.handle(IPC.INBOX.LIST, async () => {
    return InboxService.listInbox();
  });
  ipcMain.handle(IPC.INBOX.FETCH, async (_e, accountId?: number) => {
    await InboxService.fetchInbox(accountId);
    InboxService.cleanupInbox();
    // 后台预加载前 20 封正文（不阻塞返回，读条结束后前端即可秒开前 20 封）
    void InboxService.prefetchRecentBodies(20);
    // 后台补匹配退信联系人：先扫本地正文（免费），再对更早的存量走 IMAP 深度补拉。
    // 串行执行，避免和 prefetch/detectSent 叠加过多 IMAP 连接。
    void (async () => {
      let n = await InboxService.backfillBounceMatches();
      const targets = accountId
        ? [accountId]
        : getDb().select({ id: emailAccounts.id }).from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all().map(a => a.id);
      for (const aid of targets) n += await backfillBounceDeep(aid);
      if (n > 0) { BrowserWindow.getAllWindows()[0]?.webContents.send("inbox:newMail", { count: 0 }); nudgeSuggestions(); }
    })().catch(err => Log.error("inbox.backfill", "退信补匹配失败", err instanceof Error ? err.stack : undefined));
    // 后台检测 Sent 文件夹（不阻塞返回，完成后推送通知刷新前端）
    const accounts = getDb().select().from(emailAccounts).where(eq(emailAccounts.isActive, 1)).all();
    const sentTargets = accounts.filter(a => !isPop3Port(a.imapPort || 993));
    Log.debug("inbox.sent", `将检测 ${sentTargets.length}/${accounts.length} 个账号`);
    Promise.allSettled(sentTargets.map(a => detectSent(a.id))).then((results) => {
      const totalNew = results.reduce((sum, r) => {
        return sum + (r.status === "fulfilled" ? (r.value || 0) : 0);
      }, 0);
      if (totalNew > 0) {
        try {
          InboxService.cleanupInbox();
          BrowserWindow.getAllWindows()[0]?.webContents.send("inbox:newMail", { count: totalNew });
          nudgeSuggestions();
        } catch { /* */ }
      }
    });
    return InboxService.listInbox();
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
