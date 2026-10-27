import { Button, Pagination, Space, Tag } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import { CONTACT_ASSIGNMENT_LIMITS, type ContactAssignmentGroup } from '../../../shared/online-crm';

const STATUS_LABEL={pending:'待接受',accepted:'已接受',rejected:'已拒绝',cancelled:'已撤回'} as const;

export function AssignmentGroupOverview({groups,total,page,loading,busy,offline,onOpen,onAction,onPage}:{
  groups:ContactAssignmentGroup[];total:number;page:number;loading:boolean;busy?:string;offline:boolean;
  onOpen:(group:ContactAssignmentGroup)=>void;onAction:(group:ContactAssignmentGroup,action:'accept'|'reject'|'cancel')=>void;onPage:(page:number)=>void;
}){
 return <>
  <div className="assignment-group-grid" aria-busy={loading}>
   {groups.map(group=><article className="assignment-group-card" key={group.groupId}>
    <button type="button" className="assignment-group-main" disabled={offline} onClick={()=>onOpen(group)}>
     <span><strong>{group.total} 个联系人</strong><small>{group.contactNames.join('、')||group.companyNames.join('、')||'分配组'}</small></span><RightOutlined/>
    </button>
    <div className="assignment-group-meta"><Tag>{STATUS_LABEL[group.pending?'pending':group.accepted?'accepted':group.rejected?'rejected':'cancelled']}</Tag><span>{group.actorName} → {group.targetName}</span></div>
    {(group.canAcceptAll||group.canRejectAll||group.canCancelAll)&&<Space size={4}>{group.canAcceptAll&&<Button size="small" type="primary" loading={busy===group.groupId} disabled={offline||!!busy} onClick={()=>onAction(group,'accept')}>一键接收</Button>}{group.canRejectAll&&<Button size="small" disabled={offline||!!busy} onClick={()=>onAction(group,'reject')}>拒绝</Button>}{group.canCancelAll&&<Button size="small" disabled={offline||!!busy} onClick={()=>onAction(group,'cancel')}>撤回</Button>}</Space>}
   </article>)}
   {!loading&&groups.length===0&&<div className="assignment-group-empty">暂无分配组</div>}
  </div>
  {total>CONTACT_ASSIGNMENT_LIMITS.page&&(
    <Pagination size="small" current={page} pageSize={CONTACT_ASSIGNMENT_LIMITS.page} total={total} showSizeChanger={false} onChange={onPage}/>
  )}
 </>;
}
