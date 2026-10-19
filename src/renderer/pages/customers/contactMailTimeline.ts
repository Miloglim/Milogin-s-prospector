import type { ContactMailEvent } from '../../../shared/online-crm';

/** Physical messages and append-only classification audits are different timeline items. */
export function projectContactMailHistory(events: ContactMailEvent[]) {
  const grouped = new Map<string, ContactMailEvent[]>();
  const activityIds = new Set<string>();

  for (const event of events) {
    if (event.activityId) activityIds.add(event.activityId);
    const key = event.actorId && event.mailboxKey && event.messageKey
      ? JSON.stringify([
        event.actorId,
        event.mailboxKey,
        event.messageKey,
        event.customerId,
        event.contactId,
      ])
      : event.eventId;
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }

  const mail: ContactMailEvent[] = [];
  for (const group of grouped.values()) {
    const first = group[0];
    if (!first) continue;
    const original = group.find(event => !event.correction) ?? first;
    const current = group.reduce((latest, event) => (
      (event.correctionRevision ?? 0) > (latest.correctionRevision ?? 0) ? event : latest
    ), original);

    mail.push({
      ...current,
      occurredAt: original.occurredAt,
      subject: original.subject,
      preview: original.preview,
    });
  }

  return {
    mail,
    corrections: events.filter(event => !!event.correction),
    activityIds,
  };
}
