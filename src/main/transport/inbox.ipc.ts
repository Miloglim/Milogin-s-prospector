import { ipcMain, BrowserWindow } from "electron";
import { INBOX_EVENTS, type InboxFolderConfirmRequest, type InboxFolderSuggestionRequest, type InboxHistoryRequest, type InboxLabelDeleteRequest, type InboxLabelSaveRequest, type InboxListRequest, type InboxMessageLabelsRequest, type InboxPinMessageRequest, type InboxReadStateRequest, type InboxTodoBatchRequest, type InboxTodoStateRequest } from "../../shared/inbox";
import { IPC } from "../contract";
import * as InboxService from "../services/inbox.service";
import { todayMailBrief } from "../services/mail-brief.service";
import * as SendService from "../services/send.service";
import * as CampaignService from "../services/campaign.service";
import { failResult, okResult } from "../errors";
import { createInboxAnalysisService, type InboxAnalysisService } from "../services/inbox-analysis.service";
import { Log } from "../logger";
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

let inboxAnalysis: InboxAnalysisService | null = null;
let inboxAnalysisNotifyTimer: ReturnType<typeof setTimeout> | null = null;

export function registerInboxIPC(networkAllowed: () => boolean = () => true) {
  const pushToRenderer = createRendererPush();
  InboxService.setInboxNetworkAllowed(networkAllowed);
  InboxService.setImapFetchFn(doFetch);
  InboxService.setImapFetchBodyFn(fetchBody);
  InboxService.setInboxPushFn(pushToRenderer);
  InboxService.setPostFetchAdapters({ isPop3Port, backfillBounceDeep, detectSent });
  inboxAnalysis?.stop();
  inboxAnalysis = createInboxAnalysisService({
    onUpdated: messageId => {
      if (inboxAnalysisNotifyTimer) clearTimeout(inboxAnalysisNotifyTimer);
      inboxAnalysisNotifyTimer = setTimeout(() => {
        inboxAnalysisNotifyTimer = null;
        pushToRenderer(INBOX_EVENTS.ANALYSIS_UPDATED, { messageId });
      }, 500);
    },
  });
  InboxService.setInboxAfterFetchAnalysis(() => { inboxAnalysis?.enqueueRecent(200); });
  setNetPushFn(pushToRenderer);
  InboxService.startAutoFetch();
  // 智能发信任务（docs/smart-send-spec.md）：注入队列入口 + 启动到期触点调度器
  CampaignService.setCampaignNetworkAllowed(networkAllowed);
  CampaignService.setCampaignQueueFn(async (items, autoStart, opts) => networkAllowed()
    ? SendService.startQueue(items, autoStart, opts) : failResult('当前离线，无法启动发送任务。'));
  CampaignService.startCampaignScheduler();

  ipcMain.handle(IPC.INBOX.LIST, async (_e, request?: InboxListRequest) => {
    return InboxService.listInbox(request);
  });
  ipcMain.handle(IPC.INBOX.FETCH, async (_e, accountId?: number) => {
    return InboxService.refreshInbox(accountId);
  });
  ipcMain.handle(IPC.INBOX.SYNC_STATE, () => InboxService.inboxSyncSnapshot());
  ipcMain.handle(IPC.INBOX.SYNC_HISTORY, async (_e, input?: InboxHistoryRequest) => InboxService.refreshInboxHistory(input));
  ipcMain.handle(IPC.INBOX.CLASSIFY, async (_e, payload: { id: number; classification: string }) => {
    if (!payload?.id || !payload?.classification) return failResult("参数错误");
    return InboxService.classifyMessage(payload.id, payload.classification);
  });
  ipcMain.handle(IPC.INBOX.MARK_READ, async (_e, id: number) => {
    if (!Number.isInteger(id) || id <= 0) return failResult("参数错误");
    return InboxService.markRead(id);
  });
  ipcMain.handle(IPC.INBOX.SET_READ_STATE, async (_e, input: InboxReadStateRequest) => InboxService.setInboxReadState(input));
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
  ipcMain.handle(IPC.INBOX.LABELS, () => InboxService.listInboxLabels());
  ipcMain.handle(IPC.INBOX.LABEL_SAVE, async (_e, input: InboxLabelSaveRequest) => InboxService.saveInboxLabel(input));
  ipcMain.handle(IPC.INBOX.LABEL_DELETE, async (_e, input: InboxLabelDeleteRequest) => InboxService.deleteInboxLabel(input));
  ipcMain.handle(IPC.INBOX.MESSAGE_LABELS, async (_e, input: InboxMessageLabelsRequest) => InboxService.setInboxMessageLabels(input));
  ipcMain.handle(IPC.INBOX.FOLDER_SUGGEST, async (_e, input: InboxFolderSuggestionRequest) => InboxService.suggestInboxFolders(input));
  ipcMain.handle(IPC.INBOX.FOLDER_CONFIRM, async (_e, input: InboxFolderConfirmRequest) => InboxService.confirmInboxFolder(input));
  ipcMain.handle(IPC.INBOX.PIN_MESSAGE, async (_e, input: InboxPinMessageRequest) => InboxService.setInboxMessagePinned(input));
  ipcMain.handle(IPC.INBOX.TODO_STATE, async (_e, input: InboxTodoStateRequest) => InboxService.setInboxTodoState(input));
  ipcMain.handle(IPC.INBOX.TODO_STATE_BATCH, async (_e, input: InboxTodoBatchRequest) => InboxService.setInboxTodoStateBatch(input));
  ipcMain.handle(IPC.INBOX.ANALYSIS_STATUS, () => okResult(inboxAnalysis?.status() ?? { enabled: false, pending: 0, ready: 0, failed: 0 }));
  ipcMain.handle(IPC.INBOX.ANALYSIS_RUN, async (_e, messageId?: number) => {
    if (!inboxAnalysis) return failResult('收件箱分析服务未启动');
    if (messageId !== undefined) {
      if (!Number.isSafeInteger(messageId) || messageId <= 0) return failResult('无效的邮件 ID');
      return okResult({ queued: inboxAnalysis.retry(messageId) ? 1 : 0 });
    }
    return okResult({ queued: inboxAnalysis.enqueueRecent(200) });
  });

  // 首页「今日邮箱概览」：只读快照，不抓取、不改已读状态（docs/home-cards-spec.md §5）
  ipcMain.handle(IPC.INBOX.TODAY_BRIEF, () => todayMailBrief());
}

export function startInboxAnalysis(): void {
  try { inboxAnalysis?.enqueueRecent(200); }
  catch (error) { Log.warn('inbox.analysis', `启动回填失败: ${error instanceof Error ? error.message : String(error)}`); }
}

export function cleanupInboxIPC() {
  InboxService.stopAutoFetch();
  InboxService.setInboxAfterFetchAnalysis(null);
  inboxAnalysis?.stop();
  inboxAnalysis = null;
  if (inboxAnalysisNotifyTimer) { clearTimeout(inboxAnalysisNotifyTimer); inboxAnalysisNotifyTimer = null; }
}

/** Suspend future automatic sends when the center becomes unavailable; in-flight SMTP may finish. */
export function suspendLocalNetworkWork(): () => void {
  CampaignService.suspendAutomaticCampaignScheduling();
  const status = SendService.getSendStatus();
  const resumePausedSend = status.success && status.data.isRunning && !status.data.isPaused;
  if (status.success && status.data.isRunning) SendService.pauseSend();
  return () => {
    CampaignService.resumeAutomaticCampaignScheduling();
    if (resumePausedSend) SendService.resumeSend();
  };
}
