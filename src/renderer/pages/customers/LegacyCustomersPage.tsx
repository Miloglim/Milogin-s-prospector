import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Segmented, Select, Tag, message } from 'antd';
import { BankOutlined, BarChartOutlined, LeftOutlined, ShareAltOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { ContactList } from '../contacts/ContactList';
import { useQueryClient } from '@tanstack/react-query';
import { useIdentity } from '../../IdentityContext';
import { invalidateDomain } from '../../lib/cacheDeps';
import { CONTACT_ASSIGNMENT_LIMITS, type CenterContact, type CenterContactGroup, type CenterContactGroupDimension, type CenterContactQuery, type CenterContactRef } from '../../../shared/online-crm';
import { createCenterContactPort, createCenterImportPort, centerInvoke } from './centerContactPort';
import { CenterContactDetail } from './CenterContactDetail';
import * as ContactDetailViews from './CenterContactDetail';
import { CenterContactViews } from './CenterContactViews';
import { ContactAssignments, AssignmentModal } from './ContactAssignments';
import { ContactGroups, type ContactGroupSelection } from './ContactGroups';
import './customers.css';

type LegacyView = 'groups' | 'table' | 'board' | 'company' | 'assignments';
const CUSTOMER_TABLE_DEFER_MS = 180;
const CUSTOMER_TABLE_SKELETON_ROWS = 8;

function MonitorDetailSlot({ reference, onClose }: { reference: CenterContactRef; onClose: () => void }) {
  const MonitorDetail = ContactDetailViews.ContactMonitorDetail;
  return MonitorDetail ? <MonitorDetail reference={reference} onClose={onClose} /> : null;
}

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
  if (value === 'groups') return 'groups';
  if (value === 'table') return 'table';
  if (value === 'company') return 'company';
  if (value === 'assignments') return 'assignments';
  return 'board';
}
function readContactGroup():ContactGroupSelection|null {
  const params=new URLSearchParams(window.location.hash.split('?')[1]??'');
  const dimension=params.get('groupDimension'),key=params.get('groupKey'),label=params.get('groupLabel');
  return dimension&&['batch','country','company','clientType'].includes(dimension)&&key&&label?{dimension:dimension as CenterContactGroupDimension,key,label}:null;
}
function readMonitorReference(): CenterContactRef | null {
  const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
  const contactId = Number(params.get('monitorContact'));
  const customerId = params.get('centerCustomer');
  return Number.isSafeInteger(contactId) && contactId > 0 && customerId ? { contactId, customerId } : null;
}

