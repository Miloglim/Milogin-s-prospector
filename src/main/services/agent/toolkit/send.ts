// ── Agent Harness 工具层 · 发送域（从 tools.ts 拆分）────────────────
// 工具：generate_draft / queue_status / reminders_due / accounts_status / list_templates /
//       send_queue_add / campaign_create / campaign_status / campaign_control。
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../db";
import { contacts } from "../../../db/schema/contacts";
import { companies } from "../../../db/schema/companies";
import { inboxMessages } from "../../../db/schema/inbox";
import { emailAccounts } from "../../../db/schema/accounts";
import { getSendStatus, getQueueItems, startDynamicSend, buildAdaptiveQueue, startQueue } from "../../send.service";
import { previewCampaign, createCampaign, getCampaignOverview, getCampaignDetail, setCampaignStatus, restartCampaign, scanDueCampaigns, type CampaignTouch, type CampaignSchedule } from "../../campaign.service";
import { upsertTemplate, listTemplates as listTemplatesSvc } from "../../template.service";
import { getBody, htmlToText } from "../../inbox.service";
import { checkReminders } from "../../crm.service";
import { generateEmailDraft, generateEmailReply, type BackcheckReport } from "../../ai.service";
import { parseDraft } from "../parser";
import { rememberWork, fingerprint, listWork } from "../working-memory";
import { lookupIdempotent, rememberResult, forget } from "../idempotency";
import { invalidateCache } from "../tool-cache";
import { registerAction } from "../actions";
import { okResult, failResult, type Result } from "../../../errors";
import { isCircuitOpen, countRecentBlocks } from "../../sender-block.service";
import { parseEmailInquiry, pickRatesForEmail } from "../email-parse";
import { lookupReplyRates, podQueryWord, customerQuoteTable } from "../reply-rates";
import { readIdentity } from "../identity";
import { pickTarget, candidatesText, pickByEmail } from "./contacts";
import {
  gate, cachedRead, finishRead, okOut, failOut, audit, optStr, optInt, optBool, toIds,
  promptAction, navAction, type AnyAction, type ToolCtx,
} from "./common";

export const generateDraftSchema = z.object({
  companyName: optStr(80).describe("目标公司名（给了 contact 时可省略，工具会用库里档案补全）"),
  contactName: optStr(60).describe("收件人姓名（给了 contact 时可省略）"),
  language: z.string().max(8).nullable().optional().describe("输出语言：EN 英语 / ES 西语 / PT 葡语；其他值按 EN 处理。回信模式省略 = 跟随对方来信的语言"),
  focus: optStr(300).describe("内容侧重提示，如主推航线、客户痛点"),
  contactId: optInt().describe("收件联系人 id（可选）"),
  contact: optStr(80).describe("收件人的邮箱/姓名/公司名任一；给了它本工具会自己定位人并补全姓名与公司，无需先调 search_contacts"),
  messageId: optInt().describe("要回复的邮件 id（来自 inbox_search）。传了它 = 回信模式：草稿会针对对方来信逐条应答，收件人自动从来信取，无需 contact/contactId"),
});

export const sendQueueAddSchema = z.object({
  contactIds: z.preprocess((v: unknown) => toIds(v), z.array(z.number().int().positive()).max(2000))
    .describe("收件联系人 id 列表；也接受字符串数组或 \"1,2\" 形式。只有一个收件人时可改用 contact。批量发信一次最多 2000 个，更多分多次调用"),
  contact: optStr(80).describe("单个收件人的邮箱/姓名/公司名（本工具会自己定位人，无需先调 search_contacts）"),
  subject: z.string().max(150).nullable().optional().describe("邮件主题（可含 {{company}}/{{firstName}} 变量；用素材库模板时原样传模板主题）。usePreset=true 时省略"),
  body: z.string().max(8000).nullable().optional().describe("邮件正文（纯文本/简单 HTML，可含联系人变量；用素材库模板时原样传模板正文）。usePreset=true 时省略"),
  usePreset: optBool().describe("用程序内置句库组装（无需模板，按每个联系人的阶段/语言/客户类型自动拼装；已回复/已触达照常入队，由用户圈名单决定发不发）。素材库没有启用模板、用户说「用系统内置/程序自带的内容」时传 true，此时 subject/body 省略"),
});

