import { describe, expect, it } from "vitest";
import { delegationCapabilities, scopesFor } from "./permissions";
import type { ManagedUser } from "../server/core/admin";

const actor: ManagedUser = { userId: "test", displayName: "Test", email: "test@example.invalid", emailVerified: true, identityAdmin: false, crmRoles: ["admin"], active: true, revision: 1, deletedAt: null, accessActive: true, scope: "summary", capabilities: ["access.manage", "roles.manage"], navigatorRole: null, navigatorActive: false };
describe("fixed CRM delegation preview", () => {
  it("bounds delegation by the current manager, except explicit super administrators", () => {
    expect(delegationCapabilities(actor)).toEqual(actor.capabilities);
    expect(delegationCapabilities({...actor,identityAdmin:true})).toContain("leads.develop");
    expect(actor.capabilities).not.toContain("leads.develop");
    expect(delegationCapabilities({ ...actor, capabilities: ["roles.manage"] })).toEqual([]);
    expect(delegationCapabilities({ ...actor, accessActive: false })).toEqual([]);
  });
  it("bounds scopes by both role template and manager ceiling", () => {
    expect(scopesFor(["sales"], "summary")).toEqual(["own"]);
    expect(scopesFor(["operations"], "summary")).toEqual(["own", "shared"]);
    expect(scopesFor(["auditor"], "own")).toEqual(["own"]);
  });
});
