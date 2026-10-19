import type { NavigatorResult, NavigatorStatus, NavigatorOptions, NavigatorChoice } from "../../../shared/navigator";
import { useEffect, useState } from "react";
import { Button, Descriptions, Drawer, Image, Select, Space, Table, Tag, Tooltip, App as AntApp } from "antd";
import { DollarOutlined, GlobalOutlined } from "@ant-design/icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface QuoteDto {
  podRaw: string; lane: string | null; carrier: string | null; container: string | null;
  oceanUsd: number | null; validFrom: string | null; validTo: string | null;
  pol: string | null; note: string | null; sourceGroup: string | null; msgTime: string | null;
  validityRaw: string | null; freeDays: string | null; shortfallFee: string | null; sender: string | null;
  imageUrl: string | null;
}

interface IpcResult<T> { success: boolean; data?: T; error?: string }

const CONTAINERS = ["20GP", "40HQ/HC", "40NOR", "45HQ/HC"];
const RATE_PAGE_CAP = 300;
const TABLE_PAGE_SIZE = 50;
const TOAST_SECONDS = 2;
const BEIJING_OFFSET_MS = 8 * 3600_000;

/** 柜型色标：固定映射到归一化后的柜型值，扫表时一眼分桶 */
const CONTAINER_COLORS: Record<string, string> = {
  "20GP": "blue",
  "40GP": "cyan",
  "40HQ": "green",
  "NOR": "orange",
  "40GP+40HQ": "geekblue",
};

function fmtMsgTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 有效期紧凑格式（列表用，年份无信息量且挤占列宽）：
 *  同月 1-7 Sep；跨月 31 Aug – 6 Sep；单边只显一天；hover 出完整日期 */
function fmtValidity(from: string | null, to: string | null): string {
  const d = (s: string | null) => {
    const mt = /^\d{4}-(\d{2})-(\d{2})$/.exec(s || "");
    return mt ? { mo: Number(mt[1]), dy: Number(mt[2]) } : null;
  };
  const a = d(from), b = d(to);
  const tag = (x: { mo: number; dy: number }) => `${x.dy} ${MONTHS_EN[x.mo - 1]}`;
  if (a && b) return a.mo === b.mo ? `${a.dy}-${b.dy} ${MONTHS_EN[a.mo - 1]}` : `${tag(a)} – ${tag(b)}`;
  if (a) return tag(a);
  if (b) return tag(b);
  return "—";
}

/**
 * 运价库：以 Navigator 账号实时查询，查询记录归属于登录用户。
 */
