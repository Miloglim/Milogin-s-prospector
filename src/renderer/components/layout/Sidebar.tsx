import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import {
  DashboardOutlined, UserOutlined, SendOutlined,
  InboxOutlined, FileTextOutlined,
  SettingOutlined, SearchOutlined, MoreOutlined, DollarOutlined, UpOutlined, BellOutlined,
  MenuFoldOutlined, MenuUnfoldOutlined,
} from "@ant-design/icons";
import { App as AntApp, ConfigProvider, Dropdown, Input, Modal, Popover } from "antd";
import "./SidebarFooter.css";
import { brandTheme } from '../../lib/brand-theme';
import { useAppContext } from "../../AppContext";
import { DiamondLogo } from "../DiamondLogo";
import { GlobalSearch } from "../GlobalSearch";
import { MessageCenterPanel } from "../MessageCenterPanel";
import { CONVS_CHANGED, gotoConversation } from "../../lib/agent-route";
import { drop as dropConv, useRunningConvIds } from "../../hooks/useAgentTranscript";
import { useOptionalNotifications } from '../../NotificationContext';
import { useOptionalIdentity } from '../../IdentityContext';
import { identityRoleLabel } from '../../../shared/online-crm';

interface NavItem {
  key: string;
  icon: React.ReactNode;
  label: string;
}

const navItems: NavItem[] = [
  { key: "/assistant", icon: <DiamondLogo size={15} state="idle" />, label: "新对话" },
  { key: "/", icon: <DashboardOutlined />, label: "仪表盘" },
  { key: "/inbox", icon: <InboxOutlined />, label: "收件箱" },
  { key: "/customers", icon: <UserOutlined />, label: "客户" },
];

// 公司大模型正式接入前，先隐藏尚未开放的产品入口；路由和实现保留，后续只需打开开关。
const SHOW_DASHBOARD_NAV = false;
const SHOW_RATES_NAV = false;
const SHOW_NEW_CONVERSATION_NAV = false;
const SHOW_CONVERSATIONS_PANEL = false;

// 豆包式空间让位：会话历史溢出时，这三行折叠进底栏图标，列表向上增高
const collapsibleItems: NavItem[] = [
  { key: "/rates", icon: <DollarOutlined />, label: "运价库" },
  { key: "/campaigns", icon: <SendOutlined />, label: "发送中心" },
  { key: "/templates", icon: <FileTextOutlined />, label: "素材库" },
];
const NAV_ROWS_H = 138; // 三行导航 ≈46px/行，折叠↔恢复的滞回阈值

// ── 会话历史面板（豆包式：嵌在全局导航栏内，仅 AI 助手页显示） ──

interface ConvMeta { id: string; title: string; createdAt: string; updatedAt: string }

// 路由胶水（广播事件名 / 切会话写 hash）已提到 lib/agent-route，回合现场那里也要用；此处 re-export 兼容旧引用
export { CONVS_CHANGED, gotoConversation };

/** 活动会话由 hash 参数驱动：#/assistant?c=<id>（与全项目 hash 深链惯例一致），
 *  导航栏与页面各读各的，天然同步、零共享状态 */
function readActiveConv(): string | undefined {
  const raw = window.location.hash;
  const qs = raw.includes("?") ? raw.split("?")[1] : "";
  return new URLSearchParams(qs).get("c") || undefined;
}

function groupOf(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (day(d) === day(now)) return "今天";
  const yest = new Date(now.getTime() - 86400_000);
  if (day(d) === day(yest)) return "昨天";
  if (now.getTime() - d.getTime() < 7 * 86400_000) return "7 天内";
  return "更早";
}

const convRowStyle = (active: boolean): React.CSSProperties => ({
  padding: "4px 4px 4px 10px",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: "18px",
  display: "flex",
  alignItems: "center",
  gap: 2,
  borderRadius: 5,
  color: active ? "#fff" : "rgba(255,255,255,0.72)",
  background: active ? "rgba(255,255,255,0.12)" : "transparent",
  transition: "background 0.12s",
});

