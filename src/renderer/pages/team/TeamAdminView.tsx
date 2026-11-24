import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, AlertCircle, Archive, BadgeDollarSign, Building2, ChevronRight, ExternalLink, Eye, GitBranch, ListFilter, ListTree, Mail, MailPlus, Network, Paperclip, Search, Send, Settings, Table2, UsersRound, X } from 'lucide-react';
import { ONLINE_CHANNELS, TEAM_LIMITS, type MailPriority, type OrganizationContext, type TeamAdminSummary, type TeamAttentionReason, type TeamDirectMessage, type TeamFilePayload, type TeamMonitoringMemberDetail, type TeamMonitoringMemberSummary } from '../../../shared/online-crm';
import { useIdentity } from '../../IdentityContext';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';
import { TeamAdminInspector, TeamAdminOverview } from './TeamAdminInspector';
import { DiamondLogo } from '../../components/DiamondLogo';
import { TeamOrgCanvas } from './TeamOrgCanvas';
import { effectiveTeamParentId } from './team-admin-layout';
import { compareTeamMemberOrder, orderTeamMembers, readTeamChatMemory, rememberTeamChat, teamActions, useTeamConversations, useTeamDetail, useTeamDirectory, useTeamMessages, useTeamMonitoringContact, useTeamMonitoringMember, useTeamMonitoringOverview, useTeamPresence } from './team-data';
import { clearTeamEmailReference, readTeamEmailReference } from './team-compose';

type TeamAdminMode = 'directory' | 'work' | 'canvas';
const TEAM_MESSAGE_POLL_MS = 5_000;
const TEAM_MESSAGE_FALLBACK_MS = 3_000;

function memberInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

function messageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return date.toLocaleString('zh-CN', sameDay
    ? { hour: '2-digit', minute: '2-digit', hour12: false }
    : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function daysSince(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
}

function relativeActivity(value: string | null | undefined): string {
  const days = daysSince(value);
  if (days === null) return '—';
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${days} 天前`;
}

function priorityLabel(priority: string): string {
  return priority === 'urgent' ? '紧急' : priority === 'important' ? '重要' : '常规';
}

function followupStageLabel(value: string): string {
  return ({ cold: '未联系', reaching: '跟进中', quoting: '报价中', trial: '试单中', cooperating: '合作中', lost: '已流失', other: '其他' } as Record<string, string>)[value] ?? value;
}

function followupTouchLabel(value: string): string {
  return ({ uncontacted: '未触达', contacted: '已触达', replied: '已收到', bounced: '退信', autoreply: '自动回复' } as Record<string, string>)[value] ?? value;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function teamFileBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

function memberStatus(member: TeamMonitoringMemberSummary | undefined): { label: string; tone: 'normal' | 'warning' | 'danger' } {
  if (!member) return { label: '暂无统计', tone: 'normal' };
  if (member.counts.openAttention > 0) return { label: '需关注', tone: 'warning' };
  if (member.counts.bounced > 0) return { label: '核对退信', tone: 'danger' };
  return { label: '正常', tone: 'normal' };
}

function isOperations(team: TeamAdminSummary): boolean {
  return team.unitType === 'operations';
}

export function TeamAdminView({ initialMemberId = null, compactHeader = false, canManage, teams, canvasTeams, organization, selectedTeamId, search, onSearch, onSelect, onChanged }: {
  initialMemberId?: string | null;
  compactHeader?: boolean;
  canManage: boolean;
  teams: readonly TeamAdminSummary[];
  canvasTeams: readonly TeamAdminSummary[];
  organization?: OrganizationContext;
  selectedTeamId: string | null;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (teamId: string | null) => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { identity, status } = useIdentity();
  const online = status === 'authenticated';
  const [mode, setMode] = useState<TeamAdminMode>('directory');
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(() => {
    const memory = readTeamChatMemory(identity?.userId);
    return memory.teamId === selectedTeamId ? memory.memberId : initialMemberId;
  });
  const [threadTeamId, setThreadTeamId] = useState<string | null>(null);
  const [editingStructure, setEditingStructure] = useState(false);
  const [collapsedTeamIds, setCollapsedTeamIds] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [olderMessages, setOlderMessages] = useState<TeamDirectMessage[]>([]);
  const [olderHasMore, setOlderHasMore] = useState(false);
  const [olderLoading, setOlderLoading] = useState(false);
  const [selectedCustomerRef, setSelectedCustomerRef] = useState<{ customerId: string; contactId: number } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const messageLog = useRef<HTMLDivElement | null>(null);
  const markedReadKey = useRef('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [teamEventsActive, setTeamEventsActive] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [attentionReason, setAttentionReason] = useState<TeamAttentionReason>('important_reply');
  const [attentionPriority, setAttentionPriority] = useState<MailPriority>('important');
  const [attentionNote, setAttentionNote] = useState('');
  const [attentionBusy, setAttentionBusy] = useState(false);
  const [drawerNotice, setDrawerNotice] = useState('');
  const [emailReference, setEmailReference] = useState(() => {
    const draft = readTeamEmailReference();
    return draft && draft.memberUserId === initialMemberId ? draft.payload : null;
  });
  const [pendingMessages, setPendingMessages] = useState<TeamDirectMessage[]>([]);
  const detailQuery = useTeamDetail(selectedTeamId, true);
  const detail = detailQuery.data?.ok ? detailQuery.data.data : undefined;
  const detailError = detailQuery.data && !detailQuery.data.ok ? detailQuery.data.error.message : null;
  const monitoringQuery = useTeamMonitoringOverview(selectedTeamId, online && canManage);
  const monitoring = monitoringQuery.data?.ok ? monitoringQuery.data.data : undefined;
  const monitoringMembers = monitoring?.members.items ?? [];
  const monitoringById = new Map(monitoringMembers.map(member => [member.userId, member]));
  const selectedMember = detail?.team.members.find(member => member.userId === selectedMemberId) ?? null;
  const monitoringMemberQuery = useTeamMonitoringMember(selectedMemberId, online && canManage, 20);
  const conversationsQuery = useTeamConversations(selectedTeamId, online);
  const directoryQuery = useTeamDirectory(online);
  const conversations = conversationsQuery.data?.ok ? conversationsQuery.data.data.items : [];
  const selectedConversation = conversations.find(item => item.userId === selectedMemberId) ?? null;
  const activeThreadTeamId = selectedConversation?.teamId ?? threadTeamId ?? selectedTeamId;
  const presenceQuery = useTeamPresence(activeThreadTeamId, selectedMemberId, online);
  const selectedParticipant = selectedMember ?? selectedConversation;
  const restoringChat = Boolean(selectedMemberId && !selectedParticipant && mode !== 'canvas');
  const chatIdle = !canManage && !compactHeader && !selectedMemberId && mode !== 'canvas';
  const selectedMonitoringMember = selectedParticipant ? monitoringById.get(selectedParticipant.userId) : undefined;
  const monitoringMemberDetail = monitoringMemberQuery.data?.ok ? monitoringMemberQuery.data.data : undefined;
  const followupItems = monitoringMemberDetail?.followups ?? [];
  const followupContactQuery = useTeamMonitoringContact(selectedCustomerRef?.contactId ?? null, selectedCustomerRef?.customerId ?? null, online && canManage && !!selectedCustomerRef);
  const followupContact = followupContactQuery.data?.ok ? followupContactQuery.data.data : undefined;
  const presence = presenceQuery.data?.ok ? presenceQuery.data.data : undefined;
  const presenceState = presence?.state ?? 'offline';
  const presenceLabel = presenceState === 'unread' ? '在线，有未读消息' : presenceState === 'online' ? '在线' : presence?.lastSeenAt ? `离线，最近在线 ${relativeActivity(presence.lastSeenAt)}` : '离线';
  const selectedRoleLabel = selectedMember ? (selectedMember.role === 'leader' ? '负责人' : '成员') : selectedConversation?.manager ? '管理员' : '协作账号';
  const messagesQuery = useTeamMessages(activeThreadTeamId, selectedMemberId, online);
  const messages = messagesQuery.data?.ok ? messagesQuery.data.data.items : [];
  const displayMessages = useMemo(() => [...olderMessages, ...messages, ...pendingMessages], [messages, olderMessages, pendingMessages]);
  const messagesError = messagesQuery.data && !messagesQuery.data.ok ? messagesQuery.data.error.message : null;
  const normalizedSearch = search.trim().toLocaleLowerCase('zh-CN');
  const activeTeams = mode === 'canvas' ? canvasTeams : teams;
  const allTeamIds = new Set(activeTeams.map(team => team.teamId));
  const matchedIds = new Set<string>();
  if (normalizedSearch) {
    for (const team of activeTeams) if ([team.name, team.leaderName].some(value => value.toLocaleLowerCase('zh-CN').includes(normalizedSearch))) matchedIds.add(team.teamId);
    for (const id of [...matchedIds]) {
      let current = activeTeams.find(team => team.teamId === id);
      while (current) {
        const parentId = effectiveTeamParentId(current, allTeamIds);
        if (!parentId) break;
        matchedIds.add(parentId);
        current = activeTeams.find(team => team.teamId === parentId);
      }
    }
  }
  const filteredTeams = normalizedSearch ? activeTeams.filter(team => matchedIds.has(team.teamId)) : [...activeTeams];
  const operations = filteredTeams.filter(isOperations);
  const sales = filteredTeams.filter(team => !isOperations(team));
  const knownTeamIds = new Set(filteredTeams.map(team => team.teamId));
  const directSales = sales.filter(team => effectiveTeamParentId(team, knownTeamIds) === null);
  const unassignedSales = sales.filter(team => (team.assignedLeadCount ?? 0) === 0);
  const selectedTeam = selectedTeamId ? activeTeams.find(team => team.teamId === selectedTeamId) ?? null : null;
  const childCount = sales.length;

  useEffect(() => {
    const memory = readTeamChatMemory(identity?.userId);
    setSelectedMemberId(memory.teamId === selectedTeamId ? memory.memberId : null);
    setThreadTeamId(null);
    setEditingStructure(false);
  }, [identity?.userId, selectedTeamId]);
  useEffect(() => {
    if (selectedTeamId || !teams.length) return;
    const first = teams.find(team => !isOperations(team)) ?? teams[0];
    if (!first) return;
    onSelect(first.teamId);
  }, [onSelect, selectedTeamId, teams]);
  useEffect(() => {
    setDraft('');
    setSendError(null);
    setOlderMessages([]);
    setOlderHasMore(false);
    setPendingMessages([]);
    markedReadKey.current = '';
  }, [selectedMemberId]);
  useEffect(() => {
    if (messagesQuery.data?.ok) setOlderHasMore(messagesQuery.data.data.hasMore);
  }, [messagesQuery.data]);
  useEffect(() => {
    if (!online) return;
    let active = true;
    const unsubscribe = window.api.on('team:event', event => {
      if (!active) return;
      void qc.invalidateQueries({ queryKey: ['team-messages'] });
      void qc.invalidateQueries({ queryKey: ['team-conversations'] });
      void qc.invalidateQueries({ queryKey: ['team-directory'] });
      void qc.invalidateQueries({ queryKey: ['team-presence'] });
      void qc.invalidateQueries({ queryKey: ['team-monitoring-member'] });
    });
    const unsubscribeState = window.api.on('team:eventState', state => {
      if (!active) return;
      setTeamEventsActive(Boolean((state as { active?: boolean } | null)?.active));
    });
    void window.api.invoke(ONLINE_CHANNELS.TEAM_EVENTS_START).then(result => {
      if (active) setTeamEventsActive(Boolean(result && (result as { ok?: boolean }).ok));
    });
    return () => {
      active = false;
      unsubscribe();
      unsubscribeState();
      setTeamEventsActive(false);
      void window.api.invoke(ONLINE_CHANNELS.TEAM_EVENTS_STOP);
    };
  }, [online, qc]);
  useEffect(() => {
    const latestIncoming = [...messages].reverse().find(message => !message.mine);
    if (!activeThreadTeamId || !selectedMemberId || !latestIncoming) return;
    const key = `${selectedMemberId}:${latestIncoming.messageId}`;
    if (markedReadKey.current === key) return;
    markedReadKey.current = key;
    void teamActions.markMessagesRead({ teamId: activeThreadTeamId, memberUserId: selectedMemberId, throughMessageId: latestIncoming.messageId, idempotencyKey: crypto.randomUUID() }).then(result => {
      if (!result.ok) return;
      void conversationsQuery.refetch();
      void presenceQuery.refetch();
    });
  }, [conversationsQuery, presenceQuery, selectedMemberId, activeThreadTeamId, messages.length, messages[messages.length - 1]?.messageId]);
  useEffect(() => {
    const node = messageLog.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, selectedMemberId]);

  const livePollMs = teamEventsActive ? 15_000 : TEAM_MESSAGE_FALLBACK_MS;
  useVisiblePolling(async () => { await messagesQuery.refetch(); }, livePollMs, online && !!selectedTeamId && !!selectedMemberId);
  useVisiblePolling(async () => { await monitoringMemberQuery.refetch(); }, TEAM_MESSAGE_POLL_MS, online && canManage && !!selectedMemberId);
  useVisiblePolling(async () => { await presenceQuery.refetch(); }, TEAM_MESSAGE_POLL_MS, online && !!selectedMemberId);
  useVisiblePolling(async () => { await conversationsQuery.refetch(); }, livePollMs, online && !!selectedTeamId);
  useVisiblePolling(async () => { await directoryQuery.refetch(); }, livePollMs, online);
  useVisiblePolling(async () => { await monitoringQuery.refetch(); }, TEAM_MESSAGE_POLL_MS, online && canManage && !!selectedTeamId);

  const changed = () => {
    void detailQuery.refetch();
    onChanged();
  };
  const selectTeam = (teamId: string) => {
    rememberTeamChat(identity?.userId, { teamId, memberId: null });
    setThreadTeamId(null);
    if (selectedTeamId === teamId) {
      setCollapsedTeamIds(current => {
        const next = new Set(current);
        if (next.has(teamId)) next.delete(teamId);
        else next.add(teamId);
        return next;
      });
      setSelectedMemberId(null);
      return;
    }
    setSelectedMemberId(null);
    onSelect(teamId);
  };
  const openChat = (memberId: string, peerTeamId?: string | null) => {
    rememberTeamChat(identity?.userId, { teamId: selectedTeamId, memberId });
    setThreadTeamId(peerTeamId ?? null);
    setSelectedMemberId(memberId);
  };
  const markChatUnread = async () => {
    const latestIncoming = [...displayMessages].reverse().find(message => !message.mine);
    if (!activeThreadTeamId || !selectedMemberId || !latestIncoming || readBusy) return;
    setReadBusy(true);
    const result = await teamActions.markMessagesUnread({ teamId: activeThreadTeamId, memberUserId: selectedMemberId, messageId: latestIncoming.messageId, idempotencyKey: crypto.randomUUID() });
    setReadBusy(false);
    if (!result.ok) return;
    markedReadKey.current = '';
    void conversationsQuery.refetch();
    void presenceQuery.refetch();
  };
  const archiveChat = async () => {
    if (!activeThreadTeamId || !selectedMemberId || archiveBusy) return;
    setArchiveBusy(true);
    const result = await teamActions.archiveConversation({ teamId: activeThreadTeamId, memberUserId: selectedMemberId, idempotencyKey: crypto.randomUUID() });
    if (result.ok) await teamActions.openFile(result.data.fileId);
    else setSendError(result.error.message);
    setArchiveBusy(false);
  };
  const submitAttention = async () => {
    if (!selectedParticipant || !selectedCustomerRef || attentionBusy) return;
    setAttentionBusy(true);
    const result = await teamActions.createAttention({ targetMemberUserId: selectedParticipant.userId, customerId: selectedCustomerRef.customerId, contactId: selectedCustomerRef.contactId, reason: attentionReason, priority: attentionPriority, ...(attentionNote.trim() ? { note: attentionNote.trim() } : {}), idempotencyKey: crypto.randomUUID() });
    setAttentionBusy(false);
    if (result.ok) { setAttentionOpen(false); setAttentionNote(''); setDrawerNotice('已发起关注请求'); }
    else setDrawerNotice(result.error.message);
  };
  const loadOlderMessages = async () => {
    const oldest = displayMessages[0];
    if (!activeThreadTeamId || !selectedMemberId || !oldest || olderLoading || !olderHasMore) return;
    setOlderLoading(true);
    const result = await teamActions.messages({ teamId: activeThreadTeamId, memberUserId: selectedMemberId, limit: 100, beforeMessageId: oldest.messageId });
    setOlderLoading(false);
    if (!result.ok) return;
    setOlderMessages(current => [...result.data.items, ...current]);
    setOlderHasMore(result.data.hasMore);
  };
  const sendMessage = async () => {
    const body = draft.trim() || emailReference?.subject || '';
    if (!online || !activeThreadTeamId || !selectedParticipant || !body || sending) return;
    const pending: TeamDirectMessage = { messageId: `local-${crypto.randomUUID()}`, teamId: activeThreadTeamId, senderUserId: identity?.userId ?? 'me', senderName: identity?.displayName ?? '我', recipientUserId: selectedParticipant.userId, recipientName: selectedParticipant.displayName, body, kind: emailReference ? 'email_ref' : 'text', payload: emailReference, createdAt: new Date().toISOString(), mine: true };
    setPendingMessages(current => [...current, pending]);
    setSending(true);
    setSendError(null);
    const result = await teamActions.sendMessage({
      teamId: activeThreadTeamId,
      recipientUserId: selectedParticipant.userId,
      body,
      ...(emailReference ? { kind: 'email_ref' as const, payload: emailReference } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
    if (!result.ok) {
      setSendError(result.error.message);
      setPendingMessages(current => current.filter(message => message.messageId !== pending.messageId));
      setSending(false);
      return;
    }
    setPendingMessages(current => current.filter(message => message.messageId !== pending.messageId));
    setDraft('');
    setEmailReference(null);
    clearTeamEmailReference();
    setSending(false);
    await messagesQuery.refetch();
  };
  const sendAttachment = async (file: File) => {
    if (!online || !activeThreadTeamId || !selectedParticipant || uploading) return;
    if (file.size > TEAM_LIMITS.fileBytes) { setSendError('附件不能超过 8 MiB'); return; }
    setUploading(true);
    setSendError(null);
    try {
      const uploaded = await teamActions.uploadFile({ teamId: activeThreadTeamId, filename: file.name, mimeType: file.type || 'application/octet-stream', base64: await teamFileBase64(file), idempotencyKey: crypto.randomUUID() });
      if (!uploaded.ok) { setSendError(uploaded.error.message); return; }
      const sent = await teamActions.sendMessage({ teamId: activeThreadTeamId, recipientUserId: selectedParticipant.userId, body: file.name, kind: 'attachment', fileId: uploaded.data.fileId, idempotencyKey: crypto.randomUUID() });
      if (!sent.ok) { setSendError(sent.error.message); return; }
      await messagesQuery.refetch();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '附件上传失败');
    } finally {
      setUploading(false);
    }
  };
  const memberRows = (teamId: string) => {
    if (selectedTeamId !== teamId || collapsedTeamIds.has(teamId)) return null;
    if (detailQuery.isLoading) return <div className="team-admin-directory-state">正在读取成员</div>;
    if (detailError) return <div className="team-admin-directory-state is-error">{detailError}</div>;
    if (!detail) return null;
    const members = orderTeamMembers(detail.team.members.filter(member => member.userId !== identity?.userId));
    if (!members.length) return null;
    return <div className="team-admin-member-tree">{members.map(member => { const conversation = conversationByUser.get(member.userId); return <button key={member.userId} type="button" className={`team-admin-member-tree-row${selectedMemberId === member.userId ? ' is-selected' : ''}`} onClick={() => openChat(member.userId)}>
      <span className="team-admin-member-avatar">{member.displayName.trim().slice(0, 1).toUpperCase() || '?'}</span>
      <span><strong>{conversation && <i className={`team-member-presence-dot ${conversation.presence === 'online' ? conversation.unreadCount > 0 ? 'is-unread' : 'is-online' : 'is-offline'}`} />}{member.displayName}</strong><small>{member.email || '中心账号'}{conversation?.unreadCount ? ` · ${conversation.unreadCount} 条未读` : ''}</small></span>
    </button>; })}</div>;
  };
  const directory = directoryQuery.data?.ok ? directoryQuery.data.data.items : [];
  const conversationByUser = new Map(conversations.map(peer => [peer.userId, peer]));
  const selectedRosterIds = new Set(detail?.team.members.map(member => member.userId) ?? []);
  const directoryById = new Map(directory.map(entry => [entry.userId, entry]));
  const otherContacts = [
    ...directory.filter(entry => entry.userId !== identity?.userId && !selectedRosterIds.has(entry.userId)).map(entry => {
      const peer = conversationByUser.get(entry.userId);
      return { userId: entry.userId, displayName: entry.displayName, email: entry.email, presence: peer?.presence ?? entry.presence, unreadCount: peer?.unreadCount ?? entry.unreadCount, teamId: peer?.teamId ?? entry.teamId, teamName: entry.teamName, manager: entry.manager };
    }),
    ...conversations.filter(peer => peer.userId !== identity?.userId && !selectedRosterIds.has(peer.userId) && !directoryById.has(peer.userId)).map(peer => ({ userId: peer.userId, displayName: peer.displayName, email: peer.email, presence: peer.presence, unreadCount: peer.unreadCount, teamId: peer.teamId, teamName: null as string | null, manager: peer.manager })),
  ].sort((a, b) => Number(b.unreadCount > 0) - Number(a.unreadCount > 0) || a.displayName.localeCompare(b.displayName, 'zh-CN'));
  const memberCount = detail?.team.memberCount ?? selectedTeam?.memberCount ?? monitoring?.members.total ?? 0;
  const maxOpenActions = Math.max(1, ...monitoringMembers.map(member => member.counts.openActions));
  const roster = detail ? orderTeamMembers(detail.team.members.filter(member => canManage || member.userId === identity?.userId)) : [];
  const organizationPage = <div className="team-admin-org-page">
    {!compactHeader && <div className="team-admin-breadcrumb"><span>{organization?.company.name ?? '公司'}</span><ChevronRight aria-hidden="true" />{selectedTeam?.parentTeamName && <><span>{selectedTeam.parentTeamName}</span><ChevronRight aria-hidden="true" /></>}<strong>{selectedTeam?.name ?? '当前团队'}</strong></div>}
    <div className="team-admin-demo-hero"><div><div className="team-admin-title-line"><h1>{selectedTeam?.name ?? '团队工作区'}</h1>{compactHeader && canManage && <button type="button" className="team-admin-title-settings" aria-label="管理团队" title="管理团队" onClick={() => setEditingStructure(true)}><Settings aria-hidden="true" /></button>}</div><p>{selectedTeam?.unitType === 'operations' ? '运营组' : '销售团队'} · 当前范围 {memberCount} 位成员</p></div>{!compactHeader && canManage && <button type="button" className="team-admin-demo-manage" onClick={() => setEditingStructure(true)}><ListFilter aria-hidden="true" />管理团队</button>}</div>
    <div className="team-admin-demo-metrics">
      <div><span>成员</span><strong>{memberCount}</strong><em>当前范围</em></div>
      <div><span>开放动作</span><strong>{monitoring?.counts.openActions ?? '—'}</strong><em>{monitoring?.counts.overdueActions ?? 0} 个逾期</em></div>
      <div><span>回复率</span><strong>{percent(monitoring?.rates.replyRate)}</strong><em>近 30 天</em></div>
      <div><span>跟进中</span><strong>{monitoring?.counts.contacted ?? '—'}</strong><em>已触达联系人</em></div>
      <div><span>需支援</span><strong>{monitoring?.counts.openAttention ?? '—'}</strong><em>开放关注项</em></div>
    </div>
    <section className="team-admin-demo-content">
      <div className="team-admin-demo-content-head"><strong>团队成员</strong><span>{roster.length} 人</span></div>
      {detailQuery.isLoading ? <div className="team-admin-directory-state">正在读取成员</div> : detailError ? <div className="team-admin-directory-state is-error">{detailError}</div> : roster.length === 0 ? <div className="team-admin-directory-state">暂无成员</div> : <div className="team-admin-demo-member-table">
        <div className="team-admin-demo-member-head"><span>成员</span><span>角色</span><span>开放动作</span><span>回复率</span><span>联系人</span><span>状态</span><span /></div>
        {roster.map(member => { const metric = monitoringById.get(member.userId); const status = memberStatus(metric); return <button key={member.userId} type="button" className={`team-admin-demo-member-row${selectedMemberId === member.userId ? ' is-selected' : ''}`} onClick={() => openChat(member.userId)}>
          <span className="team-admin-demo-member-person"><span className="team-admin-member-avatar">{memberInitial(member.displayName)}</span><span><strong>{member.displayName}</strong><small>{member.email || '中心账号'}</small></span></span>
          <span><em className="team-admin-demo-role">{member.role === 'leader' ? '负责人' : '成员'}</em></span>
          <span className="team-admin-demo-load"><span><i style={{ width: `${Math.round((metric?.counts.openActions ?? 0) / maxOpenActions * 100)}%` }} /></span><small>{metric?.counts.openActions ?? '—'}</small></span>
          <span>{percent(metric?.rates.replyRate)}</span>
          <span>{metric?.counts.contacts ?? '—'}</span>
          <span><em className={`team-admin-demo-status is-${status.tone}`}>{status.label}</em></span>
          <ChevronRight aria-hidden="true" />
        </button>; })}
      </div>}
    </section>
  </div>;
  const workPage = <div className="team-admin-org-page">
    {!compactHeader && <div className="team-admin-breadcrumb"><span>{organization?.company.name ?? '公司'}</span><ChevronRight aria-hidden="true" /><strong>{selectedTeam?.name ?? '当前团队'}</strong><span>工作视角</span></div>}
    <div className="team-admin-demo-hero"><div><h1>{selectedTeam?.name ?? '团队工作区'}</h1><p>按开放动作、回复率和关注项排序</p></div></div>
    <div className="team-admin-demo-metrics">
      <div><span>成员</span><strong>{memberCount}</strong><em>当前范围</em></div>
      <div><span>开放动作</span><strong>{monitoring?.counts.openActions ?? '—'}</strong><em>团队合计</em></div>
      <div><span>回复率</span><strong>{percent(monitoring?.rates.replyRate)}</strong><em>近 30 天</em></div>
      <div><span>客户</span><strong>{monitoring?.counts.contacts ?? '—'}</strong><em>团队联系人</em></div>
      <div><span>需支援</span><strong>{monitoring?.counts.openAttention ?? '—'}</strong><em>开放关注项</em></div>
    </div>
    <section className="team-admin-demo-content">
      <div className="team-admin-demo-content-head"><strong>成员工作负荷</strong><span>{monitoringMembers.length} 人</span></div>
      {monitoringQuery.isLoading ? <div className="team-admin-directory-state">正在读取工作负荷</div> : monitoringQuery.data && !monitoringQuery.data.ok ? <div className="team-admin-directory-state is-error">{monitoringQuery.data.error.message}</div> : monitoringMembers.length === 0 ? <div className="team-admin-directory-state">暂无工作数据</div> : <div className="team-admin-demo-work-list">{monitoringMembers.slice().sort((left, right) => compareTeamMemberOrder(left, right) || right.counts.openActions - left.counts.openActions).map(member => { const status = memberStatus(member); return <button key={member.userId} type="button" className={`team-admin-demo-work-row${selectedMemberId === member.userId ? ' is-selected' : ''}`} onClick={() => openChat(member.userId)}>
        <span className="team-admin-demo-member-person"><span className="team-admin-member-avatar">{memberInitial(member.displayName)}</span><span><strong>{member.displayName}</strong><small>{member.role === 'leader' ? '负责人' : '成员'} · {member.email || '中心账号'}</small></span></span>
        <span className="team-admin-demo-work-meter"><span><i style={{ width: `${Math.round(member.counts.openActions / maxOpenActions * 100)}%` }} /></span><small>开放动作 {member.counts.openActions} · 联系人 {member.counts.contacts}</small></span>
        <span><em className={`team-admin-demo-status is-${status.tone}`}>{status.label}</em></span>
        <ChevronRight aria-hidden="true" />
      </button>; })}</div>}
    </section>
  </div>;
  const toolbar = <div className={`team-admin-toolbar${compactHeader ? ' is-compact-member' : ''}`}>
      <nav className="team-admin-view-tabs" aria-label="团队管理视图">
        <button type="button" aria-current={mode === 'directory' ? 'page' : undefined} onClick={() => setMode('directory')}><ListTree aria-hidden="true" />组织视角</button>
        {canManage && <button type="button" aria-current={mode === 'work' ? 'page' : undefined} onClick={() => setMode('work')}><Table2 aria-hidden="true" />工作视角</button>}
        <button type="button" aria-current={mode === 'canvas' ? 'page' : undefined} onClick={() => setMode('canvas')}><Network aria-hidden="true" />团队画布</button>
      </nav>
      {!compactHeader && <div className="team-admin-toolbar-actions">
        <div className="team-admin-toolbar-stats"><span><b>{operations.length}</b> 运营组</span><span><b>{childCount}</b> 销售团队</span><span><b>{unassignedSales.length}</b> 未分配线索</span><span><b>{teams.reduce((sum, team) => sum + team.pendingInvitationCount, 0)}</b> 待处理邀请</span></div>
      </div>}
    </div>;
  const activityDrawer = <section className="team-admin-activity-drawer is-overview" aria-label="团队动态">
    <div className="team-admin-activity-heading"><div><Activity aria-hidden="true" /><strong>团队动态</strong></div><span>{selectedParticipant?.displayName ?? selectedTeam?.name ?? '近期'}</span></div>
    <div className="team-admin-activity-list"><div className="team-admin-inline-empty">暂无近期动态</div></div>
  </section>;

  return <div className={`team-admin-view${compactHeader ? ' is-compact-member' : ''}`}>
    {toolbar}
    {mode === 'canvas'
      ? <div className="team-admin-canvas-tab"><TeamOrgCanvas teams={activeTeams} organization={organization} detail={detail} detailLoading={detailQuery.isLoading} selectedTeamId={selectedTeamId} search={search} onSelect={onSelect} /></div>
      : <div className={`team-admin-workspace is-directory is-member-directory${selectedParticipant || restoringChat ? ' is-chat-open' : ''}${chatIdle ? ' is-chat-idle' : ''}`}>
          <aside className="team-admin-rail">
            {compactHeader && <div className="team-admin-rail-search"><label className="team-admin-toolbar-search">
              <Search aria-hidden="true" />
              <input value={search} onChange={event => onSearch(event.target.value)} placeholder="搜索团队、负责人或成员" aria-label="搜索团队、负责人或成员" />
              {search && <button type="button" onClick={() => onSearch('')} aria-label="清除搜索" title="清除搜索"><X aria-hidden="true" /></button>}
            </label></div>}
            {!compactHeader && <div className="team-admin-rail-heading"><div><span>团队结构</span><h2>我的团队</h2></div><small>{filteredTeams.length}</small></div>}
            {otherContacts.length > 0 && <div className="team-admin-other-contacts">
              <span className="team-admin-other-contacts-heading">其他联系人</span>
              {otherContacts.map(peer => <button key={peer.userId} type="button" className={`team-admin-member-tree-row team-admin-conversation-row${selectedMemberId === peer.userId ? ' is-selected' : ''}`} onClick={() => openChat(peer.userId, peer.teamId)}>
                <span className="team-admin-member-avatar">{memberInitial(peer.displayName)}</span>
                <span><strong><i className={`team-member-presence-dot ${peer.presence === 'online' ? peer.unreadCount > 0 ? 'is-unread' : 'is-online' : 'is-offline'}`} />{peer.displayName}</strong><small>{(peer.teamName ?? (peer.manager ? '管理员' : '协作账号'))}{peer.unreadCount ? ` · ${peer.unreadCount} 条未读` : ''}</small></span>
              </button>)}
            </div>}
            <div className="team-admin-tree">
              {filteredTeams.length === 0 && <div className="team-admin-inline-empty">没有匹配的团队</div>}
              {!compactHeader && organization && <div className="team-admin-company-row"><Building2 aria-hidden="true" /><span><strong>{organization.company.name}</strong><small>{filteredTeams.length} 个可见组织</small></span></div>}
              {operations.map(group => {
                const children = sales.filter(team => effectiveTeamParentId(team, knownTeamIds) === group.teamId);
                const isCollapsed = collapsedTeamIds.has(group.teamId);
                return <div key={group.teamId} className="team-admin-group">
                  <div className={`team-admin-directory-root${selectedTeamId === group.teamId ? ' is-selected' : ''}`}>
                    <button type="button" className="team-admin-directory-main" aria-expanded={!isCollapsed} onClick={() => selectTeam(group.teamId)}><Building2 aria-hidden="true" /><span><strong>{group.name}</strong><small>{group.leaderName} · {group.memberCount} 位成员</small></span><span className={`team-admin-row-caret${isCollapsed ? ' is-collapsed' : ''}`}><ChevronRight aria-hidden="true" /></span></button>
                  </div>
                  {!isCollapsed && <>
                    {memberRows(group.teamId)}
                    {children.map(team => {
                      const childCollapsed = collapsedTeamIds.has(team.teamId);
                      return <div key={team.teamId}>
                        <button type="button" className={`team-admin-tree-row${selectedTeamId === team.teamId ? ' is-selected' : ''}`} data-depth="1" aria-expanded={!childCollapsed} onClick={() => selectTeam(team.teamId)}>
                          <GitBranch aria-hidden="true" /><span><strong>{team.name}</strong><small>{team.leaderName} · {team.memberCount} 位成员</small></span><span className="team-admin-row-meta"><span className={`team-admin-row-caret${childCollapsed ? ' is-collapsed' : ''}`}><ChevronRight aria-hidden="true" /></span></span>
                        </button>
                        {memberRows(team.teamId)}
                      </div>;
                    })}
                  </>}
                </div>;
              })}
              {directSales.map(team => {
                const isCollapsed = collapsedTeamIds.has(team.teamId);
                return <div key={team.teamId}>
                  <button type="button" className={`team-admin-tree-row${selectedTeamId === team.teamId ? ' is-selected' : ''}`} data-depth="0" aria-expanded={!isCollapsed} onClick={() => selectTeam(team.teamId)}>
                    <UsersRound aria-hidden="true" /><span><strong>{team.name}</strong><small>{team.leaderName} · {team.memberCount} 位成员</small></span><span className="team-admin-row-meta"><span className={`team-admin-row-caret${isCollapsed ? ' is-collapsed' : ''}`}><ChevronRight aria-hidden="true" /></span></span>
                  </button>
                  {memberRows(team.teamId)}
                </div>;
              })}
            </div>
          </aside>
          <section className="team-admin-main team-admin-member-main" aria-label={selectedParticipant ? '成员协作' : '团队详情'}>
            {selectedParticipant ? <>
              <header className="team-member-collaboration-head">
                <span className="team-member-collaboration-avatar">{memberInitial(selectedParticipant.displayName)}</span>
                <span className="team-member-collaboration-identity">
                  <span className="team-member-collaboration-name"><strong>{selectedParticipant.displayName}</strong><i className={`team-member-presence-dot is-${presenceState}`} title={presenceLabel} aria-label={presenceLabel} /></span>
                  <small>{selectedParticipant.email || '中心账号'}</small>
                </span>
                <button type="button" className="team-chat-mark-unread" disabled={archiveBusy} title={archiveBusy ? '正在生成归档' : '导出聊天记录'} aria-label={archiveBusy ? '正在生成归档' : '导出聊天记录'} onClick={() => void archiveChat()}><Archive aria-hidden="true" /></button>
                <button type="button" className="team-chat-mark-unread" disabled={readBusy || !displayMessages.some(message => !message.mine)} title="标为未读" aria-label="标为未读" onClick={() => void markChatUnread()}><Mail aria-hidden="true" /></button>
              </header>
              <div className="team-collaboration-log team-chat-log" ref={messageLog} aria-label={`与 ${selectedParticipant.displayName} 的私聊`}>
                {!online ? <div className="team-collaboration-state">离线时暂不可收发私聊</div>
                  : messagesQuery.isLoading ? <div className="team-collaboration-state">正在读取私聊</div>
                    : messagesError ? <div className="team-collaboration-state is-error">{messagesError}</div>
                      : displayMessages.length === 0 ? <div className="team-collaboration-state">还没有消息</div>
                        : <>
                          {olderHasMore && <button type="button" className="team-chat-load-older" disabled={olderLoading} onClick={() => void loadOlderMessages()}>{olderLoading ? '加载中' : '加载更早消息'}</button>}
                          {displayMessages.map(message => <article key={message.messageId} className={`team-chat-message${message.mine ? ' is-mine' : ''}`}>
                          <span className="team-chat-avatar">{message.mine ? '我' : memberInitial(message.senderName)}</span>
                          <div className="team-chat-message-body">
                            <div className="team-chat-message-meta"><strong>{message.mine ? '我' : message.senderName}</strong><time dateTime={message.createdAt}>{messageTime(message.createdAt)}</time></div>
                            <p>{message.body}</p>
                            {message.kind === 'attachment' && message.payload && 'fileId' in message.payload && <button type="button" className="team-chat-attachment" onClick={() => void teamActions.openFile((message.payload as TeamFilePayload).fileId)}><Paperclip aria-hidden="true" /><span><strong>{(message.payload as TeamFilePayload).filename}</strong><small>{formatBytes((message.payload as TeamFilePayload).bytes)}</small></span></button>}
                            {message.kind === 'email_ref' && message.payload && 'subject' in message.payload && <div className="team-chat-email-ref"><Mail aria-hidden="true" /><span><strong>{message.payload.subject || '无主题'}</strong><small>{message.payload.from} · {messageTime(message.payload.occurredAt)}</small>{message.payload.summary && <small>{message.payload.summary}</small>}</span></div>}
                          </div>
                        </article>)}
                        </>}
              </div>
              <div className="team-collaboration-composer">
                {sendError && <div className="team-chat-send-error">{sendError}</div>}
                <div className="team-chat-composer-box">
                  {emailReference && <div className="team-chat-compose-reference"><Mail aria-hidden="true" /><span><strong>{emailReference.subject || '无主题'}</strong><small>{emailReference.from} · {messageTime(emailReference.occurredAt)}</small></span><button type="button" title="移除邮件引用" aria-label="移除邮件引用" onClick={() => { setEmailReference(null); clearTeamEmailReference(); }}><X aria-hidden="true" /></button></div>}
                  <textarea rows={3} value={draft} maxLength={TEAM_LIMITS.messageBody} disabled={!online || sending} aria-label="团队消息" placeholder={online ? `给 ${selectedParticipant.displayName} 发消息` : '联网后可发送消息'} onChange={event => setDraft(event.target.value)} onKeyDown={event => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }} />
                  <div className="team-chat-composer-footer">
                    <div className="team-chat-composer-tools" aria-label="协作工具">
                      <input ref={fileInput} type="file" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void sendAttachment(file); }} />
                      <button type="button" disabled aria-disabled="true" title="邮件引用暂未接入" aria-label="邮件引用暂未接入"><MailPlus aria-hidden="true" /></button>
                      <button type="button" disabled aria-disabled="true" title="运价确认暂未接入" aria-label="运价确认暂未接入"><BadgeDollarSign aria-hidden="true" /></button>
                      <button type="button" disabled aria-disabled="true" title="关注申请暂未接入" aria-label="关注申请暂未接入"><Eye aria-hidden="true" /></button>
                      <button type="button" disabled={!online || uploading || sending} title={uploading ? '附件上传中' : '添加附件'} aria-label="添加附件" onClick={() => fileInput.current?.click()}><Paperclip aria-hidden="true" /></button>
                    </div>
                    <button type="button" className="team-chat-send" disabled={!online || sending || (!draft.trim() && !emailReference)} onClick={() => { void sendMessage(); }}><Send aria-hidden="true" />{sending ? '发送中' : '发送'}</button>
                  </div>
                </div>
              </div>
            </> : <div className={`team-admin-member-detail-content${chatIdle ? ' is-chat-idle-content' : ''}${selectedTeam || chatIdle ? '' : ' is-empty'}`}>
              {chatIdle ? <div className="team-chat-idle" aria-label="点击成员打开聊天窗"><DiamondLogo size={44} state="idle" className="team-chat-idle-logo" /></div>
                : restoringChat ? <div className="team-chat-restoring" aria-hidden="true" />
                  : !selectedTeam ? <div className="team-admin-inline-empty"><Mail aria-hidden="true" />选择成员查看协作动态</div>
                    : editingStructure ? <TeamAdminInspector canManage={canManage} detail={detail} loading={detailQuery.isLoading} error={detailError} onBack={() => setEditingStructure(false)} onChanged={changed} />
                      : mode === 'work' ? workPage : organizationPage}
            </div>}
          </section>
          <aside className={`team-admin-inspector team-admin-overview-aside${compactHeader && !selectedParticipant ? ' is-activity-only' : ''}`}>
            {selectedParticipant ? <div className="team-member-context">
              <div className="team-member-context-head">
                <span className="team-member-collaboration-avatar">{memberInitial(selectedParticipant.displayName)}</span>
                <span className="team-member-context-name"><strong>{selectedParticipant.displayName}</strong><small>{selectedRoleLabel} · {selectedTeam?.name ?? '当前团队'}</small></span>
              </div>
              <div className={`team-member-context-stats${canManage ? '' : ' is-private'}`}>
                {canManage ? <>
                  <div><strong>{percent(selectedMonitoringMember?.rates.replyRate)}</strong><span>近 30 天回复率</span></div>
                  <div><strong>{selectedMonitoringMember?.counts.uncontacted ?? '—'}</strong><span>未触达客户</span></div>
                  <div><strong>{selectedMonitoringMember?.counts.overdueActions ?? '—'}</strong><span>逾期动作</span></div>
                  <div><strong>{relativeActivity(selectedMonitoringMember?.lastActivityAt)}</strong><span>最近活跃</span></div>
                </> : <div><strong>{selectedRoleLabel}</strong><span>协作身份</span></div>}
              </div>
              <section className="team-member-context-section">
                <h3>客户跟进</h3>
                {!canManage ? <div className="team-admin-inline-empty">仅负责人可查看成员跟进</div>
                  : monitoringMemberQuery.isLoading ? <div className="team-admin-inline-empty">正在读取客户跟进</div>
                    : followupItems.length === 0 ? <div className="team-admin-inline-empty">暂无开放跟进</div>
                      : <div className="team-member-followup-list">{followupItems.map(item => <button key={item.customerId} type="button" className="team-member-followup-row" onClick={() => { setAttentionOpen(false); setDrawerNotice(''); setSelectedCustomerRef({ customerId: item.customerId, contactId: item.contactId }); }} title={`打开 ${item.customerName}`}>
                        <em className={`team-member-followup-priority is-${item.urgency}`}>{priorityLabel(item.urgency)}</em>
                        <span className="team-member-followup-main"><strong>{item.customerName}<b className="team-member-followup-grade">{item.grade}</b>{item.aiDealPending && <b className="team-member-deal-pending">成交待确认</b>}</strong><small>{[item.contactName, item.nextAction ?? item.recentSummary].filter(Boolean).join(' · ')}</small></span>
                        <time className="team-member-followup-age" title="距上次跟进的天数">{item.daysSinceFollowup === null ? '—' : `${item.daysSinceFollowup} 天`}</time>
                      </button>)}</div>}
              </section>
            </div> : compactHeader ? activityDrawer : <>
              <div className="team-admin-overview-main">
                <TeamAdminOverview teams={teams} organization={organization} onSelect={selectTeam} />
              </div>
              {activityDrawer}
            </>}
          </aside>
        </div>}
    {selectedCustomerRef && <div className="team-crm-drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedCustomerRef(null); }}>
      <section className="team-crm-drawer" aria-label="客户跟进详情">
        <header><div><span>客户跟进</span><strong>{followupContact?.companyName ?? '客户详情'}</strong></div><button type="button" title="关闭" aria-label="关闭客户跟进详情" onClick={() => setSelectedCustomerRef(null)}><X aria-hidden="true" /></button></header>
        {followupContactQuery.isLoading ? <div className="team-admin-inline-empty">正在读取客户</div>
          : followupContactQuery.data && !followupContactQuery.data.ok ? <div className="team-admin-inline-empty is-error">{followupContactQuery.data.error.message}</div>
            : followupContact ? <>
              <div className="team-crm-contact-summary">
                <strong>{followupContact.name}</strong>
                <span>{followupContact.email || '无邮箱'} · {followupContact.country || '未填国家'}</span>
                <div><em>{followupTouchLabel(followupContact.touchStatus)}</em><em>{followupStageLabel(followupContact.stage)}</em><span>{followupContact.ownerName || '未分配负责人'}</span></div>
              </div>
              <section className="team-crm-mail-list">
                <h3>最近邮件</h3>
                {followupContact.mail.items.length === 0 ? <div className="team-admin-inline-empty">暂无邮件摘要</div> : followupContact.mail.items.slice(0, 5).map(mail => <div key={mail.eventId} className="team-crm-mail-row"><strong>{mail.subject || '无主题'}</strong><small>{mail.summary || mail.nextAction || '仅结构化摘要'}</small></div>)}
              </section>
              <div className="team-crm-actions">
                <button type="button" className="team-crm-attention-trigger" onClick={() => { setDrawerNotice(''); setAttentionOpen(open => !open); }}><Eye aria-hidden="true" />请求关注</button>
                <button type="button" className="team-crm-open-customer" onClick={() => { setSelectedCustomerRef(null); window.location.hash = `#/customers?monitorContact=${followupContact.contactId}&centerCustomer=${encodeURIComponent(followupContact.customerId)}`; }}><ExternalLink aria-hidden="true" />打开客户详情</button>
              </div>
              {attentionOpen && <div className="team-crm-attention-form">
                <label><span>关注原因</span><select value={attentionReason} onChange={event => setAttentionReason(event.target.value as TeamAttentionReason)}><option value="important_reply">重要回复</option><option value="quote_overdue">报价逾期</option><option value="unhandled_inquiry">询盘未处理</option><option value="bounce_correction">退信核对</option></select></label>
                <label><span>优先级</span><select value={attentionPriority} onChange={event => setAttentionPriority(event.target.value as MailPriority)}><option value="urgent">紧急</option><option value="important">重要</option><option value="normal">常规</option></select></label>
                <textarea value={attentionNote} maxLength={2000} placeholder="补充说明" onChange={event => setAttentionNote(event.target.value)} />
                <button type="button" disabled={attentionBusy} onClick={() => void submitAttention()}>{attentionBusy ? '提交中' : '发起关注'}</button>
              </div>}
              {drawerNotice && <div className="team-crm-drawer-notice">{drawerNotice}</div>}
            </> : <div className="team-admin-inline-empty">客户不存在或不在可见范围</div>}
      </section>
    </div>}
  </div>;
}
