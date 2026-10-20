import { useEffect, useMemo, useRef, useState } from 'react';
import { Segmented, Select, message } from 'antd';
import { BankOutlined, BarChartOutlined, ShareAltOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { ContactList } from '../contacts/ContactList';
import { useQueryClient } from '@tanstack/react-query';
import { useIdentity } from '../../IdentityContext';
import type { CenterContact, CenterContactQuery, CenterContactRef } from '../../../shared/online-crm';
import { createCenterContactPort, createCenterImportPort, centerInvoke } from './centerContactPort';
import { CenterContactDetail } from './CenterContactDetail';
import { CenterContactViews } from './CenterContactViews';
import { ContactAssignments, AssignmentModal } from './ContactAssignments';
import './customers.css';

type LegacyView = 'table' | 'board' | 'company' | 'assignments';
const CUSTOMER_TABLE_DEFER_MS = 180;
const CUSTOMER_TABLE_SKELETON_ROWS = 8;

function ContactTableSkeleton() {
  return <div className="prospector-page-table customer-table-deferred" aria-busy="true" aria-label="联系人列表加载中">
    <div className="customer-table-skeleton-head" aria-hidden="true">
      <span className="customer-table-skeleton-check" />
      <span />
      <span />
      <span />
      <span />
      <span />
      <span />
    </div>
    <div className="customer-table-skeleton-body" aria-hidden="true">
      {Array.from({ length: CUSTOMER_TABLE_SKELETON_ROWS }, (_, index) => <div className="customer-table-skeleton-row" key={index}>
        <span className="customer-table-skeleton-check" />
        <span className="customer-table-skeleton-long" />
        <span />
        <span className="customer-table-skeleton-medium" />
        <span />
        <span className="customer-table-skeleton-short" />
        <span />
      </div>)}
    </div>
  </div>;
}

function readView(): LegacyView {
  const value = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('view');
  if (value === 'board') return 'board';
  if (value === 'company') return 'company';
  if (value === 'assignments') return 'assignments';
  return 'board';
}

/** Original customer shell/presentation, explicitly backed by center contacts. */
export function LegacyCustomersPage() {
  const { identity, baseUrl, status } = useIdentity();
  const qc = useQueryClient();
  const [view, setView] = useState<LegacyView>(readView);
  // 客户页壳体和骨架先独立绘制，联系人大表格在高亮动画和首屏布局稳定后再挂载。
  const [tableReady, setTableReady] = useState(false);
  const operations = identity?.identityAdmin || identity?.crmRoles.some(role => ['operations', 'admin'].includes(role)) || false;
  const [scope, setScope] = useState<NonNullable<CenterContactQuery['scope']>>('all');
  const [assigning, setAssigning] = useState<CenterContact[]>([]);
  const [deepReference, setDeepReference] = useState<CenterContactRef | null>(null);
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLDivElement | null>(null);
  const identityKey = JSON.stringify([baseUrl,identity?.userId,identity?.crmRoles?.slice().sort(),identity?.crmCapabilities?.slice().sort(),identity?.identityAdmin,identity?.mustChangePassword]);
  const activeScope: NonNullable<CenterContactQuery['scope']> = view === 'table' ? 'all' : scope;
  const key = `${identityKey}:${activeScope}`;
  const currentIdentity = useRef(identityKey); currentIdentity.current = identityKey;
  const currentSession = useRef(''); currentSession.current = `${baseUrl}:${identity?.userId}`;
  const port = useMemo(() => createCenterContactPort({ key, scope: activeScope, isCurrent: () => currentIdentity.current === identityKey }), [key, activeScope]);
  const importPort = useMemo(() => { const session = `${baseUrl}:${identity?.userId}`; return createCenterImportPort(centerInvoke, operations, () => { void qc.invalidateQueries({ queryKey: ['center-contacts'] }); }, () => currentSession.current === session); }, [key, operations, qc]);
  useEffect(() => {
    if (view !== 'table') { setTableReady(false); return; }
    const timer = window.setTimeout(() => setTableReady(true), CUSTOMER_TABLE_DEFER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [view]);
  useEffect(() => {
    const onHashChange = () => {
      // Old child pages consume/clear deep links; that must not reset the selected tab.
      if (new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('view')) setView(readView());
      const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
      const contactId = Number(params.get('centerContact'));
      const customerId = params.get('centerCustomer');
      if (Number.isSafeInteger(contactId) && contactId > 0 && customerId) setDeepReference({ contactId, customerId });
    };
    window.addEventListener('hashchange', onHashChange);
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const priorSession = useRef(`${baseUrl}:${identity?.userId}`);
  useEffect(() => { const session = `${baseUrl}:${identity?.userId}`; if (priorSession.current !== session) { priorSession.current = session; setAssigning([]); setDeepReference(null); setScope('all'); } }, [identity?.userId, baseUrl]);
  const sourceFilter = !operations ? <Select size="small" style={{ width: 120 }} aria-label="线索来源" value={scope} onChange={setScope} options={[{ value: 'all', label: '全部' }, { value: 'personal', label: '自有线索' }, { value: 'assigned', label: '分配线索' }]} /> : null;
  const assign = (ids: number[]) => {
    if (status === 'offline') { message.error('分配需要连接服务器'); return; }
    const rows = ids.map(id => port.records.get(id));
    if (rows.some(row => !row?.canAssign)) { message.error('所选联系人包含不可分配项，请刷新后重选'); return; }
    setAssigning(rows as CenterContact[]);
  };
  return <div className="prospector-table-page customer-legacy-page">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Segmented<LegacyView> value={view} onChange={setView} options={[
        { value: 'board', label: '跟进看板', icon: <BarChartOutlined /> },
        { value: 'table', label: '联系人', icon: <UnorderedListOutlined /> },
        { value: 'assignments', label: operations ? '分配管理' : '分配线索', icon: <ShareAltOutlined /> },
        { value: 'company', label: '公司', icon: <BankOutlined /> },
      ]} />
      {view === 'table' && <div ref={setHeaderActionsTarget} className="flex flex-1 min-w-[350px] items-center justify-end" />}
    </div>
    {view === 'table' && (tableReady ? <ContactList key={key} dataPort={port} importPort={importPort} online={status !== 'offline'} headerActionsTarget={headerActionsTarget} onAssign={operations ? assign : undefined} renderDetail={(contact, close) => <CenterContactDetail key={contact?.id ?? 'closed'} reference={contact?.contactId && contact.customerId ? { contactId: contact.contactId, customerId: contact.customerId } : null} onClose={close} />} /> : <ContactTableSkeleton />)}
    {(view === 'board' || view === 'company') && <div className="space-y-3">{sourceFilter}<CenterContactViews key={key} port={port} view={view} /></div>}
    {view === 'assignments' && <ContactAssignments key={`${baseUrl}:${identity?.userId}`} operations={operations} />}
    {assigning.length > 0 && <AssignmentModal key={assigning.map(row => row.contactId).join(',')} contacts={assigning} close={() => setAssigning([])} />}
    {deepReference && <CenterContactDetail key={`${deepReference.customerId}:${deepReference.contactId}`} reference={deepReference} onClose={() => setDeepReference(null)} />}
  </div>;
}
