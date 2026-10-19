import { Button, Checkbox, Empty, Input, Pagination, Popover, Select, Segmented, Space, Table, Tag, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import { BankOutlined, DeleteOutlined, DownOutlined, ExportOutlined, ImportOutlined, MailOutlined, PartitionOutlined, PlusOutlined, RightOutlined, SearchOutlined, SettingOutlined, UnorderedListOutlined } from '@ant-design/icons';
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { CrmStage, LeadBootstrap, LeadPage, LeadQuery } from '../../../shared/online-crm';
import { customerBoardStage } from '../../../shared/online-crm';
import { CRM_STAGES } from '../../components/ContactDetail';

type LegacyView = 'table' | 'board' | 'company';
type TaskView = LeadQuery['view'] | 'unassigned' | 'operationsAssigned';
type Lead = LeadPage['items'][number];

type Props = {
  bootstrap: LeadBootstrap;
  leads: LeadPage;
  listLoading: boolean;
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  search: string;
  setSearch: Dispatch<SetStateAction<string>>;
  taskView: TaskView;
  scope: LeadQuery['view'];
  scopeOptions: Array<{ value: string; label: string }>;
  additionalViews: Array<{ value: string; label: string }>;
  stageFilter: LeadQuery['stage'];
  setStageFilter: Dispatch<SetStateAction<LeadQuery['stage']>>;
  view: LegacyView;
  setView: Dispatch<SetStateAction<LegacyView>>;
  canCreate: boolean;
  canImport: boolean;
  onChangeTask: (value: TaskView) => void;
  onOpenDetail: (customerId: string) => void;
  onStartCreate: () => void;
  onOpenImport: () => void;
  assignmentLabel: (value: { origin?: 'personal' | 'operations'; state: string }) => string;
  stageLabel: (value: CrmStage | 'cold' | undefined) => string;
  selectedCustomerId?: string;
};

const PAGE_SIZE = 25;
const CUSTOMER_STAGES = ['cold', ...CRM_STAGES.map(stage => stage.key as CrmStage)] as const;
const DEFAULT_COLUMNS = ['name', 'email', 'company', 'clientType', 'status', 'stage', 'title', 'source'];

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('zh-CN') : '—';
}

function primaryContact(lead: Lead) {
  return lead.primaryContactName || lead.primaryContactEmail || `${lead.contactCount} 位联系人`;
}

/**
 * The original customer page was a compact three-view shell. This component
 * keeps that shell while receiving its rows from the online CRM adapter.
 */
