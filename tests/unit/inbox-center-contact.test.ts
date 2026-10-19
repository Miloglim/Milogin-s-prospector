import { describe, expect, it, vi } from 'vitest';
import type { CenterContact } from '../../src/shared/online-crm';
import { matchCenterMailboxMessage, type MailboxSnapshot, type InboxCenterContactPort, type InboxCenterContext } from '../../src/main/services/inbox-center-contact.service';

const context = { baseUrl: 'https://center.example.test', userId: 'actor-a' };
const contact = (contactId: number, email: string) => ({ contactId, customerId: `customer-${contactId}`, email, status: 'new', tags: [] }) as CenterContact;
const source = (fields: Partial<MailboxSnapshot> = {}): MailboxSnapshot => ({
  id: 1, accountId: 3, accountEmail: 'sales@our.example', messageId: '<mail-1@example.test>',
  fromEmail: 'buyer@buyer.example', to: 'sales@our.example', cc: '', subject: 'Hello',
  bodyPreview: 'Short preview', receivedAt: '2026-10-14T00:00:00.000Z', classification: 'other', myRole: 'to',
  ...fields,
});
function port(rows: CenterContact[]) {
  const storeMail = vi.fn(async () => ({ success: true as const, data: undefined }));
  const p: InboxCenterContactPort = {
    context: () => context,
    findByEmail: (_ctx, email) => rows.filter(row => row.email?.toLowerCase() === email),
    storeMail,
  };
  return { p, storeMail };
}

