import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Spin } from 'antd';
import { ChevronRight, Maximize2, Minus, Plus, UsersRound, ZoomIn, ZoomOut } from 'lucide-react';
import type { TeamAdminSummary, TeamDetail } from '../../../shared/online-crm';
import { effectiveTeamParentId, layoutTeamTree, pathToTeam, TEAM_NODE_HEIGHT, TEAM_NODE_WIDTH } from './team-admin-layout';

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.2;
const MAX_FIT_ZOOM = 1.1;
const ZOOM_STEP = 0.12;
const FIT_PADDING = 28;
const WHEEL_ZOOM_RATE = 0.0015;
const PAN_CLICK_THRESHOLD = 3;
const EXPANDED_HEADING_HEIGHT = 30;
const EXPANDED_ROW_HEIGHT = 34;
const MAX_EXPANDED_ROWS = 4;
const EXPANDED_PADDING = 10;
const MONITORING_MAIL_PAGE_SIZE = 10;

type CanvasPoint = { x: number; y: number };

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(value.toFixed(2))));
}

function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

export function TeamOrgCanvas({ teams, detail, detailLoading, selectedTeamId, search, onSelect }: {
  teams: readonly TeamAdminSummary[];
  detail?: TeamDetail;
  detailLoading: boolean;
  selectedTeamId: string | null;
  search: string;
  onSelect: (teamId: string | null) => void;
}) {
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
  const displayTeams = teams;
  const displayTeamIds = useMemo(() => new Set(displayTeams.map(team => team.teamId)), [displayTeams]);

  const expandedDetail = detail?.team.teamId === expandedTeamId ? detail : undefined;
  const nodeHeights = useMemo(() => {
    const heights = new Map<string, number>();
    for (const team of displayTeams) {
      let added = 0;
      if (expandedTeamId === team.teamId) {
        if (detailLoading) added = EXPANDED_HEADING_HEIGHT + EXPANDED_ROW_HEIGHT + EXPANDED_PADDING;
        else if (expandedDetail) added = EXPANDED_HEADING_HEIGHT + Math.min(Math.max(expandedDetail.team.members.length, 1), MAX_EXPANDED_ROWS) * EXPANDED_ROW_HEIGHT + EXPANDED_PADDING;
      }
      heights.set(team.teamId, TEAM_NODE_HEIGHT + added);
    }
    return heights;
  }, [detailLoading, expandedDetail, expandedTeamId, displayTeams]);
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

  const selectNode = (team: TeamAdminSummary) => {
    const collapsing = expandedTeamId === team.teamId;
    setExpandedTeamId(collapsing ? null : team.teamId);
    onSelect(collapsing ? null : team.teamId);
  };

  return <section className="team-admin-canvas-panel">
    <div className="team-admin-canvas-toolbar">
      <div><h2>团队关系</h2><span>{teams.length} 个团队</span></div>
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
          const hasChildren = displayTeams.some(candidate => effectiveTeamParentId(candidate, displayTeamIds) === team.teamId);
          const childCount = displayTeams.filter(candidate => effectiveTeamParentId(candidate, displayTeamIds) === team.teamId).length;
          const isCollapsed = collapsedTeamIds.has(team.teamId);
          const isExpanded = expandedTeamId === team.teamId;
          const matches = normalizedSearch.length > 0 && [team.name, team.leaderName].some(value => value.toLocaleLowerCase('zh-CN').includes(normalizedSearch));
          const members = expandedDetail?.team.members ?? [];
          return <article
            key={team.teamId}
            className={`team-admin-org-node${selectedTeamId === team.teamId || isExpanded ? ' is-selected' : ''}${matches ? ' is-match' : ''}${selectedPath.has(team.teamId) ? ' is-path' : ''}${isExpanded ? ' is-expanded' : ''}`}
            style={{ left: team.x, top: team.y, width: TEAM_NODE_WIDTH, height: team.height }}
          >
            <button type="button" className="team-admin-org-node-main" aria-expanded={isExpanded} onClick={() => selectNode(team)}>
              <span className="team-admin-org-icon"><UsersRound aria-hidden="true" /></span>
              <span className="team-admin-org-node-copy"><strong>{team.name}</strong><span className="team-admin-org-leader"><em>群主</em><span>{team.leaderName}</span></span></span>
              <ChevronRight aria-hidden="true" />
            </button>
            <div className="team-admin-org-node-meta"><span>{team.memberCount} 人</span>{team.unitType === 'sales_team' && (team.assignedLeadCount ?? 0) === 0 && <span className="is-warning">未分配线索</span>}{childCount > 0 && <span>{childCount} 个下级</span>}{team.pendingInvitationCount > 0 && <span>{team.pendingInvitationCount} 待接受</span>}</div>
            {isExpanded && <div className="team-admin-org-expanded">
              <div className="team-admin-org-expanded-heading"><span>成员</span><small>{team.memberCount}</small></div>
              {detailLoading && expandedDetail?.team.teamId !== team.teamId
                ? <div className="team-admin-org-expanded-state"><Spin size="small" /> 正在读取成员</div>
                : !expandedDetail
                  ? <div className="team-admin-org-expanded-state">成员不可用</div>
                  : members.length === 0
                    ? <div className="team-admin-org-expanded-state">暂无成员</div>
                    : <div className="team-admin-org-member-scroll">{members.map(member => <div key={member.userId} className="team-admin-org-member-row">
                      <span className="team-admin-org-member-avatar">{initial(member.displayName)}</span><span><strong>{member.displayName}</strong><small>{member.role === 'leader' ? '群主' : '成员'}</small></span>
                    </div>)}</div>}
            </div>}
            {hasChildren && <button type="button" className="team-admin-org-node-toggle" onClick={() => toggleCollapsed(team.teamId)} aria-label={isCollapsed ? `展开 ${team.name}` : `收起 ${team.name}`} title={isCollapsed ? '展开下级' : '收起下级'}>{isCollapsed ? <Plus aria-hidden="true" /> : <Minus aria-hidden="true" />}</button>}
          </article>;
        })}
      </div>
    </div>
  </section>;
}
