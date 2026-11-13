// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanListTime } from '../../src/renderer/pages/inbox/InboxList';

describe('inbox clean list time', () => {
  const now = new Date(2026, 10, 12, 12, 0);

  it('shows only time today, weekday within this week, and date before this week', () => {
    expect(cleanListTime(new Date(2026, 10, 12, 9, 45).toISOString(), now)).toBe('09:45');
    expect(cleanListTime(new Date(2026, 10, 9, 9, 33).toISOString(), now)).toBe('周一 09:33');
    expect(cleanListTime(new Date(2026, 10, 6, 9, 33).toISOString(), now)).toBe('11-06 09:33');
  });
});
