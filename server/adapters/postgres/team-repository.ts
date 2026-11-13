import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CrmRole } from '../../core/auth';
import { effectiveCapabilitiesFor, type DataScope } from '../../core/admin';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import {
  canDissolveOrganizationUnit,
  canCreateOrganizationAssignment,
  canGovernOrganization,
  canPlaceOrganizationUnit,
  createsOrganizationCycle,
  isSuperAdministrator,
  type OrganizationAssignmentRole,
  type OrganizationUnitKind,
} from '../../core/organization';
import type {
  OrganizationContext,
  OrganizationUnitSummary,
  TeamAdminSummary,
  TeamContext,
  TeamCreateInput,
  TeamCreateReceipt,
  TeamDetail,
  TeamDissolveInput,
  TeamInvitation,
  TeamInvitationDecision,
  TeamInviteInput,
  TeamLeaderInput,
  TeamMember,
  TeamMemberAdjustmentInput,
  TeamMemberCandidatePage,
  TeamMemberCandidateQuery,
  TeamMemberGroup,
  TeamMemberGroupDeleteInput,
  TeamMemberGroupInput,
  TeamMoveInput,
  TeamRepository,
  TeamSnapshot,
  TeamUnitType,
} from '../../core/teams';
import { DEFAULT_TEAM_UNIT_TYPE, teamAcceptsMembers } from '../../core/teams';
import {
  TEAM_SCHEMA_LOCK,
  TEAM_SCHEMA_SQL,
  TEAM_SCHEMA_VERSION,
  TEAM_TREE_SQL,
  TEAM_TREE_VERSION,
} from './team-schema';
import {
  ORG_SUPERVISION_SQL,
  ORG_SUPERVISION_VERSION,
  TEAM_ORGANIZATION_SQL,
  TEAM_ORGANIZATION_VERSION,
} from './organization-supervision-schema';
import {
  LEGACY_ORGANIZATION_REPAIR_SQL,
  LEGACY_ORGANIZATION_REPAIR_VERSION,
  ORGANIZATION_ASSIGNMENT_INTEGRITY_SQL,
  ORGANIZATION_ASSIGNMENT_INTEGRITY_VERSION,
  ORGANIZATION_SCHEMA_SQL,
  ORGANIZATION_SCHEMA_VERSION,
} from './organization-schema';
import {
  ORGANIZATION_DISSOLUTION_SQL,
  ORGANIZATION_DISSOLUTION_VERSION,
} from './organization-dissolution-schema';
import { assertCenterDatabasePool } from './config';

interface TeamActor {
  userId: string;
  displayName: string;
  identityAdmin: boolean;
  roles: CrmRole[];
  capabilities: string[];
  scope: DataScope;
}

interface OrganizationRow {
  teamId: string;
  name: string;
  organizationKind: OrganizationUnitKind;
  unitType: TeamUnitType;
  parentTeamId: string | null;
  parentTeamName: string | null;
  leaderUserId: string | null;
  leaderName: string | null;
  version: number;
  memberCount: number;
  createdAt: Date;
}

type InvitationRow = {
  invitationId: string;
  teamId: string;
  teamName: string;
  inviterUserId: string;
  inviterName: string;
  inviteeUserId: string;
  inviteeName: string;
  status: TeamInvitation['status'];
  version: number;
  createdAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
};

type AdminTeamRow = Omit<TeamAdminSummary, 'createdAt' | 'depth'> & { createdAt: Date };
type AssignmentRow = { unitId: string; role: OrganizationAssignmentRole; isPrimary: boolean };
type UnitRow = { unitId: string; kind: OrganizationUnitKind; parentUnitId: string | null; name: string; version: number; dissolvedAt?: Date | null };
type DecisionInvitationRow = { invitationId: string; teamId: string; inviterUserId: string; inviteeUserId: string; status: TeamInvitation['status']; version: number; expiresAt: Date; expired: boolean; kind: OrganizationUnitKind };

const TEAM_SELECT = `
  SELECT u.unit_id AS "teamId",u.name,u.kind AS "organizationKind",
    CASE u.kind WHEN 'operations_group' THEN 'operations' ELSE 'sales_team' END AS "unitType",
    u.parent_unit_id AS "parentTeamId",p.name AS "parentTeamName",
    leader.user_id AS "leaderUserId",leader.display_name AS "leaderName",u.version,u.created_at AS "createdAt",
    (SELECT count(*)::int FROM crm_org_assignments a WHERE a.unit_id=u.unit_id AND a.ended_at IS NULL) AS "memberCount"
  FROM crm_org_units u
  LEFT JOIN crm_org_units p ON p.unit_id=u.parent_unit_id
  LEFT JOIN LATERAL (
    SELECT a.user_id,iu.display_name
    FROM crm_org_assignments a JOIN public.identity_users iu ON iu.user_id=a.user_id
    WHERE a.unit_id=u.unit_id AND a.role='leader' AND a.ended_at IS NULL
    ORDER BY a.is_primary DESC,a.created_at,a.user_id LIMIT 1
  ) leader ON true`;

const INVITATION_SELECT = `
  SELECT i.invitation_id AS "invitationId",i.unit_id AS "teamId",u.name AS "teamName",
    i.inviter_user_id AS "inviterUserId",iu.display_name AS "inviterName",
    i.invitee_user_id AS "inviteeUserId",vu.display_name AS "inviteeName",
    i.status,i.version,i.created_at AS "createdAt",i.expires_at AS "expiresAt",i.decided_at AS "decidedAt"
  FROM crm_org_invitations i
  JOIN crm_org_units u ON u.unit_id=i.unit_id AND u.dissolved_at IS NULL
  JOIN public.identity_users iu ON iu.user_id=i.inviter_user_id
  JOIN public.identity_users vu ON vu.user_id=i.invitee_user_id`;

const ADMIN_TEAM_SELECT = `
  SELECT u.unit_id AS "teamId",u.name,
    CASE u.kind WHEN 'operations_group' THEN 'operations' ELSE 'sales_team' END AS "unitType",
    u.kind AS "organizationKind",u.parent_unit_id AS "parentTeamId",p.name AS "parentTeamName",
    leader.display_name AS "leaderName",u.version,
    (SELECT count(*)::int FROM crm_org_assignments a WHERE a.unit_id=u.unit_id AND a.ended_at IS NULL) AS "memberCount",
    (SELECT count(*)::int FROM crm_org_invitations i WHERE i.unit_id=u.unit_id AND i.status='pending') AS "pendingInvitationCount",
    (SELECT count(*)::int FROM crm_org_units c WHERE c.parent_unit_id=u.unit_id AND c.dissolved_at IS NULL) AS "childCount",
    COALESCE((SELECT count(DISTINCT r.request_id)::int
      FROM crm_contact_assignment_requests r
      JOIN crm_org_assignments target_membership ON target_membership.user_id=r.target_user_id
        AND target_membership.unit_id=u.unit_id AND target_membership.ended_at IS NULL
      WHERE u.kind='sales_team' AND r.status IN ('pending','accepted','pending_transfer')),0) AS "assignedLeadCount",
    COALESCE((SELECT array_agg(DISTINCT r.source_org_unit_id::text)
      FROM crm_contact_assignment_requests r
      JOIN crm_org_assignments target_membership ON target_membership.user_id=r.target_user_id
        AND target_membership.unit_id=u.unit_id AND target_membership.ended_at IS NULL
      WHERE u.kind='sales_team' AND r.status IN ('pending','accepted','pending_transfer') AND r.source_org_unit_id IS NOT NULL),ARRAY[]::text[]) AS "assignmentSourceTeamIds",
    u.created_at AS "createdAt"
  FROM crm_org_units u
  LEFT JOIN crm_org_units p ON p.unit_id=u.parent_unit_id
  LEFT JOIN LATERAL (
    SELECT iu.display_name
    FROM crm_org_assignments a JOIN public.identity_users iu ON iu.user_id=a.user_id
    WHERE a.unit_id=u.unit_id AND a.role='leader' AND a.ended_at IS NULL
    ORDER BY a.is_primary DESC,a.created_at,a.user_id LIMIT 1
  ) leader ON true`;

