import { describe, expect, it, vi } from 'vitest';
import { failure, success } from '../../server/core/crm';
import type { CenterContact, CenterContactPage } from '../../server/core/center-contacts';
import { readAllCenterContactsForMatch } from '../../src/main/services/contact-match-reader.service';

function contact(id: number): CenterContact {
  return {
    contactId: id,
    customerId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    customerVersion: 1,
    companyId: 1,
    companyName: 'Example',
    email: `contact-${id}@example.com`,
    firstName: null,
    lastName: null,
    title: null,
    phone: null,
    whatsapp: null,
    linkedinUrl: null,
    country: null,
    clientType: null,
    language: null,
    stage: '',
    status: '',
    tags: [],
    extra: {},
    touchStatus: 'uncontacted',
    assignee: '',
    source: 'test',
    sourceDetail: null,
    sourceLevel1: null,
    sourceLevel2: null,
    createdAt: '2026-10-22T00:00:00.000Z',
    updatedAt: '2026-10-22T00:00:00.000Z',
    ownerUserId: null,
    ownerName: null,
    origin: 'operations',
    state: 'published',
    assignmentStatus: 'accepted',
  };
}

describe('inbox center contact match reader', () => {
  it('reads every authorized page instead of using a cached partial list', async () => {
    const pages: Record<number, CenterContactPage> = {
      0: { items: [contact(1), contact(2)], total: 3 },
      2: { items: [contact(3)], total: 3 },
    };
    const query = vi.fn(async ({ offset }: { offset: number }) => success(pages[offset]!));

    const result = await readAllCenterContactsForMatch(query as never, () => true);

    expect(result).toMatchObject({ ok: true, data: [{ contactId: 1 }, { contactId: 2 }, { contactId: 3 }] });
    expect(query).toHaveBeenNthCalledWith(1, expect.objectContaining({ offset: 0, limit: 100 }));
    expect(query).toHaveBeenNthCalledWith(2, expect.objectContaining({ offset: 2, limit: 100 }));
  });

  it('returns the center failure instead of converting it into no matches', async () => {
    const result = await readAllCenterContactsForMatch(
      async () => failure('UNAVAILABLE', '中心联系人暂时不可用'),
      () => true,
    );

    expect(result).toEqual(failure('UNAVAILABLE', '中心联系人暂时不可用'));
  });
});
