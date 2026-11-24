import { invalidateDomain } from "../../lib/cacheDeps";
import { DEFAULT_CRM_OVERDUE_DAYS, DEFAULT_CRM_WARN_DAYS, MAX_CRM_THRESHOLD_DAYS } from "../../../shared/crm";
import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card, Input, InputNumber, Button, message, notification, Table, Modal, Form, Tag, Space,
  Switch, Tooltip, Badge, Popconfirm, Select, Segmented,
} from "antd";
import { DeleteOutlined, CheckCircleOutlined, EditOutlined, DownloadOutlined, SyncOutlined, FolderOpenOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { RichTextEditor } from "../../components/RichTextEditor";
import { toolLabelText, useToolMetaVersion } from "../../lib/tool-meta";
import { CONVS_CHANGED } from "../../lib/agent-route";
import type { NavigatorResult, NavigatorStatus } from "../../../shared/navigator";
import { DEFAULT_MAIL_SERVERS } from "../../../shared/mail-defaults";
import { applyWorkspaceDark, workspaceDarkEnabled } from '../../lib/workspace-preferences';

interface EmailAccount {
  id: number; email: string; provider: string;
  smtpHost: string | null; smtpPort: number | null;
  imapHost: string | null; imapPort: number | null;
  displayName: string | null; signature: string | null;
  consecutiveFails: number; isActive: number;
  /** 发信熔断：开启时刻 / 自动过期时刻 / 原因（sender_block=服务商拦截退信驱动，smtp_fail=连续发送失败） */
  circuitOpenAt: string | null; circuitResetAfter: string | null; circuitReason: string | null;
  lastFetchError: string | null; lastFetchAt: string | null; fetchFailCount: number;
}

/** 熔断是否仍在生效期（与主进程 isCircuitOpen 同口径：circuit_reset_after 优先，兜底 24h） */
function circuitOpenOf(a: EmailAccount, now = Date.now()): boolean {
  if (!a.circuitOpenAt) return false;
  const opened = Date.parse(a.circuitOpenAt);
  if (!Number.isFinite(opened)) return false;
  const until = a.circuitResetAfter ? Date.parse(a.circuitResetAfter) : opened + 24 * 60 * 60 * 1000;
  return Number.isFinite(until) && now < until;
}

interface SendSchedule {
  timeWindowEnabled: boolean; startHour: number; endHour: number;
  groupSize: number;
  groupDelayMinSeconds: number; groupDelayMaxSeconds: number;
}

interface RuntimeConfig {
  general?: { closeAction?: "tray" | "quit"; autoLaunch?: boolean };
  sendQuota?: { dailyLimit: number; firstSendAt: string | null; sentToday: number };
  fromName: string;
  schedule: SendSchedule;
  test: { email: string; company: string; enabled: boolean; dryRun: boolean };
  crm: { followupDays: Record<string, number>; todoAdvanceDays: number; autoArchiveDays: number; silentOverdueDays?: number; warnDays?: number };
}

// ── 右侧浮动导航分区 ──
const SECTIONS = [
  { id: "sec-general", label: "通用" },
  { id: "sec-mail", label: "邮件发送" },
  { id: "sec-advanced", label: "高级" },
  { id: "sec-about", label: "关于" },
];

// ── 内联编辑行（点击变输入，自动保存）──
function SettingRow({ label, value, onSave, type = "text", placeholder, required, hint, disabled }: {
  label: string; value: string | number; onSave: (v: string | number) => void;
  type?: "text" | "number"; placeholder?: string; required?: boolean; hint?: string; disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value ?? ""));
  const inputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");

  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);

  const commit = async () => {
    setEditing(false);
    if (val === String(value ?? "")) return;
    setSaving("saving");
    try {
      await onSave(type === "number" ? Number(val) : val);
      setSaving("saved");
      setTimeout(() => setSaving("idle"), 2000);
    } catch { setSaving("error"); setTimeout(() => setSaving("idle"), 2000); }
  };

  return (
    <div className="settings-row group">
      <label className="settings-row-label">
        {label}{required && <span className="text-red-500 ml-0.5">·</span>}
      </label>
      {editing ? (
        <input
          ref={inputRef}
          autoFocus
          type={type === "number" ? "number" : "text"}
          value={val}
          onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") { setVal(String(value ?? "")); setEditing(false); }
          }}
          className="flex-1 px-2 py-1 text-xs border border-gray-300 rounded outline-none focus:border-teal-400"
        />
      ) : disabled ? (
        <span className="settings-row-value text-gray-300 truncate cursor-not-allowed">
          {value !== null && value !== undefined && value !== "" ? String(value) : "未启用"}
        </span>
      ) : (
        <span
          className="settings-row-value text-gray-700 cursor-pointer truncate"
          onClick={() => setEditing(true)}
        >
          {value !== null && value !== undefined && value !== "" ? String(value) : placeholder || "未设置"}
        </span>
      )}
      <div className="settings-row-tail">
        {hint && <span className="text-gray-400">{hint}</span>}
        {saving === "saving" && <span className="text-amber-500">…</span>}
        {saving === "saved" && <span className="text-green-500">✓</span>}
        {saving === "error" && <span className="text-red-500">✗</span>}
      </div>
    </div>
  );
}

// ── 范围输入（min~max 双框，自动保存）──
function RangeRow({ label, min, max, onSaveMin, onSaveMax, hint }: {
  label: string; min: number; max: number;
  onSaveMin: (v: number) => void; onSaveMax: (v: number) => void;
  hint: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editingField, setEditingField] = useState<"min" | "max" | null>(null);
  const [val, setVal] = useState("");
  const [saving, setSaving] = useState<"idle" | "saved">("idle");

  const startEdit = (field: "min" | "max") => {
    setEditing(true);
    setEditingField(field);
    setVal(String(field === "min" ? min : max));
  };

  const commit = async () => {
    if (!editingField) return;
    const n = Number(val);
    if (!isNaN(n) && n >= 0) {
      if (editingField === "min") onSaveMin(n);
      else onSaveMax(n);
      setSaving("saved");
      setTimeout(() => setSaving("idle"), 1500);
    }
    setEditing(false);
    setEditingField(null);
  };

  const displayVal = (v: number) => (editing && editingField === "min" ? val : String(v));

  return (
    <div className="settings-row">
      <label className="settings-row-label">{label}</label>
      <div className="settings-row-value flex items-center gap-1 text-xs">
        <input
          value={editingField === "min" ? val : String(min)}
          onChange={e => { if (editingField === "min") setVal(e.target.value); }}
          onFocus={() => startEdit("min")}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-12 px-1 py-0.5 text-center border rounded outline-none focus:border-teal-400 cursor-pointer"
        />
        <span className="text-gray-400">~</span>
        <input
          value={editingField === "max" ? val : String(max)}
          onChange={e => { if (editingField === "max") setVal(e.target.value); }}
          onFocus={() => startEdit("max")}
          onBlur={commit}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          className="w-12 px-1 py-0.5 text-center border rounded outline-none focus:border-teal-400 cursor-pointer"
        />
      </div>
      <div className="settings-row-tail">
        <span className="text-gray-400">{hint}</span>
        {saving === "saved" && <span className="text-green-500">✓</span>}
      </div>
    </div>
  );
}

