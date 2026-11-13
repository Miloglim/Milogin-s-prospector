import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Segmented, Select, Space, Table, Tag, message } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import { ONLINE_CHANNELS, ONLINE_LIMITS, LEAD_LIMITS, CONTACT_ASSIGNMENT_LIMITS, type ContactAssignment, type ContactAssignmentCreate, type ContactAssignmentDecision, type ContactAssignmentGroup, type ContactAssignmentGroupDecision, type ContactAssignmentGroupPage, type ContactAssignmentLifecycleStatus, type ContactAssignmentPage, type ContactAssignmentTransfer, type MemberPage, type CenterContact } from '../../../shared/online-crm';
import { useIdentity } from '../../IdentityContext';
import { centerInvoke, createCenterContactPort } from './centerContactPort';
import { CenterContactDetail } from './CenterContactDetail';
import { ContactShares } from './ContactSharing';
import { AssignmentGroupOverview } from './AssignmentGroupOverview';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const ASSIGNMENT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ASSIGNMENT_STATUSES: readonly ContactAssignmentLifecycleStatus[] = ['pending', 'accepted', 'rejected', 'cancelled', 'expired', 'pending_transfer'];
export const ASSIGNMENT_STATUS_LABELS: Record<ContactAssignmentLifecycleStatus, string> = {
  pending: '待接受',
  accepted: '已接受',
  rejected: '已拒绝',
  cancelled: '已撤回',
  expired: '已过期',
  pending_transfer: '转交待确认',
};

function lifecycleStatus(value: string): ContactAssignmentLifecycleStatus {
  return ASSIGNMENT_STATUSES.includes(value as ContactAssignmentLifecycleStatus) ? value as ContactAssignmentLifecycleStatus : 'cancelled';
}

function statusOptions(operations: boolean) {
  return ASSIGNMENT_STATUSES.map(value => ({
    value,
    label: value === 'pending'
      ? operations ? '待分配' : '待接受'
      : value === 'accepted' && operations ? '已分配' : ASSIGNMENT_STATUS_LABELS[value],
  }));
}

function statusColor(status: ContactAssignmentLifecycleStatus) {
  if (status === 'accepted') return 'success';
  if (status === 'rejected') return 'error';
  if (status === 'expired') return 'warning';
  if (status === 'pending_transfer') return 'processing';
  return 'default';
}

function assignmentHashId(name: 'requestId' | 'groupId'): string | null {
  const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get(name);
  return value && ASSIGNMENT_ID_PATTERN.test(value) ? value : null;
}

function expiryText(row: ContactAssignment) {
  const expiresAt = Date.parse(row.expiresAt);
  if (!Number.isFinite(expiresAt)) return '';
  const exact = new Date(expiresAt).toLocaleString('zh-CN');
  const status = lifecycleStatus(row.status);
  if (status === 'expired') return `已于 ${exact} 过期`;
  if (status !== 'pending' && status !== 'pending_transfer') return '';
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) return '即将过期';
  if (remaining < HOUR_MS) return '剩余不到 1 小时';
  if (remaining < DAY_MS) return `剩余 ${Math.ceil(remaining / HOUR_MS)} 小时`;
  return `剩余 ${Math.ceil(remaining / DAY_MS)} 天`;
}

async function searchAssignmentMembers(search: string): Promise<MemberPage['items']> {
  const result = await centerInvoke<MemberPage>(ONLINE_CHANNELS.MEMBERS, { search, limit: LEAD_LIMITS.pageMax, offset: 0 });
  if (!result.ok) throw Error(result.error.message);
  return result.data.items;
}

function memberRoleLabel(member: MemberPage['items'][number]): string {
  return member.isSupervisor ? '主管' : '销售';
}

function memberOptionLabel(member: MemberPage['items'][number]): string {
  const detail = [member.email, ...(member.teamNames ?? [])].filter(Boolean).join(' · ');
  return detail ? `${member.displayName} · ${detail}` : member.displayName;
}