export function CustomerLegacyShell(props: Props) {
  const {
    bootstrap, leads, listLoading, page, setPage, search, setSearch, taskView, scope,
    scopeOptions, additionalViews, stageFilter, setStageFilter, view, setView,
    canCreate, canImport, onChangeTask, onOpenDetail, onStartCreate, onOpenImport,
    assignmentLabel, stageLabel, selectedCustomerId,
  } = props;
  const [visibleColumns, setVisibleColumns] = useState(DEFAULT_COLUMNS);
  const [selectedKeys, setSelectedKeys] = useState<React.Key[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => { setSelectedKeys([]); }, [bootstrap.userId, scope, search, stageFilter]);
  const unavailable = '当前客户中心尚未接入';
  const disabledButton = (label: string, icon?: React.ReactNode) => <Tooltip title={unavailable}><span><Button size="small" disabled icon={icon}>{label}</Button></span></Tooltip>;

  const tableColumns: TableColumnsType<Lead> = [
    {
      key: 'name', title: '姓名', width: 120,
      render: (_, row) => <button className="customer-name-link" onClick={() => onOpenDetail(row.customerId)}>{primaryContact(row)}</button>,
    },
    { key: 'email', title: '邮箱', width: 200, ellipsis: true, render: (_, row) => <span className="customer-email">{row.primaryContactEmail || '—'}</span> },
    { key: 'company', title: '公司', width: 140, ellipsis: true, render: (_, row) => <button className="customer-name-link" onClick={() => onOpenDetail(row.customerId)}>{row.companyName}</button> },
    { key: 'clientType', title: '类型', width: 70, render: () => '—' },
    { key: 'status', title: '状态', width: 80, render: (_, row) => <Tag>{assignmentLabel(row)}</Tag> },
    { key: 'stage', title: '阶段', width: 80, render: () => '—' },
    { key: 'title', title: '职位', width: 120, render: () => '—' },
    { key: 'country', title: '国家', width: 70, render: (_, row) => row.country || '—' },
    { key: 'source', title: '来源', width: 90, ellipsis: true, render: (_, row) => row.source || '—' },
    { key: 'owner', title: '负责人', width: 90, ellipsis: true, render: (_, row) => row.ownerName || '—' },
    { key: 'customerStage', title: '客户阶段', width: 100, render: (_, row) => scope === 'pool' ? '—' : stageLabel(row.stage) },
    { key: 'updated', title: '最近动态', width: 105, render: (_, row) => formatDate(row.recentActivityAt) },
  ];
  const columns = tableColumns.filter(column => visibleColumns.includes(String(column.key)));
  columns.push({ key: 'actions', title: '', width: 96, fixed: 'right', render: (_, row) => <Space size={0}>
    <Button size="small" type="text" icon={<MailOutlined />} disabled={!row.primaryContactEmail || scope === 'pool'} title="在收件箱中搜索" onClick={() => { if(row.primaryContactEmail)window.location.hash=`#/inbox?search=${encodeURIComponent(row.primaryContactEmail)}`; }} />
    <Button size="small" type="text" icon={<PartitionOutlined />} title="在跟进看板中查看" disabled={scope === 'pool' || !row.hasContacted} onClick={() => {setView('board');onOpenDetail(row.customerId);}} />
    <Button size="small" type="text" icon={<DeleteOutlined />} disabled title={unavailable} />
  </Space> });
  const pagination = <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={leads.total} showSizeChanger={false} onChange={setPage} showTotal={total => `${total} 个客户`} />;

  return <div className="prospector-table-page customer-legacy-shell">
    <div className="customer-legacy-viewbar">
      <Segmented<LegacyView>
        value={view}
        onChange={setView}
        options={[
          { value: 'table', label: '联系人', icon: <UnorderedListOutlined /> },
          { value: 'board', label: '跟进看板', icon: <PartitionOutlined />, disabled: scope === 'pool' },
          { value: 'company', label: '公司', icon: <BankOutlined /> },
        ]}
      />
    </div>

    <div className="customer-legacy-scopebar">
      {scopeOptions.length > 0 && <Segmented size="small" value={taskView} options={scopeOptions} onChange={value => onChangeTask(value as TaskView)} />}
      {additionalViews.length > 0 && <Select aria-label="更多客户视图" size="small" placeholder="更多视图" value={additionalViews.some(item => item.value === taskView) ? taskView : undefined} options={additionalViews} onChange={value => onChangeTask(value as TaskView)} />}
    </div>
    {view === 'table' && <><div className="customer-legacy-toolbar">
      <Input
        aria-label="在线客户搜索"
        prefix={<SearchOutlined />}
        placeholder="搜索邮箱、姓名、公司..."
        value={search}
        onChange={event => setSearch(event.target.value)}
        size="small"
        allowClear
      />
      <Space size="small" wrap>
        <span className="customer-legacy-count">共 {leads.total} 个客户</span>
        {selectedKeys.length > 0 && disabledButton(`删除选中 (${selectedKeys.length})`, <DeleteOutlined />)}
        <Popover trigger="click" placement="bottomRight" content={<div className="customer-columns-panel"><strong>显示字段</strong><Checkbox.Group value={visibleColumns} onChange={values => setVisibleColumns(values.map(String))} options={tableColumns.map(column => ({ value: String(column.key), label: String(column.title) }))} /><Space><Button size="small" type="text" onClick={() => setVisibleColumns(DEFAULT_COLUMNS)}>恢复默认</Button><Button size="small" type="text" onClick={() => setVisibleColumns(tableColumns.map(column => String(column.key)))}>全选</Button></Space></div>}><Button size="small" icon={<SettingOutlined />}>列设置</Button></Popover>
        {disabledButton('导出', <ExportOutlined />)}
        {canImport && <Button size="small" icon={<ImportOutlined />} onClick={onOpenImport}>导入</Button>}
        {canCreate && <Button type="primary" size="small" icon={<PlusOutlined />} onClick={onStartCreate}>新增客户</Button>}
      </Space>
    </div>

    <div className="customer-legacy-filters">
      <Tooltip title="发送阶段尚未接入"><Select size="small" disabled placeholder="阶段" style={{width:100}} /></Tooltip>
      {['状态', '标签', '客户类型', '语言'].map(label => <Tooltip key={label} title={unavailable}><Select size="small" disabled placeholder={label} style={{width:label==='语言'?120:100}} /></Tooltip>)}
      {scope !== 'pool' && <Select aria-label="筛选跟进阶段" size="small" placeholder="客户阶段" allowClear value={stageFilter} onChange={value => { setStageFilter(value); setPage(1); }} options={CUSTOMER_STAGES.map(value => ({ value, label: stageLabel(value) }))} />}
      {Object.values({ stageFilter }).some(Boolean) && <Button size="small" type="text" onClick={() => { setStageFilter(undefined); setPage(1); }}>清除筛选</Button>}
    </div></>}

    {view === 'board' && scope === 'pool' && <Empty description="公共池不展示跟进阶段" />}
    {view === 'board' && scope !== 'pool' && <div className={`customer-classic-board ${selectedCustomerId?'has-detail':''}`} aria-label="跟进看板">
      <div className="customer-classic-board-filter"><span>筛选</span><Select disabled mode="multiple" size="small" placeholder="全部国家" style={{minWidth:150}} /><Select disabled mode="multiple" size="small" placeholder="全部跟进人" style={{minWidth:150}} /><Input size="small" placeholder="搜索公司、联系人或邮箱" value={search} onChange={event=>setSearch(event.target.value)} allowClear /></div>
      <div className="customer-page-count">当前页 {leads.items.length} / 共 {leads.total} 个客户</div>
      {CRM_STAGES.map(stage => {const rows=leads.items.filter(item => customerBoardStage(item) === stage.key).sort((a,b)=>(Date.parse(b.recentActivityAt??'')||0)-(Date.parse(a.recentActivityAt??'')||0));const closed=collapsed[stage.key]??rows.length===0;return <section key={stage.key}>
        <button className="customer-classic-stage" style={{borderLeftColor:stage.color}} onClick={()=>setCollapsed(previous=>({...previous,[stage.key]:!(previous[stage.key]??rows.length===0)}))}>{closed?<RightOutlined />:<DownOutlined />}<span className="customer-stage-dot" style={{background:stage.color}} /><strong>{stage.label}</strong><span className="customer-stage-count">{rows.length}</span></button>
        {!closed && (rows.length ? rows.map(item=><div key={item.customerId} className={`customer-classic-row ${selectedCustomerId===item.customerId?'is-selected':''}`}>
          <button className="customer-classic-row-main" onClick={()=>onOpenDetail(item.customerId)}><strong>{primaryContact(item)}</strong><span className="customer-country">{item.country||'—'}</span><span className="customer-row-company">{item.companyName}</span><span className="customer-row-date">{formatDate(item.recentActivityAt)}</span>{item.ownerName&&<Tag color="geekblue">{item.ownerName}</Tag>}</button>
          <Checkbox aria-label={`选择 ${item.companyName}`} checked={selectedKeys.includes(item.customerId)} onChange={event=>setSelectedKeys(previous=>event.target.checked?[...previous,item.customerId]:previous.filter(key=>key!==item.customerId))} />
        </div>):<div className="customer-classic-empty">暂无</div>)}
      </section>;})}{pagination}
    </div>}
    {view === 'company' && <div className="customer-classic-companies"><div className="customer-company-list"><div className="customer-company-search"><Input size="small" prefix={<SearchOutlined />} placeholder="搜索公司..." value={search} onChange={event=>setSearch(event.target.value)} allowClear /><Button size="small" type="dashed" icon={<PlusOutlined />} disabled={!canCreate} onClick={onStartCreate} /><span>共 {leads.total} 家（当前 {leads.items.length} 家）</span></div>
      {leads.items.map(item=><button key={item.customerId} className={`customer-company-item ${selectedCustomerId===item.customerId?'is-selected':''}`} onClick={()=>onOpenDetail(item.customerId)}><div><strong>{item.companyName}</strong><Tag>{item.contactCount}人</Tag></div><div><span>{item.country||'—'}</span><span title="中心未接入邮件统计">发 —</span><span title="中心未接入邮件统计">回 —</span></div></button>)}{!leads.items.length&&<Empty description="暂无公司" image={Empty.PRESENTED_IMAGE_SIMPLE} />}{pagination}</div><div className="customer-company-detail-placeholder"><Empty description="选择左侧公司查看详情" /></div></div>}
    {view === 'table' && <Table
      className="prospector-page-table customer-table customer-legacy-table"
      dataSource={leads.items}
      columns={columns}
      rowKey="customerId"
      loading={listLoading}
      size="small"
      scroll={{ x: columns.reduce((sum,column)=>sum+Number(column.width||100),32) }}
      tableLayout="fixed"
      rowSelection={{selectedRowKeys:selectedKeys,onChange:setSelectedKeys}}
      pagination={{ current: page, pageSize: PAGE_SIZE, total: leads.total, showSizeChanger: false, showTotal: total => `${total} 条`, onChange: setPage }}
      locale={{ emptyText: '暂无记录' }}
      onRow={row => ({ onDoubleClick: () => onOpenDetail(row.customerId) })}
    />}
    <span className="customer-legacy-scope" aria-hidden="true">{bootstrap.scope === 'shared' ? '共享客户' : '个人客户'}</span>
  </div>;
}