// ── 分区卡片 ──
function SettingCard({ id, icon, title, required, children, status }: {
  id?: string; icon?: React.ReactNode; title: string; required?: boolean; children: React.ReactNode; status?: React.ReactNode;
}) {
  return (
    <div id={id} className={`settings-group ${required ? "is-required" : ""}`}>
      <div className="settings-group-heading">
        <h3>
          {icon ? <span className="opacity-50">{icon}</span> : null} {title}
        </h3>
        <span>{status}</span>
      </div>
      <div className="settings-group-body">{children}</div>
    </div>
  );
}

function SettingsPanel({ id, title, description, children }: {
  id: string; title: string; description?: string; children: React.ReactNode;
}) {
  return <section id={id} className="settings-section settings-panel">
    <header className="settings-panel-heading">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
    </header>
    <div className="settings-panel-body">{children}</div>
  </section>;
}

function ControlRow({ label, hint, children }: {
  label: string; hint?: React.ReactNode; children: React.ReactNode;
}) {
  return <div className="settings-row">
    <span className="settings-row-label">{label}</span>
    <div className="settings-row-value">{children}</div>
    {hint && <div className="settings-row-hint">{hint}</div>}
  </div>;
}

// ── 运价台账：用户授权后实时查询 ──
function RatesSourceCard() {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [partnerKey, setPartnerKey] = useState("");
  const [partnerBusy, setPartnerBusy] = useState(false);
  const { data: config } = useQuery({
    queryKey: ["rates", "config"],
    queryFn: () => window.api.invoke("system:getConfig") as Promise<{ success: boolean; data?: { rates?: { url?: string } } }>,
  });
  useEffect(() => { if (config?.success) setUrl(config.data?.rates?.url || ""); }, [config]);
  const { data: st } = useQuery({
    queryKey: ["rates", "navigatorStatus"],
    queryFn: () => window.api.invoke("rates:navigatorStatus") as Promise<NavigatorResult<NavigatorStatus>>,
  });
  const { data: partner } = useQuery({
    queryKey: ["rates", "partnerStatus"],
    queryFn: () => window.api.invoke("rates:partnerStatus") as Promise<{ configured: boolean; baseUrl: string | null }>,
  });
  const save = async () => {
    setBusy(true);
    try {
      const result = await window.api.invoke("system:updateConfig", { rates: { url: url.trim() } }) as { success: boolean; error?: string };
      if (!result.success) { message.error(result.error || "地址保存失败"); return; }
      message.success("Navigator 地址已保存", 2);
      await qc.invalidateQueries({ queryKey: ["rates"] });
    } catch { message.error("地址保存失败，请检查应用连接", 2); }
    finally { setBusy(false); }
  };
  const ensurePartner = async () => {
    setPartnerBusy(true);
    try {
      const result = await window.api.invoke("rates:partnerEnsure") as { ok: boolean; error?: string };
      if (!result.ok) { message.error(result.error || "自动获取 Navigator 接口凭证失败"); return; }
      message.success("已自动获取 Navigator 接口凭证", 2);
      await qc.invalidateQueries({ queryKey: ["rates"] });
    } finally { setPartnerBusy(false); }
  };
  const savePartnerKey = async () => {
    if (!partnerKey.trim()) return;
    setPartnerBusy(true);
    try {
      const result = await window.api.invoke("rates:partnerSave", partnerKey.trim()) as { ok: boolean; error?: string };
      if (!result.ok) { message.error(result.error || "接口凭证无效"); return; }
      setPartnerKey(''); message.success("Navigator 接口凭证已保存", 2);
      await qc.invalidateQueries({ queryKey: ["rates"] });
    } finally { setPartnerBusy(false); }
  };
  const clearPartnerKey = async () => {
    setPartnerBusy(true);
    try {
      await window.api.invoke("rates:partnerClear");
      message.success("已移除 Navigator 接口凭证", 2);
      await qc.invalidateQueries({ queryKey: ["rates"] });
    } finally { setPartnerBusy(false); }
  };

  return (
    <SettingCard icon="" title="运价台账"
      status={st?.ok
        ? <Tag color={st.data?.authenticated ? "green" : "orange"}>{st.data?.authenticated ? "已登录" : "未登录"}</Tag>
        : <Tag color={st ? "orange" : undefined}>{st ? "连接待配置" : "检查中"}</Tag>}>
      <div className="text-[11px] text-gray-400 mb-2">
        使用 Navigator 账号授权后实时查价，查询记录归属当前账号。私有局域网 IP 支持 HTTP，公网地址使用 HTTPS。
      </div>
      <div className="flex items-center gap-2">
        <Input size="small" aria-label="Navigator 服务地址" placeholder="http://192.168.190.244:8795" value={url} onChange={e => setUrl(e.target.value)} onPressEnter={() => { if (url.trim()) void save(); }} />
        <Button size="small" loading={busy} disabled={!url.trim()} onClick={() => void save()}>保存地址</Button>
      </div>
      <div className="mt-2 text-[11px] text-gray-400">
        {st?.ok ? `当前服务：${st.data?.baseUrl || "—"}` : st?.error}
        {st?.data?.user ? ` · ${st.data.user.display_name || st.data.user.name}` : ""}
      </div>
      <div className="mt-3 border-t border-gray-100 pt-3">
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <span>接口凭证</span>
          <Tag color={partner?.configured ? "green" : "orange"}>{partner?.configured ? "已连接" : "未获取"}</Tag>
          <Button size="small" type="text" loading={partnerBusy} onClick={() => void ensurePartner()}>自动获取</Button>
          {partner?.configured && <Button size="small" type="text" danger onClick={() => void clearPartnerKey()}>移除</Button>}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Input.Password size="small" aria-label="Navigator 接口凭证" placeholder="获取失败时手动填写 nav_sec_..." value={partnerKey} onChange={event => setPartnerKey(event.target.value)} onPressEnter={() => void savePartnerKey()} />
          <Button size="small" loading={partnerBusy} disabled={!partnerKey.trim()} onClick={() => void savePartnerKey()}>保存凭证</Button>
        </div>
      </div>
    </SettingCard>
  );
}

// ── 版本管理器 ──
interface ReleaseInfo {
  version: string; name: string; publishedAt: string;
  prerelease: boolean; htmlUrl: string; body: string; isCurrent: boolean;
}

interface VersionListData {
  currentVersion: string;
  channel: "stable" | "prerelease";
  releases: ReleaseInfo[];
}

