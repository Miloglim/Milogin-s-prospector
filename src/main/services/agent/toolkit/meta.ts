// ── Agent Harness 工具层 · 元工具域（从 tools.ts 拆分）────────────────
// 工具：read_program_config / update_program_config / update_plan / export_artifact /
//       start_batch_task / report_gap。
import { z } from "zod";
import { writeArtifact, toCsv, type ArtifactFormat } from "../../artifact.service";
import { parseTsv } from "../parser";
import { startTask, normalizeBatchItems, normalizeBatchKind, normalizeMessageIds } from "../../bg-task.service";
import { reportGap as reportGapRow } from "../../gap.service";
import { lookupIdempotent, rememberResult } from "../idempotency";
import {
  gate, finishRead, okOut, failOut, audit, programConfigSnapshot, applyConfigPatch, normalizePlan,
  updatePlanSchema, type ToolCtx,
} from "./common";

// ── P2：产物导出 & 后台批量任务（元能力，均只读/只写产物目录）──────
export const exportArtifactSchema = z.object({
  // 参数只剩三个扁平字符串字段：弱模型手拼嵌套 JSON 数组极易写坏参数 JSON
  // （Invalid JSON input 发生在 SDK 内部，schema 宽松化与熔断都救不了，arch-export live 实锤），
  // 所以 csv 一律在 content 里写多行 TSV 文本，解析交给 parser.parseTsv。
  title: z.preprocess(
    (v: unknown) => (v == null || (typeof v === "string" && v.trim() === "") ? undefined : String(v)),
    z.string().max(60).nullable().optional(),
  ).describe("文件名（不带扩展名，如「未读邮件总结」）"),
  format: z.string().nullable().optional().describe("md 或 csv；其它写法按 md 处理"),
  content: z.string().nullable().optional()
    .describe("文件内容。md：Markdown 正文。csv：多行 TSV 文本——首行表头，每行一条记录，字段间用制表符分隔"),
});

const batchCompanySchema = z.object({
  name: z.string().describe("公司名（英文优先）"),
  country: z.string().nullable().optional().describe("国家/地区，帮助收敛搜索"),
});
export const startBatchTaskSchema = z.object({
  kind: z.string().nullable().optional().describe("backcheck=批量背调 / draft=批量开发信草稿 / email_summary=批量邮件总结；写「开发信」「写信」算 draft，写「总结邮件/邮件总结」算 email_summary"),
  companies: z.array(batchCompanySchema).nullable().optional().describe("backcheck/draft 用：要处理的公司列表，最多 10 家"),
  messageIds: z.array(z.number().int().positive()).nullable().optional().describe("email_summary 用：要总结的邮件 id 列表（来自 inbox_search），最多 60 封"),
});

export const updateProgramConfigSchema = z.object({
  domain: z.string().describe("配置域：schedule/quota/test/crm/identity"),
  kvs: z.string().describe("多行 key=value，只写要改的键"),
});

export const reportGapSchema = z.object({
  wanted: z.string().describe("想做但做不到的事，一句话"),
  scene: z.string().nullable().optional().describe("当时在办的事（如「跟进 jberrocal 的自动回复」）"),
  workaround: z.string().nullable().optional().describe("你给用户的绕行办法"),
});

export async function execReadProgramConfig(ctx: ToolCtx, args: Record<string, never>): Promise<string> {
  const gateNote = gate(ctx, "read_program_config");
  if (gateNote) return gateNote;
  const snap = programConfigSnapshot();
  audit(ctx, "read_program_config", "read", undefined, snap, "auto");
  return finishRead(ctx, "read_program_config", {}, okOut({
    config: snap,
    notice: "这是只读快照。用户要改配置时调用 update_program_config（会弹确认），不要自己承诺已改。",
  }));
}

export async function execUpdateProgramConfig(ctx: ToolCtx, args: z.infer<typeof updateProgramConfigSchema>): Promise<string> {
  const gateNote = gate(ctx, "update_program_config");
  if (gateNote) return gateNote;
  const r = applyConfigPatch(String(args.domain ?? "").trim(), String(args.kvs ?? ""));
  if (!r.success) {
    audit(ctx, "update_program_config", "write", args, undefined, "approved", r.error);
    return failOut("invalid_patch", r.error);
  }
  audit(ctx, "update_program_config", "write", args, r.data, "approved");
  return okOut({
    changed: r.data.changed,
    say: `已修改 ${r.data.changed.length} 项配置：` +
      r.data.changed.map((xx: { field: string; from: unknown; to: unknown }) => `${xx.field} ${String(xx.from)} → ${String(xx.to)}`).join("；"),
    notice: "配置即时生效，无需重启。若用户问为什么，说明改的是哪个域。",
  });
}

export async function execUpdatePlan(ctx: ToolCtx, args: z.infer<typeof updatePlanSchema>): Promise<string> {
  const gateNote = gate(ctx, "update_plan");
  if (gateNote) return gateNote;
  const items = normalizePlan(args.items);
  audit(ctx, "update_plan", "read", args, { steps: items.length }, "auto");
  return JSON.stringify(items.length
    ? { ok: true, notice: "清单已更新并展示给用户。直接继续执行下一步，不要在正文里复述这份清单。" }
    : { ok: false, notice: "清单为空（items 里每条都要有 text）。界面无变化；如非多步任务请直接作答，不要重复调用本工具。" });
}

