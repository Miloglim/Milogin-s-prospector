import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Alert, Empty, Segmented, theme } from 'antd';
import {
  BellOutlined, ClockCircleOutlined, EditOutlined,
  LineChartOutlined, ShareAltOutlined, UserAddOutlined, UserSwitchOutlined,
} from '@ant-design/icons';
import { useNavigate } from '@tanstack/react-router';
import { useOptionalIdentity } from '../IdentityContext';
import { useOptionalNotifications } from '../NotificationContext';
import type { OnlineNotification } from '../../shared/online-crm';
import '../pages/messages/MessagesPage.css';

const TITLE_SIZE = 15;
const MIN_PANEL_WIDTH = 320;
const MIN_PANEL_HEIGHT = 360;
const VIEWPORT_WIDTH_MARGIN = 32;
const VIEWPORT_HEIGHT_MARGIN = 24;
const KEYBOARD_RESIZE_STEP = 24;
const FILTERS = ['全部', '未读'] as const;
type MessageFilter = typeof FILTERS[number];
type PanelSize = { width: number; height: number };
const LABELS: Record<string, string> = {
  'crm.contact.share.requested': '线索共享邀请',
  'crm.contact.share.accepted': '共享已接受',
  'crm.contact.share.rejected': '共享已拒绝',
  'crm.contact.share.revoked': '共享已结束',
  'crm.contact.share.updated': '共享权限更新',
  'crm.lead.assigned': '客户分配提醒',
  'crm.lead.published': '新线索',
  'crm.lead.claimed': '客户已领取',
  'crm.lead.followup': '跟进更新',
  'crm.task.due': '跟进到期',
  'crm.opportunity.created': '新商机',
  'crm.opportunity.stage_changed': '商机进度更新',
  'crm.contact.assignment.requested': '线索待接受',
  'crm.contact.assignment.accepted': '线索已接受',
  'crm.contact.assignment.rejected': '线索已拒绝',
  'crm.contact.assignment.cancelled': '线索已撤回',
  'crm.contact.updated': '联系人更新',
  'crm.contact.followup': '跟进更新',
  'crm.customer.created': '新增客户',
  'crm.customer.updated': '客户资料更新',
  'crm.contact.deleted': '联系人已删除',
  'crm.company.created': '新增公司',
  'crm.company.deleted': '公司已删除',
};

function dateGroup(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更早';
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN');
}

function messageIcon(eventType: string) {
  if (eventType.includes('task.due')) return <ClockCircleOutlined />;
  if (eventType.startsWith('crm.contact.share.')) return <ShareAltOutlined />;
  if (eventType.startsWith('crm.contact.assignment.') || eventType === 'crm.lead.assigned') return <UserSwitchOutlined />;
  if (eventType === 'crm.customer.created' || eventType === 'crm.lead.published') return <UserAddOutlined />;
  if (eventType.includes('opportunity')) return <LineChartOutlined />;
  if (eventType.includes('followup') || eventType.includes('updated')) return <EditOutlined />;
  return <BellOutlined />;
}

function destinationLabel(item: OnlineNotification): string {
  if (item.eventType.startsWith('crm.contact.share.')) return '查看共享';
  if (item.requestId || item.eventType.startsWith('crm.contact.assignment.')) return '处理分配';
  if (item.opportunityId || item.eventType.includes('opportunity')) return '查看商机';
  if (item.taskId || item.eventType === 'crm.task.due') return '查看任务';
  if (item.contactId || item.eventType.startsWith('crm.contact.')) return '查看联系人';
  return '查看客户';
}

function resizePanel(startWidth: number, startHeight: number, deltaX: number, deltaY: number): PanelSize {
  const maxWidth = Math.max(MIN_PANEL_WIDTH, window.innerWidth - VIEWPORT_WIDTH_MARGIN);
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - VIEWPORT_HEIGHT_MARGIN);
  return {
    width: Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, startWidth + deltaX)),
    height: Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT, startHeight - deltaY)),
  };
}

