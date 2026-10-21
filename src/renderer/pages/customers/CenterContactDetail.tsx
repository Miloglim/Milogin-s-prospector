import { askAssistant } from '../../lib/ask-ai';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Input, Modal, Select, Space, Spin, Tabs, Timeline, Tooltip, message } from 'antd';
import { CloseOutlined, SearchOutlined, PartitionOutlined, DeleteOutlined, ShareAltOutlined } from '@ant-design/icons';
import { ContactDetailLayout, InfoTab, CRM_STAGES } from '../../components/ContactDetail';
import { DiamondLogo } from '../../components/DiamondLogo';
import { CompanyBackcheck, COMPANY_BACKCHECK_UI_ENABLED, type BackcheckReport } from '../../components/CompanyBackcheck';
import { ONLINE_CHANNELS, FOLLOWUP_METHODS, FOLLOWUP_METHOD_LABELS, CONTACT_TOUCH_STATUSES, CONTACT_TOUCH_LABELS, type ContactDelete, type ContactDeleteReceipt, type CenterCompanyUpdate, type CenterContactRef, type CenterContactDetail as Detail, type CenterContactUpdate, type CenterContactFollowup, type FollowupMethod, type ContactTouchStatus, type CustomerStage } from '../../../shared/online-crm';
import { useIdentity } from '../../IdentityContext';
import { centerInvoke, displayCenterContact } from './centerContactPort';
import { ContactSharingModal } from './ContactSharing';
import { canEditContactField } from './contactRights';
import { projectContactMailHistory } from './contactMailTimeline';
import { ONLINE_LIMITS } from '../../../shared/online-crm';

const CONTACT_DETAIL_EXIT_MS = 320;