function ConversationsPanel({ collapsed, onMetrics, onTuck }: {
  collapsed: boolean; onMetrics: (scroll: number, view: number) => void; onTuck: (down: boolean) => void;
}) {
  const [convs, setConvs] = useState<ConvMeta[]>([]);
  /** 正在跑回合的会话：标题前挂呼吸点，切到别的页面也知道助手还在干活 */
  const running = useRunningConvIds();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTopRef = useRef(0);
  // 当前会话由 router state 派生：navigate()（pushState）不触发 hashchange，读旧 URL 会亮错行；
  // 这里跟随 router 状态重算，切去设置/仪表盘时 c 自然消失，高亮即灭
  const cParam = useRouterState({ select: s => (s.location.search as { c?: unknown }).c });
  const activeId = typeof cParam === "string" && cParam ? cParam : undefined;
  const [renaming, setRenaming] = useState<ConvMeta | null>(null);
  const [renameVal, setRenameVal] = useState("");

  const refresh = useCallback(async () => {
    type IpcResult<T> = { success: boolean; data?: T; error?: string };
    const r = await window.api.invoke("agent:listConversations") as IpcResult<ConvMeta[]>;
    if (r?.success && r.data) setConvs(r.data);
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = () => void refresh();
    window.addEventListener(CONVS_CHANGED, onChanged);
    return () => window.removeEventListener(CONVS_CHANGED, onChanged);
  }, [refresh]);

  // 溢出探测：容器尺寸变化（RO）与会话数变化都上报内容高/可视高，父级做折叠滞回
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const report = () => onMetrics(el.scrollHeight, el.clientHeight);
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, [onMetrics, convs]);

  const doRename = async () => {
    if (!renaming || !renameVal.trim()) return;
    await window.api.invoke("agent:renameConversation", { conversationId: renaming.id, title: renameVal });
    setRenaming(null);
    void refresh();
  };

  const confirmDelete = (c: ConvMeta) => {
    Modal.confirm({
      title: `删除会话「${c.title}」？`,
      content: "会话将移入归档（设置 → AI 助手 → 归档会话），可恢复或彻底清除。",
      okText: "删除", okType: "danger", cancelText: "取消",
      onOk: async () => {
        await window.api.invoke("agent:archiveConversation", c.id);
        dropConv(c.id);   // 回合现场缓存一并清掉（否则同 id 复用会读到脏现场）
        if (readActiveConv() === c.id) gotoConversation(undefined);
        window.dispatchEvent(new Event(CONVS_CHANGED));
      },
    });
  };

  // 折叠态太窄放不下会话列表；新对话入口由导航项「新对话」承载
  if (collapsed) return null;

  // 服务端已按 updatedAt 倒序，按出现顺序聚组即为从新到旧
  const groups: { name: string; items: ConvMeta[] }[] = [];
  for (const c of convs) {
    const g = groupOf(c.updatedAt);
    const last = groups[groups.length - 1];
    if (last && last.name === g) last.items.push(c);
    else groups.push({ name: g, items: [c] });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      <div ref={scrollRef} onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        const t = el.scrollTop;
        if (t - lastTopRef.current > 6) onTuck(true);          // 向下翻记录 → 让位
        else if (t <= 4) onTuck(false);                        // 滚回顶 → 导航回来
        lastTopRef.current = t;
      }} style={{ flex: 1, overflowY: "auto", minHeight: 0, padding: "0 8px 6px" }}>
        {groups.length === 0 && (
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.3)", textAlign: "center", paddingTop: 12 }}>
            还没有会话，开始第一段对话吧
          </div>
        )}
        {groups.map(g => (
          <div key={g.name}>
            <div style={{
              fontSize: 9, color: "rgba(255,255,255,0.35)", fontWeight: 600,
              padding: "8px 6px 2px", letterSpacing: 0.5,
            }}>{g.name}</div>
            {g.items.map(c => (
              <div
                key={c.id}
                className={activeId === c.id ? "conv-row active" : "conv-row"}
                style={convRowStyle(activeId === c.id)}
                onClick={() => gotoConversation(c.id)}
              >
                {running.includes(c.id) && <span className="conv-running-dot" />}
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.title}
                </span>
                <Dropdown
                  trigger={["click"]}
                  menu={{
                    items: [
                      { key: "rename", label: "重命名" },
                      { key: "delete", label: "删除", danger: true },
                    ],
                    onClick: ({ key, domEvent }) => {
                      domEvent.stopPropagation();
                      if (key === "rename") { setRenaming(c); setRenameVal(c.title); }
                      if (key === "delete") confirmDelete(c);
                    },
                  }}
                >
                  <button
                    className="conv-more"
                    onClick={e => e.stopPropagation()}
                    style={{
                      width: 18, height: 18, border: "none", background: "transparent",
                      color: "rgba(255,255,255,0.6)", cursor: "pointer", flexShrink: 0,
                      display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 4,
                    }}
                  >
                    <MoreOutlined style={{ fontSize: 12 }} />
                  </button>
                </Dropdown>
              </div>
            ))}
          </div>
        ))}
      </div>

      <Modal title="重命名会话" open={!!renaming} okText="保存" cancelText="取消"
        onCancel={() => setRenaming(null)} onOk={() => { void doRename(); }}
      >
        <Input value={renameVal} onChange={e => setRenameVal(e.target.value)}
          onPressEnter={() => { void doRename(); }} maxLength={60} autoFocus />
      </Modal>
    </div>
  );
}

