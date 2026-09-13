// ── Agent Harness 工具层 · 公共辅助（从 tools.ts 拆分）────────────────
// 只放纯辅助/公共包络/审计/配置控制面等跨域共用件；域工具各自在
// contacts.ts / rates.ts / inbox.ts / send.ts / research.ts / meta.ts。
import * as crypto from "crypto";
import { z } from "zod";
import { getDb, getRawDb, saveDatabase } from "../../../db";
import { loadConfig, saveConfig } from "../../../config";
import { readActiveEndpoint, endpointFamily } from "../../endpoint.service";
import { emailAccounts } from "../../../db/schema/accounts";
import { agentToolCalls } from "../../../db/schema/agent";
import { Log } from "../../../logger";
import { okResult, failResult, type Result } from "../../../errors";
import { checkBudget, ToolBudgetError } from "../policy";
import { lookupCache, rememberCache, countHit, countMiss } from "../tool-cache";
import { extractFact, rememberToolFact } from "../memory";
import { readIdentity } from "../identity";
import { listQuotes, countQuotes } from "../../rate-sync.service";
import type { ActionCard } from "../actions";
import type { ToolCtx } from "../types";

export type { ToolCtx } from "../types";
import type { ToolCtx as _ToolCtx } from "../types";

/** 同一工具连续失败达此数 → 本回合暂停该工具（Q5 熔断：不让模型换参数死磕） */
export const MAX_CONSECUTIVE_FAILURES = 2;

// ── 导入联系人的归一化（纯函数，可单测）──────────────────────────
export interface ImportContactInput {
  name?: string | null; email: string; company?: string | null; country?: string | null;
  title?: string | null; phone?: string | null; stage?: string | null; note?: string | null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const impClean = (s?: string | null): string => (s ?? "").replace(/[\t\r\n]+/g, " ").trim();
/** 与 importContacts 的字段键对齐（firstName/lastName/companyName/extraNote 都是它的既有列） */
export const IMPORT_HEADER = ["firstName", "lastName", "email", "companyName", "country", "title", "phone", "stage", "extraNote"] as const;

/** 把归一化后的联系人数组拼成 importer 吃的 TSV：校验邮箱、批内按邮箱去重、全名拆 first/last、阶段缺省 cold。 */
export function buildImportTsv(contacts: ImportContactInput[]): { tsv: string; invalid: string[]; count: number } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  const rows: string[][] = [];
  for (const c of contacts) {
    const email = (c.email ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) { invalid.push(impClean(c.name) || email || "(空)"); continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    const full = impClean(c.name);
    const sp = full.indexOf(" ");
    const first = sp < 0 ? full : full.slice(0, sp);
    const last = sp < 0 ? "" : full.slice(sp + 1);
    rows.push([first, last, email, impClean(c.company), impClean(c.country), impClean(c.title), impClean(c.phone), impClean(c.stage) || "cold", impClean(c.note)]);
  }
  const tsv = [IMPORT_HEADER.join("\t"), ...rows.map(r => r.join("\t"))].join("\n");
  return { tsv, invalid, count: rows.length };
}

/**
 * SDK 层失败识别：参数校验类错误（InvalidToolInputError 等）发生在 execute 之前，
 * 走不到我们的 audit，于是熔断计数原本对这类失败完全失明——实测 flash 把 contactId
 * 发成 "1" 后原样重试 5 次撞满 max turns 就是这么漏过去的。这里按输出文本补记。
 * 注意：只管 SDK 文本错误；我们自己工具的业务失败走统一包络 ok:false（见 isEnvelopeFailure），
 * 两者分工，熔断才不会双重计数。
 */
export function isToolRuntimeError(out: string): boolean {
  return /An error occurred while running the tool|InvalidToolInputError|tool (?:call )?error|执行失败/i.test(out);
}

/**
 * 结构化失败判定：统一包络 ok:false（execute 之内的业务失败）。
 * gate 的流控返回（budget_exhausted/tool_suspended）不带 ok 字段，不算失败。
 */
export function isEnvelopeFailure(out: string): boolean {
  try {
    const o = JSON.parse(out) as { ok?: unknown };
    return !!o && typeof o === "object" && o.ok === false;
  } catch { return false; }
}

/** 成功包络：业务字段原样平铺，只加 ok:true（不破坏模型已认识的字段名） */
export const okOut = (data: Record<string, unknown>): string => JSON.stringify({ ok: true, ...data });
/** 失败包络：code 供程序判断，message 是给模型看的人话（决定改参重试还是换路子） */
export const failOut = (code: string, message: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ok: false, error: { code, message }, ...extra });

