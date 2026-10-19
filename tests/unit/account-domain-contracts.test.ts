import { describe, expect, it } from "vitest";
import { ACCOUNT_PROFILE_LIMITS, normalizeLoginAlias } from "../../server/core/account-profile";
import { GROWTH_SOURCE_PRODUCTS, isGrowthEventDraft, type GrowthEventDraft } from "../../server/core/account-growth";
import { isLegacyAccountMappingDraft } from "../../server/core/legacy-account-mapping";

describe("central account domain contracts", () => {
  it("normalizes shared login aliases and rejects blank values", () => {
    expect(normalizeLoginAlias("  Operator.Name ")).toBe("operator.name");
    expect(() => normalizeLoginAlias("   ")).toThrow("登录别名不能为空");
  });

  it("keeps profile limits explicit", () => {
    expect(ACCOUNT_PROFILE_LIMITS).toMatchObject({ aliasMax: 128, avatarIdMax: 64, bioMax: 500 });
  });

  it("accepts only known product growth sources", () => {
    expect(GROWTH_SOURCE_PRODUCTS).toEqual(["navigator", "crm"]);
    const event: GrowthEventDraft = {
      eventId: "event-1", userId: "user-1", sourceProduct: "navigator",
      eventType: "daily_effective_search", subjectKey: "2026-10-18:user-1",
      points: 18, ruleVersion: 2, occurredAt: "2026-10-18T00:00:00.000Z",
    };
    expect(isGrowthEventDraft(event)).toBe(true);
    expect(isGrowthEventDraft({ ...event, sourceProduct: "other" })).toBe(false);
    expect(isGrowthEventDraft({ ...event, subjectKey: "" })).toBe(false);
    expect(isGrowthEventDraft({ ...event, points: 0 })).toBe(false);
  });

  it("requires an explicit status for legacy Navigator account mappings", () => {
    expect(isLegacyAccountMappingDraft({ sourceProduct: "navigator", legacyUserId: "old-1", legacyLoginAlias: "old.name", status: "needs_review", requiresPasswordReset: true })).toBe(true);
    expect(isLegacyAccountMappingDraft({ sourceProduct: "navigator", legacyUserId: "old-1", legacyLoginAlias: "old.name", status: "matched", requiresPasswordReset: true, centerUserId: "center-1" })).toBe(true);
    expect(isLegacyAccountMappingDraft({ sourceProduct: "navigator", legacyUserId: "old-1", legacyLoginAlias: "old.name", status: "matched", requiresPasswordReset: true, centerUserId: "" })).toBe(false);
  });
});
