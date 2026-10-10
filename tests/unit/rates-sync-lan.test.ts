import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const h = vi.hoisted(() => ({
  source: "remote" as "lan" | "remote",
  saveDatabase: vi.fn(),
  deletes: [] as unknown[],
  inserts: [] as unknown[][],
}));
const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-rate-lan-test-"));
vi.mock("../../src/main/config", () => ({
  APP_ROOT: appRoot,
  loadConfig: () => ({ rates: { source: h.source } }),
}));
vi.mock("../../src/main/db", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ all: () => [], get: () => ({ n: 0 }) }) }),
    delete: (table: unknown) => ({ run: () => { h.deletes.push(table); } }),
    insert: (_table: unknown) => ({ values: (rows: unknown[]) => ({ run: () => { h.inserts.push(rows); } }) }),
  }),
  saveDatabase: h.saveDatabase,
}));
vi.mock("../../src/main/logger", () => ({ Log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../src/main/services/suggestion-bus", () => ({ nudge: vi.fn() }));

const { sync, remoteBase, status, LAN_BASE } = await import("../../src/main/services/rate-sync.service");
const originalFetch = globalThis.fetch;
const originalEnv = process.env.RATES_REMOTE_URL;
const reply = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

beforeEach(() => {
  delete process.env.RATES_REMOTE_URL;
  h.source = "remote"; // 老配置不能再把请求送去公网。
  h.saveDatabase.mockClear();
  h.deletes.length = 0;
  h.inserts.length = 0;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
  if (originalEnv === undefined) delete process.env.RATES_REMOTE_URL;
  else process.env.RATES_REMOTE_URL = originalEnv;
  if (!path.resolve(appRoot).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("test directory outside temp root");
  fs.rmSync(appRoot, { recursive: true, force: true });
});

describe("现行局域网运价接口", () => {
  it("旧配置选了公网也只访问局域网，正确映射统一记录金额", async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (url: string) => {
      requests.push(url);
      return reply(url.includes("/api/space")
        ? { ok: true, total: 1, rows: [{ content_key: "s1", route: "南美东", status: "当前有效" }] }
        : { ok: true, total: 1, rows: [{ content_key: "r1", pod: "Santos", price_usd: 6094, status: "当前生效" }] });
    }) as typeof fetch;
    const result = await sync();
    expect(result).toEqual({ success: true, data: { imported: 1 } });
    expect(requests).toHaveLength(2);
    expect(requests.every(url => url.startsWith(LAN_BASE + "/api/"))).toBe(true);
    expect(h.inserts.flat()).toEqual(expect.arrayContaining([expect.objectContaining({ podRaw: "Santos", oceanUsd: 6094 })]));
    expect(h.saveDatabase).toHaveBeenCalledOnce();
    expect(remoteBase()).toBe(LAN_BASE);
    expect(status().data).toEqual(expect.objectContaining({ remoteHost: new URL(LAN_BASE).host }));
  });

  it("局域网连接失败时不访问其他地址，也不覆盖本地镜像", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("LAN refused"); });
    globalThis.fetch = fetchSpy as typeof fetch;
    const result = await sync();
    expect(result.success).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(h.deletes).toHaveLength(0);
    expect(h.saveDatabase).not.toHaveBeenCalled();
  });

  it("接口缺少 rows 数组时拒绝覆盖本地镜像", async () => {
    globalThis.fetch = vi.fn(async () => reply({ ok: true, total: 1 })) as typeof fetch;
    const result = await sync();
    expect(result.success).toBe(false);
    expect(h.deletes).toHaveLength(0);
    expect(h.saveDatabase).not.toHaveBeenCalled();
  });

  it.runIf(process.env.RATES_LIVE_SMOKE === "1")("真实 8795 接口全量只读冒烟", async () => {
    globalThis.fetch = originalFetch;
    const result = await sync();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.imported).toBeGreaterThan(0);
    const rows = h.inserts.flat() as Array<{ oceanUsd?: number | null }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.slice(0, result.data.imported).every(row => row.oceanUsd != null)).toBe(true);
    expect(h.saveDatabase).toHaveBeenCalledOnce();
  }, 60000);
});
