import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Segmented, Select, Space, Table, Tag, message } from 'antd';
import { ONLINE_CHANNELS, ONLINE_LIMITS, CONTACT_ASSIGNMENT_LIMITS, type ContactAssignment, type ContactAssignmentCreate, type ContactAssignmentDecision, type ContactAssignmentPage, type ContactAssignmentStatus, type MemberPage, type CenterContact } from '../../../shared/online-crm';
import { useIdentity } from '../../IdentityContext';
import { centerInvoke, createCenterContactPort } from './centerContactPort';
import { CenterContactDetail } from './CenterContactDetail';
import { ContactShares } from './ContactSharing';

export function AssignmentModal({ contacts, close }: { contacts: CenterContact[]; close: () => void }) {
  const { identity, baseUrl, status } = useIdentity();
  const qc = useQueryClient();
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const [target, setTarget] = useState<string>();
  const [notify, setNotify] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const retry = useRef<{ signature: string; payload: ContactAssignmentCreate } | null>(null);
  const inspected = useRef(contacts.map(row => ({ contactId: row.contactId, customerId: row.customerId, expectedVersion: row.contactVersion ?? row.customerVersion })));
  const members = useQuery({ queryKey: ['center-assignment-members', baseUrl, identity?.userId], queryFn: async () => {
    const items: MemberPage['items'] = [];
    while (true) { const result = await centerInvoke<MemberPage>(ONLINE_CHANNELS.MEMBERS, { search: '', limit: CONTACT_ASSIGNMENT_LIMITS.pageMax, offset: items.length }); if (!result.ok) throw Error(result.error.message); items.push(...result.data.items); if (items.length >= result.data.total) return items; if (!result.data.items.length) throw Error('成员列表已变化，请重试'); }
  }, enabled: !!contacts.length });
  async function submit() {
    if (!target || busy || status === 'offline') return;
    const content = { contacts: inspected.current, targetUserId: target, notifyUserIds: notify };
    const signature = JSON.stringify(content);
    if (retry.current?.signature !== signature) retry.current = { signature, payload: { ...content, idempotencyKey: crypto.randomUUID() } };
    setBusy(true);
    try { const result = await centerInvoke(ONLINE_CHANNELS.ASSIGNMENT_CREATE, retry.current.payload); if (!current.current) return; if (result.ok) { retry.current = null; void qc.invalidateQueries({ queryKey: ['center-assignment'] }); void qc.invalidateQueries({ queryKey: ['center-contacts'] }); message.success('已发起分配'); close(); } else message.error(result.error.message); }
    catch (error) { message.error(error instanceof Error ? error.message : '分配失败'); }
    finally { setBusy(false); }
  }
  return <Modal title={`分配 ${contacts.length} 个联系人`} open={!!contacts.length} onCancel={() => { if (!busy) close(); }} onOk={submit} okText="分配" confirmLoading={busy} okButtonProps={{ disabled: !target || contacts.length > CONTACT_ASSIGNMENT_LIMITS.batch || status === 'offline' }} width={420}>
    <div className="space-y-3">{members.error && <Alert type="error" message={members.error.message} />}{contacts.length > CONTACT_ASSIGNMENT_LIMITS.batch && <Alert type="error" message={`每次最多分配 ${CONTACT_ASSIGNMENT_LIMITS.batch} 人`} />}<Select aria-label="接收人" style={{ width: '100%' }} placeholder="接收人" value={target} onChange={value => { setTarget(value); setNotify(previous => previous.filter(id => id !== value)); }} loading={members.isLoading} showSearch optionFilterProp="label" options={(members.data ?? []).filter(member => member.assignable).map(member => ({ value: member.userId, label: member.displayName }))} /><Select aria-label="通知人" mode="multiple" style={{ width: '100%' }} placeholder="通知人（可选）" value={notify} maxCount={CONTACT_ASSIGNMENT_LIMITS.notify} onChange={setNotify} options={(members.data ?? []).filter(member => member.userId !== target && member.userId !== identity?.userId).map(member => ({ value: member.userId, label: member.displayName }))} /></div>
  </Modal>;
}