export const campaignCreateSchema = z.object({
  name: optStr(60).describe("任务名，如「巴西冷客户·4 触点」；不传按「筛选条件·N 触点」自动生成"),
  contactIds: z.preprocess((v: unknown) => toIds(v), z.array(z.number().int().positive()).min(1).max(2000))
    .describe("收件联系人 id 列表（来自 search_contacts 的结构化筛选结果）。已回复/已触达不再被拦截——发不发由用户圈定名单决定，确认卡会如实报数"),
  touches: z.array(z.object({
    stage: z.string().max(20).describe("该轮用的模板阶段：initial(首信)/followup1/followup2/closing/reactivate"),
    delayDays: z.number().int().min(0).max(60).describe("距上一封发出的天数；首轮（首信）填 0"),
    mode: optStr(10).describe("内容来源：system=系统句库（内置多语言，免配置）/ userTpl=用户模板（缺省；模板缺时句库兜底）/ adaptive=自适应，同阶段同语言的启用模板里随机取一条（多轮触达内容轮换，防模板疲劳；用户说「模板轮换着发」选它）/ fixed=定死内容（须传 subject+body）"),
    subject: z.string().max(150).nullable().optional().describe("mode=fixed 时该轮主题（可含 {{firstName}}/{{company}} 变量）"),
    body: z.string().max(8000).nullable().optional().describe("mode=fixed 时该轮正文"),
  })).min(1).max(6).describe("触点计划按顺序执行；建议 3-5 轮、间隔 4-7 天"),
  autoSend: optBool().describe("后续触点是否无人值守自动发送（默认 true；内容为用户模板机械替换）。传 false=每轮入队待发送中心手动开始"),
  schedule: z.object({
    windowStartHour: z.number().int().min(0).max(23).nullable().optional().describe("发送时段起始整点（本机时区），如 9=09:00 起"),
    windowEndHour: z.number().int().min(0).max(23).nullable().optional().describe("发送时段结束整点，如 18=18:00 止"),
    dailyGroupCap: z.number().int().min(0).max(2000).nullable().optional().describe("单日放行上限（组/天）：超出顺延次日——用户说「每天只发 50 封」「分几天慢慢发」时设；0/缺省=不限"),
  }).nullable().optional().describe("任务级定时器（发送时段+单日上限），不传=跟随全局设置"),
});

export const campaignControlSchema = z.object({
  campaignId: z.string().min(1).max(24).describe("任务 id（来自 campaign_create 或 campaign_status）"),
  action: z.string().max(10).describe("pause=暂停（不再排新触点）｜resume=恢复｜stop=终止（终态，不可恢复）｜restart=完结任务再启动新周期（fixed 轮内容上周期完结时已清空，需先编辑补新内容）"),
});

export const listTemplatesSchema = z.object({ language: optStr(8).nullable().optional().describe("按语言过滤：EN/ES/PT；省略=全部") });
export const campaignStatusSchema = z.object({
  campaignId: optStr(24).describe("要查明细的任务 id；不传=全部任务概览"),
});

