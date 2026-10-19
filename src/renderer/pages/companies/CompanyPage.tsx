import { invalidateDomain } from "../../lib/cacheDeps";
import { useState, useEffect } from "react";
import { Card, Input, Button, Tag, message, Empty, Popconfirm, Space } from "antd";
import { SearchOutlined, PlusOutlined, DeleteOutlined, EditOutlined, SaveOutlined, CloseOutlined, EnvironmentOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ONLINE_LIMITS } from '../../../shared/online-crm';

export interface CompanyWithCounts {
  id: number; name: string; domain: string | null; industry: string | null; customerType?: string | null;
  country: string | null; size: string | null;
  contactCount: number; sentCount: number | null; repliedCount: number | null;
  createdAt: string; updatedAt: string;
}

export interface CompanyDetail {
  company: { id: number; name: string; domain: string | null; industry: string | null; customerType?: string | null; country: string | null; size: string | null; createdAt: string };
  contacts: Array<{ id: number; email: string; firstName: string | null; lastName: string | null; title: string | null; phone: string | null; stage: string | null; status: string | null }>;
  sentCount: number | null; repliedCount: number | null;
  canEdit?: boolean; canDelete?:boolean;
}
export interface CompanyDataPort { canCreate?:boolean; delete?(id:number):Promise<{success:boolean;error?:string}>; update?(input: Record<string, unknown>): Promise<{success:boolean; error?:string}>; key: string; list(search: string, page: number, pageSize: number): Promise<{ success: boolean; data?: { items: CompanyWithCounts[]; total: number }; error?: string }>; detail(id: number): Promise<{ success: boolean; data?: CompanyDetail; error?: string }>; }

const STAGE_LABELS: Record<string, { label: string; color: string }> = {
  cold: { label: "冷开发", color: "#1565c0" },
  f1: { label: "F1", color: "#2e7d32" },
  f2: { label: "F2", color: "#e65100" },
  f3: { label: "F3", color: "#7b1fa2" },
  f4: { label: "F4", color: "#546e7a" },
};

