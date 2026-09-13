// ── Agent Harness 工具层 · 联网调研域（从 tools.ts 拆分）────────────────
// 工具：market_research / company_backcheck。
import { z } from "zod";
import { runResearchScene, CRED_LABEL } from "../../research.service";
import { searchCompany, generateBackcheckReport, type BackcheckReport } from "../../ai.service";
import { upsertCompany } from "../../company.service";
import { writeArtifact } from "../../artifact.service";
import { registerAction } from "../actions";
import { okResult, failResult } from "../../../errors";
import { findCompanyByName } from "./contacts";
import {
  gate, finishRead, okOut, failOut, audit, promptAction, navAction, splitRoute, mirrorCompareForPod, cell,
  optStr, type AnyAction, type ToolCtx,
} from "./common";

export const marketResearchSchema = z.object({
  route: optStr(80).describe("整串航线，如「上海到桑托斯」「Ningbo → Santos」（工具内部会拆成起运/目的港）"),
  pol: optStr(40).describe("起运港（与 route 二选一；中文名/英文/UNLOCODE 都行）"),
  pod: optStr(40).describe("目的港（与 route 二选一）"),
  scope: optStr(12).describe("rates=只看运价 / schedules=只看船期 / both=两者（默认 both）"),
  container: optStr(8).describe("柜型 20GP / 40GP / 40HQ，留空为不限"),
  weeks: optInt().describe("时间窗「近期」按最近 N 周，默认 4，上限 12"),
});

export const companyBackcheckSchema = z.object({
  companyName: z.string().min(2).max(80).describe("公司名（英文优先，可用行业常见拼写）"),
  country: optStr(40).describe("国家/地区，帮助收敛搜索"),
});

import { optInt } from "./common";

export async function execMarketResearch(ctx: ToolCtx, args: z.infer<typeof marketResearchSchema>): Promise<string> {
  const note = gate(ctx, "market_research");
  if (note) return note;
  const fromRoute = splitRoute(args.route);
  const pol = (args.pol || "").trim() || fromRoute.pol;
  const pod = (args.pod || "").trim() || fromRoute.pod;
  if (!pol || !pod) {
    // 方法论要求：只追问这两个港口，其余用默认值。这是待补信息、不是故障 → ok:true、不带 error、不喂熔断计数
    const need = {
      needPorts: true,
      notice: "调研一条航线只需要两个必填项：起运港与目的港。请用一句话问用户（如「从哪个港到哪个港？柜型要不要限定？」），"
        + "拿到后直接再调本工具；柜型与时间窗可以留空走默认。",
    };
    audit(ctx, "market_research", "read", args, need, "auto");
    return okOut(need);
  }
  const scopeRaw = String(args.scope || "").trim().toLowerCase();
  const scope = scopeRaw === "rates" || scopeRaw === "schedules" ? scopeRaw : "both";
  const r = await runResearchScene(
    { pol, pod, scope, container: (args.container || "").trim() || undefined, weeks: args.weeks ?? undefined },
    { mirrorCompare: mirrorCompareForPod },
  );
  if (!r.success) {
    audit(ctx, "market_research", "read", args, undefined, "auto", r.error);
    return failOut("research_failed", r.error, {
      notice: "请如实告诉用户这次没查到公开行情、以及要补哪一项，"
        + "禁止凭自己的知识给运价数字；用户台账里的价格可以用 quote_search 查。",
    });
  }
  const o = r.data.out;
  const rows = o.rates.map(x => ({
    source: x.source.slice(0, 40), value: x.value, scope: x.scope,
    published: x.published, credibility: CRED_LABEL[x.credibility], url: x.url,
  }));
  // 报告不自动落盘（调研一成功就写文件会在回合中段抢跑，用户没点头前一个字不落盘）：
  // 注册成写动作卡，正文照常给结论，想要文件点「保存调研报告」才写，执行走统一审计。
  const saveReport = registerAction({
    conversationId: ctx.conversationId, toolName: "market_research",
    label: "保存调研报告",
    confirm: "把这次调研存成报告文件？",
    detail: "含全部来源链接与日期，存到 outputs/agent 目录；不发邮件、不改任何数据",
    diff: [{ field: "report", label: "报告文件", from: "未保存", to: `航线调研 ${o.route}.md` }],
    run: async () => {
      const w = writeArtifact(`航线调研 ${o.route}`, "md", o.report);
      return w.success ? okResult(`报告已保存：${w.data.path}`) : failResult(w.error);
    },
  });
  const out = {
    route: o.route,
    window: o.window,
    checked: `${o.evidenceCount.fetched}/${o.evidenceCount.hits} 个来源通过页面核实`,
    say: rows.length
      ? `公开来源核实完成：${o.conclusions.length} 条结论、${rows.length} 条运价来源可引用`
      : "本轮没有通过核实的公开来源，因此不给运价数字（缺口见 gaps）",
    conclusions: o.conclusions.map(c => c.text),
    results: rows,
    gaps: o.gaps.slice(0, 5),
    dropped: o.dropped.slice(0, 5),
    actions: [saveReport],
    notice: "报告没有自动保存：结果卡下方有「保存调研报告」按钮，用户点击才会生成文件——正文不要声称文件已生成；"
      + "用户想要文件时，提示他点这个按钮即可。正文只讲结论加一句时效提醒（即期价以天计变化）；"
      + "明细表已由界面表格卡呈现，不要再自建汇总表，也不要补表里没有的数字、日期或来源。",
  };
  audit(ctx, "market_research", "read", args, out, "auto");
  return finishRead(ctx, "market_research", args, okOut(out));
}