/** 按工具输出记一次成/败（成功清零，失败累加，达阈值后 gate() 会让该工具本回合静默） */
export function noteToolOutcome(ctx: ToolCtx, toolName: string | undefined, output: string): void {
  if (!toolName) return;
  const fails = ctx.failures ?? (ctx.failures = new Map());
  if (isToolRuntimeError(output)) fails.set(toolName, (fails.get(toolName) ?? 0) + 1);
  else fails.set(toolName, 0);
}

/** 回合内可用性门闸：先熔断后预算；返回 null 表示放行 */
export function gate(ctx: ToolCtx, toolName: string): string | null {
  if ((ctx.failures?.get(toolName) ?? 0) >= MAX_CONSECUTIVE_FAILURES) {
    // 走失败包络：熔断态自持（模型再调仍计失败），失败卡也能如实显示
    return failOut("tool_suspended",
      `该工具本轮已连续失败 ${MAX_CONSECUTIVE_FAILURES} 次，不再可用——这是程序内部机制，对用户只字不提「次数/上限/不可用/工具」这类词。`,
      { notice: "请基于本回合已取到的数据直接给结论；没办成的部分用一句自然的话说明卡在哪（如「暂时没查到有效信息」）并给替代路径（换个说法、稍后再试，或交后台任务）。"
        + "不要重复调用本工具，也不要把没取到的内容编出来。" });
  }
  return budgetNote(ctx.counts, toolName);
}

/** 读工具统一入口：先查缓存（命中不占配额、不写审计），未过闸再返回暂停/预算提示 */
export function cachedRead(ctx: ToolCtx, toolName: string, args: unknown): string | null {
  const hit = lookupCache(ctx, toolName, args);
  if (hit !== null) { countHit(); return hit; }      // 命中：同一次查询的重复问法，不吃预算
  const note = gate(ctx, toolName);
  if (note) return note;
  countMiss();
  return null;
}

/** 读工具收尾：落审计 + 写缓存 */
export function finishRead(ctx: ToolCtx, toolName: string, args: unknown, result: string): string {
  rememberCache(ctx, toolName, args, result);
  return result;
}

/** 动作卡三类：write（主进程持闭包，点击才执行）/ prompt（续问）/ navigate（跳转查看） */
export const promptAction = (label: string, text: string) => ({ kind: "prompt" as const, label, text });
export const navAction = (label: string, href: string) => ({ kind: "navigate" as const, label, href });
export type AnyAction = ActionCard | ReturnType<typeof promptAction> | ReturnType<typeof navAction>;

/** CRM 发送阶段推进序（与 contacts.stage 及看板语义一致）：记完跟进给「下一步」建议用 */
const STAGE_SEQ: Array<{ key: string; label: string }> = [
  { key: "cold", label: "F1 首封触达" },
  { key: "f1", label: "F2 二次跟进" },
  { key: "f2", label: "F3 需求确认" },
  { key: "f3", label: "F4 报价推进" },
  { key: "f4", label: "合作洽谈" },
];
export function nextStageAfter(current: string | null): { key: string; label: string } | null {
  const i = STAGE_SEQ.findIndex(s => s.key === (current ?? "cold"));
  if (i < 0 || i >= STAGE_SEQ.length - 1) return null;
  return STAGE_SEQ[i + 1]!;
}