/** Original customer shell/presentation, explicitly backed by center contacts. */
export function LegacyCustomersPage() {
  const { identity, baseUrl, status } = useIdentity();
  const qc = useQueryClient();
  const [view, setView] = useState<LegacyView>(readView);
  const [contactGroup,setContactGroup]=useState<ContactGroupSelection|null>(readContactGroup);
  // 客户页壳体和骨架先独立绘制，联系人大表格在高亮动画和首屏布局稳定后再挂载。
  const [tableReady, setTableReady] = useState(false);
  const operations = identity?.identityAdmin || identity?.crmRoles.some(role => ['operations', 'admin'].includes(role)) || false;
  const [scope, setScope] = useState<NonNullable<CenterContactQuery['scope']>>('all');
  const [assigning, setAssigning] = useState<CenterContact[]>([]);
  const [deepReference, setDeepReference] = useState<CenterContactRef | null>(null);
  const [monitorReference, setMonitorReference] = useState<CenterContactRef | null>(readMonitorReference);
  const [headerActionsTarget, setHeaderActionsTarget] = useState<HTMLDivElement | null>(null);
  const identityKey = JSON.stringify([baseUrl,identity?.userId,identity?.crmRoles?.slice().sort(),identity?.crmCapabilities?.slice().sort(),identity?.identityAdmin,identity?.mustChangePassword]);
  const activeScope: NonNullable<CenterContactQuery['scope']> = view === 'table' || view === 'groups' ? 'all' : scope;
  const key = `${identityKey}:${activeScope}:${contactGroup?.dimension??''}:${contactGroup?.key??''}`;
  const currentIdentity = useRef(identityKey); currentIdentity.current = identityKey;
  const currentSession = useRef(''); currentSession.current = `${baseUrl}:${identity?.userId}`;
  const port = useMemo(() => createCenterContactPort({ key, scope: activeScope, group:contactGroup?{groupDimension:contactGroup.dimension,groupKey:contactGroup.key}:undefined, isCurrent: () => currentIdentity.current === identityKey }), [key, activeScope, contactGroup?.dimension, contactGroup?.key]);
  const importPort = useMemo(() => { const session = `${baseUrl}:${identity?.userId}`; return createCenterImportPort(centerInvoke, operations, () => {
    void invalidateDomain(qc, 'contacts', 'companies');
    void qc.refetchQueries({ queryKey: ['center-companies'], type: 'inactive' });
    void qc.refetchQueries({ queryKey: ['center-company-detail'], type: 'inactive' });
  }, () => currentSession.current === session); }, [key, operations, qc]);
  useEffect(() => {
    if (view !== 'table' && view !== 'groups') { setTableReady(false); return; }
    const timer = window.setTimeout(() => setTableReady(true), CUSTOMER_TABLE_DEFER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [view]);
  useEffect(() => {
    const onHashChange = () => {
      // Old child pages consume/clear deep links; that must not reset the selected tab.
      if (new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('view')) setView(readView());
      setContactGroup(readContactGroup());
      const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
      const contactId = Number(params.get('centerContact'));
      const customerId = params.get('centerCustomer');
      const monitor = readMonitorReference();
      setMonitorReference(monitor);
      if (monitor) setDeepReference(null);
      else if (Number.isSafeInteger(contactId) && contactId > 0 && customerId) setDeepReference({ contactId, customerId });
      else setDeepReference(null);
    };
    window.addEventListener('hashchange', onHashChange);
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const priorSession = useRef(`${baseUrl}:${identity?.userId}`);
  useEffect(() => { const session = `${baseUrl}:${identity?.userId}`; if (priorSession.current !== session) { priorSession.current = session; setAssigning([]); setDeepReference(null); setMonitorReference(null); setScope('all'); } }, [identity?.userId, baseUrl]);
  const sourceFilter = !operations ? <Select size="small" style={{ width: 120 }} aria-label="线索来源" value={scope} onChange={setScope} options={[{ value: 'all', label: '全部' }, { value: 'personal', label: '自有线索' }, { value: 'assigned', label: '分配线索' }]} /> : null;
  const assign = (ids: number[]) => {
    if (status === 'offline') { message.error('分配需要连接服务器'); return; }
    const rows = ids.map(id => port.records.get(id));
    if (rows.some(row => !row?.canAssign)) { message.error('所选联系人包含不可分配项，请刷新后重选'); return; }
    setAssigning(rows as CenterContact[]);
  };
  const assignGroups = async (dimension:CenterContactGroupDimension, groups:CenterContactGroup[]) => {
    if (status === 'offline') { message.error('分配需要连接服务器'); return false; }
    if (groups.reduce((total,group)=>total+group.count,0)>CONTACT_ASSIGNMENT_LIMITS.batch) { message.error(`每次最多分配 ${CONTACT_ASSIGNMENT_LIMITS.batch} 人`); return false; }
    const session = `${baseUrl}:${identity?.userId}`;
    try {
      const results = await Promise.all(groups.map(group => createCenterContactPort({
        key:`${key}:assignment:${dimension}:${group.key}`, scope:'all',
        group:{groupDimension:dimension,groupKey:group.key},
        isCurrent:()=>currentIdentity.current===identityKey&&currentSession.current===session,
      }).readAll()));
      const failed = results.find(result=>!result.success);
      if (failed) { message.error(failed.error ?? '联系人读取失败'); return false; }
      const contacts = new Map<number,CenterContact>();
      results.forEach(result=>result.data?.forEach(contact=>contacts.set(contact.contactId,contact)));
      const rows = [...contacts.values()];
      if (!rows.length) { message.error('所选分组没有可分配联系人'); return false; }
      if (rows.length>CONTACT_ASSIGNMENT_LIMITS.batch) { message.error(`每次最多分配 ${CONTACT_ASSIGNMENT_LIMITS.batch} 人`); return false; }
      if (rows.some(row=>!row.canAssign)) { message.error('所选联系人包含不可分配项，请刷新后重选'); return false; }
      setAssigning(rows);
      return true;
    } catch (error) {
      message.error(error instanceof Error ? error.message : '联系人读取失败');
      return false;
    }
  };
  const selectGroup=(selection:ContactGroupSelection|null)=>{setContactGroup(selection);if(view!=='groups')setView('table')};
  const openGroups=()=>{setContactGroup(null);setView('groups')};
  const changeView=(next:LegacyView)=>{if(next==='table'){openGroups();return;}setContactGroup(null);setView(next)};
  const groupMetrics=[
    {label:'待触达',value:contactGroup?.count===undefined?'—':Math.max(0,contactGroup.count-(contactGroup.touchedCount??0)),note:'尚未形成有效触达'},
    {label:'已触达',value:contactGroup?.touchedCount??'—',note:'已联系、回复或退信'},
    {label:'覆盖公司',value:contactGroup?.companyCount??'—',note:'当前分组内公司数'},
    {label:'覆盖国家',value:contactGroup?.countryCount??'—',note:'当前分组国家范围'},
  ];
  return <div className="prospector-table-page customer-legacy-page">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Segmented<LegacyView> className="customer-legacy-viewbar" value={view==='table'?'groups':view} onChange={changeView} options={[
        { value: 'board', label: '跟进看板', icon: <BarChartOutlined /> },
        { value: 'groups', label: '联系人', icon: <UnorderedListOutlined /> },
        { value: 'assignments', label: operations ? '分配管理' : '分配线索', icon: <ShareAltOutlined /> },
        { value: 'company', label: '公司', icon: <BankOutlined /> },
      ]} />
      {(view === 'table' || view === 'groups') && <div ref={setHeaderActionsTarget} className="flex flex-1 min-w-[350px] items-center justify-end" />}
    </div>
    {view==='table'&&contactGroup&&<div className="contact-group-context"><Button size="small" type="link" icon={<LeftOutlined/>} onClick={openGroups}>联系人分组</Button><Tag>{contactGroup.label}</Tag></div>}
    {view === 'table' && (tableReady ? <ContactList key={key} dataPort={port} importPort={importPort} online={status !== 'offline'} headerActionsTarget={headerActionsTarget} onAssign={operations ? assign : undefined} renderDetail={(contact, close) => <CenterContactDetail reference={contact?.contactId && contact.customerId ? { contactId: contact.contactId, customerId: contact.customerId } : null} onClose={close} />} /> : <ContactTableSkeleton />)}
    {view === 'groups' && <div className="contact-group-workspace">
      <div className="contact-group-metrics">{groupMetrics.map(metric=><div className="contact-group-metric" key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong><small>{metric.note}</small></div>)}</div>
      <div className="contact-group-split">
        <ContactGroups scope="all" canAssign={operations} selectedGroup={contactGroup} onSelect={selectGroup} onAssign={selection=>assignGroups(selection.dimension,selection.groups)} />
        <div className="contact-group-members">
          {tableReady ? <ContactList dataPort={port} importPort={importPort} online={status !== 'offline'} headerActionsTarget={headerActionsTarget} onAssign={operations ? assign : undefined} renderDetail={(contact, close) => <CenterContactDetail reference={contact?.contactId && contact.customerId ? { contactId: contact.contactId, customerId: contact.customerId } : null} onClose={close} />} /> : <ContactTableSkeleton />}
        </div>
      </div>
    </div>}
    {(view === 'board' || view === 'company') && <div className="space-y-3">{sourceFilter}<CenterContactViews key={key} port={port} view={view} /></div>}
    {view === 'assignments' && <ContactAssignments key={`${baseUrl}:${identity?.userId}`} operations={operations} />}
    {assigning.length > 0 && <AssignmentModal key={assigning.map(row => row.contactId).join(',')} contacts={assigning} close={() => setAssigning([])} />}
    <CenterContactDetail reference={deepReference} onClose={() => setDeepReference(null)} />
    {monitorReference && <MonitorDetailSlot reference={monitorReference} onClose={() => setMonitorReference(null)} />}
  </div>;
}
