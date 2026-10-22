import { describe, expect, it } from 'vitest';
import { centerContactDisplayStatus } from '../../src/shared/online-crm';

describe('center contact display status', () => {
  it('uses real touch state even while imported legacy status remains empty or stale', () => {
    expect(centerContactDisplayStatus({ status: '', touchStatus: 'replied' })).toBe('replied');
    expect(centerContactDisplayStatus({ status: 'replied', touchStatus: 'contacted' })).toBe('reached');
    expect(centerContactDisplayStatus({ status: 'reached', touchStatus: 'uncontacted' })).toBe('');
  });
  it('uses canonical bounced and automatic-reply outcomes', () => {
    expect(centerContactDisplayStatus({ status: 'replied', touchStatus: 'bounced' })).toBe('bounced');
    expect(centerContactDisplayStatus({ status: 'bounced', touchStatus: 'autoreply' })).toBe('autoreply');
    expect(centerContactDisplayStatus({ status: 'bounced', touchStatus: 'uncontacted' })).toBe('');
  });
  it('keeps compatibility for old fixtures without touch status', () => {
    expect(centerContactDisplayStatus({ status: 'replied' })).toBe('replied');
    expect(centerContactDisplayStatus({})).toBe('');
  });
});
