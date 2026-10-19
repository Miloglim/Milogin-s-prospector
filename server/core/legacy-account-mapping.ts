export const LEGACY_ACCOUNT_MAPPING_STATUSES = ["pending", "matched", "needs_review", "migrated", "rejected"] as const;
export type LegacyAccountMappingStatus = typeof LEGACY_ACCOUNT_MAPPING_STATUSES[number];

export interface LegacyAccountMappingDraft {
  sourceProduct: "navigator";
  legacyUserId: string;
  legacyLoginAlias: string;
  centerUserId?: string | null;
  status: LegacyAccountMappingStatus;
  requiresPasswordReset: boolean;
  reason?: string;
}

export function isLegacyAccountMappingDraft(value: unknown): value is LegacyAccountMappingDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<LegacyAccountMappingDraft>;
  return draft.sourceProduct === "navigator"
    && typeof draft.legacyUserId === "string" && draft.legacyUserId.trim() !== ""
    && typeof draft.legacyLoginAlias === "string" && draft.legacyLoginAlias.trim() !== ""
    && LEGACY_ACCOUNT_MAPPING_STATUSES.includes(draft.status as LegacyAccountMappingStatus)
    && typeof draft.requiresPasswordReset === "boolean"
    && (draft.centerUserId == null || (typeof draft.centerUserId === "string" && draft.centerUserId.trim() !== ""));
}