export function MessageCenterPanel() {
  const identity = useOptionalIdentity()?.identity;
  const notifications = useOptionalNotifications();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [filter, setFilter] = useState<MessageFilter>('全部');
  const [panelSize, setPanelSize] = useState<PanelSize | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const unread = notifications?.unread ?? 0;
  const items = (notifications?.items ?? [])
    .filter(item => filter === '全部' || !item.read)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const groups = new Map<string, OnlineNotification[]>();
  for (const item of items) {
    const name = dateGroup(item.createdAt);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }

  const open = async (item: OnlineNotification) => {
    const id = await notifications?.open(item);
    if (!id) return;
    if (item.eventType.startsWith('crm.contact.share.')) {
      const view = item.shareTargetUserId && item.shareTargetUserId !== identity?.userId ? 'outgoing' : 'incoming';
      window.location.hash = `#/customers?view=assignments&sharing=true&shareView=${view}`;
      return;
    }
    if (item.requestId) {
      const assignmentStatus = item.assignmentStatus ?? (item.eventType.split('.').pop() === 'requested' ? 'pending' : item.eventType.split('.').pop());
      window.location.hash = `#/customers?view=assignments&requestId=${encodeURIComponent(item.requestId)}&assignmentStatus=${assignmentStatus}`;
      return;
    }
    if (item.contactId) {
      window.location.hash = `#/customers?centerContact=${item.contactId}&centerCustomer=${encodeURIComponent(id)}`;
      return;
    }
    void navigate({
      to: '/customers',
      search: {
        customerId: id,
        ...(item.taskId ? { taskId: item.taskId } : {}),
        ...(item.opportunityId ? { opportunityId: item.opportunityId } : {}),
      },
    });
  };

  useEffect(() => {
    const fitViewport = () => setPanelSize(current => current
      ? resizePanel(current.width, current.height, 0, 0)
      : current);
    window.addEventListener('resize', fitViewport);
    return () => {
      window.removeEventListener('resize', fitViewport);
      resizeCleanupRef.current?.();
    };
  }, []);

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    resizeCleanupRef.current?.();
    const move = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      setPanelSize(resizePanel(rect.width, rect.height, moveEvent.clientX - startX, moveEvent.clientY - startY));
    };
    const stop = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
      resizeCleanupRef.current = null;
    };
    document.addEventListener('pointermove', move, { passive: false });
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    resizeCleanupRef.current = stop;
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const panel = panelRef.current;
    if (!panel || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = panel.getBoundingClientRect();
    const deltaX = event.key === 'ArrowRight' ? KEYBOARD_RESIZE_STEP : event.key === 'ArrowLeft' ? -KEYBOARD_RESIZE_STEP : 0;
    const deltaY = event.key === 'ArrowDown' ? KEYBOARD_RESIZE_STEP : event.key === 'ArrowUp' ? -KEYBOARD_RESIZE_STEP : 0;
    setPanelSize(resizePanel(rect.width, rect.height, deltaX, deltaY));
  };

  const style = {
    '--message-text': token.colorText,
    '--message-unread': token.colorError,
    '--message-muted': token.colorTextSecondary,
    '--message-subtle': token.colorTextTertiary,
    '--message-border': token.colorBorderSecondary,
    '--message-hover': token.colorFillQuaternary,
    '--message-focus': token.colorPrimary,
    '--message-bg': token.colorBgElevated,
    '--message-icon-bg': token.colorFillTertiary,
  } as CSSProperties;

  return <section ref={panelRef} className="message-center-panel" style={{ ...style, ...(panelSize ?? {}) }} aria-label="消息中心">
    <button type="button" className="message-resize-grip" aria-label="调整消息中心大小" title="拖动调整大小" onPointerDown={beginResize} onKeyDown={resizeWithKeyboard} />
    <header className="messages-header">
      <div className="messages-heading">
        <h1 style={{ fontSize: TITLE_SIZE }}>消息中心</h1>
        {unread > 0 && <span className="messages-unread-badge" aria-label={`${unread} 条未读`}>{unread}</span>}
      </div>
      <div className="messages-tools">
        <Segmented aria-label="消息筛选" size="small" options={[...FILTERS]} value={filter} onChange={value => setFilter(value as MessageFilter)} />
      </div>
    </header>
    {notifications?.error && <Alert className="messages-alert" type="warning" showIcon message={notifications.error} />}
    <div className="messages-body">
      <div className="messages-list">
        {!items.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter === '未读' ? '暂无未读消息' : '暂无消息'} />}
        {Array.from(groups, ([name, group]) => <section key={name} aria-label={name}>
          <h2 className="message-date-group">{name}</h2>
          {group.map(item => {
            const canOpen = item.canOpen !== false && (!!item.customerId || !!item.requestId || !!item.shareId);
            const summary = canOpen ? item.summary : undefined;
            const detail = [summary?.actorName, summary?.note].filter(Boolean).join(' · ');
            const action = canOpen ? destinationLabel(item) : '';
            const content = <>
              <span className="message-type-icon" aria-hidden="true">{messageIcon(item.eventType)}</span>
              <span className="message-copy">
                <span className="message-title">
                  {LABELS[item.eventType] ?? '记录更新'}
                  {summary?.companyName && <strong> · {summary.companyName}</strong>}
                </span>
                {(action || detail) && <span className="message-summary">
                  {action && <span className="message-destination">{action}</span>}
                  {action && detail && ' · '}
                  {detail}
                </span>}
              </span>
              <span className="message-meta"><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></span>
            </>;
            return <div key={item.id} className={`message-row${item.read ? '' : ' is-unread'}`}>
              {canOpen ? <button type="button" className="message-main" onClick={() => void open(item)}>{content}</button> : <div className="message-main">{content}</div>}
              <span className="message-status">
                {!item.read && <span className="message-unread-dot" aria-label="未读" />}
              </span>
            </div>;
          })}
        </section>)}
      </div>
    </div>
  </section>;
}
