import { Button, Pagination, Space, Tag } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import { CONTACT_ASSIGNMENT_LIMITS, type ContactAssignmentGroup } from '../../../shared/online-crm';

export function AssignmentGroupOverview({ groups, total, page, loading, busy, offline, operations, onOpen, onAction, onPage }: {
  groups: ContactAssignmentGroup[];
  total: number;
  page: number;
  loading: boolean;
  busy?: string;
  offline: boolean;
  operations: boolean;
  onOpen: (group: ContactAssignmentGroup) => void;
  onAction: (group: ContactAssignmentGroup, action: 'accept' | 'reject' | 'cancel') => void;
  onPage: (page: number) => void;
}) {
  return <>
    <div className="assignment-group-grid" aria-busy={loading}>
      {groups.map(group => {
        const counts = [
          { label: operations ? '待分配' : '待接受', value: group.pending, color: 'processing' },
          { label: operations ? '已分配' : '已接受', value: group.accepted, color: 'success' },
          { label: '转交待确认', value: group.pendingTransfer ?? 0, color: 'processing' },
          { label: '已过期', value: group.expired ?? 0, color: 'warning' },
          { label: '已拒绝', value: group.rejected, color: 'error' },
          { label: '已撤回', value: group.cancelled, color: 'default' },
        ].filter(item => item.value > 0);
        return <article className="assignment-group-card" key={group.groupId}>
          <button type="button" className="assignment-group-main" disabled={offline} onClick={() => onOpen(group)}>
            <span><strong>{group.total} 个联系人</strong><small>{group.contactNames.join('、') || group.companyNames.join('、') || '分配组'}</small></span>
            <RightOutlined />
          </button>
          <div className="assignment-group-counts" aria-label="分配状态数量">
            {counts.map(item => <Tag color={item.color} key={item.label}>{item.label} {item.value}</Tag>)}
          </div>
          <div className="assignment-group-meta"><span>{group.actorName} → {group.targetName}</span><time dateTime={group.createdAt}>{new Date(group.createdAt).toLocaleDateString('zh-CN')}</time></div>
          {(group.canAcceptAll || group.canRejectAll || group.canCancelAll) && <Space size={4}>
            {group.canAcceptAll && <Button size="small" type="primary" loading={busy === group.groupId} disabled={offline || !!busy} onClick={() => onAction(group, 'accept')}>一键接收</Button>}
            {group.canRejectAll && <Button size="small" disabled={offline || !!busy} onClick={() => onAction(group, 'reject')}>拒绝</Button>}
            {group.canCancelAll && <Button size="small" disabled={offline || !!busy} onClick={() => onAction(group, 'cancel')}>撤回</Button>}
          </Space>}
        </article>;
      })}
      {!loading && groups.length === 0 && <div className="assignment-group-empty">暂无分配组</div>}
    </div>
    {total > CONTACT_ASSIGNMENT_LIMITS.page && <Pagination size="small" current={page} pageSize={CONTACT_ASSIGNMENT_LIMITS.page} total={total} showSizeChanger={false} onChange={onPage} />}
  </>;
}