export async function execCompanyBackcheck(ctx: ToolCtx, args: z.infer<typeof companyBackcheckSchema>): Promise<string> {
  const note = gate(ctx, "company_backcheck");
  if (note) return note;
  const query = `${args.companyName}${args.country ? ` ${args.country}` : ""} importer products supplier`;
  const hits = await searchCompany(query);
  if (!hits.success || hits.data.length === 0) {
    const msg = hits.success
      ? "网络搜索未找到该公司资料，无法生成背调报告"
      : `搜索数据源不可用：${hits.error}（需在设置中配置 EXA_API_KEY 或 TAVILY_API_KEY）`;
    audit(ctx, "company_backcheck", "read", args, undefined, "auto", msg);
    return failOut(hits.success ? "no_hits" : "search_source_unavailable", msg);
  }
  const r = await generateBackcheckReport(
    { companyName: args.companyName, country: args.country ?? undefined },
    hits.data,
  );
  if (!r.success) {
    audit(ctx, "company_backcheck", "read", args, undefined, "auto", r.error);
    return failOut("generate_failed", `背调生成失败：${r.error}`);
  }
  const report = r.data;
  const matched = findCompanyByName(args.companyName);
  const industryGuess = Array.isArray(report.categories) ? report.categories.slice(0, 3).join("、") : "";
  const backcheckJson = JSON.stringify(report);
  const actions: AnyAction[] = [];

  if (matched) {
    // 库里已有 → 提议把背调结论写回公司档案（点击才执行）
    actions.push(registerAction({
      conversationId: ctx.conversationId, toolName: "company_backcheck",
      label: "写入公司档案",
      confirm: `把这次背调结论写入「${matched.name}」的公司档案`,
      detail: "只更新背调结论与空缺字段，不动已有联系人",
      diff: [
        { field: "backcheck", label: "背调结论", from: matched.backcheckData ? "已有旧版（将被覆盖）" : "无", to: `${cell(report.summary)}（评分 ${cell(report.rating)}）` },
        { field: "industry", label: "主营品类", from: cell(matched.industry), to: matched.industry || industryGuess || "—" },
        { field: "country", label: "国家", from: cell(matched.country), to: cell(matched.country || args.country) },
      ],
      target: { label: "查看公司档案", href: `#/customers?view=company&sel=${matched.id}` },
      run: async () => {
        const u = await upsertCompany({
          id: matched.id, name: matched.name,
          industry: matched.industry || (industryGuess || null),
          country: matched.country || (args.country ?? null),
          backcheckData: backcheckJson,
        });
        return u.success ? okResult(`已更新公司档案 #${matched.id}（${matched.name}）`) : failResult(u.error);
      },
    }));
    actions.push(navAction("查看公司档案", `#/customers?view=company&sel=${matched.id}`));
  } else {
    // 库里没有 → 提议建档
    actions.push(registerAction({
      conversationId: ctx.conversationId, toolName: "company_backcheck",
      label: "加入客户库",
      confirm: `新建公司「${args.companyName}」并写入这份背调结论`,
      detail: "只建公司档案，不创建联系人",
      diff: [
        { field: "name", label: "公司名", from: "—（库内无此公司）", to: args.companyName },
        { field: "industry", label: "主营品类", from: "—", to: industryGuess || "—" },
        { field: "country", label: "国家", from: "—", to: cell(args.country) },
        { field: "backcheck", label: "背调结论", from: "—", to: `${cell(report.summary)}（评分 ${cell(report.rating)}）` },
      ],
      target: { label: "查看公司库", href: "#/customers?view=company" },
      run: async () => {
        const u = await upsertCompany({
          name: args.companyName.trim(),
          industry: industryGuess || null,
          country: args.country ?? null,
          backcheckData: backcheckJson,
        });
        return u.success ? okResult(`已加入客户库：${u.data.name} #${u.data.id}`) : failResult(u.error);
      },
    }));
  }

  const out = {
    ...report,
    companyInDb: matched ? { id: matched.id, name: matched.name } : null,
    actions,
  };
  audit(ctx, "company_backcheck", "read", args, out, "auto");
  return okOut(out);
}