export async function execGenerateDraft(ctx: ToolCtx, args: z.infer<typeof generateDraftSchema>): Promise<string> {
  const note = gate(ctx, "generate_draft");
  if (note) return note;
  const sender = readIdentity();
  let companyName: string, contactName: string, lang: string, tplName: string;
  let draftContactId: number | null;
  let replySubject: string | null = null;
  let ratesAttached = 0;          // 回信里注入的真实运价条数（0=没查到匹配价）
  let ratesSelfQueried = false;   // 这批价是工具自查台账拿的（true）还是会话工作台里已有的（false）
  let inquiryNoRates = false;     // 是询价邮件但工作台与台账都没匹配价 → 出稿后说明查无当期价
  let quoteTableAttached = false; // 客户报价表（英文十一列）是否已随草稿生成
  let r: Result<string>;
  if (args.messageId) {
    // —— 回信模式（docs/agent-draft-reply-spec.md）：针对来信逐条应答 ——
    const row = getDb().select().from(inboxMessages).where(eq(inboxMessages.id, args.messageId)).get();
    if (!row) {
      audit(ctx, "generate_draft", "read", args, undefined, "auto", `邮件 #${args.messageId} 不存在`);
      return failOut("not_found", `邮件 #${args.messageId} 不存在，先 inbox_search 拿 id`);
    }
    const bodyR = await getBody(args.messageId);
    const bodyText = (bodyR.success ? htmlToText(bodyR.data) : (row.bodyPreview || "")).slice(0, 4000);
    if (!bodyText.trim()) {
      audit(ctx, "generate_draft", "read", args, undefined, "auto", "来信正文为空");
      return failOut("empty_body", "该邮件没有可用正文，无法据以起草回复；可先 email_read_full 确认");
    }
    // 收件人：来信关联联系人优先，否则 fromEmail 精确匹配；都不中不阻塞出稿（actions 少一个入队而已）
    const linked = row.matchedContactId ? pickTarget({ contactId: row.matchedContactId }) : null;
    const rep = linked && linked.ok ? linked.person : pickByEmail(row.fromEmail);
    companyName = args.companyName || rep?.company || row.fromName || row.fromEmail;
    contactName = args.contactName || rep?.name || row.fromName || row.fromEmail;
    draftContactId = rep?.id ?? null;
    const explicit = (args.language ?? "").toUpperCase();
    const langOk = ["EN", "ES", "PT"].includes(explicit) ? explicit : "";
    lang = langOk || "EN";
    // 闭环：解析来信询价要素 + 从会话工作台拉此前查到的匹配真价，据真数据起草（灭掉占位编造）
    const inq = parseEmailInquiry(bodyText);
    const matched = pickRatesForEmail(inq, listWork(ctx.conversationId, "rates", 8));
    // 工作台没有匹配价 → 工具自己查一次台账（一轮就出带真价的草稿）。
    // 旧行为是返回 notice 叫模型「先 quote_search 再重调本工具」，弱模型实测不照做，
    // 询价信的回信就只剩「报价稍后补」。规范 docs/agent-draft-reply-spec.md §询价信回信
    const selfRates = matched ? null : lookupReplyRates(inq);
    const replyRates = matched?.rows ?? selfRates?.rows ?? null;
    ratesAttached = replyRates?.length ?? 0;
    ratesSelfQueried = !!selfRates;
    inquiryNoRates = !!(inq.pod || inq.container || inq.pol) && ratesAttached === 0;
    // 客户报价表（英文十一列）：有真价就随草稿一起出，模型只负责原样嵌入。
    // POD 用归一后的标准港名（航线级行也展开到该港；多港粘连只留目标港）。
    const tablePod = selfRates?.pod ?? podQueryWord(inq) ?? (typeof matched?.pod === "string" ? matched.pod : null);
    // 出表优先用台账原始行（目免/船期/有效期原文齐全）；工作台来的只有精简行也能出
    const quoteTable = replyRates?.length ? customerQuoteTable(selfRates?.dtos ?? replyRates, tablePod, inq) : "";
    quoteTableAttached = !!quoteTable;
    r = await generateEmailReply({
      language: langOk || undefined,
      companyName, contactName,
      fromEmail: row.fromEmail, subject: row.subject,
      bodyText, focus: args.focus ?? null, sender,
      rates: replyRates, emailFacts: inq, quoteTable: quoteTable || null,
    });
    replySubject = row.subject ? (/^re[:\s]/i.test(row.subject) ? row.subject : `Re: ${row.subject}`) : null;
    tplName = `${companyName} · AI 回信`.slice(0, 60);
  } else {
    // —— 开发信模式：收件人可由 contact/contactId 任一定位；定位到就用档案补全姓名与公司 ——
    const target = args.contactId || args.contact ? pickTarget(args) : null;
    const person = target && target.ok ? target.person : null;
    if (target && !target.ok) {
      audit(ctx, "generate_draft", "read", args, undefined, "auto", "未定位到收件人");
      return failOut(target.why, target.why === "ambiguous"
        ? `「${args.contact}」匹配到多位联系人，请改用 contactId 指定其一：${candidatesText(target.candidates)}`
        : `库里找不到「${args.contact}」；不知道对方是否建档时，先调 search_contacts，或直接给我公司名继续写`);
    }
    companyName = args.companyName || person?.company || person?.name || "客户";
    contactName = args.contactName || person?.name || companyName;
    draftContactId = person?.id ?? args.contactId ?? null;
    lang = (["EN", "ES", "PT"].includes((args.language ?? "EN").toUpperCase()) ? args.language!.toUpperCase() : "EN");
    r = await generateEmailDraft({
      language: lang as "EN" | "ES" | "PT",
      companyName,
      contactName,
      backcheck: args.focus ? ({ summary: args.focus } as BackcheckReport) : null,
      sender,
    });
    tplName = `${companyName} · AI 开发信`.slice(0, 60);
  }
  if (!r.success) {
    audit(ctx, "generate_draft", "read", args, undefined, "auto", r.error);
    return failOut("generate_failed", `草稿生成失败：${r.error}`);
  }
  // 拆 SUBJECT 行 → 主题/正文（结果卡动作与入队都要用）；回信模式主题强制带 Re:
  let { subject, body } = parseDraft(r.data, `Following up — ${companyName}`);
  if (replySubject) subject = replySubject;

  const actions: AnyAction[] = [
    registerAction({
      conversationId: ctx.conversationId, toolName: "generate_draft",
      label: "存入素材库",
      confirm: `把这封草稿存进素材库，以后在发送中心可直接复用`,
      detail: `名称「${tplName}」，语言 ${lang}`,
      diff: [
        { field: "name", label: "素材名", from: "—", to: tplName },
        { field: "subject", label: "主题", from: "—", to: subject },
        { field: "body", label: "正文", from: "—", to: `${body.slice(0, 60)}${body.length > 60 ? "…" : ""}` },
      ],
      target: { label: "查看素材库", href: "#/templates" },
      run: async () => {
        const t = await upsertTemplate({ name: tplName, language: lang, subject, body, category: "ai-draft" });
        return t.success ? okResult(`已存入素材库：${t.data.name}`) : failResult(t.error);
      },
    }),
  ];
  if (draftContactId) {
    actions.push(registerAction({
      conversationId: ctx.conversationId, toolName: "generate_draft",
      label: "入队发给这位联系人",
      confirm: `把这封信加入发送队列，收件人 #${draftContactId} ${contactName}`,
      detail: "入队 ≠ 发送：队列建好后不会自动开始，仍要你在「发送中心」点「开始」",
      diff: [
        { field: "subject", label: "主题", from: "—", to: subject },
        { field: "contact", label: "收件人", from: "—", to: `#${draftContactId} ${contactName}`.trim() },
      ],
      target: { label: "去发送中心", href: "#/campaigns" },
      run: async () => {
        const s = await startDynamicSend([draftContactId], subject, body, false);
        return s.success
          ? okResult(`已入队 ${s.data.queuedCount} 封（批次 ${s.data.batchId.slice(0, 8)}），等待你在发送中心点开始`)
          : failResult(s.error);
      },
    }));
  }
  // 工作台：草稿本身也留一条，后续"把刚才那封发出去/存素材库"能跨轮引用
  rememberWork(ctx.conversationId, {
    kind: "draft",
    refId: args.messageId ? `msg-${args.messageId}` : `to-${draftContactId ?? companyName}`,
    toolName: "generate_draft",
    contextLine: `草稿 致 ${companyName}「${subject}」${lang}${ratesAttached ? `，已引用真价 ${ratesAttached} 条` : ""}`,
    payload: { subject, bodyExcerpt: body.slice(0, 2000), language: lang, contactId: draftContactId, ratesAttached, messageId: args.messageId ?? null },
  });
  // 正文只放一份（subject/body）：整条结果受推送上限约束，重复字段会挤掉 actions
  const out = {
    subject, body, language: lang, contactId: draftContactId ?? null, actions,
    ...(ratesAttached ? { ratesUsed: ratesAttached } : {}),
    ...(quoteTableAttached ? { quoteTableAttached: true } : {}),
    ...(inquiryNoRates ? {
      notice: "这封是询价邮件，但会话工作台与台账里都没有匹配到的当期运价（工具已按来信的起运港/目的港/柜型自查过一次）。"
        + "草稿走「报价稍后补」话术、不编数字。要给用户交代，就说台账暂无该航线当期报价，"
        + "并给两条出口：去运价页手动同步一次台账，或联网调研当前市场行情（market_research）。",
    } : {}),
  };
  audit(ctx, "generate_draft", "read", args,
    { subject, length: body.length, actions: actions.length, ratesAttached, ratesSelfQueried, quoteTableAttached }, "auto");
  return okOut(out);
}

