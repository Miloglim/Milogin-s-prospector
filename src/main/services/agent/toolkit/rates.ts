// ── Agent Harness 工具层 · 运价域（从 tools.ts 拆分）────────────────
// 工具：quote_search / rate_update_plan / rate_update_enqueue。
import { z } from "zod";
import { resolveQueryPod, podRawExpansion, laneOfPod } from "../../rates-standard";
// 两张表的唯一出口（规范 docs/rates-answer-chain-spec.md §3）：清洗器算列，模型只许原样贴
import { cleanQuoteRow, pivotQuotes, cleanTableMarkdown, customerQuoteMarkdown, polExpansion, detectPolMentions, fmtValidity, customerRemarkEn, type CleanQuote } from "../../rates-clean";
import { listQuotes, listQuoteRaws, countQuotes, listSpaces, normalizeContainer, quoteOptions, probeBoardCached, remoteBase, regionLanes, type SpaceDto } from "../../rate-sync.service";
import { buildRateUpdatePlan, planView, enqueueRateUpdatePlan, pendingQueueGroups, looksLikeCountry } from "../../rate-update.service";
import { getBody, htmlToText } from "../../inbox.service";
import { invalidateCache } from "../tool-cache";
import { rememberWork, fingerprint } from "../working-memory";
import {
  gate, cachedRead, finishRead, okOut, failOut, audit, promptAction, navAction, beijingTime,
  optStr, optInt, optBool, toWords, toIds, type ToolCtx,
} from "./common";

export const quoteSearchSchema = z.object({
  q: optStr(60).describe("用户说的那个词原样传（航线名、区域简称、中英文港名都行，如「地东」「伊斯坦布尔」「SANTOS」）——"
    + "工具会同时比对航线/目的港/起运港，不需要你先判断它属于哪个字段"),
  lane: optStr(20).describe("航线（库里真实存在的航线名，如 加勒比/南美东/地东），不传则全航线"),
  carrier: optStr(10).describe("船司三字码，如 CMA/MSK/MSC；不看船司就省略或传空"),
  pod: optStr(60).describe("目的港关键词（中英文均可，模糊匹配）；不限则省略或传空"),
  pol: optStr(40).describe("起运港（蛇口/盐田/南沙/深圳/华南/宁波…中英文与常用 LOCODE 都认）。"
    + "台账把华南的货记在群名「华南基本港」下，工具会自动把蛇口等展开到同群口径并在命中时提示；不限则省略或传空"),
  container: optStr(10).describe("柜型，如 20GP/40GP/40HQ/NOR（写 40HC 也会自动归一）；不限则省略或传空"),
  includeExpired: optBool().describe("是否包含已过有效期记录，默认 false"),
  limit: optInt().describe("返回条数，默认 20，按价格升序"),
  forCustomer: optBool().describe("用户已明确点头「做成客户报价表 / 发给客户」时才传 true："
    + "返回 customerTable（英文十一列对外交付表，列与占位已锁死）。没同意不要传，也不要自己翻译或另拼对外表"),
});

// ── 定向运价更新推送（规范 docs/rate-update-push-spec.md §5）─────────────
export const rateUpdatePlanSchema = z.object({
  scope: optStr(12).describe("圈人范围：不传/board=跟进看板（已触达+已回复，默认）；contacts=联系人库全量（含没开发过的冷客户）。"
    + "用户说「所有巴西客户」「冷客户也一起发」这类才传 contacts"),
  country: optStr(40).describe("按国家/地区收窄（中英文都认，如 巴西/Brazil）。用户点名某个国家/地区时传它；不传=不限国家。"
    + "**国家名一律传这里，不要塞进 port**（port 只放目的港，如 Santos/BRSSZ）"),
  stages: z.preprocess((v: unknown) => toWords(v), z.array(z.string().max(16)).max(8).nullable().optional())
    .describe("一般不用传。只有用户明确说「只推报价中/试单那批」时才传（reaching/quoting/trial/cooperating/other）"),
  statuses: z.preprocess((v: unknown) => toWords(v), z.array(z.string().max(16)).max(5).nullable().optional())
    .describe("按联系人状态圈人（用户直接说「status=已触达/reached 的那批」时才传）：reached/replied/bounced/autoreply/cold"),
  port: optStr(60).describe("只推某个目的港（英文港名或 UN/LOCODE，如 Santos/BRSSZ）；省略=按每位客户自己的港口偏好分组"),
  contactIds: z.preprocess((v: unknown) => toIds(v), z.array(z.number().int().positive()).max(50).nullable().optional())
    .describe("只给指定的这几位客户推（来自 search_contacts 的 id）；省略=按范围圈定"),
  includeReplied: optBool().describe("已回复的客户是否一起推，默认真；传 false 只推还没回的"),
  quotesPerGroup: optInt().describe("每组邮件最多放几条报价，默认 12（最多 30）"),
  days: optInt().describe("港口偏好回溯多少天的来信，默认 90"),
});

export const rateUpdateEnqueueSchema = z.object({
  planId: z.string().min(1).max(40).describe("rate_update_plan 返回的方案 id（必填；方案 30 分钟内有效，过期就重新生成）"),
  groupKeys: z.preprocess((v: unknown) => toWords(v, 40), z.array(z.string().max(40)).max(40).nullable().optional())
    .describe("只入队其中几组时传它们的 key（照抄 rate_update_plan 返回的 groups[].key，如「SANTOS|EN」）；省略=方案里全部组"),
  overwrite: optBool().describe("发送队列里已有未发送批次时默认拒绝入队（入队会清空它们）。用户明确同意覆盖才传 true"),
});

