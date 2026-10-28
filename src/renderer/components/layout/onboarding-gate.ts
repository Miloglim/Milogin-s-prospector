export interface OnboardingActivity {
  totalContacts: number;
  totalSent: number;
  totalReplied: number;
  bounceCount: number;
  recentActivity: unknown[];
}

export interface OnboardingSignals {
  configKnown: boolean;
  handled?: string | null;
  mailboxCount?: number | null;
  activity?: OnboardingActivity | null;
}

export function shouldPresentOnboarding(signals: OnboardingSignals): boolean {
  if (!signals.configKnown || signals.handled || signals.mailboxCount !== 0 || !signals.activity) return false;
  const counts = [signals.activity.totalContacts, signals.activity.totalSent, signals.activity.totalReplied, signals.activity.bounceCount];
  if (counts.some(value => !Number.isFinite(value) || value < 0)) return false;
  return counts.every(value => value === 0) && signals.activity.recentActivity.length === 0;
}
