import { describe, expect, it } from 'vitest';
import { onboardingModeFor, shouldPresentOnboarding } from '../../src/renderer/components/layout/onboarding-gate';

describe('center-account onboarding gate', () => {
  it('opens only for a known account with no handled marker, sender mailbox or activity', () => {
    expect(onboardingModeFor({ configKnown: true, mailboxCount: 0, contactCount: 0 })).toBe('full');
    expect(shouldPresentOnboarding({ configKnown: true, mailboxCount: 0, contactCount: 0 })).toBe(true);
  });
  it('asks an existing center user on a fresh device to connect the existing mailbox', () => {
    expect(onboardingModeFor({ configKnown: true, mailboxCount: 0, contactCount: 1 })).toBe('connect');
  });
  it.each([
    { configKnown: false, mailboxCount: 0, contactCount: 0 },
    { configKnown: true, handled: 'skipped', mailboxCount: 0, contactCount: 0 },
    { configKnown: true, handled: 'done', mailboxCount: 0, contactCount: 0 },
    { configKnown: true, mailboxCount: 1, contactCount: 0 },
    { configKnown: true, mailboxCount: null, contactCount: 0 },
    { configKnown: true, mailboxCount: 0, contactCount: null },
    { configKnown: true, mailboxCount: 0 },
  ])('does not open when account setup is already established or unknown %#', signals => {
    expect(shouldPresentOnboarding(signals)).toBe(false);
  });
});