export async function execQuoteSearch(ctx: ToolCtx, args: z.infer<typeof quoteSearchSchema>): Promise<string> {
  const cached = cachedRead(ctx, "quote_search", args);
  if (cached) return cached;
  // 模型可传 null（字段已声明 nullable），统一在此收敛成 undefined，保证 QuoteFilters 契约干净
  const trimmed = (v: string | null | undefined): string | undefined => {
    const t = (v ?? "").trim();
    return t || undefined;                    // 空串与 null 都按「不过滤」处理
  };
  const podQ = trimmed(args.pod);
  const qQ = trimmed(args.q);
  // 起运港语义群：用户说「蛇口」，台账把华南的货记在群名「华南基本港」下——展开成同群集合一起命中，
  // 并在命中时提示模型如实标注（不说成蛇口专属价）。认不出就是 null，按原词 LIKE 兜底。
  const polQ = trimmed(args.pol);
  const polSet = polQ ? polExpansion(polQ) : null;
  // 口语后缀去掉（「加勒比线」「南美东航线」→ 加勒比 / 南美东）
  const laneQ = trimmed(args.lane)?.replace(/航线$/, "").replace(/线$/, "").trim() || undefined;
  // 港口归一：用户任意写法→标准港名；并把航线级/区域级 podRaw 展开进过滤
  // （查 SANTOS 时 podRaw=「南美东」「WCSA」的行也要命中，否则漏掉航线级报价）
  const canon = podQ ? resolveQueryPod(podQ) : undefined;
  // L1 机械层：每个词各自跨字段 OR（航线/目的港/起运港），词之间 AND。
  // 「地东」是航线还是港名不由机械层猜、也不由模型猜——猜错字段就是漏查（规范 rates-query-fallback-spec §1）
  const termWords = [...new Set([qQ, laneQ, podQ].filter((x): x is string => !!x)
    .flatMap(w => [w, resolveQueryPod(w)].map(t => t.trim()).filter(Boolean)))];
  // 国别/区域词（巴西/拉美/墨西哥…）不是精准港：字面 LIKE 只能命中 podRaw 里恰带
  // 「巴西」括注的少数行，SANTOS/Santos 这类纯英文港行的巴西货全漏（用户实测）。
  // 区域词直接走航线级：regionLanes 扩展出的航线集合 inArray 精确命中，宁滥勿缺
  //（行上 pod 可见，南美东里的阿根廷乌拉圭行一并带出，属「相关运价」口径）。
  const regionLs = [...new Set([qQ, laneQ, podQ].filter((x): x is string => !!x)
    .flatMap(w => regionLanes(w)))];
  const isRegionQuery = regionLs.length > 0;
  // 两段查（docs/rates-answer-chain-spec.md §2）：
  //  L1 精准港＝字段里真出现这个词的行（具体港报价优先）；
  //  L2 航线级＝L1 为空才把该港所属航线/区域码（南美东、WCSA…）并进来，捞航线级报价。
  // 分两段的原因：一次 OR 混查会把区域价和具体港价搅在一起，比选时容易把区域价当本港价报给客户。
  const filtersBase = {
    carrier: trimmed(args.carrier)?.toUpperCase(),
    pod: isRegionQuery ? undefined : podQ,
    pol: polQ,
    polExtra: polSet?.values,
    terms: termWords.length ? termWords : undefined,
    // 脏柜型归一（40HC→40HQ 等），识别不了则原样大写透传
    container: normalizeContainer(trimmed(args.container) ?? null) ?? trimmed(args.container)?.toUpperCase() ?? undefined,
    includeExpired: args.includeExpired ?? undefined,
  };
  const laneWords = [...new Set([podQ, qQ].filter((x): x is string => !!x)
    .flatMap(w => podRawExpansion(resolveQueryPod(w))))];
  // limit 钳制 1..50：曾实测模型传 200 → 200 条 JSON 加表格一起进上下文，单轮 21 万 token
  const limitN = Math.min(Math.max(args.limit && args.limit > 0 ? args.limit : 20, 1), 50);
  // 航线理解在先（用户口径）：目的港归一后先判所属航线（laneOfPod），该航线当期数据整批取回，
  // 与 L1（精准港 LIKE + terms）按行键去重合并 —— terms 的 AND 会掐死航线级行，两者不能混在一条查询里。
  const laneHit = isRegionQuery ? (regionLs[0] ?? null) : (canon ? laneOfPod(canon) : null);
  const laneFilters = laneHit
    ? { carrier: filtersBase.carrier, container: filtersBase.container, includeExpired: filtersBase.includeExpired, lanes: [laneHit] }
    : null;
  const first = listQuotes({ ...filtersBase, limit: limitN });
  const laneR = laneFilters ? listQuotes({ ...laneFilters, limit: 200 }) : null;
  const dtoKey = (q: { podRaw?: string | null; carrier?: string | null; container?: string | null; oceanUsd?: number | null; validFrom?: string | null; validTo?: string | null; pol?: string | null; note?: string | null }) =>
    [q.podRaw, q.carrier, q.container, q.oceanUsd, q.validFrom, q.validTo, q.pol, q.note].join("|");
  const firstRows = first.success ? first.data : [];
  const laneFetched = ((laneR?.success ? laneR.data : []) as typeof firstRows)
    .filter(q => !firstRows.some(x => dtoKey(x) === dtoKey(q)));
  const dtoRows = [...firstRows, ...laneFetched];
  // 兜底 L2（区域词/非常规写法）：仅当 L1 与航线查询都空时走
  const useLane = isRegionQuery || (!dtoRows.length && laneWords.length > 0);
  const filters = useLane
    ? { ...filtersBase, pod: undefined, terms: undefined, lanes: isRegionQuery ? regionLs : undefined, podExtra: isRegionQuery ? undefined : laneWords }
    : filtersBase;
  const r = useLane ? listQuotes({ ...filters, limit: limitN }) : { success: true as const, data: dtoRows };
  if (!r.success) {
    audit(ctx, "quote_search", "read", args, undefined, "auto", r.error);
    return failOut("query_failed", `查询失败：${r.error}`);
  }
  // 分层：本港专属行（pod_raw 无中文）在前，航线级行在后
  const CJK_RE = /[\u4e00-\u9fa5]/;
  const dtoRowsAll = useLane ? r.data : dtoRows;
  const portRows = dtoRowsAll.filter(q => !CJK_RE.test(q.podRaw));
  const laneRows = dtoRowsAll.filter(q => CJK_RE.test(q.podRaw));
  // total 诚实口径：精准∪扩展 与 航线集合 两次计数相加减去重叠（同一条行落在两个查询里只算一次）
  let total = 0;
  if (useLane) total = countQuotes(filters);
  else if (laneFilters) {
    const overlap = countQuotes({ ...filtersBase, lanes: [laneHit!] });
    total = countQuotes(filtersBase) + countQuotes(laneFilters) - overlap;
  } else total = countQuotes(filtersBase);
  // 规则：查运价必带相关舱位——同一次调用里用同一批词并联查舱位镜像（本地查询，不多花模型调用）。
  // 附带查询不得打挂主查询：老库缺表/列变更等异常一律按「无近期舱位动态」处理
  let spaces: SpaceDto[] = [];
  try {
    const sp = listSpaces({ terms: termWords.length ? termWords : undefined, carrier: filters.carrier, limit: 8 });
    if (sp.success) spaces = sp.data;
  } catch { /* 宁可不带舱位，也不让查价失败 */ }
  const spaceTable = spaces.length
    ? [
      "| 舱位动态 | 船名航次 | ETD | 截关 | 航线 | 目的港 | 柜型/箱量 | 价格USD | 时间 | 来源群 |",
      "|---|---|---|---|---|---|---|---|---|---|",
      ...spaces.map(s => `| ${s.spaceType ?? "—"} | ${s.vessel ?? "—"} | ${s.etd ?? "—"} | ${s.cutoffRaw ?? "—"} `
        + `| ${s.lane ?? "—"} | ${s.podRaw ?? "—"} | ${[s.container, s.boxQty].filter(Boolean).join(" ") || "—"} `
        + `| ${s.priceUsd ?? "—"} | ${s.msgTime ?? "—"} | ${s.sourceGroup ?? "—"} |`),
    ].join("\n")
    : "";
  // 固定回答格式：结论与客户表格由工具预计算，模型只许复述——
  // 格式漂移（每次长得不一样）和双表格（正文重抄界面表格卡）都在这根治
  const fmtUsd = (n: number | null) => (n != null ? `$${n.toLocaleString("en-US")}` : "议价");
  // 两表分离（用户定案，规范 docs/rates-answer-chain-spec.md §3）：
  //  · userTable = 给操作者看的 12 列中文工作表（船司…备注·来源·发送人·入库时间，出处三列必备）
  //  · customerTable = 对外交付物，英文十一列（POL/POD 唯一全大写、缺项 "/"、TT 恒 "/"）
  // 两张表都出自 rates-clean 同一批清洗行（三列柜型价按港定位、港口拆分、内部备注判丢全在那边锁死），
  // 模型只许原样贴。与 total/quotes 同源：镜像未命中 → 两表一律为空（闭环规范 §5.1-A）。
  const queryWord = podQ || qQ || laneQ || "";
  const podCanon = (canon || resolveQueryPod(queryWord) || queryWord).toUpperCase() || null;
  let cleanRows: CleanQuote[] = [];
  try {
    const rawR = listQuoteRaws({ ...filters, limit: 200 }, Math.max(limitN * 4, 60));
    let rawRows = rawR.success ? [...rawR.data] : [];
    if (laneFilters && !useLane) {
      // 航线查询的行也进两张表（L1 的 terms AND 会掐掉它们，这里补回来）
      const laneRaw = listQuoteRaws({ ...laneFilters, limit: 200 }, 200);
      if (laneRaw.success) {
        const seen = new Set(rawRows.map(dtoKey));
        rawRows = [...rawRows, ...laneRaw.data.filter(x => !seen.has(dtoKey(x)))];
      }
    }
    cleanRows = pivotQuotes(rawRows.map(x => cleanQuoteRow(x, x.imageUrl)));
  } catch { /* 清洗行取不到就退回镜像展示行，不炸整次查询 */ }
  const laneLevelRows = cleanRows.filter(c => /[\u4e00-\u9fa5]/.test(c.pod));
  // 分层排序：本港专属行在前，航线级行在后（组内保持价升序）——「先航线、再分层理解」的呈现口径
  const orderedRows = [...cleanRows].sort((a, b) =>
    (CJK_RE.test(a.pod) ? 1 : 0) - (CJK_RE.test(b.pod) ? 1 : 0));
  const userTable = total > 0
    ? (orderedRows.length
      ? cleanTableMarkdown(orderedRows, 15)
      : (dtoRowsAll.length
        ? [
          "| 船司 | 起运港 | 目的港 | 柜型 | 价格(USD) | 有效期 |",
          "|---|---|---|---|---|---|",
          ...dtoRowsAll.slice(0, 15).map(q =>
            `| ${q.carrier ?? "—"} | ${q.pol ?? "—"} | ${q.podRaw} | ${q.container ?? "—"} | ${fmtUsd(q.oceanUsd)} | ${q.validFrom || q.validTo ? `${q.validFrom ?? "?"}~${q.validTo ?? "?"}` : "—"} |`),
        ].join("\n")
        : ""))
    : "";
  // 客户表：航线级行的 POD 展开成查询目标港（对外必须是唯一英文港名，不能出现「南美东」）；
  // 工作表保留原样 pod_raw，操作者要看得出这是航线级价
  const customerTable = total > 0 && args.forCustomer
    ? customerQuoteMarkdown(pivotQuotes(
        cleanRows.map(c => (podCanon && /[\u4e00-\u9fa5]/.test(c.pod) ? { ...c, pod: podCanon } : c)),
      ), 15)
    : "";
  const fmtRow = (q: { oceanUsd: number | null; carrier: string | null; container: string | null; pol: string | null; podRaw: string }) =>
    `${fmtUsd(q.oceanUsd)}（${q.carrier ?? "—"} · ${q.container ?? "综合"} · ${q.pol ?? "—"}→${q.podRaw}）`;
  let answer = "";
  if (portRows.length && laneRows.length) {
    const p = portRows[0]!;
    const l = laneRows[0]!;
    answer = `${podCanon ?? "该港"} 的本港专属价 ${portRows.length} 条（最低 ${fmtRow(p)}）；`
      + `「${l.podRaw}」航线级另有 ${laneRows.length} 条（最低 ${fmtRow(l)}，适用 ${podCanon} 作为基本港）。`;
  } else if (!portRows.length && laneRows.length) {
    const l = laneRows[0]!;
    answer = `${podCanon ?? "该港"} 暂无当期本港专属价；「${l.podRaw}」航线级 ${laneRows.length} 条`
      + `（最低 ${fmtRow(l)}，适用 ${podCanon} 作为基本港）。`;
  } else if (portRows.length) {
    const p = portRows[0]!;
    answer = `最低 ${fmtUsd(p.oceanUsd)}（${p.carrier ?? "—"} · ${p.container ?? "综合"} · ${p.pol ?? "—"}→${p.podRaw}），共 ${total} 条当前有效报价。`;
  }
  const wantCustomerTable = !!args.forCustomer || !!(ctx.userText && /给客户|发给客户|客户价格表|报价表|正式报价|整理成表/.test(ctx.userText));

  // 逐条件拼 notice：收敛信号 + 固定格式指令（弱模型对工具返回里的指令最服帖）
  const noticeLines: string[] = [];
  // 起运港兜底（弱模型实测会把「蛇口到santos」的蛇口弄丢 → pol 不传 → 全网到该港的价混进来）：
  // 用户原话里认得出起运港而调用没传 pol 时，不静默过滤（原话可能只是旁及提及，如"顺便看看蛇口"），
  // 改为在返回里下指令让模型带 pol 重查——判读交给拿着完整句子的模型，机制只负责不让约束丢掉。
  if (!polQ && ctx.userText) {
    const mentions = detectPolMentions(ctx.userText);
    const resultPols = [...new Set(dtoRowsAll.map(x => (x.pol || "").trim()).filter(Boolean))];
    if (mentions.length === 1) {
      const m = mentions[0]!;
      const group = new Set<string>(m.group);
      const foreign = resultPols.filter(p => !group.has(p));
      if (foreign.length > 0) {
        noticeLines.push(`用户原话明确提到起运港「${m.word}」，但本次调用没传 pol——上面结果混入了其他起运港（${foreign.join("、")}）的价。`
          + `立即带 pol="${m.word}"（q/pod 等其余条件照旧）重查一次，只按重查结果作答，不许把其他起运港的价混进答复；`
          + `以后用户提到起运港必须显式传 pol。`);
      }
    } else if (mentions.length > 1 && resultPols.length > 1) {
      noticeLines.push(`用户原话提到多个起运港（${mentions.map(m => m.word).join("、")}）而本次没传 pol，结果未按起运港过滤。`
        + `若用户意图是其中某一港或分港对比，带 pol 分开重查后再答。`);
    }
  }
  let candidates: { lanes: { v: string; c: number }[]; pods: { v: string; c: number }[] } | undefined;
  let mirror: { rows: number; latestSyncAt: string | null; remoteHost: string; reachable: boolean } | undefined;
  let concluded = false;                       // 是否已进入 L3 定论口径
  if (total === 0) {
    // 查不到 ≠ 没有：L2 把库存事实回给模型做语义重试，两轮不过才 L3 定论（规范 rates-query-fallback-spec §3/§4）
    const opts = quoteOptions();
    const attempt = ctx.counts?.get("quote_search") ?? 1;
    const words = termWords.map(w => w.toLowerCase());
    const hasSub = (s: string, w: string) => {
      for (let i = 0; i + 2 <= w.length; i++) if (s.includes(w.slice(i, i + 2))) return true;
      return false;
    };
    // 贴合度只机械排个序（谁和查询词有公共子串靠前）；语义等价关系交给人/模型判断，代码不养同义词表
    const score = (v: string) => {
      const s = v.toLowerCase();
      if (words.some(w => s.includes(w) || w.includes(s))) return 0;
      return words.some(w => hasSub(s, w)) ? 1 : 2;
    };
    const rank = <T extends { v: string; c: number }>(items: T[]): T[] =>
      [...items].sort((a, b) => score(a.v) - score(b.v) || b.c - a.c).slice(0, 12);
    candidates = { lanes: rank(opts.lanes), pods: rank(opts.pods) };
    const reachable = await probeBoardCached();
    let remoteHost = remoteBase();
    try { remoteHost = new URL(remoteBase()).host; } catch { /* 保底原样 */ }
    mirror = { rows: opts.rows, latestSyncAt: opts.latestSyncAt, remoteHost, reachable };
    const syncAt = opts.latestSyncAt ? beijingTime(opts.latestSyncAt) : "未知（本次运行还没同步过）";
    const stale = !opts.latestSyncAt || Date.now() - Date.parse(opts.latestSyncAt) > 24 * 3600_000;
    if (attempt <= 1) {
      noticeLines.push(
        "机械匹配第一轮没命中，这不是「库里没有」。candidates 是本地镜像里真实存在的航线与目的港（带条数，已按贴合度排序）："
        + "请判断用户说的词是否对应其中某一项（区域简称、中英文译名、同一航线的不同叫法都算）。"
        + "对得上就换成 candidates 里的原值再查一次（重试一次为限，别用同样的词重复调用）；对不上再等下一轮结论。",
      );
    } else {
      concluded = true;
      // 先分清「有行但都过期」与「真没有」：放宽有效期再数一次（不放宽就会把存量说成没有）
      let expiredOnly = 0;
      try {
        const loose = countQuotes({ ...filters, includeExpired: true });
        expiredOnly = Number.isFinite(loose) ? loose : 0;
      } catch { expiredOnly = 0; }
      if (expiredOnly > 0) {
        noticeLines.push(`台账里其实有 ${expiredOnly} 条符合这些条件的报价，但**都已过有效期**，所以当期无价可报——`
          + "这跟「库里没有这个港/航线」是两件事，别说错。请照实说「有历史报价但已过期」，"
          + "再问用户要不要联网查当前市场行情（用户同意前不要自行联网）。");
      } else {
        noticeLines.push(!reachable || stale
          ? `两轮都没命中。本地镜像共 ${opts.rows} 条、最近同步 ${syncAt}，局域网台账${reachable ? "可达" : "现在连不上"}`
            + "——很可能是镜像没跟上真源。请照实说「本地镜像里查不到这条」，不要说成「该航线没有报价」；"
            + "再给用户两条路：到「运价库」页点同步刷新镜像，或让你联网查当前市场行情。"
          : `两轮都没命中（放宽有效期后仍是 0 条），且镜像刚同步过（${syncAt}）、台账可达——可以确定台账里没有这个航线/港口。`
            + "请如实告诉用户库里没有，并问一句要不要你联网查当前市场行情；用户明确同意前不要自行联网。");
      }
    }
    // 两段都空才算「本地查不到」：L1 精准港 + L2 航线级（podExtra 展开）都为零才走到这里，
    // 口径仍按 rates-query-fallback-spec §3/§4 分「镜像没跟上」与「确实没有」两种说法
  } else {
    if (dtoRowsAll.length < total) noticeLines.push(`共命中 ${total} 条，本批返回 ${dtoRowsAll.length} 条，回答时必须注明。`);
    else noticeLines.push("命中数据已全部返回，无需再调用本工具，直接作答。");
    if (useLane) {
      noticeLines.push("本次命中的是**航线级/区域基本港**报价（具体港单独没有价）：userTable 里目的港显示为航线名，"
        + "答复时必须说明「以下是该航线基本港的报价，适用 X」，不要当成 X 港的专属价。");
    } else if (laneLevelRows.length) {
      noticeLines.push(`命中里有 ${laneLevelRows.length} 条是航线级报价（目的港列显示为航线名），答复时逐条区分清楚。`);
    }
    if (polSet?.expanded && polQ) {
      noticeLines.push(`起运港「${polQ}」的货在台账记在群名下（如「华南基本港」覆盖蛇口/盐田/南沙）——`
        + `命中行里 POL 列是群名的就是这类，答复时说明是同群适用价，别说成「${polQ}专属价」。`);
    }
    if (laneRows.length || laneHit) {
      noticeLines.push(`转述顺序：先一句「${podCanon ?? queryWord} 属于${laneHit ? `「${laneHit}」航线` : "相应航线"}」，`
        + `再分层报数——本港专属价在前、航线级适用价在后，两类不许混成一种。`);
    }
    if (!args.forCustomer && wantCustomerTable) {
      noticeLines.push("用户要的是**给客户看的报价表**：本工具必须带 forCustomer=true 重查一次，用返回的 customerTable（英文十一列、内部备注已判丢）。"
        + "绝对不许把 userTable 的中文备注（航管侧成本/批价/可减多少 这类内部话）改列后当客户表贴出去——那是事故级泄漏。");
    }
    noticeLines.push("只想给操作者看精简版时贴 priceDigest（6 列、备注已按对外口径判丢），仍不许自己另拼表或改数字。");
    noticeLines.push(
      "回答格式（固定，勿自由发挥，规范 docs/rates-answer-chain-spec.md §3）：① 第一句原样采用 answer（数字与船司不改）；"
      + "② 紧接着把 userTable **原样贴进正文**（Markdown 表格）——中间产物卡已静默，正文不贴用户就看不到表；"
      + "禁止改列名/列序/数值、禁止把表改写成散文或要点、禁止自己另拼第二张表；③ 有舱位动态再按 spaceTable 跟在表后。",
      "两张表分工不同，别拿错：userTable 是给操作者自己看的 12 列中文工作表"
        + "（船司·起运港·目的港·20GP·40HQ/HC·40NOR·目免·有效期·备注·来源·发送人·入库时间——后三列是信息出处，必须一起贴，不许删列）；"
        + "customerTable 是全英文对外交付物（列 CARRIER/POL/POD/20GP/40HQ-HC/40NOR/FT/ETD/VALIDITY/TT/REMARK，内部备注已判丢），"
        + "只有用户点头「做成客户报价表/发给客户」时才贴它，且只在本工具带 forCustomer 重新查一次后取，不要自己翻译列名。"
        + "两表都没中文混排问题，customerTable 里绝不允许出现中文。"
        + "用户没明说「导出文件」就不要调 export_artifact。",
      "末尾固定提醒：镜像价为参考价，以船司实时报价为准。",
    );
  }
  // 舱位与运价同行（规则）：有近期动态必须一起答，没有也如实说一句，两种都不许编
  noticeLines.push(spaces.length
    ? `相关舱位动态 ${spaces.length} 条（最近 21 天，见 spaceTable）：回答必须在运价之后再用一两句带上——`
      + "舱位类型、船名航次、ETD、截关、箱量一律照表里的原值说，不得编造或推算；"
      + "并补一句「舱位为群内动态，以订舱时确认为准」。用户要报价信时，把舱位一并写进去。"
    : "本次没有该航线/港口最近 21 天的舱位动态。如实说「舱位这边没有近期动态，需要时我再查」，"
      + "不要拿更早的记录或外部印象当现状。");
  // 明细只留决策要用的字段：出处/截图类信息已在 userTable 的 12 列里，重复给纯烧 token
  const slimQuotes = dtoRowsAll.slice(0, 20).map(q => ({
    podRaw: q.podRaw, lane: q.lane, carrier: q.carrier, container: q.container,
    oceanUsd: q.oceanUsd, pol: q.pol, validTo: q.validTo, note: q.note,
  }));
  // 精简视图（可直接贴的 6 行摘要）：备注走对外同一套判丢，内部黑话不进来
  let priceDigest = "";
  try {
    priceDigest = orderedRows.slice(0, 8).map(c => {
      const price = c.p40 ?? c.p20 ?? c.pNor;
      return `| ${c.carrier || "/"} | ${c.pols.join("/") || c.polText || "/"} | ${(c.pod || "/").toUpperCase()} | ${price != null ? `$${price.toLocaleString("en-US")}` : "议价"} | ${fmtValidity(c.validFrom, c.validTo)} | ${customerRemarkEn(c.note)} |`;
    }).join("\n");
    priceDigest = `| 船司 | 起运港 | 目的港 | 价格 | 有效期 | 备注 |
|---|---|---|---|---|---|
${priceDigest}`;
  } catch { priceDigest = ""; }
  const out = {
    total, count: dtoRowsAll.length, quotes: slimQuotes,
    ...(laneHit ? { laneHit } : {}),
    portCount: portRows.length, laneCount: laneRows.length,
    answer, userTable, priceDigest, customerTable,
    spaceCount: spaces.length,
    ...(spaces.length ? { spaceTable } : {}),
    notice: noticeLines.join("\n"),
    ...(candidates ? { candidates } : {}),
    ...(mirror ? { mirror } : {}),
    ...(total > 0 && dtoRowsAll.length >= total ? { complete: true } : {}),
    ...(total === 0 ? { empty: true } : {}),
    ...(total > 0 ? {
      say: `共 ${total} 条` + (args.q || args.lane || args.pod || args.carrier || args.container
        ? `（当前筛选条件下的命中数）` : `（镜像库全量）`)
        + `，其中返回明细 ${dtoRowsAll.length} 条${dtoRowsAll.length ? `，最低 ${dtoRowsAll[0]!.oceanUsd ?? "-"} USD` : ""}`
        + `；相关舱位动态 ${spaces.length} 条`,
    } : {}),
    ...(total > 0 ? {
      actions: [
        // 规范 §3：先给工作表，再问一句要不要做成客户报价表——点它等于同意，工具会带 forCustomer 重查一次
        ...(args.forCustomer ? [] : [promptAction("做成客户报价表",
          "把刚才那批运价做成对外发给客户的报价表：重新调用 quote_search 并带上 forCustomer=true（其余筛选条件照抄），"
          + "然后把返回的 customerTable 原样贴出——列已锁死（缺项是 /，TT 恒为 /），不要自己补值、翻译或改列名。")]),
        promptAction("按这批价写一封报价信", "根据刚才查到的运价，选最便宜的那条给客户写一封报价信，注明有效期和「以船司实时报价为准」的提醒；刚才那批相关舱位动态（船名航次/ETD/截关/舱位类型）也一并写进去，并注明舱位以订舱时确认为准"),
        navAction("在运价库筛选", "#/rates"),
      ],
    } : concluded ? {
      // 定论后的两条出口：刷新镜像（用户自己在运价页点，agent 不代点）/ 联网调研（点了才做）
      actions: [
        navAction("去运价页同步镜像", "#/rates"),
        promptAction("联网查市场行情",
          `本地镜像没查到「${termWords.join(" ") || "这个航线"}」的运价。请联网调研该航线当前的市场行情与船期，`
          + "回答时注明这是外部行情、不是公司台账报价。"),
      ],
    } : {}),
  };
  audit(ctx, "quote_search", "read", args, out, "auto");
  // 工作台：查到的真运价此前跨轮只剩"共 N 条"一行，起草时拿不到价 → 编占位（P2 根因）。
  // 这里把命中行按查询指纹落库，跨轮可复述、且供 generate_draft 程序化直取（Phase 2）。
  if (total > 0) {
    const qrows = (out.quotes ?? []) as unknown as Array<Record<string, unknown>>;
    const rows = qrows.slice(0, 20).map(q => ({
      carrier: q.carrier ?? null, container: q.container ?? null, pol: q.pol ?? null,
      pod: q.podRaw ?? null, price: q.oceanUsd ?? null,
      validFrom: q.validFrom ?? null, validTo: q.validTo ?? null, note: q.note ?? null,
    }));
    const route = [args.pod || args.q || args.lane, args.container].filter(Boolean).join(" ");
    const top = rows.slice(0, 3).map(r =>
      `${r.carrier ?? "—"} ${r.pol ?? "—"}→${r.pod ?? "—"} ${r.container ?? ""} $${r.price ?? "议价"}`).join("；");
    rememberWork(ctx.conversationId, {
      kind: "rates",
      refId: fingerprint({ q: args.q, pod: args.pod, lane: args.lane, container: args.container, carrier: args.carrier }),
      toolName: "quote_search",
      contextLine: `运价 ${route || "全航线"}：命中 ${total} 条，最低 $${rows[0]?.price ?? "—"}${top ? `；${top}` : ""}`,
      payload: {
        q: args.q ?? null, pod: args.pod ?? null, lane: args.lane ?? null,
        container: args.container ?? null, carrier: args.carrier ?? null,
        total, cheapest: rows[0]?.price ?? null, rows,
        mirrorSyncedAt: (out.mirror as { latestSyncAt?: string } | undefined)?.latestSyncAt ?? null,
      },
    });
  }
  // 空结果不进读缓存：同词再查也要真跑一遍，才走得到 L2→L3 的分层结论
  const payload = okOut(out);
  return total === 0 ? payload : finishRead(ctx, "quote_search", args, payload);
}

