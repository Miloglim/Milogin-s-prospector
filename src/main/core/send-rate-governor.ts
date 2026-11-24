export const SEND_RATE_LIMITS = {
  globalHourlyHard: 180,
  globalHourlySoft: 150,
  globalMinuteBurst: 10,
  accountHourly: 40,
  domainHourly: 20,
  minimumAverageIntervalSeconds: 20,
  jitterMinSeconds: 20,
  jitterMaxSeconds: 40,
} as const;

export interface SendRateEvent {
  atMs: number;
  accountId: number;
  recipientDomain: string;
}

export interface SendRateDecision {
  allowed: boolean;
  reason: 'ok' | 'global_hour' | 'global_minute' | 'account_hour' | 'domain_hour';
  retryAfterMs: number;
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export function sendRateDecision(events: readonly SendRateEvent[], candidate: SendRateEvent): SendRateDecision {
  const hourStart = candidate.atMs - HOUR_MS;
  const minuteStart = candidate.atMs - MINUTE_MS;
  const recentHour = events.filter(event => event.atMs > hourStart && event.atMs <= candidate.atMs);
  const recentMinute = recentHour.filter(event => event.atMs > minuteStart);
  if (recentHour.length >= SEND_RATE_LIMITS.globalHourlyHard) return { allowed: false, reason: 'global_hour', retryAfterMs: Math.max(1, recentHour[0]!.atMs + HOUR_MS - candidate.atMs) };
  if (recentMinute.length >= SEND_RATE_LIMITS.globalMinuteBurst) return { allowed: false, reason: 'global_minute', retryAfterMs: Math.max(1, recentMinute[0]!.atMs + MINUTE_MS - candidate.atMs) };
  if (recentHour.filter(event => event.accountId === candidate.accountId).length >= SEND_RATE_LIMITS.accountHourly) return { allowed: false, reason: 'account_hour', retryAfterMs: HOUR_MS };
  if (recentHour.filter(event => event.recipientDomain === candidate.recipientDomain).length >= SEND_RATE_LIMITS.domainHourly) return { allowed: false, reason: 'domain_hour', retryAfterMs: HOUR_MS };
  return { allowed: true, reason: 'ok', retryAfterMs: 0 };
}

export function jitterDelayMs(seed: number): number {
  const span = SEND_RATE_LIMITS.jitterMaxSeconds - SEND_RATE_LIMITS.jitterMinSeconds + 1;
  return (SEND_RATE_LIMITS.jitterMinSeconds + Math.abs(Math.trunc(seed)) % span) * 1000;
}