export function RateBoard() {
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [container, setContainer] = useState<string[]>([]);
  const [podInput, setPodInput] = useState<string[]>([]);
  const [polInput, setPolInput] = useState<string[]>([]);
  const [laneInput, setLaneInput] = useState("");
  const [carrierInput, setCarrierInput] = useState("");
  const [filters, setFilters] = useState<Record<string, unknown> | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [imagePending, setImagePending] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  /** 详情抽屉的当前行（船司/POL/POD/柜型/海运费/有效期之外的信息都收在这里） */
  const [detail, setDetail] = useState<QuoteDto | null>(null);

  const { data: statusData } = useQuery({
    queryKey: ["rates", "navigatorStatus"],
    queryFn: () => window.api.invoke("rates:navigatorStatus") as Promise<NavigatorResult<NavigatorStatus>>,
    refetchOnWindowFocus: false,
  });
  const st = statusData?.ok ? statusData.data : null;
  const [previewVisible, setPreviewVisible] = useState(false);
  const { data: optionsData, isFetching: optionsPending, error: optionsError } = useQuery({
    queryKey: ["rates", "options", st?.user?.user_id],
    queryFn: async () => {
      const result = await window.api.invoke("rates:options") as NavigatorResult<NavigatorOptions>;
      if (!result.ok || !result.data) throw new Error(result.error || "匹配候选读取失败");
      return result.data;
    },
    enabled: !!st?.authenticated, retry: false,
  });
  const choices = (items: NavigatorChoice[]) => items.map(item => ({
    value: item.n, label: item.c || item.l ? `${item.n} · ${item.c || item.l}` : item.n,
    search: [item.n,item.c,item.e,item.a,item.l].filter(Boolean).join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(),
  }));
  const ports = (side: "pol" | "pod") => choices([
    ...(optionsData?.ports || []).filter(item => !item.k || item.k === side || item.k === "both"),
    ...(optionsData?.portGroups || []).filter(item => item.k === side || item.k === "both"),
  ]);
  const filterChoice = (input: string, option?: {search?: string}) => !!option?.search?.includes(input.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase());
  const { data, isFetching: isLoading, refetch, error } = useQuery({
    queryKey: ["rates", "list", st?.user?.user_id, filters],
    queryFn: async () => {
      const result = await window.api.invoke("rates:list", filters) as IpcResult<QuoteDto[]>;
      if (!result.success) throw new Error(result.error || "查询失败");
      return result;
    },
    enabled: !!filters && !!st?.authenticated,
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false, staleTime: Infinity,
  });
  const clearView = () => { setFilters(null); setDetail(null); setImage(null); setPreviewVisible(false); qc.removeQueries({queryKey:["rates", "list"]}); qc.removeQueries({queryKey:["rates", "options"]}); };
  useEffect(() => window.api.on("navigator:identityChanged", () => {
    clearView();
    void qc.invalidateQueries({queryKey:["rates", "navigatorStatus"]});
  }), [qc]);
  useEffect(() => { if (error) message.error(error.message, TOAST_SECONDS); }, [error, message]);
  useEffect(() => {
    let active = true;
    setImage(null);
    setPreviewVisible(false);
    setImageError(null);
    setImagePending(!!detail?.imageUrl);
    if (detail?.imageUrl) {
      void window.api.invoke("rates:image", detail.imageUrl).then(value => {
        const result = value as NavigatorResult<string>;
        if (active && result.ok) setImage(result.data || null);
        if (active && !result.ok) setImageError(result.error || "截图读取失败");
        if (active) setImagePending(false);
      }).catch(() => { if (active) { setImagePending(false); setImageError("截图连接失败，请稍后重试"); } }); // Transport failure is shown inline below.
    }
    return () => { active = false; };
  }, [detail]);
  const authMut = useMutation({
    mutationFn: (logout: boolean) => window.api.invoke(logout ? "rates:navigatorLogout" : "rates:navigatorLogin") as Promise<NavigatorResult<NavigatorStatus>>,
    onSuccess: result => {
      clearView();
      if (!result.ok) message.error(result.error || "授权失败", TOAST_SECONDS);
      void qc.invalidateQueries({queryKey:["rates", "navigatorStatus"]});
    },
  });
  const search = () => {
    if (!st?.authenticated) { message.info("请先登录 Navigator 后查价", TOAST_SECONDS); return; }
    const next = { match: "web", route: laneInput || undefined, carrier: carrierInput || undefined,
      pol: polInput.join(",") || undefined, pod: podInput.join(",") || undefined, ctype: container.join(",") || undefined, limit: RATE_PAGE_CAP };
    if (JSON.stringify(next) === JSON.stringify(filters)) void refetch();
    else setFilters(next);
  };
  /** 台账工作台：主进程先探测局域网可达再开浏览器；探测最长 3 秒，按钮期间转 loading */
  const boardMut = useMutation({
    mutationFn: () => window.api.invoke("rates:openBoard") as Promise<IpcResult<void>>,
    onSuccess: (r) => { if (!r?.success) message.error(r?.error || "网络出错"); },
    onError: () => message.error("网络出错"),
  });

  const rows = data?.success ? data.data || [] : [];

  const today = new Date(Date.now() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);

  return (
    <div className="prospector-table-page rate-board-page">
      {/* 页头 */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Space>
          <h2 className="text-lg font-bold text-gray-800 m-0">
            <DollarOutlined className="text-emerald-600 mr-1" />运价库
          </h2>
          <span className="text-[12px] text-gray-400">
            {st?.authenticated ? `${st.user?.display_name || st.user?.name} · 实时查询` : "使用 Navigator 账号查价"}
          </span>
          {!statusData?.ok && statusData?.error && <Tag color="red">{statusData.error}</Tag>}
        </Space>
        <Space>
          <Button size="small" icon={<GlobalOutlined />} loading={boardMut.isPending}
            onClick={() => boardMut.mutate()}>台账工作台</Button>
          <Button size="small" loading={authMut.isPending}
            onClick={() => authMut.mutate(!!st?.authenticated)}>{st?.authenticated ? "退出账号" : "登录 Navigator"}</Button>
        </Space>
      </div>

      {/* 筛选栏：与表格列同序（船司→起运港→目的港→柜型→航线） */}
      <div className="flex items-center gap-2 flex-wrap bg-white border border-gray-200 rounded-lg px-3 py-2">
        <Select size="small" aria-label="船司匹配" placeholder="船司" allowClear showSearch filterOption={filterChoice}
          options={choices(optionsData?.carriers || [])} loading={optionsPending} style={{ width: 160 }} value={carrierInput || undefined} onChange={v => setCarrierInput(v || "")} />
        <Select size="small" aria-label="起运港匹配" mode="multiple" placeholder="起运港" allowClear showSearch filterOption={filterChoice}
          options={ports("pol")} loading={optionsPending} style={{ minWidth: 180 }} value={polInput} onChange={setPolInput} />
        <Select size="small" aria-label="目的港匹配" mode="multiple" placeholder="目的港（从匹配候选中选择）" allowClear showSearch filterOption={filterChoice}
          options={ports("pod")} loading={optionsPending} style={{ minWidth: 240 }} value={podInput} onChange={setPodInput} />
        <Select size="small" placeholder="柜型" mode="multiple" allowClear style={{ minWidth: 160 }}
          value={container} onChange={v => setContainer(v)}
          options={CONTAINERS.map(c => ({ value: c, label: c }))} />
        <Select size="small" aria-label="航线匹配" placeholder="航线" allowClear showSearch filterOption={filterChoice}
          options={choices(optionsData?.routes || [])} loading={optionsPending} style={{ width: 160 }} value={laneInput || undefined} onChange={v => setLaneInput(v || "")} />
        <Button size="small" type="primary" loading={isLoading} onClick={search}>查价</Button>
        {rows.length >= RATE_PAGE_CAP && (
          <span className="text-[10px] text-amber-600">按入库时间倒序最多显示前 {RATE_PAGE_CAP} 条，请细化筛选</span>
        )}
      </div>

      {/* 运价表：主表只放一眼要用的六列，其余信息与报价截图收进「详情」抽屉 */}
      {optionsError && <div className="text-xs text-red-600">{optionsError.message}</div>}
      <Table
        className="prospector-page-table rate-board-table"
        dataSource={rows}
        rowKey={(r: QuoteDto, i?: number) => `${i ?? 0}|${r.podRaw}|${r.carrier}|${r.container}|${r.validFrom}|${r.sourceGroup}|${r.msgTime}`}
        loading={isLoading}
        size="small"
        pagination={{ pageSize: TABLE_PAGE_SIZE, showSizeChanger: false, size: "small", showTotal: t => `${t} 条` }}
        columns={[
          { title: "船司", dataIndex: "carrier", key: "carrier", width: 80, align: "center", ellipsis: { showTitle: false },
            render: (v: string | null) => v
              ? <Tooltip title={v} placement="top"><span className="text-xs font-bold text-gray-800 block truncate">{v}</span></Tooltip>
              : "—" },
          { title: "起运港", dataIndex: "pol", key: "pol", width: 110, align: "left", ellipsis: { showTitle: false },
            render: (v: string | null) => v
              ? <Tooltip title={v} placement="topLeft"><span className="text-xs text-gray-700 block truncate">{v}</span></Tooltip>
              : "—" },
          {
            title: "目的港", dataIndex: "podRaw", key: "pod", width: 200, align: "left", ellipsis: { showTitle: false },
            render: (v: string, r: QuoteDto) => (
              <Tooltip title={r.lane ? `${v}（${r.lane}）` : v} placement="topLeft">
                <span className="text-xs font-medium text-gray-800 block truncate">{v}</span>
              </Tooltip>
            ),
          },
          { title: "柜型", dataIndex: "container", key: "container", width: 110, align: "center", ellipsis: { showTitle: false },
            render: (v: string | null) => v
              ? <Tooltip title={v} placement="top"><Tag color={CONTAINER_COLORS[v] || "purple"} className="text-[10px] !max-w-full overflow-hidden text-ellipsis">{v}</Tag></Tooltip>
              : <span className="text-[10px] text-gray-300">未填</span> },
          {
            title: "海运费", key: "usd", width: 90, align: "center",
            sorter: (a: QuoteDto, b: QuoteDto) => (a.oceanUsd ?? 0) - (b.oceanUsd ?? 0),
            render: (_: unknown, r: QuoteDto) => r.oceanUsd != null
              ? <span className="text-xs font-mono font-semibold text-gray-800">${r.oceanUsd}</span>
              : <span className="text-[10px] text-gray-300">议价</span>,
          },
          {
            title: "有效期", key: "valid", width: 110, align: "center",
            render: (_: unknown, r: QuoteDto) => {
              if (!r.validFrom && !r.validTo) return <span className="text-[10px] text-gray-300">—</span>;
              const expired = r.validTo && r.validTo < today;
              const full = `${r.validFrom || "?"} ~ ${r.validTo || "?"}${expired ? "（已过期）" : ""}`;
              return (
                <Tooltip title={full}>
                  <span className={`text-[11px] whitespace-nowrap cursor-default ${expired ? "text-red-400 line-through" : "text-gray-600"}`}>
                    {fmtValidity(r.validFrom, r.validTo)}
                  </span>
                </Tooltip>
              );
            },
          },
          { title: "消息时间", dataIndex: "msgTime", key: "time", width: 92, align: "center",
            render: (v: string | null) => <span className="text-[10px] text-gray-400 whitespace-nowrap">{fmtMsgTime(v)}</span> },
          {
            title: "", key: "go", width: 52, align: "center",
            render: (_: unknown, r: QuoteDto) => (
              <Button size="small" type="link" className="!px-0 text-[11px]" onClick={() => setDetail(r)}>详情</Button>
            ),
          },
        ]}
        tableLayout="fixed"
        scroll={{ x: 844 }}
      />

      {/* 详情抽屉：航线/有效期原文/免箱/亏舱费/来源/备注 + 报价截图（board_server /images 静态服务） */}
      <Drawer
        rootClassName="app-drawer-below-titlebar"
        title={detail ? `${detail.carrier || "—"} · ${detail.pol || "?"} → ${detail.podRaw} · ${detail.container || "—"}` : ""}
        open={!!detail}
        closable={false}
        onClose={() => setDetail(null)}
        width={560}
      >
        {detail && (
          <div className="space-y-3">
            <Descriptions size="small" column={1} bordered
              items={[
                { key: "usd", label: "海运费", children: detail.oceanUsd != null ? <b className="font-mono">${detail.oceanUsd}</b> : "议价" },
                { key: "valid", label: "有效期", children: [detail.validFrom, detail.validTo].filter(Boolean).join(" ~ ") || "—" },
                { key: "validRaw", label: "有效期原文", children: detail.validityRaw || "—" },
                { key: "lane", label: "航线", children: detail.lane || "—" },
                { key: "free", label: "免箱天数", children: detail.freeDays || "—" },
                { key: "short", label: "亏舱费", children: detail.shortfallFee || "—" },
                { key: "src", label: "来源群", children: detail.sourceGroup || "—" },
                { key: "sender", label: "报价人", children: detail.sender || "—" },
                { key: "time", label: "消息时间", children: fmtMsgTime(detail.msgTime) },
                { key: "note", label: "备注", children: detail.note || "—" },
              ]}
            />
            {detail.imageUrl ? (
              <div>
                <div className="text-[11px] text-gray-400 mb-1">报价截图</div>
                {image ? <Image
                  src={image || undefined}
                  alt="报价截图"
                  className="w-full rounded-lg border border-gray-200"
                  width="100%"
                  preview={{ visible: previewVisible, onVisibleChange: setPreviewVisible }}
                  onError={() => {
                    setImage(null);
                    setImageError("截图文件无法显示，可能已损坏或格式不支持");
                  }}
                /> : <div className="text-[11px] text-gray-400 py-2">{imagePending ? "截图读取中…" : imageError || "截图暂不可用"}</div>}
              </div>
            ) : (
              <div className="text-[11px] text-gray-300">这条记录没有关联报价截图</div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
