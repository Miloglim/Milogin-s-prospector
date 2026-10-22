import type { ContactTouchStatus } from './leads';
import type { ContactMailKind } from './contact-mail';

export interface MailProjectionFact {
  kind: ContactMailKind;
  direction: string;
  occurredAt: string;
  recordedAt: string;
  fromEmail: string;
  toEmails: string[];
}
export interface ManualTouchFact {
  contactStatus: ContactTouchStatus;
  occurredAt: string;
  recordedAt: string;
}
interface ProjectionFact {
  occurredAt: string;
  recordedAt: string;
  status: string | null;
  touch: ContactTouchStatus | null;
  manual: boolean;
}
const TOUCH_STATUS = { replied: 'replied', contacted: 'reached', bounced: 'bounced', autoreply: 'autoreply', uncontacted: '' } as const;

/** Replayed facts retain their occurrence time; recording a correction is never a new contact. */
export function projectContactMail(
  primary: string | null,
  mail: readonly MailProjectionFact[],
  manual: readonly ManualTouchFact[],
): { status: string; touchStatus: ContactTouchStatus } {
  const timeline: ProjectionFact[] = [];
  const email = primary?.toLowerCase();
  for (const fact of mail) {
    const reply = fact.kind === 'replied' && fact.direction === 'inbound'
      && fact.fromEmail.toLowerCase() === email && fact.toEmails.length > 0;
    const sent = fact.kind === 'sent' && fact.direction === 'outbound'
      && fact.toEmails.some(recipient => recipient.toLowerCase() === email)
      && fact.fromEmail.toLowerCase() !== email;
    const status = fact.kind === 'bounced' ? 'bounced'
      : fact.kind === 'autoreply' ? 'autoreply'
      : reply ? 'replied' : sent ? 'reached' : null;
    const touch = reply ? 'replied' : fact.kind === 'bounced' ? 'bounced'
      : fact.kind === 'autoreply' ? 'autoreply' : sent ? 'contacted' : null;
    timeline.push({ ...fact, manual: false, status, touch });
  }
  for (const fact of manual) {
    timeline.push({
      ...fact, manual: true,
      touch: fact.contactStatus, status: TOUCH_STATUS[fact.contactStatus],
    });
  }
  // An explicit manual result wins an occurrence-time tie; recording time never makes an old mail newer.
  timeline.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
    || Number(a.manual) - Number(b.manual)
    || Date.parse(a.recordedAt) - Date.parse(b.recordedAt));
  let touchStatus: ContactTouchStatus = 'uncontacted';
  let status = '';
  for (const fact of timeline) {
    if (fact.touch && (fact.manual || !(fact.touch === 'contacted' && ['replied','bounced','autoreply'].includes(touchStatus)))) {
      touchStatus = fact.touch;
    }
    if (fact.status !== null && !(fact.status === 'reached' && !fact.manual && touchStatus === 'replied')) {
      status = fact.status;
    }
  }
  return { status, touchStatus };
}
