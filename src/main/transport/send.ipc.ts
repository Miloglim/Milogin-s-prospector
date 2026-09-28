import { ipcMain, BrowserWindow } from "electron";
import { IPC } from "../contract";
import { sendBcc } from "../adapters/smtp.adapter";
import * as SendService from "../services/send.service";
import * as CampaignService from "../services/campaign.service";
import { failResult, okResult } from "../errors";
import { saveConfig } from "../config";

function createPushFn() {
  return (c: string, d: unknown) => { try { BrowserWindow.getAllWindows()[0]?.webContents.send(c, d); } catch { /* */ } };
}

export function registerSendIPC() {
  SendService.setSendBccFn(sendBcc);
  SendService.setPushFn(createPushFn());
  SendService.setSaveConfigFn((c) => { try { saveConfig(c); } catch { /* */ } });

  ipcMain.handle(IPC.SEND.START, (_e, payload: { keys: string[]; templates?: SendService.SendTemplate[]; autoStart?: boolean; contactIds?: number[] }) => {
    const hasTargets = (payload?.keys && payload.keys.length > 0) || (payload?.contactIds && payload.contactIds.length > 0);
    if (!hasTargets) return failResult("请选择发送对象");
    // autoStart 缺省为 true 保持旧行为；前端传 false = 只入队，等队列页手动开始。contactIds 直选（新选人表格）优先于分桶 keys
    return SendService.startSend(payload.keys || [], payload.templates, payload.autoStart !== false, payload.contactIds);
  });
  ipcMain.handle(IPC.SEND.PAUSE, () => SendService.pauseSend());
  ipcMain.handle(IPC.SEND.RESUME, () => SendService.resumeSend());
  ipcMain.handle(IPC.SEND.CANCEL, () => SendService.cancelSend());
  ipcMain.handle(IPC.SEND.STATUS, () => SendService.getSendStatus());
  ipcMain.handle(IPC.SEND.GET_QUEUE, () => SendService.getQueueItems());
  ipcMain.handle(IPC.SEND.RESUME_QUEUE, () => SendService.resumeQueue());
  ipcMain.handle(IPC.SEND.GET_INTERRUPTED_BATCH, () => SendService.getInterruptedBatchStatus());
  ipcMain.handle(IPC.SEND.RESUME_INTERRUPTED_BATCH, () => SendService.resumeInterruptedBatch());
  ipcMain.handle(IPC.SEND.GET_TIME_BUCKETS, () => SendService.getTimeBuckets());
  ipcMain.handle(IPC.SEND.GET_STAGE_BUCKETS, () => SendService.getStageBuckets());
  ipcMain.handle(IPC.SEND.GET_SEND_TIME_BUCKETS, () => SendService.getSendTimeBuckets());
  ipcMain.handle(IPC.SEND.GET_PICKER_STATS, () => SendService.getPickerStats());
  ipcMain.handle(IPC.SEND.GET_QUOTA, () => ({ success: true as const, data: SendService.getQuotaStatus() }));
  ipcMain.handle(IPC.SEND.PREVIEW, (_e, payload) => {
    // 句库预览：{ lang, clientType, stage }
    if (typeof payload?.lang === "string") {
      return SendService.previewSentence(payload.lang, payload.clientType, payload.stage);
    }
    // 收件人预览：{ keys, templates? } — 无模板时自适应组装
    if (payload?.keys && Array.isArray(payload.keys)) {
      if (payload.keys.length === 0) return failResult("请选择至少一个时间桶");
      if (payload.templates && payload.templates.length > 0) {
        return SendService.buildQueue(payload.keys, payload.templates);
      }
      return SendService.buildAdaptiveQueue(payload.keys);
    }
    // 单模板预览：{ subject, body }
    if (!payload?.subject || !payload?.body) return failResult("模板不完整");
    return SendService.previewTemplate(payload);
  });

  ipcMain.handle(IPC.SEND.DYNAMIC, async (_e, input: { contactIds: number[]; subject: string; body: string; autoStart?: boolean; cc?: string }) => {
    if (!input?.contactIds || !Array.isArray(input.contactIds) || input.contactIds.length === 0) return failResult("请选择联系人");
    if (!input?.subject?.trim()) return failResult("主题必填");
    if (!input?.body?.trim()) return failResult("正文必填");
    const cc = (input.cc || "").trim();
    // 邮箱格式校验 — 地址写错会导致整批 SMTP 拒收
    if (cc) {
      const bad = cc.split(/[,;]/).map(s => s.trim()).filter(Boolean)
        .filter(e => !SendService.isValidEmail(e));
      if (bad.length > 0) return failResult(`抄送邮箱格式错误: ${bad.join(", ")}`);
    }
    return SendService.startDynamicSend(input.contactIds, input.subject, input.body, input.autoStart !== false, cc || undefined);
  });

  // ── 发信任务（Campaign，docs/smart-send-spec.md）────────────────
  ipcMain.handle(IPC.SEND.CAMPAIGNS, () => okResult(CampaignService.getCampaignOverview()));
  ipcMain.handle(IPC.SEND.CAMPAIGN_DETAIL, (_e, id: string) => {
    if (!id?.trim()) return failResult("缺少任务 id");
    return CampaignService.getCampaignDetail(id.trim());
  });
  ipcMain.handle(IPC.SEND.CAMPAIGN_CONTROL, (_e, input: { campaignId?: string; action?: string }) => {
    const action = (input?.action ?? "").trim().toLowerCase();
    if (!["pause", "resume", "stop", "restart"].includes(action)) return failResult("action 仅支持 pause/resume/stop/restart");
    if (!input?.campaignId?.trim()) return failResult("缺少任务 id");
    // restart：done → 新周期（fixed 轮内容已清空时转回草稿待补，service 内有完整判定）
    if (action === "restart") {
      const r = CampaignService.restartCampaign(input.campaignId.trim());
      if (r.success) void CampaignService.scanDueCampaigns();
      return r;
    }
    const status = action === "pause" ? "paused" : action === "resume" ? "running" : "stopped";
    const r = CampaignService.setCampaignStatus(input.campaignId.trim(), status);
    // 启动（草稿/暂停 → 运行）后立刻扫一轮到期触点：用户点了启动就该马上有动静，不等 10 分钟调度周期
    if (r.success && action === "resume") void CampaignService.scanDueCampaigns();
    return r;
  });
  // 任务创建向导（UI 入口）：预览 / 创建 / 草稿编辑。入参结构由 service 层校验，transport 只做存在性检查
  type CampaignInput = Parameters<typeof CampaignService.createCampaign>[0];
  ipcMain.handle(IPC.SEND.CAMPAIGN_PREVIEW, (_e, contactIds: number[]) => {
    if (!Array.isArray(contactIds)) return failResult("缺少名单");
    return CampaignService.previewCampaign(contactIds);
  });
  ipcMain.handle(IPC.SEND.CAMPAIGN_CREATE, (_e, input: CampaignInput) => {
    if (!input || typeof input !== "object") return failResult("缺少任务参数");
    const r = CampaignService.createCampaign({ ...input, createdBy: "ui" });
    // 创建即运行 → 立刻扫一轮到期触点，用户不用干等 10 分钟调度周期
    if (r.success && input.startNow !== false) void CampaignService.scanDueCampaigns();
    return r;
  });
  ipcMain.handle(IPC.SEND.CAMPAIGN_UPDATE_DRAFT, (_e, input: { campaignId?: string } & CampaignInput) => {
    if (!input?.campaignId?.trim()) return failResult("缺少任务 id");
    const { campaignId, ...rest } = input;
    return CampaignService.updateCampaignDraft(campaignId!.trim(), { ...rest, createdBy: "ui" });
  });
  // 删除任务（触点账本一起删，发送历史保留）；running/paused 由 service 拒删
  ipcMain.handle(IPC.SEND.CAMPAIGN_DELETE, (_e, id: string) => {
    if (!id?.trim()) return failResult("缺少任务 id");
    return CampaignService.deleteCampaign(id.trim());
  });

  ipcMain.handle(IPC.SEND.TEST, async (_e, input: {
    to: string; accountId: number; subject?: string; body?: string; contactId?: number;
  }) => {
    if (!input?.to) return failResult("收件人必填");
    if (!input?.accountId) return failResult("发件账号必填");

    return SendService.sendTestMessage(input);
  });
}
