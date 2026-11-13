// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mailNotificationThreadKey, notificationChangeCopy, notificationResourceHash } from '../../src/renderer/components/MessageCenterPanel';
import type { OnlineNotification } from '../../src/shared/online-crm';

const root = resolve(__dirname, '../..');
const panelSource = readFileSync(resolve(root, 'src/renderer/components/MessageCenterPanel.tsx'), 'utf8');
const sidebarSource = readFileSync(resolve(root, 'src/renderer/components/layout/Sidebar.tsx'), 'utf8');
const panelCss = readFileSync(resolve(root, 'src/renderer/pages/messages/MessagesPage.css'), 'utf8');

const base: OnlineNotification = {
  id: 'delivery-1',
  eventType: 'crm.contact.followup',
  customerId: 'customer-1',
  version: 2,
  cursor: '2',
  createdAt: '2026-11-11T00:00:00.000Z',
  read: false,
  contactId: 7,
  summary: { companyName: 'ThreeLogintl', actorName: 'Zayne', note: null },
};

describe('message center notification copy', () => {
  it('explains a follow-up by status, stage, method and note', () => {
    const copy = notificationChangeCopy({
      ...base,
      change: { kind: 'followup', stage: 'quoting', contactStatus: 'contacted', method: 'email', note: '已发送上海到鹿特丹报价' },
    });
    expect(copy.label).toBe('状态与阶段更新');
    expect(copy.detail).toContain('状态：已触达');
    expect(copy.detail).toContain('阶段：报价中');
    expect(copy.detail).toContain('方式：邮件');
    expect(copy.detail).toContain('已发送上海到鹿特丹报价');
  });

  it('lists changed contact fields instead of repeating a generic update label', () => {
    const copy = notificationChangeCopy({
      ...base,
      eventType: 'crm.contact.updated',
      change: { kind: 'fields', fields: ['phone', 'tags'] },
    });
    expect(copy).toEqual({ label: '联系人资料更新', detail: '电话、标签' });
  });

  it('shows the real mail subject and sender for mail-driven follow-ups', () => {
    const copy = notificationChangeCopy({
      ...base,
      change: { kind: 'mail', direction: 'inbound', method: 'email', from: 'imendes@threelogintl.com', note: 'RES: Quotation Request FCL - QUOTE-1563-1126' },
    });
    expect(copy).toEqual({
      label: '收到客户邮件',
      detail: 'RES: Quotation Request FCL - QUOTE-1563-1126 · 来自 imendes@threelogintl.com',
    });
  });

  it('shows field-level before and after values', () => {
    const followup = notificationChangeCopy({
      ...base,
      change: { kind: 'followup', changes: [{ field: 'contactStatus', from: 'contacted', to: 'replied' }, { field: 'stage', from: 'cold', to: 'quoting' }], method: 'email', note: '客户回复报价' },
    });
    expect(followup.detail).toContain('联系状态：已触达 → 已收到');
    expect(followup.detail).toContain('关系阶段：未联系 → 报价中');
    const fields = notificationChangeCopy({
      ...base,
      eventType: 'crm.contact.updated',
      change: { kind: 'fields', fields: ['phone'], changes: [{ field: 'phone', from: '13800000000', to: '13900000000' }] },
    });
    expect(fields.detail).toBe('电话：13800000000 → 13900000000');
  });

  it('opens the exact contact table target with a highlight marker', () => {
    expect(notificationResourceHash(base, 'customer-1')).toBe('#/customers?view=table&centerContact=7&centerCustomer=customer-1&highlight=delivery-1');
    expect(notificationResourceHash(base, 'customer-1', undefined, 'delivery-1:2')).toContain('highlight=delivery-1%3A2');
  });

  it('opens mail notifications in the inbox and collapses reply subjects to one thread', () => {
    const mail: OnlineNotification = {
      ...base,
      mailMessageKey: 'message:mailbox:source',
      change: { kind: 'mail', direction: 'inbound', method: 'email', from: 'buyer@example.test', note: 'Re: Quotation Request AIR' },
    };
    expect(notificationResourceHash(mail, 'customer-1')).toContain('#/inbox?');
    expect(notificationResourceHash(mail, 'customer-1')).toContain('centerMail=message%3Amailbox%3Asource');
    expect(notificationResourceHash(mail, 'customer-1')).toContain('mailSubject=Re%3A+Quotation+Request+AIR');
    expect(mailNotificationThreadKey(mail)).toBe(mailNotificationThreadKey({ ...mail, id: 'delivery-2', change: { ...mail.change!, note: 'Quotation Request AIR' } }));
    expect(mailNotificationThreadKey(mail)).toBe(mailNotificationThreadKey({ ...mail, id: 'delivery-3', change: { ...mail.change!, note: 'RES: Quotation Request AIR' } }));
  });

  it('uses a compact dropdown in the sidebar while keeping the route panel resizable', () => {
    expect(panelSource).toContain('compact = false');
    expect(panelSource).toContain("compact ? ' is-dropdown' : ''");
    expect(panelSource).toContain('!compact && <button type="button" className="message-resize-grip"');
    expect(sidebarSource).toContain('<MessageCenterPanel compact />');
    expect(panelCss).toMatch(/\.message-center-panel\.is-dropdown\s*\{[^}]*width:\s*min\(356px/s);
    expect(panelCss).toMatch(/\.message-center-panel\.is-dropdown\s*\{[^}]*height:\s*min\(510px/s);
    expect(panelCss).toMatch(/\.message-center-popover \.ant-popover-inner\s*\{[^}]*padding:\s*0;/s);
  });
});
