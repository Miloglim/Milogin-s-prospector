import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Input, Pagination, Segmented, Spin, Tag } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { CENTER_CONTACT_GROUP_DIMENSIONS, CENTER_CONTACT_GROUP_LIMITS, CONTACT_ASSIGNMENT_LIMITS, ONLINE_CHANNELS, type CenterContactGroup, type CenterContactGroupDimension, type CenterContactGroupPage, type CenterContactGroupQuery } from '../../../shared/online-crm';
import { centerInvoke } from './centerContactPort';
import { useIdentity } from '../../IdentityContext';

const LABELS: Record<CenterContactGroupDimension,string> = { batch:'导入批次', country:'国家', company:'公司', clientType:'客户类型' };
const SEARCH_DEBOUNCE_MS = 250;

function updatedLabel(value:string|null|undefined){
 if(!value)return '';
 const date=new Date(value);return Number.isNaN(date.getTime())?'':`${date.getMonth()+1}/${date.getDate()}`;
}

export function ContactGroups({ scope = 'all', canAssign = false, onSelect, onAssign }:{
 scope?:CenterContactGroupQuery['scope']; canAssign?:boolean;
 onSelect:(selection:{dimension:CenterContactGroupDimension;key:string;label:string})=>void;
 onAssign?:(selection:{dimension:CenterContactGroupDimension;groups:CenterContactGroup[]})=>Promise<boolean>;
}) {
 const { identity, baseUrl } = useIdentity();
 const [dimension,setDimension]=useState<CenterContactGroupDimension>('batch');
 const [search,setSearch]=useState('');
 const [debouncedSearch,setDebouncedSearch]=useState('');
 const [page,setPage]=useState(1);
 const [selected,setSelected]=useState<Set<string>>(new Set());
 const [assigning,setAssigning]=useState(false);
 useEffect(()=>{const timer=window.setTimeout(()=>setDebouncedSearch(search.trim()),SEARCH_DEBOUNCE_MS);return()=>window.clearTimeout(timer);},[search]);
 useEffect(()=>{setPage(1);},[dimension,debouncedSearch,scope]);
 useEffect(()=>{setSelected(new Set());},[dimension,debouncedSearch,scope,page]);
 const query=useQuery({
  queryKey:['center-contact-groups',baseUrl,identity?.userId,scope,dimension,debouncedSearch,page],
  queryFn:()=>centerInvoke<CenterContactGroupPage>(ONLINE_CHANNELS.CONTACT_GROUPS,{dimension,scope,search:debouncedSearch,limit:CENTER_CONTACT_GROUP_LIMITS.page,offset:(page-1)*CENTER_CONTACT_GROUP_LIMITS.page}),
  placeholderData:previous=>previous,
 });
 const data=query.data?.ok?query.data.data:undefined;
 const groups=data?.items??[];
 const error=query.data&&!query.data.ok?query.data.error.message:query.error?.message;
 const selectedGroups=groups.filter(group=>selected.has(group.key));
 const selectedContacts=selectedGroups.reduce((total,group)=>total+group.count,0);
 const tooMany=selectedContacts>CONTACT_ASSIGNMENT_LIMITS.batch;
 const toggle=(key:string,checked:boolean)=>setSelected(previous=>{const next=new Set(previous);if(checked)next.add(key);else next.delete(key);return next;});
 const selectPage=()=>setSelected(new Set(groups.map(group=>group.key)));
 async function assign(){if(!onAssign||!selectedGroups.length||tooMany||assigning)return;setAssigning(true);try{if(await onAssign({dimension,groups:selectedGroups}))setSelected(new Set());}finally{setAssigning(false);}}
 return <div className="contact-group-overview">
  <div className="contact-group-sticky">
   <div className="contact-group-toolbar">
    <Segmented<CenterContactGroupDimension> value={dimension} onChange={setDimension} options={CENTER_CONTACT_GROUP_DIMENSIONS.map(value=>({value,label:LABELS[value]}))}/>
    <Input size="small" prefix={<SearchOutlined/>} placeholder={`搜索${LABELS[dimension]}`} value={search} onChange={event=>setSearch(event.target.value)} allowClear/>
   </div>
   {canAssign&&selectedGroups.length>0&&<div className="contact-group-selection">
    <span>已选 {selectedGroups.length} 组 · {selectedContacts} 人</span>
    {tooMany&&<Tag color="red">每次最多 {CONTACT_ASSIGNMENT_LIMITS.batch} 人</Tag>}
    <Button size="small" type="text" onClick={selectPage}>全选本页</Button>
    <Button aria-label="分配所选分组" size="small" type="primary" loading={assigning} disabled={tooMany} onClick={()=>void assign()}>分配</Button>
   </div>}
  </div>
  {error&&<Alert type="error" message={error}/>}
  <div className="contact-group-grid" aria-busy={query.isFetching}>
   {groups.map(group=><article className={`contact-group-card${selected.has(group.key)?' is-selected':''}`} data-dimension={dimension} key={group.key}>
    {canAssign&&<Checkbox className="contact-group-check" aria-label={`选择 ${group.label}`} checked={selected.has(group.key)} onChange={event=>toggle(group.key,event.target.checked)}/>}
    <button type="button" className="contact-group-open" onClick={()=>onSelect({dimension,key:group.key,label:group.label})}>
     <span className="contact-group-title"><strong>{group.label}</strong><b>{group.count}</b></span>
     <span className="contact-group-stats"><span>{group.companyCount??0} 家公司</span><span>{group.countryCount??0} 个国家</span><span>{group.touchedCount??0} 已触达</span></span>
     {(group.companies?.length??0)>0&&<span className="contact-group-companies">{group.companies!.slice(0,2).join(' · ')}</span>}
     <span className="contact-group-samples">{[...(group.countries??[]),...(group.clientTypes??[])].slice(0,3).map((value,index)=><Tag key={`${index}:${value}`}>{value}</Tag>)}</span>
     {group.latestUpdatedAt&&<time dateTime={group.latestUpdatedAt}>最近更新 {updatedLabel(group.latestUpdatedAt)}</time>}
    </button>
   </article>)}
   {query.isLoading&&<div className="contact-group-loading"><Spin/></div>}
   {!query.isLoading&&!error&&groups.length===0&&<div className="contact-group-empty">没有匹配分组</div>}
  </div>
  {(data?.total??0)>CENTER_CONTACT_GROUP_LIMITS.page&&<Pagination size="small" current={page} pageSize={CENTER_CONTACT_GROUP_LIMITS.page} total={data?.total??0} showSizeChanger={false} onChange={setPage}/>}
 </div>;
}
