import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Pool, type PoolClient } from 'pg';
import { readTestDatabaseConfig } from '../../server/adapters/postgres/config';
import { PostgresTeamRepository } from '../../server/adapters/postgres/team-repository';
import { PostgresCrmRepository } from '../../server/adapters/postgres/repository';
import { PostgresAuthRepository } from '../../server/adapters/postgres/auth-repository';
import { PostgresAdminRepository } from '../../server/adapters/postgres/admin-repository';
import { PostgresLeadRepository } from '../../server/adapters/postgres/lead-repository';
import { PostgresNotificationRepository } from '../../server/adapters/postgres/notification-repository';
import { createTeamService } from '../../server/services/teams';
import { capabilitiesFor } from '../../server/core/admin';
import type { CrmRole } from '../../server/core/auth';
import type { Result } from '../../server/core/crm';
import { createContactAssignmentsIn } from '../../server/adapters/postgres/contact-assignment-repository';
import { createTeamHandler } from '../../server/transport/team-http';

const enabled = process.env.PROSPECTOR_TEAM_TEST === '1';
const log = { write: (level: string, context: string, message: string) => { if (process.env.PROSPECTOR_TEAM_DEBUG === '1') console.error(`[${level}] [${context}] ${message}`); } };
const tokens = { hash: (token: string) => createHash('sha256').update(token).digest('hex') };
function unwrap<T>(result: Result<T>): T { if (!result.ok) throw Error(`${result.error.code}: ${result.error.message}`); return result.data; }

type User = { id: string; token: string; roles: CrmRole[] };

