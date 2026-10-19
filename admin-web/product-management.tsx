import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Alert, Button, Card, Col, Drawer, Empty, Row, Spin, Statistic, Table, Tag, Typography, theme } from 'antd';
import { api, ApiError, type Identity } from './api';
import type { ProductInfo } from '../server/core/admin';
import type { NavigatorDashboard } from '../server/core/navigator';
import type { DashboardDatabase, DashboardFlow, DashboardReceipt, DashboardState, ManagementDashboard } from '../server/core/management-dashboard';

type View = 'overview' | 'flows' | 'databases';
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
  const [navigatorLoading, setNavigatorLoading] = useState(false);
  const loadNavigator = useCallback(async () => {
    setNavigatorLoading(true);
    setNavigatorError('');
    try {
      const [catalog, users, dashboard] = await Promise.all([api.products(), api.users('', 1, 0, 'navigator'), api.navigatorDashboard()]);
      if (mounted.current) { setProducts(catalog); setNavigatorUsers(users.total); setNavigatorSnapshot(dashboard); }
    } catch (cause) {
      if (mounted.current) setNavigatorError(cause instanceof Error ? cause.message : 'Navigator 状态读取失败');
    } finally { if (mounted.current) setNavigatorLoading(false); }
  }, []);
  useEffect(() => { if (product === 'navigator') void loadNavigator(); }, [loadNavigator, product]);
  const navigatorInfo = products.find(item => item.productId === 'navigator');
  return <section className="product-dashboard" style={style} aria-label="产品管理中心">
    {product === 'navigator' ? <NavigatorManagement info={navigatorInfo} users={navigatorUsers} dashboard={navigatorSnapshot} error={navigatorError} loading={navigatorLoading} onRefresh={() => void loadNavigator()} />
      : loading && !snapshot ? <div className="dashboard-loading"><Spin /><Typography.Text>正在读取 Prospector 数据状态</Typography.Text></div>
      : error && !snapshot ? <Alert type="error" showIcon message={error} action={<Button onClick={() => void load()}>重试</Button>} />
      : !snapshot ? <Empty description="暂无看板数据" /> : <>
    <div className="dashboard-heading"><div><Typography.Title level={2}>Prospector</Typography.Title><Typography.Text type="secondary">程序数据流通与数据库状态</Typography.Text></div><div className="dashboard-heading-actions"><Typography.Text type="secondary">更新于 {formatTime(snapshot.generatedAt)}</Typography.Text><Button loading={loading} onClick={() => void load()}>刷新</Button></div></div>
    {error && <Alert type="warning" showIcon message={`刷新失败，当前显示上次数据：${error}`} />}
    <div className="dashboard-tabs" role="tablist">{([['overview','运行总览'],['flows','数据流'],['databases','数据库']] as const).map(([key,label]) => <button key={key} type="button" role="tab" aria-selected={view === key} className={view === key ? 'active' : ''} onClick={() => setView(key)}>{label}</button>)}</div>
    {view === 'overview' ? <Overview snapshot={snapshot} onViewFlows={() => setView('flows')} onViewDatabases={() => setView('databases')} /> : view === 'flows' ? <FlowView flows={snapshot.flows} receipts={snapshot.receipts} /> : <DatabaseView databases={snapshot.databases} />}
    </>}
  </section>;
}

