import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Drawer, List, Popconfirm, Space, Tooltip } from 'antd';
import { ONLINE_CHANNELS, ONLINE_LIMITS, type CrmSyncStatus, type CrmSyncResolve, type LeadDetail, type Result } from '../../../shared/online-crm';
const ACTIVITY_PREVIEW_COUNT = 3;
const SYNC_DRAWER_WIDTH = 620;
const CONTACT_FIELD_LABELS: Record<string,string> = { email:'邮箱',firstName:'名',lastName:'姓',title:'职位',phone:'电话',linkedinUrl:'LinkedIn',country:'国家',clientType:'客户类型',language:'语言',stage:'发送阶段',status:'状态',tags:'标签',preferences:'偏好' };
const fieldValue = (value:unknown):string => value===null||value===undefined||value===''?'未设置':Array.isArray(value)?value.join('、'):String(value);

function summary(detail:LeadDetail) {
  return <><div>{detail.companyName} · {detail.country||'—'}</div><div>{detail.contacts.map(c=>[c.name,c.email,c.phone].filter(Boolean).join(' / ')).join('；')}</div><div>{detail.activities.slice(0,ACTIVITY_PREVIEW_COUNT).map(a=>a.note).join('；')}</div></>;
}
export function CrmSyncPanel({onChanged,compact=false,scope=''}:{onChanged:()=>void;compact?:boolean;scope?:string}) {
  const currentScope=useRef(scope);currentScope.current=scope;
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [state,setState]=useState<CrmSyncStatus>();const [open,setOpen]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  useEffect(()=>{
    let active=true;let timer:ReturnType<typeof setTimeout>;
    const update=async()=>{try{const r=await window.api.invoke(ONLINE_CHANNELS.SYNC_STATUS) as Result<CrmSyncStatus>;if(active&&r.ok&&Array.isArray(r.data.issues))setState(r.data);}catch{/* Existing page errors cover an IPC outage; retain the last sync status. */}};
    const poll=async()=>{await update();if(active)timer=setTimeout(()=>void poll(),ONLINE_LIMITS.pollMs);};
    setState(undefined);setError('');setOpen(false);setBusy(false);void poll();
    return()=>{active=false;clearTimeout(timer);};
  },[scope]);
  async function resolve(input:CrmSyncResolve) {
    const startedScope=scope;
    setBusy(true);setError('');
    try{
      const r=await window.api.invoke(ONLINE_CHANNELS.SYNC_RESOLVE,input) as Result<unknown>;
      if(!mounted.current||currentScope.current!==startedScope)return;
      if(!r.ok)setError(r.error.message);
      const status=await window.api.invoke(ONLINE_CHANNELS.SYNC_STATUS) as Result<CrmSyncStatus>;
      if(!mounted.current||currentScope.current!==startedScope)return;
      if(status.ok)setState(status.data);onChanged();
    }catch{if(currentScope.current===startedScope)setError('同步连接中断，请重试');}finally{if(currentScope.current===startedScope)setBusy(false);}
  }
  if(!state)return null;
  const connectionLabel=state.connection==='offline'?'离线':state.syncing?'正在同步':'在线';
  const compactLabel=state.conflicts?`同步冲突 ${state.conflicts}`:state.failed?`同步失败 ${state.failed}`:state.pending?`待同步 ${state.pending}`:'同步';
  return <>{compact?<Tooltip title={`${connectionLabel}${state.lastError?` · ${state.lastError}`:''}`}><Button size="small" type="text" loading={busy||state.syncing} onClick={()=>setOpen(true)}>{compactLabel}</Button></Tooltip>:<div className="crm-sync-bar" role="status">
    <span>{state.connection==='offline'?'离线':state.syncing?'正在同步':'在线'}{state.pending?` · 待同步 ${state.pending}`:''}{state.failed?` · 失败 ${state.failed}`:''}{state.conflicts?` · 冲突 ${state.conflicts}`:''}</span>
    <Space size="small"><span className="customer-activity-time">{state.lastSyncedAt?`最近同步 ${new Date(state.lastSyncedAt).toLocaleString('zh-CN')}`:'尚未完成同步'}</span><Button size="small" type="text" onClick={()=>setOpen(true)}>同步详情</Button></Space>
  </div>}<Drawer rootClassName="app-drawer-below-titlebar" title="客户同步" open={open} onClose={()=>setOpen(false)} width={SYNC_DRAWER_WIDTH}>
    {(error||state.lastError)&&<Alert type="warning" message={error||state.lastError} showIcon />}
    <List locale={{emptyText:state.pending?'记录将在联网后自动同步':'没有需要处理的记录'}} dataSource={state.issues} renderItem={issue=><List.Item><div style={{width:'100%'}}>
      <strong>{issue.contact?.name??issue.local?.companyName??'导入或客户记录'}</strong><p>{issue.message}</p>
      {issue.contact&&<div className="crm-sync-comparison"><section><strong>本地修改</strong>{issue.contact.note&&<div className="whitespace-pre-wrap">{issue.contact.note}</div>}{Object.entries(issue.contact.fields??{}).map(([field,value])=><div key={field}>{CONTACT_FIELD_LABELS[field]??field}：{fieldValue(value)}</div>)}</section><section><strong>中心版本</strong>{issue.contact.centralFields?Object.entries(issue.contact.centralFields).map(([field,value])=><div key={field}>{CONTACT_FIELD_LABELS[field]??field}：{fieldValue(value)}</div>):'尚未取得'}</section></div>}
      {issue.receipt&&<List size="small" dataSource={issue.receipt.rows} renderItem={row=><List.Item>批次记录 {row.index+1} · {row.message??({created:'已导入',duplicate:'重复',invalid:'需修正',restricted_conflict:'受限冲突'}[row.status])}</List.Item>} />}
      {issue.local&&<div className="crm-sync-comparison"><section><strong>本地修改</strong>{summary(issue.local)}</section><section><strong>中心版本</strong>{issue.central?summary(issue.central):'尚未取得'}</section></div>}
      <Space className="mt-3">
        {issue.replayOnly&&<Button disabled={busy||state.syncing||state.connection==='offline'} onClick={()=>void resolve({id:issue.id,action:'retry'})}>重试同步</Button>}
        {!issue.replayOnly&&<Popconfirm title="保留中心版本？" description="此记录及后续未同步修改将被撤销。" onConfirm={()=>resolve({id:issue.id,action:'use-central'})}><Button disabled={busy||state.syncing||state.connection==='offline'}>保留中心</Button></Popconfirm>}
        {!issue.replayOnly&&issue.status==='conflict'&&(issue.contact||issue.local&&issue.central)&&<Popconfirm title="按中心最新版本重试本地修改？" description="将重试该记录及后续修改，仍会检查权限和版本。" onConfirm={()=>resolve({id:issue.id,action:'retry'})}><Button disabled={busy||state.syncing||state.connection==='offline'}>重试本地修改</Button></Popconfirm>}
      </Space>
    </div></List.Item>} />
  </Drawer></>;
}