export async function execRateUpdatePlan(ctx: ToolCtx, args: z.infer<typeof rateUpdatePlanSchema>): Promise<string> {
  const cached = cachedRead(ctx, "rate_update_plan", args);
  if (cached) return cached;
  // 容错：模型常把国家名塞进 port（用户说「巴西的」→ port=巴西）。认得是国家就纠回 country，
  // 别让一次参数误用变成「查无此人」，更别让模型因此去自由发挥编原因
  let country = args.country ?? undefined;
  let port = args.port ?? undefined;
  let corrected = "";
  if (port && looksLikeCountry(port)) {
    corrected = `把「${port}」按国家处理（port 只放目的港）`;
    country = country ?? looksLikeCountry(port) ?? undefined;
    port = undefined;
  }
  const r = buildRateUpdatePlan({
    scope: args.scope === "contacts" ? "contacts" : "board",
    country,
    stages: args.stages?.map(s => s.toLowerCase()),
    statuses: args.statuses?.map(s => (["cold", "未触达", "none"].includes(s.toLowerCase()) ? "" : s.toLowerCase())),
    port,
    contactIds: args.contactIds?.length ? args.contactIds : undefined,
    includeReplied: args.includeReplied ?? undefined,
    quotesPerGroup: args.quotesPerGroup ?? undefined,
    days: args.days ?? undefined,
  });
  if (!r.success) {
    audit(ctx, "rate_update_plan", "read", args, undefined, "auto", r.error);
    // 失败口径钉死：这是数据范围问题，不是权限问题（实测模型会把没圈到人解释成「账号未启用该能力，请找管理员」）
    return failOut("no_plan", r.error + "。", {
      notice: "如实把这句话说给用户：范围里没圈到符合条件的客户。"
        + "严禁把它说成权限不足、账号未启用、需要联系管理员或功能没开——不存在这种东西。"
        + "换范围（scope=contacts）或换筛选条件再试一次即可。",
    });
  }
  const plan = r.data;
  const view = planView(plan);
  const biggest = [...plan.groups].sort((a, b) => b.customers.length - a.customers.length)[0];
  const laneLevelGroups = plan.groups.filter(g => g.laneLevel).map(g => g.label);
  audit(ctx, "rate_update_plan", "read", args, { planId: plan.id, groups: plan.totals.groups, covered: plan.totals.covered }, "auto");
  // 空方案：如实给原因 + 建议换的范围（一键续问），不要让它变成模型自由发挥的空间
  if (plan.emptyReason) {
    return okOut({
      ...view, empty: true,
      notice: `一个组都没成：${plan.emptyReason}。原话告诉用户这个原因，并问一句要不要改用「联系人库」范围重试`
        + (plan.suggestScope ? `（scope="${plan.suggestScope}"）` : "")
        + "。这跟权限、账号、功能开关完全无关，一个字都不许往那方面提；也不要转去逐家 search_contacts 自己拼名单。",
      actions: plan.suggestScope
        ? [promptAction(plan.suggestScope === "contacts" ? "改用联系人库范围重试" : "改回跟进看板范围重试",
          `给跟进客户更新运价：改用 scope="${plan.suggestScope}" 重新出方案${country ? `，country=${country}` : ""}`)]
        : [],
    });
  }
  const out = finishRead(ctx, "rate_update_plan", args, okOut({
    ...view,
    ...(corrected ? { corrected } : {}),
    // 邮件正文的纯文本形态（service 生成，不是模型写的）：用户问「信长什么样」时原样贴出
    preview: biggest
      ? {
        groupKey: biggest.key, subject: biggest.subject,
        text: htmlToText(biggest.bodyHtml).replace(/\n{3,}/g, "\n\n").trim(),
      }
      : null,
    laneLevelGroups,
    queueOccupied: pendingQueueGroups(),
    notice: "① 方案表已在界面渲染成表格卡，正文不要再手抄一遍表。"
      + "② 事实白名单：你只能说 totals、groups[] 数字、每组 facts（真实表行）与 preview 里出现过的内容——"
      + "船期延迟、中转、附加费、免箱期这类细节只要没在这些字段里，就不许提、不许凭印象补（这是本功能最高优先级的禁令）。"
      + (laneLevelGroups.length
        ? `③ ${laneLevelGroups.join("、")} 组命中的是航线级/区域基本港价（不是该港专属价），转述时必须说清这点，不能说成「X 港的本港报价」。`
        : "③ 本次各组都是该目的港的本港报价。")
      + "。④ uncovered 的人如实交代原因（no_port=偏好与来信都没推出港，且国家方向当期也没价；no_live_rate=台账当期无有效价，"
      + "按查价口径说明，不等于这条线没有报价；over_cap=本轮组数上限没排上）。"
      + "⑤ 队列若已有未发送批次（queueOccupied>0），提前告诉用户入队会清空它们，由他决定。"
      + "⑥ 然后问一句要不要入队；用户点头才调 rate_update_enqueue（会弹确认框）。你永远不能自己开始发送——"
      + "真正发出去那一下是用户自己在发送中心点的，这句要提前讲清。",
    nextStep: `用户认可后调 rate_update_enqueue，planId="${plan.id}"（只发其中几组就带 groupKeys，照抄 groups[].key）。`,
  }));
  return out;
}

