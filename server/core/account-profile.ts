import type { GrowthSummary } from "./account-growth";

export const ACCOUNT_PROFILE_LIMITS = {
  aliasMax: 128,
  avatarIdMax: 64,
  bioMax: 500,
} as const;

export interface AccountProfile {
  userId: string;
  displayName: string;
  avatarId: string;
  bio: string;
  growth: GrowthSummary | null;
}

export interface AccountProfilePatch {
  avatarId?: string;
  bio?: string;
}

export interface LoginAlias {
  alias: string;
  userId: string;
}

export function normalizeLoginAlias(value: string): string {
  const alias = value.trim().toLowerCase();
  if (!alias) throw new Error("登录别名不能为空");
  if (alias.length > ACCOUNT_PROFILE_LIMITS.aliasMax) throw new Error("登录别名过长");
  return alias;
}
