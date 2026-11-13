import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { Alert, Button, Empty, Segmented, message, theme } from 'antd';
import {
  BellOutlined, CheckOutlined, ClockCircleOutlined, EditOutlined,
  LineChartOutlined, ShareAltOutlined, UserAddOutlined, UserSwitchOutlined,
} from '@ant-design/icons';
import { useNavigate } from '@tanstack/react-router';
import { useOptionalIdentity } from '../IdentityContext';
import { useOptionalNotifications } from '../NotificationContext';
import { CONTACT_TOUCH_LABELS, FOLLOWUP_METHOD_LABELS, type ContactAssignmentLifecycleStatus, type OnlineNotification } from '../../shared/online-crm';
import { normalizeInboxSubject } from '../../shared/inbox';
import { CRM_STAGES } from './ContactDetail';
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
  'crm.deal.overlap_detected': '成交重叠提醒',
  'crm.contact.assignment.requested': '线索待接受',
  'crm.contact.assignment.accepted': '线索已接受',
  'crm.contact.assignment.rejected': '线索已拒绝',
  'crm.contact.assignment.cancelled': '线索已撤回',
  'crm.contact.assignment.expired': '线索分配已过期',
  'crm.contact.assignment.transfer_requested': '线索待转交确认',
  'crm.contact.assignment.transferred': '线索已转交',
  'crm.contact.assignment.transfer_cancelled': '线索转交已撤回',
  'crm.contact.team_visible': '团队可见',
  'crm.contact.updated': '联系人更新',
  'crm.contact.followup': '跟进更新',
  'crm.team.attention.opened': '团队关注项',
  'crm.team.attention.acknowledged': '关注项已确认',
  'crm.team.attention.resolved': '关注项已完成',
  'crm.team.attention.dismissed': '关注项已驳回',
  'crm.customer.created': '新增客户',
  'crm.customer.updated': '客户资料更新',
  'crm.contact.deleted': '联系人已删除',
  'crm.company.created': '新增公司',
  'crm.company.deleted': '公司已删除',
};
const CONTACT_FIELD_LABELS: Record<string, string> = {
  email: '邮箱', firstName: '名', lastName: '姓', title: '职位', phone: '电话', whatsapp: 'WhatsApp',
  sourceLevel1: '一级来源', sourceLevel2: '二级来源', linkedinUrl: 'LinkedIn', country: '国家',
  clientType: '客户类型', language: '语言', stage: '发送阶段', status: '状态', tags: '标签', preferences: '偏好',
};
const stageLabel = (value: string) => value === 'cold' ? '未联系' : CRM_STAGES.find(stage => stage.key === value)?.label ?? value;

export function notificationChangeCopy(item: OnlineNotification): { label: string; detail: string } {
  const change = item.change;
  const fallbackLabel = LABELS[item.eventType] ?? '记录更新';
  if (!change) return { label: fallbackLabel, detail: item.summary?.note || '' };
  if (change.kind === 'mail') {
    return {
      label: change.direction === 'outbound' ? '已发送邮件' : '收到客户邮件',
      detail: [change.note || item.summary?.note || '', change.from ? `来自 ${change.from}` : ''].filter(Boolean).join(' · '),
    };
  }
  if (change.kind === 'followup') {
    const readable = (field: string, value: string | null) => value === null ? '空' : field === 'contactStatus' ? CONTACT_TOUCH_LABELS[value as keyof typeof CONTACT_TOUCH_LABELS] ?? value : field === 'stage' ? stageLabel(value) : value;
    const changed = (change.changes ?? []).map(value => `${value.field === 'contactStatus' ? '联系状态' : value.field === 'stage' ? '关系阶段' : CONTACT_FIELD_LABELS[value.field] ?? value.field}：${readable(value.field, value.from)} → ${readable(value.field, value.to)}`);
    const details = [
      ...changed,
      ...(!changed.length && change.contactStatus ? [`状态：${CONTACT_TOUCH_LABELS[change.contactStatus as keyof typeof CONTACT_TOUCH_LABELS] ?? change.contactStatus}`] : []),
      ...(!changed.length && change.stage ? [`阶段：${stageLabel(change.stage)}`] : []),
      change.method ? `方式：${FOLLOWUP_METHOD_LABELS[change.method as keyof typeof FOLLOWUP_METHOD_LABELS] ?? change.method}` : '',
      change.note || item.summary?.note || '',
    ].filter(Boolean);
    return {
      label: change.contactStatus && change.stage ? '状态与阶段更新' : change.contactStatus ? '联系状态更新' : change.stage ? '关系阶段更新' : '新增跟进记录',
      detail: details.join(' · '),
    };
  }
  if (change.kind === 'fields') {
    const changed = (change.changes ?? []).map(value => `${CONTACT_FIELD_LABELS[value.field] ?? value.field}：${value.from ?? '空'} → ${value.to ?? '空'}`);
    return { label: '联系人资料更新', detail: changed.length ? changed.join(' · ') : (change.fields ?? []).map(field => CONTACT_FIELD_LABELS[field] ?? field).join('、') };
  }
  if (change.kind === 'task') return { label: '任务到期提醒', detail: change.title || item.summary?.note || '' };
  if (change.kind === 'opportunity') return { label: fallbackLabel, detail: change.title || item.summary?.note || '' };
  return { label: fallbackLabel, detail: item.summary?.note || '' };
}

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
  if (eventType.startsWith('crm.team.attention.')) return <BellOutlined />;
  if (eventType.startsWith('crm.contact.share.')) return <ShareAltOutlined />;
  if (eventType.startsWith('crm.contact.assignment.') || eventType === 'crm.lead.assigned') return <UserSwitchOutlined />;
  if (eventType === 'crm.customer.created' || eventType === 'crm.lead.published') return <UserAddOutlined />;
  if (eventType.includes('opportunity')) return <LineChartOutlined />;
  if (eventType.includes('followup') || eventType.includes('updated')) return <EditOutlined />;
  return <BellOutlined />;
}

