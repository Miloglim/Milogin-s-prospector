import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureAgentRecipients, runAgentSendOnce } from '../../src/main/services/agent-send.service';
import { setAgentContactPort, type AgentContactPort } from '../../src/main/services/agent-contact.service';
import type { CenterContact } from '../../src/shared/online-crm';

function fixture() {
  let active = true;
  let scope = 'A';
  let rows = [{ contactId: 7, customerId: 'customer-a', email: 'a@example.invalid', canFollowup: true }] as CenterContact[];
  const port = { snapshot: () => ({ ok: true, data: { scope, active: () => active, contacts: rows } }), now: () => Date.now(), report: vi.fn() } as unknown as AgentContactPort;
  setAgentContactPort(port);
  return { capture: () => captureAgentRecipients({ contactIds: [7] }), switch: () => { active = false; scope = 'B'; }, changeEmail: () => { rows = rows.map(r => ({ ...r, email: 'b@example.invalid' })); }, revoke: () => { rows = rows.map(r => ({ ...r, canFollowup: false })); } };
}
afterEach(() => setAgentContactPort(null));
describe('AI center send scope', () => {
  it('allows shared mail without followup rights and blocks a missing or revoked send grant', () => {
    let row={contactId:7,customerId:'customer-a',email:'a@example.invalid',isShared:true,canFollowup:false,canSendMail:true} as CenterContact;
    setAgentContactPort({snapshot:()=>({ok:true,data:{scope:'shared',active:()=>true,contacts:[row]}})} as AgentContactPort);
    const result=captureAgentRecipients({contactId:7});
    expect(result.success).toBe(true);
    if(!result.success)throw Error(result.error);
    expect(result.data.validate().success).toBe(true);
    row={...row,canSendMail:false};
    expect(result.data.validate().success).toBe(false);
    row={...row,canSendMail:undefined,canFollowup:true};
    expect(result.data.validate().success).toBe(false);
  });
  it('freezes explicit refs and rejects any missing recipient', () => {
    const f = fixture(); const r = f.capture();
    expect(r).toMatchObject({ success: true, data: { refs: [{ contactId: 7, customerId: 'customer-a' }] } });
    expect(captureAgentRecipients({ contactIds: [7, 99] }).success).toBe(false);
  });
  it.each(['switch', 'changeEmail', 'revoke'] as const)('rejects stale actions after %s', async change => {
    const f = fixture(); const r = f.capture(); if (!r.success) throw Error(r.error);
    f[change](); const write = vi.fn(async () => ({ success: true as const, data: 'queued' }));
    expect((await runAgentSendOnce(r.data, 'chat', 'enqueue', {}, write)).success).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it('coalesces duplicates and reuses the same receipt', async () => {
    const f = fixture(); const r = f.capture(); if (!r.success) throw Error(r.error);
    const write = vi.fn(async () => ({ success: true as const, data: 'queued' }));
    await Promise.all(Array.from({ length: 4 }, () => runAgentSendOnce(r.data, 'chat', 'enqueue', { body: 'same' }, write)));
    await runAgentSendOnce(r.data, 'chat', 'enqueue', { body: 'same' }, write);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('discards delayed receipts after switching account', async () => {
    const f = fixture(); const r = f.capture(); if (!r.success) throw Error(r.error);
    expect((await runAgentSendOnce(r.data, 'chat', 'enqueue', {}, async () => { f.switch(); return { success: true, data: 'queued' }; })).success).toBe(false);
  });
  it('permits retry after an explicit failure but never automatically replays an exception', async () => {
    const f = fixture(); const r = f.capture(); if (!r.success) throw Error(r.error);
    const write = vi.fn().mockResolvedValueOnce({ success: false, error: 'offline' }).mockResolvedValue({ success: true, data: 'queued' });
    await runAgentSendOnce(r.data, 'chat', 'enqueue', {}, write);
    expect((await runAgentSendOnce(r.data, 'chat', 'enqueue', {}, write)).success).toBe(true);
    expect(write).toHaveBeenCalledTimes(2);
    const unknown = vi.fn(async () => { throw Error('unknown result'); });
    await runAgentSendOnce(r.data, 'chat', 'campaign', {}, unknown);
    await runAgentSendOnce(r.data, 'chat', 'campaign', {}, unknown);
    expect(unknown).toHaveBeenCalledTimes(1);
  });
});