function CenterContactDetailContent({ reference, open, onClose, variant = 'drawer' }: { reference: CenterContactRef; open: boolean; onClose: () => void; variant?: 'drawer' | 'board' }) {
  const { identity, baseUrl, status } = useIdentity();
  const qc = useQueryClient();
  const current = useRef(true);
  useEffect(() => { current.current = true; return () => { current.current = false; }; }, []);
  const permissionScope = JSON.stringify([identity?.crmRoles?.slice().sort(), identity?.crmCapabilities?.slice().sort(), identity?.identityAdmin, identity?.mustChangePassword]);
  const backcheckScope = JSON.stringify([baseUrl, identity?.userId, permissionScope, reference?.customerId, reference?.contactId]);
  const currentBackcheckScope = useRef(backcheckScope); currentBackcheckScope.current = backcheckScope;
  const [transientReport, setTransientReport] = useState<{scope:string;report:BackcheckReport}>();
  const [sharing, setSharing] = useState(false);
  const [tab, setTab] = useState('info');
  const [note, setNote] = useState('');
  const [method, setMethod] = useState<FollowupMethod>('note');
  const [contactStatus, setContactStatus] = useState<ContactTouchStatus>();
  const [stage, setStage] = useState<CustomerStage>();
  const [busy, setBusy] = useState(false);
  const deleteRetry = useRef<ContactDelete | null>(null);
  const updateRetry = useRef<{ signature: string; payload: CenterContactUpdate } | null>(null);
  const followupRetry = useRef<{ signature: string; payload: CenterContactFollowup } | null>(null);
  const key = ['center-contact-detail', baseUrl, identity?.userId, reference?.customerId, reference?.contactId, permissionScope];
  const query = useQuery({ queryKey: key, enabled: !!reference && !!identity, queryFn: () => centerInvoke<Detail>(ONLINE_CHANNELS.CONTACT_DETAIL, reference), refetchInterval: ONLINE_LIMITS.pollMs });
  useEffect(() => { updateRetry.current = null; followupRetry.current = null; deleteRetry.current = null; setBusy(false); setNote(''); setSharing(false); }, [backcheckScope]);
  const denied = query.data && !query.data.ok && ['FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED', 'PASSWORD_CHANGE_REQUIRED'].includes(query.data.error.code);
  const authorizedDetail = useRef<{ scope: string; detail: Detail }>();
  if (denied || authorizedDetail.current?.scope !== backcheckScope) authorizedDetail.current = undefined;
  if (query.data?.ok) authorizedDetail.current = { scope: backcheckScope, detail: query.data.data };
  // An unavailable read must not unmount the existing inline editor and destroy its draft.
  const detail = authorizedDetail.current?.detail;
  const access = JSON.stringify([backcheckScope, !!detail, detail?.permissions, detail?.canEdit, detail?.canFollowup, detail?.canDelete, detail?.company.canEdit]);
  const latestAccess = useRef({ signature: access, generation: 0 });
  if (latestAccess.current.signature !== access) latestAccess.current = { signature: access, generation: latestAccess.current.generation + 1 };
  const accessGeneration = latestAccess.current.generation;
  const hasCurrentAccess = () => current.current && currentBackcheckScope.current === backcheckScope && latestAccess.current.generation === accessGeneration;
  useEffect(() => { setBusy(false); }, [accessGeneration]);
  useEffect(() => {
    if (!denied) return;
    setNote(''); setSharing(false); setTransientReport(undefined);
    for (const prefix of ['center-contacts', 'center-companies', 'center-company-detail', 'center-assignment', 'center-shares', 'inbox', 'dashboard', 'search']) void qc.invalidateQueries({ queryKey: [prefix] });
    onClose();
  }, [denied, backcheckScope, qc]);
  const canEditField = (field: string) => !!detail && (detail.permissions ? canEditContactField(detail.permissions, field) : field === 'relationshipStage' ? detail.canFollowup : detail.canEdit);
  const error = query.data && !query.data.ok ? query.data.error.message : query.error?.message;
  const changed = (next: Detail) => { qc.setQueryData(key, { ok: true, data: next }); void qc.invalidateQueries({ queryKey: ['center-contacts'] }); void qc.invalidateQueries({ queryKey: ['center-assignment'] }); void qc.invalidateQueries({ queryKey: ['contacts', 'match'] }); void qc.invalidateQueries({ queryKey: ['inbox'] }); void qc.invalidateQueries({ queryKey: ['dashboard'] }); void qc.invalidateQueries({ queryKey: ['search'] }); void qc.invalidateQueries({ queryKey: ['center-company-detail'] }); };
  function remove() {
    if(!hasCurrentAccess()||!reference||!detail?.canDelete||busy||status==='offline')return;
    const captured=reference;
    const startedScope=backcheckScope;
    Modal.confirm({title:'删除该联系人？',content:'删除后不再参与匹配和新发送任务，历史记录保留。',okText:'删除',okType:'danger',cancelText:'取消',onOk:async()=>{
      if(!hasCurrentAccess()||!current.current||currentBackcheckScope.current!==startedScope)return;
      setBusy(true);
      try {
        const previous=deleteRetry.current?.contacts[0];
        if(!previous||previous.contactId!==captured.contactId||previous.customerId!==captured.customerId)deleteRetry.current={contacts:[{...captured,expectedVersion:detail.contact.contactVersion??detail.contact.customerVersion}],idempotencyKey:crypto.randomUUID()};
        const r=await centerInvoke<ContactDeleteReceipt>(ONLINE_CHANNELS.CONTACT_DELETE,deleteRetry.current);
        if(!hasCurrentAccess()||!current.current||currentBackcheckScope.current!==startedScope)return;
        if(!r.ok){if(r.error.code==='CONFLICT')deleteRetry.current=null;message.error(r.error.message);void qc.invalidateQueries({queryKey:key});return;}
        for(const prefix of ['center-contacts','center-companies','center-company-detail','center-contact-detail','dashboard','search','center-assignment','inbox'])void qc.invalidateQueries({queryKey:[prefix]});
        message.success('已删除');onClose();
      }finally{if(current.current&&currentBackcheckScope.current===startedScope)setBusy(false);}
    }});
  }
  async function save(field: string, value: string | null) {
    if (!hasCurrentAccess() || !reference || !detail || !canEditField(field) || busy) return false;
    const startedScope = backcheckScope;
    const isCurrent = () => hasCurrentAccess() && currentBackcheckScope.current === startedScope;
    if (detail.permissions && field === 'status' && ![null, '', 'reached', 'replied'].includes(value)) return;
    if (field === 'relationshipStage' || field === 'status' && [null, '', 'reached', 'replied'].includes(value)) {
      if (field === 'relationshipStage' ? !(detail.permissions?.canChangeStage ?? detail.canFollowup) : !detail.canFollowup) return;
      const nextStage = CRM_STAGES.find(item => item.key === value);
      if (field === 'relationshipStage' && !nextStage) return;
      const content = field === 'relationshipStage'
        ? { note: `跟进阶段：${nextStage!.label}`, method: 'note' as const, stage: nextStage!.key as CustomerStage }
        : { note: `触达状态：${value === 'reached' ? '已触达' : value === 'replied' ? '已回复' : '未触达'}`, method: 'other' as const, contactStatus: (value === 'reached' ? 'contacted' : value === 'replied' ? 'replied' : 'uncontacted') as ContactTouchStatus };
      const signature = JSON.stringify({ reference, content });
      if (followupRetry.current?.signature !== signature) followupRetry.current = { signature, payload: { ...reference, ...content, expectedVersion: detail.contact.contactVersion ?? detail.contact.customerVersion, idempotencyKey: crypto.randomUUID() } };
      setBusy(true);
      try {
        const result = await centerInvoke<Detail>(ONLINE_CHANNELS.CONTACT_FOLLOWUP, followupRetry.current.payload);
        if (!isCurrent()) return false;
        if (result.ok) { followupRetry.current = null; changed(result.data); return true; }
        else { if (result.error.code === 'CONFLICT') followupRetry.current = null; message.error(result.error.message); void query.refetch(); return false; }
      } catch (error) { if (isCurrent()) message.error(error instanceof Error ? error.message : '保存失败'); return false; }
      finally { if (isCurrent()) setBusy(false); }
    }
    const normalized = field === 'tags' ? value ? JSON.parse(value) : [] : field === 'stage' ? value ?? 'cold' : field === 'status' ? value ?? '' : value;
    const fields = { [field]: normalized } as CenterContactUpdate['fields'];
    const signature = JSON.stringify({ reference, fields });
    if (updateRetry.current?.signature !== signature) updateRetry.current = { signature, payload: { ...reference, expectedVersion: detail.contact.contactVersion ?? detail.contact.customerVersion, idempotencyKey: crypto.randomUUID(), fields } };
    setBusy(true);
    try { const result = await centerInvoke<Detail>(ONLINE_CHANNELS.CONTACT_UPDATE, updateRetry.current.payload); if (!isCurrent()) return false; if (result.ok) { updateRetry.current = null; changed(result.data); return true; } else { if (result.error.code === 'CONFLICT') updateRetry.current = null; message.error(result.error.message); void query.refetch(); return false; } }
    catch (error) { if (isCurrent()) message.error(error instanceof Error ? error.message : '保存失败'); return false; }
    finally { if (isCurrent()) setBusy(false); }
  }
  async function followup() {
    if (!hasCurrentAccess() || !reference || !detail?.canFollowup || busy || !note.trim()) return;
    const startedScope = backcheckScope;
    const isCurrent = () => hasCurrentAccess() && currentBackcheckScope.current === startedScope;
    const content = { note: note.trim(), method, ...(stage && (detail.permissions?.canChangeStage ?? true) ? { stage } : {}), ...(method !== 'note' && contactStatus ? { contactStatus } : {}) };
    const signature = JSON.stringify({ reference, content });
    if (followupRetry.current?.signature !== signature) followupRetry.current = { signature, payload: { ...reference, ...content, expectedVersion: detail.contact.contactVersion ?? detail.contact.customerVersion, idempotencyKey: crypto.randomUUID() } };
    setBusy(true);
    try { const result = await centerInvoke<Detail>(ONLINE_CHANNELS.CONTACT_FOLLOWUP, followupRetry.current.payload); if (!isCurrent()) return; if (result.ok) { followupRetry.current = null; changed(result.data); setNote(''); message.success('已保存'); } else { if (result.error.code === 'CONFLICT') followupRetry.current = null; message.error(result.error.message); void query.refetch(); } }
    catch (error) { if (isCurrent()) message.error(error instanceof Error ? error.message : '保存失败'); }
    finally { if (isCurrent()) setBusy(false); }
  }
  const companyRetry = useRef<CenterCompanyUpdate | null>(null);
  useEffect(() => { companyRetry.current = null; setTransientReport(undefined); }, [backcheckScope]);
  const canBackcheck = !!detail && (detail.company.canEdit || detail.permissions?.canSendMail || detail.canSendMail);
  const latestBackcheckAccess = useRef({canRun:canBackcheck,canWrite:!!detail?.company.canEdit}); latestBackcheckAccess.current = {canRun:canBackcheck,canWrite:!!detail?.company.canEdit};
  async function backcheck(input: {companyName:string;website?:string;country?:string}) {
    if (!hasCurrentAccess() || !reference || !detail || !canBackcheck || status === 'offline') return {success:false,error:'当前无法背调'};
    if (detail.company.canEdit && !detail.company.revision) return {success:false,error:'公司资料版本不可用'};
    const startedScope = backcheckScope;
    if (!detail.company.canEdit) companyRetry.current = null;
    if (!companyRetry.current) {
      const result = await window.api.invoke('ai:backcheck',{...input,centerReference:reference}) as {success:boolean;data?:{report:BackcheckReport};error?:string};
      if (!hasCurrentAccess() || !current.current || currentBackcheckScope.current !== startedScope || !latestBackcheckAccess.current.canRun) return {success:false,error:'账号或页面已切换'};
      if (!result.success || !result.data) return {success:false,error:result.error};
      if (!latestBackcheckAccess.current.canWrite) { setTransientReport({scope:startedScope,report:result.data.report}); return {success:true}; }
      companyRetry.current = {...reference,expectedRevision:detail.company.revision!,idempotencyKey:crypto.randomUUID(),fields:{backcheckData:result.data.report as unknown as NonNullable<CenterCompanyUpdate['fields']['backcheckData']>}};
    }
    const saved = await centerInvoke<Detail>(ONLINE_CHANNELS.COMPANY_UPDATE,companyRetry.current);
    if (!hasCurrentAccess() || !current.current || currentBackcheckScope.current !== startedScope || !latestBackcheckAccess.current.canRun) return {success:false,error:'账号或页面已切换'};
    if (!saved.ok) { if (saved.error.code === 'CONFLICT') {companyRetry.current=null; void query.refetch();} return {success:false,error:saved.error.message}; }
    companyRetry.current=null; changed(saved.data); return {success:true};
  }
  const contact = detail ? displayCenterContact(detail.contact) : undefined;
  const reached = detail && ['contacted','replied'].includes(detail.contact.touchStatus);
  const history = useMemo(() => {
    if (!detail) return [];
    const labels: Record<string, string> = { received: '收到邮件', sent: '已发送', replied: '回复', autoreply: '自动回复', bounced: '退信', cc: '抄送' };
    const mailEvents = detail.mailEvents || [];
    const projected = projectContactMailHistory(mailEvents);
    const mailActivities = projected.activityIds;
    const mailItems = projected.mail.map(event => ({
      time: event.occurredAt, key: event.eventId,
      children: <div className="text-xs"><div className="text-gray-400">{labels[event.kind] || event.kind} · {new Date(event.occurredAt).toLocaleString('zh-CN')}</div><div>{event.subject || '无主题'}</div><div className="whitespace-pre-wrap">{event.preview}</div></div>,
    }));
    const correctionLabels: Record<string, string> = { other: '其他', replied: '回复', autoreply: '自动回复', bounced: '退信' };
    const corrections = projected.corrections.map(event => ({
      time: event.recordedAt,
      key: `classification:${event.eventId}`,
      children: <div className="text-xs text-gray-400">
        邮件分类更正为{correctionLabels[event.correction!.classification]} · {new Date(event.recordedAt).toLocaleString('zh-CN')}
      </div>,
    }));
    const loadedEventIds = new Set(mailEvents.map(event => event.eventId));
    const activities = detail.activities.filter(activity => !mailActivities.has(activity.id) && !(activity.mailEventId && loadedEventIds.has(activity.mailEventId))).map(activity => ({
      time: activity.occurredAt ?? activity.createdAt, key: activity.id,
      children: <div className="text-xs"><div className="text-gray-400">{activity.actorName ?? ''}{activity.mailSuperseded ? ' · 历史记录（已更正）' : ''} · {new Date(activity.occurredAt ?? activity.createdAt).toLocaleString('zh-CN')}</div><div className="whitespace-pre-wrap">{activity.note}</div></div>,
    }));
    return [...mailItems, ...corrections, ...activities].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }, [detail]);
  return <ContactDetailLayout open={open} onClose={onClose} destroyOnClose {...(variant === 'board' ? { mask: true, rootClassName: 'customer-classic-floating-detail', width: 'clamp(360px, 44vw, 620px)', rootStyle: { top: 36 }, styles: { body: { padding: 12, height: '100%', overflow: 'hidden' } } } : {})}>
    <div className="flex-shrink-0 pb-3 mb-2 border-b border-gray-100"><div className="flex items-center gap-1.5 flex-wrap"><span className="text-base font-semibold text-gray-900">{contact ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') || '未命名联系人' : '联系人'}</span><Tooltip title="在收件箱中搜索"><Button type="text" aria-label="在收件箱中搜索" size="small" icon={<SearchOutlined />} className="btn-hover-color" style={{ color: '#bbb', padding: 0, minWidth: 20, height: 20 }} disabled={!contact?.email} onClick={() => { window.location.hash = `#/inbox?search=${encodeURIComponent(contact?.email ?? '')}`; }} /></Tooltip><Tooltip title={reached ? '在CRM中查看' : '未进入CRM管线'}><Button type="text" aria-label="在CRM中查看" size="small" icon={<PartitionOutlined />} disabled={!reached} className="btn-hover-color" style={{ color: reached ? '#bbb' : '#d9d9d9', padding: 0, minWidth: 20, height: 20 }} onClick={() => { window.location.hash = '#/customers?view=board'; onClose(); }} /></Tooltip><Tooltip title="带着这位联系人问 AI"><Button type="text" aria-label="带着这位联系人问 AI" size="small" disabled={!contact} onClick={() => { if (contact) askAssistant({ question: `请查询中心联系人 #${contact.contactId}（客户编号 ${contact.customerId}），分析最近情况与跟进建议。` }); }} icon={<DiamondLogo size={14} state="static" />} className="btn-hover-color" style={{ color: '#bbb', padding: 0, minWidth: 20, height: 20 }} /></Tooltip><Tooltip title="共享线索"><Button type="text" aria-label="共享线索" size="small" disabled={!detail?.permissions?.canShare || busy || status === 'offline'} onClick={() => setSharing(true)} icon={<ShareAltOutlined />} className="btn-hover-color" style={{ color: '#bbb', padding: 0, minWidth: 20, height: 20 }} /></Tooltip><Tooltip title="删除"><Button type="text" aria-label="删除联系人" size="small" disabled={!detail?.canDelete || busy || status === 'offline'} onClick={remove} icon={<DeleteOutlined />} className="btn-hover-color" style={{ padding: 0, minWidth: 20, height: 20 }} /></Tooltip><Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} className="ml-auto" /></div><div className="text-[11px] text-gray-500 font-mono mt-1">{contact?.email}</div></div>
    {query.isFetching && !detail && <Spin />}{error && <Alert type="error" message={error} />}
    {contact && detail && <Tabs activeKey={tab} onChange={setTab} size="small" className="contact-detail-tabs" items={[
      { key: 'info', label: '基本信息', children: <InfoTab key={backcheckScope} contact={contact} canEdit={(detail.permissions ? !!(detail.permissions.editableFields.length || detail.permissions.canFollowup || detail.permissions.canChangeStage) : detail.canEdit)} canEditField={canEditField} onSaveField={save} /> },
      { key: 'company', label: '公司背调', children: detail.supplementAvailable === false ? <div className="text-xs text-gray-400">联网后加载公司资料</div> : <CompanyBackcheck companyId={null} run={canBackcheck && status !== 'offline' ? backcheck : undefined} centerCompany={{ id: detail.company.companyId, name: detail.company.name, domain: detail.company.domain, backcheckData: transientReport?.scope === backcheckScope ? JSON.stringify(transientReport.report) : detail.company.backcheckData ? JSON.stringify(detail.company.backcheckData) : null }} /> },
      { key: 'history', label: '往来记录', children: <div className="space-y-3">{(detail.supplementAvailable === false || !detail.mailAvailable) && <div className="text-xs text-gray-400">{detail.supplementAvailable === false ? '联网后加载往来记录' : '邮件往来暂未接入'}</div>}{detail.canFollowup && <div className="space-y-2"><Space wrap><Select size="small" value={method} onChange={setMethod} options={FOLLOWUP_METHODS.map(value => ({ value, label: FOLLOWUP_METHOD_LABELS[value] }))} /><Select size="small" placeholder="触达结果" allowClear value={contactStatus} disabled={method === 'note'} onChange={setContactStatus} options={CONTACT_TOUCH_STATUSES.map(value => ({ value, label: CONTACT_TOUCH_LABELS[value] }))} /><Select size="small" placeholder="跟进阶段" disabled={detail.permissions ? !detail.permissions.canChangeStage : false} allowClear value={stage} onChange={setStage} options={CRM_STAGES.map(item => ({ value: item.key, label: item.label }))} /></Space><Input.TextArea rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="跟进记录" /><Button type="primary" size="small" block loading={busy} disabled={!note.trim()} onClick={followup}>保存</Button></div>}<Timeline items={history} /></div> },
    ].filter(item => COMPANY_BACKCHECK_UI_ENABLED || item.key !== 'company')} />}
    {sharing && reference && detail && <ContactSharingModal key={`${baseUrl}:${identity?.userId}:${reference.contactId}`} reference={reference} detail={detail} close={() => setSharing(false)} />}
  </ContactDetailLayout>;
}

export function CenterContactDetail({ reference, onClose, variant = 'drawer' }: { reference: CenterContactRef | null; onClose: () => void; variant?: 'drawer' | 'board' }) {
  const [activeReference, setActiveReference] = useState<CenterContactRef | null>(reference);
  const [open, setOpen] = useState(!!reference);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (exitTimer.current) clearTimeout(exitTimer.current);
    if (reference) {
      setActiveReference(reference);
      setOpen(true);
      return;
    }
    setOpen(false);
    exitTimer.current = setTimeout(() => { setActiveReference(null); exitTimer.current = null; }, CONTACT_DETAIL_EXIT_MS);
    return () => { if (exitTimer.current) clearTimeout(exitTimer.current); };
  }, [reference?.customerId, reference?.contactId]);
  if (!activeReference) return null;
  return <CenterContactDetailContent reference={activeReference} open={open} onClose={onClose} variant={variant} />;
}