function destinationLabel(item: OnlineNotification): string {
  if (item.change?.kind === 'mail') return '查看邮件';
  if (item.attentionItemId) return '查看关注';
  if (item.eventType.startsWith('crm.team.attention.')) return '查看关注项';
  if (item.eventType.startsWith('crm.contact.share.')) return '查看共享';
  if (item.contactOpenMode === 'monitor') return '监督查看';
  if (item.requestId || item.eventType.startsWith('crm.contact.assignment.')) return '处理分配';
  if (item.opportunityId || item.eventType.includes('opportunity')) return '查看商机';
  if (item.taskId || item.eventType === 'crm.task.due') return '查看任务';
  if (item.contactId || item.eventType.startsWith('crm.contact.')) return '查看联系人';
  return '查看客户';
}

export function mailNotificationThreadKey(item: OnlineNotification): string | null {
  if (item.change?.kind !== 'mail' || !item.customerId) return null;
  const subject = normalizeInboxSubject(item.change.note);
  return subject ? `${item.customerId}:${item.contactId ?? 'contact'}:${subject}` : null;
}

function assignmentStatusFor(item: OnlineNotification): ContactAssignmentLifecycleStatus {
  if (['pending', 'accepted', 'rejected', 'cancelled', 'expired', 'pending_transfer'].includes(item.assignmentStatus ?? '')) return item.assignmentStatus as ContactAssignmentLifecycleStatus;
  const event = item.eventType.split('.').pop();
  if (event === 'requested') return 'pending';
  if (event === 'transfer_requested') return 'pending_transfer';
  if (event === 'expired') return 'expired';
  if (event === 'rejected') return 'rejected';
  if (event === 'cancelled') return 'cancelled';
  return 'accepted';
}

/** The notification only supplies a resource reference; the customer page owns every detail drawer. */
export function notificationResourceHash(item: OnlineNotification, id: string, userId?: string, highlightToken = item.id): string | null {
  const highlight = encodeURIComponent(highlightToken);
  if (item.change?.kind === 'mail' && item.contactId) {
    const params = new URLSearchParams({
      centerContact: String(item.contactId),
      centerCustomer: id,
      ...(item.mailMessageKey ? { centerMail: item.mailMessageKey } : {}),
      mailSubject: item.change.note || '',
      mailAt: item.createdAt,
      highlight: highlightToken,
    });
    return `#/inbox?${params.toString()}`;
  }
  if (item.eventType.startsWith('crm.team.attention.')) return `#/team?attention=${encodeURIComponent(id)}&highlight=${highlight}`;
  if (item.eventType.startsWith('crm.contact.share.')) {
    const view = item.shareTargetUserId && item.shareTargetUserId !== userId ? 'outgoing' : 'incoming';
    return `#/customers?view=assignments&sharing=true&shareView=${view}`;
  }
  if (item.contactOpenMode === 'monitor' && item.contactId) {
    return `#/customers?monitorContact=${item.contactId}&centerCustomer=${encodeURIComponent(id)}&highlight=${highlight}`;
  }
  if (item.assignmentGroupId) {
    return `#/customers?view=assignments&groupId=${encodeURIComponent(item.assignmentGroupId)}&assignmentStatus=${assignmentStatusFor(item)}&highlight=${highlight}`;
  }
  if (item.requestId) {
    return `#/customers?view=assignments&requestId=${encodeURIComponent(item.requestId)}&assignmentStatus=${assignmentStatusFor(item)}&highlight=${highlight}`;
  }
  if (item.contactId) return `#/customers?view=table&centerContact=${item.contactId}&centerCustomer=${encodeURIComponent(id)}&highlight=${highlight}`;
  return null;
}

function revealDestination(destination: string): void {
  const alreadyThere = window.location.hash === destination;
  window.location.hash = destination;
  if (alreadyThere) window.dispatchEvent(new HashChangeEvent('hashchange'));
}

let notificationHighlightSequence = 0;

function newNotificationHighlight(id: string): string {
  notificationHighlightSequence += 1;
  return `${id}:${Date.now()}:${notificationHighlightSequence}`;
}