describe.skipIf(!enabled)('canonical organization PostgreSQL rollback-only', () => {
  let pool: Pool;
  let client: PoolClient;
  let repo: PostgresTeamRepository;
  let service: ReturnType<typeof createTeamService>;

  async function mirrorLegacyIdentity(id: string, name: string, admin = false) {
    if (!(await client.query("SELECT to_regclass('identity.users') AS name")).rows[0].name) return;
    await client.query('INSERT INTO identity.users(user_id,display_name,active,identity_admin) VALUES($1,$2,true,$3) ON CONFLICT DO NOTHING', [id, name, admin]);
  }

  async function userWithRoles(roles: CrmRole[], name: string): Promise<User> {
    const id = randomUUID();
    const token = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
    const scope = roles.includes('operations') ? 'shared' : roles.includes('admin') ? 'summary' : 'own';
    await client.query('INSERT INTO public.identity_users(user_id,display_name,active) VALUES($1,$2,true)', [id, name]);
    await mirrorLegacyIdentity(id, name);
    await client.query('INSERT INTO public.identity_login_emails(user_id,email,verified_at) VALUES($1,$2,now())', [id, `${id}@example.invalid`]);
    for (const role of roles) await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)", [id, role]);
    await client.query("INSERT INTO public.identity_product_access(user_id,product_id,scope,capabilities) VALUES($1,'crm',$2,$3)", [id, scope, JSON.stringify(capabilitiesFor(roles))]);
    await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) SELECT $1,user_id,security_revision,now()+interval '1 hour','api' FROM public.identity_users WHERE user_id=$2", [tokens.hash(token), id]);
    return { id, token, roles };
  }

  async function user(role: CrmRole, name: string): Promise<User> {
    return userWithRoles([role], name);
  }

  async function identityAdmin(name: string): Promise<User> {
    const id = randomUUID();
    const token = Buffer.from(randomUUID() + randomUUID()).toString('base64url').slice(0, 43);
    await client.query('INSERT INTO public.identity_users(user_id,display_name,identity_admin,active) VALUES($1,$2,true,true)', [id, name]);
    await mirrorLegacyIdentity(id, name, true);
    await client.query('INSERT INTO public.identity_login_emails(user_id,email,verified_at) VALUES($1,$2,now())', [id, `${id}@example.invalid`]);
    await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) SELECT $1,user_id,security_revision,now()+interval '1 hour','api' FROM public.identity_users WHERE user_id=$2", [tokens.hash(token), id]);
    return { id, token, roles: [] };
  }

  async function resetCanonicalSchema() {
    await client.query('DROP TABLE crm_org_dissolution_audits,crm_org_member_group_members,crm_org_member_groups,crm_org_idempotency,crm_org_invitations,crm_org_assignments,crm_org_units CASCADE');
    await client.query('DROP FUNCTION crm_reject_org_dissolution_audit_change()');
    await client.query('DROP FUNCTION crm_validate_org_assignment()');
    await client.query('DROP FUNCTION crm_validate_org_unit_hierarchy()');
    await client.query('ALTER TABLE crm_contact_assignment_requests DROP COLUMN source_org_unit_id');
    await client.query("DELETE FROM crm_schema_migrations WHERE version IN ('055-organization-canonical','056-organization-assignment-integrity','064-organization-dissolution')");
  }

  async function createOperationsGroup(operations: User, leader?: User) {
    return unwrap(await service.create(operations.token, {
      name: `Operations ${randomUUID().slice(0, 8)}`,
      parentTeamId: null,
      unitType: 'operations',
      leaderUserId: (leader ?? operations).id,
      inviteeUserIds: [],
      idempotencyKey: randomUUID(),
    }));
  }

  async function createSalesTeam(_operations: User, leader: User, _parentTeamId: string | null = null, invitees: string[] = [], idempotencyKey = randomUUID(), name = `Sales ${randomUUID().slice(0, 8)}`) {
    return unwrap(await service.create(leader.token, {
      name,
      parentTeamId: null,
      unitType: 'sales_team',
      leaderUserId: undefined,
      inviteeUserIds: invitees,
      idempotencyKey,
    }));
  }

  async function rejectedDatabaseWrite(sql: string, params: unknown[]): Promise<string> {
    await client.query('SAVEPOINT rejected_assignment');
    try {
      await client.query(sql, params);
      return '';
    } catch (error) {
      return String((error as { code?: string }).code ?? '');
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT rejected_assignment');
      await client.query('RELEASE SAVEPOINT rejected_assignment');
    }
  }

  beforeEach(async () => {
    pool = new Pool(readTestDatabaseConfig());
    unwrap(await new PostgresCrmRepository(pool, log).migrate());
    unwrap(await new PostgresAuthRepository(pool, log).migrate());
    unwrap(await new PostgresAdminRepository(pool, log).migrate());
    const leadSchema = (await pool.query("SELECT to_regclass('crm_customers') AS customers,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='identity_outbox' AND column_name='customer_id') AS customer_column")).rows[0];
    if (!leadSchema.customers) {
      unwrap(await new PostgresLeadRepository(pool, log).migrate());
      unwrap(await new PostgresNotificationRepository(pool, log).migrate());
    } else if (!leadSchema.customer_column) {
      await pool.query('ALTER TABLE public.identity_outbox ADD COLUMN IF NOT EXISTS customer_id uuid');
    }
    await pool.query('ALTER TABLE public.identity_outbox ADD COLUMN IF NOT EXISTS recipient_user_ids uuid[]');
    await pool.query('ALTER TABLE public.identity_outbox ADD COLUMN IF NOT EXISTS payload jsonb');
    client = await pool.connect();
    await client.query('BEGIN');
    const wrapped = {
      options: pool.options,
      connect: async () => ({
        release: () => {},
        query: async (sql: string, params?: unknown[]) => {
          if (sql === 'BEGIN') return client.query('SAVEPOINT team_operation');
          if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT team_operation');
          if (sql === 'ROLLBACK') {
            await client.query('ROLLBACK TO SAVEPOINT team_operation');
            return client.query('RELEASE SAVEPOINT team_operation');
          }
          return client.query(sql, params);
        },
      }),
    } as unknown as Pool;
    repo = new PostgresTeamRepository(wrapped, log);
    service = createTeamService(repo, tokens as never);
    unwrap(await repo.migrate());
    unwrap(await repo.migrate());
  });

  afterEach(async () => {
    if (client) { await client.query('ROLLBACK'); client.release(); }
    if (pool) await pool.end();
  });

  it('migrates legacy teams once, keeps one company root and rolls the whole schema test back', async () => {
    const counts = (await client.query(`SELECT
      (SELECT count(*)::int FROM crm_org_units WHERE kind='company') AS companies,
      (SELECT count(*)::int FROM crm_schema_migrations WHERE version='055-organization-canonical') AS migrations,
      (SELECT count(*)::int FROM crm_schema_migrations WHERE version='056-organization-assignment-integrity') AS integrity`)).rows[0];
    expect(counts).toEqual({ companies: 1, migrations: 1, integrity: 1 });

    await client.query('DROP TABLE crm_org_member_group_members,crm_org_member_groups,crm_org_idempotency,crm_org_invitations,crm_org_assignments,crm_org_units CASCADE');
    await client.query('DROP FUNCTION crm_validate_org_assignment()');
    await client.query('DROP FUNCTION crm_validate_org_unit_hierarchy()');
    await client.query('ALTER TABLE crm_contact_assignment_requests DROP COLUMN source_org_unit_id');
    await client.query("DELETE FROM crm_schema_migrations WHERE version IN ('055-organization-canonical','056-organization-assignment-integrity')");

    const creator = await user('operations', 'Legacy Creator');
    const leader = await user('sales', 'Legacy Leader');
    const member = await user('sales', 'Legacy Member');
    const operationsTeamId = randomUUID();
    const salesTeamId = randomUUID();
    const groupId = randomUUID();
    const invitationId = randomUUID();
    await client.query('ALTER TABLE crm_teams ALTER CONSTRAINT crm_teams_parent_team_id_fkey DEFERRABLE INITIALLY DEFERRED');
    // Insert the child before its parent to prove migration order comes from the hierarchy, not insertion order.
    await client.query("INSERT INTO crm_teams(team_id,name,unit_type,parent_team_id,leader_user_id,created_by) VALUES($1,'Legacy Sales','sales_team',$2,$3,$4)", [salesTeamId, operationsTeamId, leader.id, creator.id]);
    await client.query("INSERT INTO crm_teams(team_id,name,unit_type,leader_user_id,created_by) VALUES($1,'Legacy Ops','operations',$2,$3)", [operationsTeamId, creator.id, creator.id]);
    await client.query("INSERT INTO crm_team_members(team_id,user_id,role) VALUES($1,$2,'member')", [salesTeamId, member.id]);
    await client.query("INSERT INTO crm_team_invitations(invitation_id,team_id,inviter_user_id,invitee_user_id) VALUES($1,$2,$3,$4)", [invitationId, salesTeamId, leader.id, member.id]);
    await client.query("INSERT INTO crm_team_member_groups(group_id,team_id,name) VALUES($1,$2,'Legacy Group')", [groupId, salesTeamId]);
    await client.query('INSERT INTO crm_team_member_group_members(group_id,team_id,user_id) VALUES($1,$2,$3)', [groupId, salesTeamId, member.id]);

    unwrap(await repo.migrate());
    unwrap(await repo.migrate());
    const migrated = (await client.query(`SELECT
      (SELECT count(*)::int FROM crm_org_units WHERE kind='company') AS companies,
      (SELECT parent_unit_id FROM crm_org_units WHERE unit_id=$1) AS "salesParent",
      (SELECT count(*)::int FROM crm_org_assignments WHERE unit_id=$1 AND user_id=$2 AND role='leader') AS leaders,
      (SELECT count(*)::int FROM crm_org_assignments WHERE unit_id=$1 AND user_id=$3 AND role='member') AS members,
      (SELECT count(*)::int FROM crm_org_invitations WHERE invitation_id=$4) AS invitations,
      (SELECT count(*)::int FROM crm_org_member_group_members WHERE group_id=$5) AS grouped`, [salesTeamId, leader.id, member.id, invitationId, groupId])).rows[0];
    expect(migrated).toEqual({ companies: 1, salesParent: operationsTeamId, leaders: 1, members: 1, invitations: 1, grouped: 1 });
  });

  it('rejects unsupported legacy hierarchy and rolls the 055 migration back completely', async () => {
    await resetCanonicalSchema();
    const creator = await user('operations', 'Unsupported Creator');
    const rootLeader = await user('sales', 'Unsupported Root Leader');
    const childLeader = await user('sales', 'Unsupported Child Leader');
    const rootId = randomUUID();
    const childId = randomUUID();
    await client.query("INSERT INTO crm_teams(team_id,name,unit_type,leader_user_id,created_by) VALUES($1,'Unsupported Root','sales_team',$2,$3)", [rootId, rootLeader.id, creator.id]);
    await client.query("INSERT INTO crm_teams(team_id,name,unit_type,parent_team_id,leader_user_id,created_by) VALUES($1,'Unsupported Child','sales_team',$2,$3,$4)", [childId, rootId, childLeader.id, creator.id]);

    expect(await repo.migrate()).toMatchObject({ ok: false, error: { code: 'DATABASE_ERROR' } });
    const state = (await client.query(`SELECT
      to_regclass('crm_org_units') AS units,
      EXISTS(SELECT 1 FROM crm_schema_migrations WHERE version='055-organization-canonical') AS recorded`)).rows[0];
    expect(state).toEqual({ units: null, recorded: false });
  });

  it('enforces hierarchy and leaf rules and rejects cycles', async () => {
    const operations = await user('operations', 'Hierarchy Operations');
    const leader = await user('sales', 'Hierarchy Leader');
    const ops = await createOperationsGroup(operations);
    const team = await createSalesTeam(operations, leader, ops.teamId);

    expect(await service.create(operations.token, {
      name: `Missing Leader ${randomUUID().slice(0, 8)}`, parentTeamId: ops.teamId, unitType: 'sales_team', inviteeUserIds: [], idempotencyKey: randomUUID(),
    })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await service.create(operations.token, {
      name: `Nested ${randomUUID().slice(0, 8)}`, parentTeamId: team.teamId, unitType: 'sales_team', leaderUserId: leader.id, inviteeUserIds: [], idempotencyKey: randomUUID(),
    })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await service.move(operations.token, ops.teamId, { parentTeamId: team.teamId, expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await service.move(operations.token, ops.teamId, { parentTeamId: ops.teamId, expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect((await client.query("SELECT count(*)::int AS count FROM crm_org_assignments WHERE unit_id=$1 AND role='member'", [ops.teamId])).rows[0].count).toBe(0);
  });

  it('opens team context to every active CRM account without granting creation', async () => {
    const auditor = await user('auditor', 'Team Auditor');
    const context = unwrap(await service.context(auditor.token));
    expect(context.team).toBeNull();
    expect(context.canCreate).toBe(false);
    expect(context.canAdmin).toBe(false);
    expect(context.incomingInvitations).toEqual([]);
  });

  it('lets a team member read the own-team roster for collaboration', async () => {
    const leader = await user('sales', 'Roster Leader');
    const first = await user('sales', 'Roster First');
    const second = await user('sales', 'Roster Second');
    const created = await createSalesTeam(leader, leader, null, [first.id, second.id]);
    for (const invitee of [first, second]) {
      const invitation = unwrap(await service.context(invitee.token)).incomingInvitations.find(item => item.teamId === created.teamId)!;
      unwrap(await service.decide(invitee.token, invitation.invitationId, 'accept', { expectedVersion: invitation.version, idempotencyKey: randomUUID() }));
    }
    const context = unwrap(await service.context(first.token));
    expect(context.team?.members.map(item => item.userId)).toEqual(expect.arrayContaining([leader.id, first.id, second.id]));
    const detail = unwrap(await service.detail(first.token, created.teamId));
    expect(detail.team.members.map(item => item.userId)).toEqual(expect.arrayContaining([leader.id, first.id, second.id]));
    expect(detail.children).toEqual([]);
  });

  it('turns member additions into invitations and lets ordinary members leave', async () => {
    const leader = await user('sales', 'Consent Leader');
    const member = await user('sales', 'Consent Member');
    const created = await createSalesTeam(leader, leader);
    const invited = unwrap(await service.adjustMember(leader.token, created.teamId, { userId: member.id, action: 'add', expectedVersion: 1, idempotencyKey: randomUUID() }));
    expect((await client.query("SELECT count(*)::int AS count FROM crm_org_assignments WHERE unit_id=$1 AND user_id=$2 AND ended_at IS NULL", [created.teamId, member.id])).rows[0].count).toBe(0);
    const invitation = invited.outgoingInvitations.find(item => item.inviteeUserId === member.id)!;
    unwrap(await service.decide(member.token, invitation.invitationId, 'accept', { expectedVersion: invitation.version, idempotencyKey: randomUUID() }));
    expect(unwrap(await service.context(member.token)).team?.teamId).toBe(created.teamId);
    const left = unwrap(await service.adjustMember(member.token, created.teamId, { userId: member.id, action: 'leave', expectedVersion: 1, idempotencyKey: randomUUID() }));
    expect(left.team).toBeNull();
    expect((await client.query("SELECT count(*)::int AS count FROM crm_org_assignments WHERE unit_id=$1 AND user_id=$2 AND ended_at IS NULL", [created.teamId, member.id])).rows[0].count).toBe(0);
  });

  it('shows sales-team membership for leaders and members in the assignment directory', async () => {
    const operations = await user('operations', 'Directory Operations');
    const leader = await user('sales', 'Directory Leader');
    const member = await user('sales', 'Directory Member');
    const teamName = `Directory Team ${randomUUID().slice(0, 8)}`;
    const created = await createSalesTeam(operations, leader, null, [member.id], randomUUID(), teamName);
    const invitation = unwrap(await service.context(member.token)).incomingInvitations.find(item => item.teamId === created.teamId)!;
    unwrap(await service.decide(member.token, invitation.invitationId, 'accept', { expectedVersion: invitation.version, idempotencyKey: randomUUID() }));
    const leads = new PostgresLeadRepository(pool, log);
    const rows = await (leads as unknown as { memberRows(client: PoolClient): Promise<Array<{ userId: string; teamNames: string[]; supervisorNames: string[] }>> }).memberRows(client);
    const leaderRow = rows.find(item => item.userId === leader.id)!;
    const memberRow = rows.find(item => item.userId === member.id)!;
    expect(leaderRow.teamNames).toContain(teamName);
    expect(memberRow.teamNames).toContain(teamName);
    expect(memberRow.supervisorNames).toContain('Directory Leader');
  });

  it('shares the own-team roster for collaboration but denies enumeration and management', async () => {
    const operations = await user('operations', 'Privacy Operations');
    const leader = await user('sales', 'Privacy Leader');
    const member = await user('sales', 'Privacy Member');
    const teammate = await user('sales', 'Privacy Teammate');
    const outsider = await user('sales', 'Privacy Outsider');
    const creator = await user('sales', 'Privacy Creator');
    const ops = await createOperationsGroup(operations);
    const createCandidates = unwrap(await service.candidates(creator.token, { search: 'Privacy', limit: 20, offset: 0, purpose: 'create' }));
    expect(createCandidates.items.map(item => item.userId)).toEqual(expect.arrayContaining([member.id, teammate.id, outsider.id]));
    const createKey = randomUUID();
    const teamName = `Privacy Sales ${randomUUID().slice(0, 8)}`;
    const created = await createSalesTeam(operations, leader, ops.teamId, [member.id, teammate.id], createKey, teamName);
    expect((await createSalesTeam(operations, leader, ops.teamId, [member.id, teammate.id], createKey, teamName)).teamId).toBe(created.teamId);
    const other = await createSalesTeam(operations, outsider, ops.teamId);
    for (const invitee of [member, teammate]) {
      const invitation = unwrap(await service.context(invitee.token)).incomingInvitations.find(item => item.teamId === created.teamId)!;
      unwrap(await service.decide(invitee.token, invitation.invitationId, 'accept', { expectedVersion: invitation.version, idempotencyKey: randomUUID() }));
    }
    expect((await client.query('SELECT count(*)::int AS count FROM crm_org_idempotency WHERE actor_id=$1 AND idempotency_key=$2', [operations.id, createKey])).rows[0].count).toBe(1);
    expect((await client.query('SELECT count(*)::int AS count FROM crm_team_idempotency WHERE actor_id=$1 AND idempotency_key=$2', [operations.id, createKey])).rows[0].count).toBe(0);

    const context = unwrap(await service.context(member.token));
    expect(context.team?.members.map(item => item.userId)).toEqual(expect.arrayContaining([leader.id, member.id, teammate.id]));
    expect(context.team?.memberCount).toBe(3);
    expect(context.outgoingInvitations).toEqual([]);
    expect(context.managedTeams).toEqual([]);
    expect(context.organization?.visibleUnits.map(unit => unit.unitId)).toEqual([created.teamId]);
    expect((await service.detail(member.token, created.teamId)).ok && unwrap(await service.detail(member.token, created.teamId)).team.members.map(item => item.userId)).toEqual(expect.arrayContaining([leader.id, member.id, teammate.id]));
    expect(await service.detail(member.token, other.teamId)).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(await service.candidates(member.token, { search: '', limit: 20, offset: 0 })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(unwrap(await service.context(leader.token)).team?.members.map(item => item.userId)).toEqual(expect.arrayContaining([leader.id, member.id, teammate.id]));
  });

  it('uses canonical organization membership to notify the direct leader during contact assignment', async () => {
    const operations = await user('operations', 'Assignment Operations');
    const leader = await user('sales', 'Assignment Leader');
    const member = await user('sales', 'Assignment Member');
    const ops = await createOperationsGroup(operations);
    const team = await createSalesTeam(operations, leader, ops.teamId, [member.id]);
    const invitation = unwrap(await service.context(member.token)).incomingInvitations.find(item => item.teamId === team.teamId)!;
    unwrap(await service.decide(member.token, invitation.invitationId, 'accept', { expectedVersion: invitation.version, idempotencyKey: randomUUID() }));

    const companyId = (await client.query("INSERT INTO companies(name,backcheck_data) VALUES('canonical-assignment-company','{}'::jsonb) RETURNING id")).rows[0].id;
    const customerId = randomUUID();
    await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin) VALUES($1,$2,'fixture',$3,'canonical-assignment',$4,'operations')", [customerId, companyId, customerId, operations.id]);
    const contactId = (await client.query("INSERT INTO contacts(email,first_name,company_id,source_detail) VALUES($1,'Canonical Contact',$2,'canonical-assignment') RETURNING id", [`${randomUUID()}@example.invalid`, companyId])).rows[0].id;
    await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, contactId]);

    const result = unwrap(await createContactAssignmentsIn(client, {
      userId: operations.id,
      roles: ['operations'],
      capabilities: capabilitiesFor(['operations']),
      scope: 'shared',
    }, {
      contacts: [{ contactId, customerId, expectedVersion: 1 }],
      targetUserId: member.id,
      idempotencyKey: randomUUID(),
    }));
    expect(result.items[0]).toMatchObject({ targetUserId: member.id, supervisorUserIds: [leader.id] });
    const stored = (await client.query('SELECT supervisor_user_ids AS "supervisorUserIds",notify_user_ids AS "notifyUserIds" FROM crm_contact_assignment_requests WHERE request_id=$1', [result.items[0]!.requestId])).rows[0];
    expect(stored.supervisorUserIds).toEqual([leader.id]);
    expect(stored.notifyUserIds).toEqual(expect.arrayContaining([member.id, leader.id]));
  });

  it('soft-dissolves leaf organizations with optimistic idempotency and preserves contact ownership', async () => {
    const operations = await user('operations', 'Dissolve Operations');
    const superAdmin = await identityAdmin('Dissolve Identity Admin');
    const leader = await user('sales', 'Dissolve Primary Leader');
    const secondaryLeader = await user('sales', 'Dissolve Secondary Leader');
    const secondTeamLeader = await user('sales', 'Dissolve Second Team Leader');
    const member = await user('sales', 'Dissolve Member');
    const pending = await user('sales', 'Dissolve Pending Invite');
    const ops = await createOperationsGroup(operations);
    const team = await createSalesTeam(operations, leader, ops.teamId, [member.id, pending.id]);
    const memberInvitation = unwrap(await service.context(member.token)).incomingInvitations.find(item => item.teamId === team.teamId)!;
    unwrap(await service.decide(member.token, memberInvitation.invitationId, 'accept', { expectedVersion: memberInvitation.version, idempotencyKey: randomUUID() }));
    await client.query("INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary) VALUES($1,$2,'leader',false)", [secondaryLeader.id, team.teamId]);
    const group = unwrap(await service.saveMemberGroup(leader.token, team.teamId, {
      groupId: null,
      name: '解散前分组',
      memberIds: [leader.id, member.id],
      expectedVersion: 0,
      idempotencyKey: randomUUID(),
    }));
    expect(group.team?.memberGroups).toHaveLength(1);

    const companyId = (await client.query("INSERT INTO companies(name,backcheck_data) VALUES('dissolve-company','{}'::jsonb) RETURNING id")).rows[0].id;
    const customerId = randomUUID();
    await client.query("INSERT INTO crm_customers(customer_id,company_id,source,customer_key,source_detail,created_by,origin) VALUES($1,$2,'fixture',$3,'dissolve-ownership',$4,'operations')", [customerId, companyId, customerId, operations.id]);
    const contactId = (await client.query("INSERT INTO contacts(email,first_name,company_id,source_detail) VALUES($1,'Dissolve Contact',$2,'dissolve-ownership') RETURNING id", [`${randomUUID()}@example.invalid`, companyId])).rows[0].id;
    await client.query('INSERT INTO crm_customer_contacts(customer_id,contact_id) VALUES($1,$2)', [customerId, contactId]);
    const ownership = (await client.query("INSERT INTO crm_contact_ownership(contact_id,customer_id,owner_user_id,source_org_unit_id,created_by) VALUES($1,$2,$3,$4,$5) RETURNING ownership_id", [contactId, customerId, member.id, team.teamId, operations.id])).rows[0].ownership_id;

    expect(unwrap(await service.detail(operations.token, team.teamId)).team.canDissolve).toBe(true);
    expect(unwrap(await service.detail(member.token, team.teamId)).team.canDissolve).toBe(false);
    expect(await service.dissolve(secondaryLeader.token, team.teamId, { expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await service.dissolve(member.token, team.teamId, { expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await service.dissolve(operations.token, ops.teamId, { expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ error: { code: 'CONFLICT' } });

    const dissolveKey = randomUUID();
    const dissolved = unwrap(await service.dissolve(leader.token, team.teamId, { expectedVersion: 1, idempotencyKey: dissolveKey }));
    expect(dissolved.team).toBeNull();
    expect(unwrap(await service.dissolve(leader.token, team.teamId, { expectedVersion: 1, idempotencyKey: dissolveKey })).team).toBeNull();
    expect(await service.dissolve(leader.token, team.teamId, { expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(await service.detail(operations.token, team.teamId)).toMatchObject({ error: { code: 'NOT_FOUND' } });

    const state = (await client.query(`SELECT unit.dissolved_at AS "dissolvedAt",unit.dissolved_by AS "dissolvedBy",unit.version,
      (SELECT count(*)::int FROM crm_org_assignments WHERE unit_id=$1) AS assignments,
      (SELECT count(*)::int FROM crm_org_assignments WHERE unit_id=$1 AND ended_at IS NOT NULL) AS ended,
      (SELECT count(*)::int FROM crm_org_invitations WHERE unit_id=$1 AND status='cancelled') AS cancelled,
      (SELECT count(*)::int FROM crm_org_member_groups WHERE unit_id=$1) AS groups,
      (SELECT count(*)::int FROM crm_org_dissolution_audits WHERE unit_id=$1) AS audits
      FROM crm_org_units unit WHERE unit.unit_id=$1`, [team.teamId])).rows[0];
    expect(state).toEqual({ dissolvedAt: expect.any(Date), dissolvedBy: leader.id, version: 2, assignments: 3, ended: 3, cancelled: 1, groups: 0, audits: 1 });
    const audit = (await client.query('SELECT unit_version AS "unitVersion",ended_assignment_count AS "endedCount",cancelled_invitation_count AS "cancelledCount" FROM crm_org_dissolution_audits WHERE unit_id=$1', [team.teamId])).rows[0];
    expect(audit).toEqual({ unitVersion: 2, endedCount: 3, cancelledCount: 1 });
    const retained = (await client.query('SELECT ownership_id AS id,owner_user_id AS owner,source_org_unit_id AS source,ended_at AS ended FROM crm_contact_ownership WHERE ownership_id=$1', [ownership])).rows[0];
    expect(retained).toEqual({ id: ownership, owner: member.id, source: team.teamId, ended: null });

    const secondTeam = await createSalesTeam(operations, secondTeamLeader, ops.teamId);
    expect(unwrap(await service.dissolve(superAdmin.token, secondTeam.teamId, { expectedVersion: 1, idempotencyKey: randomUUID() })).team).toBeNull();
    expect(unwrap(await service.dissolve(operations.token, ops.teamId, { expectedVersion: 1, idempotencyKey: randomUUID() })).team).toBeNull();

    const company = (await client.query("SELECT unit_id AS id FROM crm_org_units WHERE kind='company'")).rows[0];
    expect(await service.dissolve(superAdmin.token, company.id, { expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('rejects duplicate sibling names in PostgreSQL after trimming and case folding', async () => {
    const operations = await user('operations', 'Duplicate Operations');
    const companyId = (await client.query("SELECT unit_id FROM crm_org_units WHERE kind='company'")).rows[0].unit_id;
    await client.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('operations_group',$1,'Same Sibling',$2)", [companyId, operations.id]);
    await client.query('SAVEPOINT duplicate_sibling_name');
    let code = '';
    try {
      await client.query("INSERT INTO crm_org_units(kind,parent_unit_id,name,created_by) VALUES('operations_group',$1,'  same sibling  ',$2)", [companyId, operations.id]);
    } catch (error) {
      code = String((error as { code?: string }).code ?? '');
      await client.query('ROLLBACK TO SAVEPOINT duplicate_sibling_name');
    }
    await client.query('RELEASE SAVEPOINT duplicate_sibling_name');
    expect(code).toBe('23505');
  });

  it('marks an expired invitation on context refresh and refuses late acceptance', async () => {
    const operations = await user('operations', 'Expiry Operations');
    const leader = await user('sales', 'Expiry Leader');
    const member = await user('sales', 'Expiry Member');
    const ops = await createOperationsGroup(operations);
    const team = await createSalesTeam(operations, leader, ops.teamId, [member.id]);
    const pending = unwrap(await service.context(member.token)).incomingInvitations.find(item => item.teamId === team.teamId)!;
    expect(pending.expiresAt).toEqual(expect.any(String));
    await client.query("UPDATE crm_org_invitations SET expires_at=now()-interval '1 second' WHERE invitation_id=$1", [pending.invitationId]);

    const expired = unwrap(await service.context(member.token)).incomingInvitations.find(item => item.invitationId === pending.invitationId)!;
    expect(expired).toMatchObject({ status: 'expired', canAccept: false, canDecline: false, canCancel: false });
    expect(expired.version).toBe(pending.version + 1);
    expect(await service.decide(member.token, pending.invitationId, 'accept', { expectedVersion: expired.version, idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect((await client.query("SELECT count(*)::int AS count FROM crm_org_assignments WHERE unit_id=$1 AND user_id=$2 AND role='member'", [team.teamId, member.id])).rows[0].count).toBe(0);
  });

  it('supports a multi-team leader, multiple operations managers and superadmin company visibility', async () => {
    const operations = await user('operations', 'First Operations');
    const secondOperations = await user('operations', 'Second Operations');
    const superAdmin = await identityAdmin('Identity Only Admin');
    const leader = await user('sales', 'Portfolio Leader');
    const ops = await createOperationsGroup(operations, operations);
    const assigned = unwrap(await service.assignLeader(operations.token, ops.teamId, { leaderUserId: secondOperations.id, expectedVersion: 1, idempotencyKey: randomUUID() }));
    expect(assigned.organization?.visibleUnits.find(unit => unit.unitId === ops.teamId)?.version).toBe(2);
    const first = await createSalesTeam(operations, leader, ops.teamId);
    const second = await createSalesTeam(operations, leader, ops.teamId);

    const leaderContext = unwrap(await service.context(leader.token));
    expect(leaderContext.managedTeams?.map(team => team.teamId)).toEqual(expect.arrayContaining([first.teamId, second.teamId]));
    const operationsLeaders = (await client.query("SELECT count(*)::int AS count,count(*) FILTER(WHERE is_primary)::int AS primary_count FROM crm_org_assignments WHERE unit_id=$1 AND role='leader'", [ops.teamId])).rows[0];
    expect(operationsLeaders).toEqual({ count: 2, primary_count: 1 });
    const multiTeamLeaders = (await client.query("SELECT unit_id,is_primary FROM crm_org_assignments WHERE unit_id=ANY($1::uuid[]) AND user_id=$2 AND role='leader' ORDER BY unit_id", [[first.teamId, second.teamId], leader.id])).rows;
    expect(multiTeamLeaders).toHaveLength(2);
    expect(multiTeamLeaders.every(row => row.is_primary)).toBe(true);

    const adminContext = unwrap(await service.context(superAdmin.token));
    expect(adminContext.isSuperAdmin).toBe(true);
    expect(adminContext.organization?.company.kind).toBe('company');
    expect(adminContext.organization?.visibleUnits.map(unit => unit.unitId)).toEqual(expect.arrayContaining([ops.teamId, first.teamId, second.teamId]));
    expect((await client.query("SELECT count(*)::int AS count FROM public.identity_product_access WHERE user_id=$1 AND product_id='crm'", [superAdmin.id])).rows[0].count).toBe(0);
    expect((await client.query('SELECT count(*)::int AS count FROM crm_org_assignments WHERE user_id=$1', [superAdmin.id])).rows[0].count).toBe(0);
  });

  it('closes canonical mutation paths for move, leader reassignment, members and display groups', async () => {
    const operations = await user('operations', 'Mutation Operations');
    const oldLeader = await user('sales', 'Old Leader');
    const newLeader = await user('sales', 'New Leader');
    const member = await user('sales', 'Mutation Member');
    const firstOps = await createOperationsGroup(operations);
    const secondOps = await createOperationsGroup(operations);
    const team = await createSalesTeam(operations, oldLeader, firstOps.teamId);

    const invited = unwrap(await service.invite(operations.token, team.teamId, { userIds: [member.id], idempotencyKey: randomUUID() }));
    const memberInvitation = invited.outgoingInvitations.find(item => item.inviteeUserId === member.id)!;
    unwrap(await service.decide(member.token, memberInvitation.invitationId, 'accept', { expectedVersion: memberInvitation.version, idempotencyKey: randomUUID() }));
    expect(invited.organization?.visibleUnits.find(unit => unit.unitId === team.teamId)?.version).toBe(1);
    const grouped = unwrap(await service.saveMemberGroup(operations.token, team.teamId, { groupId: null, name: '华东一组', memberIds: [member.id], expectedVersion: 0, idempotencyKey: randomUUID() }));
    const group = unwrap(await service.detail(operations.token, team.teamId)).team.memberGroups?.find(item => item.name === '华东一组');
    expect(group).toMatchObject({ memberIds: [member.id], version: 1 });
    expect(grouped.organization?.visibleUnits.some(unit => unit.unitId === team.teamId)).toBe(true);
    const renamed = unwrap(await service.saveMemberGroup(operations.token, team.teamId, { groupId: group!.groupId, name: '华东一组（更新）', memberIds: [member.id], expectedVersion: group!.version, idempotencyKey: randomUUID() }));
    expect(renamed.organization?.visibleUnits.some(unit => unit.unitId === team.teamId)).toBe(true);
    const renamedGroup = unwrap(await service.detail(operations.token, team.teamId)).team.memberGroups?.find(item => item.groupId === group!.groupId);
    expect(renamedGroup).toMatchObject({ name: '华东一组（更新）', version: 2 });

    const reassigned = unwrap(await service.assignLeader(operations.token, team.teamId, { leaderUserId: newLeader.id, expectedVersion: 1, idempotencyKey: randomUUID() }));
    expect(reassigned.organization?.visibleUnits.find(unit => unit.unitId === team.teamId)?.version).toBe(2);
    const moved = unwrap(await service.move(operations.token, team.teamId, { parentTeamId: secondOps.teamId, expectedVersion: 2, idempotencyKey: randomUUID() }));
    expect(moved.organization?.visibleUnits.find(unit => unit.unitId === team.teamId)?.parentUnitId).toBe(secondOps.teamId);
    expect(moved.organization?.visibleUnits.find(unit => unit.unitId === team.teamId)?.version).toBe(3);
    expect((await service.adjustMember(operations.token, team.teamId, { userId: member.id, action: 'remove', expectedVersion: 3, idempotencyKey: randomUUID() })).ok).toBe(true);
    expect((await service.deleteMemberGroup(operations.token, team.teamId, group!.groupId, { groupId: group!.groupId, expectedVersion: 2, idempotencyKey: randomUUID() })).ok).toBe(true);

    expect((await client.query('SELECT count(*)::int AS count FROM crm_teams')).rows[0].count).toBe(0);
    expect((await client.query('SELECT count(*)::int AS count FROM crm_org_assignments WHERE unit_id=$1 AND user_id=$2 AND role=\'member\'', [team.teamId, member.id])).rows[0].count).toBe(0);
  });

  it('enforces bidirectional assignment exclusivity and filters leader candidates by exact role', async () => {
    const operations = await user('operations', 'Matrix Operations');
    const secondOperations = await user('operations', 'Matrix Secondary Operations');
    const leader = await user('sales', 'Matrix Existing Leader');
    const member = await user('sales', 'Matrix Member Elsewhere');
    const identityOnly = await identityAdmin('Matrix Identity Admin');
    const multiRole = await userWithRoles(['sales', 'operations'], 'Matrix Multi Role');
    const pureSales = await user('sales', 'Matrix Pure Candidate');
    const firstOps = await createOperationsGroup(operations);
    const secondOps = await createOperationsGroup(operations);
    await unwrap(await service.assignLeader(operations.token, firstOps.teamId, { leaderUserId: secondOperations.id, expectedVersion: 1, idempotencyKey: randomUUID() }));
    await unwrap(await service.assignLeader(operations.token, secondOps.teamId, { leaderUserId: secondOperations.id, expectedVersion: 1, idempotencyKey: randomUUID() }));
    const first = await createSalesTeam(operations, leader, firstOps.teamId, [member.id]);
    const second = await createSalesTeam(operations, leader, secondOps.teamId);
    const invitation = unwrap(await service.context(member.token)).incomingInvitations.find(item => item.teamId === first.teamId)!;
    unwrap(await service.decide(member.token, invitation.invitationId, 'accept', { expectedVersion: invitation.version, idempotencyKey: randomUUID() }));

    expect(await service.assignLeader(operations.token, second.teamId, { leaderUserId: member.id, expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const server = createServer((request, response) => { void createTeamHandler(service)(request, response); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const response = await fetch(`${base}/api/crm/teams/${second.teamId}/leader`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${operations.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaderUserId: member.id, expectedVersion: 1, idempotencyKey: randomUUID() }),
      });
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    expect(await rejectedDatabaseWrite("INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary) VALUES($1,$2,'leader',false)", [member.id, second.teamId])).toBe('P0001');
    const third = await createSalesTeam(operations, pureSales, secondOps.teamId);
    expect(await rejectedDatabaseWrite("INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary) VALUES($1,$2,'member',false)", [leader.id, third.teamId])).toBe('P0001');
    expect(await service.adjustMember(operations.token, first.teamId, { userId: leader.id, action: 'add', expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    await createSalesTeam(operations, leader, secondOps.teamId, [], randomUUID(), 'Matrix Leader Team');

    const candidates = unwrap(await service.candidates(operations.token, { search: 'Matrix', limit: 50, offset: 0, role: 'leader', unitType: 'sales_team' }));
    const candidateIds = candidates.items.map(item => item.userId);
    expect(candidateIds).toContain(pureSales.id);
    expect(candidateIds).not.toContain(identityOnly.id);
    expect(candidateIds).not.toContain(operations.id);
    expect(candidateIds).not.toContain(multiRole.id);
    expect(candidateIds).not.toContain(member.id);
    for (const candidate of [operations, identityOnly, multiRole, member]) {
      expect(await service.assignLeader(operations.token, second.teamId, { leaderUserId: candidate.id, expectedVersion: 1, idempotencyKey: randomUUID() })).toMatchObject({ ok: false });
    }

    const secondSuperAdmin = await identityAdmin('Matrix Second Super Admin');
    const firstAdminContext = unwrap(await service.context(identityOnly.token));
    expect(firstAdminContext.isSuperAdmin).toBe(true);
    expect(firstAdminContext.organization?.visibleUnits.map(unit => unit.unitId)).toEqual(expect.arrayContaining([firstOps.teamId, secondOps.teamId]));
    const secondAdminContext = unwrap(await service.context(secondSuperAdmin.token));
    expect(secondAdminContext.isSuperAdmin).toBe(true);
    expect(secondAdminContext.organization?.visibleUnits.map(unit => unit.unitId)).toEqual(expect.arrayContaining([firstOps.teamId, secondOps.teamId]));
    const secondManagerAssignments = await client.query("SELECT count(*)::int AS count FROM crm_org_assignments WHERE user_id=$1 AND role='leader' AND unit_id=ANY($2::uuid[])", [secondOperations.id, [firstOps.teamId, secondOps.teamId]]);
    expect(secondManagerAssignments.rows[0].count).toBe(2);
  });

  it('lets the primary leader, any operations manager and superadmins cancel invitations without deleting history, and replays idempotent mutations', async () => {
    const operations = await user('operations', 'Cancel Operations');
    const secondaryOperations = await user('operations', 'Cancel Secondary Operations');
    const superAdmin = await identityAdmin('Cancel Super Admin');
    const leader = await user('sales', 'Cancel Leader');
    const first = await user('sales', 'Cancel Invitee One');
    const second = await user('sales', 'Cancel Invitee Two');
    const third = await user('sales', 'Cancel Invitee Three');
    const member = await user('sales', 'Group Member');
    const outsider = await user('sales', 'Group Outsider');
    const ops = await createOperationsGroup(operations);
    const team = await createSalesTeam(operations, leader, ops.teamId, [first.id, second.id, third.id]);

    const leaderDetail = unwrap(await service.detail(leader.token, team.teamId));
    const leaderInvitation = leaderDetail.outgoingInvitations.find(item => item.inviteeUserId === first.id)!;
    expect(leaderInvitation.canCancel).toBe(true);
    unwrap(await service.decide(leader.token, leaderInvitation.invitationId, 'cancel', { expectedVersion: leaderInvitation.version, idempotencyKey: randomUUID() }));

    const managerDetail = unwrap(await service.detail(secondaryOperations.token, team.teamId));
    const managerInvitation = managerDetail.outgoingInvitations.find(item => item.inviteeUserId === second.id)!;
    expect(managerInvitation.canCancel).toBe(true);
    unwrap(await service.decide(secondaryOperations.token, managerInvitation.invitationId, 'cancel', { expectedVersion: managerInvitation.version, idempotencyKey: randomUUID() }));

    const adminDetail = unwrap(await service.detail(superAdmin.token, team.teamId));
    const adminInvitation = adminDetail.outgoingInvitations.find(item => item.inviteeUserId === third.id)!;
    expect(adminInvitation.canCancel).toBe(true);
    unwrap(await service.decide(superAdmin.token, adminInvitation.invitationId, 'cancel', { expectedVersion: adminInvitation.version, idempotencyKey: randomUUID() }));
    const history = await client.query("SELECT status,count(*)::int AS count FROM crm_org_invitations WHERE invitation_id=ANY($1::uuid[]) GROUP BY status", [[leaderInvitation.invitationId, managerInvitation.invitationId, adminInvitation.invitationId]]);
    expect(history.rows).toEqual([{ status: 'cancelled', count: 3 }]);

    const memberInvited = unwrap(await service.invite(operations.token, team.teamId, { userIds: [member.id], idempotencyKey: 'stable-member-key' }));
    const memberInvitedAgain = unwrap(await service.invite(operations.token, team.teamId, { userIds: [member.id], idempotencyKey: 'stable-member-key' }));
    expect(memberInvitedAgain).toEqual(memberInvited);
    const memberInvitation = memberInvited.outgoingInvitations.find(item => item.inviteeUserId === member.id)!;
    unwrap(await service.decide(member.token, memberInvitation.invitationId, 'accept', { expectedVersion: memberInvitation.version, idempotencyKey: randomUUID() }));
    unwrap(await service.saveMemberGroup(operations.token, team.teamId, { groupId: null, name: '负责人与成员', memberIds: [leader.id, member.id], expectedVersion: 0, idempotencyKey: randomUUID() }));
    const savedGroup = unwrap(await service.detail(operations.token, team.teamId)).team.memberGroups?.find(item => item.name === '负责人与成员');
    expect(savedGroup).toMatchObject({ version: 1, memberIds: expect.arrayContaining([leader.id, member.id]) });
    expect((await service.saveMemberGroup(operations.token, team.teamId, { groupId: savedGroup!.groupId, name: '负责人与成员', memberIds: [outsider.id], expectedVersion: savedGroup!.version, idempotencyKey: randomUUID() })).ok).toBe(false);
    expect((await client.query('SELECT count(*)::int AS count FROM crm_org_idempotency WHERE actor_id=$1 AND idempotency_key=$2', [operations.id, 'stable-member-key'])).rows[0].count).toBe(1);
  });
});
