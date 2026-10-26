// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { InfoTab } from '../../src/renderer/components/ContactDetail';
import type { Contact } from '../../src/renderer/hooks/useContacts';

const contact: Contact = {
  dataSource: 'center', id: 1, contactId: 1, customerId: '00000000-0000-4000-8000-000000000001',
  email: 'remark@example.invalid', firstName: null, lastName: null, title: null, phone: null,
  linkedinUrl: null, companyId: 1, companyName: 'Remark Company', country: 'Germany', clientType: null,
  stage: 'cold', status: '', tags: '[]', extra: JSON.stringify({ note: 'Profile：first line\nsecond line\nAssociations：WCA' }),
  assignee: '', source: 'desktop-import', sourceDetail: 'remark.xlsx', createdAt: '2026-10-25T00:00:00Z', updatedAt: '2026-10-25T00:00:00Z',
};

describe('imported contact remark', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
  it('shows unmatched source fields as multiline imported remarks', async () => {
    await act(async () => root.render(<InfoTab contact={contact} canEdit={false} onSaveField={() => ({ success: true })} />));
    expect(host.textContent).toContain('导入备注');
    expect(host.textContent).toContain('Profile：first line');
    expect(host.textContent).toContain('Associations：WCA');
    expect(host.querySelector('.whitespace-pre-wrap')?.textContent).toContain('\nsecond line');
  });
});
