import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ query: vi.fn(), auth: vi.fn(), epoch: 1 }));
vi.mock("../../src/main/adapters/navigator-auth.adapter", () => ({
  queryNavigatorRates: api.query, requireNavigatorAuthorization: api.auth,
  navigatorAuthorizationEpoch: () => api.epoch,
}));
vi.mock("../../src/main/db", () => ({ getDb: () => { throw new Error("local mirror forbidden"); } }));
vi.mock("../../src/main/config", () => ({ loadConfig: () => ({ rates: {} }), APP_ROOT: "" }));
import { listQuotes, listQuoteRaws, countQuotes } from "../../src/main/adapters/navigator-quotes.adapter";
describe("authenticated Navigator quote adapter", () => {
  it("keeps web matching and ordering without silently excluding expired quotes", async () => {
    api.query.mockResolvedValue({ok:true,data:{total:0,rows:[]}});
    await listQuotes({match:"web",pod:"Santos",route:"Brazil",ctype:"40HQ/HC"},"web-query");
    expect(api.query.mock.calls[0]?.[0]).toMatchObject({match:"web",pod:"Santos",route:"Brazil",ctype:"40HQ/HC",sort:"synced_at",direction:"desc"});
    expect(api.query.mock.calls[0]?.[0]).not.toHaveProperty("valid_since");
  });
  beforeEach(() => { api.epoch = 1; api.query.mockReset(); api.auth.mockReset(); api.auth.mockResolvedValue({ ok: true, data: { authenticated: true } }); });
  it("keeps provenance/raw price evidence without touching mirror", async () => {
    api.query.mockResolvedValue({ ok: true, data: { total: 1, rows: [{ content_key: "r1", pod_raw: "SANTOS", carrier: "MSK", price_usd: "1200", message_text: "SANTOS 1200/1400", synced_at: "2026-09-01T08:00:00Z", source_group: "fixture", sender: "fixture", container_type: "20GP" }] } });
    const dto = await listQuotes({ pod: "SANTOS" }, "query-one");
    expect(dto.success && dto.data[0]?.oceanUsd).toBe(1200);
    const raw = await listQuoteRaws({ pod: "SANTOS" }, 20, "query-one");
    expect(raw.success && raw.data[0]?.messageText).toBe("SANTOS 1200/1400");
    expect(raw.success && raw.data[0]?.sourceGroup).toBe("fixture");
    expect(raw.success && raw.data[0]?.syncedAt).toBe("2026-09-01T08:00:00Z");
    expect(api.query.mock.calls.every(c => c[1] === "query-one")).toBe(true);
  });
  it("never reads records when authorization fails", async () => {
    api.auth.mockResolvedValue({ ok: false, error: "请登录" });
    expect(await listQuotes({ pod: "SANTOS" })).toEqual({ success: false, error: "请登录" });
    expect(api.query).not.toHaveBeenCalled();
  });
  it("discards an in-flight response after identity changes", async () => {
    api.query.mockImplementation(async () => { api.epoch++; return { ok: true, data: { rows: [{ pod_raw: "SANTOS" }], total: 1 } }; });
    expect((await listQuotes({ pod: "SANTOS" })).success).toBe(false);
  });
  it("uses remote exact totals and the action id for count calls", async () => {
    api.query.mockResolvedValue({ ok: true, data: { rows: [], total: 73 } });
    expect(await countQuotes({ pod: "SANTOS" }, "query-count")).toBe(73);
    expect(api.query.mock.calls[0]?.[1]).toBe("query-count");
  });
  it("paginates with one query id and globally sorted server queries", async () => {
    api.query.mockImplementation(async (filters: Record<string, unknown>) => ({ ok: true, data: {
      total: 600, rows: Array.from({ length: Number(filters.limit) }, (_, i) => ({ pod_raw: "SANTOS", content_key: `row-${Number(filters.offset) + i}`, price_usd: Number(filters.offset) + i + 1 })),
    } }));
    const result = await listQuotes({ pod: "SANTOS", limit: 600 }, "page-action");
    expect(result.success && result.data).toHaveLength(600);
    expect(api.query.mock.calls.map(c => [c[0].offset, c[0].limit, c[1]])).toEqual([[0, 500, "page-action"], [500, 100, "page-action"]]);
    expect(api.query.mock.calls.every(c => c[0].sort === "price" && c[0].direction === "asc" && /^\d{4}-\d{2}-\d{2}$/.test(c[0].valid_since))).toBe(true);
  });
  it("rejects incomplete remote rows rather than presenting false totals", async () => {
    api.query.mockResolvedValue({ ok: true, data: { rows: [{ carrier: "MSK", price_usd: 1200 }], total: 1 } });
    expect((await listQuotes({ pod: "SANTOS" })).success).toBe(false);
  });
  it("does not turn a remote failure into a zero count", async () => {
    api.query.mockResolvedValue({ ok: false, error: "会话已过期" });
    await expect(countQuotes({ pod: "SANTOS" })).rejects.toThrow("会话已过期");
  });

});
