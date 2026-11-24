import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { CENTER_CONTACT_ROUTE, centerContactQuery, type CenterContactPage } from '../../server/core/center-contacts';
import { success, type Result } from '../../server/core/crm';
import type { LeadService } from '../../server/services/leads';
import { createCrmHandler } from '../../server/transport/crm-http';

const TOKEN = 'a'.repeat(43);

describe('CRM contact HTTP attention query', () => {
  let server: Server;
  let base: string;
  let received: unknown;

  beforeEach(async () => {
    const handler = createCrmHandler({
      contacts: async (_token: string, input: unknown): Promise<Result<CenterContactPage>> => {
        received = input;
        const parsed = centerContactQuery(input);
        return parsed.ok ? success({ items: [], total: 0 }) : parsed;
      },
    } as unknown as LeadService);
    server = createServer((request, response) => { void handler(request, response); });
    server.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('parses attentionOnly as a boolean before contract validation', async () => {
    const response = await fetch(`${base}${CENTER_CONTACT_ROUTE}?search=&limit=50&offset=0&attentionOnly=true`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    expect(received).toMatchObject({ attentionOnly: true });
  });

  it('keeps followupOnly as a boolean compatibility alias', async () => {
    const response = await fetch(`${base}${CENTER_CONTACT_ROUTE}?search=&limit=50&offset=0&followupOnly=false`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(200);
    expect(received).toMatchObject({ followupOnly: false });
  });
});
