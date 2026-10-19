import { describe, expect, it } from 'vitest';
import { mapLegacyContacts } from '../../src/main/core/legacy-contact-map';

const now = '2026-10-16T00:00:00.000Z';

describe('legacy contact mapping', () => {
  it('maps one local email to one center contact', () => {
    expect(mapLegacyContacts([{ localContactId: 1, email: ' A@Example.com ' }], [{ customerId: '1-O', contactId: 9, email: 'a@example.com' }], now)).toEqual([
      { localContactId: 1, centerCustomerId: '1-O', centerContactId: 9, state: 'mapped', matchedAt: now },
    ]);
  });

  it('does not guess when either side has duplicate email candidates', () => {
    const rows = mapLegacyContacts(
      [{ localContactId: 1, email: 'a@example.com' }],
      [{ customerId: '1-O', contactId: 9, email: 'a@example.com' }, { customerId: '2-O', contactId: 10, email: 'a@example.com' }],
      now,
    );
    expect(rows[0]).toMatchObject({ localContactId: 1, state: 'ambiguous', reason: '邮箱存在多个候选' });
  });

  it('keeps unmatched local contacts pending', () => {
    expect(mapLegacyContacts([{ localContactId: 1, email: 'a@example.com' }], [], now)).toEqual([
      { localContactId: 1, state: 'unmatched', reason: '中心暂无唯一匹配', matchedAt: now },
    ]);
  });
});