export function AssignmentModal({ contacts, close }: { contacts: CenterContact[]; close: () => void }) {
  const { identity, baseUrl, status } = useIdentity();
  const qc = useQueryClient();
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const [target, setTarget] = useState<string>();
  const [targetMember, setTargetMember] = useState<MemberPage['items'][number] | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const deferredMemberSearch = useDeferredValue(memberSearch.trim());
  const [supervisorIds, setSupervisorIds] = useState<string[]>([]);
  const [selectedSupervisors, setSelectedSupervisors] = useState<MemberPage['items']>([]);
  const [supervisorSearch, setSupervisorSearch] = useState('');
  const deferredSupervisorSearch = useDeferredValue(supervisorSearch.trim());
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const retry = useRef<{ signature: string; payload: ContactAssignmentCreate } | null>(null);
  const inspected = useRef(contacts.map(row => ({ contactId: row.contactId, customerId: row.customerId, expectedVersion: row.contactVersion ?? row.customerVersion })));
  const members = useQuery({ queryKey: ['center-assignment-members', baseUrl, identity?.userId, deferredMemberSearch], queryFn: () => searchAssignmentMembers(deferredMemberSearch), enabled: !!contacts.length, placeholderData: previous => previous });
  const supervisorMembers = useQuery({ queryKey: ['center-assignment-supervisors', baseUrl, identity?.userId, deferredSupervisorSearch], queryFn: () => searchAssignmentMembers(deferredSupervisorSearch), enabled: !!contacts.length, placeholderData: previous => previous });
  const supervisorCandidates = (supervisorMembers.data ?? []).filter(member => member.userId !== target);
  const ownedCount = contacts.filter(contact => !!contact.ownerUserId).length;
  const pendingCount = contacts.filter(contact => !contact.ownerUserId && !!contact.assignmentStatus).length;
  const personalCount = contacts.filter(contact => contact.origin !== 'operations').length;
  const blockedCount = contacts.filter(contact => contact.origin !== 'operations' || !!contact.ownerUserId || !!contact.assignmentStatus).length;
  async function submit() {
    if (!target || busy || submitting.current || status === 'offline') return;
    const content = { contacts: inspected.current, targetUserId: target, ...(supervisorIds.length ? { supervisorUserIds: supervisorIds } : {}) };
    const signature = JSON.stringify(content);
    if (retry.current?.signature !== signature) retry.current = { signature, payload: { ...content, idempotencyKey: crypto.randomUUID() } };
    submitting.current = true;
    setBusy(true);
    try { const result = await centerInvoke(ONLINE_CHANNELS.ASSIGNMENT_CREATE, retry.current.payload); if (!current.current) return; if (result.ok) { retry.current = null; void qc.invalidateQueries({ queryKey: ['center-assignment'] }); void qc.invalidateQueries({ queryKey: ['center-assignment-groups'] }); void qc.invalidateQueries({ queryKey: ['center-contacts'] }); message.success('已发起分配'); close(); } else if (result.error.code === 'CONFLICT' && result.error.message.includes('联系人信息已更新')) { void qc.invalidateQueries({ queryKey: ['center-contacts'] }); message.error({ key: 'assignment-create-error', content: '联系人信息已更新，列表已刷新，请重新选择' }); close(); } else message.error({ key: 'assignment-create-error', content: result.error.message }); }
    catch (error) { message.error({ key: 'assignment-create-error', content: error instanceof Error ? error.message : '分配失败' }); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <Modal title={`分配 ${contacts.length} 个联系人`} open={!!contacts.length} onCancel={() => { if (!busy) close(); }} onOk={submit} okText="分配" confirmLoading={busy} okButtonProps={{ disabled: !target || contacts.length > CONTACT_ASSIGNMENT_LIMITS.batch || blockedCount > 0 || status === 'offline' }} width={420}>
    <div className="assignment-modal-body">{members.error && <Alert type="error" message={members.error.message} />}{contacts.length > CONTACT_ASSIGNMENT_LIMITS.batch && <Alert type="error" message={`每次最多分配 ${CONTACT_ASSIGNMENT_LIMITS.batch} 人`} />}{personalCount > 0 && <Alert type="warning" showIcon message={`${personalCount} 条个人线索不在管理员分配范围`} />}{ownedCount > 0 && <Alert type="warning" showIcon message={`${ownedCount} 个联系人已有负责人`} />}{pendingCount > 0 && <Alert type="warning" showIcon message={`${pendingCount} 个联系人已有进行中的分配`} />}<div className="assignment-batch-summary"><span><b>{contacts.length}</b> 个联系人</span><span>{personalCount ? `${personalCount} 个个人线索` : ownedCount ? `${ownedCount} 个已有负责人` : pendingCount ? `${pendingCount} 个分配中` : '均未分配'}</span></div><Select aria-label="接收人" style={{ width: '100%' }} placeholder="接收人" value={target} onChange={(value: string) => { setTarget(value); setTargetMember((members.data ?? []).find(member => member.userId === value) ?? null); setSupervisorIds(previous => previous.filter(id => id !== value)); setSelectedSupervisors(previous => previous.filter(member => member.userId !== value)); }} loading={members.isLoading} showSearch filterOption={false} onSearch={setMemberSearch} options={(members.data ?? []).filter(member => member.assignable).map(member => ({ value: member.userId, label: memberOptionLabel(member) }))} />{targetMember && <div className="assignment-recipient-summary"><strong>{targetMember.displayName}</strong><span>{memberRoleLabel(targetMember)}{targetMember.email ? ` · ${targetMember.email}` : ''}</span><small>{targetMember.teamNames?.length ? `团队 ${targetMember.teamNames.join(' / ')}` : '未加入销售团队'}</small><small>{targetMember.supervisorNames?.length ? `将通知主管 ${targetMember.supervisorNames.join(' / ')}` : '无直属主管'}</small></div>}<label className="assignment-supervisor-field"><span>通知用户</span><Select aria-label="通知用户" mode="multiple" style={{ width: '100%' }} placeholder="选择需要通知的同事" value={supervisorIds} onChange={(values: string[]) => { setSupervisorIds(values); setSelectedSupervisors(previous => values.map(value => supervisorCandidates.find(member => member.userId === value) ?? previous.find(member => member.userId === value)).filter((member): member is MemberPage['items'][number] => !!member)); }} loading={supervisorMembers.isLoading} showSearch filterOption={false} onSearch={setSupervisorSearch} options={supervisorCandidates.map(member => ({ value: member.userId, label: memberOptionLabel(member) }))} /></label>{selectedSupervisors.length > 0 && <div className="assignment-recipient-summary is-compact"><span>已选通知用户</span><small>{selectedSupervisors.map(member => member.displayName).join(' / ')}</small></div>}{supervisorMembers.error && <Alert type="error" message={supervisorMembers.error.message} />}</div>
  </Modal>;
}

export function AssignmentTransferModal({ assignment, close }: { assignment: ContactAssignment | null; close: () => void }) {
  const { identity, baseUrl, status } = useIdentity();
  const qc = useQueryClient();
  const current = useRef(true);
  const [target, setTarget] = useState('');
  const [selectedMember, setSelectedMember] = useState<MemberPage['items'][number] | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  const deferredMemberSearch = useDeferredValue(memberSearch.trim());
  const [busy, setBusy] = useState(false);
  const retry = useRef<{ signature: string; payload: ContactAssignmentTransfer } | null>(null);
  useEffect(() => { current.current = true; setTarget(''); setSelectedMember(null); setMemberSearch(''); retry.current = null; return () => { current.current = false; }; }, [assignment?.requestId, assignment?.version]);
  const members = useQuery({ queryKey: ['center-assignment-members', baseUrl, identity?.userId, deferredMemberSearch], queryFn: () => searchAssignmentMembers(deferredMemberSearch), enabled: !!assignment });
  const candidates = (members.data ?? []).filter(member => member.assignable && member.userId !== assignment?.targetUserId);
  const selectedName = selectedMember?.displayName;
  async function submit() {
    if (!assignment || !target || busy || status === 'offline') return;
    const content = { requestId: assignment.requestId, targetUserId: target, expectedVersion: assignment.version };
    const signature = JSON.stringify(content);
    if (retry.current?.signature !== signature) retry.current = { signature, payload: { ...content, idempotencyKey: crypto.randomUUID() } };
    setBusy(true);
    try {
      const result = await centerInvoke(ONLINE_CHANNELS.ASSIGNMENT_TRANSFER, retry.current.payload);
      if (!current.current) return;
      if (result.ok) {
        retry.current = null;
        for (const queryKey of ['center-assignment', 'center-assignment-groups', 'center-contacts', 'center-contact-detail']) void qc.invalidateQueries({ queryKey: [queryKey] });
        message.success('已发起转交');
        close();
      } else {
        if (result.error.code === 'CONFLICT') retry.current = null;
        message.error(result.error.message);
        void qc.invalidateQueries({ queryKey: ['center-assignment'] });
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '转交失败');
    } finally {
      setBusy(false);
    }
  }
  return <Modal title="转交联系人" open={!!assignment} onCancel={() => { if (!busy) close(); }} onOk={submit} okText="确认转交" confirmLoading={busy} okButtonProps={{ disabled: !target || status === 'offline' }} width={420}>
    {assignment && <div className="assignment-transfer-dialog">
      {members.error && <Alert type="error" message={members.error.message} />}
      <div className="assignment-transfer-route"><span>{assignment.targetName}</span><ArrowRightOutlined /><span>{selectedName ?? '选择接收人'}</span></div>
      <Select aria-label="转交接收人" style={{ width: '100%' }} placeholder="接收人" value={target || undefined} onChange={(value: string) => { setTarget(value); setSelectedMember(candidates.find(member => member.userId === value) ?? null); }} loading={members.isLoading} showSearch filterOption={false} onSearch={setMemberSearch} options={candidates.map(member => ({ value: member.userId, label: memberOptionLabel(member) }))} />
      {selectedMember && <div className="assignment-recipient-summary"><strong>{selectedMember.displayName}</strong><span>{memberRoleLabel(selectedMember)}{selectedMember.email ? ` · ${selectedMember.email}` : ''}</span><small>{selectedMember.teamNames?.length ? `团队 ${selectedMember.teamNames.join(' / ')}` : '未加入销售团队'}</small><small>{selectedMember.supervisorNames?.length ? `将通知主管 ${selectedMember.supervisorNames.join(' / ')}` : '无直属主管'}</small></div>}
    </div>}
  </Modal>;
}

export function ContactAssignments({ operations }: { operations: boolean }) {
  const { identity, baseUrl, status: connection } = useIdentity();
  const qc = useQueryClient();
  const [shareView, setShareView] = useState<'incoming' | 'outgoing'>(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('shareView') === 'outgoing' ? 'outgoing' : 'incoming');
  const [mode, setMode] = useState<'assignments' | 'shares'>(() => operations ? 'assignments' : (new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('sharing') === 'true' ? 'shares' : 'assignments'));
  const [status, setStatus] = useState<ContactAssignmentLifecycleStatus>(() => { const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('assignmentStatus'); return value && ASSIGNMENT_STATUSES.includes(value as ContactAssignmentLifecycleStatus) ? value as ContactAssignmentLifecycleStatus : 'pending'; });
  const [requestId, setRequestId] = useState<string | null>(() => assignmentHashId('requestId'));
  const [groupId,setGroupId]=useState<string|null>(()=>assignmentHashId('groupId'));
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string>();
  const [selected, setSelected] = useState<ContactAssignment | null>(null);
  const [transferring, setTransferring] = useState<ContactAssignment | null>(null);
  const [selectedContact, setSelectedContact] = useState<{ customerId: string; contactId: number } | null>(null);
  const commands = useRef(new Map<string, ContactAssignmentDecision>());
  const groupCommands=useRef(new Map<string,ContactAssignmentGroupDecision>());
  useEffect(() => { const changed = () => { const params = new URLSearchParams(window.location.hash.split('?')[1] ?? ''); if (!operations && params.get('sharing') === 'true') { setMode('shares'); setShareView(params.get('shareView') === 'outgoing' ? 'outgoing' : 'incoming'); } setRequestId(assignmentHashId('requestId')); setGroupId(assignmentHashId('groupId')); const value = params.get('assignmentStatus'); if (value && ASSIGNMENT_STATUSES.includes(value as ContactAssignmentLifecycleStatus)) setStatus(value as ContactAssignmentLifecycleStatus); }; window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, [operations]);
  const acceptedPort = useMemo(() => createCenterContactPort({ key: `${baseUrl}:${identity?.userId}:accepted`, assignment: 'accepted' }), [baseUrl, identity?.userId]);
  const groupsQuery=useQuery({queryKey:['center-assignment-groups',baseUrl,identity?.userId,operations,status,search,page],enabled:mode==='assignments'&&!requestId&&!groupId&&!(operations&&status==='accepted'),queryFn:()=>centerInvoke<ContactAssignmentGroupPage>(ONLINE_CHANNELS.ASSIGNMENT_GROUPS,{view:operations?'outgoing':'incoming',status,search,limit:CONTACT_ASSIGNMENT_LIMITS.page,offset:(page-1)*CONTACT_ASSIGNMENT_LIMITS.page}),refetchInterval:ONLINE_LIMITS.pollMs,placeholderData:previous=>previous});
  const query = useQuery({ queryKey: ['center-assignment', baseUrl, identity?.userId, operations, status, search, page, requestId, groupId], enabled: mode === 'assignments' && (!!requestId||!!groupId), queryFn: () => centerInvoke<ContactAssignmentPage>(ONLINE_CHANNELS.ASSIGNMENT_LIST, { view: operations ? 'outgoing' : 'incoming', status, search:'', limit:requestId?1:200, offset:0, ...(requestId ? { requestId } : {}), ...(groupId ? { groupId } : {}) }), refetchInterval: ONLINE_LIMITS.pollMs, placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === baseUrl && previousQuery.queryKey[2] === identity?.userId ? previous : undefined });
  const acceptedContacts = useQuery({ queryKey: ['center-contacts', acceptedPort.key, 'awaiting-first-followup'], enabled: mode === 'assignments' && operations && status === 'accepted' && !requestId && !groupId, queryFn: () => acceptedPort.readAll(), refetchInterval: ONLINE_LIMITS.pollMs });
  const data = query.data?.ok ? query.data.data : undefined;
  const groupData=groupsQuery.data?.ok?groupsQuery.data.data:undefined;
  const assignmentRows = data?.items ?? [];
  const assignmentGroups=groupData?.items??[];
  const acceptedRows = (acceptedContacts.data?.data ?? []).filter(row => !['contacted','replied'].includes(row.touchStatus));
  useEffect(() => { const found = requestId && data?.items.find(row => row.requestId === requestId); if (found) { const next = lifecycleStatus(found.status); if (next !== status) setStatus(next); } }, [requestId, data, status]);
  const error = (groupsQuery.data&&!groupsQuery.data.ok?groupsQuery.data.error.message:groupsQuery.error?.message)||(query.data&&!query.data.ok?query.data.error.message:query.error?.message);
  async function decide(row: ContactAssignment, action: 'accept' | 'reject' | 'cancel') {
    if (busy || connection === 'offline') return;
    const commandKey = `${row.requestId}:${row.version}:${action}`;
    if (!commands.current.has(commandKey)) commands.current.set(commandKey, { requestId: row.requestId, expectedVersion: row.version, idempotencyKey: crypto.randomUUID() });
    setBusy(row.requestId);
    try { const channel = { accept: ONLINE_CHANNELS.ASSIGNMENT_ACCEPT, reject: ONLINE_CHANNELS.ASSIGNMENT_REJECT, cancel: ONLINE_CHANNELS.ASSIGNMENT_CANCEL }[action]; const result = await centerInvoke(channel, commands.current.get(commandKey)); if (result.ok) { commands.current.delete(commandKey); void qc.invalidateQueries({ queryKey: ['center-assignment'] }); void qc.invalidateQueries({ queryKey: ['center-assignment-groups'] }); void qc.invalidateQueries({ queryKey: ['center-contacts'] }); void qc.invalidateQueries({ queryKey: ['center-contact-detail'] }); message.success({ accept: '已接受', reject: '已拒绝', cancel: '已撤回' }[action]); } else { message.error(result.error.message); void query.refetch(); } }
    catch (error) { message.error(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(undefined); }
  }
  async function decideGroup(group:ContactAssignmentGroup,action:'accept'|'reject'|'cancel'){
    if(busy||connection==='offline')return;
    const commandKey=`${group.groupId}:${action}`;
    if(!groupCommands.current.has(commandKey))groupCommands.current.set(commandKey,{groupId:group.groupId,idempotencyKey:crypto.randomUUID()});
    setBusy(group.groupId);
    try{
      const channel={accept:ONLINE_CHANNELS.ASSIGNMENT_GROUP_ACCEPT,reject:ONLINE_CHANNELS.ASSIGNMENT_GROUP_REJECT,cancel:ONLINE_CHANNELS.ASSIGNMENT_GROUP_CANCEL}[action];
      const result=await centerInvoke(channel,groupCommands.current.get(commandKey));
      if(result.ok){groupCommands.current.delete(commandKey);void qc.invalidateQueries({queryKey:['center-assignment']});void qc.invalidateQueries({queryKey:['center-assignment-groups']});void qc.invalidateQueries({queryKey:['center-contacts']});message.success({accept:'已接受整组',reject:'已拒绝整组',cancel:'已撤回整组'}[action]);}
      else{message.error(result.error.message);void groupsQuery.refetch();if(groupId)void query.refetch();}
    }catch(error){message.error(error instanceof Error?error.message:'操作失败');}
    finally{setBusy(undefined);}
  }
  if (mode === 'shares' && !operations) return <div className="prospector-table-page customer-sharing-page"><Segmented value={mode} onChange={() => setMode('assignments')} options={[{value:'assignments',label:'分配'},{value:'shares',label:'共享'}]} /><ContactShares key={shareView} initialView={shareView} onOpen={setSelectedContact} /><CenterContactDetail reference={selectedContact} onClose={() => setSelectedContact(null)} /></div>;
  if (mode === 'assignments' && !requestId && !groupId && !(operations && status === 'accepted')) return <div className="prospector-table-page customer-assignment-page">
    {!operations&&<Segmented value={mode} onChange={()=>setMode('shares')} options={[{value:'assignments',label:'分配'},{value:'shares',label:'共享'}]}/>}
    <div className="customer-assignment-toolbar"><Segmented value={status} onChange={value=>{setStatus(value as ContactAssignmentLifecycleStatus);setPage(1);setRequestId(null);setGroupId(null);}} options={statusOptions(operations)}/><Input className="customer-assignment-search" size="small" placeholder="搜索联系人、公司..." value={search} onChange={event=>{setSearch(event.target.value);setPage(1);}} allowClear/></div>
    {error&&<Alert type="error" message={error}/>}
    <AssignmentGroupOverview groups={assignmentGroups} total={groupData?.total??0} page={page} loading={groupsQuery.isFetching} busy={busy} offline={connection==='offline'} operations={operations} onOpen={group=>{setRequestId(null);setGroupId(group.groupId);}} onAction={decideGroup} onPage={setPage}/>
  </div>;
  return <div className="prospector-table-page customer-assignment-page">{!operations && <Segmented value={mode} onChange={() => setMode('shares')} options={[{value:'assignments',label:'分配'},{value:'shares',label:'共享'}]} />}<div className="customer-assignment-toolbar"><Segmented value={status} onChange={value => { setStatus(value as ContactAssignmentLifecycleStatus); setPage(1); setRequestId(null); setGroupId(null); }} options={statusOptions(operations)} />{requestId||groupId ? <Button size="small" onClick={() => { setRequestId(null); setGroupId(null); }}>{groupId?'返回分组':'查看全部'}</Button> : !(operations && status === 'accepted') && <Input className="customer-assignment-search" size="small" placeholder="搜索联系人、公司..." value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} allowClear />}</div>{error && <Alert type="error" message={error} />}
    {operations && status === 'accepted' && !requestId ? <div className="customer-assignment-table-wrap">{acceptedContacts.data?.error && <Alert type="error" message={acceptedContacts.data.error} />}<div className="customer-assignment-section-label">待首次跟进</div><Table<CenterContact> className={`prospector-page-table customer-assignment-table${!acceptedContacts.isFetching && acceptedRows.length === 0 ? ' is-empty' : ''}`} size="small" rowKey={row => `${row.customerId}:${row.contactId}`} dataSource={acceptedRows} loading={acceptedContacts.isFetching} pagination={false} columns={[{ title: '联系人', render: (_, row) => [row.firstName,row.lastName].filter(Boolean).join(' ') || row.email }, { title: '公司', dataIndex: 'companyName' }, { title: '负责人', dataIndex: 'ownerName' }, { title: '', render: (_, row) => <Button size="small" type="link" onClick={() => setSelectedContact({ contactId: row.contactId, customerId: row.customerId })}>跟进</Button> }]} /></div> : <Table<ContactAssignment> className={`prospector-page-table customer-assignment-table${!query.isFetching && assignmentRows.length === 0 ? ' is-empty' : ''}`} size="small" rowKey="requestId" dataSource={assignmentRows} loading={query.isFetching} scroll={{ x: 1040 }} pagination={{ current: page, pageSize: CONTACT_ASSIGNMENT_LIMITS.page, total: data?.total ?? 0, onChange: setPage, showSizeChanger: false }} columns={[
      { title: '联系人', width: 130, render: (_, row) => <span className="text-xs font-medium">{row.contactName || row.email || '-'}</span> }, { title: '公司', dataIndex: 'companyName', width: 160 }, { title: '发起人', dataIndex: 'actorName', width: 100 }, { title: '接收人', dataIndex: 'targetName', width: 100 }, { title: '时间', width: 150, render: (_, row) => new Date(row.createdAt).toLocaleString('zh-CN') },
      { title: '状态', width: 140, render: (_, row) => { const current = lifecycleStatus(row.status); const expiry = expiryText(row); return <div className="customer-assignment-status"><Tag color={statusColor(current)}>{ASSIGNMENT_STATUS_LABELS[current]}</Tag>{expiry && <small title={new Date(row.expiresAt).toLocaleString('zh-CN')}>{expiry}</small>}</div>; } },
      { title: '', width: 210, render: (_, row) => { const current = lifecycleStatus(row.status); if (current === 'expired') return <span className="customer-assignment-readonly">只读</span>; return <Space size={0}>{row.canAccept && <Button type="link" size="small" disabled={connection === 'offline' || !!busy} loading={busy === row.requestId} onClick={() => decide(row, 'accept')}>接受</Button>}{row.canReject && <Button type="link" size="small" disabled={connection === 'offline' || !!busy} onClick={() => decide(row, 'reject')}>拒绝</Button>}{row.canCancel && <Button type="link" size="small" disabled={connection === 'offline' || !!busy} onClick={() => decide(row, 'cancel')}>撤回</Button>}{current === 'accepted' && row.canTransfer && <Button type="link" size="small" disabled={connection === 'offline' || !!busy} onClick={() => setTransferring(row)}>转交</Button>}{current === 'accepted' && <Button type="link" size="small" onClick={() => setSelected(row)}>跟进</Button>}</Space>; } },
    ]} />}
    <CenterContactDetail reference={selected ? { contactId: selected.contactId, customerId: selected.customerId } : null} onClose={() => setSelected(null)} />
    <CenterContactDetail reference={selectedContact} onClose={() => setSelectedContact(null)} />
    <AssignmentTransferModal assignment={transferring} close={() => setTransferring(null)} />
  </div>;
}

