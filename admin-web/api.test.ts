// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, configureSession, readChallenge } from "./api";

afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, "", "/"); });
describe("browser admin session boundaries", () => {
  it("reads the system operations summary through the admin origin", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, data: { version: "0.55.0-alpha.1", checks: [] } }) });
    vi.stubGlobal("fetch", fetch);
    await api.operations();
    const url = new URL(fetch.mock.calls[0]![0], "http://localhost");
    expect(url.pathname).toBe("/admin-api/operations");
  });
  it("queries user management audit by immutable identity and selected product", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, data: [] }) });
    vi.stubGlobal("fetch", fetch);
    await api.audit("crm", "11111111-1111-4111-8111-111111111111");
    const url = new URL(fetch.mock.calls[0]![0], "http://localhost");
    expect(url.pathname).toBe("/admin-api/audit");
    expect(url.searchParams.get("productId")).toBe("crm");
    expect(url.searchParams.get("userId")).toBe("11111111-1111-4111-8111-111111111111");
  });
  it("does not expire a new identity when an old request returns 401", async () => {
    let resolveOld!: (value: unknown) => void;
    const expiredOld = vi.fn(); const expiredNew = vi.fn();
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    configureSession("old-csrf", expiredOld);
    const oldRequest = api.me();
    configureSession("new-csrf", expiredNew);
    resolveOld({ ok: false, status: 401, json: async () => ({ ok: false, error: "expired old identity" }) });
    await expect(oldRequest).rejects.toThrow("expired old identity");
    expect(expiredOld).not.toHaveBeenCalled(); expect(expiredNew).not.toHaveBeenCalled();
    await api.logout();
    expect(fetch.mock.calls.at(-1)?.[1].headers["X-CSRF-Token"]).toBe("new-csrf");
  });
  it("removes challenge material from the address before consumption", () => {
    window.history.replaceState(null, "", "/?challenge=one-time-secret&view=account#help");
    expect(readChallenge()).toBe("one-time-secret");
    expect(window.location.search).toBe("?view=account");
    expect(window.location.hash).toBe("#help");
    expect(readChallenge()).toBeNull();
  });
  it("sends challenge only in JSON body, using same-origin credentials", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetch);
    await api.challenge("one-time-secret", "new-password");
    expect(fetch).toHaveBeenCalledWith("/admin-api/challenge", expect.objectContaining({ credentials: "same-origin", cache: "no-store", body: JSON.stringify({ token: "one-time-secret", password: "new-password" }) }));
  });
  it("wrong reauthentication keeps current session, read 401 clears it", async () => {
    const expired = vi.fn(); configureSession("csrf-in-memory", expired);
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ ok: false, error: { message: "密码不正确" } }) });
    vi.stubGlobal("fetch", fetch);
    await expect(api.command({ action: "session.revoke", userId: "target", sessionId: "session", reason: "device retired" }, "wrong")).rejects.toThrow("密码不正确");
    expect(expired).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("/admin-api/command", expect.objectContaining({ headers: { "Content-Type": "application/json", "X-CSRF-Token": "csrf-in-memory" } }));
    await expect(api.me()).rejects.toThrow();
    expect(expired).toHaveBeenCalledOnce();
    await expect(api.logout()).rejects.toThrow();
    expect(fetch.mock.calls.at(-1)?.[1].headers["X-CSRF-Token"]).toBe("");
  });
});
