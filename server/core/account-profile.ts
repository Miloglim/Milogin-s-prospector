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
  displayName?: string;
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

const AVATAR_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function normalizeAccountProfilePatch(value: unknown): AccountProfilePatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("账号资料参数无效");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["displayName", "avatarId", "bio"].includes(key))) throw new Error("账号资料包含未知字段");
  const patch: AccountProfilePatch = {};
  if (input.displayName !== undefined) {
    if (typeof input.displayName !== "string") throw new Error("用户名须为文字");
    const displayName = input.displayName.trim();
    if (!displayName || displayName.length > 64 || [...displayName].some(char => char.charCodeAt(0) < 32)) throw new Error("用户名须为1至64个字符");
    patch.displayName = displayName;
  }
  if (input.avatarId !== undefined) {
    if (typeof input.avatarId !== "string" || !AVATAR_ID_PATTERN.test(input.avatarId)) throw new Error("头像 ID 无效");
    patch.avatarId = input.avatarId;
  }
  if (input.bio !== undefined) {
    if (typeof input.bio !== "string" || input.bio.length > ACCOUNT_PROFILE_LIMITS.bioMax) throw new Error("个人简介过长");
    patch.bio = input.bio.trim();
  }
  if (!Object.keys(patch).length) throw new Error("没有需要保存的账号资料");
  return patch;
}
