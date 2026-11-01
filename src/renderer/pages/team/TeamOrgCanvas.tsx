import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Drawer, Spin } from 'antd';
import { AlertCircle, ArrowLeft, Building2, ChevronRight, Clock3, Mail, Maximize2, Minus, Plus, ShieldCheck, UsersRound, X, ZoomIn, ZoomOut } from 'lucide-react';
import { ONLINE_CHANNELS, type OrganizationContext, type Result, type TeamAdminSummary, type TeamDetail, type TeamMember, type TeamMonitoringMailDetail, type TeamMonitoringMailSummary } from '../../../shared/online-crm';
import { useIdentity } from '../../IdentityContext';
import { TeamMonitoringMemberDetail } from './TeamMonitoringMemberDetail';
import { layoutTeamTree, pathToTeam, TEAM_NODE_HEIGHT, TEAM_NODE_WIDTH } from './team-admin-layout';

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.2;
const MAX_FIT_ZOOM = 1.1;
const ZOOM_STEP = 0.12;
const FIT_PADDING = 28;
const WHEEL_ZOOM_RATE = 0.0015;
const PAN_CLICK_THRESHOLD = 3;
const FRONTEND_SUPERADMIN_TEAM_ID = 'frontend-superadmins';
const EXPANDED_HEADING_HEIGHT = 30;
const EXPANDED_ROW_HEIGHT = 34;
const MAX_EXPANDED_ROWS = 4;
const EXPANDED_PADDING = 10;
const MONITORING_MAIL_PAGE_SIZE = 10;

type CanvasPoint = { x: number; y: number };

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function isSuperAdminIdentity(identity: ReturnType<typeof useIdentity>['identity']): boolean {
  return !!identity && (identity.identityAdmin || identity.crmRoles.includes('admin'));
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  return window.api.invoke(channel, ...args) as Promise<Result<T>>;
}

function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

