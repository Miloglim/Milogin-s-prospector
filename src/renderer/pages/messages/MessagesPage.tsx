import { useState, type CSSProperties } from 'react';
import { Alert, Button, Empty, Segmented, Spin, theme } from 'antd';
import { CheckOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate } from '@tanstack/react-router';
import { useIdentity } from '../../IdentityContext';
import { useOptionalNotifications } from '../../NotificationContext';
import type { OnlineNotification } from '../../../shared/online-crm';
import './MessagesPage.css';
const LABELS: Record<string, string> = { 'crm.contact.share.requested':'线索共享邀请', 'crm.contact.share.accepted':'共享已接受', 'crm.contact.share.rejected':'共享已拒绝', 'crm.contact.share.revoked':'共享已结束', 'crm.contact.share.updated':'共享权限更新', 'crm.lead.assigned': '客户分配提醒', 'crm.lead.published': '新线索', 'crm.lead.claimed': '客户已领取', 'crm.lead.followup': '跟进更新', 'crm.task.due':'跟进到期', 'crm.opportunity.created':'新商机', 'crm.opportunity.stage_changed':'商机进度更新', 'crm.contact.assignment.requested': '线索待接受', 'crm.contact.assignment.accepted': '线索已接受', 'crm.contact.assignment.rejected': '线索已拒绝', 'crm.contact.assignment.cancelled': '线索已撤回', 'crm.contact.updated': '联系人更新', 'crm.contact.followup': '跟进更新' };
const TITLE_SIZE = 18;
function dateGroup(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更早';
  const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN');
}
export function MessagesPage() {
  const { identity } = useIdentity();
  const notifications = useOptionalNotifications(); const navigate = useNavigate(); const { token } = theme.useToken();
  const [filter, setFilter] = useState('全部');
  const items = (notifications?.items ?? []).filter(item => filter === '全部' || !item.read).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const groups = new Map<string, OnlineNotification[]>();
  for (const item of items) { const name = dateGroup(item.createdAt); groups.set(name, [...(groups.get(name) ?? []), item]); }
  const open = async (item: OnlineNotification) => {
    const id = await notifications?.open(item);
    if (!id) return;
    if (item.eventType.startsWith('crm.contact.share.')) { const view = item.shareTargetUserId && item.shareTargetUserId !== identity?.userId ? 'outgoing' : 'incoming'; window.location.hash = `#/customers?view=assignments&sharing=true&shareView=${view}`; return; }
    if (item.requestId) { const assignmentStatus = item.assignmentStatus ?? (item.eventType.split('.').pop() === 'requested' ? 'pending' : item.eventType.split('.').pop()); window.location.hash = `#/customers?view=assignments&requestId=${encodeURIComponent(item.requestId)}&assignmentStatus=${assignmentStatus}`; return; }
    if (item.contactId) { window.location.hash = `#/customers?centerContact=${item.contactId}&centerCustomer=${encodeURIComponent(id)}`; return; }
    void navigate({ to: '/customers-online', search: { customerId: id, ...(item.taskId ? { taskId: item.taskId } : {}), ...(item.opportunityId ? { opportunityId: item.opportunityId } : {}) } });
  };
  const style = { '--message-text': token.colorText, '--message-unread': token.colorError, '--message-muted': token.colorTextSecondary, '--message-border': token.colorBorderSecondary, '--message-hover': token.colorFillAlter, '--message-focus': token.colorPrimary, '--message-bg': token.colorBgContainer } as CSSProperties;
  return <div className="messages-page" style={style}>
    <header className="messages-header"><h1 style={{ fontSize: TITLE_SIZE }}>消息中心</h1><div className="messages-tools">
      <Segmented aria-label="消息筛选" size="small" options={['全部', '未读']} value={filter} onChange={value => setFilter(String(value))} />
      <Button type="text" icon={<ReloadOutlined />} aria-label="刷新消息" title="刷新消息" loading={notifications?.loading} onClick={() => void notifications?.refresh(true)} />
    </div></header>
    {notifications?.error && <Alert type="warning" showIcon message={notifications.error} />}
    <Spin spinning={notifications?.loading ?? false}><div className="messages-list">
      {!items.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter === '未读' ? '暂无未读消息' : '暂无消息'} />}
      {Array.from(groups, ([name, group]) => <section key={name} aria-label={name}>
        <h2 className="message-date-group">{name}</h2>
        {group.map(item => {
          const canOpen = item.canOpen !== false && (!!item.customerId || !!item.requestId || !!item.shareId);
          const summary = canOpen ? item.summary : undefined;
          const content = <><span className="message-unread-dot" aria-label={!item.read ? '未读' : undefined} style={{ visibility: item.read ? 'hidden' : 'visible' }} /><span className="message-copy"><span className="message-title">{LABELS[item.eventType] ?? '协作消息'}{summary?.companyName && <strong>{summary.companyName}</strong>}</span>{(summary?.actorName || summary?.note) && <span className="message-summary">{[summary.actorName, summary.note].filter(Boolean).join(' · ')}</span>}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></>;
          return <div key={item.id} className={`message-row${item.read ? '' : ' is-unread'}`}>
            {canOpen ? <button type="button" className="message-main" onClick={() => void open(item)}>{content}</button> : <div className="message-main">{content}</div>}
            {!item.read && <button type="button" className="message-read" aria-label="标为已读" title="标为已读" onClick={() => void notifications?.read(item.id)}><CheckOutlined /></button>}
          </div>;
        })}
      </section>)}
    </div></Spin>
  </div>;
}
