import { describe, expect, it } from "vitest";
import {
  ADMIN_DATA_TABLES,
  adminDataValueKind,
  canReadAdminData,
  findAdminDataTable,
  isSafeAdminDataColumn,
} from "../../server/core/admin-data-browser";

describe("management data browser boundary", () => {
  it("keeps only explicit business tables and never security credential tables", () => {
    const ids = ADMIN_DATA_TABLES.map(table => table.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(findAdminDataTable("public.contacts")?.label).toBe("联系人");
    expect(findAdminDataTable("identity.credentials")).toBeUndefined();
    expect(findAdminDataTable("identity.sessions")).toBeUndefined();
    expect(findAdminDataTable("identity.desktop_refresh_tokens")).toBeUndefined();
    expect(findAdminDataTable("identity.management_challenges")).toBeUndefined();
  });

  it("rejects credential-like columns while allowing ordinary business columns", () => {
    expect(isSafeAdminDataColumn("password_hash")).toBe(false);
    expect(isSafeAdminDataColumn("session_token")).toBe(false);
    expect(isSafeAdminDataColumn("challenge_hash")).toBe(false);
    expect(isSafeAdminDataColumn("capabilities")).toBe(true);
    expect(isSafeAdminDataColumn("crm_touch_status")).toBe(true);
  });

  it("maps common PostgreSQL types for safe display", () => {
    expect(adminDataValueKind("timestamp with time zone")).toBe("date");
    expect(adminDataValueKind("jsonb")).toBe("json");
    expect(adminDataValueKind("integer")).toBe("number");
    expect(adminDataValueKind("uuid")).toBe("text");
  });

  it("allows database browsing only for the identity super administrator", () => {
    expect(canReadAdminData({ identityAdmin: true })).toBe(true);
    expect(canReadAdminData({ identityAdmin: false })).toBe(false);
  });
});