export async function execQueueStatus(ctx: ToolCtx, args: Record<string, never>): Promise<string> {
  const cached = cachedRead(ctx, "queue_status", {});
  if (cached) return cached;
  const s = getSendStatus();
  const q = getQueueItems();
  const items = q.success ? q.data : [];
  const pending = items.filter(i => i.status === "pending");
  const out = {
    running: s.success ? s.data.isRunning : false,
    paused: s.success ? s.data.isPaused : false,
    totalGroups: s.success ? s.data.totalItems : 0,
    sentGroups: s.success ? s.data.sentCount : 0,
    failedGroups: s.success ? s.data.failedCount : 0,
    pendingGroups: pending.length,
    pendingRecipients: pending.reduce((n, i) => n + i.recipients.length, 0),
  };
  audit(ctx, "queue_status", "read", {}, out, "auto");
  return okOut(out);
}

export async function execRemindersDue(ctx: ToolCtx, args: Record<string, never>): Promise<string> {
  const cached = cachedRead(ctx, "reminders_due", {});
  if (cached) return cached;
  const r = checkReminders();
  if (!r.success) {
    audit(ctx, "reminders_due", "read", {}, undefined, "auto", r.error);
    return failOut("query_failed", `查询失败：${r.error}`);
  }
  const brief = (c: (typeof r.data.due)[number]) => ({
    id: c.id,
    name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email,
    company: c.companyName ?? "", reminderAt: c.reminderAt ?? "", note: c.followupNote ?? "",
    // 逾期来源：显式提醒到期 or 沉默超期（无提醒但距最近跟进 >5 天 = 看板标红的同一批）
    reason: c.reminderAt ? "显式提醒到期" : `沉默 ${(c.staleDays ?? 0)} 天未跟进`,
  });
  const due = r.data.due.map(brief);
  const overdue = r.data.overdue.map(brief);
  const all = [...overdue, ...due];                       // 逾期优先
  const out = { dueCount: due.length, overdueCount: overdue.length, due, overdue };

  // P1-4：提醒清单 → 一键批量成信入队（每人生成一封、按各自语言，入队不发送）
  const sender = readIdentity();
  const actions: AnyAction[] = [];
  if (all.length > 0) {
    const targets = all.slice(0, 10);
    actions.push(registerAction({
      conversationId: ctx.conversationId, toolName: "reminders_due",
      label: `给这 ${targets.length} 位批量生成跟进信`,
      confirm: `为清单前 ${targets.length} 位联系人各生成一封跟进信并加入发送队列`,
      detail: "入队 ≠ 发送：全部生成后到「发送中心」核对批次，手动点开始才外发；每人一封、按各自语言",
      diff: [
        { field: "targets", label: "收件人", from: "—", to: targets.slice(0, 5).map(c => `#${c.id} ${c.name}`).join("、") + (targets.length > 5 ? ` 等 ${targets.length} 人` : "") },
        { field: "batch", label: "批次", from: "—", to: "生成后显示" },
      ],
      target: { label: "去发送中心", href: "#/campaigns" },
      run: async () => {
        const queued: string[] = [];
        const failed: string[] = [];
        for (const c of targets) {
          const contact = getDb().select({
            id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName,
            language: contacts.language, companyId: contacts.companyId, email: contacts.email,
          }).from(contacts).where(eq(contacts.id, c.id)).get();
          if (!contact) { failed.push(`#${c.id}（已不存在）`); continue; }
          const companyName = contact.companyId
            ? (getDb().select({ name: companies.name }).from(companies).where(eq(companies.id, contact.companyId)).get()?.name ?? "")
            : "";
          const lang = ["ES", "PT"].includes(String(contact.language ?? "").toUpperCase())
            ? (String(contact.language).toUpperCase() as "ES" | "PT") : "EN";
          const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email;
          const draft = await generateEmailDraft({
            language: lang, companyName: companyName || c.company || name, contactName: name,
            backcheck: c.note ? { summary: `此前跟进备注：${c.note}` } as BackcheckReport : null,
          });
          if (!draft.success) { failed.push(`${name}（${draft.error.slice(0, 30)}）`); continue; }
          const { subject, body } = parseDraft(draft.data, `Following up — ${companyName || name}`);
          const q = await startDynamicSend([contact.id], subject, body, false);
          if (q.success) queued.push(name); else failed.push(`${name}（${q.error.slice(0, 30)}）`);
        }
        return okResult(
          `批量成信完成：${queued.length} 封已入队${queued.length ? `（${queued.join("、")}）` : ""}`
          + (failed.length ? `；${failed.length} 位未成：${failed.join("、")}` : "")
          + "。队列未启动，请到「发送中心」核对内容后点开始。",
        );
      },
    }));
  }
  audit(ctx, "reminders_due", "read", {}, { ...out, actions: actions.length }, "auto");
  if (due.length === 0 && overdue.length === 0) {
    return okOut({ ...out, notice: "今天没有到期或逾期的提醒。请如实告知用户，不要重复调用本工具。" });
  }
  return okOut({ ...out, ...(actions.length ? { actions } : {}) });
}