function superAdmin(actor: TeamActor): boolean {
  return isSuperAdministrator({ userId: actor.userId, identityAdmin: actor.identityAdmin, roles: actor.roles });
}

function manager(actor: TeamActor): boolean {
  return canGovernOrganization({ userId: actor.userId, identityAdmin: actor.identityAdmin, roles: actor.roles });
}

function mapInvitation(row: InvitationRow, actor: TeamActor, canCancel: boolean): TeamInvitation {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    canAccept: row.status === 'pending' && row.inviteeUserId === actor.userId,
    canDecline: row.status === 'pending' && row.inviteeUserId === actor.userId,
    canCancel: row.status === 'pending' && canCancel,
  };
}

function treeOrder(rows: AdminTeamRow[]): TeamAdminSummary[] {
  const byId = new Map(rows.map(row => [row.teamId, row]));
  const children = new Map<string | null, AdminTeamRow[]>();
  for (const row of rows) {
    const parent = row.parentTeamId && byId.has(row.parentTeamId) ? row.parentTeamId : null;
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  for (const group of children.values()) group.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.teamId.localeCompare(right.teamId));
  const result: TeamAdminSummary[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    for (const row of children.get(parent) ?? []) {
      if (seen.has(row.teamId)) continue;
      seen.add(row.teamId);
      result.push({ ...row, createdAt: row.createdAt.toISOString(), depth });
      visit(row.teamId, depth + 1);
    }
  };
  visit(null, 0);
  for (const row of rows.filter(row => !seen.has(row.teamId)).sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.teamId.localeCompare(right.teamId))) {
    result.push({ ...row, createdAt: row.createdAt.toISOString(), depth: 0 });
  }
  return result;
}