/** electron-updater 的英文报错翻成人话——界面上不再出现 "Please check update first" 这类看不懂的灰字 */
const UPDATE_ERR_CN: Array<[RegExp, string]> = [
  [/please check update first/i, "更新信息未就绪，请稍后再点一次下载"],
  [/already.*download|up.to.date|no update/i, "已是最新版本"],
  [/rate limit|HTTP 403/i, "更新发布源请求受限，请稍后重试"],
  [/404|Not Found/i, "更新仓库未找到，请联系维护者"],
  [/certificate|SSL|TLS|self[- ]signed|unable to verify/i, "网络证书校验失败（企业代理常见），请换网络后重试"],
  [/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|net::|Failed|download/i, "网络不通或超时，稍后重试"],
];
function friendlyUpdateError(msg?: string): string {
  const m = (msg || "").trim();
  if (!m) return "更新失败，请重试";
  for (const [re, cn] of UPDATE_ERR_CN) if (re.test(m)) return cn;
  return "更新失败，详情见日志";
}

function UpdateChecker() {
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");
  const [statusKind, setStatusKind] = useState<"info" | "found" | "ok" | "error">("info");
  const [pendingVersion, setPendingVersion] = useState("");
  const [progress, setProgress] = useState(0);
  const [speedInfo, setSpeedInfo] = useState("");
  const [downloaded, setDownloaded] = useState(false);

  const say = (msg: string, kind: "info" | "found" | "ok" | "error" = "info") => {
    setStatusMsg(msg);
    setStatusKind(kind);
  };

  // 版本数据（仅用于当前版本号与通道展示）
  const [versionData, setVersionData] = useState<VersionListData | null>(null);
  const [channel, setChannel] = useState<"stable" | "prerelease">("stable");

  // 加载当前版本/通道
  const loadVersions = async () => {
    try {
      const r = await window.api.invoke("update:listVersions") as {
        success: boolean; data?: VersionListData; error?: string;
      };
      if (r?.success && r.data) {
        setVersionData(r.data);
        setChannel(r.data.channel);
      }
    } catch { /* 静默 */ }
  };

  // 切换通道
  const handleChannelChange = async (ch: "stable" | "prerelease") => {
    await window.api.invoke("update:setChannel", ch);
    setChannel(ch);
    await loadVersions();
    message.info(`已切换到${ch === "stable" ? "正式版" : "预览版"}通道`);
  };

  useEffect(() => {
    loadVersions();

    // 监听主进程推送的自动更新事件
    const unsub1 = window.api.on("update:available", (data: any) => {
      setPendingVersion(data?.version || "");
      say(`发现新版本 v${data?.version}`, "found");
      loadVersions(); // 刷新列表
    });
    const unsub2 = window.api.on("update:download-progress", (data: any) => {
      setProgress(data?.percent || 0);
      const sizeInfo = data?.total ? `${data.transferred}/${data.total} MB` : `${data.transferred} MB`;
      setSpeedInfo(`${data.percent}% · ${data.speedMB} MB/s · ${sizeInfo}`);
    });
    const unsub3 = window.api.on("update:downloaded", (data: any) => {
      setDownloaded(true);
      setDownloading(false);
      say(`v${data?.version} 已下载，重启后生效`, "ok");
    });
    const unsub4 = window.api.on("update:error", (data: any) => {
      say(friendlyUpdateError(data?.message), "error");
    });
    return () => { unsub1?.(); unsub2?.(); unsub3?.(); unsub4?.(); };
  }, []);

  const handleCheck = async () => {
    setChecking(true);
    say("检查中…");
    try {
      const r = await window.api.invoke("update:check") as {
        success: boolean; data?: { version: string; available: boolean } | null; error?: string;
      };
      if (r?.success && r.data?.version) {
        setPendingVersion(r.data.version);
        say(`发现新版本 v${r.data.version}`, "found");
      } else if (r?.success) {
        say("已是最新版本", "ok");
        setTimeout(() => setStatusMsg(""), 3000);
      } else {
        say(r?.error || "检查失败", "error");
      }
    } catch (e: any) {
      say(friendlyUpdateError(e?.message), "error");
    } finally {
      setChecking(false);
      await loadVersions();
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    setDownloaded(false);
    setProgress(0);
    setSpeedInfo("");
    say("正在下载更新…");
    try {
      const r = await window.api.invoke("update:download") as { success: boolean; error?: string };
      // 整包下完才返回：成功就等 update:downloaded 把状态切成「立即重启安装」
      if (!r?.success) say(friendlyUpdateError(r?.error), "error");
    } catch (e: any) {
      say(friendlyUpdateError(e?.message), "error");
    } finally {
      setDownloading(false);
    }
  };

  const handleInstall = async () => {
    await window.api.invoke("update:install");
  };

  const hasUpdate = pendingVersion && !downloaded;

  return (
    <div className="space-y-3">
      {/* 当前版本 + 通道切换 */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-[11px] text-gray-500">
          当前 <strong className="text-gray-800">{versionData?.currentVersion || "—"}</strong>
        </span>
        <span className="text-[10px] text-gray-300">|</span>
        <div className="flex bg-gray-100 rounded p-px">
          <button
            onClick={() => handleChannelChange("stable")}
            className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${channel === "stable" ? "bg-white shadow-sm text-gray-800 font-medium" : "text-gray-500"}`}
          >正式版</button>
          <button
            onClick={() => handleChannelChange("prerelease")}
            className={`px-2.5 py-0.5 text-[11px] rounded transition-colors ${channel === "prerelease" ? "bg-white shadow-sm text-gray-800 font-medium" : "text-gray-500"}`}
          >预览版</button>
        </div>
      </div>

      {/* 操作按钮 + 状态 */}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="small" icon={<SyncOutlined spin={checking} />} loading={checking} onClick={handleCheck}>
          检查更新
        </Button>
        {statusMsg && (
          <span className={`text-xs ${
            statusKind === "found" ? "text-teal-600"
              : statusKind === "ok" ? "text-green-600"
              : statusKind === "error" ? "text-red-500"
              : "text-gray-400"
          }`}>{statusMsg}</span>
        )}
        {hasUpdate && (
          <Button size="small" type="primary" loading={downloading} onClick={handleDownload}>
            {downloading ? "下载中…" : `下载 v${pendingVersion}`}
          </Button>
        )}
        {downloaded && (
          <Button size="small" danger onClick={handleInstall}>立即重启安装</Button>
        )}
      </div>

      {/* 进度条 */}
      {downloading && (
        <div className="space-y-1">
          <div className="h-1.5 bg-gray-100 rounded overflow-hidden">
            <div className="h-full bg-teal-500 transition-all duration-300 rounded"
              style={{ width: `${progress || 5}%` }} />
          </div>
          <div className="text-[10px] text-gray-400">{speedInfo || "准备下载…"}</div>
        </div>
      )}
    </div>
  );
}

// ── 设置页主组件 ──
// ── AI 活动记录：agent_tool_calls 审计可视化（谁在什么会话里调了什么工具、写操作是否经人工确认）──
interface ToolCallLog {
  id: number;
  conversationId: string;
  toolName: string;
  sideEffect: string;
  argsPreview: string;
  approval: string;
  error: string | null;
  createdAt: string;
}

/** 审计页工具名展示：注册表派生（tool-meta 缓存），不再维护本地清单；
 *  reasoning 是思考伪通道，注册表里没有，本地特判 */
function auditToolLabel(v: string): string {
  return v === "reasoning" ? "思考" : toolLabelText(v);
}

/**
 * 异常红标的「已忽略水位」：agent_tool_calls.id 自增，拿 id 当水位最稳。
 * 刻意放模块级而非组件 state —— 切去别的页面再回来，刚忽略掉的旧异常不该重新亮一次。
 */
let auditIgnoredBelowId = 0;

interface ConversationMeta { id: string; title: string; createdAt: string; updatedAt: string; messageCount: number }

/** 归档会话：侧栏「删除」的会话落在这里。可恢复回侧栏，或彻底删除（不可恢复）。默认收起。 */
function AgentConversationCard() {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["agentArchivedConversations"],
    queryFn: async () => {
      const r = await window.api.invoke("agent:listArchivedConversations") as { success: boolean; data?: ConversationMeta[] };
      return r?.success ? (r.data ?? []) : [];
    },
  });
  const list = data ?? [];

  const invalidate = () => {
    void invalidateDomain(qc, "conversations");
    window.dispatchEvent(new Event(CONVS_CHANGED));   // 侧栏历史同步
  };

  const delMut = useMutation({
    mutationFn: (ids: string[]) => window.api.invoke("agent:deleteConversations", ids) as
      Promise<{ success: boolean; data?: { deleted: number }; error?: string }>,
    onSuccess: (r) => {
      if (!r?.success) { message.error(r?.error || "删除失败"); return; }
      message.success(`已彻底删除 ${r.data?.deleted ?? 0} 条会话`);
      setSelected([]);
      invalidate();
    },
    onError: (e) => message.error(e instanceof Error ? e.message : "删除失败"),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => window.api.invoke("agent:unarchiveConversation", id) as
      Promise<{ success: boolean; error?: string }>,
    onSuccess: (r) => {
      if (!r?.success) { message.error(r?.error || "恢复失败"); return; }
      message.success("已恢复到左侧栏");
      invalidate();
    },
    onError: (e) => message.error(e instanceof Error ? e.message : "恢复失败"),
  });

  const fmt = (iso: string) => (iso || "").replace("T", " ").slice(0, 16);
  const columns = [
    { title: "标题", dataIndex: "title", key: "title", ellipsis: true,
      render: (v: string) => <span className="text-[12px] text-gray-700">{v || "（无标题）"}</span> },
    { title: "消息", dataIndex: "messageCount", key: "messageCount", width: 60, align: "right" as const,
      render: (v: number) => <span className="text-[11px] text-gray-400">{v}</span> },
    { title: "更新时间", dataIndex: "updatedAt", key: "updatedAt", width: 120,
      render: (v: string) => <span className="text-[11px] text-gray-400">{fmt(v)}</span> },
    { title: "", key: "op", width: 70, align: "right" as const,
      render: (_: unknown, row: ConversationMeta) => (
        <button className="text-[11px] text-teal-600 hover:text-teal-700"
          onClick={() => restoreMut.mutate(row.id)}>恢复</button>
      ) },
  ];

  return (
    <SettingCard icon="" title={`归档会话 · ${list.length}`}
      status={<button onClick={() => setOpen(o => !o)} className="text-[11px] text-gray-400 hover:text-gray-600">
        {open ? "收起" : "展开"}
      </button>}>
      <div className="text-[11px] text-gray-400 mb-2">
        左侧栏「删除」的会话都归档在这里：可单条恢复；勾选后彻底删除，或一键清空。彻底删除不可恢复。
      </div>
      {open && (
        <>
          <Table<ConversationMeta>
            className="row-select-table"
            dataSource={list}
            rowKey="id"
            columns={columns}
            size="small"
            loading={isLoading}
            pagination={{ pageSize: 8, hideOnSinglePage: true }}
            rowSelection={{ selectedRowKeys: selected, onChange: keys => setSelected(keys as string[]) }}
            locale={{ emptyText: "归档区是空的 — 左侧栏「删除」的会话会出现在这里" }}
          />
          <div className="pt-2 flex items-center gap-2">
            <Popconfirm title={`彻底删除选中的 ${selected.length} 条会话？删除后不可恢复。`} disabled={!selected.length}
              onConfirm={() => delMut.mutate(selected)}>
              <Button size="small" danger disabled={!selected.length} loading={delMut.isPending}
                icon={<DeleteOutlined />}>彻底删除选中（{selected.length}）</Button>
            </Popconfirm>
            <Popconfirm title={`清空全部 ${list.length} 条归档会话？删除后不可恢复。`} disabled={!list.length}
              onConfirm={() => delMut.mutate(list.map(x => x.id))}>
              <Button size="small" disabled={!list.length} loading={delMut.isPending}>清空归档</Button>
            </Popconfirm>
          </div>
        </>
      )}
    </SettingCard>
  );
}

function AgentAuditCard() {
  /** 明细是排障时才看的，默认收起；收起时连轮询一起停，别白刷库 */
  const [open, setOpen] = useState(false);
  const [, bumpIgnored] = useState(0);   // 忽略动作改的是模块级水位，靠它触发一次重算
  // 工具中文名来自注册表（经 agent:toolMeta）：到达后刷新一次
  useToolMetaVersion();
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["agentToolCalls"],
    queryFn: async () => {
      const r = await window.api.invoke("agent:toolCalls", 60) as { success: boolean; data?: ToolCallLog[] };
      return r?.success ? (r.data ?? []) : [];
    },
    // 收起时也要能发现新异常（否则忽略一次就永远不提醒了），只把频率降下来：读的是本地库 limit 60
    refetchInterval: open ? 30_000 : 120_000,
  });

  const approvalTag = (a: string) =>
    a === "approved" ? <Tag color="green">已批准</Tag>
      : a === "rejected" ? <Tag color="red">已拒绝</Tag>
        : <Tag color="default">自动</Tag>;

  const columns = [
    { title: "时间", dataIndex: "createdAt", key: "createdAt", width: 150,
      render: (v: string) => <span className="text-[11px] text-gray-400">{(v || "").replace("T", " ").slice(0, 19)}</span> },
    { title: "工具", dataIndex: "toolName", key: "toolName", width: 110,
      render: (v: string) => auditToolLabel(v) },
    { title: "副作用", dataIndex: "sideEffect", key: "sideEffect", width: 70,
      render: (v: string) => v === "write" ? <Tag color="orange">写</Tag> : <Tag color="default">读</Tag> },
    { title: "参数摘要", dataIndex: "argsPreview", key: "argsPreview", ellipsis: true,
      render: (v: string) => <span className="text-[11px] text-gray-500">{v || "—"}</span> },
    { title: "确认", dataIndex: "approval", key: "approval", width: 80, render: approvalTag },
    { title: "异常", dataIndex: "error", key: "error", ellipsis: true,
      render: (v: string | null) => v ? <span className="text-[11px] text-red-400">{v}</span> : null },
  ];

  const writes = (data ?? []).filter(d => d.sideEffect === "write").length;
  const errorRows = (data ?? []).filter(d => d.error);
  /** 忽略过的旧异常不再打扰；只有比水位更新的异常才算「新检测到」 */
  const freshErrors = errorRows.filter(d => d.id > auditIgnoredBelowId);
  const ignoreErrors = () => {
    if (!errorRows.length) return;
    auditIgnoredBelowId = Math.max(auditIgnoredBelowId, ...errorRows.map(d => d.id));
    bumpIgnored(n => n + 1);
  };

  /** 诊断包导出：出错时点一下，生成日志+配置快照（密钥已掩码）的 md 发给开发者 */
  const [diag, setDiag] = useState<{ running: boolean; name?: string; path?: string; error?: string }>({ running: false });
  const exportDiag = async () => {
    setDiag({ running: true });
    try {
      const r = await window.api.invoke("agent:exportDiagnostics") as
        { success: boolean; data?: { name: string; path: string }; error?: string };
      setDiag(r?.success && r.data
        ? { running: false, name: r.data.name, path: r.data.path }
        : { running: false, error: r?.error || "导出失败" });
    } catch (e) {
      // invoke 被 reject（如主进程未重启、handler 未注册）也要落地提示，防 loading 永转
      setDiag({ running: false, error: e instanceof Error ? e.message : "导出失败" });
    }
  };

  return (
    <SettingCard icon="" title="AI 活动记录"
      status={<Space size={6}>
        {freshErrors.length > 0 && (
          <Tooltip title="双击忽略这批异常；再检测到新的才会重新提醒">
            <Tag color="red" className="!my-0" style={{ cursor: "pointer" }} onDoubleClick={ignoreErrors}>
              {freshErrors.length} 条异常
            </Tag>
          </Tooltip>
        )}
        <button onClick={() => setOpen(o => !o)} className="text-[11px] text-gray-400 hover:text-gray-600">
          {open ? "收起" : "展开"}
        </button>
      </Space>}>
      <div className="text-[11px] text-gray-400 mb-2">
        最近 {data?.length ?? 0} 次工具调用（其中写操作 {writes} 次，全部经人工确认）
        {open ? "。展开期间 30 秒自动刷新。" : "，点开看明细。"}
      </div>
      {open && (
        <Table<ToolCallLog>
          dataSource={data ?? []}
          rowKey="id"
          columns={columns}
          size="small"
          loading={isLoading}
          pagination={{ pageSize: 8, hideOnSinglePage: true }}
          locale={{ emptyText: "暂无记录 — 聊天查询已停用" }}
        />
      )}
      {open && (
        <div className="pt-2 flex items-center gap-2 flex-wrap">
          <Button size="small" loading={diag.running} onClick={() => { void exportDiag(); }}>导出诊断包</Button>
          {diag.name && (
            <span className="text-[11px] text-gray-400">
              {diag.name}
              <a className="ml-1.5" onClick={() => { void window.api.invoke("agent:openPath", { path: diag.path }); }}>打开位置</a>
            </span>
          )}
          {diag.error && <span className="text-[11px] text-red-400">{diag.error}</span>}
        </div>
      )}
    </SettingCard>
  );
}

export function SettingsPage() {
  const { data: appVersion } = useQuery({ queryKey: ['app-version'], queryFn: () => window.api.invoke('system:appVersion') as Promise<{ success: boolean; data?: string }> });
  const [addOpen, setAddOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<EmailAccount | null>(null);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const qc = useQueryClient();
  const [activeSection, setActiveSection] = useState("sec-general");
  const [workspaceDark, setWorkspaceDark] = useState(workspaceDarkEnabled);
  const railLockRef = useRef(0);

  useEffect(() => {
    document.body.classList.add("settings-route-active");
    return () => document.body.classList.remove("settings-route-active");
  }, []);

  const { data: accountData } = useQuery({
    queryKey: ["accounts"],
    queryFn: () => window.api.invoke("accounts:list") as Promise<{ success: boolean; data?: EmailAccount[] }>,
  });

  // 收信健康度事件驱动刷新：后台每轮抓取成功后账号列表状态实时更新（无需重进设置页）
  useEffect(() => {
    return window.api.on("inbox:health", () => { invalidateDomain(qc, "accounts"); });
  }, [qc]);

  const { data: configData } = useQuery({
    queryKey: ["settings"],
    queryFn: () => window.api.invoke("system:getConfig") as Promise<{ success: boolean; data?: RuntimeConfig }>,
  });

  const upsertMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("accounts:upsert", input),
    onSuccess: () => invalidateDomain(qc, "accounts"),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => window.api.invoke("accounts:delete", id),
    onSuccess: () => invalidateDomain(qc, "accounts"),
  });
  const saveConfigMut = useMutation({
    mutationFn: (input: unknown) => window.api.invoke("system:updateConfig", input) as Promise<{ success: boolean; error?: string }>,
    onSuccess: result => {
      if (!result.success) { message.error(result.error || "保存失败"); return; }
      void invalidateDomain(qc, "settings"); message.success("已保存");
    },
    onError: error => message.error(`保存失败：${error.message}`),
  });

  const accounts = accountData?.success ? accountData.data || [] : [];
  const config = configData?.success ? configData.data : null;
  const sched = config?.schedule;

  // 保存 schedule 单个字段
  const saveSched = (patch: Partial<SendSchedule>) => {
    saveConfigMut.mutate({ schedule: { ...sched, ...patch } });
  };

  const setAutoLaunch = async (enabled: boolean) => {
    const result = await window.api.invoke("system:setAutoLaunch", enabled) as { success: boolean; error?: string };
    if (!result.success) { message.error(result.error || "开机启动设置失败"); return; }
    await invalidateDomain(qc, "settings");
  };

  // 账号熔断状态变化 → 即时刷新账号列表
  useEffect(() => {
    const off = window.api.on("accounts:circuitChanged", () => invalidateDomain(qc, "accounts"));
    return off;
  }, [qc]);

  // 滚动高亮分区 — 高亮「越过阅读线(视口 35%)的最后一个」section
  useEffect(() => {
    const lastId = SECTIONS[SECTIONS.length - 1]!.id;
    const pick = (scroller: HTMLElement | null) => {
      if (Date.now() < railLockRef.current) return;   // 点圆点后的平滑滚动期间不抢高亮
      const line = window.innerHeight * 0.35;
      let current = SECTIONS[0]!.id;
      for (const s of SECTIONS) {
        const el = document.getElementById(s.id);
        if (el && el.getBoundingClientRect().top <= line) current = s.id;
      }
      // 仅当容器真的滚到底、且末段仍未越过阅读线时才补亮最后一个；否则会误吞「数据」等短区块
      if (scroller && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) {
        const lastEl = document.getElementById(lastId);
        if (lastEl && lastEl.getBoundingClientRect().top > line) current = lastId;
      }
      setActiveSection(current);
    };
    // 滚动发生在 antd Content 容器（overflow:auto），scroll 不冒泡，需 capture 阶段捕获；事件 target 即真正的滚动容器
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | Document | null;
      const scroller = t && t !== document && typeof (t as HTMLElement).scrollTop === "number" ? (t as HTMLElement) : null;
      pick(scroller);
    };
    // 用户手动滚动 → 立刻解除锁定，恢复正常跟随
    const unlock = () => { railLockRef.current = 0; };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    document.addEventListener("wheel", unlock, { passive: true });
    document.addEventListener("touchstart", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    pick(null); // 初始执行
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true } as EventListenerOptions);
      document.removeEventListener("wheel", unlock);
      document.removeEventListener("touchstart", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const scrollTo = (id: string) => {
    railLockRef.current = Date.now() + 800;   // 平滑滚动期间锁住高亮，避免被 spy 抢走
    setActiveSection(id);
    const el = document.getElementById(id);
    if (el) {
      el.classList.remove("is-located");
      void el.offsetWidth;                     // 重启 CSS 动画
      el.classList.add("is-located");
      el.addEventListener("animationend", () => el.classList.remove("is-located"), { once: true });
    }
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const accountStatus = (r: EmailAccount) => {
    const open = circuitOpenOf(r);
    const blocked = open && r.circuitReason === "sender_block";
    const recvBad = !!r.imapHost && r.fetchFailCount > 0;
    if (!open && !r.consecutiveFails && !recvBad) return <Tag color={r.imapHost ? "green" : "default"}>{r.imapHost ? "正常" : "仅发信"}</Tag>;
    return <Space size={2}>
      {blocked && <Tooltip title={`服务商拦截后已摘出发信轮换，${r.circuitResetAfter ? new Date(r.circuitResetAfter).toLocaleString("zh-CN") : "24 小时"}后自动恢复`}><Tag color="red">发信受阻</Tag></Tooltip>}
      {open && !blocked && <Tooltip title={`发信连续失败 ${r.consecutiveFails || 3} 次，已熔断`}><Tag color="orange">发信异常</Tag></Tooltip>}
      {!open && r.consecutiveFails > 0 && <Tooltip title={`发信已连续失败 ${r.consecutiveFails} 次（满 3 次熔断）`}><Tag color="orange">发信欠佳</Tag></Tooltip>}
      {recvBad && <Tooltip title={`连续失败 ${r.fetchFailCount} 次：${r.lastFetchError || "收信失败"}`}><Tag color="red">收信异常</Tag></Tooltip>}
    </Space>;
  };
  const editAccount = (r: EmailAccount) => {
    setEditingAccount(r);
    form.setFieldsValue({ displayName: r.displayName, smtpHost: r.smtpHost, smtpPort: r.smtpPort, email: r.email, imapHost: r.imapHost, imapPort: r.imapPort, signature: r.signature });
    setAddOpen(true);
  };
  const testAccount = async (r: EmailAccount) => {
    setTestingId(r.id);
    try {
      const res = await window.api.invoke("accounts:validate", r.id) as { success: boolean; data?: { smtpOk: boolean; smtpError?: string; imapConfigured?: boolean; imapOk: boolean; imapError?: string }; error?: string };
      if (!res?.success || !res.data) { message.error(res?.error || "验证请求失败"); return; }
      const { smtpOk, smtpError, imapOk, imapError } = res.data;
      const imapConfigured = res.data.imapConfigured ?? (!!r.imapHost || imapOk);
      if (smtpOk && imapConfigured && imapOk) message.success(`${r.email} 连接正常（SMTP + IMAP 认证通过）`);
      else if (smtpOk && !imapConfigured) message.warning(`${r.email} SMTP 认证通过；未配置收信`);
      else notification.error({ message: `${r.email} 连接异常`, description: [!smtpOk && `SMTP ✗ ${smtpError || "失败"}`, imapConfigured && !imapOk && `IMAP ✗ ${imapError || "失败"}`].filter(Boolean).join("；"), duration: 8 });
    } finally { setTestingId(null); }
  };
  const resetAccountCircuit = async (r: EmailAccount) => {
    const res = await window.api.invoke("accounts:resetCircuit", r.id) as { success: boolean; error?: string };
    res?.success ? message.success(`${r.email} 已解除熔断`) : message.error(res?.error || "解除失败");
    await invalidateDomain(qc, "accounts");
  };
  const removeAccount = async (r: EmailAccount) => {
    const res = await deleteMut.mutateAsync(r.id);
    res?.success ? message.success("已删除") : message.error(res?.error || "失败");
  };

  return (
    <div className="settings-page mx-auto flex w-full max-w-6xl gap-8">
      {/* 主内容 */}
      <div className="min-w-[560px] max-w-[820px] flex-1 space-y-8">
        {/* ═══ 通用 ═══ */}
        <SettingsPanel id="sec-general" title="通用" description="工作区外观、关闭方式和启动行为">
          <SettingCard title="界面与启动">
            <ControlRow label="深浅色切换" hint="当前工作区配色">
              <Switch size="small" checked={workspaceDark} onChange={value => { setWorkspaceDark(value); applyWorkspaceDark(value); }} />
            </ControlRow>
            <ControlRow label="关闭窗口时">
              <Segmented size="small" value={config?.general?.closeAction === "quit" ? "quit" : "tray"}
                options={[{ value: "tray", label: "最小化托盘" }, { value: "quit", label: "直接退出" }]}
                onChange={value => saveConfigMut.mutate({ general: { ...config?.general, closeAction: value as "tray" | "quit" } })} />
            </ControlRow>
            <ControlRow label="开机自动启动" hint="登录 Windows 后自动打开">
              <Switch size="small" checked={config?.general?.autoLaunch ?? false} onChange={value => void setAutoLaunch(value)} />
            </ControlRow>
          </SettingCard>
        </SettingsPanel>

        {/* ═══ 邮件发送 ═══ */}
        <SettingsPanel id="sec-mail" title="邮件发送" description="发信账号、全局限额与发送节奏">
          <SettingCard title={`发信账号 · ${accounts.length}`}
            status={<Button size="small" onClick={() => { setEditingAccount(null); form.setFieldsValue({ smtpHost: DEFAULT_MAIL_SERVERS.smtpHost, smtpPort: DEFAULT_MAIL_SERVERS.smtpPort, imapHost: DEFAULT_MAIL_SERVERS.imapHost, imapPort: DEFAULT_MAIL_SERVERS.imapPort }); setAddOpen(true); }}>添加账号</Button>}>
            <div className="settings-account-list">
              {accounts.length ? accounts.map(account => <div key={account.id} className="settings-account-row">
                <div className="settings-account-mark" aria-hidden="true">@</div>
                <div className="settings-account-identity">
                  <strong>{account.email}</strong>
                  <span>SMTP {account.smtpHost}:{account.smtpPort}</span>
                  <span>IMAP {account.imapHost ? `${account.imapHost}${account.imapPort ? `:${account.imapPort}` : ""}` : "未配置，仅发信"}</span>
                </div>
                <div className="settings-account-status">{accountStatus(account)}</div>
                <div className="settings-account-actions">
                  <Button size="small" type="text" icon={<EditOutlined />} onClick={() => editAccount(account)}>编辑</Button>
                  <Button size="small" type="text" icon={<CheckCircleOutlined />} loading={testingId === account.id} onClick={() => void testAccount(account)}>测试</Button>
                  {circuitOpenOf(account) && <Button size="small" type="text" danger icon={<PlayCircleOutlined />} onClick={() => void resetAccountCircuit(account)}>解除熔断</Button>}
                  <Popconfirm title={`删除 ${account.email}？`} okText="删除" cancelText="取消" onConfirm={() => void removeAccount(account)}>
                    <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删除 ${account.email}`} />
                  </Popconfirm>
                </div>
              </div>) : <div className="settings-empty-row">还没有发信账号</div>}
            </div>
          </SettingCard>

          <SettingCard title="发信限额">
            <div className="settings-group-note">全局限额从首次发送起计时，24 小时后自动重置；0 表示不限制。</div>
            <SettingRow label="每日上限" value={config?.sendQuota?.dailyLimit ?? 800} type="number"
              onSave={v => saveConfigMut.mutate({ sendQuota: { ...(config?.sendQuota || {}), dailyLimit: Number(v) } })}
              hint="封" />
            {config?.sendQuota?.firstSendAt && <div className="settings-group-note">
              已发 {config.sendQuota.sentToday || 0} 封 · {new Date(new Date(config.sendQuota.firstSendAt).getTime() + 86400000).toLocaleString("zh-CN")} 重置
            </div>}
          </SettingCard>

          <SettingCard title="发送节奏">
            <SettingRow label="每组人数" value={sched?.groupSize ?? 20} type="number"
              onSave={v => saveSched({ groupSize: Number(v) })} hint="人/组" />
            {sched && <RangeRow label="组间暂停" min={sched.groupDelayMinSeconds} max={sched.groupDelayMaxSeconds}
              onSaveMin={v => saveSched({ groupDelayMinSeconds: v })} onSaveMax={v => saveSched({ groupDelayMaxSeconds: v })}
              hint="秒" />}
            <div className="settings-group-note">发送时段由每个开发任务单独设置。</div>
          </SettingCard>
        </SettingsPanel>
        {/* ═══ 高级 ═══ */}
        <SettingsPanel id="sec-advanced" title="高级" description="客户跟进、数据与测试模式">
          <SettingCard title="服务与助手">
          <RatesSourceCard />
          <AgentConversationCard />
          <AgentAuditCard />
          </SettingCard>

        {/* ═══ 客户跟进 ═══ */}
          <SettingCard title="客户跟进">
          <SettingCard icon="" title="沉默预警">
            <Space wrap>
              <span>沉默逾期</span>
              <InputNumber aria-label="沉默逾期天数" min={1} max={MAX_CRM_THRESHOLD_DAYS} precision={0}
                value={config?.crm?.silentOverdueDays ?? DEFAULT_CRM_OVERDUE_DAYS}
                onChange={value => { if (value !== null) saveConfigMut.mutate({ crm: { silentOverdueDays: value } }); }} />
              <span>天；提前预警</span>
              <InputNumber aria-label="沉默预警天数" min={1} max={config?.crm?.silentOverdueDays ?? DEFAULT_CRM_OVERDUE_DAYS} precision={0}
                value={config?.crm?.warnDays ?? DEFAULT_CRM_WARN_DAYS}
                onChange={value => { if (value !== null) saveConfigMut.mutate({ crm: { warnDays: value } }); }} />
              <span>天</span>
            </Space>
            <div className="text-[10px] text-gray-400 mt-2">超过阈值生效；显式提醒仍以提醒到期时间为准。看板与助手使用同一口径。</div>
          </SettingCard>
          <SettingCard icon="" title="默认跟进间隔">
            <div className="text-[11px] text-gray-400 mb-2">
              切换阶段后的默认提醒天数，可在 CRM 管线中单独覆盖
            </div>
            {[
              { key: "reaching", label: "触达中" },
              { key: "quoting", label: "报价中" },
              { key: "trial", label: "试单" },
              { key: "cooperating", label: "合作中" },
              { key: "lost", label: "已流失" },
              { key: "other", label: "其他" },
            ].map(stage => (
              <SettingRow key={stage.key}
                label={stage.label}
                value={config?.crm?.followupDays?.[stage.key] ?? 3}
                type="number"
                onSave={v => saveConfigMut.mutate({
                  crm: { ...config?.crm, followupDays: { ...config?.crm?.followupDays, [stage.key]: Number(v) } },
                })}
                hint="天" />
            ))}
          </SettingCard>
          <SettingCard icon="" title="自动归档">
            <SettingRow label="无回复归档" value={config?.crm?.autoArchiveDays ?? 30} type="number"
              onSave={v => saveConfigMut.mutate({
                crm: { ...config?.crm, autoArchiveDays: Number(v) },
              })}
              hint="天" />
            <div className="text-[10px] text-gray-400 mt-1">
              发信后 N 天无回复自动标记为「已流失」，0=禁用
            </div>
          </SettingCard>
          </SettingCard>

        {/* ═══ 数据 ═══ */}
          <SettingCard title="数据">
          <SettingCard icon="" title="导出数据库">
            <div className="text-[11px] text-gray-400 mb-3">将联系人数据和跟进记录导出为 CSV 文件，可用 Excel 打开。</div>
            <Space>
              <Button size="small" icon={<DownloadOutlined />}
                onClick={async () => {
                  const r = await window.api.invoke("export:contactsToExcel") as { success: boolean; data?: string; error?: string };
                  if (r?.success && r.data) {
                    const blob = new Blob([r.data], { type: "text/csv;charset=utf-8" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `contacts_${new Date().toISOString().slice(0, 10)}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                    message.success("导出完成");
                  } else { message.error(r?.error || "导出失败"); }
                }}
              >导出联系人</Button>
              <Button size="small"
                onClick={async () => {
                  const r = await window.api.invoke("export:notesToCsv") as { success: boolean; data?: string; error?: string };
                  if (r?.success && r.data) {
                    const blob = new Blob([r.data], { type: "text/csv;charset=utf-8" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `跟进记录_${new Date().toISOString().slice(0, 10)}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                    message.success("导出完成");
                  } else { message.error(r?.error || "导出失败"); }
                }}
              >导出跟进记录</Button>
            </Space>
          </SettingCard>
          <SettingCard icon="" title="数据文件夹">
            <div className="text-[11px] text-gray-400 mb-3">邮件数据库、正文和归档备份都存放在本机数据目录。</div>
            <Space>
              <Button size="small" icon={<FolderOpenOutlined />}
                onClick={async () => {
                  const r = await window.api.invoke("system:openPath", "data") as { success: boolean; error?: string };
                  if (!r?.success) message.error(r?.error || "打开失败");
                }}
              >打开数据目录</Button>
              <Button size="small"
                onClick={async () => {
                  const r = await window.api.invoke("system:openPath", "archive") as { success: boolean; error?: string };
                  if (!r?.success) message.error(r?.error || "打开失败");
                }}
              >定位归档文件</Button>
            </Space>
          </SettingCard>
          </SettingCard>

          <SettingCard icon="" title="测试模式">
            <SettingRow label="测试邮箱" value={config?.test?.email || ""}
              onSave={v => saveConfigMut.mutate({ test: { ...config?.test, email: String(v) } })}
              placeholder="test@example.com" />
            <SettingRow label="测试公司" value={config?.test?.company || ""}
              onSave={v => saveConfigMut.mutate({ test: { ...config?.test, company: String(v) } })}
              placeholder="用于测试邮件的公司名" />
            <div className="flex items-center gap-2.5 py-1.5 min-h-[30px]">
              <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">启用测试</label>
              <Switch size="small" checked={config?.test?.enabled ?? false}
                onChange={v => saveConfigMut.mutate({ test: { ...config?.test, enabled: v } })}
              />
              <span className="text-[10px] text-gray-400">使用测试收件人和测试公司资料</span>
            </div>
            <div className="flex items-center gap-2.5 py-1.5 min-h-[30px]">
              <label className="w-[72px] text-right text-[11px] text-gray-500 flex-shrink-0">发信阻隔</label>
              <Switch size="small" checked={config?.test?.dryRun ?? false}
                onChange={v => saveConfigMut.mutate({ test: { ...config?.test, dryRun: v } })}
              />
              <span className="text-[10px] text-gray-400">流程完整但不实际发送</span>
            </div>
          </SettingCard>
        </SettingsPanel>
        <SettingsPanel id="sec-about" title="关于" description="版本与更新">
          <SettingCard title="Milogin's Prospector">
            <div className="flex justify-between py-3 text-xs text-gray-500"><span>版本</span><span
              onMouseDown={event => { if (event.shiftKey && event.button === 0) window.dispatchEvent(new Event("open-onboarding")); }}
              onClick={event => { if (event.shiftKey) window.dispatchEvent(new Event("open-onboarding")); }}
              style={{ cursor: "default" }}
            >{appVersion?.success ? `v${appVersion.data}` : '—'}</span></div>
          </SettingCard>
          <SettingCard id="settings-update" title="检查更新"><UpdateChecker /></SettingCard>
        </SettingsPanel>
      </div>

      {/* 右侧浮动导航轨道 */}
      <nav className="settings-rail hidden lg:block">
        {SECTIONS.map(s => (
          <div key={s.id}
            className={`settings-rail-item ${activeSection === s.id ? "active" : ""}`}
            onClick={() => scrollTo(s.id)}
          >
            <span className="settings-rail-label">{s.label}</span>
            <span className="settings-rail-dot" />
          </div>
        ))}
      </nav>

      {/* 新增/编辑账号弹窗 */}
      <Modal title={editingAccount ? "编辑发信账号" : "发信账号"} open={addOpen} width={520}
        styles={{ body: { overflow: "hidden" } }}
        onCancel={() => { setAddOpen(false); setEditingAccount(null); form.resetFields(); }}
        onOk={async () => {
          try {
            const values = await form.validateFields();
            const payload: Record<string, unknown> = { ...values };
            if (editingAccount) payload.id = editingAccount.id;
            if (!values.password) delete payload.password;
            const result = await upsertMut.mutateAsync(payload) as { success?: boolean; error?: string } | undefined;
            if (!result?.success) {
              message.error(result?.error || "保存失败");
              return;
            }
            setAddOpen(false);
            setEditingAccount(null);
            form.resetFields();
            message.success(editingAccount ? "账号已更新" : "账号已保存，连接验证通过");
          } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
          }
        }}
        confirmLoading={upsertMut.isPending}
      >
        <Form form={form} layout="vertical" size="small" className="settings-account-form">
          <Form.Item name="displayName" label="发件人名称"><Input placeholder="客户收到的名称，如 Zayne Jin" /></Form.Item>
          <Form.Item name="email" label="邮箱地址" rules={[{ required: true, type: "email" }]}><Input placeholder="your@email.com" /></Form.Item>
          <Form.Item name="password" label="邮箱密码 / 授权码"
            extra="这是邮箱服务商提供的密码或授权码，不是中心登录密码。"
            rules={editingAccount ? [] : [{ required: true, message: "新增时密码必填" }]}>
            <Input.Password placeholder={editingAccount ? "留空则不变；第三方登录填授权码" : "密码或第三方登录授权码"} />
          </Form.Item>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="smtpHost" label="SMTP 服务器地址" rules={[{ required: true }]}><Input placeholder={DEFAULT_MAIL_SERVERS.smtpHost} /></Form.Item>
            <Form.Item name="smtpPort" label="SMTP 端口" rules={[{ required: true }]}><InputNumber min={1} max={65535} style={{ width: "100%" }} /></Form.Item>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Form.Item name="imapHost" label="IMAP 服务器"><Input placeholder={DEFAULT_MAIL_SERVERS.imapHost} /></Form.Item>
            <Form.Item name="imapPort" label="IMAP 端口"><InputNumber min={1} max={65535} style={{ width: "100%" }} placeholder={String(DEFAULT_MAIL_SERVERS.imapPort)} /></Form.Item>
          </div>
          <Form.Item name="signature" label="账号签名">
            <RichTextEditor
              placeholder="粘贴签名（支持富文本格式与图片）"
              style={{ height: 200, maxHeight: 200, overflowY: "auto", border: "1px solid #d9d9d9", borderRadius: 6, padding: 8 }}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
