export type MailAiMode = 'live' | 'off' | 'mock';

export interface MailAiModeOptions {
  requested?: string | null;
  development: boolean;
}

/** Test-only modes must never be activated by a stray production environment value. */
export function resolveMailAiMode(options: MailAiModeOptions): MailAiMode {
  const requested = (options.requested || '').trim().toLowerCase();
  if (requested !== 'off' && requested !== 'mock') return 'live';
  return options.development ? requested : 'live';
}

export function currentMailAiMode(): MailAiMode {
  const development = process.defaultApp === true
    || process.env.NODE_ENV === 'test'
    || Boolean(process.env.PROSPECTOR_DEV_PROFILE);
  return resolveMailAiMode({ requested: process.env.PROSPECTOR_MAIL_AI_MODE, development });
}

export function isInboxAiTestMode(): boolean {
  return currentMailAiMode() !== 'live';
}