/** ISO/UTC 存储 → 北京时间可读串：时间交给模型换算就会编（实测把 12:13 写成 09:24） */
export function beijingTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return String(iso);
  const d = new Date(t + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const 日 = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return (d.toISOString().slice(0, 10) === new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
    ? "今天 " : 日 + " ") + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}

export const cell = (v: unknown): string => (v == null || v === "" ? "—" : String(v));

/**
 * 航线串拆成起运港/目的港：模型常整串传「上海到桑托斯」「Ningbo → Santos」，
 * 让它自己拆不稳（实测会把「桑托斯」拆成「托斯」）。拆不出来就交回调用方去问用户。
 */
export function splitRoute(route: string | null | undefined): { pol: string; pod: string } {
  const s = String(route || "").trim();
  if (!s) return { pol: "", pod: "" };
  const parts = s
    .split(/\s*(?:到|至|去|→|->|=>|\|{1,2}|[;,]|\/|[-—]\s?to\s?|\s+to\s+)\s*/i)
    .map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return { pol: parts[0]!.slice(0, 40), pod: parts[1]!.slice(0, 40) };
  return { pol: "", pod: "" };
}

/** 与本地运价镜像对照（只报库里真有的：条数、USD 区间、最晚有效期；没有就 null，不编造） */
export function mirrorCompareForPod(podEn: string, podCn: string): string | null {
  for (const term of [podEn, podCn]) {
    const t = String(term || "").trim();
    if (!t) continue;
    const rows = listQuotes({ terms: [t], limit: 30 });
    if (!rows.success || !rows.data.length) continue;
    const prices = rows.data.map(q => q.oceanUsd).filter((n): n is number => typeof n === "number" && n > 0).sort((a, b) => a - b);
    const total = countQuotes({ terms: [t] });
    const latest = rows.data.map(q => q.validTo || "").sort().pop();
    return `镜像库「${t}」有 ${total} 条参考价`
      + (prices.length ? `，区间 ${prices[0]}–${prices[prices.length - 1]} USD` : "")
      + (latest ? `，最晚有效期 ${latest}` : "")
      + "；公开来源报价与它的差距要逐条对照口径判断，不要直接比大小";
  }
  return null;
}

/** 预算超限时不 throw（模型会把 tool error 当“接口故障”继续绕），改为明确引导语令其基于已有数据作答。
 *  走失败包络（ok:false）：harness 的失败计数才能看见它——模型若无视引导继续调，
 *  连续 2 次后熔断接手（此前流控返回被当成功清零计数，重试风暴 10 连击就是这么漏的）。 */
function budgetNote(counts: Map<string, number>, toolName: string): string | null {
  try { checkBudget(counts, toolName); return null; }
  catch (e) {
    if (e instanceof ToolBudgetError) {
      const destructive = e.message.includes("不可逆");
      return failOut(destructive ? "destructive_once" : "turn_ceiling", e.message, {
        notice: "这一次调用没有执行——必须如实说「这一步没做」，并交付已完成的其它部分。"
          + "严禁把失败说成已完成（实测谎报「已删除另一批 13 人」即是事故），也不许规划「下次自动继续」："
          + "要不要继续由用户下一句决定。不要重复调用本工具。",
      });
    }
    throw e;
  }
}

/**
 * 宽松取值：模型常把 id 发成字符串（实测 flash 发 "1"）、把布尔发成 "false"、
 * 把 id 数组发成 "1,2"。zod 在这些情况下会抛 InvalidToolInputError —— 它发生在
 * execute 之前，我们的预算与熔断计数都看不见，模型只会原样重试到撞满 max turns。
 * 所以这里一律归一，归一不了就当没填，绝不让它炸。
 */
