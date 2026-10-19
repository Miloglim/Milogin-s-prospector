import { invalidateDomain } from "../../lib/cacheDeps";
import { useRouterState } from "@tanstack/react-router";
import { useState, useEffect, useRef, type ReactNode, type ComponentRef } from "react";
import { createPortal } from "react-dom";
import { Table, Button, Input, Space, Drawer, Tag, message, Form, Select, Popover, Checkbox, Modal } from "antd";
import { PlusOutlined, SearchOutlined, DeleteOutlined, SettingOutlined, ImportOutlined, PartitionOutlined, MailOutlined, ExportOutlined, MoreOutlined, LeftOutlined } from "@ant-design/icons";
import type { TableColumnsType } from "antd";
import { useQueryClient } from "@tanstack/react-query";
import { useContacts, useUpsertContact, useDeleteContact, type Contact, type ContactDataPort } from "../../hooks/useContacts";
import { ContactDetailDrawer, CLIENT_TYPE, STATUS_META, STAGE_META, CRM_STAGES, COUNTRIES } from "../../components/ContactDetail";
import { ImportDrawer, type ImportDrawerPort } from "../../components/ImportDrawer";

/* ---------- 可配置列定义 ---------- */
const COLS_KEY = "contacts-cols";
const CENTER_COLS_KEY = "contacts-cols-lead-fields";
const LOCAL_DEFAULT_COLS = ["name", "email", "companyName", "clientType", "status", "relationshipStage", "stage", "title", "source"];
const DEFAULT_COLS = ["companyName", "country", "clientType", "name", "title", "phone", "whatsapp", "email", "sourceLevel1", "sourceLevel2", "status", "relationshipStage", "stage"];

interface ColDef { key: string; title: string; width?: number; render: (c: Contact) => ReactNode; }

// 单元格用原生 title 悬浮提示：50 行 × 10 列若包 antd Tooltip（含操作列共 ~500 实例），
// 每次进页挂载开销是"切页卡一下"的主体；原生 title 零组件成本，Chromium 上表现一致
const Muted = ({ v }: { v: string | null | undefined }) => (
  <span className="text-xs text-gray-500 block truncate" title={v || undefined}>{v || "-"}</span>
);
const Dash = () => <span className="text-xs text-gray-300">—</span>;
const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "-";
const parseTags = (s: string | null): string[] => {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
};
const inCrm = (contact: Contact) => contact.dataSource === 'center' ? ['contacted', 'replied'].includes(contact.touchStatus ?? '') : contact.status === 'reached';
const TOUCH_STATUS_META: Record<string, { label: string; color: string }> = {
  uncontacted: { label: '未触达', color: 'default' },
  contacted: { label: '已触达', color: 'blue' },
  replied: { label: '已回复', color: 'green' },
  unreachable: { label: '无法联系', color: 'red' },
};