export class PostgresTeamRepository implements TeamRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) {
    assertCenterDatabasePool(pool);
  }

  private async tx<T>(work: (client: PoolClient) => Promise<Result<T>>): Promise<Result<T>> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [TEAM_SCHEMA_LOCK]);
      const result = await work(client);
      await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { /* The failed transaction is already disposed. */ }
      this.log.write('ERROR', 'teams.repository', `组织迁移失败 (${error instanceof Error ? error.name : 'unknown'})`);
      return failure('DATABASE_ERROR', '组织数据迁移失败');
    } finally {
      client?.release();
    }
  }

  private async authorized<T>(tokenHash: string, work: (client: PoolClient, actor: TeamActor) => Promise<Result<T>>): Promise<Result<T>> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      const actor = await this.actor(client, tokenHash);
      if (!actor) return failure('FORBIDDEN', '当前账号没有组织权限');
      return await work(client, actor);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
      this.log.write('ERROR', 'teams.authorize', `组织鉴权失败 code=${code} message=${error instanceof Error ? error.message : 'unknown'}`);
      return failure('DATABASE_ERROR', '组织鉴权失败');
    } finally {
      client?.release();
    }
  }

  private async authorizedTransaction<T>(tokenHash: string, work: (client: PoolClient, actor: TeamActor) => Promise<Result<T>>): Promise<Result<T>> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const actor = await this.actor(client, tokenHash);
      if (!actor) { await client.query('ROLLBACK'); return failure('FORBIDDEN', '当前账号没有组织权限'); }
      const result = await work(client, actor);
      await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      if (client) try { await client.query('ROLLBACK'); } catch { /* The failed transaction is already disposed. */ }
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
      this.log.write('ERROR', 'teams.transaction', `组织写事务失败 code=${code} message=${error instanceof Error ? error.message : 'unknown'}`);
      if (code === '23505') return failure('CONFLICT', '组织数据与现有记录冲突');
      if (code === '23503' || code === '23514' || code === 'P0001') return failure('INVALID_INPUT', '组织变更不符合层级或关系规则');
      return failure('DATABASE_ERROR', '组织数据操作失败');
    } finally {
      client?.release();
    }
  }

  async migrate(): Promise<Result<void>> {
    return this.tx(async client => {
      for (const [version, sql] of [
        [TEAM_SCHEMA_VERSION, TEAM_SCHEMA_SQL],
        [TEAM_TREE_VERSION, TEAM_TREE_SQL],
        [ORG_SUPERVISION_VERSION, ORG_SUPERVISION_SQL],
        [TEAM_ORGANIZATION_VERSION, TEAM_ORGANIZATION_SQL],
        [LEGACY_ORGANIZATION_REPAIR_VERSION, LEGACY_ORGANIZATION_REPAIR_SQL],
        [ORGANIZATION_SCHEMA_VERSION, ORGANIZATION_SCHEMA_SQL],
        [ORGANIZATION_ASSIGNMENT_INTEGRITY_VERSION, ORGANIZATION_ASSIGNMENT_INTEGRITY_SQL],
        [ORGANIZATION_DISSOLUTION_VERSION, ORGANIZATION_DISSOLUTION_SQL],
      ] as const) {
        const checksum = createHash('sha256').update(sql).digest('hex');
        const old = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [version]);
        if (old.rows.length && old.rows[0].checksum !== checksum) return failure('CONFLICT', `组织迁移校验不一致: ${version}`);
        if (!old.rows.length) {
          await client.query(sql);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
          this.log.write('INFO', 'teams.migrate', `迁移完成 version=${version}`);
        }
      }
      return success(undefined);
    });
  }

  private async actor(client: PoolClient, tokenHash: string): Promise<TeamActor | null> {
    const row = (await client.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",u.identity_admin AS "identityAdmin",a.scope,a.capabilities,ARRAY(SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active ORDER BY g.role) AS roles FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) LEFT JOIN public.identity_product_access a ON a.user_id=u.user_id AND a.product_id='crm' AND a.active WHERE s.token_hash=$1 AND s.client='api' AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND NOT u.must_change_password AND s.security_revision=u.security_revision`, [tokenHash])).rows[0];
    if (!row || !row.identityAdmin && row.scope === null) return null;
    const roles = (row.roles ?? []) as CrmRole[];
    const actor: TeamActor = { ...row, roles, scope: (row.scope ?? 'own') as DataScope, capabilities: [] };
    return { ...actor, capabilities: effectiveCapabilitiesFor(roles, row.capabilities) };
  }

  private async members(client: PoolClient, unitId: string, _full: boolean, _viewerUserId: string): Promise<TeamMember[]> {
    return (await client.query(`
      SELECT a.user_id AS "userId",u.display_name AS "displayName",e.email,a.role,a.created_at AS "joinedAt"
      FROM crm_org_assignments a
      JOIN public.identity_users u ON u.user_id=a.user_id
      LEFT JOIN public.identity_login_emails e ON e.user_id=a.user_id
      WHERE a.unit_id=$1 AND a.ended_at IS NULL
      ORDER BY a.created_at DESC,a.user_id
    `, [unitId])).rows.map(member => ({ ...member, joinedAt: (member.joinedAt as Date).toISOString() })) as TeamMember[];
  }

  private async memberGroups(client: PoolClient, unitId: string, full: boolean): Promise<TeamMemberGroup[]> {
    if (!full) return [];
    const groups = (await client.query('SELECT group_id AS "groupId",unit_id AS "teamId",name,version FROM crm_org_member_groups WHERE unit_id=$1 ORDER BY created_at DESC,group_id', [unitId])).rows as Array<Pick<TeamMemberGroup, 'groupId' | 'teamId' | 'name' | 'version'>>;
    if (!groups.length) return [];
    const members = (await client.query('SELECT group_id AS "groupId",user_id AS "userId" FROM crm_org_member_group_members WHERE unit_id=$1 ORDER BY group_id,user_id', [unitId])).rows as Array<{ groupId: string; userId: string }>;
    return groups.map(group => ({ ...group, memberIds: members.filter(member => member.groupId === group.groupId).map(member => member.userId) }));
  }

  private async snapshot(client: PoolClient, row: OrganizationRow, full: boolean, viewerUserId: string, canDissolve: boolean): Promise<TeamSnapshot> {
    return {
      teamId: row.teamId,
      name: row.name,
      unitType: row.unitType,
      parentTeamId: row.parentTeamId,
      parentTeamName: row.parentTeamName,
      leaderUserId: row.leaderUserId ?? '',
      leaderName: row.leaderName ?? '',
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      members: await this.members(client, row.teamId, full, viewerUserId),
      memberCount: row.memberCount,
      memberGroups: await this.memberGroups(client, row.teamId, full),
      canDissolve,
    };
  }

  private async unit(client: PoolClient, unitId: string): Promise<UnitRow | null> {
    return ((await client.query('SELECT unit_id AS "unitId",kind,parent_unit_id AS "parentUnitId",name,version,dissolved_at AS "dissolvedAt" FROM crm_org_units WHERE unit_id=$1 AND dissolved_at IS NULL', [unitId])).rows[0] as UnitRow | undefined) ?? null;
  }

  private async assignment(client: PoolClient, userId: string, unitId: string): Promise<AssignmentRow | null> {
    return ((await client.query('SELECT unit_id AS "unitId",role,is_primary AS "isPrimary" FROM crm_org_assignments WHERE user_id=$1 AND unit_id=$2 AND ended_at IS NULL ORDER BY is_primary DESC,created_at LIMIT 1', [userId, unitId])).rows[0] as AssignmentRow | undefined) ?? null;
  }

  private async canManageUnit(client: PoolClient, actor: TeamActor, unitId: string): Promise<boolean> {
    if (manager(actor)) return true;
    const row = await this.assignment(client, actor.userId, unitId);
    return row?.role === 'leader';
  }

  private async canDissolveUnit(client: PoolClient, actor: TeamActor, unitId: string): Promise<boolean> {
    const unit = await this.unit(client, unitId);
    if (!unit) return false;
    const assignment = await this.assignment(client, actor.userId, unitId);
    const children = await client.query('SELECT count(*)::int AS count FROM crm_org_units WHERE parent_unit_id=$1 AND dissolved_at IS NULL', [unitId]);
    return canDissolveOrganizationUnit(unit.kind, children.rows[0].count, assignment?.role === 'leader' && assignment.isPrimary, manager(actor)).allowed;
  }

  private async teamById(client: PoolClient, unitId: string, actor: TeamActor): Promise<{ row: OrganizationRow; team: TeamSnapshot } | null> {
    const row = (await client.query(`${TEAM_SELECT} WHERE u.unit_id=$1 AND u.dissolved_at IS NULL`, [unitId])).rows[0] as OrganizationRow | undefined;
    if (!row) return null;
    const own = await this.assignment(client, actor.userId, unitId);
    const full = !!own || await this.canManageUnit(client, actor, unitId);
    return { row, team: await this.snapshot(client, row, full, actor.userId, await this.canDissolveUnit(client, actor, unitId)) };
  }

  private async teamForUser(client: PoolClient, actor: TeamActor): Promise<TeamSnapshot | null> {
    const row = (await client.query(`${TEAM_SELECT} JOIN crm_org_assignments a ON a.unit_id=u.unit_id AND a.ended_at IS NULL WHERE a.user_id=$1 AND u.kind='sales_team' AND u.dissolved_at IS NULL ORDER BY a.is_primary DESC,a.created_at,a.unit_id LIMIT 1`, [actor.userId])).rows[0] as OrganizationRow | undefined;
    return row ? this.snapshot(client, row, true, actor.userId, await this.canDissolveUnit(client, actor, row.teamId)) : null;
  }

  private async expireInvitations(client: PoolClient): Promise<void> {
    await client.query("UPDATE crm_org_invitations SET status='expired',version=version+1,decided_at=now() WHERE status='pending' AND expires_at<=now()");
  }

  private async canManageInvitation(client: PoolClient, actor: TeamActor, unitId: string): Promise<boolean> {
    if (manager(actor)) return true;
    const row = await this.assignment(client, actor.userId, unitId);
    return row?.role === 'leader' && row.isPrimary;
  }

  private async invitations(client: PoolClient, actor: TeamActor, teamId: string | null, canManageCurrent: boolean): Promise<{ incoming: TeamInvitation[]; outgoing: TeamInvitation[] }> {
    await this.expireInvitations(client);
    const incoming = (await client.query(`${INVITATION_SELECT} WHERE i.invitee_user_id=$1 AND i.status IN ('pending','expired') ORDER BY i.created_at DESC,i.invitation_id`, [actor.userId])).rows as InvitationRow[];
    const outgoing = manager(actor)
      ? (await client.query(`${INVITATION_SELECT} WHERE ($1::uuid IS NULL OR i.unit_id=$1) AND i.status IN ('pending','expired') ORDER BY i.created_at DESC,i.invitation_id`, [teamId])).rows as InvitationRow[]
      : teamId && canManageCurrent
        ? (await client.query(`${INVITATION_SELECT} WHERE i.unit_id=$1 AND i.status IN ('pending','expired') ORDER BY i.created_at DESC,i.invitation_id`, [teamId])).rows as InvitationRow[]
        : [];
    return {
      incoming: incoming.map(row => mapInvitation(row, actor, manager(actor) || (canManageCurrent && row.teamId === teamId))),
      outgoing: outgoing.map(row => mapInvitation(row, actor, manager(actor) || (canManageCurrent && row.teamId === teamId))),
    };
  }

  private async adminTeamRows(client: PoolClient, suffix = '', params: unknown[] = []): Promise<AdminTeamRow[]> {
    return (await client.query(`${ADMIN_TEAM_SELECT} WHERE u.kind<>'company' AND u.dissolved_at IS NULL ${suffix}`, params)).rows as AdminTeamRow[];
  }

  private async organizationContext(client: PoolClient, actor: TeamActor): Promise<OrganizationContext> {
    const companyRow = (await client.query("SELECT unit_id AS \"unitId\",kind,parent_unit_id AS \"parentUnitId\",name,version FROM crm_org_units WHERE kind='company'")).rows[0] as OrganizationUnitSummary | undefined;
    if (!companyRow) throw new Error('company root missing');
    const rows = manager(actor)
      ? (await client.query("SELECT unit_id AS \"unitId\",kind,parent_unit_id AS \"parentUnitId\",name,version FROM crm_org_units WHERE kind<>'company' AND dissolved_at IS NULL ORDER BY created_at DESC,unit_id")).rows
      : (await client.query("SELECT u.unit_id AS \"unitId\",u.kind,u.parent_unit_id AS \"parentUnitId\",u.name,u.version FROM crm_org_units u JOIN crm_org_assignments a ON a.unit_id=u.unit_id AND a.ended_at IS NULL WHERE a.user_id=$1 AND u.dissolved_at IS NULL ORDER BY u.created_at DESC,u.unit_id", [actor.userId])).rows;
    return { company: companyRow, visibleUnits: rows as OrganizationUnitSummary[] };
  }

  private async contextIn(client: PoolClient, actor: TeamActor): Promise<Result<TeamContext>> {
    const team = await this.teamForUser(client, actor);
    const teamManageable = team ? await this.canManageInvitation(client, actor, team.teamId) : false;
    const invitations = await this.invitations(client, actor, team?.teamId ?? null, teamManageable);
    const allAdminTeams = manager(actor) ? treeOrder(await this.adminTeamRows(client)) : [];
    const managedTeams = manager(actor)
      ? allAdminTeams
      : actor.roles.includes('sales')
        ? treeOrder(await this.adminTeamRows(client, "AND EXISTS(SELECT 1 FROM crm_org_assignments a WHERE a.unit_id=u.unit_id AND a.user_id=$1 AND a.role='leader' AND a.ended_at IS NULL)", [actor.userId]))
        : [];
    return success({
      team,
      managedTeams,
      incomingInvitations: invitations.incoming,
      outgoingInvitations: invitations.outgoing,
      canCreate: manager(actor) || (!team && actor.roles.includes('sales')),
      canAdmin: manager(actor),
      isSuperAdmin: superAdmin(actor),
      adminTeams: allAdminTeams,
      organization: await this.organizationContext(client, actor),
    });
  }

  context(tokenHash: string): Promise<Result<TeamContext>> {
    return this.authorized(tokenHash, (client, actor) => this.contextIn(client, actor));
  }

  detail(tokenHash: string, teamId: string): Promise<Result<TeamDetail>> {
    return this.authorized(tokenHash, async (client, actor) => {
      const own = await this.assignment(client, actor.userId, teamId);
      if (!manager(actor) && !own) return failure('NOT_FOUND', '团队不存在');
      const found = await this.teamById(client, teamId, actor);
      if (!found || found.row.organizationKind === 'company') return failure('NOT_FOUND', '团队不存在');
      const canManage = await this.canManageUnit(client, actor, teamId);
      const invitations = await this.invitations(client, actor, teamId, await this.canManageInvitation(client, actor, teamId));
      const allTeams = canManage ? treeOrder(await this.adminTeamRows(client)) : [];
      const children = found.row.organizationKind === 'operations_group'
        ? allTeams.filter(row => row.unitType === 'sales_team' && (row.assignmentSourceTeamIds ?? []).includes(teamId))
        : allTeams.filter(row => row.parentTeamId === teamId);
      return success({ team: found.team, outgoingInvitations: invitations.outgoing, children });
    });
  }

  candidates(tokenHash: string, query: TeamMemberCandidateQuery): Promise<Result<TeamMemberCandidatePage>> {
    return this.authorized(tokenHash, async (client, actor) => {
      const leads = (await client.query("SELECT 1 FROM crm_org_assignments WHERE user_id=$1 AND role='leader' AND ended_at IS NULL LIMIT 1", [actor.userId])).rows.length > 0;
      const role = query.role ?? 'member';
      const kind: OrganizationUnitKind = role === 'leader' && query.unitType === 'operations' ? 'operations_group' : 'sales_team';
      if (role === 'leader' && !manager(actor)) return failure('FORBIDDEN', '只有管理角色可以调整负责人');
      const creatingSalesTeam = query.purpose === 'create' && role === 'member';
      if (creatingSalesTeam && !manager(actor)) {
        const assignments = await this.assignmentsForUser(client, actor.userId);
        if (assignments.some(item => item.role === 'member')) return failure('CONFLICT', '当前账号已经加入销售团队');
      }
      if (role === 'member' && !manager(actor) && !leads && !creatingSalesTeam) return failure('FORBIDDEN', '只有团队负责人可以邀请成员');
      const search = `%${query.search.replace(/[!%_]/g, '!$&')}%`;
      const access = "u.active AND NOT u.must_change_password AND EXISTS(SELECT 1 FROM public.identity_product_access a WHERE a.user_id=u.user_id AND a.product_id='crm' AND a.active)";
      const searchable = "(u.display_name ILIKE $1 ESCAPE '!' OR COALESCE(e.email,'') ILIKE $1 ESCAPE '!')";
      const activeRoles = "(SELECT array_agg(g.role ORDER BY g.role) FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active)";
      const salesOnly = `NOT u.identity_admin AND ${activeRoles}=ARRAY['sales']::text[]`;
      const operationsOnly = `NOT u.identity_admin AND ${activeRoles}=ARRAY['operations']::text[]`;
      const filter = role === 'leader'
        ? kind === 'sales_team'
          ? `WHERE ${access} AND ${salesOnly} AND NOT EXISTS(SELECT 1 FROM crm_org_assignments a WHERE a.user_id=u.user_id AND a.role='member' AND a.ended_at IS NULL) AND ${searchable}`
          : `WHERE ${access} AND ${operationsOnly} AND ${searchable}`
        : `WHERE ${access} AND u.user_id<>$2 AND ${salesOnly} AND NOT EXISTS(SELECT 1 FROM crm_org_assignments a WHERE a.user_id=u.user_id AND a.ended_at IS NULL) AND ${searchable}`;
      const count = await client.query(`SELECT count(*)::int AS count FROM public.identity_users u LEFT JOIN public.identity_login_emails e USING(user_id) ${filter}`, role === 'member' ? [search, actor.userId] : [search]);
      const leaderCount = role === 'leader' ? `,(SELECT count(*)::int FROM crm_org_assignments la JOIN crm_org_units lu ON lu.unit_id=la.unit_id WHERE la.user_id=u.user_id AND la.role='leader' AND la.ended_at IS NULL AND lu.kind='${kind}' AND lu.dissolved_at IS NULL) AS "leaderTeamCount"` : '';
      const items = (await client.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",e.email${leaderCount} FROM public.identity_users u LEFT JOIN public.identity_login_emails e USING(user_id) ${filter} ORDER BY CASE WHEN u.user_id=$2 THEN 0 ELSE 1 END,u.display_name,u.user_id LIMIT $3 OFFSET $4`, [search, actor.userId, query.limit, query.offset])).rows as TeamMemberCandidatePage['items'];
      return success({ items, total: count.rows[0].count });
    });
  }

  private async assignmentsForUser(client: PoolClient, userId: string): Promise<AssignmentRow[]> {
    return (await client.query('SELECT unit_id AS "unitId",role,is_primary AS "isPrimary" FROM crm_org_assignments WHERE user_id=$1 AND ended_at IS NULL', [userId])).rows as AssignmentRow[];
  }

  private async hasPrimary(client: PoolClient, unitId: string): Promise<boolean> {
    return (await client.query("SELECT 1 FROM crm_org_assignments WHERE unit_id=$1 AND role='leader' AND is_primary AND ended_at IS NULL LIMIT 1", [unitId])).rows.length > 0;
  }

  private async insertAssignment(client: PoolClient, userId: string, unitId: string, kind: OrganizationUnitKind, role: OrganizationAssignmentRole): Promise<Result<void>> {
    const existing = await this.assignmentsForUser(client, userId);
    const rule = canCreateOrganizationAssignment(kind, role, existing, unitId);
    if (!rule.allowed) return failure('CONFLICT', rule.reason ?? '成员关系冲突');
    const primary = role === 'leader' && !(await this.hasPrimary(client, unitId));
    await client.query('INSERT INTO crm_org_assignments(user_id,unit_id,role,is_primary) VALUES($1,$2,$3,$4)', [userId, unitId, role, primary]);
    return success(undefined);
  }

  private async validLeader(client: PoolClient, userId: string, kind: OrganizationUnitKind): Promise<boolean> {
    const row = (await client.query(`SELECT u.identity_admin AS "identityAdmin",ARRAY(SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active ORDER BY g.role) AS roles FROM public.identity_users u WHERE u.user_id=$1 AND u.active AND NOT u.must_change_password AND EXISTS(SELECT 1 FROM public.identity_product_access a WHERE a.user_id=u.user_id AND a.product_id='crm' AND a.active)`, [userId])).rows[0];
    if (!row) return false;
    const roles = row.roles as CrmRole[];
    return kind === 'sales_team'
      ? !row.identityAdmin && roles.length === 1 && roles[0] === 'sales'
      : !row.identityAdmin && roles.length === 1 && roles[0] === 'operations';
  }

  private async validInvitees(client: PoolClient, userIds: string[]): Promise<boolean> {
    if (!userIds.length) return true;
    const row = (await client.query(`SELECT count(*)::int AS count FROM public.identity_users u WHERE u.user_id=ANY($1::uuid[]) AND u.active AND NOT u.must_change_password AND NOT u.identity_admin AND EXISTS(SELECT 1 FROM public.identity_product_access a WHERE a.user_id=u.user_id AND a.product_id='crm' AND a.active) AND (SELECT array_agg(g.role ORDER BY g.role) FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active)=ARRAY['sales']::text[] AND NOT EXISTS(SELECT 1 FROM crm_org_assignments a WHERE a.user_id=u.user_id AND a.ended_at IS NULL)`, [userIds])).rows[0];
    return row.count === userIds.length;
  }

  private async cache<T>(client: PoolClient, actorId: string, operation: string, key: string, input: unknown): Promise<{ state: 'new' | 'replay' | 'conflict'; digest: string; response?: T }> {
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const old = (await client.query('SELECT digest,response FROM crm_org_idempotency WHERE actor_id=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE', [actorId, operation, key])).rows[0];
    if (!old) return { state: 'new', digest };
    if (old.digest !== digest) return { state: 'conflict', digest };
    return { state: 'replay', digest, response: old.response as T };
  }

  private remember(client: PoolClient, actorId: string, operation: string, key: string, digest: string, response: unknown) {
    return client.query('INSERT INTO crm_org_idempotency(actor_id,operation,idempotency_key,digest,response) VALUES($1,$2,$3,$4,$5)', [actorId, operation, key, digest, JSON.stringify(response)]);
  }

  create(tokenHash: string, input: TeamCreateInput): Promise<Result<TeamCreateReceipt>> {
    return this.authorizedTransaction(tokenHash, async (client, actor) => {
      const cached = await this.cache<TeamCreateReceipt>(client, actor.userId, 'organization.create', input.idempotencyKey, input);
      if (cached.state === 'replay' && cached.response) return success(cached.response);
      if (cached.state === 'conflict') return failure('CONFLICT', '幂等键已用于不同请求');
      const kind: OrganizationUnitKind = (input.unitType ?? DEFAULT_TEAM_UNIT_TYPE) === 'operations' ? 'operations_group' : 'sales_team';
      const admin = superAdmin(actor);
      const roleAllowsKind = admin
        || kind === 'operations_group' && actor.roles.includes('operations')
        || kind === 'sales_team' && actor.roles.includes('sales');
      if (!roleAllowsKind) return failure('FORBIDDEN', kind === 'operations_group' ? '只有运营账号可以创建运营组' : '只有销售账号可以创建销售团队');
      if (kind === 'sales_team' && input.parentTeamId) return failure('INVALID_INPUT', '销售团队不能挂在运营组；请通过分配线索建立团队关系');
      if (!admin && input.leaderUserId && input.leaderUserId !== actor.userId) return failure('FORBIDDEN', '只能把当前账号设为负责人');
      if (admin && !input.leaderUserId) return failure('INVALID_INPUT', '管理角色创建组织时必须明确指定负责人');
      const leaderUserId = admin ? input.leaderUserId! : actor.userId;
      if (!admin && (await this.assignmentsForUser(client, actor.userId)).some(item => item.role === 'member')) return failure('CONFLICT', '当前账号已经加入销售团队');
      if (input.inviteeUserIds.includes(leaderUserId)) return failure('INVALID_INPUT', '负责人不能同时作为受邀普通成员');
      if (!(await this.validLeader(client, leaderUserId, kind))) return failure('INVALID_INPUT', kind === 'sales_team' ? '销售团队负责人必须是可用销售账号' : '运营组负责人必须是管理账号');
      const company = (await client.query("SELECT unit_id AS \"unitId\" FROM crm_org_units WHERE kind='company' AND dissolved_at IS NULL")).rows[0] as { unitId: string } | undefined;
      if (!company) return failure('DATABASE_ERROR', '组织根不存在');
      const parentUnitId = input.parentTeamId ?? company.unitId;
      const parent = await this.unit(client, parentUnitId);
      if (!parent) return failure('NOT_FOUND', '上级组织不存在');
      if (!canPlaceOrganizationUnit(parent.kind, kind)) return failure('INVALID_INPUT', '组织层级不符合公司、运营组、销售团队规则');
      if (kind !== 'sales_team' && input.inviteeUserIds.length) return failure('INVALID_INPUT', '运营组不接受普通成员邀请');
      const name = input.name.trim();
      if ((await client.query('SELECT 1 FROM crm_org_units WHERE parent_unit_id=$1 AND lower(btrim(name))=lower(btrim($2)) AND dissolved_at IS NULL', [parentUnitId, name])).rows.length) return failure('CONFLICT', '同一层级已存在同名组织');
      if (!(await this.validInvitees(client, input.inviteeUserIds))) return failure('INVALID_INPUT', '邀请成员已有归属或不可用');
      const teamId = randomUUID();
      await client.query('INSERT INTO crm_org_units(unit_id,kind,parent_unit_id,name,created_by) VALUES($1,$2,$3,$4,$5)', [teamId, kind, parentUnitId, name, actor.userId]);
      const assigned = await this.insertAssignment(client, leaderUserId, teamId, kind, 'leader');
      if (!assigned.ok) return assigned;
      for (const inviteeUserId of input.inviteeUserIds) await client.query("INSERT INTO crm_org_invitations(invitation_id,unit_id,inviter_user_id,invitee_user_id) VALUES($1,$2,$3,$4)", [randomUUID(), teamId, actor.userId, inviteeUserId]);
      const context = await this.contextIn(client, actor);
      if (!context.ok) return context;
      const receipt = { teamId, context: context.data };
      await this.remember(client, actor.userId, 'organization.create', input.idempotencyKey, cached.digest, receipt);
      return success(receipt);
    });
  }

  invite(tokenHash: string, teamId: string, input: TeamInviteInput): Promise<Result<TeamContext>> {
    return this.authorizedTransaction(tokenHash, async (client, actor) => {
      const operation = `organization.invite:${teamId}`;
      const cached = await this.cache<TeamContext>(client, actor.userId, operation, input.idempotencyKey, input);
      if (cached.state === 'replay' && cached.response) return success(cached.response);
      if (cached.state === 'conflict') return failure('CONFLICT', '幂等键已用于不同请求');
      const team = (await client.query('SELECT unit_id AS "unitId",kind FROM crm_org_units WHERE unit_id=$1 AND dissolved_at IS NULL FOR UPDATE', [teamId])).rows[0] as { unitId: string; kind: OrganizationUnitKind } | undefined;
      if (!team) return failure('NOT_FOUND', '团队不存在');
      if (!teamAcceptsMembers(team.kind === 'operations_group' ? 'operations' : 'sales_team')) return failure('INVALID_INPUT', '运营组不接受成员邀请');
      if (!(await this.canManageUnit(client, actor, teamId))) return failure('FORBIDDEN', '只有团队负责人可以邀请成员');
      if (!(await this.validInvitees(client, input.userIds))) return failure('INVALID_INPUT', '邀请成员已有归属或不可用');
      for (const inviteeUserId of input.userIds) await client.query("INSERT INTO crm_org_invitations(invitation_id,unit_id,inviter_user_id,invitee_user_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [randomUUID(), teamId, actor.userId, inviteeUserId]);
      const context = await this.contextIn(client, actor);
      if (!context.ok) return context;
      await this.remember(client, actor.userId, operation, input.idempotencyKey, cached.digest, context.data);
      return success(context.data);
    });
  }

  decide(tokenHash: string, invitationId: string, action: 'accept' | 'decline' | 'cancel', input: TeamInvitationDecision): Promise<Result<TeamContext>> {
    return this.authorizedTransaction(tokenHash, async (client, actor) => {
      const operation = `organization.invitation.${action}:${invitationId}`;
      const cached = await this.cache<TeamContext>(client, actor.userId, operation, input.idempotencyKey, input);
      if (cached.state === 'replay' && cached.response) return success(cached.response);
      if (cached.state === 'conflict') return failure('CONFLICT', '幂等键已用于不同请求');
      const row = (await client.query(`SELECT i.invitation_id AS "invitationId",i.unit_id AS "teamId",i.inviter_user_id AS "inviterUserId",i.invitee_user_id AS "inviteeUserId",i.status,i.version,i.expires_at AS "expiresAt",i.expires_at<=clock_timestamp() AS expired,u.kind FROM crm_org_invitations i JOIN crm_org_units u ON u.unit_id=i.unit_id AND u.dissolved_at IS NULL WHERE i.invitation_id=$1 FOR UPDATE OF i,u`, [invitationId])).rows[0] as DecisionInvitationRow | undefined;
      if (!row) return failure('NOT_FOUND', '邀请不存在');
      const desired = action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled';
      const allowed = action === 'cancel' ? (await this.canManageInvitation(client, actor, row.teamId)) : row.inviteeUserId === actor.userId;
      if (!allowed) return failure('NOT_FOUND', '邀请不存在或无权处理');
      if (row.status === 'pending' && row.expired) {
        await client.query("UPDATE crm_org_invitations SET status='expired',version=version+1,decided_at=now() WHERE invitation_id=$1", [invitationId]);
        const expired = await this.contextIn(client, actor);
        if (!expired.ok) return expired;
        await this.remember(client, actor.userId, operation, input.idempotencyKey, cached.digest, expired.data);
        return success(expired.data);
      }
      if (row.status === desired) return this.contextIn(client, actor);
      if (row.status !== 'pending') return failure('CONFLICT', '邀请已处理');
      if (row.version !== input.expectedVersion) return failure('CONFLICT', '邀请版本已变化');
      if (action === 'accept') {
        if (row.kind !== 'sales_team') return failure('INVALID_INPUT', '运营组不接受普通成员');
        if (!(await this.validInvitees(client, [actor.userId]))) return failure('INVALID_INPUT', '成员已有归属或账号角色不符合普通成员要求');
        const assigned = await this.insertAssignment(client, actor.userId, row.teamId, row.kind, 'member');
        if (!assigned.ok) return assigned;
      }
      await client.query('UPDATE crm_org_invitations SET status=$2,version=version+1,decided_at=now() WHERE invitation_id=$1', [invitationId, desired]);
      const context = await this.contextIn(client, actor);
      if (!context.ok) return context;
      await this.remember(client, actor.userId, operation, input.idempotencyKey, cached.digest, context.data);
      return success(context.data);
    });
  }

  move(tokenHash: string, teamId: string, input: TeamMoveInput): Promise<Result<TeamContext>> {
    return this.authorizedTransaction(tokenHash, async (client, actor) => {
      const operation = `organization.move:${teamId}`;
      const cached = await this.cache<TeamContext>(client, actor.userId, operation, input.idempotencyKey, input);
      if (cached.state === 'replay' && cached.response) return success(cached.response);
      if (cached.state === 'conflict') return failure('CONFLICT', '幂等键已用于不同请求');
      const current = (await client.query('SELECT unit_id AS "unitId",kind,parent_unit_id AS "parentUnitId",name,version FROM crm_org_units WHERE unit_id=$1 AND dissolved_at IS NULL FOR UPDATE', [teamId])).rows[0] as UnitRow | undefined;
      if (!current || current.kind === 'company') return failure('NOT_FOUND', '团队不存在');
      if (!(await this.canManageUnit(client, actor, teamId))) return failure('FORBIDDEN', '只有负责人或管理角色可以移动团队');
      if (current.version !== input.expectedVersion) return failure('CONFLICT', '团队版本已变化');
      const company = (await client.query("SELECT unit_id AS \"unitId\" FROM crm_org_units WHERE kind='company' AND dissolved_at IS NULL")).rows[0] as { unitId: string } | undefined;
      if (!company) return failure('DATABASE_ERROR', '组织根不存在');
      if (current.kind === 'sales_team' && input.parentTeamId && input.parentTeamId !== company.unitId) return failure('INVALID_INPUT', '销售团队不能挂在运营组；请通过分配线索建立团队关系');
      const parentUnitId = input.parentTeamId ?? company.unitId;
      const parent = await this.unit(client, parentUnitId);
      if (!parent || !canPlaceOrganizationUnit(parent.kind, current.kind)) return failure('INVALID_INPUT', '目标上级不符合组织层级');
      const ancestors = (await client.query(`WITH RECURSIVE chain AS (
        SELECT unit_id,parent_unit_id FROM crm_org_units WHERE unit_id=$1
        UNION ALL SELECT u.unit_id,u.parent_unit_id FROM crm_org_units u JOIN chain c ON u.unit_id=c.parent_unit_id
      ) SELECT COALESCE(array_agg(unit_id::text),'{}'::text[]) AS ids FROM chain`, [parentUnitId])).rows[0].ids as string[];
      if (createsOrganizationCycle(teamId, parentUnitId, ancestors)) return failure('INVALID_INPUT', '不能把组织移动到自身或下游');
      if ((await client.query('SELECT 1 FROM crm_org_units WHERE parent_unit_id=$1 AND lower(btrim(name))=lower(btrim($2)) AND unit_id<>$3 AND dissolved_at IS NULL', [parentUnitId, current.name, teamId])).rows.length) return failure('CONFLICT', '同一层级已存在同名组织');
      await client.query('UPDATE crm_org_units SET parent_unit_id=$2,version=version+1,updated_at=now() WHERE unit_id=$1', [teamId, parentUnitId]);
      const context = await this.contextIn(client, actor);
      if (!context.ok) return context;
      await this.remember(client, actor.userId, operation, input.idempotencyKey, cached.digest, context.data);
      return success(context.data);
    });
  }

  dissolve(tokenHash: string, teamId: string, input: TeamDissolveInput): Promise<Result<TeamContext>> {
    return this.authorizedTransaction(tokenHash, async (client, actor) => {
      const operation = `organization.dissolve:${teamId}`;
      const cached = await this.cache<TeamContext>(client, actor.userId, operation, input.idempotencyKey, input);
      if (cached.state === 'replay' && cached.response) return success(cached.response);
      if (cached.state === 'conflict') return failure('CONFLICT', '幂等键已用于不同请求');

      const current = (await client.query('SELECT unit_id AS "unitId",kind,parent_unit_id AS "parentUnitId",name,version,dissolved_at AS "dissolvedAt" FROM crm_org_units WHERE unit_id=$1 FOR UPDATE', [teamId])).rows[0] as UnitRow | undefined;
      if (!current || current.kind === 'company') return failure('NOT_FOUND', '团队不存在');
      if (current.dissolvedAt) return failure('CONFLICT', '团队已经解散');
      if (current.version !== input.expectedVersion) return failure('CONFLICT', '团队版本已变化');

      const assignment = await this.assignment(client, actor.userId, teamId);
      const childCount = Number((await client.query('SELECT count(*)::int AS count FROM crm_org_units WHERE parent_unit_id=$1 AND dissolved_at IS NULL', [teamId])).rows[0].count);
      const rule = canDissolveOrganizationUnit(current.kind, childCount, assignment?.role === 'leader' && assignment.isPrimary, manager(actor));
      if (!rule.allowed) {
        if (!manager(actor) && !(assignment?.role === 'leader' && assignment.isPrimary)) return failure('FORBIDDEN', rule.reason ?? '无权解散组织');
        return failure('CONFLICT', rule.reason ?? '组织暂不能解散');
      }

      const dissolvedAt = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at as Date;
      const ended = await client.query('UPDATE crm_org_assignments SET ended_at=$2,version=version+1,updated_at=$2 WHERE unit_id=$1 AND ended_at IS NULL', [teamId, dissolvedAt]);
      const cancelled = await client.query("UPDATE crm_org_invitations SET status='cancelled',version=version+1,decided_at=$2 WHERE unit_id=$1 AND status='pending'", [teamId, dissolvedAt]);
      await client.query('DELETE FROM crm_org_member_group_members WHERE unit_id=$1', [teamId]);
      await client.query('DELETE FROM crm_org_member_groups WHERE unit_id=$1', [teamId]);
      const updated = await client.query('UPDATE crm_org_units SET dissolved_at=$2,dissolved_by=$3,version=version+1,updated_at=$2 WHERE unit_id=$1 AND dissolved_at IS NULL RETURNING version', [teamId, dissolvedAt, actor.userId]);
      if (!updated.rowCount) return failure('CONFLICT', '团队已经解散');
      const nextVersion = Number(updated.rows[0].version);
      await client.query(`INSERT INTO crm_org_dissolution_audits(
        unit_id,actor_user_id,unit_kind,unit_name,unit_version,ended_assignment_count,cancelled_invitation_count,dissolved_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [teamId, actor.userId, current.kind, current.name, nextVersion, ended.rowCount ?? 0, cancelled.rowCount ?? 0, dissolvedAt]);

      const context = await this.contextIn(client, actor);
      if (!context.ok) return context;
      await this.remember(client, actor.userId, operation, input.idempotencyKey, cached.digest, context.data);
      return success(context.data);
    });
  }

  assignLeader(tokenHash: string, teamId: string, input: TeamLeaderInput): Promise<Result<TeamContext>> {
    return this.authorizedTransaction(tokenHash, async (client, actor) => {
      const operation = `organization.leader:${teamId}`;
      const cached = await this.cache<TeamContext>(client, actor.userId, operation, input.idempotencyKey, input);
      if (cached.state === 'replay' && cached.response) return success(cached.response);
      if (cached.state === 'conflict') return failure('CONFLICT', '幂等键已用于不同请求');
      const team = (await client.query('SELECT unit_id AS "unitId",kind,version FROM crm_org_units WHERE unit_id=$1 AND dissolved_at IS NULL FOR UPDATE', [teamId])).rows[0] as UnitRow | undefined;
      if (!team || team.kind === 'company') return failure('NOT_FOUND', '团队不存在');
      if (!(await this.canManageUnit(client, actor, teamId))) return failure('FORBIDDEN', '只有负责人或管理角色可以调整负责人');
      if (team.version !== input.expectedVersion) return failure('CONFLICT', '团队版本已变化');
      if (!(await this.validLeader(client, input.leaderUserId, team.kind))) return failure('INVALID_INPUT', team.kind === 'sales_team' ? '销售团队负责人必须是可用销售账号' : '运营组负责人必须是管理账号');
      const existingTarget = await this.assignment(client, input.leaderUserId, teamId);
      if (existingTarget?.role === 'member') {
        await client.query('DELETE FROM crm_org_member_group_members WHERE unit_id=$1 AND user_id=$2', [teamId, input.leaderUserId]);
        await client.query("DELETE FROM crm_org_assignments WHERE unit_id=$1 AND user_id=$2 AND role='member' AND ended_at IS NULL", [teamId, input.leaderUserId]);
      }
      if (team.kind === 'sales_team') await client.query("DELETE FROM crm_org_assignments WHERE unit_id=$1 AND role='leader' AND user_id<>$2 AND ended_at IS NULL", [teamId, input.leaderUserId]);
      if (!(await this.assignment(client, input.leaderUserId, teamId))) {
        const inserted = await this.insertAssignment(client, input.leaderUserId, teamId, team.kind, 'leader');
        if (!inserted.ok) return inserted;
      }
      await client.query("UPDATE crm_org_assignments SET is_primary=false WHERE unit_id=$1 AND role='leader' AND ended_at IS NULL", [teamId]);
      await client.query("UPDATE crm_org_assignments SET is_primary=true WHERE unit_id=$1 AND role='leader' AND user_id=$2 AND ended_at IS NULL", [teamId, input.leaderUserId]);
      await client.query('UPDATE crm_org_units SET version=version+1,updated_at=now() WHERE unit_id=$1', [teamId]);
      const context = await this.contextIn(client, actor);
      if (!context.ok) return context;
      await this.remember(client, actor.userId, operation, input.idempotencyKey, cached.digest, context.data);
      return success(context.data);
    });
  }

  adjustMember(tokenHash: string, teamId: string, input: TeamMemberAdjustmentInput): Promise<Result<TeamContext>> {
    return this.authorizedTransaction(tokenHash, async (client, actor) => {
      const operation = `organization.member.${input.action}:${teamId}:${input.userId}`;
      const cached = await this.cache<TeamContext>(client, actor.userId, operation, input.idempotencyKey, input);
      if (cached.state === 'replay' && cached.response) return success(cached.response);
      if (cached.state === 'conflict') return failure('CONFLICT', '幂等键已用于不同请求');
      const team = (await client.query('SELECT unit_id AS "unitId",kind,version FROM crm_org_units WHERE unit_id=$1 AND dissolved_at IS NULL FOR UPDATE', [teamId])).rows[0] as UnitRow | undefined;
      if (!team || team.kind !== 'sales_team') return failure('INVALID_INPUT', '只有销售团队可以调整普通成员');
      if (team.version !== input.expectedVersion) return failure('CONFLICT', '团队版本已变化');
      if (input.action === 'leave' && input.userId !== actor.userId) return failure('FORBIDDEN', '只能退出自己的团队');
      if (input.action !== 'leave' && !(await this.canManageUnit(client, actor, teamId))) return failure('FORBIDDEN', '只有负责人或管理角色可以调整成员');
      if (input.action === 'add') {
        if (!(await this.validInvitees(client, [input.userId]))) return failure('INVALID_INPUT', '成员已有归属或不可用');
        await client.query("INSERT INTO crm_org_invitations(invitation_id,unit_id,inviter_user_id,invitee_user_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [randomUUID(), teamId, actor.userId, input.userId]);
      } else {
        const existing = await this.assignment(client, input.userId, teamId);
        if (existing?.role !== 'member') return failure('NOT_FOUND', '团队成员不存在');
        await client.query('DELETE FROM crm_org_member_group_members WHERE unit_id=$1 AND user_id=$2', [teamId, input.userId]);
        await client.query("DELETE FROM crm_org_assignments WHERE unit_id=$1 AND user_id=$2 AND role='member' AND ended_at IS NULL", [teamId, input.userId]);
        await client.query('UPDATE crm_org_units SET version=version+1,updated_at=now() WHERE unit_id=$1', [teamId]);
      }
      const context = await this.contextIn(client, actor);
      if (!context.ok) return context;
      await this.remember(client, actor.userId, operation, input.idempotencyKey, cached.digest, context.data);
      return success(context.data);
    });
  }

  saveMemberGroup(tokenHash: string, teamId: string, input: TeamMemberGroupInput): Promise<Result<TeamContext>> {
    return this.authorizedTransaction(tokenHash, async (client, actor) => {
      const operation = `organization.group.save:${teamId}:${input.groupId ?? 'new'}`;
      const cached = await this.cache<TeamContext>(client, actor.userId, operation, input.idempotencyKey, input);
      if (cached.state === 'replay' && cached.response) return success(cached.response);
      if (cached.state === 'conflict') return failure('CONFLICT', '幂等键已用于不同请求');
      const team = (await client.query('SELECT unit_id AS "unitId",kind FROM crm_org_units WHERE unit_id=$1 AND dissolved_at IS NULL FOR UPDATE', [teamId])).rows[0] as UnitRow | undefined;
      if (!team || team.kind !== 'sales_team') return failure('INVALID_INPUT', '只有销售团队可以维护展示分组');
      if (!(await this.canManageUnit(client, actor, teamId))) return failure('FORBIDDEN', '只有负责人或管理角色可以维护展示分组');
      if (input.groupId) {
        const group = (await client.query('SELECT version FROM crm_org_member_groups WHERE group_id=$1 AND unit_id=$2 FOR UPDATE', [input.groupId, teamId])).rows[0];
        if (!group) return failure('NOT_FOUND', '展示分组不存在');
        if (group.version !== input.expectedVersion) return failure('CONFLICT', '展示分组版本已变化');
        await client.query('UPDATE crm_org_member_groups SET name=$2,version=version+1,updated_at=now() WHERE group_id=$1', [input.groupId, input.name.trim()]);
      } else if (input.expectedVersion !== 0) return failure('CONFLICT', '新展示分组版本必须为 0');
      if (input.memberIds.length) {
        const eligible = await client.query("SELECT count(*)::int AS count FROM crm_org_assignments WHERE unit_id=$1 AND role IN ('leader','member') AND user_id=ANY($2::uuid[]) AND ended_at IS NULL", [teamId, input.memberIds]);
        if (eligible.rows[0].count !== input.memberIds.length) return failure('INVALID_INPUT', '展示分组只能包含本团队负责人或普通成员');
        const occupied = await client.query('SELECT 1 FROM crm_org_member_group_members WHERE unit_id=$1 AND user_id=ANY($2::uuid[]) AND group_id<>$3 LIMIT 1', [teamId, input.memberIds, input.groupId ?? '00000000-0000-0000-0000-000000000000']);
        if (occupied.rows.length) return failure('CONFLICT', '成员已经在其他展示分组');
      }
      const groupId = input.groupId ?? randomUUID();
      if (!input.groupId) await client.query('INSERT INTO crm_org_member_groups(group_id,unit_id,name) VALUES($1,$2,$3)', [groupId, teamId, input.name.trim()]);
      await client.query('DELETE FROM crm_org_member_group_members WHERE group_id=$1', [groupId]);
      for (const memberId of input.memberIds) await client.query('INSERT INTO crm_org_member_group_members(group_id,unit_id,user_id) VALUES($1,$2,$3)', [groupId, teamId, memberId]);
      const context = await this.contextIn(client, actor);
      if (!context.ok) return context;
      await this.remember(client, actor.userId, operation, input.idempotencyKey, cached.digest, context.data);
      return success(context.data);
    });
  }

  deleteMemberGroup(tokenHash: string, teamId: string, groupId: string, input: TeamMemberGroupDeleteInput): Promise<Result<TeamContext>> {
    return this.authorizedTransaction(tokenHash, async (client, actor) => {
      const operation = `organization.group.delete:${teamId}:${groupId}`;
      const cached = await this.cache<TeamContext>(client, actor.userId, operation, input.idempotencyKey, input);
      if (cached.state === 'replay' && cached.response) return success(cached.response);
      if (cached.state === 'conflict') return failure('CONFLICT', '幂等键已用于不同请求');
      const group = (await client.query('SELECT version FROM crm_org_member_groups WHERE group_id=$1 AND unit_id=$2 FOR UPDATE', [groupId, teamId])).rows[0];
      if (!group) return failure('NOT_FOUND', '展示分组不存在');
      if (!(await this.canManageUnit(client, actor, teamId))) return failure('FORBIDDEN', '只有负责人或管理角色可以维护展示分组');
      if (group.version !== input.expectedVersion) return failure('CONFLICT', '展示分组版本已变化');
      await client.query('DELETE FROM crm_org_member_groups WHERE group_id=$1', [groupId]);
      const context = await this.contextIn(client, actor);
      if (!context.ok) return context;
      await this.remember(client, actor.userId, operation, input.idempotencyKey, cached.digest, context.data);
      return success(context.data);
    });
  }
}
