import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import initSqlJs from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as schema from "../../src/main/db/schema";
import { BASE_SCHEMA_SQL } from "../../src/main/db/schema-sql";
const h = vi.hoisted(() => ({ db: null as any }));
vi.mock("../../src/main/db", () => ({ getDb: () => h.db, saveDatabase: () => {} }));
vi.mock("../../src/main/logger", () => ({ Log: { debug: vi.fn(), error: vi.fn() } }));
vi.mock("../../src/main/services/suggestion-bus", () => ({ nudge: vi.fn() }));
vi.mock("../../src/main/config", () => ({ loadConfig: () => ({ crm: {} }) }));
const crm = await import("../../src/main/services/crm.service");
let SQL: Awaited<ReturnType<typeof initSqlJs>>;
const old = "2026-01-01T00:00:00.000Z";
beforeAll(async () => { SQL = await initSqlJs(); });
beforeEach(() => {
  const raw = new SQL.Database(); raw.run(BASE_SCHEMA_SQL); h.db = drizzle(raw, { schema });
  h.db.insert(schema.contacts).values({ id: 1, email: "test@example.com", status: "reached", tags: '["reaching"]', extra: JSON.stringify({ stageChangedAt: old }) }).run();
});
it("阶段变更可见，列表和详情的最近跟进/逾期不被清零", async () => {
  h.db.insert(schema.interactions).values({ contactId: 1, type: "note", direction: "internal", bodyPreview: "follow", createdAt: old }).run();
  expect((await crm.setStage(1, "quoting")).success).toBe(true);
  const pipe = crm.listPipeline(); const detail = crm.getDetail(1);
  if (!pipe.success || !detail.success) throw new Error("query failed");
  const c = pipe.data.flatMap(s => s.contacts)[0];
  expect(c.lastFollowupAt).toBe(old); expect(c.overdue).toBe(true);
  expect(detail.data.contact?.lastFollowupAt).toBe(old); expect(detail.data.contact?.overdue).toBe(true);
  expect(detail.data.timeline.find(e => e.type === "stage")?.bodyPreview).toBe("触达中 → 报价中");
  await crm.setStage(1, "quoting");
  expect(h.db.select().from(schema.interactions).all().filter((r: any) => r.type === "stage")).toHaveLength(1);
});
it("只有阶段兜底的老客户切阶段后沉默时长不变", async () => {
  const before = crm.listPipeline(); await crm.setStage(1, "trial"); const after = crm.listPipeline();
  if (!before.success || !after.success) throw new Error("query failed");
  expect(after.data.flatMap(s => s.contacts)[0].staleDays).toBe(before.data.flatMap(s => s.contacts)[0].staleDays);
});