export async function execAccountsStatus(ctx: ToolCtx, args: Record<string, never>): Promise<string> {
  const cached = cachedRead(ctx, "accounts_status", {});
  if (cached) return cached;
  const rows = getDb().select({
    id: emailAccounts.id, email: emailAccounts.email, isActive: emailAccounts.isActive,
    consecutiveFails: emailAccounts.consecutiveFails, circuitOpenAt: emailAccounts.circuitOpenAt,
    circuitResetAfter: emailAccounts.circuitResetAfter, circuitReason: emailAccounts.circuitReason,
    lastFetchError: emailAccounts.lastFetchError, fetchFailCount: emailAccounts.fetchFailCount,
  }).from(emailAccounts).all();
  // 熔断按「是否仍在生效期」判（circuit_reset_after 到期自动放行）——按老口径非空即熔断会把过期账号误报成熔断中
  const issues = rows.map(r => {
    const probs: string[] = [];
    const open = isCircuitOpen(r);
    const blockCount = countRecentBlocks(r.id);
    if (r.isActive !== 1) probs.push("已停用");
    if (open && r.circuitReason === "sender_block") probs.push(`发信受阻熔断中（服务商反垃圾/限流拦截，30 分钟内 ${blockCount} 封）— 已从发信轮换摘除，24h 自动过期或设置页手动解除`);
    else if (open) probs.push("发信熔断中（连续发送失败）");
    else if (blockCount > 0) probs.push(`近 30 分钟有 ${blockCount} 封反垃圾/限流拦截退信（熔断已解除；再被拦会立即重新触发，注意先改内容/降频）`);
    if (r.consecutiveFails > 0) probs.push(`发信连续失败 ${r.consecutiveFails} 次`);
    if (r.fetchFailCount > 0) probs.push(`收信连续失败 ${r.fetchFailCount} 次${r.lastFetchError ? `：${r.lastFetchError}` : ""}`);
    else if (r.lastFetchError) probs.push(`最近收信异常：${r.lastFetchError}`);
    return probs.length ? { id: r.id, email: r.email, problems: probs.join("、") } : null;
  }).filter((x): x is { id: number; email: string; problems: string } => x !== null);
  const healthyCount = rows.filter(r =>
    r.isActive === 1 && !isCircuitOpen(r) && r.consecutiveFails === 0 && r.fetchFailCount === 0).length;
  // P1-7：有异常 → 直接给「去修」入口（跳设置页账号区）与复测动作
  const actions: AnyAction[] = [];
  if (issues.length > 0) {
    actions.push(navAction("去设置页修账号", "#/settings"));
  }
  const out = { total: rows.length, enabled: rows.filter(r => r.isActive === 1).length, healthy: healthyCount, issues, ...(actions.length ? { actions } : {}) };
  audit(ctx, "accounts_status", "read", {}, out, "auto");
  return okOut(out);
}

