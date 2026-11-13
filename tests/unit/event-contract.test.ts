import { describe, expect, it } from 'vitest';
import { EVENTS } from '../../src/main/events';
import { INBOX_EVENTS } from '../../src/shared/inbox';

describe('renderer event contract', () => {
  it('keeps every inbox event in the preload allowlist source', () => {
    expect(Object.values(EVENTS)).toEqual(expect.arrayContaining(Object.values(INBOX_EVENTS)));
  });
});
