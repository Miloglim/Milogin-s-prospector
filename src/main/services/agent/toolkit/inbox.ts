// ── Agent Harness 工具层 · 收件箱域（从 tools.ts 拆分）────────────────
// 工具：inbox_search / email_summarize / email_read_full / mail_brief。
import { z } from "zod";
import { eq, like, or, and, gte, isNull, ne, desc, sql } from "drizzle-orm";
import { getDb, saveDatabase } from "../../../db";
import { inboxMessages } from "../../../db/schema/inbox";
import { contacts } from "../../../db/schema/contacts";
import { companies } from "../../../db/schema/companies";
import { interactions } from "../../../db/schema/interactions";
import { getBody, htmlToText, markRead } from "../../inbox.service";
import { setStage } from "../../crm.service";
import { summarizeEmail } from "../../ai.service";
import { upsertContact } from "../../contact.service";
import { rememberWork, fingerprint } from "../working-memory";
import { registerAction } from "../actions";
import { okResult, failResult } from "../../../errors";
import { todayMailBrief, resolveBeijingStart } from "../../mail-brief.service";
import {
  gate, cachedRead, finishRead, okOut, failOut, audit, optStr, optInt, optBool, beijingTime,
  type AnyAction, type ToolCtx,
} from "./common";

export const inboxSearchSchema = z.object({
  query: optStr(120).describe("关键词，匹配发件人邮箱与称呼/主题/正文摘要；不传则返回最近邮件。「第一封/最新一封」这类指代不要拿称呼当关键词，直接省略 query 或配 unreadOnly"),
  classification: z.string().max(20).nullable().optional()
    .describe("按系统分类过滤，值必须照抄不可自创：replied=客户回复 bounce=退信 autoreply=自动回复 other=其他来信 sent=我方发出的副本"),
  intentFilter: optStr(20).describe("按意图过滤（可单用）：price_inquiry=询价 schedule_request=船期 cooperation=合作 follow_up=跟进 other=其他；"
    + "多数邮件意图未被识别（为空），按意图过滤容易漏——确认「有没有某人来信」优先用 query，别叠加 intent"),
  unreadOnly: optBool().describe("只看未读，默认 false"),
  since: optStr(24).describe("时间范围（北京时间）：可传「今天」「昨天」「本周」「最近3天」或 2026-09-09。"
    + "用户话里带时间（今天/这几天/上周…）必须传它，由服务端算日界——不要拉一页再自己按时间戳筛（慢且常筛错）"),
  includeSent: optBool().describe("是否包含我方发出的副本。默认 false（问「有没有来信/询盘/回复」时发出副本不算来信，会把开发信当成待处理）；"
    + "只有用户明确问「我发出去的邮件」时才传 true，或直接传 classification=\"sent\""),
  limit: optInt().describe("返回条数，默认 10，按时间倒序"),
});

export const emailSummarizeSchema = z.object({
  messageId: optInt().describe("邮件 id（单封时用；来自 inbox_search 返回）"),
  // 兜底字段：弱模型常自己发明 messageIds 想一次总结多封。本工具不做批量（一封封循环会撞
  // 本轮调用上限，且没有进度条），识别到这个意图时直接把请求转交给后台任务。
  // 上限与 toIds 的截断一致：卡在 max 上会让参数解析先炸掉（发生在预算计数之前，模型只会重试到 max turns）。
  messageIds: z.preprocess((v: unknown) => toIds(v), z.array(z.number().int().positive()).max(50).nullable().optional())
    .describe("不要传：本工具一次只总结一封。多封邮件一律用 start_batch_task(kind=\"email_summary\", messageIds=[…])"),
});

export const emailReadFullSchema = z.object({
  messageId: z.number().int().describe("inbox_search 返回的 id；只能照抄本轮检索结果里的 id，检索不到就如实告知，严禁凭记忆猜测或编造 id"),
});

import { toIds } from "./common";

