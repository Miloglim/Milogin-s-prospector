import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAgentContactPort, type AgentContactPort } from '../../src/main/services/agent-contact.service';
import type { CenterContact } from '../../src/shared/online-crm';
import type { PendingAction } from '../../src/main/services/agent/actions';
import { execGenerateDraft, execSendQueueAdd, execCampaignCreate } from '../../src/main/services/agent/toolkit/send';

const h = vi.hoisted(() => ({
  cards: [] as Array<Omit<PendingAction, 'id'>>,
  enqueue: vi.fn(), dynamic: vi.fn(), prepared: vi.fn(), adaptive: vi.fn(), queue: vi.fn(), preview: vi.fn(), campaign: vi.fn(), scan: vi.fn(),
  draft: vi.fn(), reply: vi.fn(), audit: vi.fn(), work: vi.fn(), db: vi.fn(), body: vi.fn(),
}));
vi.mock('../../src/main/db', () => ({ getDb: h.db, getRawDb: vi.fn(), saveDatabase: vi.fn() }));
vi.mock('../../src/main/services/send.service', () => ({ startDynamicSend: vi.fn(), buildDynamicQueue: h.dynamic, buildAdaptiveQueue: h.adaptive, startQueue: h.enqueue, getQueueItems: () => ({ success: true, data: [] }), getSendStatus: vi.fn(), isValidEmail: (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) }));
vi.mock('../../src/main/services/campaign.service', () => ({ previewCampaign: h.preview, createCampaign: h.campaign, enqueuePreparedCampaign: h.prepared, scanDueCampaigns: h.scan }));
vi.mock('../../src/main/services/ai.service', () => ({ generateEmailDraft: h.draft, generateEmailReply: h.reply }));
vi.mock('../../src/main/services/inbox.service', () => ({ getBody: h.body, htmlToText: (s: string) => s }));
vi.mock('../../src/main/services/agent/identity', () => ({
  readIdentity: () => ({}),
  identityForMailbox: (mailbox: { email: string; displayName?: string | null }, fallback: Record<string, unknown>) => ({
    ...fallback,
    fromName: mailbox.displayName || fallback.fromName || mailbox.email.split('@')[0],
    selfName: mailbox.displayName || fallback.selfName || mailbox.email.split('@')[0],
    email: mailbox.email,
    company: fallback.company || '运去哪（YQN）',
  }),
}));
vi.mock('../../src/main/services/agent/working-memory', () => ({ rememberWork: h.work, fingerprint: vi.fn() }));
vi.mock('../../src/main/services/agent/actions', () => ({ registerAction: (a: Omit<PendingAction, 'id'>) => { h.cards.push(a); return { kind: 'write', id: String(h.cards.length), label: a.label }; } }));
vi.mock('../../src/main/services/agent/toolkit/common', async original => ({ ...await original<typeof import('../../src/main/services/agent/toolkit/common')>(), gate: () => null, audit: h.audit }));

