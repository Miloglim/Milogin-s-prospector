import { readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { createCrmService } from "../../server/services/crm";
import { PostgresCrmRepository } from "../../server/adapters/postgres/repository";
import { readTestDatabaseConfig } from "../../server/adapters/postgres/config";
import type { Result, Contact } from "../../server/core/crm";

const TEST_TIMEOUT_MS = 20000;
const MISSING_ID = 2147483647;
const EXCESSIVE_LIMIT = 1000;
const HOSTILE_NAME = "A'); DROP TABLE contacts; --";
const logs: string[] = [];
const logger = { write: (_level: string, _context: string, message: string) => logs.push(message) };
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
let pool: Pool;
let repo: PostgresCrmRepository;
let service: ReturnType<typeof createCrmService>;
let contact: Contact;
const testPrefix = `integration-${Date.now()}`;

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === "1")("isolated real PostgreSQL CRM foundation", () => {
  beforeAll(async () => {
    execFileSync(process.execPath, ["scripts/crm-postgres.mjs", "start"], { timeout: TEST_TIMEOUT_MS, windowsHide: true, stdio: "pipe" });
    const config = readTestDatabaseConfig();
    pool = new Pool(config);
    repo = new PostgresCrmRepository(pool, logger);
    service = createCrmService(repo);
    unwrap(await repo.migrate());
  }, TEST_TIMEOUT_MS);
  afterAll(async () => { await pool?.end(); });

  it("creates companies/contacts and preserves UTF-8 and JSON values", async () => {
    const company = unwrap(await service.createCompany({ name: "测试物流", domain: `${testPrefix}.invalid` }));
    contact = unwrap(await service.createContact({
      email: ` ${testPrefix.toUpperCase()}@EXAMPLE.INVALID `, companyId: company.id,
      firstName: HOSTILE_NAME, lastName: "测试", extra: { crmReminder: null, nested: { text: "中文" } },
    }));
    expect(contact.email).toBe(`${testPrefix}@example.invalid`);
    expect(unwrap(await service.getContact(contact.id)).extra).toEqual(contact.extra);
    expect(contact.firstName).toBe(HOSTILE_NAME);
    expect(new Date(contact.createdAt).toISOString()).toBe(contact.createdAt);
  });

  it("rejects duplicate emails and missing-company foreign keys without inserting", async () => {
    const duplicate = await service.createContact({ email: contact.email.toUpperCase() });
    expect(duplicate).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const missing = await service.createContact({ email: `missing-${testPrefix}@example.invalid`, companyId: MISSING_ID });
    expect(missing).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(unwrap(await service.listContacts({ search: `missing-${testPrefix}` })).total).toBe(0);
  });

  it("stores hostile text as data and treats search wildcards literally", async () => {
    const found = unwrap(await service.listContacts({ search: HOSTILE_NAME }));
    expect(found.items.some(item => item.id === contact.id)).toBe(true);
    await service.createContact({ email: `percent-${testPrefix}@example.invalid`, firstName: "100%_literal" });
    const literal = unwrap(await service.listContacts({ search: "%_" }));
    expect(literal.items.every(item => item.firstName?.includes("%_"))).toBe(true);
  });

  it("records followups and atomically records CRM stage transitions", async () => {
    const note = unwrap(await service.addFollowup(contact.id, "客户要求明天报价"));
    expect(note.type).toBe("followup");
    const stage = unwrap(await service.changeStage(contact.id, "quoting"));
    expect(stage.tags).toEqual(["quoting"]);
    expect(stage.stage).toBe("cold"); // send stage is a different fact
    const activities = unwrap(await service.listInteractions(contact.id));
    expect(activities.some(a => a.type === "stage" && a.metadata.to === "quoting")).toBe(true);
    expect(activities.some(a => a.id === note.id)).toBe(true);
  });

  it("keeps the old stage when activity insertion fails", async () => {
    // Explicit transaction failure injection in the isolated test DB only.
    const rejectStage = `reject_${Date.now()}`;
    await pool.query(`ALTER TABLE interactions ADD CONSTRAINT ${rejectStage} CHECK (type <> 'stage') NOT VALID`);
    try {
      expect((await service.changeStage(contact.id, "trial")).ok).toBe(false);
      expect(unwrap(await service.getContact(contact.id)).tags).toEqual(["quoting"]);
    } finally {
      await pool.query(`ALTER TABLE interactions DROP CONSTRAINT ${rejectStage}`);
    }
  });

  it("is visible to another connection and concurrent stage changes have valid history", async () => {
    const second = new Pool(readTestDatabaseConfig());
    try {
      const other = createCrmService(new PostgresCrmRepository(second, logger));
      const outcomes = await Promise.all([service.changeStage(contact.id, "trial"), other.changeStage(contact.id, "cooperating")]);
      expect(outcomes.every(r => r.ok)).toBe(true);
      const history = unwrap(await other.listInteractions(contact.id)).filter(a => a.type === "stage");
      const final = unwrap(await other.getContact(contact.id));
      expect(history[0]?.metadata.to).toBe(final.tags[0]);
      expect(history[0]?.metadata.from).toEqual([history[1]?.metadata.to]);
    } finally { await second.end(); }
  });

  it("rejects invalid IDs, stages, pagination and non-JSON input before writes", async () => {
    expect(await service.changeStage(contact.id, "invented")).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await service.getContact(-1)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await service.listContacts({ limit: EXCESSIVE_LIMIT })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(await service.createContact({ email: `cycle-${testPrefix}@example.invalid`, extra: cycle as never })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await service.addFollowup(MISSING_ID, "missing")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("reapplies migrations without destroying persisted data or exposing passwords", async () => {
    unwrap(await repo.migrate());
    expect(unwrap(await service.getContact(contact.id)).email).toBe(contact.email);
    const config = JSON.parse(readFileSync(path.resolve(".work/pg-crm/config.json"), "utf8"));
    expect(logs.join("\n")).not.toContain(config.password);
    expect((await pool.query("SELECT count(*)::int AS count FROM crm_schema_migrations WHERE version='001-crm-foundation'")).rows[0].count).toBe(1);
  });

  it("refuses migration checksum drift instead of overwriting the existing schema", async () => {
    const original = (await pool.query("SELECT version,checksum FROM crm_schema_migrations WHERE version='001-crm-foundation'")).rows[0];
    await pool.query("UPDATE crm_schema_migrations SET checksum=$1 WHERE version=$2", ["synthetic-invalid-checksum",original.version]);
    try {
      expect(await repo.migrate()).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      expect(unwrap(await service.getContact(contact.id)).id).toBe(contact.id);
    } finally {
      await pool.query("UPDATE crm_schema_migrations SET checksum=$1 WHERE version=$2", [original.checksum,original.version]);
    }
  });

  it("refuses arbitrary production database configurations before connecting", async () => {
    const wrong = new Pool({ ...readTestDatabaseConfig(), database: "freight_production" });
    try { expect(() => new PostgresCrmRepository(wrong, logger)).toThrow("隔离测试"); }
    finally { await wrong.end(); }
  });
});