export async function execInboxSearch(ctx: ToolCtx, args: z.infer<typeof inboxSearchSchema>): Promise<string> {
  const cached = cachedRead(ctx, "inbox_search", args);
  if (cached) return cached;
  // 词表必须镜像 inbox.service.ts 的 Classification——曾写成 inquiry/reply/auto_reply/normal，
  // 与落库值 replied/autoreply/other/sent 对不上：模型照旧文案传 reply → 静默 0 条 → 连环假「查无」
  const INBOX_CLASSES = ["replied", "bounce", "autoreply", "other", "sent"] as const;
  const INTENT_VALUES = ["price_inquiry", "schedule_request", "cooperation", "follow_up", "other"] as const;
  const q0 = (args.query ?? "").trim();
  const cls = (args.classification ?? "").trim().toLowerCase();
  const conds = [];
  // 非法过滤值直接报错纠正，不静默降级成「不过滤」或空结果：
  // 模型分不清「真空」和「我拼错词」，静默 0 条只会换来连环盲试（实测一轮烧 3 次调用）
  if (cls && !INBOX_CLASSES.includes(cls as (typeof INBOX_CLASSES)[number])) {
    return finishRead(ctx, "inbox_search", args, failOut("bad_filter",
      `classification 值「${cls}」不存在。有效值只有：${INBOX_CLASSES.join(" / ")}。改用有效值重查一次即可。`));
  }
  const intentF = (args.intentFilter ?? "").trim();
  if (intentF && !INTENT_VALUES.includes(intentF as (typeof INTENT_VALUES)[number])) {
    return finishRead(ctx, "inbox_search", args, failOut("bad_filter",
      `intentFilter 值「${intentF}」不存在。有效值只有：${INTENT_VALUES.join(" / ")}；多数邮件意图为空，建议去掉本过滤直接用 query 查。`));
  }
  if (q0) {
    const q = `%${q0}%`;
    // fromName 必须参战：发件人称呼（如 GCRA Fortune Freight Inc.）常不在邮箱地址里
    conds.push(or(like(inboxMessages.fromEmail, q), like(inboxMessages.fromName, q), like(inboxMessages.subject, q), like(inboxMessages.bodyPreview, q)));
  }
  if (cls) conds.push(eq(inboxMessages.classification, cls));
  if (intentF) conds.push(eq(inboxMessages.intent, intentF));
  // 默认只看「进来的信」：我方发出副本也是 is_read=0 的未读，混进来会把开发信算成询盘
  // （实测：用户问「今天的邮件有询盘吗」，第一轮被 sent 挤满 → 答「没有」，第二轮才翻出两封询价）
  const wantSent = cls === "sent" || args.includeSent === true;
  if (!wantSent) conds.push(or(isNull(inboxMessages.classification), ne(inboxMessages.classification, "sent")));
  // 时间范围服务端算：解析不出当面纠错，不静默降级成"查全部"（静默会让模型继续自己瞎筛）
  const sinceRaw = (args.since ?? "").trim();
  const win = sinceRaw ? resolveBeijingStart(sinceRaw) : null;
  if (sinceRaw && !win) {
    return finishRead(ctx, "inbox_search", args, failOut("bad_filter",
      `since「${sinceRaw}」看不懂。可传：今天 / 昨天 / 本周 / 最近3天 / 2026-09-09（按北京时间算日界）。`));
  }
  if (win) conds.push(gte(inboxMessages.receivedAt, new Date(win.start).toISOString()));
  // 「未读」指待我处理的来信：我方自己发出的副本（classification=sent）也是 is_read=0，
  // 不排除会把"我发出去的邮件"算成未读，计数与清单一起失真（用户实测抓到过）
  if (args.unreadOnly) conds.push(eq(inboxMessages.isRead, 0), ne(inboxMessages.classification, "sent"));
  const rows = getDb().select({
    id: inboxMessages.id, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
    subject: inboxMessages.subject, classification: inboxMessages.classification,
    intent: inboxMessages.intent,
    isRead: inboxMessages.isRead, receivedAt: inboxMessages.receivedAt,
    matchedContactId: inboxMessages.matchedContactId,
  }).from(inboxMessages)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(inboxMessages.receivedAt))
    .limit(Math.min(args.limit && args.limit > 0 ? args.limit : 10, 50))
    .all();
  // 时间由服务端算成北京时间、条数由服务端算好：模型不换算时区、不自己数数
  // （此前它在汇总表里把 12:13 写成 09:24 这类编造时间，就是两头都让它自己算导致的）
  const raw = rows.map(r => ({
    ...r,
    from: r.fromName || r.fromEmail,
    matchedContactId: r.matchedContactId ?? undefined,
    收到时间: beijingTime(r.receivedAt),
  }));
  const matchedTotal = getDb().select({ n: sql<number>`count(*)` }).from(inboxMessages)
    .where(conds.length ? and(...conds) : undefined).get()?.n ?? raw.length;
  audit(ctx, "inbox_search", "read", args, raw, "auto");
  // 收敛信号：空结果如实回答；结果少于 limit 说明已全量返回
  // 空结果也要走 finishRead 落缓存：否则模型换个措辞重复问同一个查不到的条件，
  // 每次都真查并吃掉一次预算，很快撞满 budgetPerTurn 卡住（「中断反应」的成因之一）
  if (raw.length === 0) {
    return finishRead(ctx, "inbox_search", args,
      okOut({ total: 0, messages: [], notice: "收件箱中没有匹配的邮件。请直接如实告知用户，不要重复调用本工具。" }));
  }
  // 工作台：检索到的邮件条目跨轮留存，后续"读第 N 封/回复它"能直接拿到真实 messageId，不靠模型记忆猜 id。
  rememberWork(ctx.conversationId, {
    kind: "inbox",
    refId: fingerprint({ q: q0, cls, intent: intentF, unread: args.unreadOnly, limit: args.limit }),
    toolName: "inbox_search",
    contextLine: `邮件检索「${q0 || "全部"}」${cls ? `[${cls}]` : ""}${intentF ? `[意图:${intentF}]` : ""}${args.unreadOnly ? "(未读)" : ""}：命中 ${matchedTotal}，返回 ${raw.length}；`
      + raw.slice(0, 5).map(m => `#${m.id} ${m.from}「${m.subject ?? "无主题"}」${m["收到时间"] ?? ""}`).join("；"),
    payload: {
      query: q0 ?? null, classification: cls ?? null, intent: intentF ?? null,
      unreadOnly: args.unreadOnly ?? false, total: matchedTotal,
      hits: raw.slice(0, 30).map(m => ({
        id: m.id, from: m.from, fromEmail: m.fromEmail, subject: m.subject ?? null,
        classification: m.classification ?? null, intent: m.intent ?? null,
        收到时间: m["收到时间"] ?? null, isRead: m.isRead,
      })),
    },
  });
  const defaultLimit = Math.min(args.limit && args.limit > 0 ? args.limit : 10, 50);
  // P1-1：真实客户来信（询盘/回复）但库中无此联系人 → 附「创建联系人」写入动作
  const actions: AnyAction[] = [];
  for (const m of raw) {
    if (m.matchedContactId || !["inquiry", "reply"].includes(String(m.classification))) continue;
    const cands = getDb().select({ id: contacts.id }).from(contacts).where(eq(contacts.email, m.fromEmail)).all();
    if (cands.length > 0) continue;
    const label = `把 ${m.from} 加为客户`;
    actions.push(registerAction({
      conversationId: ctx.conversationId, toolName: "inbox_search",
      label,
      confirm: `为发件人 ${m.fromEmail} 创建联系人${m.fromName ? `（${m.fromName}）` : ""}`,
      detail: "只建联系人档案，不发任何邮件",
      diff: [
        { field: "email", label: "邮箱", from: "—（库中无此联系人）", to: m.fromEmail },
        { field: "name", label: "姓名", from: "—", to: m.fromName || "（取邮箱前缀）" },
        { field: "status", label: "状态", from: "—", to: "已触达（刚来信）" },
      ],
      target: { label: "查看联系人", href: `#/customers?view=table&add=1&email=${encodeURIComponent(m.fromEmail)}` },
      run: async () => {
        const nameGuess = m.fromName?.trim() || m.fromEmail.split("@")[0]!;
        const [first, ...rest] = nameGuess.split(/\s+/);
        const u = await upsertContact({
          email: m.fromEmail,
          firstName: first ?? nameGuess,
          lastName: rest.join(" ") || null,
          status: "reached",
        });
        return u.success ? okResult(`已创建联系人 ${u.data.email} #${u.data.id}`) : failResult(u.error);
      },
    }));
    break;   // 一张卡最多给一个创建动作，避免按钮噪音
  }
  const dateHint = !win && ctx.userText && /今天|今日|昨天|前天|本周|上周|这几天|最近/.test(ctx.userText)
    ? "用户问的是带时间的邮件：下次直接传 since=\"今天\"（或原话里的日期），由服务端按北京时间算日界——拉一页再自己数时间，既慢又容易把今天说成昨天。"
    : "";
  return finishRead(ctx, "inbox_search", args, okOut({
    total: matchedTotal,
    ...(win ? { 时间窗口: win.label } : {}),
    ...(dateHint ? { 用法提醒: dateHint } : {}),
    returned: raw.length,
    // 让模型照抄结论，别自己数条数、别自己换算时间
    say: `共 ${matchedTotal} 封匹配，本条列出 ${raw.length} 封（时间为北京时间）`,
    ...(args.unreadOnly ? { unreadHint: "此处「未读」只算来信，已排除我方自己发出的邮件副本" } : {}),
    ...(raw.length < defaultLimit ? { complete: true, notice: "以上即全部匹配邮件，直接作答即可" } : {}),
    messages: raw,
    ...(actions.length ? { actions } : {}),
  }));
}