export function TeamOrgCanvas({ teams, organization, detail, detailLoading, selectedTeamId, search, onSelect }: {
  teams: readonly TeamAdminSummary[];
  organization?: OrganizationContext;
  detail?: TeamDetail;
  detailLoading: boolean;
  selectedTeamId: string | null;
  search: string;
  onSelect: (teamId: string | null) => void;
}) {
  const { identity, status } = useIdentity();
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number; origin: CanvasPoint; moved: boolean; pointerId: number } | null>(null);
  const suppressClickRef = useRef(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<CanvasPoint>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const fittedRef = useRef(false);
  const [collapsedTeamIds, setCollapsedTeamIds] = useState<Set<string>>(() => new Set());
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(selectedTeamId);
  const [focusedMember, setFocusedMember] = useState<TeamMember | null>(null);
  const [mailDetail, setMailDetail] = useState<TeamMonitoringMailDetail | null>(null);
  const [mailLoading, setMailLoading] = useState(false);
  const [mailError, setMailError] = useState('');
  const superAdminViewer = isSuperAdminIdentity(identity);
  const company = organization?.company;

  const displayTeams = useMemo(() => {
    const virtualId = FRONTEND_SUPERADMIN_TEAM_ID;
    const companyId = company?.unitId;
    const virtual: TeamAdminSummary = {
      teamId: virtualId,
      name: '超级管理员',
      parentTeamId: null,
      parentTeamName: null,
      depth: 0,
      childCount: companyId ? 1 : teams.filter(team => !team.parentTeamId).length,
      leaderName: superAdminViewer ? identity?.displayName ?? '超级管理员' : '超级管理员',
      memberCount: superAdminViewer ? 1 : 0,
      pendingInvitationCount: 0,
      createdAt: new Date(0).toISOString(),
    };
    const companyNode: TeamAdminSummary | null = company ? {
      teamId: company.unitId,
      name: company.name,
      organizationKind: 'company',
      parentTeamId: virtualId,
      parentTeamName: virtual.name,
      depth: 1,
      childCount: teams.filter(team => team.parentTeamId === company.unitId).length,
      leaderName: '组织根',
      memberCount: 0,
      pendingInvitationCount: 0,
      createdAt: new Date(0).toISOString(),
    } : null;
    const real = teams.map(team => {
      const parentKnown = !!team.parentTeamId && (team.parentTeamId === companyId || teams.some(candidate => candidate.teamId === team.parentTeamId));
      const parentTeamId = parentKnown ? team.parentTeamId : companyId ?? virtualId;
      return { ...team, parentTeamId };
    });
    const byId = new Map<string, TeamAdminSummary>();
    if (companyNode) byId.set(companyNode.teamId, companyNode);
    for (const team of real) byId.set(team.teamId, team);
    const rootParent = companyId ?? virtualId;
    for (const team of real) {
      if (!team.parentTeamId) team.parentTeamId = rootParent;
    }
    const depthOf = (team: TeamAdminSummary, seen = new Set<string>()): number => {
      if (team.teamId === virtualId) return 0;
      if (!team.parentTeamId || seen.has(team.teamId)) return 1;
      if (team.parentTeamId === companyId) return 2;
      const parent = byId.get(team.parentTeamId);
      if (!parent) return 1;
      seen.add(team.teamId);
      return depthOf(parent, seen) + 1;
    };
    virtual.depth = 0;
    if (companyNode) companyNode.depth = 1;
    for (const team of real) team.depth = depthOf(team);
    return [virtual, ...(companyNode ? [companyNode] : []), ...real];
  }, [company, identity?.displayName, superAdminViewer, teams]);

  const expandedDetail = detail?.team.teamId === expandedTeamId ? detail : undefined;
  const companyChildren = company ? displayTeams.filter(team => team.parentTeamId === company.unitId) : [];
  const nodeHeights = useMemo(() => {
    const heights = new Map<string, number>();
    for (const team of displayTeams) {
      let added = 0;
      if (expandedTeamId === team.teamId) {
        if (team.teamId === FRONTEND_SUPERADMIN_TEAM_ID) added = EXPANDED_HEADING_HEIGHT + EXPANDED_ROW_HEIGHT + EXPANDED_PADDING;
        else if (team.organizationKind === 'company') added = EXPANDED_HEADING_HEIGHT + Math.min(Math.max(companyChildren.length, 1), MAX_EXPANDED_ROWS) * EXPANDED_ROW_HEIGHT + EXPANDED_PADDING;
        else if (detailLoading) added = EXPANDED_HEADING_HEIGHT + EXPANDED_ROW_HEIGHT + EXPANDED_PADDING;
        else if (expandedDetail) added = EXPANDED_HEADING_HEIGHT + Math.min(Math.max(expandedDetail.team.members.length, 1), MAX_EXPANDED_ROWS) * EXPANDED_ROW_HEIGHT + EXPANDED_PADDING;
      }
      heights.set(team.teamId, TEAM_NODE_HEIGHT + added);
    }
    return heights;
  }, [companyChildren.length, detailLoading, expandedDetail, expandedTeamId, displayTeams]);
  const layout = useMemo(() => layoutTeamTree(displayTeams, collapsedTeamIds, nodeHeights), [displayTeams, collapsedTeamIds, nodeHeights]);
  const selectedPath = useMemo(() => selectedTeamId ? pathToTeam(displayTeams, selectedTeamId) : new Set<string>(), [selectedTeamId, displayTeams]);
  const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN');

  const zoomAt = (nextValue: number, anchor: CanvasPoint) => {
    const nextZoom = clampZoom(nextValue);
    const currentZoom = zoomRef.current;
    if (nextZoom === currentZoom) return;
    const currentPan = panRef.current;
    const nextPan = {
      x: anchor.x - ((anchor.x - currentPan.x) / currentZoom) * nextZoom,
      y: anchor.y - ((anchor.y - currentPan.y) / currentZoom) * nextZoom,
    };
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
  };
  const zoomAtCenter = (nextZoom: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    zoomAt(nextZoom, { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 });
  };
  const fit = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const availableWidth = Math.max(1, viewport.clientWidth - FIT_PADDING);
    const availableHeight = Math.max(1, viewport.clientHeight - FIT_PADDING);
    const nextZoom = clampZoom(Math.min(MAX_FIT_ZOOM, availableWidth / layout.width, availableHeight / layout.height));
    const nextPan = {
      x: (viewport.clientWidth - layout.width * nextZoom) / 2,
      y: (viewport.clientHeight - layout.height * nextZoom) / 2,
    };
    zoomRef.current = nextZoom;
    panRef.current = nextPan;
    setZoom(nextZoom);
    setPan(nextPan);
  };
  const toggleCollapsed = (teamId: string) => setCollapsedTeamIds(current => {
    const next = new Set(current);
    if (next.has(teamId)) next.delete(teamId);
    else next.add(teamId);
    return next;
  });

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);
  useLayoutEffect(() => {
    if (fittedRef.current) return;
    fittedRef.current = true;
    fit();
  }, [layout.height, layout.width]);
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      const nextZoom = clampZoom(zoomRef.current * Math.exp(-event.deltaY * WHEEL_ZOOM_RATE));
      zoomAt(nextZoom, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    setFocusedMember(null);
    setMailDetail(null);
    setMailError('');
  }, [expandedTeamId]);

  useEffect(() => {
    setMailDetail(null);
    setMailError('');
  }, [focusedMember?.userId]);

  const openMonitoringMail = async (mail: TeamMonitoringMailSummary) => {
    setMailDetail(null);
    setMailError('');
    setMailLoading(true);
    const result = await invoke<TeamMonitoringMailDetail>(ONLINE_CHANNELS.TEAM_MONITORING_MAIL, mail.eventId, mail.contactId, mail.customerId);
    setMailLoading(false);
    if (result.ok) setMailDetail(result.data);
    else setMailError(result.error.message);
  };

  const selectNode = (team: TeamAdminSummary) => {
    const frontendNode = team.teamId === FRONTEND_SUPERADMIN_TEAM_ID || team.organizationKind === 'company';
    setFocusedMember(null);
    setExpandedTeamId(team.teamId);
    onSelect(frontendNode ? null : team.teamId);
  };

  const virtualMembers: TeamMember[] = identity && superAdminViewer ? [{
    userId: identity.userId,
    displayName: identity.displayName,
    email: identity.email,
    role: 'leader',
    joinedAt: new Date(0).toISOString(),
  }] : [];

  return <section className="team-admin-canvas-panel">
    <div className="team-admin-canvas-toolbar">
      <div><h2>组织关系</h2><span>{teams.length} 个团队</span></div>
      <div className="team-admin-canvas-actions">
        <button type="button" onClick={() => zoomAtCenter(zoom - ZOOM_STEP)} disabled={zoom <= MIN_ZOOM} aria-label="缩小" title="缩小"><ZoomOut aria-hidden="true" /></button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => zoomAtCenter(zoom + ZOOM_STEP)} disabled={zoom >= MAX_ZOOM} aria-label="放大" title="放大"><ZoomIn aria-hidden="true" /></button>
        <button type="button" onClick={fit} aria-label="适配视图" title="适配视图"><Maximize2 aria-hidden="true" /></button>
      </div>
    </div>
    <div
      ref={viewportRef}
      className={`team-admin-canvas-viewport${panning ? ' is-panning' : ''}`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        const viewport = viewportRef.current;
        if (!viewport) return;
        dragRef.current = { x: event.clientX, y: event.clientY, origin: panRef.current, moved: false, pointerId: event.pointerId };
        suppressClickRef.current = false;
        setPanning(true);
      }}
      onPointerMove={event => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) >= PAN_CLICK_THRESHOLD) {
          drag.moved = true;
          viewportRef.current?.setPointerCapture(drag.pointerId);
        }
        const nextPan = { x: drag.origin.x + dx, y: drag.origin.y + dy };
        panRef.current = nextPan;
        setPan(nextPan);
      }}
      onPointerUp={event => {
        suppressClickRef.current = dragRef.current?.moved ?? false;
        dragRef.current = null;
        const viewport = viewportRef.current;
        if (viewport?.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
        setPanning(false);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        suppressClickRef.current = false;
        setPanning(false);
      }}
      onClickCapture={event => {
        if (!suppressClickRef.current) return;
        suppressClickRef.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="team-admin-canvas-stage" style={{ width: layout.width, height: layout.height, transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})` }}>
        <svg className="team-admin-canvas-lines" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map(edge => {
            const midY = edge.y1 + (edge.y2 - edge.y1) / 2;
            const active = selectedPath.has(edge.parentId) && selectedPath.has(edge.childId);
            return <path key={`${edge.parentId}:${edge.childId}`} className={active ? 'is-active' : undefined} d={`M ${edge.x1} ${edge.y1} V ${midY} H ${edge.x2} V ${edge.y2}`} />;
          })}
        </svg>
        {layout.nodes.map(team => {
          const superAdminNode = team.teamId === FRONTEND_SUPERADMIN_TEAM_ID;
          const companyNode = team.organizationKind === 'company';
          const hasChildren = displayTeams.some(candidate => candidate.parentTeamId === team.teamId);
          const isCollapsed = collapsedTeamIds.has(team.teamId);
          const isExpanded = expandedTeamId === team.teamId;
          const matches = normalizedSearch.length > 0 && [team.name, team.leaderName].some(value => value.toLocaleLowerCase('zh-CN').includes(normalizedSearch));
          const members = superAdminNode ? virtualMembers : expandedDetail?.team.members ?? [];
          return <article
            key={team.teamId}
            className={`team-admin-org-node${selectedTeamId === team.teamId || isExpanded ? ' is-selected' : ''}${matches ? ' is-match' : ''}${selectedPath.has(team.teamId) ? ' is-path' : ''}${isExpanded ? ' is-expanded' : ''}${superAdminNode ? ' is-superadmin' : ''}${companyNode ? ' is-company' : ''}`}
            style={{ left: team.x, top: team.y, width: TEAM_NODE_WIDTH, height: team.height }}
          >
            <button type="button" className="team-admin-org-node-main" aria-expanded={isExpanded} onClick={() => selectNode(team)}>
              <span className="team-admin-org-icon">{superAdminNode ? <ShieldCheck aria-hidden="true" /> : companyNode ? <Building2 aria-hidden="true" /> : <UsersRound aria-hidden="true" />}</span>
              <span className="team-admin-org-node-copy"><strong>{team.name}</strong><span className="team-admin-org-leader"><em>{superAdminNode ? '系统' : companyNode ? '组织' : '群主'}</em><span>{team.leaderName}</span></span></span>
              <ChevronRight aria-hidden="true" />
            </button>
            <div className="team-admin-org-node-meta">{!companyNode && <span>{team.memberCount} 人</span>}{team.childCount > 0 && <span>{team.childCount} 个下级</span>}{team.pendingInvitationCount > 0 && <span>{team.pendingInvitationCount} 待接受</span>}</div>
            {isExpanded && <div className="team-admin-org-expanded">
              <div className="team-admin-org-expanded-heading"><span>{companyNode ? '下级组织' : '成员'}</span><small>{companyNode ? companyChildren.length : team.memberCount}</small></div>
              {companyNode ? companyChildren.length === 0
                ? <div className="team-admin-org-expanded-state">暂无下级组织</div>
                : <div className="team-admin-org-member-scroll">{companyChildren.map(child => <button key={child.teamId} type="button" className="team-admin-org-member-row" onClick={() => selectNode(child)}>
                  <span className="team-admin-org-member-avatar">{initial(child.name)}</span><span><strong>{child.name}</strong><small>{child.leaderName}</small></span><ChevronRight aria-hidden="true" />
                </button>)}</div>
                : superAdminNode
                  ? virtualMembers.length === 0
                    ? <div className="team-admin-org-expanded-state">当前账号无可见成员</div>
                    : <div className="team-admin-org-member-scroll">{virtualMembers.map(member => <div key={member.userId} className="team-admin-org-member-row">
                      <span className="team-admin-org-member-avatar">{initial(member.displayName)}</span><span><strong>{member.displayName}</strong><small>{member.email || '超级管理员'}</small></span><ShieldCheck aria-hidden="true" />
                    </div>)}</div>
                  : detailLoading && expandedDetail?.team.teamId !== team.teamId
                    ? <div className="team-admin-org-expanded-state"><Spin size="small" /> 正在读取成员</div>
                    : !expandedDetail
                      ? <div className="team-admin-org-expanded-state">成员不可用</div>
                      : members.length === 0
                        ? <div className="team-admin-org-expanded-state">暂无成员</div>
                        : <div className="team-admin-org-member-scroll">{members.map(member => <button key={member.userId} type="button" className="team-admin-org-member-row" onClick={() => setFocusedMember(member)}>
                          <span className="team-admin-org-member-avatar">{initial(member.displayName)}</span><span><strong>{member.displayName}</strong><small>{member.role === 'leader' ? '群主' : '成员'}</small></span><ChevronRight aria-hidden="true" />
                        </button>)}</div>}
            </div>}
            {hasChildren && <button type="button" className="team-admin-org-node-toggle" onClick={() => toggleCollapsed(team.teamId)} aria-label={isCollapsed ? `展开 ${team.name}` : `收起 ${team.name}`} title={isCollapsed ? '展开下级' : '收起下级'}>{isCollapsed ? <Plus aria-hidden="true" /> : <Minus aria-hidden="true" />}</button>}
          </article>;
        })}
      </div>
    </div>
    <Drawer className="team-canvas-member-drawer" width={520} open={!!focusedMember} onClose={() => setFocusedMember(null)} closable={false} destroyOnHidden>
      {focusedMember && <TeamMonitoringMemberDetail userId={focusedMember.userId} online={status === 'authenticated'} onClose={() => setFocusedMember(null)} onOpenMail={mail => { void openMonitoringMail(mail); }} />}
      {mailLoading && <div className="team-monitoring-inline-state"><Spin size="small" /> 正在读取邮件摘要</div>}
      {mailError && <div className="team-monitoring-inline-state is-error"><AlertCircle aria-hidden="true" />{mailError}</div>}
      {mailDetail && <section className="team-canvas-mail-detail">
        <button type="button" className="team-canvas-mail-back" onClick={() => setMailDetail(null)}><ArrowLeft aria-hidden="true" />返回成员</button>
        <div className="team-canvas-mail-heading"><span><Mail aria-hidden="true" />{mailDetail.mail.classification || '邮件'}</span><button type="button" onClick={() => setMailDetail(null)} aria-label="关闭邮件详情" title="关闭"><X aria-hidden="true" /></button></div>
        <strong>{mailDetail.mail.subject || '无主题'}</strong>
        <small><Clock3 aria-hidden="true" />{new Date(mailDetail.mail.occurredAt).toLocaleString('zh-CN')}</small>
        <p>{mailDetail.mail.summary || '暂无结构化摘要'}</p>
        {mailDetail.mail.nextAction && <div><span>下一步</span><strong>{mailDetail.mail.nextAction}</strong></div>}
      </section>}
    </Drawer>
  </section>;
}
