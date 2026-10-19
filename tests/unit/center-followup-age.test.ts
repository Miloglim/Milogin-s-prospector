import { describe, it, expect } from 'vitest';
import { contactFollowupAge } from '../../src/shared/crm';
const now = Date.parse('2026-10-15T12:00:00Z');
describe('center board follows actual contact time', () => {
 it('warns and marks overdue from real contact time without using an edit or stage timestamp', () => {
  expect(contactFollowupAge('2026-10-09T12:00:00Z', now)).toMatchObject({staleDays:6,overdue:true,warnDays:3,overdueDays:5});
  expect(contactFollowupAge('2026-10-15T12:00:00Z', now)).toMatchObject({staleDays:0,overdue:false});
 });
 it('keeps unknown timestamps unknown and uses the configured thresholds', () => {
  expect(contactFollowupAge(null, now).staleDays).toBeNull();
  expect(contactFollowupAge('invalid', now).overdue).toBe(false);
  expect(contactFollowupAge('2026-10-09T12:00:00Z', now, {silentOverdueDays:7,warnDays:4})).toMatchObject({staleDays:6,overdue:false,warnDays:4});
 });
});
