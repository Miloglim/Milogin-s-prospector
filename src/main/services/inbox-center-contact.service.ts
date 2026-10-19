import { createHash } from 'node:crypto';
import type { CenterContact, CenterContactRef } from '../../shared/online-crm';
import { CONTACT_MAIL_LIMITS, type ContactMailEventInput, type ContactMailKind } from '../../../server/core/contact-mail';
import { failResult, okResult, type Result } from '../errors';

export interface InboxCenterContext { baseUrl: string; userId: string; permissionKey?: string; active?(): boolean }
export interface MailboxSnapshot {
  id: number; accountId: number; accountEmail: string; messageId: string | null;
  fromEmail: string; to: string | null; cc: string | null; subject: string | null;
  bodyPreview: string | null; receivedAt: string; classification: string | null; myRole: string | null;
  folder?: string; uid?: string | number;
}
export type CenterMailRole = 'primary' | 'to' | 'cc' | 'bounce';
export interface InboxCenterLink extends CenterContactRef { role?: CenterMailRole; status?: string; tags?: string[] }
export interface InboxCenterMailInput { localMessageId: number; role: CenterMailRole; event: ContactMailEventInput; recordEvent?: boolean; }
export interface InboxCenterContactPort {
  context(): InboxCenterContext | null;
  findByEmail(context: InboxCenterContext, email: string): CenterContact[] | Promise<CenterContact[]>;
  storeMail(context: InboxCenterContext, input: InboxCenterMailInput): Result<unknown> | Promise<Result<unknown>>;
  /** Synchronous, account-scoped offline mirror; no network required by inbox list hydration. */
  getLinks?(context: InboxCenterContext, localMessageId: number): InboxCenterLink[];
  contacts?(context: InboxCenterContext): CenterContact[] | Promise<CenterContact[]>;
}
export interface CenterMailboxMatchOptions {
  correctionChangeKey?: string;
  associationOnly?: boolean;
  bounceText?: string;
  classify?: (subject: string | null, from: string | null, body: string | null, matched: boolean, ccOnly: boolean) => string;
  isSenderBlock?: (text: string) => boolean;
}
const MAX_BOUNCE_CONTACTS = 50;
const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SYSTEM_LOCAL_PART = /^(?:no-reply|noreply|mailer-daemon|postmaster|mailadmin|mailsupport)(?:[._+-]|$)/;
const SYSTEM_DOMAIN = 'aliyun.com';
function systemAddress(address: string): boolean {
  const [local = '', domain = ''] = address.split('@');
  return SYSTEM_LOCAL_PART.test(local) || domain === SYSTEM_DOMAIN || domain.endsWith(`.${SYSTEM_DOMAIN}`);
}
function emails(value: string | null | undefined): string[] {
  return [...new Set((value?.match(EMAIL_PATTERN) || []).map(email => email.trim().toLowerCase()).filter(email => email.length <= CONTACT_MAIL_LIMITS.email))];
}
function hash(parts: unknown[]): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
function sameContext(port: InboxCenterContactPort, context: InboxCenterContext): boolean {
  const current = port.context();
  return context.active?.() !== false && current?.active?.() !== false
    && current?.userId === context.userId && current.baseUrl === context.baseUrl
    && current.permissionKey === context.permissionKey;
}
function bounceTiers(text: string): string[][] {
  const dsn: string[] = [];
  for (const match of text.matchAll(/(?:X-Failed-Recipients|Final-Recipient|Original-Recipient):\s*(?:rfc822;)?([^\r\n]+)/gi)) dsn.push(...emails(match[1]));
  const natural: string[] = [];
  const flat = text.replace(/\s+/g, ' ');
  for (const pattern of [
    /could not be delivered to\s+([^\r\n]{0,400})/gi,
    /following recipients?[^:]*:\s*([^\r\n]{0,400})/gi,
    /<(\S+@\S+)>[^<]{0,60}?(?:failed|rejected|bounced|undeliverable)/gi,
    /收(?:件|信)人?\s*(?:邮件)?地址[：:]\s*([^\r\n]{0,200})/g,
    /(?:无法(?:送达|投递)|退信|拒收)\s*[^\r\n]{0,60}?((?:[\w.+-]+@[\w.-]+\.\w+)(?:[，,、;；\s]+[\w.+-]+@[\w.-]+\.\w+)*)/g,
  ]) for (const match of flat.matchAll(pattern)) {
    const recipients = match[1]?.split(/\s(?:From|To|Cc|Subject|Date|Sent|发件人|收件人|抄送|主题|发送时间)[：:]/i)[0];
    natural.push(...emails(recipients));
  }
  return [dsn, natural, emails(text)];
}