describe('independent center mailbox associations', () => {
  it('uses a durable manual change key for corrections without changing mail time or send facts',async()=>{
    const {p,storeMail}=port([contact(7,'buyer@buyer.example')]);
    await matchCenterMailboxMessage(p,source({classification:'autoreply'}),{correctionChangeKey:'change-A'});
    await matchCenterMailboxMessage(p,source({classification:'other'}),{correctionChangeKey:'change-B'});
    await matchCenterMailboxMessage(p,source({classification:'autoreply'}),{correctionChangeKey:'change-C'});
    await matchCenterMailboxMessage(p,source({classification:'autoreply'}),{correctionChangeKey:'change-C'});
    const events=storeMail.mock.calls.map(call=>call[1].event);
    expect(new Set(events.slice(0,3).map(event=>event.eventKey)).size).toBe(3);
    expect(events[2]!.eventKey).toBe(events[3]!.eventKey);
    expect(events[1]).toMatchObject({kind:'received',direction:'inbound',occurredAt:source().receivedAt,correction:{classification:'other',previousEventKey:null}});
    expect(events.every(event=>event.advanceSendStage===undefined)).toBe(true);
  });
  it('retains an authorized prior bounce link when correcting a daemon mail to other',async()=>{
    const row=contact(7,'buyer@buyer.example');const {p,storeMail}=port([row]);
    p.getLinks=()=>[{contactId:7,customerId:row.customerId,role:'bounce'}];
    p.contacts=()=>[row];
    await matchCenterMailboxMessage(p,source({fromEmail:'mailer-daemon@mx.example',classification:'other'}),{correctionChangeKey:'change-bounce'});
    expect(storeMail).toHaveBeenCalledWith(context,expect.objectContaining({event:expect.objectContaining({contactId:7,kind:'received',correction:{classification:'other',previousEventKey:null}})}));
  });
  it('matches a center sender without introducing a legacy ID and preserves stable metadata keys', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example')]);
    const first = await matchCenterMailboxMessage(p, source(), { classify: () => 'replied' });
    await matchCenterMailboxMessage(p, source({ id: 99 }), { classify: () => 'replied' });
    expect(first).toMatchObject({ success: true, data: { classification: 'replied', matched: 1 } });
    const input = storeMail.mock.calls[0]![1];
    expect(input).toMatchObject({ localMessageId: 1, role: 'primary', event: { contactId: 7, customerId: 'customer-7', kind: 'replied', direction: 'inbound', preview: 'Short preview' } });
    expect(input.event.eventKey).toBe(storeMail.mock.calls[1]![1].event.eventKey);
    expect(input.event).not.toHaveProperty('matchedContactId');
    expect(input.event).not.toHaveProperty('rawSource');
  });
  it('appends distinct classification facts without changing mail occurrence time and replays the same kind idempotently', async () => {
    const {p,storeMail}=port([contact(7,'buyer@buyer.example')]);
    const message=source({bodyPreview:'Final-Recipient: rfc822; buyer@buyer.example'});
    for(const classification of ['other','autoreply','replied','bounce','autoreply'])await matchCenterMailboxMessage(p,{...message,classification});
    const facts=storeMail.mock.calls.map(call=>call[1].event);
    expect(facts.map(fact=>fact.kind)).toEqual(['received','autoreply','replied','bounced','autoreply']);
    expect(new Set(facts.slice(0,4).map(fact=>fact.eventKey)).size).toBe(4);
    expect(facts[1].eventKey).toBe(facts[4].eventKey);
    expect(new Set(facts.map(fact=>fact.occurredAt))).toEqual(new Set([message.receivedAt]));
    expect(new Set(facts.map(fact=>fact.messageKey)).size).toBe(1);
  });
  it('scopes the same Message-ID to each mailbox while keeping replay independent of local IDs', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example')]);
    await matchCenterMailboxMessage(p, source());
    await matchCenterMailboxMessage(p, source({ id: 99 }));
    await matchCenterMailboxMessage(p, source({ id: 100, accountId: 4, accountEmail: 'other@our.example', to: 'other@our.example' }));
    const first = storeMail.mock.calls[0]![1].event, replay = storeMail.mock.calls[1]![1].event, other = storeMail.mock.calls[2]![1].event;
    expect(first.messageKey).toBe(replay.messageKey);
    expect(first.messageKey).not.toBe(other.messageKey);
    expect(first.eventKey).not.toBe(other.eventKey);
    expect(first.messageKey.length).toBeLessThanOrEqual(256);
  });
  it('keeps CC-only incoming mail out of reply status and marks outgoing CC independently', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example'), contact(9, 'copy@buyer.example')]);
    await matchCenterMailboxMessage(p, source({ myRole: 'cc', classification: 'replied' }), { classify: () => 'replied' });
    expect(storeMail.mock.calls[0]![1].event.kind).toBe('cc');
    await matchCenterMailboxMessage(p, source({ classification: 'sent', fromEmail: 'sales@our.example', to: 'buyer@buyer.example', cc: 'Copy Person <copy@buyer.example>' }));
    expect(storeMail.mock.calls.slice(1).map(call => [call[1].role, call[1].event.kind, call[1].event.direction])).toEqual([['to', 'sent', 'outbound'], ['cc', 'cc', 'outbound']]);
  });
  it('uses all DSN recipients and excludes original sender/other quoted recipients', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example'), contact(9, 'copy@buyer.example'), contact(10, 'quoted@buyer.example')]);
    const text = 'Final-Recipient: rfc822; buyer@buyer.example\nFinal-Recipient: rfc822; copy@buyer.example\nFrom: quoted@buyer.example';
    await matchCenterMailboxMessage(p, source({ classification: 'bounce', fromEmail: 'mailer-daemon@mx.example' }), { bounceText: text });
    expect(storeMail.mock.calls.map(call => [call[1].event.contactId, call[1].event.kind, call[1].role])).toEqual([[7, 'bounced', 'bounce'], [9, 'bounced', 'bounce']]);
  });
  it('retains manual other classification and stops on an identity switch before persisting', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example')]);
    await matchCenterMailboxMessage(p, source());
    expect(storeMail.mock.calls[0]![1].event.kind).toBe('received');
    storeMail.mockClear();
    p.findByEmail = async () => { p.context = () => ({ ...context, userId: 'actor-b' }); return [contact(7, 'buyer@buyer.example')]; };
    expect(await matchCenterMailboxMessage(p, source())).toMatchObject({ success: false });
    expect(storeMail).not.toHaveBeenCalled();
  });
  it('reports queue failure instead of claiming a match is saved', async () => {
    const { p } = port([contact(7, 'buyer@buyer.example')]);
    p.storeMail = async () => ({ success: false, error: 'queue unavailable' });
    expect(await matchCenterMailboxMessage(p, source())).toEqual({ success: false, error: 'queue unavailable' });
  });
  it.each(['primary', 'to', 'cc', 'bounce'] as const)('does not broadcast an ambiguous %s address to multiple center references', async role => {
    const { p, storeMail } = port([contact(7, 'shared@buyer.example'), contact(9, 'shared@buyer.example')]);
    const message = role === 'primary' ? source({ fromEmail: 'shared@buyer.example' })
      : role === 'to' ? source({ classification: 'sent', fromEmail: 'sales@our.example', to: 'shared@buyer.example' })
      : role === 'cc' ? source({ fromEmail: 'unknown@buyer.example', cc: 'shared@buyer.example' })
      : source({ classification: 'bounce', bodyPreview: 'Final-Recipient: rfc822; shared@buyer.example' });
    const result = await matchCenterMailboxMessage(p, message, { classify: (_subject, _from, _body, matched) => matched ? 'replied' : 'other' });
    expect(result).toMatchObject({ success: true, data: { matched: 0, classification: role === 'to' ? 'sent' : role === 'bounce' ? 'bounce' : 'other' } });
    expect(storeMail).not.toHaveBeenCalled();
  });
  it('deduplicates identical references before deciding address uniqueness', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example'), contact(7, 'buyer@buyer.example')]);
    expect(await matchCenterMailboxMessage(p, source())).toMatchObject({ success: true, data: { matched: 1 } });
    expect(storeMail.mock.calls.map(call => call[1].event.contactId)).toEqual([7]);
  });
  it('still links unique addresses independently while leaving an ambiguous sender unclassified', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example'), contact(9, 'buyer@buyer.example'), contact(10, 'unique@buyer.example')]);
    const result = await matchCenterMailboxMessage(p, source({ cc: 'unique@buyer.example' }), {
      classify: (_subject, _from, _body, matched) => matched ? 'replied' : 'other',
    });
    expect(result).toMatchObject({ success: true, data: { matched: 1, classification: 'other' } });
    expect(storeMail.mock.calls.map(call => [call[1].event.contactId, call[1].role, call[1].event.kind])).toEqual([[10, 'cc', 'cc']]);
  });
  it.each(['permission', 'inactive', 'mutated-context'] as const)('stops before persisting when lookup observes %s changes', async mode => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example'), contact(9, 'copy@buyer.example')]);
    let active = true;
    let current: InboxCenterContext = { ...context, permissionKey: 'sales', active: () => active };
    const lookedUp: string[] = [];
    p.context = () => current;
    p.findByEmail = async (_ctx, email) => {
      lookedUp.push(email);
      if (mode === 'inactive') active = false;
      else if (mode === 'mutated-context') current.permissionKey = 'revoked';
      else current = { ...current, permissionKey: 'revoked' };
      return [contact(7, 'buyer@buyer.example')];
    };
    expect(await matchCenterMailboxMessage(p, source({ cc: 'copy@buyer.example' }))).toMatchObject({ success: false });
    expect(storeMail).not.toHaveBeenCalled();
    expect(lookedUp).toEqual(['buyer@buyer.example']);
  });
  it.each(['identity', 'permission', 'inactive', 'logout'] as const)('does not report success when %s changes during the last awaited store', async mode => {
    const { p } = port([contact(7, 'buyer@buyer.example')]);
    let active = true;
    let current: InboxCenterContext | null = { ...context, permissionKey: 'sales', active: () => active };
    p.context = () => current;
    p.storeMail = async () => {
      if (mode === 'inactive') active = false;
      else if (mode === 'logout') current = null;
      else current = { ...current!, ...(mode === 'identity' ? { userId: 'actor-b' } : { permissionKey: 'revoked' }) };
      return { success: true, data: undefined };
    };
    expect(await matchCenterMailboxMessage(p, source())).toMatchObject({ success: false });
  });
  it.each(['ambiguous', 'unknown', 'system', 'own-domain'] as const)('does not attribute a quoted recipient when the explicit DSN target is %s', async mode => {
    const target = mode === 'system' ? 'postmaster@mx.example' : mode === 'own-domain' ? 'colleague@our.example' : 'shared@buyer.example';
    const rows = [contact(10, 'quoted@buyer.example'), ...(mode === 'ambiguous' ? [contact(7, target), contact(9, target)] : [])];
    const { p, storeMail } = port(rows);
    const result = await matchCenterMailboxMessage(p, source({ classification: 'bounce' }), {
      bounceText: `Final-Recipient: rfc822; ${target}\nFrom: quoted@buyer.example`,
    });
    expect(result).toMatchObject({ success: true, data: { matched: 0 } });
    expect(storeMail).not.toHaveBeenCalled();
  });
  it('does not mistake system-marker substrings in business addresses for system senders', async () => {
    const addresses = ['buyer@notaliyun.com', 'annnoreply@buyer.example'];
    const { p, storeMail } = port(addresses.map((email, index) => contact(index + 7, email)));
    expect(await matchCenterMailboxMessage(p, source({ classification: 'bounce' }), {
      bounceText: `X-Failed-Recipients: ${addresses.join(', ')}`,
    })).toMatchObject({ success: true, data: { matched: 2 } });
    expect(storeMail.mock.calls.map(call => call[1].event.contactId)).toEqual([7, 8]);
  });
  it('excludes actual system and own-domain addresses with a normalized account address', async () => {
    const addresses = ['postmaster@mx.example', 'no-reply@mailsupport.aliyun.com', 'sales@aliyun.com', 'colleague@our.example'];
    const { p, storeMail } = port(addresses.map((email, index) => contact(index + 7, email)));
    expect(await matchCenterMailboxMessage(p, source({ classification: 'bounce', accountEmail: ' SALES@OUR.EXAMPLE ' }), {
      bounceText: `X-Failed-Recipients: ${addresses.join(', ')}`,
    })).toMatchObject({ success: true, data: { matched: 0 } });
    expect(storeMail).not.toHaveBeenCalled();
  });
  it.each([
    ['natural language', 'could not be delivered to buyer@buyer.example'],
    ['Chinese natural language', '无法投递 buyer@buyer.example'],
    ['unstructured fallback', 'Delivery report buyer@buyer.example'],
  ])('retains %s bounce evidence when a higher tier is absent', async (_label, text) => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example')]);
    expect(await matchCenterMailboxMessage(p, source({ classification: 'bounce' }), { bounceText: text })).toMatchObject({ success: true, data: { matched: 1 } });
    expect(storeMail.mock.calls[0]![1]).toMatchObject({ role: 'bounce', event: { contactId: 7, kind: 'bounced' } });
  });
  it('keeps primary precedence and one event when the same reference repeats across header roles', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example')]);
    expect(await matchCenterMailboxMessage(p, source({ to: 'sales@our.example, buyer@buyer.example', cc: 'buyer@buyer.example' }))).toMatchObject({ success: true, data: { matched: 1 } });
    expect(storeMail.mock.calls.map(call => [call[1].role, call[1].event.contactId])).toEqual([['primary', 7]]);
  });
  it('does not collapse equal numerical IDs belonging to different customer references', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example'), { ...contact(7, 'buyer@buyer.example'), customerId: 'another-customer' }]);
    expect(await matchCenterMailboxMessage(p, source())).toMatchObject({ success: true, data: { matched: 0 } });
    expect(storeMail).not.toHaveBeenCalled();
  });
  it('filters mismatched lookup rows before deciding uniqueness and accepts normalized exact addresses', async () => {
    const { p, storeMail } = port([]);
    p.findByEmail = () => [contact(7, ' BUYER@BUYER.EXAMPLE '), contact(9, 'different@buyer.example')];
    expect(await matchCenterMailboxMessage(p, source())).toMatchObject({ success: true, data: { matched: 1 } });
    expect(storeMail.mock.calls.map(call => call[1].event.contactId)).toEqual([7]);
  });
  it('does not attribute sender-block failures as recipient bounces', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example')]);
    expect(await matchCenterMailboxMessage(p, source({ classification: 'bounce' }), {
      bounceText: 'Final-Recipient: rfc822; buyer@buyer.example', isSenderBlock: () => true,
    })).toMatchObject({ success: true, data: { matched: 0 } });
    expect(storeMail).not.toHaveBeenCalled();
  });
  it('does not treat quoted From headers as natural-language failure recipients', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example'), contact(9, 'quoted@buyer.example')]);
    expect(await matchCenterMailboxMessage(p, source({ classification: 'bounce' }), {
      bounceText: 'could not be delivered to buyer@buyer.example\nFrom: quoted@buyer.example',
    })).toMatchObject({ success: true, data: { matched: 1 } });
    expect(storeMail.mock.calls.map(call => call[1].event.contactId)).toEqual([7]);
  });
  it('preserves multiline natural-language recipient lists before a quoted header', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example'), contact(9, 'copy@buyer.example'), contact(10, 'quoted@buyer.example')]);
    expect(await matchCenterMailboxMessage(p, source({ classification: 'bounce' }), {
      bounceText: 'following recipients:\nbuyer@buyer.example,\ncopy@buyer.example\nFrom: quoted@buyer.example',
    })).toMatchObject({ success: true, data: { matched: 2 } });
    expect(storeMail.mock.calls.map(call => call[1].event.contactId)).toEqual([7, 9]);
  });
  it('keeps automatic reply facts separate from a human reply', async () => {
    const { p, storeMail } = port([contact(7, 'buyer@buyer.example')]);
    expect(await matchCenterMailboxMessage(p, source({ classification: 'autoreply' }))).toMatchObject({ success: true, data: { matched: 1, classification: 'autoreply' } });
    expect(storeMail.mock.calls[0]![1]).toMatchObject({ role: 'primary', event: { kind: 'autoreply', direction: 'inbound' } });
  });
});
