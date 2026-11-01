import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { success } from '../../server/core/crm';
import { teamMonitoringScopeFor, type TeamMonitoringRepository } from '../../server/core/team-monitoring';
import { createTeamMonitoringService } from '../../server/services/team-monitoring';
import { createTeamMonitoringHandler } from '../../server/transport/team-monitoring-http';
import type { TeamMonitoringService } from '../../server/services/team-monitoring';

const TOKEN = 't'.repeat(43);
const USER_ID = '00000000-0000-4000-8000-000000000001';
const TEAM_ID = '00000000-0000-4000-8000-000000000002';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000003';
const EVENT_ID = '00000000-0000-4000-8000-000000000004';

function repository() {
  return {
    overview: vi.fn(async () => success({} as never)),
    member: vi.fn(async () => success({} as never)),
    contact: vi.fn(async () => success({} as never)),
    mail: vi.fn(async () => success({} as never)),
  } satisfies TeamMonitoringRepository;
}

describe('CP6 team monitoring contract', () => {
  it('resolves only monitoring roles and treats identity admins as superadmins', () => {
    expect(teamMonitoringScopeFor({ identityAdmin: true, roles: [] })).toBe('superadmin');
    expect(teamMonitoringScopeFor({ identityAdmin: false, roles: ['admin'] })).toBe('superadmin');
    expect(teamMonitoringScopeFor({ identityAdmin: false, roles: ['operations'] })).toBe('operations');
    expect(teamMonitoringScopeFor({ identityAdmin: false, roles: ['sales'] })).toBe('leader');
    expect(teamMonitoringScopeFor({ identityAdmin: false, roles: ['auditor'] })).toBeNull();
  });

  it('validates bounded queries before calling the repository', async () => {
    const repo = repository();
    const service = createTeamMonitoringService(repo, { hash: value => value.padEnd(64, '0'), create: () => TOKEN });

    expect(await service.overview(TOKEN, { teamId: TEAM_ID, limit: 101, offset: 0, unitLimit: 25, unitOffset: 0 }))
      .toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await service.member(TOKEN, 'not-a-uuid', { limit: 20, offset: 0 }))
      .toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await service.contact(TOKEN, '0', { customerId: CUSTOMER_ID, limit: 20, offset: 0 }))
      .toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await service.mail(TOKEN, EVENT_ID, { contactId: 1, customerId: 'bad', extra: true }))
      .toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(repo.overview).not.toHaveBeenCalled();
    expect(repo.member).not.toHaveBeenCalled();
    expect(repo.contact).not.toHaveBeenCalled();
    expect(repo.mail).not.toHaveBeenCalled();
  });

  it('passes only server-derived scope inputs and bounded pagination', async () => {
    const repo = repository();
    const service = createTeamMonitoringService(repo, { hash: value => value.padEnd(64, '0'), create: () => TOKEN });
    await service.overview(TOKEN, { teamId: TEAM_ID, memberUserId: USER_ID, limit: 10, offset: 20, unitLimit: 5, unitOffset: 10 });
    expect(repo.overview).toHaveBeenCalledWith(TOKEN.padEnd(64, '0'), {
      teamId: TEAM_ID, memberUserId: USER_ID, limit: 10, offset: 20, unitLimit: 5, unitOffset: 10,
    });
    await service.member(TOKEN, USER_ID, { limit: 10, offset: 0 });
    expect(repo.member).toHaveBeenCalledWith(TOKEN.padEnd(64, '0'), USER_ID, 10, 0);
    await service.contact(TOKEN, '42', { customerId: CUSTOMER_ID, limit: 10, offset: 0 });
    expect(repo.contact).toHaveBeenCalledWith(TOKEN.padEnd(64, '0'), 42, CUSTOMER_ID, 10, 0);
    await service.mail(TOKEN, EVENT_ID, { contactId: 42, customerId: CUSTOMER_ID });
    expect(repo.mail).toHaveBeenCalledWith(TOKEN.padEnd(64, '0'), EVENT_ID, 42, CUSTOMER_ID);
  });
});

describe('CP6 team monitoring HTTP routes', () => {
  let server: Server;
  let base: string;
  let service: { overview: ReturnType<typeof vi.fn>; member: ReturnType<typeof vi.fn>; contact: ReturnType<typeof vi.fn>; mail: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    service = {
      overview: vi.fn(async () => success({} as never)),
      member: vi.fn(async () => success({} as never)),
      contact: vi.fn(async () => success({} as never)),
      mail: vi.fn(async () => success({} as never)),
    };
    const handler = createTeamMonitoringHandler(service as unknown as TeamMonitoringService);
    server = createServer((request, response) => { void handler(request, response); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('routes bounded overview, member, contact and mail drilldowns', async () => {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    await fetch(`${base}/api/crm/team-monitoring?teamId=${TEAM_ID}&limit=10&offset=0&unitLimit=5&unitOffset=0`, { headers });
    expect(service.overview).toHaveBeenCalledWith(TOKEN, { teamId: TEAM_ID, limit: 10, offset: 0, unitLimit: 5, unitOffset: 0 });
    await fetch(`${base}/api/crm/team-monitoring/members/${USER_ID}?limit=10&offset=2`, { headers });
    expect(service.member).toHaveBeenCalledWith(TOKEN, USER_ID, { limit: 10, offset: 2 });
    await fetch(`${base}/api/crm/team-monitoring/contacts/42?customerId=${CUSTOMER_ID}&limit=10&offset=0`, { headers });
    expect(service.contact).toHaveBeenCalledWith(TOKEN, '42', { customerId: CUSTOMER_ID, limit: 10, offset: 0 });
    await fetch(`${base}/api/crm/team-monitoring/mail/${EVENT_ID}?contactId=42&customerId=${CUSTOMER_ID}`, { headers });
    expect(service.mail).toHaveBeenCalledWith(TOKEN, EVENT_ID, { contactId: 42, customerId: CUSTOMER_ID });
  });

  it('rejects duplicate query parameters before the service sees them', async () => {
    const response = await fetch(`${base}/api/crm/team-monitoring?limit=10&limit=20`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(response.status).toBe(400);
    expect(service.overview).not.toHaveBeenCalled();
  });
});
