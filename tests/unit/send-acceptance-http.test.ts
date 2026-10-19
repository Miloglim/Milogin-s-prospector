import { createServer } from 'node:http';
import { describe, it, expect, vi } from 'vitest';
import { createSendAcceptanceHandler } from '../../server/transport/send-acceptance-http';
import { SEND_ACCEPTANCE_ROUTES } from '../../server/core/send-acceptance';
import { success } from '../../server/core/crm';
import { CONTACT_MAIL_LIMITS } from '../../server/core/contact-mail';

describe('send acceptance HTTP boundary', () => {
  it('accepts both maximum recipient envelopes when a prior IMAP fact accompanies the SMTP receipt',async()=>{
    const accept=vi.fn().mockResolvedValue(success({eventId:'maximum',duplicate:false,archivedAfterRevocation:true}));
    const server=createServer((req,res)=>{void createSendAcceptanceHandler({accept,authorize:vi.fn()})(req,res);});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('HTTP fixture failed to bind');
    const addresses=Array.from({length:CONTACT_MAIL_LIMITS.recipients},(_,index)=>'a'.repeat(CONTACT_MAIL_LIMITS.email-'@example.test'.length-String(CONTACT_MAIL_LIMITS.recipients).length)+String(index).padStart(String(CONTACT_MAIL_LIMITS.recipients).length,'0')+'@example.test');
    const event={contactId:1,customerId:'00000000-0000-4000-8000-000000000001',eventKey:'event',mailboxKey:'mailbox',messageKey:'message',kind:'sent',direction:'outbound',occurredAt:new Date().toISOString(),subject:'s'.repeat(CONTACT_MAIL_LIMITS.subject),preview:'p'.repeat(CONTACT_MAIL_LIMITS.preview),fromEmail:'sender@example.test',toEmails:addresses,ccEmails:addresses};
    const payload=JSON.stringify({authorizationId:'00000000-0000-4000-8000-000000000002',event,observedEvent:{...event,preview:'Prior IMAP'}});
    expect(Buffer.byteLength(payload)).toBeGreaterThan(CONTACT_MAIL_LIMITS.bodyBytes);
    try {
      const response=await fetch(`http://127.0.0.1:${address.port}`+SEND_ACCEPTANCE_ROUTES.accept,{method:'POST',headers:{authorization:`Bearer ${'a'.repeat(43)}`,'content-type':'application/json'},body:payload});
      expect(response.status).toBe(200);expect(accept).toHaveBeenCalledOnce();
    }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  });
  it('routes both mutations, preserves structured receipts and refuses missing sessions, queries and other methods', async () => {
    const service = { authorize: vi.fn().mockResolvedValue(success([])), accept: vi.fn().mockResolvedValue(success({ eventId: 'event', duplicate: false, archivedAfterRevocation: true })) };
    const handler = createSendAcceptanceHandler(service);
    const server = createServer((request, response) => { void handler(request, response); });
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('HTTP fixture failed to bind');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: `Bearer ${'a'.repeat(43)}`, 'content-type': 'application/json' };
    try {
      expect(await (await fetch(base + SEND_ACCEPTANCE_ROUTES.authorize, { method: 'POST', headers, body: '{}' })).json()).toEqual(success([]));
      expect(await (await fetch(base + SEND_ACCEPTANCE_ROUTES.accept, { method: 'POST', headers, body: '{}' })).json()).toEqual(success({ eventId: 'event', duplicate: false, archivedAfterRevocation: true }));
      const missingSession = await fetch(base + SEND_ACCEPTANCE_ROUTES.accept, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(missingSession.status).toBe(401);
      expect((await (await fetch(base + SEND_ACCEPTANCE_ROUTES.accept + '?bypass=1', { method: 'POST', headers, body: '{}' })).json()).error.code).toBe('INVALID_INPUT');
      expect((await fetch(base + SEND_ACCEPTANCE_ROUTES.accept, { headers })).status).toBe(404);
      expect(service.authorize).toHaveBeenCalledTimes(1);
      expect(service.accept).toHaveBeenCalledTimes(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve(); }); });
    }
  });
});
