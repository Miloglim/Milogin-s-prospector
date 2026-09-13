// ── Agent Harness 工具层 · 联系人域（从 tools.ts 拆分）────────────────
// 工具：search_contacts / record_followup / delete_contacts / update_contact / import_contacts。
import { z } from "zod";
import { eq, like, or, and, sql, count, inArray } from "drizzle-orm";
import { getDb, saveDatabase } from "../../../db";
import { contacts } from "../../../db/schema/contacts";
import { companies } from "../../../db/schema/companies";
import { interactions } from "../../../db/schema/interactions";
import { inboxMessages } from "../../../db/schema/inbox";
import { invalidateCache } from "../tool-cache";
import { lookupIdempotent, rememberResult } from "../idempotency";
import { registerAction } from "../actions";
import { upsertContact, importContacts, deleteContactsBatch } from "../../contact.service";
import { parseDraft } from "../parser";
import { rememberWork, fingerprint } from "../working-memory";
import { generateEmailDraft } from "../../ai.service";
import { startDynamicSend } from "../../send.service";
import { okResult } from "../../../errors";
import { readIdentity } from "../identity";
import {
  gate, cachedRead, finishRead, okOut, failOut, audit, toIds, toInt, optStr, optInt, optBool,
  tagsArr, nextStageAfter, promptAction, buildImportTsv, IMPORT_HEADER, type AnyAction, type ToolCtx,
} from "./common";
import type { ToolCtx as _ToolCtx } from "../types";

export interface ResolvedContact { id: number; name: string; email: string; company: string | null }

/** 按 id / 邮箱 / 姓名 / 公司名在库里确定性定位联系人（最多回 10 条） */
export function resolveContacts(q: string): ResolvedContact[] {
  const tokens = (q || "").split(/\s+/).filter(Boolean).slice(0, 4);
  if (!tokens.length) return [];
  const rows = getDb().select({
    id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
    companyName: companies.name,
  }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(and(...tokens.map(tok => {
      const p = `%${tok}%`;
      return or(like(contacts.email, p), like(contacts.firstName, p), like(contacts.lastName, p), like(companies.name, p));
    }))).limit(10).all();
  return rows.map(r => ({
    id: r.id, name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
    email: r.email, company: r.companyName ?? null,
  }));
}

/**
 * 目标解析：contactId 优先，其次 contact（邮箱/姓名/公司名任一）。
 * 弱模型（实测 agnes-2.5-flash）串「先 search_contacts 再写」两步经常只走第一步，
 * 所以写工具自己定位人 —— 一步办成；检索在代码里做，不靠模型记忆。
 */
export function pickTarget(
  args: { contactId?: number | null; contact?: string | null },
): { ok: true; person: ResolvedContact } | { ok: false; why: "ambiguous" | "notfound"; candidates: ResolvedContact[] } {
  if (args.contactId) {
    const one = getDb().select({
      id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
      companyName: companies.name,
    }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id))
      .where(eq(contacts.id, args.contactId)).get();
    if (one) {
      return { ok: true, person: {
        id: one.id, name: [one.firstName, one.lastName].filter(Boolean).join(" ") || one.email,
        email: one.email, company: one.companyName ?? null,
      } };
    }
  }
  const found = resolveContacts(args.contact || "");
  if (found.length === 1) return { ok: true, person: found[0]! };
  return { ok: false, why: found.length > 1 ? "ambiguous" : "notfound", candidates: found };
}

export const candidatesText = (list: ResolvedContact[]) => list.slice(0, 5)
  .map(c => '#' + c.id + ' ' + c.name + (c.company ? '（' + c.company + '）' : '') + ' ' + c.email).join('；');

