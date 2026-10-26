import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Alert, Button, Empty, Input, Select, Space, Spin, Table, Tag, Typography, theme, type TableColumnsType, type TableProps } from "antd";
import { ADMIN_DATA_BROWSER_LIMITS, type AdminDataPage, type AdminDataTableInfo, type AdminDataValueKind } from "../server/core/admin-data-browser";
import type { Identity } from "../server/core/auth";
import { api, ApiError } from "./api";

const dateText = (value: unknown) => {
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString("zh-CN", { hour12: false });
};

function valueCell(value: unknown, kind: AdminDataValueKind) {
  if (value === null || value === undefined) return <Typography.Text type="secondary">NULL</Typography.Text>;
  if (kind === "boolean") return <Tag color={value ? "success" : "default"}>{value ? "是" : "否"}</Tag>;
  if (kind === "date") return dateText(value);
  if (kind === "json") return JSON.stringify(value);
  return String(value);
}

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "数据读取失败";

export function DataBrowser({ identity }: { identity: Identity }) {
  const { token } = theme.useToken();
  const style = {
    "--dashboard-text": token.colorText,
    "--dashboard-muted": token.colorTextSecondary,
    "--dashboard-border": token.colorBorderSecondary,
    "--dashboard-accent": token.colorPrimary,
    "--dashboard-tint": token.colorFillSecondary,
  } as CSSProperties;
  const [tables, setTables] = useState<AdminDataTableInfo[]>([]);
  const [tableId, setTableId] = useState("");
  const [data, setData] = useState<AdminDataPage | null>(null);
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(ADMIN_DATA_BROWSER_LIMITS.page);
  const [sort, setSort] = useState<string | undefined>();
  const [direction, setDirection] = useState<"asc" | "desc" | undefined>();
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const dataVersion = useRef(0);

  useEffect(() => {
    let cancelled = false;
    mounted.current = true;
    setLoadingCatalog(true); setError(""); setTables([]); setTableId(""); setData(null);
    void api.dataTables().then(result => {
      if (!cancelled) { setTables(result); setTableId(result[0]?.id ?? ""); }
    }).catch(cause => {
      if (!cancelled) setError(errorText(cause));
    }).finally(() => {
      if (!cancelled) setLoadingCatalog(false);
    });
    return () => { cancelled = true; mounted.current = false; dataVersion.current++; };
  }, [identity.userId]);

  const loadPage = useCallback(async () => {
    if (!tableId) return;
    const version = ++dataVersion.current;
    const current = () => mounted.current && version === dataVersion.current;
    setLoadingData(true); setError("");
    try {
      const result = await api.data({ table: tableId, search, limit: pageSize, offset: (page - 1) * pageSize, ...(sort ? { sort } : {}), ...(direction ? { direction } : {}) });
      if (current()) setData(result);
    } catch (cause) {
      if (current()) {
        if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) setData(null);
        setError(errorText(cause));
      }
    } finally {
      if (current()) setLoadingData(false);
    }
  }, [direction, page, pageSize, search, sort, tableId]);

  useEffect(() => {
    if (!tableId) return;
    void loadPage();
    return () => { dataVersion.current++; };
  }, [loadPage, refreshVersion]);

  const selectTable = (id: string) => {
    setTableId(id); setSearch(""); setSearchDraft(""); setPage(1); setSort(undefined); setDirection(undefined); setData(null);
  };

  const tableChange: TableProps<Record<string, unknown>>["onChange"] = (pagination, _filters, sorter) => {
    const active = Array.isArray(sorter) ? sorter[0] : sorter;
    if (active?.order && active.columnKey) { setSort(String(active.columnKey)); setDirection(active.order === "ascend" ? "asc" : "desc"); }
    if (active?.order === null || active?.order === undefined) { setSort(undefined); setDirection(undefined); }
    const nextSize = pagination.pageSize ?? pageSize;
    setPage(nextSize === pageSize ? Number(pagination.current ?? 1) : 1);
    setPageSize(nextSize);
  };

  const columns: TableColumnsType<Record<string, unknown>> = (data?.columns ?? []).map(column => ({
    title: column.label,
    dataIndex: column.key,
    key: column.key,
    width: column.kind === "json" ? 320 : column.kind === "text" ? 190 : 150,
    ellipsis: true,
    sorter: column.sortable,
    sortOrder: data?.sort === column.key ? data.direction === "asc" ? "ascend" : "descend" : null,
    render: (value: unknown) => valueCell(value, column.kind),
  }));

  const groups = [...new Set(tables.map(table => table.group))];
  const selected = tables.find(table => table.id === tableId);
  return <section className="product-dashboard data-browser" style={style} aria-label="数据浏览">
    <div className="dashboard-heading data-browser-heading">
      <div><Typography.Title level={2}>数据浏览</Typography.Title><Typography.Text type="secondary">中心 PostgreSQL · 只读</Typography.Text></div>
      <Space><Tag>只读</Tag><Button loading={loadingData} disabled={!tableId} onClick={() => setRefreshVersion(value => value + 1)}>刷新</Button></Space>
    </div>
    {loadingCatalog ? <div className="dashboard-loading"><Spin /><Typography.Text>正在读取数据目录</Typography.Text></div>
      : error && !tables.length ? <Alert type="error" showIcon message={error} />
      : !tables.length ? <Empty description="暂无可浏览的数据表" />
      : <>
        {error && <Alert className="data-browser-alert" type="warning" showIcon message={`读取失败，当前显示上次数据：${error}`} />}
        <div className="data-browser-toolbar">
          <Select aria-label="数据表" value={tableId || undefined} onChange={selectTable} options={groups.map(group => ({ label: group, options: tables.filter(table => table.group === group).map(table => ({ value: table.id, label: table.label })) }))} />
          <Input.Search aria-label="搜索当前表" placeholder="搜索当前表" allowClear maxLength={ADMIN_DATA_BROWSER_LIMITS.searchMax} value={searchDraft} onChange={event => setSearchDraft(event.target.value)} onSearch={value => { setSearch(value.trim()); setPage(1); }} />
          <Typography.Text type="secondary">{selected?.description}</Typography.Text>
        </div>
        {!data ? <div className="dashboard-loading"><Spin /><Typography.Text>正在读取数据</Typography.Text></div>
          : <Table<Record<string, unknown>>
              className="data-browser-table"
              size="small"
              rowKey={record => String(record[data.keyColumn] ?? JSON.stringify(record))}
              loading={loadingData}
              dataSource={data.rows}
              columns={columns}
              scroll={{ x: "max-content" }}
              locale={{ emptyText: <Empty description={search ? "没有匹配记录" : "当前表暂无数据"} /> }}
              pagination={{
                current: page,
                pageSize,
                total: data.total,
                showSizeChanger: true,
                pageSizeOptions: ADMIN_DATA_BROWSER_LIMITS.pageSizes.map(String),
                showTotal: total => `共 ${total} 行`,
              }}
              onChange={tableChange}
            />}
      </>}
  </section>;
}
