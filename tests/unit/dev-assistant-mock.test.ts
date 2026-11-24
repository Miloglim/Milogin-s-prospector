import { describe, expect, it } from 'vitest';
import { buildRandomAssistantMock } from '../../src/renderer/lib/dev-assistant-mock';
import { reminderKind } from '../../src/renderer/components/AssistantBriefingCards';

describe('assistant mock data', () => {
  it('builds ten unique reminders covering all four card kinds', () => {
    const items = buildRandomAssistantMock(10);
    expect(items).toHaveLength(10);
    expect(new Set(items.map(item => item.reminderId)).size).toBe(10);
    expect(new Set(items.map(reminderKind))).toEqual(new Set(['mail', 'quote', 'task', 'followup']));
    expect(items.slice(0, 4).every(item => item.priority === 1)).toBe(true);
    expect(items.filter(item => item.priority === 1)).toHaveLength(4);
    const mail = items.find(item => reminderKind(item) === 'mail')!;
    expect(mail.facts?.senderEmail).toContain('@');
    expect(mail.facts?.waitedHours).toBeGreaterThan(0);
    const quote = items.find(item => reminderKind(item) === 'quote')!;
    expect(quote.facts?.candidates?.length).toBeGreaterThan(1);
    expect(quote.facts?.selectedCandidateId).toBeTruthy();
    expect(quote.facts?.fieldSummary?.length).toBeGreaterThan(0);
    const task = items.find(item => reminderKind(item) === 'task')!;
    expect(task.facts?.items?.length).toBeGreaterThan(0);
  });
});
