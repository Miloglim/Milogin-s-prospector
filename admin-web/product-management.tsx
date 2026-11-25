import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Alert, Button, Card, Col, Drawer, Empty, Input, InputNumber, Row, Select, Space, Spin, Statistic, Switch, Table, Tag, Typography, theme } from 'antd';
import { api, ApiError, type Identity } from './api';
import type { ProductInfo } from '../server/core/admin';
import type { NavigatorDashboard } from '../server/core/navigator';
import type { DashboardDatabase, DashboardFlow, DashboardReceipt, DashboardState, ManagementDashboard } from '../server/core/management-dashboard';
import type { AiFeature, AiModelProfile, AiPolicyRow, AiUsageReceipt, AiUsageSummary } from '../server/core/ai';

type View = 'overview' | 'flows' | 'databases' | 'ai';
export type ManagedProduct = 'prospector' | 'navigator';
const stateText: Record<DashboardState, string> = { healthy: '正常', attention: '需关注', offline: '离线', not_connected: '未接入' };
const stateColor: Record<DashboardState, string> = { healthy: 'success', attention: 'warning', offline: 'error', not_connected: 'default' };
const formatTime = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '暂无记录';

export function ProductManagement({ identity, product = 'prospector' }: { identity: Identity; product?: ManagedProduct }) {
  const { token } = theme.useToken();
  const style = { '--dashboard-text': token.colorText, '--dashboard-muted': token.colorTextSecondary, '--dashboard-border': token.colorBorderSecondary, '--dashboard-accent': token.colorPrimary, '--dashboard-tint': token.colorFillSecondary } as CSSProperties;
  const [view, setView] = useState<View>('overview');
  const [snapshot, setSnapshot] = useState<ManagementDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const version = useRef(0);
  const mounted = useRef(false);
  const load = useCallback(async () => {
    const requestVersion = ++version.current;
    const current = () => mounted.current && requestVersion === version.current;
    setLoading(true); setError('');
    try { const data = await api.dashboard(); if(current()) setSnapshot(data); } catch (cause) { if(current()) { if(cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setSnapshot(null); setError(cause instanceof Error ? cause.message : '看板读取失败'); } }
    finally { if(current()) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; setSnapshot(null); setView('overview'); void load(); return () => { mounted.current = false; version.current++; }; }, [load, identity.userId]);
  const [products, setProducts] = useState<ProductInfo[]>([]);
  const [navigatorUsers, setNavigatorUsers] = useState(0);
  const [navigatorSnapshot, setNavigatorSnapshot] = useState<NavigatorDashboard | null>(null);
  const [navigatorError, setNavigatorError] = useState('');
  const [aiPolicies, setAiPolicies] = useState<AiPolicyRow[]>([]);
  const [aiUsage, setAiUsage] = useState<AiUsageSummary | null>(null);
  const [aiModels, setAiModels] = useState<AiModelProfile[]>([]);
  const [aiEvents, setAiEvents] = useState<AiUsageReceipt[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const loadNavigator = useCallback(async () => {
    setNavigatorError('');
    try {
      const [catalog, users, dashboard] = await Promise.all([api.products(), api.users('', 1, 0, 'navigator'), api.navigatorDashboard()]);
      if (mounted.current) { setProducts(catalog); setNavigatorUsers(users.total); setNavigatorSnapshot(dashboard); }
    } catch (cause) {
      if (mounted.current) setNavigatorError(cause instanceof Error ? cause.message : 'Navigator 状态读取失败');
    }
  }, []);
  useEffect(() => { if (product === 'navigator') void loadNavigator(); }, [loadNavigator, product]);
  const loadAi = useCallback(async () => {
    setAiLoading(true); setAiError('');
    try {
      const results = await Promise.allSettled([api.aiPolicies(), api.aiUsage(30), api.aiModels(), api.aiUsageEvents({ days: 30, limit: 80 })]);
      if (!mounted.current) return;
      const errors: string[] = [];
      if (results[0].status === 'fulfilled') setAiPolicies(results[0].value); else errors.push(results[0].reason instanceof Error ? results[0].reason.message : '用户策略读取失败');
      if (results[1].status === 'fulfilled') setAiUsage(results[1].value); else errors.push(results[1].reason instanceof Error ? results[1].reason.message : '用量汇总读取失败');
      if (results[2].status === 'fulfilled') setAiModels(results[2].value); else errors.push(results[2].reason instanceof Error ? results[2].reason.message : '模型档案读取失败');
      if (results[3].status === 'fulfilled') setAiEvents(results[3].value); else errors.push(results[3].reason instanceof Error ? results[3].reason.message : '请求回执读取失败');
      if (errors.length) setAiError(errors.join('；'));
    } catch (cause) {
      if (mounted.current) setAiError(cause instanceof Error ? cause.message : 'AI 管理数据读取失败');
    } finally {
      if (mounted.current) setAiLoading(false);
    }
  }, []);
  const navigatorInfo = products.find(item => item.productId === 'navigator');
  return <section className="product-dashboard" style={style} aria-label="产品管理中心">
    {product === 'navigator' ? <NavigatorManagement info={navigatorInfo} users={navigatorUsers} dashboard={navigatorSnapshot} error={navigatorError} />
      : loading && !snapshot ? <div className="dashboard-loading"><Spin /><Typography.Text>正在读取 Prospector 数据状态</Typography.Text></div>
      : error && !snapshot ? <Alert type="error" showIcon message={error} action={<Button onClick={() => void load()}>重试</Button>} />
      : !snapshot ? <Empty description="暂无看板数据" /> : <>
    <div className="dashboard-heading"><div><Typography.Title level={2}>Prospector</Typography.Title><Typography.Text type="secondary">程序数据流通与数据库状态</Typography.Text></div><div className="dashboard-heading-actions"><Typography.Text type="secondary">更新于 {formatTime(snapshot.generatedAt)}</Typography.Text></div></div>
    {error && <Alert type="warning" showIcon message={`读取失败，当前显示上次数据：${error}`} />}
    <div className="dashboard-tabs" role="tablist">{([['overview','运行总览'],['flows','数据流'],['databases','数据库'],['ai','AI 管理']] as const).map(([key,label]) => <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'active' : ''} onClick={() => { setView(key); if (key === 'ai') void loadAi(); }}>{label}</button>)}</div>
    {view === 'overview' ? <Overview snapshot={snapshot} onViewFlows={() => setView('flows')} onViewDatabases={() => setView('databases')} /> : view === 'flows' ? <FlowView flows={snapshot.flows} receipts={snapshot.receipts} /> : view === 'databases' ? <DatabaseView databases={snapshot.databases} /> : <AiManagement policies={aiPolicies} usage={aiUsage} models={aiModels} events={aiEvents} loading={aiLoading} error={aiError} onReload={loadAi} onSaved={loadAi} />}
    </>}
  </section>;
}

function NavigatorManagement({ info, users, dashboard, error }: { info?: ProductInfo; users: number; dashboard: NavigatorDashboard | null; error: string }) {
  return <>
    <div className="dashboard-heading"><div><Typography.Title level={2}>Navigator</Typography.Title><Typography.Text type="secondary">运价库身份、运行与业务数据</Typography.Text></div><div className="dashboard-heading-actions"><Typography.Text type="secondary">{dashboard ? `最新消息 ${formatTime(dashboard.latestMessage)}` : '尚未读取业务数据'}</Typography.Text></div></div>
    {error && <Alert type="warning" showIcon message={error} description="测试中心只连接隔离环境；正式 Navigator 使用正式中心账号和正式中心地址。" />}
    <Row gutter={[12, 12]} className="dashboard-stats">
      <Col xs={12} md={8}><Card><Statistic title="中心连接" value={info?.connected ? '已接入' : '未接入'} valueStyle={{ color: info?.connected ? '#2f855a' : '#ad6b2e' }} /></Card></Col>
      <Col xs={12} md={8}><Card><Statistic title="已授权账号" value={users} suffix="个" /></Card></Col>
      <Col xs={24} md={8}><Card><Statistic title="业务服务" value={dashboard?.service.status === 'ok' ? '正常' : '未连接'} suffix={dashboard ? ` :${dashboard.service.port}` : ''} /></Card></Col>
    </Row>
    {dashboard && <Row gutter={[12, 12]} className="dashboard-stats">
      <Col xs={12} md={6}><Card><Statistic title="有效运价" value={dashboard.counts.currentRates} suffix={`/ ${dashboard.counts.rates}`} /></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="舱位条目" value={dashboard.counts.space} /></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="待审核" value={dashboard.counts.pendingAwaiting} valueStyle={{ color: dashboard.counts.pendingAwaiting ? '#ad6b2e' : undefined }} /></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="待核问题" value={dashboard.counts.reviewIssuesOpen} valueStyle={{ color: dashboard.counts.reviewIssuesOpen ? '#ad6b2e' : undefined }} /></Card></Col>
    </Row>}
    <Card title="Navigator 接入范围">
      <Typography.Paragraph>{info?.description ?? '正在读取中心产品目录'}</Typography.Paragraph>
      <Typography.Text type="secondary">中心负责统一身份、准入和角色授权；运价业务仍由 Navigator 服务处理，当前页面读取的是只读运行摘要。</Typography.Text>
      {dashboard && <div style={{ marginTop: 12 }}><Typography.Link href={dashboard.entryUrl} target="_blank" rel="noreferrer">打开 Navigator 运价库</Typography.Link></div>}
    </Card>
  </>;
}

const AI_FEATURES: Array<{ value: AiFeature; label: string }> = [
  { value: 'agent', label: 'Agent 对话' },
  { value: 'draft', label: '开发信' },
  { value: 'backcheck', label: '背调' },
  { value: 'mail_analysis', label: '邮件分析' },
  { value: 'summary', label: '摘要' },
];

function AiManagement({ policies, usage, models, events, loading, error, onReload, onSaved }: {
  policies: AiPolicyRow[];
  usage: AiUsageSummary | null;
  models: AiModelProfile[];
  events: AiUsageReceipt[];
  loading: boolean;
  error: string;
  onReload: () => Promise<void>;
  onSaved: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<AiPolicyRow | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<React.Key[]>([]);
  const [saving, setSaving] = useState(false);
  const policyInput = (row: AiPolicyRow, reason: string) => ({
    userId: row.userId,
    enabled: row.enabled,
    dailyTokenLimit: Math.max(0, Math.floor(row.dailyTokenLimit || 0)),
    monthlyTokenLimit: Math.max(0, Math.floor(row.monthlyTokenLimit || 0)),
    maxOutputTokens: Math.min(32768, Math.max(128, Math.floor(row.maxOutputTokens || 2048))),
    allowedFeatures: row.allowedFeatures,
    reason,
  });
  const savePolicy = async (row: AiPolicyRow, reason: string) => {
    setSaving(true);
    try {
      await api.updateAiPolicy(policyInput(row, reason));
      await onSaved();
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : 'AI 策略保存失败');
    } finally {
      setSaving(false);
    }
  };
  const batchToggle = async (enabled: boolean) => {
    if (!selected.length) return;
    setSaving(true);
    try {
      for (const userId of selected) {
        const row = policies.find(item => item.userId === userId);
        if (row) await api.updateAiPolicy(policyInput({ ...row, enabled }, enabled ? '批量启用 AI' : '批量停用 AI'));
      }
      setSelected([]);
      await onSaved();
    } catch (cause) {
      window.alert(cause instanceof Error ? cause.message : '批量操作失败');
    } finally {
      setSaving(false);
    }
  };
  const filteredPolicies = policies.filter(row => {
    const q = search.trim().toLocaleLowerCase();
    return !q || [row.email, row.displayName || '', ...row.crmRoles].some(value => value.toLocaleLowerCase().includes(q));
  });
  return <>
    {error && <Alert type="warning" showIcon message={error} action={<Button onClick={() => void onReload()}>重试</Button>} />}
    <Row gutter={[12, 12]} className="dashboard-stats">
      <Col xs={12} md={6}><Card><Statistic title="启用账号" value={policies.filter(row => row.enabled).length} /></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="近 30 天请求" value={usage?.requests ?? 0} /></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="输入 Token" value={usage?.inputTokens ?? 0} /></Card></Col>
      <Col xs={12} md={6}><Card><Statistic title="输出 Token" value={usage?.outputTokens ?? 0} /></Card></Col>
    </Row>
    <Card title="用户 AI 策略" extra={<Space><Button onClick={() => void onReload()} loading={loading}>刷新</Button><Button onClick={() => void batchToggle(true)} disabled={!selected.length || saving}>批量启用</Button><Button danger onClick={() => void batchToggle(false)} disabled={!selected.length || saving}>批量停用</Button></Space>}>
      <Space style={{ marginBottom: 10 }}><Input.Search allowClear placeholder="搜索邮箱、姓名或角色" value={search} onChange={e => setSearch(e.target.value)} style={{ width: 320 }} /></Space>
      <Table rowKey="userId" size="small" loading={loading} dataSource={filteredPolicies} rowSelection={{ selectedRowKeys: selected, onChange: setSelected }} locale={{ emptyText: '没有可管理的用户；请确认当前管理员有用户读取权限' }} pagination={{ pageSize: 20, showSizeChanger: true, pageSizeOptions: [20, 50, 100] }} scroll={{ x: 900 }} columns={[
        { title: '用户', dataIndex: 'email', width: 260, render: (_: string, row: AiPolicyRow) => <div><Typography.Text strong>{row.email}</Typography.Text><br /><Typography.Text type="secondary">{row.displayName || row.crmRoles.join(' / ') || '无 CRM 角色'}</Typography.Text></div> },
        { title: '状态', width: 80, render: (_: unknown, row: AiPolicyRow) => row.enabled ? <Tag color="success">启用</Tag> : <Tag>停用</Tag> },
        { title: '今日用量', width: 150, render: (_: unknown, row: AiPolicyRow) => `${row.dailyTokens.toLocaleString()} / ${row.dailyTokenLimit.toLocaleString()}` },
        { title: '本月用量', width: 160, render: (_: unknown, row: AiPolicyRow) => `${row.monthlyTokens.toLocaleString()} / ${row.monthlyTokenLimit.toLocaleString()}` },
        { title: '功能', width: 100, render: (_: unknown, row: AiPolicyRow) => `${row.allowedFeatures.length} 项` },
        { title: '最近使用', width: 160, render: (_: unknown, row: AiPolicyRow) => <Typography.Text type="secondary">{row.lastUsedAt ? formatTime(row.lastUsedAt) : '暂无'}</Typography.Text> },
        { title: '操作', width: 80, fixed: 'right' as const, render: (_: unknown, row: AiPolicyRow) => <Button type="link" onClick={() => setEditing({ ...row })}>编辑</Button> },
      ]} />
    </Card>
    <Drawer title={editing ? `编辑 AI 策略 · ${editing.email}` : '编辑 AI 策略'} open={!!editing} onClose={() => setEditing(null)} width={440}>
      {editing && <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <div><Typography.Text strong>启用 AI</Typography.Text><br /><Switch checked={editing.enabled} onChange={v => setEditing({ ...editing, enabled: v })} /></div>
        <div><Typography.Text strong>今日 token 上限</Typography.Text><br /><InputNumber min={0} value={editing.dailyTokenLimit} onChange={v => setEditing({ ...editing, dailyTokenLimit: Number(v) || 0 })} style={{ width: '100%' }} /></div>
        <div><Typography.Text strong>本月 token 上限</Typography.Text><br /><InputNumber min={0} value={editing.monthlyTokenLimit} onChange={v => setEditing({ ...editing, monthlyTokenLimit: Number(v) || 0 })} style={{ width: '100%' }} /></div>
        <div><Typography.Text strong>单次输出上限</Typography.Text><br /><InputNumber min={128} max={32768} value={editing.maxOutputTokens} onChange={v => setEditing({ ...editing, maxOutputTokens: Number(v) || 2048 })} style={{ width: '100%' }} /></div>
        <div><Typography.Text strong>允许功能</Typography.Text><br /><Select mode="multiple" style={{ width: '100%' }} value={editing.allowedFeatures} options={AI_FEATURES} onChange={v => setEditing({ ...editing, allowedFeatures: v })} /></div>
        <Space><Button type="primary" loading={saving} onClick={async () => { await savePolicy(editing, '中心管理台编辑单用户 AI 策略'); setEditing(null); }}>保存</Button><Button onClick={() => setEditing(null)}>取消</Button></Space>
      </Space>}
    </Drawer>
    <Card title="模型档案" style={{ marginTop: 12 }} extra={<Button type="primary" onClick={async()=>{await api.saveAiModel({modelId:`model-${Date.now()}`,label:'新模型',baseUrl:'https://api.example.com/v1',modelName:'model-name',wireApi:'chat_completions',keyEnv:'CENTER_AI_API_KEY',allowedFeatures:[...AI_FEATURES.map(x=>x.value)],enabled:false,isDefault:false,maxOutputTokens:2048,updatedAt:null});await onReload();}}>新增模型档案</Button>}>
      <Table rowKey="modelId" size="small" dataSource={models} locale={{ emptyText: '还没有模型档案，点击右上角“新增模型档案”' }} pagination={false} scroll={{ x: 920 }} columns={[
        { title:'档案', width:180, render:(_:unknown,row:AiModelProfile)=><Input defaultValue={row.label} onChange={e=>{row.label=e.target.value;}} /> },
        { title:'模型标识', width:160, render:(_:unknown,row:AiModelProfile)=><Input defaultValue={row.modelName} onChange={e=>{row.modelName=e.target.value;}} /> },
        { title:'Base URL', width:240, render:(_:unknown,row:AiModelProfile)=><Input defaultValue={row.baseUrl} onChange={e=>{row.baseUrl=e.target.value;}} /> },
        { title:'密钥环境变量', width:160, render:(_:unknown,row:AiModelProfile)=><Input defaultValue={row.keyEnv} placeholder="CENTER_AI_API_KEY" onChange={e=>{row.keyEnv=e.target.value;}} /> },
        { title:'功能', width:240, render:(_:unknown,row:AiModelProfile)=><Select mode="multiple" style={{width:'100%'}} defaultValue={row.allowedFeatures} options={AI_FEATURES} onChange={v=>{row.allowedFeatures=v;}} /> },
        { title:'默认', width:70, render:(_:unknown,row:AiModelProfile)=><Switch defaultChecked={row.isDefault} onChange={v=>{row.isDefault=v;}} /> },
        { title:'启用', width:70, render:(_:unknown,row:AiModelProfile)=><Switch defaultChecked={row.enabled} onChange={v=>{row.enabled=v;}} /> },
        { title:'操作', width:80, render:(_:unknown,row:AiModelProfile)=><Button type="link" onClick={async()=>{try{await api.saveAiModel(row);await onReload();}catch(cause){window.alert(cause instanceof Error?cause.message:String(cause));}}}>保存</Button> },
      ]} />
    </Card>
    <Card title="AI 请求回执" style={{ marginTop: 12 }}>
      <Table rowKey="eventId" size="small" dataSource={events} pagination={{pageSize:20,showSizeChanger:false}} scroll={{x:1000}} columns={[
        {title:'时间',dataIndex:'createdAt',width:160,render:formatTime},
        {title:'用户',width:190,render:(_:unknown,row:AiUsageReceipt)=>row.userEmail||row.userName||row.userId},
        {title:'功能',dataIndex:'feature',width:110},
        {title:'模型',dataIndex:'model',width:140},
        {title:'状态',dataIndex:'status',width:90,render:(v:string)=><Tag color={v==='ok'?'success':v==='blocked'?'warning':'error'}>{v}</Tag>},
        {title:'Token',width:110,render:(_:unknown,row:AiUsageReceipt)=>`${row.inputTokens}/${row.outputTokens}`},
        {title:'耗时',dataIndex:'latencyMs',width:80,render:(v:number)=>`${v}ms`},
        {title:'错误',width:140,render:(_:unknown,row:AiUsageReceipt)=>row.errorCode||row.httpStatus||'-'},
      ]} />
    </Card>
  </>;
}

function Overview({ snapshot, onViewFlows, onViewDatabases }: { snapshot: ManagementDashboard; onViewFlows: () => void; onViewDatabases: () => void }) {
  return <><Row gutter={[12, 12]} className="dashboard-stats">
    <Col xs={12} md={8}><Card><Statistic title="数据区" value={snapshot.overview.healthy} suffix={`/ ${snapshot.overview.databases} 可读取`} /><Button type="link" onClick={onViewDatabases}>查看数据库</Button></Card></Col>
    <Col xs={12} md={8}><Card><Statistic title="启用账号" value={snapshot.overview.activeUsers} /></Card></Col>
    <Col xs={12} md={8}><Card><Statistic title="客户记录" value={snapshot.overview.customers} /></Card></Col>
    <Col xs={12} md={8}><Card><Statistic title="当前邮件分析" value={snapshot.overview.mailAnalyses} /><Typography.Text type="secondary">{snapshot.overview.humanLockedMail} 封人工锁定</Typography.Text></Card></Col>
    <Col xs={12} md={8}><Card><Statistic title="需要动作" value={snapshot.overview.mailActions} valueStyle={{ color: snapshot.overview.mailActions ? '#ad6b2e' : undefined }} /><Button type="link" onClick={onViewFlows}>查看分析链路</Button></Card></Col>
    <Col xs={12} md={8}><Card><Statistic title="待处理事件" value={snapshot.overview.pendingEvents} valueStyle={{ color: snapshot.overview.pendingEvents ? '#ad6b2e' : undefined }} /></Card></Col>
  </Row><div className="dashboard-grid"><Card title="数据流状态" extra={<button className="dashboard-link" onClick={onViewFlows}>查看全部</button>}><div className="dashboard-list">{snapshot.flows.map(flow => <FlowRow key={flow.id} flow={flow} />)}</div></Card><Card title="需要关注"><div className="dashboard-list">{snapshot.alerts.map(alert => <div className="alert-row" key={alert.id}><span className={`alert-dot ${alert.level}`} /><div><Typography.Text strong>{alert.title}</Typography.Text><Typography.Paragraph type="secondary">{alert.detail}</Typography.Paragraph></div></div>)}</div></Card></div></>;
}

function FlowView({ flows, receipts }: { flows: DashboardFlow[]; receipts: DashboardReceipt[] }) {
  const [selected, setSelected] = useState<DashboardFlow | null>(null);
  return <><div className="dashboard-grid single"><Card title="Prospector 数据流"><div className="dashboard-list">{flows.map(flow => <div key={flow.id}><FlowRow flow={flow} expanded /><Button onClick={() => setSelected(flow)}>查看回执</Button></div>)}</div></Card></div><Drawer title={selected?.label} open={!!selected} onClose={() => setSelected(null)} width="min(760px, 100vw)"><Typography.Paragraph type="secondary">最近的已保存记录</Typography.Paragraph><Table rowKey="id" size="small" dataSource={receipts.filter(receipt => receipt.flowId === selected?.id)} pagination={false} scroll={{ x: 580 }} columns={[{ title:'时间',dataIndex:'createdAt',render:formatTime },{title:'状态',dataIndex:'status'},{title:'回执',dataIndex:'detail'},{title:'编号',dataIndex:'id',render:(id:string)=><Typography.Text copyable>{id}</Typography.Text>}]}/></Drawer></>;
}
function FlowRow({ flow, expanded = false }: { flow: DashboardFlow; expanded?: boolean }) { return <div className={`flow-row ${expanded ? 'expanded' : ''}`}><span className={`state-dot ${flow.state}`} /><div className="flow-main"><div className="flow-title"><Typography.Text strong>{flow.label}</Typography.Text><Tag color={stateColor[flow.state]}>{stateText[flow.state]}</Tag></div><Typography.Text type="secondary">{flow.detail}</Typography.Text>{expanded && <div className="flow-stages">{flow.stages.map((stage, index) => <span key={stage}><i>{index + 1}</i>{stage}</span>)}</div>}</div><div className="flow-meta"><Typography.Text strong>{flow.records ?? '—'}</Typography.Text><Typography.Text type="secondary">{flow.recordLabel}</Typography.Text><Typography.Text type="secondary">{flow.timeLabel}：{formatTime(flow.updatedAt)}</Typography.Text></div></div>; }
function DatabaseView({ databases }: { databases: DashboardDatabase[] }) { return <div className="database-grid">{databases.map(database => <Card key={database.id} className="database-card"><div className="database-title"><div><Typography.Title level={4}>{database.name}</Typography.Title><Typography.Text type="secondary">{database.kind}</Typography.Text></div><Tag color={stateColor[database.state]}>{stateText[database.state]}</Tag></div><Statistic title={database.recordLabel} value={database.records ?? '—'} /><Typography.Paragraph type="secondary">{database.detail}</Typography.Paragraph><Typography.Text type="secondary">最近更新：{formatTime(database.updatedAt)}</Typography.Text></Card>)}</div>; }