export async function execListTemplates(ctx: ToolCtx, args: z.infer<typeof listTemplatesSchema>): Promise<string> {
  const gateNote = gate(ctx, "list_templates");
  if (gateNote) return gateNote;
  const cached = cachedRead(ctx, "list_templates", args);
  if (cached) return cached;
  const lang = (args.language || "").trim().toUpperCase();
  const r = await listTemplatesSvc(["EN", "ES", "PT"].includes(lang) ? lang : undefined);
  if (!r.success) {
    audit(ctx, "list_templates", "read", args, undefined, "auto", r.error);
    return failOut("list_failed", `读取素材库失败：${r.error}`);
  }
  audit(ctx, "list_templates", "read", args, { total: r.data.length }, "auto");
  return finishRead(ctx, "list_templates", args, okOut({
    total: r.data.length,
    templates: r.data.slice(0, 30).map(t => ({
      id: t.id, name: t.name, language: t.language, subject: t.subject,
      bodyPreview: (t.body || "").slice(0, 300),
    })),
    ...(r.data.length === 0
      ? { notice: "素材库暂无启用中的模板。两条路：① generate_draft 起草一版给用户过目，认可后入队；"
          + "② 用程序内置句库（系统预设）：send_queue_add 传 usePreset=true，按每个联系人的阶段/语言自动组装，无需模板。" }
      : {}),
  }));
}

export async function execSendQueueAdd(ctx: ToolCtx, args: z.infer<typeof sendQueueAddSchema>): Promise<string> {
  const gateNote = gate(ctx, "send_queue_add");
  if (gateNote) return gateNote;
  const dup = lookupIdempotent(ctx, "send_queue_add", args);
  if (dup) return dup;
  // 收件人：id 列表优先，否则用 contact 定位（少一步 = 弱模型少一次掉链子）
  let ids = args.contactIds ?? [];
  if (ids.length === 0 && args.contact) {
    const t = pickTarget({ contact: args.contact });
    if (!t.ok) {
      audit(ctx, "send_queue_add", "write", args, undefined, "approved", "未定位到收件人");
      return failOut(t.why, t.why === "ambiguous"
        ? `「${args.contact}」匹配到多位联系人，请用 contactIds 指定：${candidatesText(t.candidates)}`
        : `库里找不到「${args.contact}」，请先确认对方已建档`);
    }
    ids = [t.person.id];
  }
  if (ids.length === 0) {
    audit(ctx, "send_queue_add", "write", args, undefined, "approved", "缺少收件人");
    return failOut("missing_recipient", "缺少收件人。请给 contactIds（或单个 contact：邮箱/姓名）。");
  }
  // 程序预设路径（用户拍板：素材库为空也该能用系统内置句库）：按每个联系人的
  // 阶段/语言/客户类型组装；已回复/已触达照常入队（资格闸已解除，名单由用户圈定）
  if (args.usePreset) {
    const qr = buildAdaptiveQueue([], ids);
    if (!qr.success) {
      audit(ctx, "send_queue_add", "write", args, undefined, "approved", qr.error);
      return failOut("preset_failed", qr.error);
    }
    const q = await startQueue(qr.data, false);
    audit(ctx, "send_queue_add", "write", args, { preset: true, queued: q.success ? q.data.queuedCount : 0 }, "approved", q.success ? undefined : q.error);
    if (!q.success) return failOut("enqueue_failed", q.error);
    return okOut({
      preset: true, queuedCount: q.data.queuedCount, batchId: q.data.batchId,
      notice: `已按程序预设句库组装 ${q.data.queuedCount} 封并入队（批次 ${q.data.batchId.slice(0, 8)}）。入队 ≠ 发送：请到发送中心核对后点开始。`,
    });
  }
  if (!args.subject?.trim() || !args.body?.trim()) {
    return failOut("missing_content", "缺主题或正文。用素材库模板就把模板的 subject/body 原样传；没有启用模板可用 usePreset=true 走程序预设句库。");
  }
  const r = await startDynamicSend(ids, args.subject, args.body, false);
  if (!r.success) {
    audit(ctx, "send_queue_add", "write", args, undefined, "approved", r.error);
    forget(ctx, "send_queue_add", args);
    return failOut("enqueue_failed", `入队失败：${r.error}`);
  }
  audit(ctx, "send_queue_add", "write", args, r.data, "approved");
  invalidateCache("send_queue_add");
  const out = okOut({
    say: `已加入发送队列：${r.data.queuedCount} 封（批次 ${r.data.batchId.slice(0, 8)}，${r.data.dropped} 组因限额被丢弃）。`,
    notice: "队列已建立但尚未启动，请提示用户到「发送中心」确认后手动点开始发送。",
  });
  rememberResult(ctx, "send_queue_add", args, out);
  return out;
}