export function CompanyPage({ dataPort }: { dataPort?: CompanyDataPort } = {}) {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  // 深链定位：#/customers?view=company&sel=<id>（AI 动作卡「查看公司档案」用）
  const [selectedId, setSelectedId] = useState<number | null>(() => {
    if (dataPort) return null;
    const raw = window.location.hash;
    const qs = raw.includes("?") ? raw.split("?")[1] : "";
    const sel = Number(new URLSearchParams(qs).get("sel"));
    return Number.isInteger(sel) && sel > 0 ? sel : null;
  });
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editVal, setEditVal] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDomain, setNewDomain] = useState("");
  const PAGE_SIZE = 100;

  // sel 只在首次进入时起作用，消费后从 hash 摘掉，避免刷新反复定位
  useEffect(() => {
    const raw = window.location.hash;
    if (!raw.includes("sel=")) return;
    const [base, qs = ""] = raw.split("?");
    const sp = new URLSearchParams(qs);
    sp.delete("sel");
    const rest = sp.toString();
    window.location.hash = rest ? `${base}?${rest}` : base!;
  }, []);

  const { data: listData, isLoading, error: listError, dataUpdatedAt: listUpdatedAt } = useQuery({
    queryKey: [dataPort ? 'center-companies' : "companies", dataPort?.key, search, page],
    queryFn: () => dataPort ? dataPort.list(search, page, PAGE_SIZE) : window.api.invoke("companies:list", search || undefined, page, PAGE_SIZE) as Promise<{ success: boolean; data?: { items: CompanyWithCounts[]; total: number }; error?: string }>,
    refetchInterval: dataPort ? ONLINE_LIMITS.pollMs : false,
  });

  const { data: detailData } = useQuery({
    queryKey: [dataPort ? 'center-company-detail' : "companies", "detail", dataPort?.key, selectedId],
    queryFn: () => dataPort ? dataPort.detail(selectedId!) : window.api.invoke("companies:getDetail", selectedId) as Promise<{ success: boolean; data?: CompanyDetail; error?: string }>,
    enabled: !!selectedId,
  });

  const upsertMut = useMutation({
    mutationFn: (input: Record<string, unknown>) => dataPort?.update ? dataPort.update(input) : window.api.invoke("companies:upsert", input),
    onSuccess: (result) => {
      const r = result as {success:boolean;error?:string};
      if (!r.success) { message.error(r.error || '保存失败'); return; }
      invalidateDomain(qc, "companies");
      void qc.invalidateQueries({queryKey:["center-companies"]});
      void qc.invalidateQueries({queryKey:['center-company-detail']});
      void qc.invalidateQueries({queryKey:['center-contacts']});
      message.success("已保存");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => dataPort ? dataPort.delete!(id) : window.api.invoke("companies:delete", id),
    onSuccess: (result) => {
      const r = result as { success: boolean; error?: string };
      r?.success ? (message.success("已删除"), setSelectedId(null)) : message.error(r?.error || "删除失败");
      invalidateDomain(qc, "companies");
      void qc.invalidateQueries({queryKey:["center-companies"]});
    },
  });

  const companies = listData?.success ? listData.data?.items || [] : [];
  const total = listData?.success ? listData.data?.total || 0 : 0;
  const detail = detailData?.success ? detailData.data : null;
  useEffect(() => {
    if (dataPort && selectedId && listData?.success) void qc.invalidateQueries({ queryKey: ['center-company-detail', 'detail', dataPort.key, selectedId] });
  }, [dataPort, selectedId, listUpdatedAt, listData?.success, qc]);
  useEffect(() => { if (dataPort && !detail?.canEdit) setEditingField(null); }, [dataPort, detail?.canEdit]);

  const saveField = (field: string, val: string) => {
    if (!detail || dataPort && !detail.canEdit) return;
    upsertMut.mutate({ id: detail.company.id, name: detail.company.name, [field]: val });
    setEditingField(null);
  };

  const addCompany = async () => {
    if (!newName.trim()) return;
    const r = await upsertMut.mutateAsync({ name: newName.trim(), domain: newDomain.trim() || undefined });
    const res = r as { success: boolean; data?: { id: number } };
    if (res?.success && res.data?.id) setSelectedId(res.data.id);
    if(res?.success){setAdding(false); setNewName(""); setNewDomain("");}
  };

  return (
    <div className="flex gap-4 h-full" style={{ minHeight: "calc(100vh - var(--app-titlebar-height) - 32px)" }}>
      {/* ═══ 左侧公司列表 ═══ */}
      <div className="flex-shrink-0 bg-white border border-gray-200 rounded-lg flex flex-col overflow-hidden" style={{ width: 280 }}>
        <div className="p-3 border-b border-gray-100 space-y-2">
          <div className="flex items-center gap-2">
            <Input size="small" prefix={<SearchOutlined />} placeholder="搜索公司名或域名"
              value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} allowClear />
            <Button size="small" type="dashed" aria-label="新增公司" icon={<PlusOutlined />}
              disabled={!!dataPort && !dataPort.canCreate}
              onClick={() => setAdding(true)} />
          </div>
          <div className="text-[10px] text-gray-400">共 {total} 家（当前 {companies.length} 家）</div>
          {(listError || listData?.success === false) && <div role="alert" className="text-xs text-red-500">{listData?.error || '公司加载失败'}</div>}
        </div>

        {adding && (
          <div className="p-3 border-b border-gray-100 space-y-2 bg-gray-50">
            <Input size="small" placeholder="公司名称" value={newName}
              onChange={e => setNewName(e.target.value)} autoFocus />
            <Input size="small" placeholder="域名（可选）" value={newDomain}
              onChange={e => setNewDomain(e.target.value)} />
            <div className="flex gap-1">
              <Button size="small" type="primary" loading={upsertMut.isPending}
                disabled={!newName.trim()} onClick={addCompany}>创建</Button>
              <Button size="small" onClick={() => { setAdding(false); setNewName(""); setNewDomain(""); }}>取消</Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {isLoading ? <Card loading /> :
            companies.length === 0 ? <Empty description="暂无公司" image={Empty.PRESENTED_IMAGE_SIMPLE} /> :
            companies.map(c => (
              <div key={c.id}
                className={`px-4 py-2.5 cursor-pointer border-b border-gray-50 hover:bg-gray-50 transition-colors ${selectedId === c.id ? "bg-violet-50 border-l-2 border-l-violet-400" : ""}`}
                onClick={() => setSelectedId(c.id)}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-800 truncate flex-1">{c.name}</span>
                  <Tag className="text-[10px]">{c.contactCount}人</Tag>
                </div>
                {c.domain && <div className="text-[10px] text-gray-400 truncate">{c.domain}</div>}
                <div className="flex gap-3 text-[10px] text-gray-400 mt-0.5">
                  {c.country && <span><EnvironmentOutlined className="text-[9px]" /> {c.country}</span>}
                  <span>发 {c.sentCount ?? '—'}</span>
                  <span>回 {c.repliedCount ?? '—'}</span>
                </div>
              </div>
            ))
          }
        </div>

        {/* 分页 */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-center gap-2 p-2 border-t border-gray-100">
            <Button size="small" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</Button>
            <span className="text-[11px] text-gray-400">
              {page} / {Math.ceil(total / PAGE_SIZE)}
            </span>
            <Button size="small" disabled={page * PAGE_SIZE >= total} onClick={() => setPage(p => p + 1)}>下一页</Button>
          </div>
        )}
      </div>

      {/* ═══ 右侧公司详情 ═══ */}
      <div className="flex-1 bg-white border border-gray-200 rounded-lg flex flex-col overflow-hidden">
        {detailData?.success === false && <div role="alert" className="text-xs text-red-500 p-3">{detailData.error || '公司详情加载失败'}</div>}
        {!selectedId ? (
          <div className="flex-1 flex items-center justify-center">
            <Empty description="选择左侧公司查看详情" />
          </div>
        ) : detail ? (
          <>
            {/* 头部 */}
            <div className="p-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
              <div>
                <h2 className="text-lg font-bold text-gray-800 m-0">{detail.company.name}</h2>
                {detail.company.domain && <span className="text-xs text-gray-400">{detail.company.domain}</span>}
              </div>
              <Space>
                <Popconfirm title={`确定删除 ${detail.company.name}？`}
                  onConfirm={() => deleteMut.mutate(detail.company.id)}>
                  <Button size="small" danger disabled={!!dataPort && (!dataPort.delete || !detail.canDelete)} icon={<DeleteOutlined />}>删除</Button>
                </Popconfirm>
              </Space>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {/* 可编辑字段 */}
              <div className="grid grid-cols-2 gap-3">
                {([
                  { label: "国家", field: "country" },
                  { label: dataPort ? "业务类型" : "行业", field: "industry" },
                  ...(dataPort ? [{label:"客户类型",field:"customerType"},{label:"网站",field:"domain"}] : []),
                  { label: "规模", field: "size" },
                ]).map(row => {
                  const val = String((detail.company as Record<string, unknown>)[row.field] || "");
                  const editing = editingField === row.field && (!dataPort || detail.canEdit);
                  return (
                    <div key={row.field} className="flex items-center gap-2 text-xs">
                      <span className="w-16 shrink-0 text-gray-400">{row.label}</span>
                      {editing ? (
                        <div className="flex gap-1 flex-1">
                          <Input size="small" value={editVal}
                            onChange={e => setEditVal(e.target.value)} autoFocus
                            onPressEnter={() => saveField(row.field, editVal)}
                            onKeyDown={e => { if (e.key === "Escape") setEditingField(null); }}
                          />
                          <Button type="text" size="small" icon={<SaveOutlined />}
                            onClick={() => saveField(row.field, editVal)} />
                          <Button type="text" size="small" icon={<CloseOutlined />}
                            onClick={() => setEditingField(null)} />
                        </div>
                      ) : (
                        <span className={`flex-1 text-gray-600 rounded px-1 py-0.5 ${!dataPort || detail.canEdit ? "cursor-pointer hover:bg-gray-50" : ""}`}
                          onClick={() => { if (dataPort && !detail.canEdit) return; setEditingField(row.field); setEditVal(val); }}>
                          {val || "—"}
                          {(!dataPort || detail.canEdit) && <EditOutlined className="text-[9px] text-gray-300 ml-1 opacity-0 hover:opacity-100" />}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* 统计 */}
              <div className="flex gap-4">
                <div className="bg-gray-50 rounded-lg px-4 py-2 text-center">
                  <div className="text-lg font-bold text-gray-800">{detail.contacts.length}</div>
                  <div className="text-[10px] text-gray-400">联系人</div>
                </div>
                <div className="bg-blue-50 rounded-lg px-4 py-2 text-center">
                  <div className="text-lg font-bold text-blue-700">{detail.sentCount ?? '—'}</div>
                  <div className="text-[10px] text-gray-400">已发送</div>
                </div>
                <div className="bg-green-50 rounded-lg px-4 py-2 text-center">
                  <div className="text-lg font-bold text-green-700">{detail.repliedCount ?? '—'}</div>
                  <div className="text-[10px] text-gray-400">已回复</div>
                </div>
              </div>

              {/* 联系人列表 */}
              <div>
                <h3 className="text-xs font-semibold text-gray-500 uppercase mb-2">
                  联系人 ({detail.contacts.length})
                </h3>
                {detail.contacts.length === 0 ? (
                  <div className="text-[11px] text-gray-300 py-4 text-center">暂无联系人</div>
                ) : (
                  <div className="space-y-0.5 border border-gray-200 rounded-lg overflow-hidden">
                    {detail.contacts.map(c => (
                      <div key={c.id} className="flex items-center gap-3 px-3 py-2 border-b border-gray-50 last:border-b-0 hover:bg-gray-50 text-xs">
                        <span className="font-medium w-24 truncate">
                          {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                        </span>
                        <span className="font-mono text-[11px] text-blue-600 flex-1 truncate">{c.email}</span>
                        {c.title && <span className="text-[10px] text-gray-400">{c.title}</span>}
                        {c.phone && <span className="text-[10px] text-gray-500 font-mono">{c.phone}</span>}
                        {c.stage && STAGE_LABELS[c.stage] && (
                          <Tag color={STAGE_LABELS[c.stage]!.color} className="text-[9px] leading-none px-1">
                            {STAGE_LABELS[c.stage]!.label}
                          </Tag>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <Card loading className="flex-1" />
        )}
      </div>
    </div>
  );
}