const LABELS: Record<ContactAssignmentStatus, string> = { pending: '待接受', accepted: '已接受', rejected: '已拒绝', cancelled: '已撤回' };
export function ContactAssignments({ operations }: { operations: boolean }) {
  const { identity, baseUrl, status: connection } = useIdentity();
  const qc = useQueryClient();
  const [shareView, setShareView] = useState<'incoming' | 'outgoing'>(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('shareView') === 'outgoing' ? 'outgoing' : 'incoming');
  const [mode, setMode] = useState<'assignments' | 'shares'>(() => operations ? 'assignments' : (new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('sharing') === 'true' ? 'shares' : 'assignments'));
  const [status, setStatus] = useState<ContactAssignmentStatus>(() => { const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('assignmentStatus'); return value && ['pending', 'accepted', 'rejected', 'cancelled'].includes(value) ? value as ContactAssignmentStatus : 'pending'; });
  const [requestId, setRequestId] = useState<string | null>(() => new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('requestId'));
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string>();
  const [selected, setSelected] = useState<ContactAssignment | null>(null);
  const [selectedContact, setSelectedContact] = useState<{ customerId: string; contactId: number } | null>(null);
  const commands = useRef(new Map<string, ContactAssignmentDecision>());
  useEffect(() => { const changed = () => { const params = new URLSearchParams(window.location.hash.split('?')[1] ?? ''); if (!operations && params.get('sharing') === 'true') { setMode('shares'); setShareView(params.get('shareView') === 'outgoing' ? 'outgoing' : 'incoming'); } if (params.get('requestId')) { setRequestId(params.get('requestId')); const value = params.get('assignmentStatus'); if (value && ['pending','accepted','rejected','cancelled'].includes(value)) setStatus(value as ContactAssignmentStatus); } }; window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, [operations]);
  const acceptedPort = useMemo(() => createCenterContactPort({ key: `${baseUrl}:${identity?.userId}:accepted`, assignment: 'accepted' }), [baseUrl, identity?.userId]);
  const query = useQuery({ queryKey: ['center-assignment', baseUrl, identity?.userId, operations, status, search, page, requestId], enabled: mode === 'assignments' && !(operations && status === 'accepted' && !requestId), queryFn: () => centerInvoke<ContactAssignmentPage>(ONLINE_CHANNELS.ASSIGNMENT_LIST, { view: operations ? 'outgoing' : 'incoming', status, search: requestId ? '' : search, limit: requestId ? 1 : CONTACT_ASSIGNMENT_LIMITS.page, offset: requestId ? 0 : (page - 1) * CONTACT_ASSIGNMENT_LIMITS.page, ...(requestId ? { requestId } : {}) }), refetchInterval: ONLINE_LIMITS.pollMs, placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === baseUrl && previousQuery.queryKey[2] === identity?.userId && previousQuery.queryKey[7] === requestId ? previous : undefined });
  const acceptedContacts = useQuery({ queryKey: ['center-contacts', acceptedPort.key, 'awaiting-first-followup'], enabled: mode === 'assignments' && operations && status === 'accepted' && !requestId, queryFn: () => acceptedPort.readAll(), refetchInterval: ONLINE_LIMITS.pollMs });
  const data = query.data?.ok ? query.data.data : undefined;
  const assignmentRows = data?.items ?? [];
  const acceptedRows = (acceptedContacts.data?.data ?? []).filter(row => !['contacted','replied'].includes(row.touchStatus));
  useEffect(() => { const found = requestId && data?.items.find(row => row.requestId === requestId); if (found && found.status !== status) setStatus(found.status); }, [requestId, data, status]);
  const error = query.data && !query.data.ok ? query.data.error.message : query.error?.message;
  async function decide(row: ContactAssignment, action: 'accept' | 'reject' | 'cancel') {
    if (busy || connection === 'offline') return;
    const commandKey = `${row.requestId}:${row.version}:${action}`;
    if (!commands.current.has(commandKey)) commands.current.set(commandKey, { requestId: row.requestId, expectedVersion: row.version, idempotencyKey: crypto.randomUUID() });
    setBusy(row.requestId);
    try { const channel = { accept: ONLINE_CHANNELS.ASSIGNMENT_ACCEPT, reject: ONLINE_CHANNELS.ASSIGNMENT_REJECT, cancel: ONLINE_CHANNELS.ASSIGNMENT_CANCEL }[action]; const result = await centerInvoke(channel, commands.current.get(commandKey)); if (result.ok) { commands.current.delete(commandKey); void qc.invalidateQueries({ queryKey: ['center-assignment'] }); void qc.invalidateQueries({ queryKey: ['center-contacts'] }); void qc.invalidateQueries({ queryKey: ['center-contact-detail'] }); message.success({ accept: '已接受', reject: '已拒绝', cancel: '已撤回' }[action]); } else { message.error(result.error.message); void query.refetch(); } }
    catch (error) { message.error(error instanceof Error ? error.message : '操作失败'); }
    finally { setBusy(undefined); }
  }
  if (mode === 'shares' && !operations) return <div className="prospector-table-page customer-sharing-page"><Segmented value={mode} onChange={() => setMode('assignments')} options={[{value:'assignments',label:'分配'},{value:'shares',label:'共享'}]} /><ContactShares key={shareView} initialView={shareView} onOpen={setSelectedContact} /><CenterContactDetail reference={selectedContact} onClose={() => setSelectedContact(null)} /></div>;
  return <div className="prospector-table-page customer-assignment-page">{!operations && <Segmented value={mode} onChange={() => setMode('shares')} options={[{value:'assignments',label:'分配'},{value:'shares',label:'共享'}]} />}<div className="flex items-center justify-between"><Segmented value={status} onChange={value => { setStatus(value as ContactAssignmentStatus); setPage(1); setRequestId(null); }} options={operations ? [{ value: 'pending', label: '待分配' }, { value: 'accepted', label: '已分配' }] : [{ value: 'pending', label: '待接受' }, { value: 'accepted', label: '已接受' }, { value: 'rejected', label: '已拒绝' }]} />{requestId ? <Button size="small" onClick={() => setRequestId(null)}>查看全部</Button> : !(operations && status === 'accepted') && <Input size="small" style={{ width: 260 }} placeholder="搜索联系人、公司..." value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} allowClear />}</div>{error && <Alert type="error" message={error} />}
    {operations && status === 'accepted' && !requestId ? <div className="customer-assignment-table-wrap">{acceptedContacts.data?.error && <Alert type="error" message={acceptedContacts.data.error} />}<div className="text-xs text-gray-500">待首次跟进</div><Table<CenterContact> className={`prospector-page-table customer-assignment-table${!acceptedContacts.isFetching && acceptedRows.length === 0 ? ' is-empty' : ''}`} size="small" rowKey={row => `${row.customerId}:${row.contactId}`} dataSource={acceptedRows} loading={acceptedContacts.isFetching} pagination={false} columns={[{ title: '联系人', render: (_, row) => [row.firstName,row.lastName].filter(Boolean).join(' ') || row.email }, { title: '公司', dataIndex: 'companyName' }, { title: '负责人', dataIndex: 'ownerName' }, { title: '', render: (_, row) => <Button size="small" type="link" onClick={() => setSelectedContact({ contactId: row.contactId, customerId: row.customerId })}>跟进</Button> }]} /></div> : <Table<ContactAssignment> className={`prospector-page-table customer-assignment-table${!query.isFetching && assignmentRows.length === 0 ? ' is-empty' : ''}`} size="small" rowKey="requestId" dataSource={assignmentRows} loading={query.isFetching} scroll={{ x: 900 }} pagination={{ current: page, pageSize: CONTACT_ASSIGNMENT_LIMITS.page, total: data?.total ?? 0, onChange: setPage, showSizeChanger: false }} columns={[
      { title: '联系人', width: 130, render: (_, row) => <span className="text-xs font-medium">{row.contactName || row.email || '-'}</span> }, { title: '公司', dataIndex: 'companyName', width: 160 }, { title: '发起人', dataIndex: 'actorName', width: 100 }, { title: '接收人', dataIndex: 'targetName', width: 100 }, { title: '时间', width: 160, render: (_, row) => new Date(row.createdAt).toLocaleString('zh-CN') }, { title: '状态', width: 90, render: (_, row) => <Tag>{LABELS[row.status]}</Tag> },
      { title: '', width: 150, render: (_, row) => <Space size={0}>{row.canAccept && <Button type="link" size="small" disabled={connection === 'offline' || !!busy} loading={busy === row.requestId} onClick={() => decide(row, 'accept')}>接受</Button>}{row.canReject && <Button type="link" size="small" disabled={connection === 'offline' || !!busy} onClick={() => decide(row, 'reject')}>拒绝</Button>}{row.canCancel && <Button type="link" size="small" disabled={connection === 'offline' || !!busy} onClick={() => decide(row, 'cancel')}>撤回</Button>}{row.status === 'accepted' && <Button type="link" size="small" onClick={() => setSelected(row)}>跟进</Button>}</Space> },
    ]} />}
    <CenterContactDetail reference={selected ? { contactId: selected.contactId, customerId: selected.customerId } : null} onClose={() => setSelected(null)} />
    <CenterContactDetail reference={selectedContact} onClose={() => setSelectedContact(null)} />
  </div>;
}