export async function execCampaignCreate(ctx: ToolCtx, args: z.infer<typeof campaignCreateSchema>): Promise<string> {
  const gateNote = gate(ctx, "campaign_create");
  if (gateNote) return gateNote;
  // 触点入参 → service 形态（mode/fixed 内容快照透传；与向导同一判据提前校验，别等确认卡点下去才报错）
  const touches: CampaignTouch[] = args.touches.map(t => ({
    stage: t.stage,
    delayDays: t.delayDays,
    ...(t.mode ? { mode: t.mode as CampaignTouch["mode"] } : {}),
    ...(t.mode === "fixed" ? { content: { subject: t.subject ?? "", body: t.body ?? "" } } : {}),
  }));
  for (let i = 0; i < touches.length; i++) {
    const t = touches[i]!;
    if (t.mode === "fixed" && (!(t.content?.subject ?? "").trim() || !(t.content?.body ?? "").trim())) {
      return failOut("bad_touch", `第 ${i + 1} 轮选了「固定内容」但主题或正文为空`);
    }
  }
  const s = args.schedule;
  const ws = s?.windowStartHour ?? undefined;
  const we = s?.windowEndHour ?? undefined;
  const cap = s?.dailyGroupCap ?? undefined;
  const schedule: CampaignSchedule | undefined = !s ? undefined : {
    ...(ws !== undefined && we !== undefined ? { windowStartHour: ws, windowEndHour: we } : {}),
    ...(cap && cap > 0 ? { dailyGroupCap: cap } : {}),
  };
  const pv = previewCampaign(args.contactIds);
  if (!pv.success) return failOut("bad_list", pv.error);
  const { eligible, excluded, total, sample, reachedReplied } = pv.data;
  if (eligible === 0) {
    return failOut("no_eligible", `名单里 ${excluded} 人全部已不在库（无有效收件人）。请重新圈定名单。`);
  }
  const name = args.name?.trim() || `${eligible} 人·${args.touches.length} 触点`;
  const autoSend = args.autoSend !== false;
  const planSummary = args.touches.map((t, i) =>
    i === 0 ? `首信(${t.stage})立即` : `${t.stage} 间隔${t.delayDays}天`).join(" → ");
  const MODE_SRC: Record<string, string> = { system: "系统句库", userTpl: "用户模板", adaptive: "自适应模板", fixed: "固定内容" };
  const contentSrc = MODE_SRC[touches[0]?.mode ?? ""] ?? "用户模板";
  const winNote = schedule?.windowStartHour !== undefined && schedule?.windowEndHour !== undefined
    ? `，时段 ${schedule.windowStartHour}:00-${schedule.windowEndHour}:00` : "";
  const capNote = schedule?.dailyGroupCap ? `，单日上限 ${schedule.dailyGroupCap} 组/天` : "";
  const rrNote = reachedReplied > 0 ? `（其中 ${reachedReplied} 位已触达/已回复，将照常入队）` : "";
  audit(ctx, "campaign_create", "write", args, { eligible, excluded, rounds: args.touches.length }, "auto");
  return okOut({
    eligible, excluded, total, reachedReplied, planSummary, autoSend,
    sample,
    actions: [registerAction({
      conversationId: ctx.conversationId, toolName: "campaign_create",
      label: `创建发信任务（${eligible} 人 × ${args.touches.length} 轮）`,
      confirm: `为 ${eligible} 位联系人创建发信任务「${name}」${rrNote}：${planSummary}，内容=${contentSrc}${winNote}${capNote}。后续触点${autoSend ? "自动发送（无人值守）" : "入队待你在发送中心手动开始"}。`,
      detail: "客户回复后自动止损；发信账号智能轮换遵循「谁发过的客户还由谁发」（不换人发），新客户才轮换",
      diff: [
        { field: "targets", label: "收件人", from: "—", to: sample.map(s => `#${s.id} ${s.name}`).join("、") + (eligible > sample.length ? ` 等 ${eligible} 人` : "") },
        { field: "plan", label: "触点计划", from: "—", to: planSummary },
        { field: "content", label: "内容来源", from: "—", to: contentSrc },
        ...(schedule?.windowStartHour !== undefined && schedule?.windowEndHour !== undefined
          ? [{ field: "window", label: "发送时段", from: "—", to: `${schedule.windowStartHour}:00-${schedule.windowEndHour}:00` }] : []),
        ...(schedule?.dailyGroupCap
          ? [{ field: "cap", label: "单日上限", from: "—", to: `${schedule.dailyGroupCap} 组/天（超出顺延次日）` }] : []),
        { field: "auto", label: "执行方式", from: "—", to: autoSend ? "无人值守" : "每轮手动开始" },
      ],
      target: { label: "去发送中心", href: "#/campaigns" },
      run: async () => {
        const r = createCampaign({ name, contactIds: args.contactIds, touches, autoSend, ...(schedule ? { schedule } : {}) });
        if (!r.success) return failResult(r.error);
        await scanDueCampaigns();   // 首触点立即入队（不等下个扫描周期）
        return okResult(`任务 ${r.data.id} 已创建：${r.data.eligible} 人入列（排除 ${r.data.excluded}），首信已入队列${autoSend ? "并自动开始" : "，等你在发送中心点开始"}。后续触点按计划自动跟进，客户回复即止损。`);
      },
    })],
    notice: "预览即执行对象：确认卡里的名单数=实际建任务的名单。向用户口头说明计划节奏与止损规则，确认卡由用户点击生效。",
  });
}

