import { describe, expect, it } from 'vitest';
import { assistantDue, assistantSelection, fallbackAssistantSelection, type AssistantCandidate } from '../../src/main/core/assistant';
import { assistantCallout } from '../../src/shared/assistant';

const candidates: AssistantCandidate[] = [
  { id: 'mail-1', signature: 'mail:1', title: '客户在等回复：Acme', detail: '确认运价', target: 'inbox:1', priority: 2 },
  { id: 'task-1', signature: 'task:1', title: '待办：补料', detail: '今天到期', target: 'customers:c:1', priority: 1 },
  { id: 'review-1', signature: 'review:1', title: '报价待你确认：Beta', detail: 'Shanghai→Santos', target: 'team_review', priority: 3 },
];

describe('assistant rules', () => {
  it('is due when never checked or when the interval has elapsed', () => {
    const now = Date.parse('2026-11-18T10:00:00Z');
    expect(assistantDue(null, 60, now)).toBe(true);
    expect(assistantDue('2026-11-18T09:30:00Z', 60, now)).toBe(false);
    expect(assistantDue('2026-11-18T08:00:00Z', 60, now)).toBe(true);
    expect(assistantDue(null, 0, now)).toBe(false);
  });

  it('falls back to the highest priority candidates', () => {
    expect(fallbackAssistantSelection(candidates).map(item => item.id)).toEqual(['task-1', 'mail-1', 'review-1']);
  });

  it('accepts only known ids and keeps candidate targets', () => {
    const selected = assistantSelection({ items: [
      { id: 'review-1', title: 'Beta 报价等你确认', detail: '上海到桑托斯' },
      { id: 'unknown', title: '编造', detail: '不存在' },
      { id: 'review-1', title: '重复', detail: '重复' },
    ] }, candidates);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ id: 'review-1', title: 'Beta 报价等你确认', target: 'team_review' });
  });

  it('honours an explicit empty decision but falls back on unusable output', () => {
    expect(assistantSelection({ items: [] }, candidates)).toEqual([]);
    expect(assistantSelection('not-json', candidates).map(item => item.id)).toEqual(['task-1', 'mail-1', 'review-1']);
  });

  it('turns the top reminder into a short navigation callout', () => {
    expect(assistantCallout([])).toBe('任务');
    expect(assistantCallout([{ reminderId: 'r', title: '客户在等回复：Tom', detail: '', target: 'inbox:1', priority: 2, source: 'ai', createdAt: '' }])).toBe('回复 Tom');
    expect(assistantCallout([{ reminderId: 'r', title: '报价待你确认：Acme', detail: '', target: 'team_review', priority: 2, source: 'ai', createdAt: '' }])).toBe('确认报价');
    expect(assistantCallout([{ reminderId: 'r', title: '待办：补料', detail: '', target: 'customers:c:1', priority: 1, source: 'ai', createdAt: '' }])).toBe('处理待办');
  });
});
