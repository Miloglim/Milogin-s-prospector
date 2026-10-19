import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendItem } from '../../src/main/services/send.service';
const h = vi.hoisted(() => ({ sendMail: vi.fn(), close: vi.fn() }));
vi.mock('nodemailer', () => ({ createTransport: () => ({ sendMail: h.sendMail, close: h.close }) }));
vi.mock('../../src/main/db', () => ({ getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ get: () => ({ id: 1, email: 'sender@example.test', smtpHost: 'smtp.example.test', smtpPort: 587 }) }) }) }) }) }));
vi.mock('../../src/main/services/account.service', () => ({ getDecryptedPassword: () => ({ success: true, data: 'synthetic-only' }) }));
vi.mock('../../src/main/config', () => ({ loadConfig: () => ({ fromName: 'Test' }) }));
vi.mock('../../src/main/logger', () => ({ Log: { debug: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/main/net-proxy', () => ({ netFetch: vi.fn() }));
function item(center: boolean): SendItem & { body: string } {
  return { id: 'test', companyName: 'Test', companyId: 1, accountId: 1, subject: 'Synthetic', body: 'Synthetic', tplBody: '', contactVars: {}, status: 'pending', recipients: [{ contactId: 1, email: 'one@example.test', name: 'One', ...(center ? { centerReference: { contactId: 1, customerId: 'customer-one' } } : {}) }] };
}
beforeEach(() => { h.sendMail.mockReset(); h.close.mockReset(); });
describe('center SMTP adapter evidence', () => {
  it('never reconnects and retries ambiguous center transport failure after DATA', async () => {
    const { sendBcc } = await import('../../src/main/adapters/smtp.adapter');
    h.sendMail.mockRejectedValueOnce(new Error('ECONNRESET after DATA')).mockResolvedValueOnce({ messageId: 'duplicate' });
    expect(await sendBcc(item(true))).toMatchObject({ success: false }); expect(h.sendMail).toHaveBeenCalledOnce();
  });
  it('retains historical legacy idle reconnect behavior', async () => {
    const { sendBcc } = await import('../../src/main/adapters/smtp.adapter');
    h.sendMail.mockRejectedValueOnce(new Error('idle socket disconnected')).mockResolvedValueOnce({ messageId: 'legacy' });
    expect(await sendBcc(item(false))).toMatchObject({ success: true, data: { messageId: 'legacy' } }); expect(h.sendMail).toHaveBeenCalledTimes(2);
  });
  it('returns actual accepted and rejected envelope recipients', async () => {
    const { sendBcc } = await import('../../src/main/adapters/smtp.adapter');
    h.sendMail.mockResolvedValue({ messageId: 'partial', accepted: ['one@example.test'], rejected: ['two@example.test'] });
    expect(await sendBcc(item(true))).toEqual({ success: true, data: { messageId: 'partial', accepted: ['one@example.test'], rejected: ['two@example.test'] } });
  });
});