const COLUMN_DEFS: ColDef[] = [
  {
    key: "name", title: "联系人姓名", width: 120,
    render: (c) => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email.split("@")[0];
      return <span className="text-xs font-medium text-gray-800 block truncate" title={name}>{name}{c.isShared && <Tag className="text-[10px] my-0 ml-1 leading-none">协作</Tag>}</span>;
    },
  },
  {
    key: "email", title: "邮箱", width: 200,
    render: (c) => <span className="text-xs font-mono text-blue-600 block truncate" title={c.email}>{c.email}</span>,
  },
  { key: "firstName", title: "名", width: 100, render: (c) => <Muted v={c.firstName} /> },
  { key: "lastName", title: "姓", width: 100, render: (c) => <Muted v={c.lastName} /> },
  { key: "companyName", title: "公司名", width: 140, render: (c) => <Muted v={c.companyName} /> },
  { key: "businessType", title: "业务类型", width: 110, render: (c) => <Muted v={c.businessType} /> },
  { key: "website", title: "网站", width: 150, render: (c) => <Muted v={c.website} /> },
  { key: "title", title: "职位 / Title", width: 120, render: (c) => <Muted v={c.title} /> },
  {
    key: "clientType", title: "客户类型", width: 88,
    render: (c) => {
      const m = c.clientType ? CLIENT_TYPE[c.clientType] : null;
      return m ? <Tag color={m.color} className="text-[10px] my-0 leading-none py-0.5 px-1.5">{m.label}</Tag> : <Dash />;
    },
  },
  {
    key: "status", title: "联系状态", width: 88,
    render: (c) => {
      const m = c.dataSource === 'center' ? TOUCH_STATUS_META[c.touchStatus ?? ''] : STATUS_META[c.status || ""];
      return m ? <Tag color={m.color} className="text-[10px] my-0 leading-none py-0.5 px-1.5">{m.label}</Tag> : <Dash />;
    },
  },
  {
    key: "stage", title: "发送阶段", width: 80,
    render: (c) => {
      const m = STAGE_META[c.stage || ""];
      return m ? <Tag color={m.color} className="text-[10px] my-0 leading-none py-0.5 px-1.5">{m.label}</Tag> : <Dash />;
    },
  },
  {
    key: "relationshipStage", title: "客户阶段", width: 88,
    render: (c) => {
      const m = CRM_STAGES.find(stage => stage.key === c.relationshipStage);
      return m ? <Tag color={m.color} className="text-[10px] my-0 leading-none py-0.5 px-1.5">{m.label}</Tag> : <Dash />;
    },
  },
  { key: "phone", title: "电话", width: 130, render: (c) => <Muted v={c.phone} /> },
  { key: "whatsapp", title: "WhatsApp", width: 130, render: (c) => <Muted v={c.whatsapp} /> },
  { key: "linkedinUrl", title: "LinkedIn", width: 150, render: (c) => <Muted v={c.linkedinUrl} /> },
  { key: "language", title: "语言", width: 70, render: (c) => <Muted v={c.language} /> },
  { key: "country", title: "国家", width: 70, render: (c) => <Muted v={c.country} /> },
  { key: "sourceLevel1", title: "一级来源", width: 110, render: (c) => <Muted v={c.sourceLevel1} /> },
  { key: "sourceLevel2", title: "二级来源", width: 130, render: (c) => <Muted v={c.sourceLevel2} /> },
  {
    key: "source", title: "导入批次来源", width: 120,
    render: (c) => c.source ? <Tag className="text-[10px] my-0 leading-none px-1.5">{c.source}</Tag> : <Dash />,
  },
  { key: "assignee", title: "负责人", width: 90, render: (c) => <Muted v={c.assignee} /> },
  {
    key: "tags", title: "标签", width: 90,
    render: (c) => {
      const key = parseTags(c.tags)[0];
      return key ? <Tag className="text-[10px] my-0 leading-none py-0.5 px-1.5">{key}</Tag> : <Dash />;
    },
  },
  { key: "createdAt", title: "创建", width: 80, render: (c) => <Muted v={fmtDate(c.createdAt)} /> },
  { key: "updatedAt", title: "更新", width: 80, render: (c) => <Muted v={fmtDate(c.updatedAt)} /> },
];

