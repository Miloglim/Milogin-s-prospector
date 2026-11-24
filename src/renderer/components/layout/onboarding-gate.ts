export interface OnboardingSignals {
  configKnown: boolean;
  handled?: string | null;
  mailboxCount?: number | null;
  contactCount?: number | null;
}

export type OnboardingMode = 'full' | 'connect';

export function onboardingModeFor(signals: OnboardingSignals): OnboardingMode | null {
  const count = signals.contactCount;
  if (!signals.configKnown || signals.handled || signals.mailboxCount !== 0) return null;
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
  return count === 0 ? 'full' : 'connect';
}

export function shouldPresentOnboarding(signals: OnboardingSignals): boolean {
  return onboardingModeFor(signals) !== null;
}