export const toInt = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined;
};
export const toBool = (v: unknown): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") return true;
    if (t === "false" || t === "0" || t === "no") return false;
  }
  return undefined;
};
export const toIds = (v: unknown): number[] => {
  const raw = Array.isArray(v) ? v
    : typeof v === "string" ? v.split(/[,;\s]+/) : [];
  return [...new Set(raw.map(toInt).filter((n): n is number => n !== undefined))].slice(0, 50);
};
/** 字符串数组宽容归一（模型常把数组发成 "a,b" 或 "a b"）：去重、去空、限量。
 *  刻意保留大小写——分组键（如 "SANTOS|EN"）要原样比对，需要小写的调用方自己转。 */
export const toWords = (v: unknown, max = 8): string[] => {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]+/) : [];
  return [...new Set(raw.map(s => String(s).trim()).filter(s => s && !isNoneish(s)))].slice(0, max);
};
/** 模型（尤其经 compat 网关的 agnes / deepseek）会把「没填」写成 Python 风格字符串 "None"，
 *  或塞 "N/A" "-" "/"「不限」当占位。不归一就会被当成真实筛选值——实测报
 *  「『None』在台账里不是可识别的目的港」、stage 值「None」不存在，模型原样重试 4 次
 *  烧掉 68k 输入什么也没交付。按本文件既定原则①：能用归一解决的绝不硬拒。 */
const NONEISH = new Set(["none", "null", "undefined", "nil", "n/a", "-", "—", "--", "/", "无", "不限", "全部", "所有", "任意"]);
/** 单个值是不是「等于没填」 */
export function isNoneish(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return false;
  const t = v.trim();
  return !t || NONEISH.has(t.toLowerCase());
}
/** 可选字符串：空串/全空格/null/「None 类占位」一律归一为「未填」，不留给下游判 */
export const optStr = (max: number) => z.preprocess(
  (v: unknown) => (isNoneish(v) ? undefined : v),
  z.string().max(max).nullable().optional(),
);

// 注意：可选字段必须 .nullable().optional() 成对出现 —— SDK 转 JSON Schema 时
// 只认这一种「可选」表达（少了 nullable 就整工具转换失败，实测踩过两次）。
export const optInt = () => z.preprocess((v: unknown) => toInt(v) ?? undefined, z.number().int().nullable().optional());
export const optBool = () => z.preprocess((v: unknown) => toBool(v) ?? undefined, z.boolean().nullable().optional());

// ── update_plan：界面任务清单（元工具，不读写任何业务数据）─────────────
export type PlanState = "pending" | "doing" | "done";
export interface PlanItem { /** 步骤稳定标识（文本哈希）：全量重发时渲染端据此识别同一步 */ id: string; text: string; state: PlanState }

const PLAN_DONE_RE = /^(done|completed|complete|finished|ok|已?完成|做完|已完成|已做)$/i;
const PLAN_DOING_RE = /^(doing|in[_\s-]?progress|running|active|wip|current|进行中|正在做|在做|当前)$/i;

/** 步骤 id：文本归一后的短哈希（同一步骤每次全量重发 id 不变） */
function planStepId(text: string): string {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 8);
}

/**
 * 归一模型给的清单：条数与文本长度在代码里钳制，状态词按同义词容错。
 * execute 与 harness 推 agent:plan 事件共用此口径，避免两处各写一套判据。
 */