export async function execEmailSummarize(ctx: ToolCtx, args: z.infer<typeof emailSummarizeSchema>): Promise<string> {
  const note = gate(ctx, "email_summarize");
  if (note) return note;
  const batchIds = Array.isArray(args.messageIds) ? args.messageIds : [];
  if (!args.messageId && batchIds.length) {
    // 模型自己发明了 messageIds：这是有效意图，不算失败（不喂熔断计数），直接把请求转交出去
    const redirect = {
      redirect: "start_batch_task",
      messageIds: batchIds,
      notice: "多封邮件的总结不在本工具做（一封封循环会撞本轮调用上限，也没有进度条）。"
        + "请立即调用 start_batch_task，kind=\"email_summary\"，messageIds 照抄上面这串——"
        + "不要再用 inbox_search 重新查一遍，也不要回答「请你自己打开客户端查看」。",
    };
    audit(ctx, "email_summarize", "read", args, redirect, "auto");
    return okOut(redirect);
  }
  if (!args.messageId) {
    audit(ctx, "email_summarize", "read", args, undefined, "auto", "缺少 messageId");
    return failOut("missing_message_id", "缺少参数 messageId。请先用 inbox_search 拿到邮件 id 再总结。");
  }
  const row = getDb().select({
    id: inboxMessages.id, fromName: inboxMessages.fromName, fromEmail: inboxMessages.fromEmail,
    subject: inboxMessages.subject, bodyPreview: inboxMessages.bodyPreview,
    classification: inboxMessages.classification, intent: inboxMessages.intent,
    isRead: inboxMessages.isRead,
    matchedContactId: inboxMessages.matchedContactId,
  }).from(inboxMessages).where(eq(inboxMessages.id, args.messageId)).get();
  if (!row) {
    audit(ctx, "email_summarize", "read", args, undefined, "auto", `邮件 #${args.messageId} 不存在`);
    return failOut("not_found", `邮件 #${args.messageId} 不存在，请先用 inbox_search 查询`);
  }
  // 正文：全文本（懒加载含 IMAP 拉取）→ 去标签压成纯文本，避免 HTML 噪声进模型
  const bodyR = await getBody(args.messageId);
  const text = (bodyR.success ? bodyR.data : (row.bodyPreview || ""))
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2500);
  const contact = row.matchedContactId
    ? getDb().select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName, companyId: contacts.companyId })
        .from(contacts).where(eq(contacts.id, row.matchedContactId)).get()
    : undefined;
  const r = await summarizeEmail({
    fromName: row.fromName, fromEmail: row.fromEmail, subject: row.subject,
    bodyPreview: text || (row.bodyPreview ?? ""),
    matchedContactName: contact ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") : null,
    matchedCompany: contact?.companyId
      ? (getDb().select({ name: companies.name }).from(companies).where(eq(companies.id, contact.companyId)).get()?.name ?? null)
      : null,
  });
  if (!r.success) {
    audit(ctx, "email_summarize", "read", args, undefined, "auto", r.error);
    return failOut("summarize_failed", `总结失败：${r.error}`);
  }
  const summary = {
    id: row.id, from: row.fromName || row.fromEmail, subject: row.subject ?? "",
    summary: r.data.summary, nextStep: r.data.nextStep,
  };
  audit(ctx, "email_summarize", "read", args, summary, "auto");

  // P1-2/P1-3：按邮件类型给「顺手办掉」的写动作（点击才执行，落动作卡审计）
  const actions: AnyAction[] = [];
  const cls = String(row.classification ?? "");
  if (row.matchedContactId) {
    if (cls === "inquiry" || cls === "reply") {
      actions.push(registerAction({
        conversationId: ctx.conversationId, toolName: "email_summarize",
        label: "记一条跟进",
        confirm: `给联系人 #${row.matchedContactId} 记跟进：「${r.data.summary.slice(0, 40)}…」`,
        detail: "写入该联系人的跟进历史；只记事，不改阶段",
        diff: [
          { field: "note", label: "跟进内容", from: "—", to: `收到${cls === "inquiry" ? "询盘" : "回复"}：${r.data.summary.slice(0, 50)}` },
          { field: "direction", label: "方向", from: "—", to: "客户来件" },
        ],
        run: async () => {
          getDb().insert(interactions).values({
            contactId: row.matchedContactId!, type: "note", direction: "inbound",
            channel: "email", bodyPreview: `收到${cls === "inquiry" ? "询盘" : "回复"}：${r.data.summary}`,
          }).run();
          saveDatabase();
          return okResult(`已给联系人 #${row.matchedContactId} 记一条「收到${cls === "inquiry" ? "询盘" : "回复"}」的跟进`);
        },
      }));
    }
    if (cls === "bounce") {
      actions.push(registerAction({
        conversationId: ctx.conversationId, toolName: "email_summarize",
        label: "标记已流失",
        confirm: `把联系人 #${row.matchedContactId} 标记为「已流失」（邮箱退信）`,
        detail: "改的是 CRM 阶段；后续仍可手动改回",
        diff: [
          { field: "stage", label: "阶段", from: "当前阶段", to: "已流失 (lost)" },
          { field: "reason", label: "原因", from: "—", to: "邮箱退信" },
        ],
        run: async () => {
          const r2 = await setStage(row.matchedContactId!, "lost");
          return r2.success ? okResult(`已把联系人 #${row.matchedContactId} 标记为已流失`) : failResult(r2.error);
        },
      }));
    }
    if (cls === "inquiry" || cls === "reply") {
      actions.push(registerAction({
        conversationId: ctx.conversationId, toolName: "email_summarize",
        label: "标记已读",
        confirm: `把这封邮件（#${row.id}）标为已读`,
        diff: [{ field: "isRead", label: "状态", from: "未读", to: "已读" }],
        run: async () => {
          const r2 = markRead(row.id);
          return r2.success ? okResult("已标记已读") : failResult(r2.error);
        },
      }));
    }
  }
  // 询价联动：识别为询价的邮件，提示先查台账价再起草（quote_search → 草稿引用台账价）
  const quoteHint = row.intent === "price_inquiry"
    ? { notice: "这是询价邮件：起草回复前先用 quote_search 查该航线的台账价，把参考价写进草稿（注明以船司实时报价为准）。" }
    : {};
  return okOut({ ...summary, ...quoteHint, ...(actions.length ? { actions } : {}) });
}

