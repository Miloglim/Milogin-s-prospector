import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createTeamHandler } from '../../server/transport/team-http';
import type { TeamService } from '../../server/services/teams';
import { createTeamService } from '../../server/services/teams';
import type { TeamRepository } from '../../server/core/teams';

const TOKEN = 'a'.repeat(43);
const TEAM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVITATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('team HTTP contract', () => {
  let server: Server;
  let base: string;
  let service: {
    context: ReturnType<typeof vi.fn>;
    detail: ReturnType<typeof vi.fn>;
    candidates: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    invite: ReturnType<typeof vi.fn>;
    decide: ReturnType<typeof vi.fn>;
    move: ReturnType<typeof vi.fn>;
    dissolve: ReturnType<typeof vi.fn>;
    assignLeader: ReturnType<typeof vi.fn>;
    adjustMember: ReturnType<typeof vi.fn>;
    saveMemberGroup: ReturnType<typeof vi.fn>;
    deleteMemberGroup: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    service = {
      context: vi.fn(async () => ({ ok: true, data: {} })),
      detail: vi.fn(async () => ({ ok: true, data: {} })),
      candidates: vi.fn(async () => ({ ok: true, data: {} })),
      create: vi.fn(async () => ({ ok: true, data: {} })),
      invite: vi.fn(async () => ({ ok: true, data: {} })),
      decide: vi.fn(async () => ({ ok: true, data: {} })),
      move: vi.fn(async () => ({ ok: true, data: {} })),
      dissolve: vi.fn(async () => ({ ok: true, data: {} })),
      assignLeader: vi.fn(async () => ({ ok: true, data: {} })),
      adjustMember: vi.fn(async () => ({ ok: true, data: {} })),
      saveMemberGroup: vi.fn(async () => ({ ok: true, data: {} })),
      deleteMemberGroup: vi.fn(async () => ({ ok: true, data: {} })),
    };
    const handler = createTeamHandler(service as unknown as TeamService);
    server = createServer((request, response) => { void handler(request, response); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('routes context and bounded candidate queries to the service', async () => {
    await fetch(`${base}/api/crm/team-context`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(service.context).toHaveBeenCalledWith(TOKEN);
    await fetch(`${base}/api/crm/team-invite-candidates?search=wang&limit=25&offset=50&role=leader&unitType=operations`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(service.candidates).toHaveBeenCalledWith(TOKEN, { search: 'wang', limit: 25, offset: 50, role: 'leader', unitType: 'operations' });
    await fetch(`${base}/api/crm/teams/${TEAM_ID}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(service.detail).toHaveBeenCalledWith(TOKEN, TEAM_ID);
  });

  it('routes create, invite and decision bodies without changing their contracts', async () => {
    const create = { name: 'East Team', parentTeamId: null, inviteeUserIds: [], idempotencyKey: 'create-key' };
    await fetch(`${base}/api/crm/teams`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(create) });
    expect(service.create).toHaveBeenCalledWith(TOKEN, create);

    const invite = { userIds: [INVITATION_ID], idempotencyKey: 'invite-key' };
    await fetch(`${base}/api/crm/teams/${TEAM_ID}/invitations`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(invite) });
    expect(service.invite).toHaveBeenCalledWith(TOKEN, TEAM_ID, invite);

    const decision = { expectedVersion: 1, idempotencyKey: 'decision-key' };
    await fetch(`${base}/api/crm/team-invitations/${INVITATION_ID}/accept`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(decision) });
    expect(service.decide).toHaveBeenCalledWith(TOKEN, INVITATION_ID, 'accept', decision);
  });

  it('rejects manager-only organization creation without an explicit leader before the repository', async () => {
    const repo = { create: vi.fn() } as unknown as TeamRepository;
    const strictHandler = createTeamHandler(createTeamService(repo, { hash: () => 'hashed-token' }));
    const strictServer = createServer((request, response) => { void strictHandler(request, response); });
    strictServer.listen(0, '127.0.0.1');
    await once(strictServer, 'listening');
    const strictBase = `http://127.0.0.1:${(strictServer.address() as { port: number }).port}`;
    try {
      const response = await fetch(`${strictBase}/api/crm/teams`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '运营组', parentTeamId: null, unitType: 'operations', inviteeUserIds: [], idempotencyKey: 'operations-key' }),
      });
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(repo.create).not.toHaveBeenCalled();
    } finally {
      strictServer.closeAllConnections();
      await new Promise<void>(resolve => strictServer.close(() => resolve()));
    }
  });

  it('validates candidate role and unit combinations before touching the repository', async () => {
    const candidates = vi.fn(async () => ({ ok: true, data: { items: [], total: 0 } }));
    const repo = { candidates } as unknown as TeamRepository;
    const strictHandler = createTeamHandler(createTeamService(repo, { hash: () => 'hashed-token' }));
    const strictServer = createServer((request, response) => { void strictHandler(request, response); });
    strictServer.listen(0, '127.0.0.1');
    await once(strictServer, 'listening');
    const strictBase = `http://127.0.0.1:${(strictServer.address() as { port: number }).port}`;
    const headers = { Authorization: `Bearer ${TOKEN}` };
    try {
      const memberOperations = await fetch(`${strictBase}/api/crm/team-invite-candidates?role=member&unitType=operations`, { headers });
      expect(await memberOperations.json()).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      const unknownRole = await fetch(`${strictBase}/api/crm/team-invite-candidates?role=boss&unitType=sales_team`, { headers });
      expect(await unknownRole.json()).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      const createPurpose = await fetch(`${strictBase}/api/crm/team-invite-candidates?search=first&limit=20&offset=0&role=member&unitType=sales_team&purpose=create`, { headers });
      expect(await createPurpose.json()).toMatchObject({ ok: true });
      expect(candidates).toHaveBeenCalledWith('hashed-token', { search: 'first', limit: 20, offset: 0, role: 'member', unitType: 'sales_team', purpose: 'create' });
    } finally {
      strictServer.closeAllConnections();
      await new Promise<void>(resolve => strictServer.close(() => resolve()));
    }
  });

  it('routes canonical organization mutations without widening the API', async () => {
    const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    const move = { parentTeamId: null, expectedVersion: 2, idempotencyKey: 'move-key' };
    await fetch(`${base}/api/crm/teams/${TEAM_ID}/move`, { method: 'POST', headers, body: JSON.stringify(move) });
    expect(service.move).toHaveBeenCalledWith(TOKEN, TEAM_ID, move);

    const dissolve = { expectedVersion: 2, idempotencyKey: 'dissolve-key' };
    await fetch(`${base}/api/crm/teams/${TEAM_ID}/dissolve`, { method: 'POST', headers, body: JSON.stringify(dissolve) });
    expect(service.dissolve).toHaveBeenCalledWith(TOKEN, TEAM_ID, dissolve);

    const leader = { leaderUserId: INVITATION_ID, expectedVersion: 2, idempotencyKey: 'leader-key' };
    await fetch(`${base}/api/crm/teams/${TEAM_ID}/leader`, { method: 'POST', headers, body: JSON.stringify(leader) });
    expect(service.assignLeader).toHaveBeenCalledWith(TOKEN, TEAM_ID, leader);

    const member = { userId: INVITATION_ID, action: 'remove', expectedVersion: 2, idempotencyKey: 'member-key' };
    await fetch(`${base}/api/crm/teams/${TEAM_ID}/members`, { method: 'POST', headers, body: JSON.stringify(member) });
    expect(service.adjustMember).toHaveBeenCalledWith(TOKEN, TEAM_ID, member);

    const group = { groupId: null, name: '华东', memberIds: [], expectedVersion: 0, idempotencyKey: 'group-key' };
    await fetch(`${base}/api/crm/teams/${TEAM_ID}/groups`, { method: 'POST', headers, body: JSON.stringify(group) });
    expect(service.saveMemberGroup).toHaveBeenCalledWith(TOKEN, TEAM_ID, group);

    const removal = { groupId: INVITATION_ID, expectedVersion: 1, idempotencyKey: 'group-delete-key' };
    await fetch(`${base}/api/crm/teams/${TEAM_ID}/groups/${INVITATION_ID}/delete`, { method: 'POST', headers, body: JSON.stringify(removal) });
    expect(service.deleteMemberGroup).toHaveBeenCalledWith(TOKEN, TEAM_ID, INVITATION_ID, removal);
  });

  it('preserves the repository conflict for an illegal member-to-leader assignment', async () => {
    service.assignLeader.mockResolvedValueOnce({ ok: false, error: { code: 'CONFLICT', message: '普通成员不能同时担任负责人' } });
    const response = await fetch(`${base}/api/crm/teams/${TEAM_ID}/leader`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ leaderUserId: INVITATION_ID, expectedVersion: 2, idempotencyKey: 'conflict-key' }),
    });
    expect(await response.json()).toEqual({ ok: false, error: { code: 'CONFLICT', message: '普通成员不能同时担任负责人' } });
  });
});