// 共用的导航项样式
const navItemStyle = (active: boolean, collapsed: boolean): React.CSSProperties => ({
  padding: collapsed ? "12px 0" : "12px 20px",
  height: 44,
  boxSizing: "border-box",
  cursor: "pointer",
  fontSize: 14,
  display: "flex",
  alignItems: "center",
  justifyContent: collapsed ? "center" : "flex-start",
  gap: collapsed ? 0 : 10,
  // 选中态的绿色条由父级滑块统一绘制，避免每个条目各自重排。
  borderLeft: collapsed ? "none" : "3px solid transparent",
  background: collapsed && active ? "rgba(0,191,165,0.15)" : "transparent",
  fontWeight: active ? 600 : 400,
  transition: "color 0.15s ease, opacity 0.15s ease",
  color: active && collapsed ? "#00bfa5" : "#fff",
  position: "relative",
  zIndex: 1,
});

export function Sidebar() {
  const session = useOptionalIdentity();
  const { message } = AntApp.useApp();
  const notifications = useOptionalNotifications();
  const localAvailable = !session || session.localAvailable;
  const offline = session?.status === 'offline';
  const unavailable = (key: string) => !localAvailable && key !== '/customers';
  const { sidebarCollapsed, toggleSidebar } = useAppContext();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: s => s.location.pathname });
  /** 是否已在某个具体会话里——是则「新对话」不高亮（高亮交给会话列表那一行）；
   *  与列表同源：从 router state 派生而非监听 hashchange（navigate() 不触发后者） */
  const cParam = useRouterState({ select: s => (s.location.search as { c?: unknown }).c });
  const activeConv = typeof cParam === "string" && cParam ? cParam : undefined;
  // agent 输出中：「新对话」导航菱形从呼吸切到旋转（任意页面的全局状态灯）
  const [agentBusy, setAgentBusy] = useState(false);
  const [checkingConnection, setCheckingConnection] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const indicatorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (offline || !session?.identity) setMessagesOpen(false);
  }, [offline, session?.identity]);

  useEffect(() => {
    const offChunk = window.api.on("agent:chunk", () => setAgentBusy(true));
    const offDone = window.api.on("agent:done", () => setAgentBusy(false));
    const offErr = window.api.on("agent:error", () => setAgentBusy(false));
    return () => { offChunk(); offDone(); offErr(); };
  }, []);

  // 豆包式空间让位（双条件）：会话列表确实溢出 且 用户开始向下翻记录 → 运价库/发送中心/素材库
  // 折叠进底栏图标，列表向上增高；滚回顶部或空间恢复则自动还原。溢出侧保留滞回防抖。
  const [overflows, setOverflows] = useState(false);
  const [tucked, setTucked] = useState(false);
  const navHidden = overflows && tucked && !sidebarCollapsed;
  const handleMetrics = useCallback((scroll: number, view: number) => {
    setOverflows(prev => (prev ? scroll > view - NAV_ROWS_H - 8 : scroll > view + 4));
  }, []);
  const handleTuck = useCallback((down: boolean) => setTucked(down), []);

  const isActive = (key: string) => {
    // 「新对话」只代表空态入口：已经在某个会话里就不高亮（高亮交给会话列表那一行）
    if (key === "/assistant") return pathname === "/assistant" && !activeConv;
    return pathname === key || (key !== "/" && pathname.startsWith(key));
  };

  const width = sidebarCollapsed ? 64 : 210;
  const visibleNavItems = navItems.filter(item => (item.key !== '/' || SHOW_DASHBOARD_NAV) && (item.key !== '/assistant' || SHOW_NEW_CONVERSATION_NAV));
  const visibleCollapsibleItems = collapsibleItems.filter(item => item.key !== '/rates' || SHOW_RATES_NAV);
  const renderedNavItems = navHidden ? visibleNavItems : [...visibleNavItems, ...visibleCollapsibleItems];
  const activeNavIndex = renderedNavItems.findIndex(item => isActive(item.key));
  const checkConnection = async () => {
    if (checkingConnection || !session) return;
    setCheckingConnection(true);
    try {
      const online = await session.reconnect();
      if (online) message.success('中心连接正常');
      else message.warning('中心仍不可用，当前保留离线工作区');
    } finally {
      setCheckingConnection(false);
    }
  };

  const renderItem = (item: NavItem, index: number) => (
    <li
      key={item.key}
      onClick={() => {
        if (unavailable(item.key)) return;
        const go = () => {
          // 「新对话」= 清掉会话参数进入空白态；已在该页时 hash 变化仍会触发页面重置
          if (item.key === "/assistant") gotoConversation(undefined);
          else navigate({ to: item.key });
        };
        // 客户页高亮条独立于页面内容移动；路由壳体立即切换，重表格由客户页自行延后挂载。
        if (item.key === "/customers" && !isActive(item.key) && !sidebarCollapsed) {
          indicatorRef.current?.style.setProperty("transform", `translateY(${index * 44}px)`);
        }
        go();
      }}
      title={unavailable(item.key) ? offline ? '离线' : '此功能暂未开放' : sidebarCollapsed ? item.label : undefined}
      aria-disabled={unavailable(item.key)}
      style={{ ...navItemStyle(isActive(item.key), sidebarCollapsed), ...(unavailable(item.key) ? { opacity: .4, cursor: 'not-allowed' } : {}) }}
    >
      <span style={{
        width: 20, height: 20, textAlign: "center",
        flexShrink: 0, display: "inline-flex",
        alignItems: "center", justifyContent: "center",
      }}>
        {item.key === "/assistant"
          ? <DiamondLogo size={15} state={agentBusy ? "running" : "idle"} />
          : item.icon}
      </span>
      <span style={{
        overflow: "hidden",
        whiteSpace: "nowrap",
        opacity: sidebarCollapsed ? 0 : 1,
        transition: "opacity 0.15s ease",
        display: sidebarCollapsed ? "none" : "flex", alignItems: "center",
      }}>
        {item.label}
      </span>
    </li>
  );

  return (
    <aside
      style={{
        width,
        minWidth: width,
        maxWidth: width,
        background: "#1a1a1a",
        borderRight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "visible",
        position: "relative",
        transition: "width 0.2s, min-width 0.2s, max-width 0.2s",
      }}
    >
      {/* 保留品牌区域高度，折叠仅隐藏内容，导航不会上下跳动。 */}
      <div
        className="sidebar-brand"
        role="button"
        tabIndex={sidebarCollapsed ? -1 : 0}
        aria-hidden={sidebarCollapsed}
        aria-label={checkingConnection ? '正在检查中心连接' : '检查并重连中心'}
        title={checkingConnection ? '正在检查中心连接' : '检查并重连中心'}
        style={{ padding: "24px 20px 20px", cursor: checkingConnection ? 'wait' : 'pointer', textAlign: "left", opacity: sidebarCollapsed ? 0 : 1, borderBottom: sidebarCollapsed ? "1px solid rgba(255,255,255,0.08)" : "none", whiteSpace: "nowrap", flexShrink: 0, pointerEvents: sidebarCollapsed ? 'none' : 'auto' }}
        onClick={() => void checkConnection()}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void checkConnection(); } }}
      >
        <div style={{ fontSize: 10, opacity: 0.5, display: "block", color: "#999" }}>
          Milogin&apos;s
        </div>
        <h1 style={{
          fontSize: 20, fontWeight: 700, letterSpacing: "0.5px",
          margin: 0, color: "#fff",
        }}>
          Prospector<span className={`sidebar-brand-dot${offline ? ' is-offline' : ''}`}>.</span>
        </h1>
      </div>

      {/* Nav — 平铺列表；会话历史常驻导航项下方（豆包式：任何页面都可直切会话） */}
      <nav style={{ flex: 1, overflow: "hidden", minHeight: 0, display: "flex", flexDirection: "column" }}>
        <ul className="sidebar-nav-list" style={{ listStyle: "none", padding: 0, margin: 0, flexShrink: 0, position: "relative" }}>
          {!sidebarCollapsed && activeNavIndex >= 0 && <span
            ref={indicatorRef}
            className="sidebar-nav-indicator"
            aria-hidden="true"
            style={{ transform: `translateY(${activeNavIndex * 44}px)` }}
          />}
          {renderedNavItems.map(renderItem)}
        </ul>

        {SHOW_CONVERSATIONS_PANEL && <div style={{ borderTop: "1px solid rgba(255,255,255,0.1)", margin: "8px 12px 0", flexShrink: 0 }} />}
        {localAvailable && SHOW_CONVERSATIONS_PANEL && <ConversationsPanel collapsed={sidebarCollapsed} onMetrics={handleMetrics} onTuck={handleTuck} />}
      </nav>

      {navHidden && SHOW_CONVERSATIONS_PANEL && <div className="sidebar-tucked-nav">
        <FootIcon icon={<UpOutlined />} label="展开导航" active={false} onClick={() => setTucked(false)} />
        {visibleCollapsibleItems.map(it => <FootIcon key={it.key} icon={it.icon} label={it.label}
          active={isActive(it.key)} onClick={() => navigate({ to: it.key })} />)}
      </div>}

      <div className={`sidebar-footer${sidebarCollapsed ? ' is-collapsed' : ''}`}>
        {session?.identity && <ConfigProvider theme={brandTheme(true)}><Dropdown overlayClassName="account-menu-popup" trigger={['click']} placement="topLeft" menu={{ items: [{ type: 'group', label: <div className="account-menu-identity"><strong>{session.identity.displayName}</strong><span>{session.identity.email}</span></div> }, { type: 'divider' }, { key: 'profile', icon: <UserOutlined />, label: '账号资料' }, { key: 'settings', icon: <SettingOutlined />, label: '设置' }, { type: 'divider' }, { key: 'switch', label: '切换账号' }, { key: 'logout', className: 'account-menu-logout-item', label: <span className="account-menu-logout">退出登录</span> }], onClick: ({ key }) => { if (key === 'logout') void session.logout(); if (key === 'switch') void session.logout({ switchAccount: true }); if (key === 'settings') void navigate({ to: '/settings' }); if (key === 'profile') void navigate({ to: '/account' }); } }}>
                <button type="button" className="sidebar-account" aria-label="账号菜单" title={`你好，${identityRoleLabel(session.identity)}`}>
            <SettingOutlined />
                  {!sidebarCollapsed && <span className="sidebar-greeting" style={{ color: '#9b9b9b', fontWeight: 600 }}>你好，{identityRoleLabel(session.identity)}</span>}
          </button>
        </Dropdown></ConfigProvider>}
        <div className="sidebar-footer-actions">
          {localAvailable && <GlobalSearch trigger={(onClick, active) => <FootIcon icon={<SearchOutlined />} label="全局搜索" active={active} onClick={onClick} />} />}
          {session?.identity && <Popover
            trigger="click"
            placement="rightBottom"
            open={messagesOpen}
            onOpenChange={setMessagesOpen}
            overlayClassName="message-center-popover"
            styles={{ body: { padding: 0, overflow: 'hidden' } }}
            content={<MessageCenterPanel />}
          >
            <span className="message-center-trigger">
              <FootIcon icon={<><BellOutlined />{(notifications?.unread ?? 0) > 0 && <span className="sidebar-message-badge" aria-label={`${notifications?.unread} 条未读`}>{notifications?.unread}</span>}</>} label="消息中心" disabled={offline} active={messagesOpen} onClick={() => undefined} />
            </span>
          </Popover>}
        </div>
      </div>

      {/* 边缘细长书签式折叠钮：向外突出在侧栏右边线上 */}
      <button
        type="button"
        onClick={toggleSidebar}
        title={sidebarCollapsed ? "展开侧栏" : "折叠为图标轨"}
        style={{
          position: "absolute",
          right: -4,
          top: "50%",
          transform: "translateY(-50%)",
          width: 8,
          height: 40,
          padding: 0,
          border: "none",
          background: "#2a2a2a",
          cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center",
          borderRadius: "4px",
          boxShadow: "0 1px 4px rgba(0,0,0,.35)",
          zIndex: 10,
          transition: "background .15s",
        }}
        onMouseEnter={e => { e.currentTarget.style.background = "#00bfa5"; }}
        onMouseLeave={e => { e.currentTarget.style.background = "#2a2a2a"; }}
      >
        <span style={{
          fontSize: 9, color: "rgba(255,255,255,.6)",
          transition: "color .15s",
          lineHeight: 1,
        }}>
          {sidebarCollapsed ? "›" : "‹"}
        </span>
      </button>
    </aside>
  );
}

/** 底栏轻量图标按钮（设置 / 折叠进来的导航项共用） */
function FootIcon({ icon, label, active, onClick, disabled = false }: {
  icon: React.ReactNode; label: string; active: boolean; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button type="button" className="sidebar-foot-icon" aria-label={label} disabled={disabled}
      title={label}
      onClick={onClick}
      style={{
        borderRadius: 6, position: "relative",
        border: "none", padding: 0, flexShrink: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? .4 : 1,
        color: active ? "#fff" : "rgba(255,255,255,0.45)",
        background: active ? "rgba(255,255,255,0.12)" : "transparent",
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.08)"; e.currentTarget.style.color = "#fff"; }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = active ? "rgba(255,255,255,0.12)" : "transparent";
        e.currentTarget.style.color = active ? "#fff" : "rgba(255,255,255,0.45)";
      }}
    >
      {icon}
    </button>
  );
}