export async function execExportArtifact(ctx: ToolCtx, args: z.infer<typeof exportArtifactSchema>): Promise<string> {
  const gateNote = gate(ctx, "export_artifact");
  if (gateNote) return gateNote;
  const dup = lookupIdempotent(ctx, "export_artifact", args);
  if (dup) return dup;
  const format: ArtifactFormat = /^csv$/i.test(String(args.format ?? "").trim()) ? "csv" : "md";
  const title = String(args.title ?? "").trim().slice(0, 40) || "导出内容";
  let content: string;
  if (format === "csv") {
    // csv 统一从 content 解析 TSV（rows 协议已废：嵌套数组 JSON 弱模型写坏率高）
    const rows = parseTsv(args.content ?? "")
      .slice(0, 500)
      .map(r => r.slice(0, 20).map(c => c.slice(0, 200)));
    if (!rows.length) {
      audit(ctx, "export_artifact", "read", args, undefined, "auto", "csv 缺少 content TSV");
      return failOut("missing_content",
        "导出 csv 需要 content：把表格写成多行 TSV 文本（首行表头，每行一条记录，字段间用制表符分隔）。请补齐后再调用本工具。");
    }
    content = toCsv(rows);
  } else {
    content = String(args.content ?? "").trim().slice(0, 64_000);
    if (!content) {
      audit(ctx, "export_artifact", "read", args, undefined, "auto", "content 为空");
      return failOut("missing_content", "导出 md 需要 content（Markdown 正文）。请补齐内容后再调用本工具。");
    }
  }
  const w = writeArtifact(title, format, content);
  if (!w.success) {
    audit(ctx, "export_artifact", "read", args, undefined, "auto", w.error);
    return failOut("write_failed", `导出失败：${w.error}`);
  }
  audit(ctx, "export_artifact", "read", args, w.data, "auto");
  const okMsg = okOut({ artifact: w.data, notice: "文件已生成，对话里已显示文件卡。正文给用户一句结论即可，禁止再贴全文。" });
  rememberResult(ctx, "export_artifact", args, okMsg);
  return okMsg;
}

export async function execStartBatchTask(ctx: ToolCtx, args: z.infer<typeof startBatchTaskSchema>): Promise<string> {
  const gateNote = gate(ctx, "start_batch_task");
  if (gateNote) return gateNote;
  const kind = normalizeBatchKind(args.kind);
  if (kind === "email_summary") {
    const ids = normalizeMessageIds(args.messageIds);
    if (!ids.length) {
      audit(ctx, "start_batch_task", "read", args, undefined, "auto", "邮件 id 为空");
      return failOut("missing_message_ids", "email_summary 需要 messageIds（先用 inbox_search 拿到邮件 id）。请让用户补充或先检索。");
    }
    const r = startTask(ctx.push, { conversationId: ctx.conversationId, kind, messageIds: ids });
    if (!r.success) { audit(ctx, "start_batch_task", "read", args, undefined, "auto", r.error); return failOut("start_failed", `启动后台任务失败：${r.error}`); }
    audit(ctx, "start_batch_task", "read", args, r.data, "auto");
    return okOut({ task: r.data, notice: `后台任务已启动（总结 ${r.data.total} 封），进度卡已在对话中展示，完成后自动生成文件产物。告诉用户可随时看进度、继续问别的，不要重复调用本工具。` });
  }
  const companies = normalizeBatchItems(args.companies);
  if (!companies.length) {
    audit(ctx, "start_batch_task", "read", args, undefined, "auto", "公司列表为空");
    return failOut("missing_companies", "companies 至少要有一家有 name 的公司。请让用户补充，或改用对应的单公司工具。");
  }
  const r = startTask(ctx.push, { conversationId: ctx.conversationId, kind, companies });
  if (!r.success) {
    audit(ctx, "start_batch_task", "read", args, undefined, "auto", r.error);
    return failOut("start_failed", `启动后台任务失败：${r.error}`);
  }
  audit(ctx, "start_batch_task", "read", args, r.data, "auto");
  return okOut({ task: r.data, notice: "后台任务已启动，进度卡已在对话中展示。告诉用户随时能看进度、可以继续问别的。不要重复调用本工具。" });
}

export async function execReportGap(ctx: ToolCtx, args: z.infer<typeof reportGapSchema>): Promise<string> {
  const gateNote = gate(ctx, "report_gap");
  if (gateNote) return gateNote;
  const r = reportGapRow(args);
  audit(ctx, "report_gap", "read", args, r.success ? r.data : undefined, "auto", r.success ? undefined : r.error);
  if (!r.success) return failOut("report_failed", `缺口登记失败：${r.error}`);
  return JSON.stringify({
    ok: true, gapId: r.data.gapId, hits: r.data.hits,
    notice: r.data.merged
      ? "该缺口此前已登记，本次计入抱怨次数。已足够，禁止再为同一缺口调用本工具。"
      : "缺口已登记进台账。如实把做不到和绕行办法讲给用户即可，禁止假装已完成。",
  });
}