export async function execEmailReadFull(ctx: ToolCtx, args: z.infer<typeof emailReadFullSchema>): Promise<string> {
  const gateNote = gate(ctx, "email_read_full");
  if (gateNote) return gateNote;
  const row = getDb().select().from(inboxMessages).where(eq(inboxMessages.id, args.messageId)).get();
  if (!row) return failOut("not_found", `邮件 #${args.messageId} 不存在，先 inbox_search 拿 id`);
  const bodyR = await getBody(args.messageId);
  // 落盘正文是原始 HTML（含签名档 base64 内嵌图），原样给模型和对话卡都是垃圾；
  // 统一转纯文本再返回
  const full = bodyR.success ? htmlToText(bodyR.data) : (row.bodyPreview || "");
  const CAP = 12_000;
  audit(ctx, "email_read_full", "read", args, { id: row.id, len: full.length }, "auto");
  // 工作台：邮件正文此前只在当轮上下文里，下一轮就蒸发（读过却答"没写柜型"的根因）。
  // contextLine 带正文要点摘录（空白折叠 350 字），让柜型/起运港/目的港等跨轮仍可见；
  // payload 存结构化头 + 更长正文摘录，供后续 generate_draft 程序化直取（见闭环规范 Phase 2）。
  rememberWork(ctx.conversationId, {
    kind: "email", refId: String(row.id), toolName: "email_read_full",
    contextLine: `邮件#${row.id} ${row.fromName || row.fromEmail}「${row.subject ?? "无主题"}」`
      + `${row.intent ? `[${row.intent}]` : ""}：${full.replace(/\s+/g, " ").trim().slice(0, 350)}`,
    payload: {
      id: row.id, from: row.fromEmail, fromName: row.fromName, to: row.to || null, cc: row.cc || null,
      subject: row.subject, receivedAt: row.receivedAt, classification: row.classification, intent: row.intent || null,
      bodyExcerpt: full.replace(/\s+/g, " ").trim().slice(0, 2000),
    },
  });
  return finishRead(ctx, "email_read_full", args, okOut({
    id: row.id, from: row.fromEmail, fromName: row.fromName,
    to: row.to || null, cc: row.cc || null, subject: row.subject,
    receivedAt: row.receivedAt, classification: row.classification, intent: row.intent || null,
    body: full.slice(0, CAP),
    // 弱模型读到全文后常停下来反问用户而不是起草；把下一步直接铺到脚边
    ...(full.length > CAP
      ? { notice: `正文共 ${full.length} 字，已截断到 ${CAP} 字；要存档用 export_artifact。` }
      : {}),
    nextStep: `用户若是想回复这封邮件：直接调 generate_draft 传 messageId=${row.id}（回信模式，自动带来信全文并逐条应答），不要反问用户要正文、语言或立场。`,
  }));
}

