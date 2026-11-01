import { describe, expect, it } from 'vitest';
import { onboardingModeFor, shouldPresentOnboarding, type OnboardingActivity } from '../../src/renderer/components/layout/onboarding-gate';

const activity = (overrides: Partial<OnboardingActivity> = {}): OnboardingActivity => ({
  totalContacts: 0,
  totalSent: 0,
  totalReplied: 0,
  bounceCount: 0,
  recentActivity: [],
  ...overrides,
});

describe('center-account onboarding gate', () => {
  it('opens only for a known account with no handled marker, sender mailbox or activity', () => {
    expect(onboardingModeFor({ configKnown: true, mailboxCount: 0, activity: activity() })).toBe('full');
    expect(shouldPresentOnboarding({ configKnown: true, mailboxCount: 0, activity: activity() })).toBe(true);
  });
  it('asks an existing center user on a fresh device to connect the existing mailbox', () => {
    expect(onboardingModeFor({ configKnown: true, mailboxCount: 0, activity: activity({ totalContacts: 1 }) })).toBe('connect');
  });
  it.each([
    { configKnown: false, mailboxCount: 0, activity: activity() },
    { configKnown: true, handled: 'skipped', mailboxCount: 0, activity: activity() },
    { configKnown: true, handled: 'done', mailboxCount: 0, activity: activity() },
    { configKnown: true, mailboxCount: 1, activity: activity() },
    { configKnown: true, mailboxCount: null, activity: activity() },
    { configKnown: true, mailboxCount: 0, activity: null },
  ])('does not open when account setup is already established or unknown %#', signals => {
    expect(shouldPresentOnboarding(signals)).toBe(false);
  });
});