function NavigatorManagement({ info, users, dashboard, error, loading, onRefresh }: { info?: ProductInfo; users: number; dashboard: NavigatorDashboard | null; error: string; loading: boolean; onRefresh: () => void }) {
  return <>
    <div className="dashboard-heading"><div><Typography.Title level={2}>Navigator</Typography.Title><Typography.Text type="secondary">运价库身份、运行与业务数据</Typography.Text></div><div className="dashboard-heading-actions"><Typography.Text type="secondary">{dashboard ? `最新消息 ${formatTime(dashboard.latestMessage)}` : '尚未读取业务数据'}</Typography.Text><Button loading={loading} onClick={onRefresh}>刷新</Button></div></div>
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

function Overview({ snapshot, onViewFlows, onViewDatabases }: { snapshot: ManagementDashboard; onViewFlows: () => void; onViewDatabases: () => void }) {
  return <><Row gutter={[12, 12]} className="dashboard-stats">
    <Col xs={12} md={6}><Card><Statistic title="数据区" value={snapshot.overview.healthy} suffix={`/ ${snapshot.overview.databases} 可读取`} /><Button type="link" onClick={onViewDatabases}>查看数据库</Button></Card></Col>
    <Col xs={12} md={6}><Card><Statistic title="启用账号" value={snapshot.overview.activeUsers} /></Card></Col>
    <Col xs={12} md={6}><Card><Statistic title="客户记录" value={snapshot.overview.customers} /></Card></Col>
    <Col xs={12} md={6}><Card><Statistic title="待处理事件" value={snapshot.overview.pendingEvents} valueStyle={{ color: snapshot.overview.pendingEvents ? '#ad6b2e' : undefined }} /></Card></Col>
  </Row><div className="dashboard-grid"><Card title="数据流状态" extra={<button className="dashboard-link" onClick={onViewFlows}>查看全部</button>}><div className="dashboard-list">{snapshot.flows.map(flow => <FlowRow key={flow.id} flow={flow} />)}</div></Card><Card title="需要关注"><div className="dashboard-list">{snapshot.alerts.map(alert => <div className="alert-row" key={alert.id}><span className={`alert-dot ${alert.level}`} /><div><Typography.Text strong>{alert.title}</Typography.Text><Typography.Paragraph type="secondary">{alert.detail}</Typography.Paragraph></div></div>)}</div></Card></div></>;
}

function FlowView({ flows, receipts }: { flows: DashboardFlow[]; receipts: DashboardReceipt[] }) {
  const [selected, setSelected] = useState<DashboardFlow | null>(null);
  return <><div className="dashboard-grid single"><Card title="Prospector 数据流"><div className="dashboard-list">{flows.map(flow => <div key={flow.id}><FlowRow flow={flow} expanded /><Button onClick={() => setSelected(flow)}>查看回执</Button></div>)}</div></Card></div><Drawer title={selected?.label} open={!!selected} onClose={() => setSelected(null)} width="min(760px, 100vw)"><Typography.Paragraph type="secondary">最近的已保存记录</Typography.Paragraph><Table rowKey="id" size="small" dataSource={receipts.filter(receipt => receipt.flowId === selected?.id)} pagination={false} scroll={{ x: 580 }} columns={[{ title:'时间',dataIndex:'createdAt',render:formatTime },{title:'状态',dataIndex:'status'},{title:'回执',dataIndex:'detail'},{title:'编号',dataIndex:'id',render:(id:string)=><Typography.Text copyable>{id}</Typography.Text>}]}/></Drawer></>;
}
function FlowRow({ flow, expanded = false }: { flow: DashboardFlow; expanded?: boolean }) { return <div className={`flow-row ${expanded ? 'expanded' : ''}`}><span className={`state-dot ${flow.state}`} /><div className="flow-main"><div className="flow-title"><Typography.Text strong>{flow.label}</Typography.Text><Tag color={stateColor[flow.state]}>{stateText[flow.state]}</Tag></div><Typography.Text type="secondary">{flow.detail}</Typography.Text>{expanded && <div className="flow-stages">{flow.stages.map((stage, index) => <span key={stage}><i>{index + 1}</i>{stage}</span>)}</div>}</div><div className="flow-meta"><Typography.Text strong>{flow.records ?? '—'}</Typography.Text><Typography.Text type="secondary">{flow.recordLabel}</Typography.Text><Typography.Text type="secondary">{flow.timeLabel}：{formatTime(flow.updatedAt)}</Typography.Text></div></div>; }
function DatabaseView({ databases }: { databases: DashboardDatabase[] }) { return <div className="database-grid">{databases.map(database => <Card key={database.id} className="database-card"><div className="database-title"><div><Typography.Title level={4}>{database.name}</Typography.Title><Typography.Text type="secondary">{database.kind}</Typography.Text></div><Tag color={stateColor[database.state]}>{stateText[database.state]}</Tag></div><Statistic title={database.recordLabel} value={database.records ?? '—'} /><Typography.Paragraph type="secondary">{database.detail}</Typography.Paragraph><Typography.Text type="secondary">最近更新：{formatTime(database.updatedAt)}</Typography.Text></Card>)}</div>; }