export async function execMailBrief(ctx: ToolCtx, args: Record<string, never>): Promise<string> {
  const cached = cachedRead(ctx, "mail_brief", args);
  if (cached) return cached;
  const r = todayMailBrief();
  if (!r.success) {
    audit(ctx, "mail_brief", "read", args, undefined, "auto", r.error);
    return failOut("brief_failed", r.error);
  }
  const b = r.data;
  audit(ctx, "mail_brief", "read", args, { day: b.day, inbound: b.inbound, awaiting: b.awaiting.length }, "auto");
  return finishRead(ctx, "mail_brief", args, okOut({
    day: b.day, inbound: b.inbound, unread: b.unread, byClass: b.byClass,
    priceInquiry: b.priceInquiry, sentToday: b.sentToday,
    awaiting: b.awaiting.map(m => ({
      id: m.id, from: m.fromName || m.fromEmail, fromEmail: m.fromEmail, subject: m.subject ?? null,
      收到时间: beijingTime(m.receivedAt), 已等小时: m.waitedHours, contactId: m.matchedContactId ?? undefined,
    })),
    latest: b.latest.map(m => ({
      id: m.id, from: m.fromName || m.fromEmail, subject: m.subject ?? null,
      classification: m.classification ?? "other", 收到时间: beijingTime(m.receivedAt), isRead: m.isRead,
    })),
    summary: b.summary,
    notice: "数字与时间以本工具为准（服务端按北京时间算好），不许自己换算时区或数条数。"
      + "要逐封看内容或起草回复：先 inbox_search 传 since=\"今天\"（需要含我方发出副本时再加 includeSent=true）拿 id，再 email_read_full。",
    nextStep: b.awaiting.length
      ? `有 ${b.awaiting.length} 封等你回复，最久 ${b.awaiting[0]!.waitedHours} 小时——要不要读 #${b.awaiting[0]!.id} 并起草回复？`
      : "今天没有待你回复的客户邮件。",
  }));
}
