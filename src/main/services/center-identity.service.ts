let provider: (() => string | null) | null = null;
let accessProvider: (() => string | null) | null = null;

export function setCenterIdentityProvider(next: (() => string | null) | null): void {
  provider = next;
}

export function currentCenterUserId(): string | null {
  try { return provider?.() || null; } catch { return null; }
}

export function setCenterAccessTokenProvider(next: (() => string | null) | null): void {
  accessProvider = next;
}

export function currentCenterAccessToken(): string | null {
  try { return accessProvider?.() || null; } catch { return null; }
}