/** 回信模式收件人定位：fromEmail 精确等值（邮箱是唯一键；模糊匹配会跨国错配，禁用） */
export function pickByEmail(email: string): ResolvedContact | null {
  const e = (email || "").trim().toLowerCase();
  if (!e) return null;
  const one = getDb().select({
    id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
    companyName: companies.name,
  }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(sql`lower(${contacts.email}) = ${e}`).get();
  return one
    ? { id: one.id, name: [one.firstName, one.lastName].filter(Boolean).join(" ") || one.email, email: one.email, company: one.companyName ?? null }
    : null;
}

/** 按公司名模糊找库内记录：多命中时优先精确同名，其次首条（供背调联动判断「库里有没有」） */
export function findCompanyByName(name: string) {
  const tokens = name.split(/\s+/).filter(Boolean).slice(0, 4);
  if (!tokens.length) return undefined;
  const rows = getDb().select().from(companies)
    .where(and(...tokens.map(t => like(companies.name, `%${t}%`)))).all();
  if (!rows.length) return undefined;
  const exact = rows.find(r => r.name.trim().toLowerCase() === name.trim().toLowerCase());
  return exact ?? rows[0];
}

// ── Schema 设计原则（live 评测两轮实锤）─────────────────────────
// ① 能用「钳制/归一」解决的，绝不用 .max()/.enum() 硬拒：zod 校验失败发生在 execute 之前，
//    预算守卫拦不住，模型会当成接口故障反复重试直到 max turns。
// ② 可选字段一律 .nullable().optional()：SDK 转 JSON Schema 要求可选字段以 nullable 表达
//    （否则报 "uses .optional() without .nullable()"）；而 DeepSeek 等模型确实会把没用上的
//    字段回传 null —— 声明可空后 null 能过校验，下游用 ?? / ?. / 真值判断天然按「未填」处理。
export const searchContactsSchema = z.object({
  query: optStr(80).describe("姓名/邮箱/公司名关键词（可留空，留空时必须给下面的筛选条件）。别用单字母去全库扫——那是把 8000 多人一股脑拉回来，既慢又选不准人"),
  limit: optInt().describe("返回条数上限，默认 10（发成字符串也行）"),
  sortBy: optStr(12).describe("传 'stale' = 按最近跟进时间升序（沉默最久的排前面，适合「沉默最久的是谁」类问题）"),
  hasPhone: optBool().describe("传 true = 只返回有电话号码的联系人（适合「有电话的客户」「要打电话的名单」类问题）"),
  country: optStr(60).describe("按国家/地区筛选（模糊匹配联系人或公司的国家字段，如 巴西/Brazil/Mexico）；冷开发按国别圈人时用"),
  stage: optStr(16).describe("按发送阶段筛选，只认 cold/f1/f2/f3/f4（cold=还没开发过的冷客户）；也认中文别名 冷开发/跟进1..4。传别的值会当面报错并列出有效值"),
  status: optStr(16).describe("按发送状态筛选：reached=已触达 / replied=已回复 / bounced=退信 / autoreply=自动回复 / none=未触达(没发过或没触达过)。也认中文别名(已触达/已回复/退信/自动回复/未触达)。注意与 stage 是两个维度：stage=开发漏斗步骤(cold/f1-f4)，status=邮件发送结果。「跟进中的客户」= status:reached 或 replied。传别的值会当面报错"),
  industry: optStr(60).describe("按公司主营品类筛选（模糊匹配公司行业字段，如 家具/家具制造/furniture）"),
  silenceDays: optInt().describe("只要最近跟进早于 N 天的（含从未跟进过的）；冷开发挑沉默客户用，如 30=一个月没动静的"),
  validEmail: optBool().describe("传 true = 排除占位/无效邮箱（如 xxx@no.email 这类导入占位），只留能真发出去的"),
});

export const recordFollowupSchema = z.object({
  contactId: optInt().describe("联系人 id（可选；有 id 就不必填 contact）"),
  contact: optStr(80).describe("联系人定位串：邮箱、姓名或公司名任一（如 juan@acme.com 或 Juan Garcia）。本工具会自己在库里定位，不需要先调 search_contacts"),
  note: z.string().min(1).max(500).describe("跟进记录内容"),
});

export const deleteContactsSchema = z.object({
  contactIds: z.preprocess((v: unknown) => toIds(v), z.array(z.number().int().positive()).max(500).nullable().optional())
    .describe("首选：按上一步筛选出的确切 id 列表删除（照抄 search_contacts 返回的 id）。"
      + "模糊条件会误伤——实测按公司名 query 删，把不相干公司的联系人一起删了"),
  emailSuffix: optStr(60).describe("按邮箱后缀过滤（如 no.email）；与 query 二选一或并用"),
  query: optStr(80).nullable().describe("姓名/邮箱/公司名关键词（与 search_contacts 同词法）；只按后缀删时可传 null"),
});

export const updateContactSchema = z.object({
  contactId: optInt().describe("联系人 id（有它就不必填 contact）"),
  contact: optStr(80).describe("邮箱/姓名/公司名任一"),
  title: optStr(60), phone: optStr(40), country: optStr(40),
  clientType: optStr(10).describe("agent 或 direct"),
  tags: optStr(120).describe("逗号分隔标签，如 reaching,重点"),
  preference: optStr(200).describe("偏好备注，追加写入 extra.preferences"),
});

export const importContactsSchema = z.object({
  contacts: z.array(z.object({
    name: z.string().nullable().optional().describe("姓名（整串即可，工具自动拆名/姓）"),
    email: z.string().describe("邮箱，必填——去重与写入的唯一键，缺了这条会被判无效"),
    company: z.string().nullable().optional().describe("公司名"),
    country: z.string().nullable().optional().describe("国家/地区"),
    title: z.string().nullable().optional().describe("职位"),
    phone: z.string().nullable().optional().describe("电话"),
    stage: z.string().nullable().optional().describe("阶段 cold/f1-f4，留空按 cold"),
    note: z.string().nullable().optional().describe("备注"),
  })).min(1).describe("要导入的联系人：把用户粘贴的任意内容（表格/名单/邮件签名等）整理成这个数组即可，不要反问用户要 CSV 还是 JSON"),
});

// ── search_contacts 结构化筛选助手（冷开发按前置条件精确圈人，不再全库扫）──────
const STAGE_VALUES = ["cold", "f1", "f2", "f3", "f4"];
const STAGE_ALIAS: Record<string, string> = {
  cold: "cold", 冷开发: "cold", 冷: "cold", 未开发: "cold",
  f1: "f1", 跟进1: "f1", 跟进一: "f1", f2: "f2", 跟进2: "f2", 跟进二: "f2",
  f3: "f3", 跟进3: "f3", 跟进三: "f3", f4: "f4", 跟进4: "f4", 跟进四: "f4",
};
/** 归一阶段值：空→null（不过滤）；合法/别名→标准值；非法→undefined（调用方据此当面纠错，不静默降级） */
function normStage(raw: string | null | undefined): string | null | undefined {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (STAGE_VALUES.includes(low)) return low;
  return STAGE_ALIAS[t] ?? STAGE_ALIAS[low] ?? undefined;
}

const STATUS_VALUES = ["reached", "replied", "bounced", "autoreply", "none"];
const STATUS_ALIAS: Record<string, string> = {
  reached: "reached", 已触达: "reached", 触达: "reached", 触达过: "reached",
  replied: "replied", 已回复: "replied", 回复: "replied", 回复过: "replied",
  bounced: "bounced", 已退信: "bounced", 退信: "bounced",
  autoreply: "autoreply", 自动回复: "autoreply",
  none: "none", 未触达: "none", 无状态: "none", 未发送: "none", 没发过: "none",
};
const STATUS_LABEL: Record<string, string> = {
  reached: "已触达", replied: "已回复", bounced: "退信", autoreply: "自动回复", none: "未触达",
};
/** 归一发送状态：空→null（不过滤）；合法/别名→标准值（none=空状态哨兵，筛未触达用）；非法→undefined（当面纠错） */
function normStatus(raw: string | null | undefined): string | null | undefined {
  const t = (raw ?? "").trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (STATUS_VALUES.includes(low)) return low;
  return STATUS_ALIAS[t] ?? STATUS_ALIAS[low] ?? undefined;
}

type RawContactRow = {
  id: number; email: string; firstName: string | null; lastName: string | null;
  country: string | null; stage: string | null; status: string | null; companyName: string | null;
  title: string | null; tags: string | null; extra: string | null; lastFollowupAt: string | null;
};
function mapContactHit(r: RawContactRow) {
  return {
    id: r.id,
    name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
    email: r.email, company: r.companyName, country: r.country,
    stage: r.stage, status: r.status,
    title: r.title, tags: tagsArr(r.tags),
    preferences: (() => { try { const e = JSON.parse(r.extra || "{}"); return Array.isArray(e.preferences) ? e.preferences : []; } catch { return []; } })(),
    lastFollowupAt: r.lastFollowupAt ?? null,
  };
}

interface ContactSelectOpts {
  tokens: string[]; country?: string | null; stage?: string | null; status?: string | null;
  industry?: string | null; silenceDays?: number | null; validEmail?: boolean | null; hasPhone?: boolean | null;
  stale?: boolean; limit: number;
}
/**
 * 统一 CTE 选择器：关键词 + 结构化筛选 + 沉默天数，一次算清命中行与真总数。
 * 沉默比较坑：interactions.created_at 是「YYYY-MM-DD HH:MM:SS」、inbox.received_at 是 ISO「…T…Z」，
 * 混格式直接字符串比 cutoff 会错 → 用 substr(replace(last_at,'T',' '),1,10) 归一到日期粒度再比。
 * count 也走 .all()（部分测试 raw 库 shim 只实现 .all，不实现 .get）。
 */
function selectContactsRaw(o: ContactSelectOpts): { rows: RawContactRow[]; total: number } {
  const conds: string[] = [];
  const params: Array<string | number> = [];
  for (const tok of o.tokens) {
    conds.push("(c.email LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ? OR cp.name LIKE ?)");
    const p = `%${tok}%`; params.push(p, p, p, p);
  }
  if (o.country) {
    // 国家词中英加宽：数据归一后 country 多为英文(Brazil)，用户/模型常给中文「巴西」。
    // 对照表与运价链路共用（rate-update.service 唯一事实源）；认不出的词原样 LIKE，不猜。
    const words = countryMatchWords(o.country.trim()).map(w => w.toLowerCase());
    const cond = words.map(() => "(lower(c.country) LIKE ? OR lower(cp.country) LIKE ?)").join(" OR ");
    conds.push(`(${cond})`);
    for (const w of words) { const p = `%${w}%`; params.push(p, p); }
  }
  if (o.stage) { conds.push("c.stage = ?"); params.push(o.stage); }
  if (o.status) {
    if (o.status === "none") conds.push("(c.status IS NULL OR c.status = '')");   // 未触达=空状态
    else { conds.push("c.status = ?"); params.push(o.status); }
  }
  if (o.industry) { conds.push("cp.industry LIKE ?"); params.push(`%${o.industry.trim()}%`); }
  if (o.hasPhone) conds.push("(c.phone IS NOT NULL AND c.phone != '')");
  if (o.validEmail) conds.push("(instr(c.email,'@')>0 AND lower(c.email) NOT LIKE '%no.email%')");
  if (o.silenceDays && o.silenceDays > 0) {
    const cutoff = new Date(Date.now() - o.silenceDays * 86_400_000).toISOString().slice(0, 10);
    conds.push("(m.last_at IS NULL OR substr(replace(m.last_at,'T',' '),1,10) < ?)");
    params.push(cutoff);
  }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const cte = `WITH last_act AS (
     SELECT contact_id AS cid, MAX(created_at) AS at FROM interactions GROUP BY contact_id
     UNION ALL
     SELECT matched_contact_id, MAX(received_at) FROM inbox_messages WHERE matched_contact_id IS NOT NULL GROUP BY matched_contact_id
   ), merged AS (SELECT cid, MAX(at) AS last_at FROM last_act GROUP BY cid)`;
  const from = `FROM contacts c LEFT JOIN merged m ON m.cid = c.id LEFT JOIN companies cp ON cp.id = c.company_id`;
  const db = getRawDb();
  const nRow = db.prepare(`${cte} SELECT COUNT(*) AS n ${from} ${where}`).all(...params) as Array<{ n: number }>;
  const total = nRow[0]?.n ?? 0;
  const order = o.stale ? "ORDER BY (m.last_at IS NULL) DESC, m.last_at ASC" : "ORDER BY c.id DESC";   // 默认最新建档在前（本程序以邮件为脉搏，时效优先）
  const rows = db.prepare(
    `${cte} SELECT c.id AS id, c.email AS email, c.first_name AS firstName, c.last_name AS lastName,
       c.country AS country, c.stage AS stage, c.status AS status, cp.name AS companyName,
       c.title AS title, c.tags AS tags, c.extra AS extra, m.last_at AS lastFollowupAt
     ${from} ${where} ${order} LIMIT ?`,
  ).all(...params, o.limit) as RawContactRow[];
  return { rows, total };
}

// 依赖注入：countryMatchWords 从 rate-update.service 取（避免本文件直接引整表；与旧 tools.ts 同源）
import { countryMatchWords } from "../../rate-update.service";
import { getRawDb } from "../../../db";

export async function execSearchContacts(ctx: ToolCtx, args: z.infer<typeof searchContactsSchema>): Promise<string> {
  const cached = cachedRead(ctx, "search_contacts", args);
  if (cached) return cached;
  // 阶段值归一 + 当面纠错（非法值不静默降级，对齐 inbox_search 过滤词表原则）
  const stageNorm = normStage(args.stage);
  if ((args.stage ?? "").trim() && stageNorm === undefined) {
    return finishRead(ctx, "search_contacts", args, failOut("bad_filter",
      `stage 值「${args.stage}」不存在。有效值只有：cold / f1 / f2 / f3 / f4（冷开发=cold，跟进1..4=f1..f4）。多数联系人是 cold；不确定就去掉本过滤直接查。`));
  }
  // 发送状态归一 + 当面纠错（与 stage 同一原则）
  const statusNorm = normStatus(args.status);
  if ((args.status ?? "").trim() && statusNorm === undefined) {
    return finishRead(ctx, "search_contacts", args, failOut("bad_filter",
      `status 值「${args.status}」不存在。有效值：reached(已触达) / replied(已回复) / bounced(退信) / autoreply(自动回复) / none(未触达，即还没发过或没触达过)。「跟进中的客户」= reached 和 replied，两个都要就分两次查。不确定就去掉本过滤直接查。`));
  }
  // 按词切分匹配（live 评测实锤：模型常传全名 "Juan Garcia"，整串 LIKE 匹配不上单列 → 误判查无此人）
  const tokens = (args.query ?? "").split(/\s+/).filter(Boolean).slice(0, 4);
  const silence = args.silenceDays && args.silenceDays > 0 ? args.silenceDays : null;
  const hasStructFilter = !!(args.country || stageNorm || statusNorm || args.industry || silence || args.validEmail);
  const limit = Math.min(args.limit && args.limit > 0 ? args.limit : 10, 50);
  // 无任何检索/筛选条件 → 拒绝全库扫（冷开发"给了前置条件还全量扫"的根因就是没条件也硬扫）
  if (!tokens.length && !hasStructFilter && !args.hasPhone && args.sortBy !== "stale") {
    return failOut("no_criteria",
      "给一个检索关键词，或至少一个筛选条件（country 国家 / stage 阶段 / status 发送状态 / industry 行业 / silenceDays 沉默天数 / hasPhone 有电话）。不要用单字母全库扫——那会拉回几千人且选不准。");
  }
  const filtersApplied = [
    args.country ? `国家~${args.country}` : "", stageNorm ? `阶段=${stageNorm}` : "",
    statusNorm ? `状态=${STATUS_LABEL[statusNorm] ?? statusNorm}` : "",
    args.industry ? `行业~${args.industry}` : "", silence ? `沉默≥${silence}天` : "",
    args.validEmail ? "仅有效邮箱" : "", args.hasPhone ? "仅有电话" : "",
    args.sortBy === "stale" ? "按沉默排序" : "",
  ].filter(Boolean);
  // B：最近跟进时间（读时合并口径：interactions ∪ inbox 邮件取较新者，与 CRM 看板同源）—— drizzle 路径用
  const mergedLatest = (ids: number[]): Map<number, string> => {
    const m = new Map<number, string>();
    if (!ids.length) return m;
    const take = (cid: number | null, at: string | null) => {
      if (cid == null || !at) return;
      const cur = m.get(cid);
      if (!cur || at > cur) m.set(cid, at);
    };
    const chunk = 200;
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      const rows1 = getDb().select({ contactId: interactions.contactId, at: sql<string>`MAX(${interactions.createdAt})` })
        .from(interactions).where(inArray(interactions.contactId, part)).groupBy(interactions.contactId).all();
      for (const r of rows1) take(r.contactId, r.at);
      const rows2 = getDb().select({ cid: inboxMessages.matchedContactId, at: sql<string>`MAX(${inboxMessages.receivedAt})` })
        .from(inboxMessages).where(inArray(inboxMessages.matchedContactId, part)).groupBy(inboxMessages.matchedContactId).all();
      for (const r of rows2) take(r.cid, r.at);
    }
    return m;
  };
  type ContactHit = {
    id: number; name: string; email: string; company: string | null; country: string | null;
    stage: string | null; status: string | null; lastFollowupAt: string | null;
  };
  let out: ContactHit[];
  let total: number;
  if (hasStructFilter || args.sortBy === "stale") {
    // 带结构化筛选或沉默排序 → 统一 CTE 选择器：一次算清命中行 + 真总数（含 silenceDays 日期归一比较）
    const sel = selectContactsRaw({
      tokens, country: args.country ?? null, stage: stageNorm ?? null, status: statusNorm ?? null,
      industry: args.industry ?? null,
      silenceDays: silence, validEmail: args.validEmail ?? null, hasPhone: args.hasPhone ?? null,
      stale: args.sortBy === "stale", limit,
    });
    total = sel.total;
    out = sel.rows.map(mapContactHit) as ContactHit[];
  } else {
    // 纯关键词（可带 hasPhone）→ 保留原 drizzle 路径，行为与既往一致
    const perToken = tokens.map(tok => {
      const p = `%${tok}%`;
      return or(like(contacts.email, p), like(contacts.firstName, p), like(contacts.lastName, p), like(companies.name, p));
    });
    if (args.hasPhone) perToken.push(and(sql`${contacts.phone} IS NOT NULL`, sql`${contacts.phone} != ''`));
    const where = perToken.length ? and(...perToken) : undefined;
    total = getDb().select({ n: count() }).from(contacts)
      .leftJoin(companies, eq(contacts.companyId, companies.id)).where(where).all()[0]?.n ?? 0;
    const baseRows = getDb()
      .select({
        id: contacts.id, email: contacts.email,
        firstName: contacts.firstName, lastName: contacts.lastName,
        country: contacts.country, stage: contacts.stage, status: contacts.status,
        title: contacts.title, tags: contacts.tags, extra: contacts.extra,
        phone: contacts.phone,
        companyName: companies.name,
      })
      .from(contacts)
      .leftJoin(companies, eq(contacts.companyId, companies.id))
      .where(where)
      .limit(limit)
      .all();
    const latest = mergedLatest(baseRows.map(r => r.id));
    out = baseRows.map(r => ({
      id: r.id,
      name: [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email,
      email: r.email, company: r.companyName, country: r.country,
      stage: r.stage, status: r.status,
      title: r.title, tags: tagsArr(r.tags),
      preferences: (() => { try { const e = JSON.parse(r.extra || "{}"); return Array.isArray(e.preferences) ? e.preferences : []; } catch { return []; } })(),
      lastFollowupAt: latest.get(r.id) ?? null,
    }));
  }
  audit(ctx, "search_contacts", "read", args, out, "auto");
  // 空结果给显式收敛信号：模型往往会换词重试直至 max turns（live 评测实锤）
  if (out.length === 0) {
    return okOut({
      results: [], total: 0, ...(filtersApplied.length ? { filtersApplied } : {}),
      notice: filtersApplied.length
        ? `没有符合筛选条件（${filtersApplied.join("、")}）的联系人。如实告知用户，别用相同条件重复调用；可放宽某个条件再试。`
        : "库中没有匹配该关键词的联系人。请直接如实告知用户查无此人，不要用相同参数重复调用本工具。",
    });
  }
  // 工作台：命中的人此前跨轮即丢，下一轮要么重扫要么把别处的人混进来（跨国错配写进草稿的温床）。
  rememberWork(ctx.conversationId, {
    kind: "contacts",
    refId: fingerprint({ q: args.query, sortBy: args.sortBy, hasPhone: args.hasPhone, country: args.country, stage: stageNorm, industry: args.industry, silenceDays: silence, validEmail: args.validEmail, limit: args.limit }),
    toolName: "search_contacts",
    contextLine: `联系人${args.query ? `「${args.query}」` : ""}${filtersApplied.length ? `[${filtersApplied.join("、")}]` : ""}：命中 ${total}，返回 ${out.length}；`
      + out.slice(0, 5).map(c => `${c.name}(${c.company || "-"}/${c.country || "-"}/${c.stage || "-"})`).join("、"),
    payload: {
      query: args.query ?? null, total, returned: out.length,
      filters: { sortBy: args.sortBy ?? null, hasPhone: args.hasPhone ?? null, country: args.country ?? null, stage: stageNorm ?? null, industry: args.industry ?? null, silenceDays: silence, validEmail: args.validEmail ?? null },
      hits: out.slice(0, 30).map(c => ({
        id: c.id, name: c.name, email: c.email, company: c.company ?? null,
        country: c.country ?? null, stage: c.stage ?? null, lastFollowupAt: c.lastFollowupAt ?? null,
      })),
    },
  });
  const QUIET_NOTE = "本结果卡不会展示给用户（静默检索）：正文禁止复述联系人名单或按行描述，直接给结论；"
    + "只允许引用本批 results 里的人——此前对话或其他来源的联系人（姓名/公司/备注）一律不得混入本轮回答，results 里没有就明说未检索到。";
  const completeNote = total <= out.length
    ? { complete: true as const, notice: `命中数据已全部返回（共 ${total} 条），无需再调用本工具，直接作答。沉默天数请直接引用 lastFollowupAt 与正文计算结果，不要自己换算。${QUIET_NOTE}` }
    : { notice: `共命中 ${total} 条，本批返回前 ${out.length} 条（sortBy:'stale' 时为沉默最久的前若干名）。回答时必须说明「共 ${total} 条，展示前 ${out.length} 条」，不要把本批行数说成总数。${QUIET_NOTE}` };
  // 唯一命中 → 直接续问写开发信（带上 contactId，草稿结果卡才能长出「入队」按钮）
  if (out.length === 1 && total === 1) {
    const one = out[0]!;
    return okOut({
      results: out, total, ...(filtersApplied.length ? { filtersApplied } : {}),
      actions: [promptAction(
        "给 TA 写一封开发信",
        `给联系人 #${one.id} ${one.name}（${one.company || "无公司名"}${one.country ? `，${one.country}` : ""}）写一封开发信，先想清楚切入点再动笔`,
      )],
    });
  }
  // P1-5：多命中 → 两种批量路径任选：整批各生成一封入队（写动作），或续问聚焦
  const batch = out.slice(0, 10);
  const sender = readIdentity();
  return okOut({
    results: out, total, ...completeNote, ...(filtersApplied.length ? { filtersApplied } : {}),
    actions: [
      registerAction({
        conversationId: ctx.conversationId, toolName: "search_contacts",
        label: `给这 ${batch.length} 位各生成一封跟进信`,
        confirm: `为检索到的前 ${batch.length} 位联系人各生成一封跟进信并加入发送队列`,
        detail: "入队 ≠ 发送：到「发送中心」核对后手动点开始；每人一封、按各自语言",
        diff: [
          { field: "targets", label: "收件人", from: "—", to: batch.slice(0, 5).map(c => `#${c.id} ${c.name}`).join("、") + (batch.length > 5 ? ` 等 ${batch.length} 人` : "") },
        ],
        target: { label: "去发送中心", href: "#/campaigns" },
        run: async () => {
          const queued: string[] = [];
          const failed: string[] = [];
          for (const c of batch) {
            const contact = getDb().select({
              id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName,
              language: contacts.language, companyId: contacts.companyId, email: contacts.email,
            }).from(contacts).where(eq(contacts.id, c.id)).get();
            if (!contact) { failed.push(`#${c.id}`); continue; }
            const companyName = contact.companyId
              ? (getDb().select({ name: companies.name }).from(companies).where(eq(companies.id, contact.companyId)).get()?.name ?? "")
              : "";
            const lang = ["ES", "PT"].includes(String(contact.language ?? "").toUpperCase())
              ? (String(contact.language).toUpperCase() as "ES" | "PT") : "EN";
            const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email;
            const draft = await generateEmailDraft({ language: lang, companyName: companyName || c.company || name, contactName: name, sender });
            if (!draft.success) { failed.push(name); continue; }
            const { subject, body } = parseDraft(draft.data, `Following up — ${companyName || name}`);
            const q = await startDynamicSend([contact.id], subject, body, false);
            if (q.success) queued.push(name); else failed.push(name);
          }
          return okResult(
            `批量成信完成：${queued.length} 封已入队${queued.length ? `（${queued.join("、")}）` : ""}`
            + (failed.length ? `；${failed.length} 位未成（${failed.join("、")}）` : "")
            + "。队列未启动，请到「发送中心」核对后点开始。",
          );
        },
      }),
      promptAction("先看清这批人再决定", `把刚才检索到的 ${batch.length} 位联系人按公司归组，说明各自阶段与国家，帮助判断该给谁写信`),
    ],
  });
}

export async function execRecordFollowup(ctx: ToolCtx, args: z.infer<typeof recordFollowupSchema>): Promise<string> {
  const gateNote = gate(ctx, "record_followup");
  if (gateNote) return gateNote;
  // 幂等：同一会话里相同内容 5 分钟内只落一次（模型重复提交/用户连点）
  const dup = lookupIdempotent(ctx, "record_followup", args);
  if (dup) return dup;
  // 定位人：id 或 邮箱/姓名/公司名任一（弱模型不必先调 search_contacts）
  const target = pickTarget(args);
  if (!target.ok) {
    const why = target.why === "ambiguous"
      ? `「${args.contact}」匹配到多位联系人，请用 contactId 指定其一：${candidatesText(target.candidates)}`
      : `库里找不到「${args.contact ?? `#${args.contactId}`}」，请先用 search_contacts 确认这人是否已建档`;
    audit(ctx, "record_followup", "write", args, undefined, "approved", "未定位到联系人");
    return failOut(target.why, why);
  }
  const pid = target.person.id;
  getDb().insert(interactions).values({
    contactId: pid, type: "note", direction: "outbound",
    channel: "manual", bodyPreview: args.note,
  }).run();
  saveDatabase();
  audit(ctx, "record_followup", "write", args, { ok: true }, "approved");
  invalidateCache("record_followup");
  const who = `${target.person.name}（#${pid}${target.person.company ? ` · ${target.person.company}` : ""}）`;
  const stageRow = getDb().select({ stage: contacts.stage }).from(contacts).where(eq(contacts.id, pid)).get();
  const nextStage = nextStageAfter(stageRow?.stage ?? null);
  const out = okOut({
    say: `已为 ${who} 记录跟进。`,
    notice: nextStage
      ? `提示用户：TA 当前阶段是「${stageRow?.stage ?? "冷开发"}」，要不要顺手推进到「${nextStage.label}」？（可在 CRM 看板里改，或让我用动作卡来做）`
      : "（该联系人已是终态阶段，无需推进）",
  });
  rememberResult(ctx, "record_followup", args, out);
  return out;
}

export async function execDeleteContacts(ctx: ToolCtx, args: z.infer<typeof deleteContactsSchema>): Promise<string> {
  const gateNote = gate(ctx, "delete_contacts");
  if (gateNote) return gateNote;
  const suffix = (args.emailSuffix ?? "").trim().replace(/^@/, "");
  const tokens = String(args.query ?? "").split(/\s+/).filter(Boolean).slice(0, 4);
  const exactIds = (args.contactIds ?? []).filter(n => Number.isInteger(n) && n > 0);
  if (!suffix && !tokens.length && !exactIds.length) {
    return failOut("invalid_args", "要给 contactIds（首选，按上一步筛选的确切名单）、emailSuffix 或 query 之一，拒绝无条件全库删除。");
  }
  // 精确 id 路径：只删用户/上一步确认过的那批，不做任何模糊匹配
  if (exactIds.length) {
    const hits = getDb().select({
      id: contacts.id, email: contacts.email, firstName: contacts.firstName, lastName: contacts.lastName,
    }).from(contacts).where(inArray(contacts.id, exactIds)).all();
    if (!hits.length) {
      audit(ctx, "delete_contacts", "write", args, { matched: 0 }, "approved");
      return okOut({ matched: 0, notice: "这些 id 在库里已不存在（可能刚删过）。如实告知用户，不要重复调用。" });
    }
    if (hits.length > 500) {
      return failOut("over_limit", `给了 ${hits.length} 个 id，超过单次上限 500，请分批。`);
    }
    const dr = deleteContactsBatch(hits.map(h => h.id));
    if (!dr.success) {
      audit(ctx, "delete_contacts", "write", args, undefined, "approved", dr.error);
      return failOut("delete_failed", `删除失败：${dr.error}`);
    }
    invalidateCache("search_contacts");
    invalidateCache("reminders_due");
    const dSample = hits.slice(0, 5).map(h => `#${h.id} ${[h.firstName, h.lastName].filter(Boolean).join(" ") || h.email}`).join("、");
    audit(ctx, "delete_contacts", "write", { ids: hits.length }, { deleted: dr.data.deleted }, "approved");
    return okOut({
      deleted: dr.data.deleted, companiesRemoved: dr.data.companiesRemoved, matched: hits.length,
      say: `已删除 ${dr.data.deleted} 个联系人${dr.data.companiesRemoved ? `（含 ${dr.data.companiesRemoved} 个空壳公司自动清理）` : ""}：${dSample}${hits.length > 5 ? ` 等 ${hits.length} 人` : ""}。`,
      notice: `只删了给定的 ${hits.length} 个 id（无模糊匹配）。不可恢复。还有没删的部分要如实说明条数，别声称全删完。`,
    });
  }
  // 后缀条件是 AND（no.email）；query 的多词是 OR 组——语义：后缀命中且（含任一关键词）
  const suffixConds = suffix ? [like(contacts.email, `%${suffix}`)] : [];
  const tokenConds = tokens.flatMap(tok => [like(contacts.email, `%${tok}%`), like(contacts.firstName, `%${tok}%`), like(contacts.lastName, `%${tok}%`), like(companies.name, `%${tok}%`)]);
  const where = and(...suffixConds, ...(tokenConds.length ? [or(...tokenConds)] : []));
  const hits = getDb().select({
    id: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
  }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id))
    .where(where).limit(501).all();
  const total = hits.length === 501 ? getDb().select({ n: count() }).from(contacts).leftJoin(companies, eq(contacts.companyId, companies.id)).where(where).all()[0]!.n : hits.length;
  if (!hits.length) {
    audit(ctx, "delete_contacts", "write", args, { matched: 0 }, "approved");
    return okOut({ matched: 0, notice: "没有命中任何联系人，未执行删除。请如实告知用户（可能后缀拼写不同），不要重复调用。" });
  }
  if (total > 500) {
    audit(ctx, "delete_contacts", "write", args, { matched: total, refused: "over_limit" }, "approved");
    return failOut("over_limit", `命中 ${total} 人超过单次上限 500。请提示用户缩小条件（加关键词/分批）后重试，不要自己放宽条件。`);
  }
  // 执行删除（确认已由 SDK 中断流完成；此处 ids 是确认卡上那批的子集校验）
  const ids = hits.map(h => h.id);
  const r = deleteContactsBatch(ids);
  if (!r.success) {
    audit(ctx, "delete_contacts", "write", args, undefined, "approved", r.error);
    return failOut("delete_failed", `删除失败：${r.error}`);
  }
  invalidateCache("search_contacts");
  invalidateCache("reminders_due");
  const sample = hits.slice(0, 5).map(h => `#${h.id} ${[h.firstName, h.lastName].filter(Boolean).join(" ") || h.email}`).join("、");
  audit(ctx, "delete_contacts", "write", args, { deleted: r.data.deleted, companiesRemoved: r.data.companiesRemoved, sample }, "approved");
  return okOut({
    deleted: r.data.deleted, companiesRemoved: r.data.companiesRemoved, matched: total,
    say: `已删除 ${r.data.deleted} 个联系人${r.data.companiesRemoved ? `（含 ${r.data.companiesRemoved} 个空壳公司自动清理）` : ""}：${sample}${total > 5 ? ` 等 ${total} 人` : ""}。`,
    notice: "已删除不可恢复。若用户后续要找回，只能从备份导入。提醒用户相关往来记录已一并删除。",
  });
}

