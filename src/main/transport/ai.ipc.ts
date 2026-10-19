import { getAgentContactPort } from "../services/agent-contact.service";
import { contactRef } from "../../../server/services/contact-assignments";
import { ipcMain } from "electron";
import { IPC } from "../contract";
import * as Ai from "../services/ai.service";
import * as Provider from "../services/provider.service";
import * as NetProxy from "../net-proxy";
import { getBackcheckReport, saveBackcheck } from "../services/company.service";
import { failResult } from "../errors";
import { Log } from "../logger";
import { canSendToContact } from '../core/contact-permissions';

export function registerAiIPC() {
  // 配置状态
  ipcMain.handle(IPC.AI.STATUS, () => ({ success: true as const, data: Ai.isAiConfigured() }));

  // API 密钥状态（不返回明文）
  ipcMain.handle(IPC.AI.GET_KEYS, () => Ai.getApiKeyStatus());
  // 写入密钥到 .env（空值=清除）
  ipcMain.handle(IPC.AI.SET_KEY, (_e, input: { name?: string; value?: string }) => {
    if (!input?.name) return failResult("缺少密钥名");
    return Ai.setApiKey(input.name as Ai.ApiKeyName, input.value ?? "");
  });

  // Center research returns a report only; writing a shared company is a separate authorized command.
  ipcMain.handle(IPC.AI.BACKCHECK, async (_e, input: Ai.BackcheckInput) => {
    if (!input?.companyName?.trim()) return failResult("请填写公司名");
    const center = input.centerReference ? getAgentContactPort()?.snapshot() : undefined;
    if (input.centerReference && (!contactRef(input.centerReference).ok || !center?.ok || !center.data.active() || !center.data.contacts.some(row => row.contactId === input.centerReference!.contactId && row.customerId === input.centerReference!.customerId))) return failResult('中心联系人不存在或会话已变化');
    const centerContact=center?.ok?center.data.contacts.find(row=>row.contactId===input.centerReference!.contactId&&row.customerId===input.centerReference!.customerId):undefined;
    if(centerContact&&!canSendToContact(centerContact)&&centerContact.canEdit!==true)return failResult('当前没有该联系人的开发权限');
    Log.debug("ai.backcheck", input.companyName);
    const hits = await Ai.searchCompany(input.companyName + (input.website ? " " + input.website : ""));
    if (!hits.success) return hits;
    const report = await Ai.generateBackcheckReport(input, hits.data);
    if (!report.success) return report;
    if (center?.ok) {
      if (!center.data.active()) return failResult('账号或权限已变化');
      return {success:true as const,data:{report:report.data,companyId:centerContact!.companyId}};
    }
    const saved = await saveBackcheck({
      name: input.companyName.trim(),
      domain: input.website ? input.website.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : undefined,
      report: report.data,
    });
    if (!saved.success) return saved;

    return { success: true as const, data: {
      report: report.data,
      companyId: saved.data.id,
      clientType: saved.data.clientType,
    } };
  });

  // AI 开发信：自动带上该公司已存的背调报告（若有）
  ipcMain.handle(IPC.AI.GENERATE_DRAFT, async (_e, input: Ai.EmailDraftInput) => {
    if (!input?.companyName?.trim() || !input?.contactName?.trim()) return failResult("公司名和联系人必填");
    if (!input.language) return failResult("请选择语言");
    const backcheck = getBackcheckReport(input.companyName) as Ai.BackcheckReport | null;
    return Ai.generateEmailDraft({ ...input, backcheck });
  });

  // AI 邮件总结
  ipcMain.handle(IPC.AI.SUMMARIZE_EMAIL, async (_e, input: Ai.EmailSummaryInput) => {
    if (!input?.subject && !input?.bodyPreview) return failResult("邮件内容为空");
    return Ai.summarizeEmail(input);
  });

  // ── 模型端点管理：密钥只进 .env；激活即写生效参数，本次运行立即生效（无需重启）──
  ipcMain.handle(IPC.AI.ENDPOINT_STATUS, () => Provider.getEndpointStatus());
  ipcMain.handle(IPC.AI.PROFILES, () => Provider.listProfiles());
  ipcMain.handle(IPC.AI.PROFILE_UPSERT, (_e, input: Provider.ProfileInput) => Provider.upsertProfile(input));
  ipcMain.handle(IPC.AI.PROFILE_DELETE, (_e, id: string) => Provider.deleteProfile(id));
  ipcMain.handle(IPC.AI.PROFILE_KEY, (_e, input: { id?: string; value?: string }) => {
    if (!input?.id) return failResult("缺少端点 id");
    return Provider.setProfileKey(input.id, input.value ?? "");
  });
  ipcMain.handle(IPC.AI.PROFILE_ACTIVATE, (_e, id: string) => {
    if (!id) return failResult("缺少端点 id");
    return Provider.activateProfile(id);
  });
  ipcMain.handle(IPC.AI.PROFILE_TEST, async (_e, id: string) => {
    if (!id) return failResult("缺少端点 id");
    Log.debug("ai.profileTest", id);
    return await Provider.testProfile(id);
  });

  // AI 追问建议：基于一轮问答产出 2-3 条下一步可问的短问题（失败回空由前端兜底）
  ipcMain.handle(IPC.AI.FOLLOW_UPS, async (_e, input: { userText?: string; aiText?: string }) => {
    return await Ai.suggestFollowUps({ userText: input?.userText ?? "", aiText: input?.aiText ?? "" });
  });

  // 出网代理自动检测（只读展示；实际生效在 netFetch 里，无需用户配置）
  ipcMain.handle(IPC.AI.PROXY_INFO, () => NetProxy.proxyInfo());
}