export function normalizePlan(raw: unknown): PlanItem[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.slice(0, 8).map((entry): PlanItem => {
    const o = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const text = String(o.text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const st = String(o.state ?? "").trim();
    const state: PlanState = PLAN_DONE_RE.test(st) ? "done" : PLAN_DOING_RE.test(st) ? "doing" : "pending";
    return { id: planStepId(text), text, state };
  }).filter(i => i.text.length > 0);
}

const planItemSchema = z.object({
  text: z.string().describe("这一步做什么，一句话（如「检索 ACME 的联系人」）"),
  state: z.string().nullable().optional()
    .describe("pending=待办 / doing=进行中 / done=已完成；写 completed、in_progress 也会被归一"),
});

export const updatePlanSchema = z.object({
  items: z.array(planItemSchema).describe("全量清单（每次调用覆盖上一次，不是增量），最多 8 步"),
});

export function audit(ctx: ToolCtx, toolName: string, sideEffect: string, args: unknown,
               result: unknown, approval: string, error?: string): void {
  // 失败轨迹就地计数：带 error 的审计 = 这次没办成；办成立刻清零。
  // 空结果不算失败（那是真实数据，不是故障），因为空结果一律不带 error。
  const fails = ctx.failures ?? (ctx.failures = new Map());
  if (error) fails.set(toolName, (fails.get(toolName) ?? 0) + 1);
  else fails.set(toolName, 0);
  // 记忆写入：成功才抽一行事实给下一轮引用（失败与拒绝不值得记）
  if (!error) {
    const fact = extractFact(toolName, result);
    if (fact) rememberToolFact(ctx.conversationId, toolName, fact);
  }
  try {
    getDb().insert(agentToolCalls).values({
      conversationId: ctx.conversationId,
      toolName,
      sideEffect,
      argsJson: JSON.stringify(args),
      resultJson: result === undefined ? undefined : JSON.stringify(result).slice(0, 4000),
      approval,
      error,
    }).run();
    saveDatabase();
  } catch (err) {
    Log.warn("agent.audit", `工具留痕写入失败 ${toolName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 审计层对外暴露：审批被拒时由 dispatcher 记一行 rejected */
export function auditRejected(ctx: ToolCtx, toolName: string, argsJson: string | undefined): void {
  audit(ctx, toolName, "write", argsJson ? safeParse(argsJson) : undefined, undefined, "rejected", "用户拒绝执行");
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

// ── 控制面：配置快照与受控补丁（docs/agent-control-plane-spec.md）────────
// 密钥/端点密钥/检索源令牌永不进快照（红线）。
export function programConfigSnapshot() {
  const c = loadConfig();
  const ep = readActiveEndpoint();
  // 账号查询容错：无库环境（单测）返回空表，不阻塞快照其余部分
  let accounts: Array<{ email: string; displayName: string | null; isActive: number | null; lastFetchError: string | null }> = [];
  try {
    accounts = getDb().select({
      email: emailAccounts.email, displayName: emailAccounts.displayName,
      isActive: emailAccounts.isActive, lastFetchError: emailAccounts.lastFetchError,
    }).from(emailAccounts).all();
  } catch { /* DB 未初始化 */ }
  return {
    schedule: {
      timeWindowEnabled: c.schedule.timeWindowEnabled,
      startHour: c.schedule.startHour, endHour: c.schedule.endHour,
      groupSize: c.schedule.groupSize,
      groupDelayMinSeconds: c.schedule.groupDelayMinSeconds,
      groupDelayMaxSeconds: c.schedule.groupDelayMaxSeconds,
    },
    sendQuota: c.sendQuota ?? null,
    testMode: { enabled: c.test.enabled, dryRun: c.test.dryRun },
    identity: { ...readIdentity() },   // 仅 fromName 可配；公司身份恒定
    crm: { ...c.crm },
    accounts: accounts.map(a => ({
      email: a.email, displayName: a.displayName || null,
      isActive: !!a.isActive, lastFetchError: a.lastFetchError || null,
    })),
    endpoint: { model: ep.model || null, baseUrl: ep.baseUrl || null, family: endpointFamily(ep.baseUrl) },
  };
}

function parseBool(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (["true", "1", "yes", "是", "开", "on"].includes(s)) return true;
  if (["false", "0", "no", "否", "关", "off"].includes(s)) return false;
  throw new Error(`不是布尔值：${v}`);
}
function intIn(min: number, max: number) {
  return (v: string): number => {
    const n = Number(v.trim());
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`需 ${min}-${max} 的整数，收到 ${v}`);
    return n;
  };
}
function strMax(max: number) {
  return (v: string): string => {
    const s = v.trim();
    if (s.length > max) throw new Error(`超过 ${max} 字`);
    return s;
  };
}

/** 域 → 字段白名单与校验器；不在表里的键一律拒绝（防弱模型瞎传） */
const CONFIG_PATCHERS: Record<string, Record<string, (v: string) => number | boolean | string>> = {
  schedule: {
    timeWindowEnabled: parseBool, startHour: intIn(0, 23), endHour: intIn(0, 23),
    groupSize: intIn(1, 500), groupDelayMinSeconds: intIn(0, 86_400), groupDelayMaxSeconds: intIn(0, 86_400),
  },
  quota: { dailyLimit: intIn(1, 100_000) },
  test: { enabled: parseBool, dryRun: parseBool, email: strMax(80), company: strMax(80) },
  crm: {
    "followupDays.reaching": intIn(1, 365), "followupDays.quoting": intIn(1, 365),
    "followupDays.trial": intIn(1, 365), "followupDays.cooperating": intIn(1, 365),
    "followupDays.lost": intIn(1, 365), "followupDays.other": intIn(1, 365),
    todoAdvanceDays: intIn(0, 60), autoArchiveDays: intIn(0, 365),
  },
  // 注意：config.json 里的 identity{company/title/business/persona} 是历史死字段，
  // readIdentity() 只认 fromName（公司身份写死在 identity.ts）——白名单只开 fromName。
  identity: { fromName: strMax(40) },
};

/**
 * 应用配置补丁。kvs = 多行 "key=value"（弱模型友好，不传嵌套 JSON）。
 * 返回 before/after 差异供确认卡与回答展示；任一行非法 → 整批拒绝（不半改）。
 */
export function applyConfigPatch(domain: string, kvs: string):
  Result<{ changed: Array<{ field: string; from: unknown; to: unknown }> }> {
  const patchers = CONFIG_PATCHERS[domain];
  if (!patchers) {
    return failResult(`不支持的配置域「${domain}」，可用：${Object.keys(CONFIG_PATCHERS).join("/")}`);
  }
  const c = loadConfig();
  const target: Record<string, unknown> =
    domain === "schedule" ? { ...c.schedule } :
    domain === "quota" ? { ...(c.sendQuota ?? { dailyLimit: 1500, firstSendAt: null, sentToday: 0 }) } :
    domain === "test" ? { ...c.test } :
    domain === "crm" ? { ...c.crm, followupDays: { ...c.crm.followupDays } } :
    { fromName: c.fromName };
  const changed: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const line of kvs.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) return failResult(`行格式应为 key=value：${t}`);
    const key = t.slice(0, eq).trim();
    const raw = t.slice(eq + 1).trim();
    const p = patchers[key];
    if (!p) return failResult(`「${domain}」没有字段 ${key}，可用：${Object.keys(patchers).join("/")}`);
    let val: unknown;
    try { val = p(raw); } catch (e) { return failResult(e instanceof Error ? e.message : String(e)); }
    const from = key.includes(".")
      ? (target[key.split(".")[0]!] as Record<string, unknown>)[key.split(".")[1]!]
      : target[key];
    if (from === val) continue;
    if (key.includes(".")) {
      const [a, b] = key.split(".");
      (target[a!] as Record<string, unknown>)[b!] = val;
    } else target[key] = val;
    changed.push({ field: key, from, to: val });
  }
  if (!changed.length) return failResult("没有需要修改的字段（值与当前一致或 kvs 为空）");
  // 落盘
  if (domain === "schedule") c.schedule = target as unknown as typeof c.schedule;
  else if (domain === "quota") c.sendQuota = target as unknown as typeof c.sendQuota;
  else if (domain === "test") c.test = target as unknown as typeof c.test;
  else if (domain === "crm") c.crm = target as unknown as typeof c.crm;
  else c.fromName = String(target.fromName ?? c.fromName);
  saveConfig(c);
  return okResult({ changed });
}

/** 联系人 tags JSON → 字符串数组（容错） */
export const tagsArr = (s: string | null | undefined): string[] => {
  try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a.filter(x => typeof x === "string") : []; }
  catch { return []; }
};