export async function execCampaignStatus(ctx: ToolCtx, args: z.infer<typeof campaignStatusSchema>): Promise<string> {
  const gateNote = gate(ctx, "campaign_status");
  if (gateNote) return gateNote;
  if (args.campaignId) {
    const d = getCampaignDetail(args.campaignId.trim());
    if (!d.success) return failOut("not_found", d.error);
    const data = d.data;
    audit(ctx, "campaign_status", "read", args, { id: args.campaignId, targets: data.targets.length }, "auto");
    return okOut({
      campaign: data.campaign,
      targets: data.targets.slice(0, 20),
      notice: `名单共 ${data.campaign?.total ?? 0} 人，本表展示前 20。进度看 touchesSent/touchesPlanned（封数，多轮已计入），人数总量看 total。status 口径：pending=待发，queued=已入队，sent=计划走完，replied/bounced/unsubscribed=止损，skipped=排除。`,
    });
  }
  const campaigns = getCampaignOverview();
  audit(ctx, "campaign_status", "read", args, { count: campaigns.length }, "auto");
  if (!campaigns.length) {
    return okOut({ campaigns: [], notice: "还没有发信任务。要批量自动跟进，先 search_contacts 筛人再 campaign_create。" });
  }
  return okOut({
    campaigns,
    notice: "回答格式：逐任务一句「名称 · 状态 · 已发 X/Y 封 · 回复 Z · 还剩 W 封」——X/Y 直接用 touchesSent/touchesPlanned（封数口径，止损后分母随之收缩），别拿 total 人数当进度；用户要细看某任务再带 campaignId 查一次。",
  });
}

export async function execCampaignControl(ctx: ToolCtx, args: z.infer<typeof campaignControlSchema>): Promise<string> {
  const gateNote = gate(ctx, "campaign_control");
  if (gateNote) return gateNote;
  const action = (args.action ?? "").trim().toLowerCase();
  if (!["pause", "resume", "stop", "restart"].includes(action)) {
    return failOut("bad_action", `action 值「${args.action}」不存在。有效值：pause / resume / stop / restart。`);
  }
  if (action === "restart") {
    const r = restartCampaign(args.campaignId.trim());
    audit(ctx, "campaign_control", "write", args, r.success ? { campaignId: args.campaignId, action } : undefined, "auto", r.success ? undefined : r.error);
    if (!r.success) return failOut("control_failed", r.error);
    void scanDueCampaigns();
    return okOut({
      campaignId: args.campaignId, action, status: "running",
      notice: `任务已再启动新周期：重置 ${r.data.reset} 个触点（退信/退订保持终态）。到期触点由调度器自动排入队列。`,
    });
  }
  const status = action === "pause" ? "paused" : action === "resume" ? "running" : "stopped";
  const r = setCampaignStatus(args.campaignId.trim(), status as "paused" | "running" | "stopped");
  audit(ctx, "campaign_control", "write", args, r.success ? { campaignId: args.campaignId, action } : undefined, "auto", r.success ? undefined : r.error);
  if (!r.success) return failOut("control_failed", r.error);
  return okOut({
    campaignId: args.campaignId, action, status,
    notice: action === "stop"
      ? "任务已终止：待发触点全部清空，已发出的不受影响。如实告知用户不可恢复。"
      : action === "pause"
        ? "任务已暂停：不再排新触点；正在队列里的照常发完。恢复用 resume。"
        : "任务已恢复：到期触点会被调度器自动排入队列。",
  });
}
