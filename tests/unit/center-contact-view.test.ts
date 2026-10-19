import { describe, it, expect, vi } from 'vitest';
import { readCenterContacts } from '../../src/renderer/hooks/useCenterContacts';
import { success } from '../../server/core/crm';

const row = {
  contactId: 12, customerId: '11111111-1111-4111-8111-111111111111', customerVersion: 2,
  companyId: 7, companyName: 'Synthetic company', email: null,
  firstName: 'Contact', lastName: 'Surname', title: 'Manager', phone: '123', linkedinUrl: null,
  country: 'Brazil', clientType: 'agent', language: 'PT', stage: 'f2', status: 'replied',
  tags: ['quoting'], extra: { crmPreferences: { warnDays: 3 } }, touchStatus: 'contacted',
  assignee: 'legacy free text', source: 'file', sourceDetail: null,
  createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
  ownerUserId: '22222222-2222-4222-8222-222222222222', ownerName: 'Center owner', origin: 'operations', state: 'owned',
};
describe('center contact component data adapter', () => {
  it('preserves display fields and makes central IDs impossible to mistake for a legacy id', async () => {
    const invoke = vi.fn(async () => success({ items: [row], total: 1 }));
    const result = await readCenterContacts({ page: 2, country: 'Brazil' }, invoke);
    expect(invoke).toHaveBeenCalledWith('online:contact-list', { search: '', limit: 50, offset: 50, country: 'Brazil' });
    expect(result).toMatchObject({ ok: true, data: { total: 1, items: [{
      contactId: 12, customerId: row.customerId, rowKey: `${row.customerId}:12`,
      email: '', firstName: 'Contact', lastName: 'Surname', stage: 'f2', status: 'replied',
      tags: '["quoting"]', extra: JSON.stringify(row.extra), assignee: 'Center owner',
    }] } });
    if (!result.ok) throw Error('Expected center data');
    expect(result.data.items[0]).not.toHaveProperty('id');
  });
  it('rejects bad pagination and truncated responses rather than showing a false empty list', async () => {
    const invoke = vi.fn(async () => success({ items: [{ ...row, customerId: undefined }], total: 1 }));
    expect(await readCenterContacts({ page: 0 }, invoke)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(invoke).not.toHaveBeenCalled();
    expect(await readCenterContacts({}, invoke)).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(await readCenterContacts({}, async () => { throw Error('IPC rejected'); })).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
  });
});