export async function execUpdateContact(ctx: ToolCtx, args: z.infer<typeof updateContactSchema>): Promise<string> {
  const gateNote = gate(ctx, "update_contact");
  if (gateNote) return gateNote;
  const target = pickTarget(args);
  if (!target.ok) {
    const why = target.why === "ambiguous"
      ? `「${args.contact}」匹配到多位联系人，请用 contactId 指定：${candidatesText(target.candidates)}`
      : `库里找不到「${args.contact ?? `#${args.contactId}`}」`;
    audit(ctx, "update_contact", "write", args, undefined, "approved", why);
    return failOut(target.why, why);
  }
  const id = target.person.id;
  const row = getDb().select().from(contacts).where(eq(contacts.id, id)).get();
  if (!row) return failOut("notfound", "联系人已不存在");
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  const changed: string[] = [];
  if (args.title != null) { set.title = args.title; changed.push(`职位→${args.title}`); }
  if (args.phone != null) { set.phone = args.phone; changed.push(`电话→${args.phone}`); }
  if (args.country != null) { set.country = args.country; changed.push(`国家→${args.country}`); }
  if (args.clientType != null) {
    if (!["agent", "direct"].includes(args.clientType)) return failOut("invalid", "clientType 只能是 agent 或 direct");
    set.clientType = args.clientType; changed.push(`客户类型→${args.clientType}`);
  }
  if (args.tags != null) {
    const arr = args.tags.split(/[,，]/).map(s => s.trim()).filter(Boolean).slice(0, 6);
    set.tags = JSON.stringify(arr); changed.push(`标签→${arr.join("/") || "清空"}`);
  }
  if (args.preference != null) {
    let extra: Record<string, unknown> = {};
    try { extra = JSON.parse(row.extra || "{}"); } catch { /* 坏 JSON 当空 */ }
    const prefs = Array.isArray(extra.preferences) ? extra.preferences as string[] : [];
    if (!prefs.includes(args.preference)) prefs.push(args.preference);
    extra.preferences = prefs.slice(-10);
    set.extra = JSON.stringify(extra); changed.push("偏好已追加");
  }
  if (!changed.length) return failOut("noop", "没有要改的字段");
  getDb().update(contacts).set(set).where(eq(contacts.id, id)).run();
  saveDatabase();
  invalidateCache("update_contact");
  audit(ctx, "update_contact", "write", args, { id, changed }, "approved");
  return okOut({ id, changed, say: `已更新联系人 #${id}：${changed.join("；")}` });
}

