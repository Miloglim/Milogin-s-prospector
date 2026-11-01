import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Pagination, Segmented, Spin, Tag } from 'antd';
import { CheckSquareOutlined } from '@ant-design/icons';
import { CENTER_CONTACT_GROUP_DIMENSIONS, CENTER_CONTACT_GROUP_LIMITS, CONTACT_ASSIGNMENT_LIMITS, ONLINE_CHANNELS, type CenterContactGroup, type CenterContactGroupDimension, type CenterContactGroupPage, type CenterContactGroupQuery } from '../../../shared/online-crm';
import { centerInvoke } from './centerContactPort';
import { useIdentity } from '../../IdentityContext';

const LABELS: Record<CenterContactGroupDimension,string> = { batch:'导入批次', country:'国家', company:'公司', clientType:'客户类型' };
const IMPORTED_AT_FORMATTER = new Intl.DateTimeFormat('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });

export type ContactGroupSelection = {
  dimension:CenterContactGroupDimension;
  key:string;
  label:string;
  count?:number;
  companyCount?:number;
  countryCount?:number;
  touchedCount?:number;
  latestImportedAt?:string|null;
};

function importedAtLabel(value:string|null|undefined){
 if(!value)return '未记录';
 const date=new Date(value);
 return Number.isNaN(date.getTime())?'未记录':IMPORTED_AT_FORMATTER.format(date);
}

function selection(dimension:CenterContactGroupDimension,group:CenterContactGroup):ContactGroupSelection {
 return {
  dimension,key:group.key,label:group.label,count:group.count,
  companyCount:group.companyCount,countryCount:group.countryCount,touchedCount:group.touchedCount,
  latestImportedAt:group.latestImportedAt,
 };
}

export function ContactGroups({ scope = 'all', canAssign = false, selectedGroup, onSelect, onAssign }:{
 scope?:CenterContactGroupQuery['scope']; canAssign?:boolean;
 selectedGroup?:ContactGroupSelection|null;
 onSelect:(selection:ContactGroupSelection|null)=>void;
 onAssign?:(selection:{dimension:CenterContactGroupDimension;groups:CenterContactGroup[]})=>Promise<boolean>;
}) {
 const { identity, baseUrl } = useIdentity();
 const [dimension,setDimension]=useState<CenterContactGroupDimension>(selectedGroup?.dimension??'batch');
 const [page,setPage]=useState(1);
 const [selected,setSelected]=useState<Set<string>>(new Set());
 const [selecting,setSelecting]=useState(false);
 const [assigning,setAssigning]=useState(false);
 useEffect(()=>{setPage(1);},[dimension,scope]);
 useEffect(()=>{setSelected(new Set());},[dimension,scope,page]);
 const query=useQuery({
  queryKey:['center-contact-groups',baseUrl,identity?.userId,scope,dimension,'',page],
  queryFn:()=>centerInvoke<CenterContactGroupPage>(ONLINE_CHANNELS.CONTACT_GROUPS,{dimension,scope,search:'',limit:CENTER_CONTACT_GROUP_LIMITS.page,offset:(page-1)*CENTER_CONTACT_GROUP_LIMITS.page}),
  placeholderData:keepPreviousData,
 });
 const data=query.data?.ok?query.data.data:undefined;
 const groups=data?.items??[];
 const groupSignature=groups.map(group=>`${group.key}:${group.count}`).join('|');
 const selectableGroups=query.isPlaceholderData?[]:groups;
 const selectableSignature=query.isPlaceholderData?'':groupSignature;
 const selectedGroups=groups.filter(group=>selected.has(group.key));
 const selectedContacts=selectedGroups.reduce((total,group)=>total+group.count,0);
 const tooMany=selectedContacts>CONTACT_ASSIGNMENT_LIMITS.batch;
 useEffect(()=>{
  if(!selectableGroups.length)return;
  const current=selectedGroup?.dimension===dimension?selectableGroups.find(group=>group.key===selectedGroup.key):undefined;
  if(current&&selectedGroup?.count!==undefined)return;
  onSelect(selection(dimension,current??selectableGroups[0]!));
 },[dimension,selectableSignature,selectedGroup?.dimension,selectedGroup?.key,selectedGroup?.count,onSelect]);
 const error=query.data&&!query.data.ok?query.data.error.message:query.error?.message;
 const toggle=(key:string,checked:boolean)=>setSelected(previous=>{const next=new Set(previous);if(checked)next.add(key);else next.delete(key);return next;});
 const selectPage=()=>setSelected(new Set(groups.map(group=>group.key)));
 const toggleSelecting=()=>setSelecting(value=>{if(value)setSelected(new Set());return !value;});
 const changeDimension=(value:CenterContactGroupDimension)=>{setPage(1);setDimension(value);onSelect(null);};
 async function assign(){if(!onAssign||!selectedGroups.length||tooMany||assigning)return;setAssigning(true);try{if(await onAssign({dimension,groups:selectedGroups})){setSelected(new Set());setSelecting(false);}}finally{setAssigning(false);}}
 return <aside className="contact-group-panel" aria-busy={query.isFetching}>
  <div className="contact-group-panel-head">
   <div><div className="contact-group-panel-title">联系人分组</div><div className="contact-group-panel-count">{data?.total??0} 组</div></div>
   {canAssign&&<Button size="small" type={selecting?'primary':'default'} icon={<CheckSquareOutlined/>} onClick={toggleSelecting}>{selecting?'取消':'多选'}</Button>}
  </div>
  <Segmented<CenterContactGroupDimension> block size="small" value={dimension} onChange={changeDimension} options={CENTER_CONTACT_GROUP_DIMENSIONS.map(value=>({value,label:LABELS[value]}))}/>
  {canAssign&&selecting&&selectedGroups.length>0&&<div className="contact-group-panel-selection">
   <span>已选 {selectedGroups.length} 组 · {selectedContacts} 人</span>
   {tooMany&&<Tag color="red">最多 {CONTACT_ASSIGNMENT_LIMITS.batch} 人</Tag>}
   <Button size="small" type="text" onClick={selectPage}>全选本页</Button>
   <Button aria-label="分配所选分组" size="small" type="primary" loading={assigning} disabled={tooMany} onClick={()=>void assign()}>分配</Button>
  </div>}
  {error&&<Alert type="error" message={error}/>}
  <div className={`contact-group-panel-list${query.isFetching&&groups.length?' is-fetching':''}`}>
   {groups.map(group=>{
    const active=selectedGroup?.dimension===dimension&&selectedGroup.key===group.key;
    return <div className={`contact-group-panel-row${active?' is-active':''}${selected.has(group.key)?' is-checked':''}`} key={group.key}>
     {canAssign&&selecting&&<Checkbox aria-label={`选择 ${group.label}`} checked={selected.has(group.key)} onChange={event=>toggle(group.key,event.target.checked)}/>}
     <button type="button" className="contact-group-panel-open" onClick={()=>onSelect(selection(dimension,group))}>
      <span className="contact-group-panel-name"><strong title={group.label}>{group.label}</strong><b>{group.count}</b></span>
      <span className="contact-group-panel-meta"><time dateTime={group.latestImportedAt??undefined}>{importedAtLabel(group.latestImportedAt)}</time><span>{(group.sourceLevel1??[])[0]||'未设置'}</span></span>
     </button>
    </div>;
   })}
   {query.isLoading&&<div className="contact-group-panel-empty"><Spin size="small"/></div>}
   {!query.isLoading&&!error&&groups.length===0&&<div className="contact-group-panel-empty">没有分组</div>}
  </div>
  <div className="contact-group-panel-footer">
   {(data?.total??0)>CENTER_CONTACT_GROUP_LIMITS.page&&<Pagination size="small" simple current={page} pageSize={CENTER_CONTACT_GROUP_LIMITS.page} total={data?.total??0} onChange={setPage}/>}
  </div>
 </aside>;
}