export function ContactList({ dataPort, importPort, onAssign, renderDetail, headerActionsTarget, online = true }: {
  dataPort?: ContactDataPort; importPort?: ImportDrawerPort;
  onAssign?: (ids: number[]) => void;
  renderDetail?: (contact: Contact | null, close: () => void) => ReactNode;
  headerActionsTarget?: HTMLElement | null;
  online?: boolean;
} = {}) {
  const location = useRouterState({ select: s => s.location });
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionsView, setActionsView] = useState<"main" | "columns" | "export">("main");
  const [detailContact, setDetailContact] = useState<Contact | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  // 从收件箱跳转（#/customers?detail=id）的目标联系人：数据到达后滚动定位 + 高亮 + 展开
  const [pendingDetailId, setPendingDetailId] = useState<number | null>(null);
  // antd 5 顶层未导出 TableRef 类型：用 ComponentRef<typeof Table>（含 ref.scrollTo）并显式调用
  const tableRef = useRef<ComponentRef<typeof Table>>(null);
  const [visibleCols, setVisibleCols] = useState<string[]>(() => {
    try {
      const current = dataPort ? localStorage.getItem(CENTER_COLS_KEY) : null;
      const s = current ?? localStorage.getItem(COLS_KEY);
      const saved = s ? JSON.parse(s) as string[] : dataPort ? DEFAULT_COLS : LOCAL_DEFAULT_COLS;
      return dataPort && !current ? [...new Set(saved.flatMap(key => key === 'source' ? ['sourceLevel1', 'sourceLevel2'] : [key]))] : saved;
    } catch { return dataPort ? DEFAULT_COLS : LOCAL_DEFAULT_COLS; }
  });
  const [form] = Form.useForm();

  // 搜索防抖：输入逐键触发查询会连续打"COUNT+JOIN+LIKE+ORDER BY"全表扫描（主进程同步查询，会阻塞事件循环）
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, error, dataUpdatedAt } = useContacts({ search: debouncedSearch, page }, dataPort);
  const upsertContact = useUpsertContact(dataPort);
  const deleteContact = useDeleteContact(dataPort);
  const qc = useQueryClient();

  const contacts = data?.success ? (data.data?.items || []) : [];
  const total = data?.success ? (data.data?.total || 0) : 0;

  useEffect(() => {
    if (!dataPort || !data?.success || !selectedRowKeys.length) return;
    let active = true;
    // A paginated row disappearing does not prove loss of access; reconcile against the full authorized scope.
    void dataPort.listIds({}).then(result => {
      if (!active || !result.success || !result.data) return;
      const allowed = new Set(result.data.ids);
      setSelectedRowKeys(previous => previous.every(id => allowed.has(Number(id))) ? previous : previous.filter(id => allowed.has(Number(id))));
    }).catch(() => { /* Retain selection while the authorized ID list is unavailable. */ });
    return () => { active = false; };
  }, [dataPort, dataUpdatedAt, data?.success, selectedRowKeys.length]);

  // 跳转定位：目标联系人出现在当前列表数据后 → 高亮该行 + 滚动到可视区 + 详情已由上方打开
  useEffect(() => {
    if (pendingDetailId == null) return;
    const idx = contacts.findIndex(c => c.id === pendingDetailId);
    if (idx < 0) return; // 数据未加载到（翻页/清筛选后重新拉取中），等下一次数据变更
    setSelectedRowKeys([pendingDetailId]);
    requestAnimationFrame(() => {
      try { tableRef.current?.scrollTo?.({ index: idx }); } catch { /* 老版本无 scrollTo 时忽略 */ }
    });
    setPendingDetailId(null);
  }, [contacts, pendingDetailId]);

  // 跨页全选：拉取当前搜索结果的全部 id（服务端分页时表头全选只能选当前页 50 条）
  const selectAllMatched = async () => {
    const r = await (dataPort ? dataPort.listIds({ search: debouncedSearch }) : window.api.invoke("contacts:listIds", { search: debouncedSearch })) as
      { success: boolean; data?: { ids: number[] }; error?: string };
    if (r?.success && r.data) {
      setSelectedRowKeys(r.data.ids);
      message.success(`已选中全部 ${r.data.ids.length} 个匹配联系人`);
    } else message.error(r?.error || "选择失败");
  };

  // 批量删除选中联系人（一次级联 + 一次落盘，支持跨页全选）
  const batchDelete = () => {
    if (dataPort && (!online || !dataPort.deleteBatch)) return;
    if (selectedRowKeys.length === 0) return;
    const ids = selectedRowKeys.map(k => Number(k)).filter(n => Number.isInteger(n) && n > 0);
    Modal.confirm({
      title: `删除 ${ids.length} 个联系人？`,
      content: dataPort ? "删除后不再参与匹配和新发送任务，历史记录保留。" : "将同时清除其跟进/发送记录并解除邮件关联，空壳公司一并回收。此操作不可撤销，建议先导出。",
      okText: "删除", okType: "danger", cancelText: "取消",
      onOk: async () => {
        const r = await (dataPort ? dataPort.deleteBatch!(ids) : window.api.invoke("contacts:deleteBatch", ids)) as
          { success: boolean; data?: { deleted: number; companiesRemoved: number }; error?: string };
        r?.success
          ? message.success(`已删除 ${r.data?.deleted ?? ids.length} 个联系人`)
          : message.error(r?.error || "删除失败");
        if(r.success)setSelectedRowKeys([]);
        if(dataPort)for(const key of ["center-contacts","center-companies","center-company-detail","center-contact-detail","dashboard","search","center-assignment","inbox"])void qc.invalidateQueries({queryKey:[key]});
        else invalidateDomain(qc, "contacts");
      },
    });
  };

  // ── 导出（原独立导出页功能并入：联系人 CSV / 跟进记录 CSV）──
  const [exporting, setExporting] = useState(false);
  const downloadCsv = (content: string, filename: string) => {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  const handleExport = async (kind: "contacts" | "notes") => {
    setExporting(true);
    try {
      const result = dataPort?.export ? await dataPort.export(kind, { search: debouncedSearch }) : kind === "contacts"
        ? await window.api.invoke("export:contactsToExcel", { search: debouncedSearch })
        : await window.api.invoke("export:notesToCsv");
      const r = result as { success: boolean; data?: string; error?: string };
      if (!r?.success) { message.error(r?.error || "导出失败"); return; }
      const name = kind === "contacts" ? "contacts" : "跟进记录";
      downloadCsv(r.data || "", `${name}_${new Date().toISOString().slice(0, 10)}.csv`);
      message.success("导出完成");
    } catch {
      message.error("导出失败");
    } finally {
      setExporting(false);
    }
  };

  // 从收件箱跳转来的预填/详情（读 hash 路由的 search 部分）
  useEffect(() => {
    if (location.pathname !== "/customers") return;
    const rawHash = window.location.hash; // 如 "#/customers?view=table&add=1&email=..." 或 "#/customers?view=table&detail=123"
    const qs = rawHash.includes("?") ? rawHash.split("?")[1] : "";
    if (!qs) return;
    const sp = new URLSearchParams(qs);
    if (sp.get("view") && sp.get("view") !== "table") return;

    // 打开详情 — 直接按 id 拉取，不依赖当前分页/筛选结果（否则目标联系人不在当前页就弹不出）
    const detailId = sp.get("detail");
    if (detailId) {
      // Inbox detail IDs refer to SQLite. Never reinterpret them as center IDs.
      if (dataPort) { message.info("请在联系人列表中选择中心联系人"); return; }
      const id = Number(detailId);
      if (!isNaN(id)) {
        window.api.invoke("contacts:getById", id).then((res) => {
          const r = res as { success: boolean; data?: Contact };
          if (r?.success && r.data) setDetailContact(r.data);
        });
        // 跳转定位：清掉搜索（保证目标行在结果集里），再用 listIds（与列表同排序）
        // 算出目标所在页码，数据到位后由下方 effect 滚动定位 + 高亮 + 保持详情展开
        setSearch("");
        setDebouncedSearch("");
        setPage(1);
        window.api.invoke("contacts:listIds", {}).then((res) => {
          const r = res as { success: boolean; data?: { ids: number[] } };
          if (r?.success && r.data) {
            const idx = r.data.ids.indexOf(id);
            if (idx >= 50) setPage(Math.floor(idx / 50) + 1);
          }
          setPendingDetailId(id);
        });
      }
      window.location.hash = rawHash.split("?")[0]!;
      return;
    }

    // 新增预填
    if (sp.get("add") === "1" && sp.get("email")) {
      form.setFieldsValue({
        email: sp.get("email") || "",
        companyName: sp.get("company") || "",
        firstName: sp.get("firstName") || "",
        lastName: sp.get("lastName") || "",
        clientType: sp.get("clientType") || undefined,
        ...(dataPort ? {customerType: CLIENT_TYPE[sp.get("clientType") ?? '']?.label} : {}),
      });
      setAddOpen(true);
      window.location.hash = rawHash.split("?")[0]!;
    }
  }, [form, location.pathname, location.searchStr, dataPort]);

  const updateCols = (cols: string[]) => {
    setVisibleCols(cols);
    localStorage.setItem(dataPort ? CENTER_COLS_KEY : COLS_KEY, JSON.stringify(cols));
  };

  const visibleDefinitions = visibleCols.flatMap(key => COLUMN_DEFS.find(d => d.key === key) ?? []);
  const columns: TableColumnsType<Contact> = [
    ...visibleDefinitions.map(d => ({
      title: d.title, key: d.key, width: d.width,
      render: (_: unknown, r: Contact) => d.render(r),
    })),
    {
      title: "", key: "actions", width: 96, fixed: "right" as const,
      render: (_: unknown, r: Contact) => (
        <Space size={0} style={{ display: "flex", justifyContent: "center" }}>
          <Button type="text" size="small" icon={<MailOutlined />}
            className="btn-hover-color"
            style={{ color: "#bbb" }}
            title="在收件箱中搜索"
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              window.location.hash = `#/inbox?search=${encodeURIComponent(r.email)}`;
            }}
          />
          <Button type="text" size="small" icon={<PartitionOutlined />}
            disabled={!inCrm(r)}
            className="btn-hover-color"
            style={{ color: inCrm(r) ? "#bbb" : "#d9d9d9" }}
            title={inCrm(r) ? "在CRM中查看" : "未进入CRM管线"}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              if (!inCrm(r)) return;
              window.location.hash = dataPort ? `#/customers?view=board&centerContact=${r.contactId}&centerCustomer=${r.customerId}` : `#/customers?view=board&detail=${r.id}`;
            }}
          />
          <Button type="text" size="small" icon={<DeleteOutlined />}
            disabled={!!dataPort && (!online || !r.canDelete)}
            loading={deletingId === r.id}
            className="btn-hover-color"
            style={{ color: "#bbb" }}
            title="删除"
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={async (e) => {
              e.stopPropagation();
              if (deletingId) return;
              setDeletingId(r.id);
              try {
                const res = await deleteContact.mutateAsync(r.id);
                res?.success ? message.success("已删除") : message.error(res?.error || "失败");
              } catch {
                message.error("删除失败");
              } finally {
                setDeletingId(null);
              }
            }}
          />
        </Space>
      ),
    },
  ];

  const colsPanel = (
    <div className="w-56">
      <div className="text-[11px] font-semibold text-gray-500 mb-2">显示字段</div>
      <Checkbox.Group
        value={visibleCols}
        onChange={(v) => updateCols(v as string[])}
        className="contact-columns-options grid grid-cols-2 gap-x-2 gap-y-1"
      >
        {COLUMN_DEFS.map(d => (
          <Checkbox key={d.key} value={d.key} className="text-xs">{d.title}</Checkbox>
        ))}
      </Checkbox.Group>
      <div className="flex justify-between mt-3 pt-2 border-t border-gray-100">
        <Button size="small" type="text" onClick={() => updateCols(dataPort ? DEFAULT_COLS : LOCAL_DEFAULT_COLS)}>恢复默认</Button>
        <Button size="small" type="text" onClick={() => updateCols(COLUMN_DEFS.map(d => d.key))}>全选</Button>
      </div>
    </div>
  );

  const closeActions = () => { setActionsOpen(false); setActionsView("main"); };
  const actionItem = (label: string, icon: ReactNode, onClick: () => void, disabled = false) => (
    <Button key={label} type="text" size="small" icon={icon} disabled={disabled} onClick={onClick}
      className="w-full text-left" style={{ display: "flex", alignItems: "center", justifyContent: "flex-start" }}>{label}</Button>
  );
  const actionsPanel = <div className={`${actionsView === "columns" ? "w-56" : "w-48"} flex flex-col gap-0.5`}>
    {actionsView !== "main" && actionItem("返回", <LeftOutlined />, () => setActionsView("main"))}
    {actionsView === "main" && <>
      {actionItem("新增", <PlusOutlined />, () => { closeActions(); form.resetFields(); setAddOpen(true); }, !!dataPort && !online)}
      {actionItem("导入", <ImportOutlined />, () => { closeActions(); setImportOpen(true); }, !!dataPort && (!importPort || !online))}
      {actionItem("导出", <ExportOutlined />, () => setActionsView("export"), !!dataPort && !dataPort.export)}
      {actionItem("列设置", <SettingOutlined />, () => setActionsView("columns"))}
    </>}
    {actionsView === "export" && <>
      {actionItem("联系人 CSV", <ExportOutlined />, () => { closeActions(); void handleExport("contacts"); }, exporting)}
      {actionItem("跟进记录 CSV", <ExportOutlined />, () => { closeActions(); void handleExport("notes"); }, exporting)}
    </>}
    {actionsView === "columns" && colsPanel}
  </div>;

  // scroll.x 用数字：每列已有固定 width，"max-content" 会让 Table 挂载时同步测量内容宽度并强制回流
  const tableScrollX = COLUMN_DEFS.filter(d => visibleCols.includes(d.key))
    .reduce((s, d) => s + (d.width || 100), 0) + 96 /* 操作列 */ + 32 /* 多选列 */;

  const searchInput = <Input prefix={<SearchOutlined />} placeholder="搜索邮箱、姓名、公司..."
    value={search} onChange={e => { setSearch(e.target.value); setPage(1); }}
    size="small" style={{ width: 260, maxWidth: "100%" }} allowClear />;
  const headerActions = <Space size="small">
    {headerActionsTarget && searchInput}
    <Popover trigger="click" placement="bottomRight" open={actionsOpen}
      onOpenChange={open => { setActionsOpen(open); if (!open) setActionsView("main"); }} content={actionsPanel}>
      <Button type="text" size="small" icon={<MoreOutlined />} aria-label="更多操作" title="更多操作" />
    </Popover>
  </Space>;

  return (
    <div className="prospector-table-page customer-contacts-page">
      {headerActionsTarget && createPortal(headerActions, headerActionsTarget)}
      {/* 选中记录后的批量操作 */}
      {(!headerActionsTarget || selectedRowKeys.length > 0) && <div className={`flex items-center ${headerActionsTarget ? "justify-end" : "justify-between"}`}>
        {!headerActionsTarget && searchInput}
        <Space size="small">
          {!headerActionsTarget && headerActions}
          {selectedRowKeys.length > 0 && selectedRowKeys.length < total && (
            <Button size="small" type="link" style={{ padding: 0, height: "auto" }}
              onClick={selectAllMatched}>选择全部 {total} 个匹配项</Button>
          )}
          {selectedRowKeys.length > 0 && (
            <Button size="small" danger icon={<DeleteOutlined />}
              disabled={!!dataPort && (!online || !dataPort.deleteBatch || selectedRowKeys.some(id=>!dataPort.canDelete?.(Number(id))))}
              onClick={batchDelete}>删除选中 ({selectedRowKeys.length})</Button>
          )}
          {onAssign && selectedRowKeys.length > 0 && <Button size="small" onClick={() => onAssign(selectedRowKeys.map(Number))}>分配线索 ({selectedRowKeys.length})</Button>}
        </Space>
      </div>}

      {/* 加载 / 错误 */}
      {(error || data?.success === false) && <div role="alert" className="text-xs text-red-500 p-2 bg-red-50 rounded">{data?.error || '加载失败'}</div>}

      {/* 表格 — 高密度 */}
      <Table
        ref={tableRef}
        dataSource={contacts}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        size="small"
        scroll={{ x: tableScrollX }}
        className="prospector-page-table customer-contacts-table [&_.ant-table-thead>tr>th]:!text-[11px] [&_.ant-table-thead>tr>th]:!text-gray-400 [&_.ant-table-thead>tr>th]:!font-medium"
        pagination={{
          current: page, pageSize: 50, total, onChange: setPage,
          size: "small", showSizeChanger: false,
          showTotal: t => `${t} 人`,
        }}
        rowSelection={{
          selectedRowKeys,
          onChange: setSelectedRowKeys,
          preserveSelectedRowKeys: true,
        }}
        tableLayout="fixed"
        onRow={(record) => ({
          onDoubleClick: () => setDetailContact(record),
          onClick: (e: React.MouseEvent) => {
            if (e.ctrlKey || e.metaKey) {
              setSelectedRowKeys(prev => prev.includes(record.id) ? prev.filter(k => k !== record.id) : [...prev, record.id]);
            } else if (e.shiftKey) {
              const last = selectedRowKeys.length ? selectedRowKeys[selectedRowKeys.length - 1] : record.id;
              const idxA = contacts.findIndex(c => c.id === last);
              const idxB = contacts.findIndex(c => c.id === record.id);
              const [lo, hi] = [Math.min(idxA, idxB), Math.max(idxA, idxB)];
              const range = contacts.slice(lo, hi + 1).map(c => c.id);
              setSelectedRowKeys(prev => [...new Set([...prev, ...range])]);
            }
          },
        })}
        rowClassName="cursor-pointer"
      />

      {/* 新增弹窗 — 紧凑 */}
      <Drawer rootClassName="app-drawer-below-titlebar" title="新增联系人" open={addOpen} onClose={() => setAddOpen(false)} width={400}>
        <Form form={form} layout="vertical" size="small"
          onFinish={async (v) => {
            const r = await upsertContact.mutateAsync(v);
            r?.success ? (setAddOpen(false), message.success("已保存")) : message.error(r?.error || "失败");
          }}
        >
          {dataPort && <div className="text-xs font-semibold text-gray-500 mb-3">公司资料</div>}
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="companyName" label="公司名" rules={dataPort ? [{ required: true, whitespace: true, message: "请输入公司名称" }] : []}><Input size="small" placeholder="公司名称" /></Form.Item>
            <Form.Item name={dataPort ? "customerType" : "clientType"} label="客户类型"><Select size="small" allowClear options={[{value:dataPort ? "代理" : "agent",label:"代理"},{value:dataPort ? "直客" : "direct",label:"直客"}]} /></Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="country" label="国家">
              <Select size="small" showSearch optionFilterProp="label" allowClear placeholder="搜索选择国家"
                options={COUNTRIES.map(c => ({ value: c.code, label: `${c.code} ${c.label}` }))} />
            </Form.Item>
          </div>
          {dataPort && <div className="grid grid-cols-2 gap-3">
            <Form.Item name="businessType" label="业务类型"><Input size="small" /></Form.Item>
            <Form.Item name="website" label="网站"><Input size="small" /></Form.Item>
          </div>}
          {dataPort && <div className="text-xs font-semibold text-gray-500 mb-3">联系人与线索来源</div>}
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="firstName" label="名"><Input size="small" /></Form.Item>
            <Form.Item name="lastName" label="姓"><Input size="small" /></Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="title" label="职位 / Title"><Input size="small" /></Form.Item>
            <Form.Item name="linkedinUrl" label="LinkedIn"><Input size="small" /></Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="language" label="语言">
                <Select size="small" allowClear placeholder="匹配发信模板"
                  options={[
                    { value: "ES", label: "ES 西班牙语" },
                    { value: "PT", label: "PT 葡萄牙语" },
                    { value: "EN", label: "EN 英语" },
                  ]} />
              </Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="phone" label="电话"><Input size="small" /></Form.Item>
            {dataPort && <Form.Item name="whatsapp" label="WhatsApp"><Input size="small" /></Form.Item>}
          </div>
          <Form.Item name="email" label="邮箱" rules={[{ required: !dataPort, type: "email" }]}><Input size="small" /></Form.Item>
          {dataPort && <>
            <div className="grid grid-cols-2 gap-3">
              <Form.Item name="sourceLevel1" label="一级来源"><Input size="small" /></Form.Item>
              <Form.Item name="sourceLevel2" label="二级来源"><Input size="small" /></Form.Item>
            </div>
            <Form.Item name="stage" label="发送阶段"><Select size="small" allowClear options={Object.entries(STAGE_META).map(([value,meta])=>({value,label:meta.label}))} /></Form.Item>
          </>}
          <Button type="primary" htmlType="submit" size="small" block loading={upsertContact.isPending}>
            保存
          </Button>
        </Form>
      </Drawer>

      {/* 导入抽屉 */}
      <ImportDrawer open={importOpen} onClose={() => setImportOpen(false)} port={importPort} disabled={!!dataPort && !online} />

      {/* 详情抽屉 — 双击打开，分页标签 */}
      {renderDetail ? renderDetail(detailContact, () => setDetailContact(null)) : <ContactDetailDrawer
        contact={detailContact}
        open={!!detailContact}
        onClose={() => setDetailContact(null)}
        onUpdated={(c) => setDetailContact(c)}
      />}
    </div>
  );
}