function resizePanel(startWidth: number, startHeight: number, deltaX: number, deltaY: number): PanelSize {
  const maxWidth = Math.max(MIN_PANEL_WIDTH, window.innerWidth - VIEWPORT_WIDTH_MARGIN);
  const maxHeight = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - VIEWPORT_HEIGHT_MARGIN);
  return {
    width: Math.min(maxWidth, Math.max(MIN_PANEL_WIDTH, startWidth + deltaX)),
    height: Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT, startHeight - deltaY)),
  };
}

export function MessageCenterPanel({ compact = false }: { compact?: boolean } = {}) {
  const session = useOptionalIdentity();
  const identity = session?.identity;
  const offline = session?.status === 'offline';
  const notifications = useOptionalNotifications();
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [filter, setFilter] = useState<MessageFilter>('全部');
  const [panelSize, setPanelSize] = useState<PanelSize | null>(null);
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const dedupedItems: OnlineNotification[] = [];
  const seenMailThreads = new Set<string>();
  for (const item of (notifications?.items ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const threadKey = mailNotificationThreadKey(item);
    if (threadKey && seenMailThreads.has(threadKey)) continue;
    if (threadKey) seenMailThreads.add(threadKey);
    dedupedItems.push(item);
  }
  const unread = dedupedItems.filter(item => !item.read).length;
  const items = dedupedItems.filter(item => filter === '全部' || !item.read);
  const groups = new Map<string, OnlineNotification[]>();
  for (const item of items) {
    const name = dateGroup(item.createdAt);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }

  const open = async (item: OnlineNotification) => {
    const id = await notifications?.open(item);
    if (!id) return;
    const highlight = newNotificationHighlight(item.id);
    if (item.attentionItemId) {
      revealDestination(`#/team?attention=${encodeURIComponent(item.attentionItemId)}&highlight=${encodeURIComponent(highlight)}`);
      return;
    }
    const destination = notificationResourceHash(item, id, identity?.userId, highlight);
    if (destination) {
      revealDestination(destination);
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

  const markAllRead = async () => {
    if (!notifications || unread === 0 || offline || markingAllRead) return;
    setMarkingAllRead(true);
    try {
      if (await notifications.readAll()) message.success('已全部标为已读');
    } finally {
      setMarkingAllRead(false);
    }
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

  return <section ref={panelRef} className={`message-center-panel${compact ? ' is-dropdown' : ''}`} style={{ ...style, ...(!compact && panelSize ? panelSize : {}) }} aria-label="消息中心">
    {!compact && <button type="button" className="message-resize-grip" aria-label="调整消息中心大小" title="拖动调整大小" onPointerDown={beginResize} onKeyDown={resizeWithKeyboard} />}
    <header className="messages-header">
      <div className="messages-heading">
        <h1 style={{ fontSize: TITLE_SIZE }}>消息中心</h1>
        {unread > 0 && <span className="messages-unread-badge" aria-label={`${unread} 条未读`}>{unread}</span>}
      </div>
      <div className="messages-tools">
        <Button className="messages-mark-all-read" type="text" size="small" icon={<CheckOutlined />} aria-label="一键已读全部消息" disabled={unread === 0 || offline} title={offline ? '连接中心后可全部标为已读' : '全部标为已读'} loading={markingAllRead} onClick={() => void markAllRead()}>{!compact && '全部已读'}</Button>
        <Segmented aria-label="消息筛选" size="small" options={[...FILTERS]} value={filter} onChange={value => setFilter(value as MessageFilter)} />
      </div>
    </header>
    {notifications?.error && <Alert className="messages-alert" type="warning" showIcon message={notifications.error} />}
    <div className={`messages-body${items.length ? '' : ' is-empty'}`}>
      <div className="messages-list">
        {!items.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={filter === '未读' ? '暂无未读消息' : '暂无消息'} />}
        {Array.from(groups, ([name, group]) => <section key={name} aria-label={name}>
          <h2 className="message-date-group">{name}</h2>
          {group.map(item => {
            const canOpen = item.eventType !== 'crm.deal.overlap_detected' && item.canOpen !== false && (!!item.customerId || !!item.requestId || !!item.shareId || (item.eventType.startsWith('crm.team.attention.') && !!item.taskId));
            const summary = canOpen ? item.summary : undefined;
            const changeCopy = canOpen ? notificationChangeCopy(item) : { label: LABELS[item.eventType] ?? '记录更新', detail: '' };
            const detail = [
              ...(item.change ? [changeCopy.detail, summary?.actorName] : [summary?.actorName, changeCopy.detail]),
              item.assignmentGroupCount ? `${item.assignmentGroupCount} 个联系人` : '',
            ].filter(Boolean).join(' · ');
            const action = canOpen ? destinationLabel(item) : '';
            const content = <>
              <span className="message-type-icon" aria-hidden="true">{messageIcon(item.eventType)}</span>
              <span className="message-copy">
                <span className="message-title">
                  {changeCopy.label}
                  {summary?.companyName && <strong> · {summary.companyName}</strong>}
                </span>
                {(action || detail) && <span className="message-summary" title={detail || undefined}>
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
