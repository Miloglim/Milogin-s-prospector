import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Input, Pagination, Segmented, Spin } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { CENTER_CONTACT_GROUP_DIMENSIONS, CENTER_CONTACT_GROUP_LIMITS, ONLINE_CHANNELS, type CenterContactGroupDimension, type CenterContactGroupPage, type CenterContactGroupQuery } from '../../../shared/online-crm';
import { centerInvoke } from './centerContactPort';
import { useIdentity } from '../../IdentityContext';

const LABELS: Record<CenterContactGroupDimension,string> = { batch:'导入批次', country:'国家', company:'公司', clientType:'客户类型' };
const SEARCH_DEBOUNCE_MS = 250;

export function ContactGroups({ scope = 'all', onSelect }: { scope?: CenterContactGroupQuery['scope']; onSelect:(selection:{dimension:CenterContactGroupDimension;key:string;label:string})=>void }) {
  const { identity, baseUrl } = useIdentity();
  const [dimension,setDimension]=useState<CenterContactGroupDimension>('batch');
  const [search,setSearch]=useState('');
  const [debouncedSearch,setDebouncedSearch]=useState('');
  const [page,setPage]=useState(1);
  useEffect(()=>{const timer=window.setTimeout(()=>setDebouncedSearch(search.trim()),SEARCH_DEBOUNCE_MS);return()=>window.clearTimeout(timer);},[search]);
  useEffect(()=>{setPage(1);},[dimension,debouncedSearch,scope]);
  const query=useQuery({
    queryKey:['center-contact-groups',baseUrl,identity?.userId,scope,dimension,debouncedSearch,page],
    queryFn:()=>centerInvoke<CenterContactGroupPage>(ONLINE_CHANNELS.CONTACT_GROUPS,{dimension,scope,search:debouncedSearch,limit:CENTER_CONTACT_GROUP_LIMITS.page,offset:(page-1)*CENTER_CONTACT_GROUP_LIMITS.page}),
    placeholderData:previous=>previous,
  });
  const data=query.data?.ok?query.data.data:undefined;
  const error=query.data&&!query.data.ok?query.data.error.message:query.error?.message;
  return <div className="contact-group-overview">
    <div className="contact-group-toolbar">
      <Segmented<CenterContactGroupDimension> value={dimension} onChange={setDimension} options={CENTER_CONTACT_GROUP_DIMENSIONS.map(value=>({value,label:LABELS[value]}))} />
      <Input size="small" prefix={<SearchOutlined/>} placeholder={`搜索${LABELS[dimension]}`} value={search} onChange={event=>setSearch(event.target.value)} allowClear />
    </div>
    {error&&<Alert type="error" message={error}/>}
    <div className="contact-group-grid" aria-busy={query.isFetching}>
      {(data?.items??[]).map(group=><button type="button" className="contact-group-card" data-dimension={dimension} key={group.key} onClick={()=>onSelect({dimension,key:group.key,label:group.label})}>
        <span>{group.label}</span><strong>{group.count}</strong>
      </button>)}
      {query.isLoading&&<div className="contact-group-loading"><Spin/></div>}
      {!query.isLoading&&!error&&data?.items.length===0&&<div className="contact-group-empty">没有匹配分组</div>}
    </div>
    {(data?.total??0)>CENTER_CONTACT_GROUP_LIMITS.page&&<Pagination size="small" current={page} pageSize={CENTER_CONTACT_GROUP_LIMITS.page} total={data?.total??0} showSizeChanger={false} onChange={setPage}/>}
  </div>;
}
