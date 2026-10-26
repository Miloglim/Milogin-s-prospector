// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "../../admin-web/api";
import { DataBrowser } from "../../admin-web/data-browser";
import type { Identity } from "../../server/core/auth";

const identity: Identity = { userId: "admin", email: "admin@example.invalid", displayName: "管理员", emailVerified: true, identityAdmin: true, mustChangePassword: false, crmRoles: ["admin"] };
const page = {
  table: { id: "identity.users", group: "账号与权限", label: "用户", description: "中心账号、启用状态与权限修订" },
  columns: [
    { key: "user_id", label: "用户 ID", type: "uuid", kind: "text" as const, sortable: true, searchable: true },
    { key: "display_name", label: "姓名", type: "text", kind: "text" as const, sortable: true, searchable: true },
    { key: "active", label: "启用", type: "boolean", kind: "boolean" as const, sortable: true, searchable: false },
  ],
  rows: [{ user_id: "u-1", display_name: "Alice", active: true }],
  total: 1,
  limit: 25,
  offset: 0,
  search: "",
  sort: "created_at",
  direction: "desc" as const,
  keyColumn: "user_id",
};

describe("read-only management data browser", () => {
  let root: Root; let host: HTMLDivElement;
  afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.restoreAllMocks(); });
  it("renders business rows with search, sorting, and server pagination but no write controls", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    vi.spyOn(api, "dataTables").mockResolvedValue([page.table]);
    vi.spyOn(api, "data").mockResolvedValue(page);
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root.render(<DataBrowser identity={identity} />); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(host.textContent).toContain("中心 PostgreSQL · 只读");
    expect(host.textContent).toContain("用户 ID");
    expect(host.textContent).toContain("Alice");
    expect(host.textContent).toContain("共 1 行");
    expect(host.textContent).not.toContain("编辑");
    expect(host.textContent).not.toContain("删除");
    expect(api.data).toHaveBeenCalledWith(expect.objectContaining({ table: "identity.users", limit: 25, offset: 0 }));
    await act(async () => { (Array.from(host.querySelectorAll("button")).find(button => button.textContent?.replace(/\s/g, "") === "刷新") as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(api.data).toHaveBeenCalledTimes(2);
  });
});
