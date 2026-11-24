import { describe, expect, it } from 'vitest';
import { SEND_RATE_LIMITS, jitterDelayMs, sendRateDecision, type SendRateEvent } from '../../src/main/core/send-rate-governor';

const now = Date.parse('2026-11-17T12:00:00Z');
const event = (offsetMs: number, accountId = 1, domain = 'example.com'): SendRateEvent => ({ atMs: now + offsetMs, accountId, recipientDomain: domain });

describe('send rate governor', () => {
  it('allows normal traffic', () => {
    expect(sendRateDecision([event(-60_000), event(-120_000)], event(0))).toMatchObject({ allowed: true, reason: 'ok' });
  });
  it('enforces minute burst before hourly limit', () => {
    const events = Array.from({ length: SEND_RATE_LIMITS.globalMinuteBurst }, (_, index) => event(-index * 1_000));
    expect(sendRateDecision(events, event(0))).toMatchObject({ allowed: false, reason: 'global_minute' });
  });
  it('enforces account and domain limits', () => {
    const accountEvents = Array.from({ length: SEND_RATE_LIMITS.accountHourly }, (_, index) => event(-(index + 1) * 60_000));
    expect(sendRateDecision(accountEvents, event(0))).toMatchObject({ allowed: false, reason: 'account_hour' });
    const domainEvents = Array.from({ length: SEND_RATE_LIMITS.domainHourly }, (_, index) => event(-(index + 1) * 60_000, 2, 'target.example'));
    expect(sendRateDecision(domainEvents, event(0, 3, 'target.example'))).toMatchObject({ allowed: false, reason: 'domain_hour' });
  });
  it('uses deterministic jitter in the configured window', () => {
    expect(jitterDelayMs(1)).toBeGreaterThanOrEqual(SEND_RATE_LIMITS.jitterMinSeconds * 1000);
    expect(jitterDelayMs(1)).toBeLessThanOrEqual(SEND_RATE_LIMITS.jitterMaxSeconds * 1000);
    expect(jitterDelayMs(123)).toBe(jitterDelayMs(123));
  });
});