function fixture() {
  let active = true;
  let rows = [{ contactId: 701, customerId: 'customer-a', email: 'ana@example.invalid', firstName: 'Ana', companyName: 'Center Company', language: 'PT', canFollowup: true }] as CenterContact[];
  const port = { snapshot: () => ({ ok: true, data: { scope: 'A', active: () => active, contacts: rows } }), now: () => Date.now(), report: vi.fn() } as unknown as AgentContactPort;
  setAgentContactPort(port);
  h.enqueue.mockResolvedValue({ success: true, data: { queuedCount: 1, batchId: 'batch-123', dropped: 0 } });
  h.dynamic.mockReturnValue({ success: true, data: [{ subject: 'Hello', tplBody: 'Dear Ana' }] });
  h.prepared.mockImplementation(async (_input: unknown, items: unknown[], enqueue: (items: unknown[]) => Promise<unknown>) => enqueue(items));
  h.draft.mockResolvedValue({ success: true, data: 'SUBJECT: Hello\n\nDear Ana' });
  h.reply.mockResolvedValue({ success: true, data: 'SUBJECT: Hello\n\nReply' });
  h.preview.mockReturnValue({ success: true, data: { eligible: 1, excluded: 0, total: 1, sample: [{ id: 701, name: 'Ana' }], reachedReplied: 0 } });
  h.campaign.mockReturnValue({ success: true, data: { id: 'campaign-1', eligible: 1, excluded: 0 } });
  return { ctx: { conversationId: crypto.randomUUID(), push: vi.fn(), counts: new Map(), failures: new Map() }, switch: () => { active = false; }, revoke: () => { rows = rows.map(r => ({ ...r, canFollowup: false })); } };
}
afterEach(() => { setAgentContactPort(null); h.cards.length = 0; vi.resetAllMocks(); });
describe('AI center sending tools', () => {
  it('uses center profile and default language; draft card enqueues explicit refs once', async () => {
    const f = fixture();
    expect(JSON.parse(await execGenerateDraft(f.ctx, { contactId: 701 })).ok).toBe(true);
    expect(h.draft).toHaveBeenCalledWith(expect.objectContaining({ companyName: 'Center Company', contactName: 'Ana', language: 'PT' }));
    const action = h.cards.find(a => a.label.includes('入队'))!;
    expect((await action.run()).success).toBe(true);
    await execSendQueueAdd(f.ctx, { contactIds: [701], subject: 'Hello', body: 'Dear Ana' });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.dynamic).toHaveBeenCalledWith([701], 'Hello', 'Dear Ana', undefined, undefined, [{ contactId: 701, customerId: 'customer-a' }]);
    expect(h.enqueue).toHaveBeenCalledWith(expect.any(Array), false);
    expect(h.prepared).toHaveBeenCalledWith(expect.objectContaining({ centerContactRefs: [{ contactId: 701, customerId: 'customer-a' }], autoSend: false }), expect.any(Array), expect.any(Function));
    expect(h.db).not.toHaveBeenCalled();
  });
  it('drops generation and avoids new-account audit/memory after account switch', async () => {
    const f = fixture(); h.draft.mockImplementation(async () => { f.switch(); return { success: true, data: 'SUBJECT: Hello\n\nBody' }; });
    expect(JSON.parse(await execGenerateDraft(f.ctx, { contactId: 701 })).ok).toBe(false);
    expect(h.cards).toHaveLength(0); expect(h.work).not.toHaveBeenCalled(); expect(h.audit).not.toHaveBeenCalled();
  });
  it('rejects removed permission before executing a draft card', async () => {
    const f = fixture(); await execGenerateDraft(f.ctx, { contactId: 701 }); f.revoke();
    expect((await h.cards.find(a => a.label.includes('入队'))!.run()).success).toBe(false);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('does not partially enqueue or fall back to a legacy same-number contact', async () => {
    const f = fixture(); expect(JSON.parse(await execSendQueueAdd(f.ctx, { contactIds: [701, 999], subject: 'Hi', body: 'Body' })).ok).toBe(false);
    expect(h.enqueue).not.toHaveBeenCalled(); expect(h.db).not.toHaveBeenCalled();
  });
  it('preserves offline enqueue errors', async () => {
    const f = fixture(); h.enqueue.mockResolvedValue({ success: false, error: 'offline' });
    expect(JSON.parse(await execSendQueueAdd(f.ctx, { contactIds: [701], subject: 'Hi', body: 'Body' })).ok).toBe(false);
  });
  it('creates a center-reference campaign draft only after confirmation, without scanning or sending', async () => {
    const f = fixture(); const args = { contactIds: [701], touches: [{ stage: 'initial', delayDays: 0, mode: 'system' }] };
    expect(JSON.parse(await execCampaignCreate(f.ctx, args)).ok).toBe(true); expect(h.campaign).not.toHaveBeenCalled();
    expect((await h.cards[0]!.run()).success).toBe(true);
    await h.cards[0]!.run(); expect(h.campaign).toHaveBeenCalledTimes(1);
    expect(h.campaign).toHaveBeenCalledWith(expect.objectContaining({ startNow: false, centerContactRefs: [{ contactId: 701, customerId: 'customer-a' }] }));
    expect(h.scan).not.toHaveBeenCalled(); expect(h.db).not.toHaveBeenCalled();
  });
  it('matches replies by current authorized email, ignoring legacy matchedContactId', async () => {
    const f = fixture(); const row = { fromEmail: 'ana@example.invalid', fromName: 'Ana', subject: 'Checking in', matchedContactId: 9 };
    h.db.mockReturnValue({ select: () => ({ from: () => ({ where: () => ({ get: () => row }) }) }) });
    h.body.mockResolvedValue({ success: true, data: 'Hello, how are you?' });
    expect(JSON.parse(await execGenerateDraft(f.ctx, { messageId: 1 }))).toMatchObject({ ok: true, contactId: 701, subject: 'Re: Checking in' });
    expect((await h.cards.find(a => a.label.includes('入队'))!.run()).success).toBe(true);
    expect(h.dynamic.mock.calls[0]![0]).toEqual([701]);
  });
});
