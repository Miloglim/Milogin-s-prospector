// 实时台账查询适配：只读取已授权 API；不读取或更新历史本地镜像。
import { okResult, failResult, type Result } from "../errors";
import type { mapRemoteRow, mapRemoteSpace, QuoteDto, QuoteFilters, SpaceDto, SpaceFilters } from "./rate-sync.service";
import type { QuoteRowRaw } from "./rates-clean";
const BEIJING_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 86_400_000;
const DEFAULT_SPACE_DAYS = 21;
const PAGE_SIZE = 500;
const MAX_ROWS = 5000;
type RemoteRow = Record<string, unknown>;
type RawQuote = QuoteRowRaw & { imageUrl: string | null };

export interface NavigatorQueryPorts {
  authorize(): Promise<{ ok: boolean; error?: string }>;
  query(filters: Record<string, unknown>, queryId: string, kind: "rates" | "space"):
    Promise<{ ok: boolean; data?: { rows: RemoteRow[]; total: number }; error?: string }>;
  epoch(): number;
  queryId(): string;
  now(): number;
  mapRate: typeof mapRemoteRow;
  mapSpace: typeof mapRemoteSpace;
}

/** 服务只编排注入端口与纯映射，网络、账号与随机标识由 adapter 提供。 */
export function createNavigatorQueries(ports: NavigatorQueryPorts) {

  async function queryRows(filters: QuoteFilters | SpaceFilters, limit: number, queryId: string, kind: "rates" | "space" = "rates"):
    Promise<Result<{ rows: RemoteRow[]; total: number }>> {
    const auth = await ports.authorize();
    if (!auth.ok) return failResult(auth.error || "请先登录运价台账");
    const epoch = ports.epoch();
    const now = ports.now() + BEIJING_OFFSET_MS;
    const webMatch = (filters as QuoteFilters).match === "web";
    const remoteFilters = { ...filters,
      ...(kind === "rates" ? { sort: webMatch ? "synced_at" : "price", direction: webMatch ? "desc" : "asc" } : {}),
      ...(kind === "rates" && !webMatch && !(filters as QuoteFilters).includeExpired ? { valid_since: new Date(now).toISOString().slice(0, 10) } : {}),
      ...(kind === "space" ? { time_from: new Date(now - ((filters as SpaceFilters).days ?? DEFAULT_SPACE_DAYS) * DAY_MS).toISOString().slice(0, 10) } : {}),
    };
    const rows: RemoteRow[] = [];
    let total = 0;
    const cap = Math.min(Math.max(limit, 1), MAX_ROWS);
    do {
      const page = await ports.query({ ...remoteFilters, limit: Math.min(PAGE_SIZE, cap - rows.length), offset: rows.length }, queryId, kind);
      if (epoch !== ports.epoch()) return failResult("账号状态已变化，请重新查询");
      if (!page.ok || !page.data) return failResult(page.error || "台账查询失败");
      total = page.data.total;
      rows.push(...page.data.rows);
      if (!page.data.rows.length) break;
    } while (rows.length < Math.min(total, cap));
    return okResult({ rows: rows.slice(0, cap), total });
  }

  async function listQuotes(f: QuoteFilters, queryId = ports.queryId()): Promise<Result<QuoteDto[]>> {
    const r = await queryRows(f, f.limit ?? 20, queryId);
    if (!r.success) return r;
    const rows = r.data.rows.map((row, i) => {
      const mapped = ports.mapRate(row, `live-${i}`);
      if (!mapped) return null;
      // 入库时间只能采信源端；不能把本次查询时间冒充源记录的入库时间。
      return { ...mapped, syncedAt: typeof row.synced_at === "string" ? row.synced_at : null };
    }).filter((row): row is NonNullable<typeof row> => !!row);
    if (rows.length !== r.data.rows.length) return failResult("台账返回了缺少目的港的报价行，已停止展示，请检查接口契约");
    return okResult(rows.map(row => ({
      podRaw: row.podRaw, lane: row.lane ?? null, carrier: row.carrier ?? null, container: row.container ?? null,
      oceanUsd: row.oceanUsd ?? null, validFrom: row.validFrom ?? null, validTo: row.validTo ?? null,
      pol: row.pol ?? null, note: row.note ?? null, sourceGroup: row.sourceGroup ?? null, msgTime: row.msgTime ?? null,
      validityRaw: row.validityRaw ?? null, freeDays: row.freeDays ?? null, shortfallFee: row.shortfallFee ?? null,
      sender: row.sender ?? null, imageUrl: row.imageName ?? null, etd: row.etd ?? null,
    })));
  }
  async function listQuoteRaws(f: QuoteFilters, maxRows = 200, queryId = ports.queryId()): Promise<Result<RawQuote[]>> {
    const r = await queryRows(f, maxRows, queryId);
    if (!r.success) return r;
    const rows = r.data.rows.map((row, i) => {
      const mapped = ports.mapRate(row, `live-${i}`);
      if (!mapped) return null;
      // 入库时间只能采信源端；不能把本次查询时间冒充源记录的入库时间。
      return { ...mapped, syncedAt: typeof row.synced_at === "string" ? row.synced_at : null };
    }).filter((row): row is NonNullable<typeof row> => !!row);
    if (rows.length !== r.data.rows.length) return failResult("台账返回了缺少目的港的报价行，已停止展示，请检查接口契约");
    return okResult(rows.map(row => ({
      carrier: row.carrier ?? null, pol: row.pol ?? null, podRaw: row.podRaw, lane: row.lane ?? null,
      container: row.container ?? null, containerRaw: row.containerRaw ?? null, oceanUsd: row.oceanUsd ?? null,
      freeDays: row.freeDays ?? null, etd: row.etd ?? null, validityRaw: row.validityRaw ?? null,
      validFrom: row.validFrom ?? null, validTo: row.validTo ?? null, note: row.note ?? null,
      sourceGroup: row.sourceGroup ?? null, sender: row.sender ?? null, msgTime: row.msgTime ?? null,
      syncedAt: row.syncedAt ?? null, status: row.status ?? null, messageText: row.messageText ?? null,
      // AI 输出只提供原文溯源；截图由主进程授权读取，不向模型提供裸 HTTP 地址。
      imageUrl: null,
    })));
  }
  async function countQuotes(f: QuoteFilters, queryId = ports.queryId()): Promise<number> {
    const r = await queryRows(f, 1, queryId);
    if (!r.success) throw new Error(r.error);
    return r.data.total;
  }
  async function listSpaces(f: SpaceFilters, queryId = ports.queryId()): Promise<Result<SpaceDto[]>> {
    const r = await queryRows(f, f.limit ?? 8, queryId, "space");
    if (!r.success) return r;
    const rows = r.data.rows.map((row, i) => ports.mapSpace(row, `live-${i}`)).filter((row): row is NonNullable<typeof row> => !!row);
    return okResult(rows.map(row => ({
      podRaw: row.podRaw ?? null, lane: row.lane ?? null, carrier: row.carrier ?? null, pol: row.pol ?? null,
      container: row.container ?? null, boxQty: row.boxQty ?? null, spaceType: row.spaceType ?? null,
      vessel: row.vessel ?? null, etd: row.etd ?? null, cutoffRaw: row.cutoffRaw ?? null,
      priceUsd: row.priceUsd ?? null, note: row.note ?? null, sender: row.sender ?? null,
      sourceGroup: row.sourceGroup ?? null, msgTime: row.msgTime ?? null, imageUrl: null,
    })));
  }

  return { listQuotes, listQuoteRaws, countQuotes, listSpaces };
}

