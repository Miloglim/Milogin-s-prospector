export interface CenterAiSession {
  baseUrl: string;
  accessToken: string;
}

let provider: (() => CenterAiSession | null) | null = null;

export function setCenterAiSessionProvider(next: (() => CenterAiSession | null) | null): void {
  provider = next;
}

export function getCenterAiSession(): CenterAiSession | null {
  try { return provider?.() || null; }
  catch { return null; }
}