export async function execRateUpdateEnqueue(ctx: ToolCtx, args: z.infer<typeof rateUpdateEnqueueSchema>): Promise<string> {
  const gateNote = gate(ctx, "rate_update_enqueue");
  if (gateNote) return gateNote;
  const r = await enqueueRateUpdatePlan(
    args.planId.trim(), args.groupKeys?.length ? args.groupKeys : undefined, args.overwrite ?? false,
  );
  if (!r.success) {
    audit(ctx, "rate_update_enqueue", "write", args, undefined, "approved", r.error);
    const expired = /过期|不存在/.test(r.error);
    return failOut(expired ? "plan_expired" : "enqueue_failed", r.error
      + (expired ? "（重新调一次 rate_update_plan 生成新方案再入队）" : ""));
  }
  if (r.data.occupied) {
    return failOut("queue_occupied",
      `发送队列里还压着 ${r.data.pendingGroups} 组未发送的邮件，直接入队会把它们清掉，所以先停下。`
      + "请把这件事告诉用户：可以先到发送中心把这批发掉或清掉，或者明确同意覆盖后你再带 overwrite=true 调一次。"
      + "不要自己替他决定覆盖。");
  }
  const e = r.data.enqueue;
  audit(ctx, "rate_update_enqueue", "write", args, { batchId: e.batchId, groups: e.groups, queuedCount: e.queuedCount }, "approved");
  invalidateCache("rate_update_plan");   // 方案已消费：下一次问「还有谁能推」必须重新算，不能吃缓存
  return okOut({
    say: `已把 ${e.groups} 组运价更新邮件（${e.queuedCount} 封，目的港 ${e.pods.join("、") || "—"}）加入发送队列，`
      + `批次 ${e.batchId.slice(0, 8)}${e.dropped ? `，另有 ${e.dropped} 组因当日发信限额被裁掉` : ""}。`,
    notice: "队列已建立但尚未启动：必须提醒用户到「发送中心」核对后手动点开始发送，程序不会自动发。"
      + "被限额裁掉的组说明今天发不动了，如实讲。",
    actions: [navAction("去发送中心", "#/queue")],
  });
}