export async function execImportContacts(ctx: ToolCtx, args: z.infer<typeof importContactsSchema>): Promise<string> {
  const gateNote = gate(ctx, "import_contacts");
  if (gateNote) return gateNote;
  const { tsv, invalid, count } = buildImportTsv(args.contacts);
  const total = args.contacts.length;
  if (count === 0) {
    audit(ctx, "import_contacts", "write", args, undefined, "approved", "无有效邮箱可导入");
    return failOut("no_valid_contacts",
      `没有可导入的联系人：${total} 条里 ${invalid.length} 条邮箱无效或缺失。每条必须有合法邮箱，请核对后重试。`);
  }
  const mapping = Object.fromEntries(IMPORT_HEADER.map((h) => [h, h]));
  const res = await importContacts({ mode: "execute", type: "tsv", data: tsv, mapping });
  if (!res.success) {
    audit(ctx, "import_contacts", "write", args, undefined, "approved", res.error);
    return failOut("import_failed", `导入失败：${res.error}`);
  }
  const { imported, skipped } = res.data;
  audit(ctx, "import_contacts", "write", args, { imported, skipped, invalid: invalid.length }, "approved");
  invalidateCache("search_contacts");
  saveDatabase();
  return okOut({
    say: `导入完成：新增 ${imported} 位，跳过 ${skipped} 位（邮箱已存在/为空），无效 ${invalid.length} 位`
      + (invalid.length ? `（如 ${invalid.slice(0, 3).join("、")}）` : "") + "。",
    notice: "要不要按公司/国家汇总一下，或挑几位直接进开发信？",
    imported, skipped, invalidCount: invalid.length,
  });
}