/** Pure metadata matching. Never updates SQLite contact IDs, status, campaigns, body files or attachments. */
export async function matchCenterMailboxMessage(
  port: InboxCenterContactPort, source: MailboxSnapshot, options: CenterMailboxMatchOptions = {},
): Promise<Result<{ matched: number; classification: string }>> {
  const current = port.context();
  const originalClassification = source.classification || 'other';
  if (!current) return okResult({ matched: 0, classification: originalClassification });
  const context = { ...current };
  if (!source.accountEmail) return failResult('邮件发信账号缺失，无法建立中心关联');
  try {
    const direction = originalClassification === 'sent' ? 'outbound' : 'inbound';
    const ccOnly = source.myRole === 'cc' && direction === 'inbound';
    const linked = new Map<string, { contact: CenterContact; role: CenterMailRole }>();
    const lookup = async (addresses: string[], role: CenterMailRole): Promise<void> => {
      for (const address of [...new Set(addresses)]) {
        if (!sameContext(port, context)) return;
        if (address === source.accountEmail.trim().toLowerCase()) continue;
        const rows = await port.findByEmail(context, address);
        if (!sameContext(port, context)) return;
        // Uniqueness is per address and explicit center reference, never per company or row position.
        const candidates = new Map<string, CenterContact>();
        for (const contact of rows) {
          if (contact.email?.trim().toLowerCase() !== address) continue;
          const key = `${contact.customerId}:${contact.contactId}`;
          candidates.set(key, contact);
        }
        if (candidates.size !== 1) continue;
        const candidate = candidates.entries().next().value;
        if (!candidate) continue;
        const [key, contact] = candidate;
        if (!linked.has(key)) linked.set(key, { contact, role });
        if (role === 'bounce' && linked.size >= MAX_BOUNCE_CONTACTS) return;
      }
    };
    const bounceText = options.bounceText ?? source.bodyPreview ?? '';
    if (originalClassification === 'bounce') {
      if (options.isSenderBlock?.(bounceText)) return okResult({ matched: 0, classification: originalClassification });
      const ownDomain = source.accountEmail.trim().toLowerCase().split('@')[1];
      for (const tier of bounceTiers(bounceText)) {
        if (!tier.length) continue;
        // Explicit failed recipients remain authoritative even when absent or ambiguous in the mirror.
        // Falling back to quoted From/To addresses would invent a bounce for another contact.
        await lookup(tier.filter(address => !systemAddress(address) && address.split('@')[1] !== ownDomain), 'bounce');
        break;
      }
    } else {
      if (direction === 'inbound') await lookup(emails(source.fromEmail), 'primary');
      await lookup(emails(source.to), 'to');
      await lookup(emails(source.cc), 'cc');
    }
    if (options.correctionChangeKey && direction === 'inbound' && port.contacts && port.getLinks) {
      const available = await port.contacts(context);
      if (!sameContext(port, context)) return failResult('账号已切换');
      for (const prior of port.getLinks(context, source.id)) {
        if (prior.role !== 'bounce' && prior.role !== 'primary') continue;
        const row = available.find(row => row.contactId === prior.contactId && row.customerId === prior.customerId);
        if (row) linked.set(`${row.customerId}:${row.contactId}`, { contact: row, role: prior.role });
      }
    }
    if (options.correctionChangeKey && direction === 'inbound' && !systemAddress(source.fromEmail.toLowerCase())) await lookup(emails(source.fromEmail), 'primary');
    if (!sameContext(port, context)) return failResult('账号已切换，邮件关联已停止');
    const senderMatched = [...linked.values()].some(item => item.role === 'primary');
    const classification = options.classify && direction === 'inbound' && originalClassification === 'other'
      ? options.classify(source.subject, source.fromEmail, source.bodyPreview, senderMatched, ccOnly)
      : originalClassification;
    const mailboxKey = `mailbox:${hash([source.accountEmail.trim().toLowerCase()])}`;
    const sourceMessageKey = source.messageId?.trim() || `${source.folder || (direction === 'outbound' ? 'sent' : 'inbox')}:${source.uid ?? source.id}`;
    // The same Message-ID can be delivered to several configured mailboxes.
    // Keep local links scoped to the mailbox as well as center event keys.
    const messageKey = `message:${hash([mailboxKey])}:${hash([sourceMessageKey])}`;
    let matched = 0;
    for (const { contact, role } of linked.values()) {
      if (!sameContext(port, context)) return failResult('账号已切换，邮件关联已停止');
      const correction = options.correctionChangeKey && direction === 'inbound' && (role === 'primary' || role === 'bounce')
        ? { previousEventKey: null, classification: classification === 'bounce' ? 'bounced' as const
          : classification === 'replied' ? 'replied' as const : classification === 'autoreply' ? 'autoreply' as const : 'other' as const }
        : undefined;
      const kind: ContactMailKind = correction ? correction.classification==='other'?'received':correction.classification : role === 'bounce' ? 'bounced'
        : role === 'cc' || ccOnly ? 'cc'
        : direction === 'outbound' ? 'sent'
        : role !== 'primary' ? 'received'
        : classification === 'replied' ? 'replied'
        : classification === 'autoreply' ? 'autoreply' : 'received';
      const event: ContactMailEventInput = {
        contactId: contact.contactId, customerId: contact.customerId, mailboxKey, messageKey,
        eventKey: `mail:${hash([mailboxKey, messageKey, contact.customerId, contact.contactId, kind, direction,...(correction?[options.correctionChangeKey]:[])])}`,
        kind, direction, occurredAt: source.receivedAt,
        ...(correction?{correction}:{}),
        subject: (source.subject || '').slice(0, CONTACT_MAIL_LIMITS.subject), preview: (source.bodyPreview || '').slice(0, CONTACT_MAIL_LIMITS.preview),
        fromEmail: emails(source.fromEmail)[0] || '', toEmails: emails(source.to).slice(0, CONTACT_MAIL_LIMITS.recipients), ccEmails: emails(source.cc).slice(0, CONTACT_MAIL_LIMITS.recipients),
      };
      const saved = await port.storeMail(context, { localMessageId: source.id, role, event, ...(options.associationOnly ? { recordEvent: false } : {}) });
      if (!sameContext(port, context)) return failResult('账号或权限已变化，邮件关联已停止');
      if (!saved.success) return failResult(saved.error);
      matched++;
    }
    return okResult({ matched, classification });
  } catch (error) {
    // Caller logs this Result; the pure matcher must propagate queue/lookup failure, never claim persistence.
    return failResult(error instanceof Error ? error.message : String(error));
  }
}
