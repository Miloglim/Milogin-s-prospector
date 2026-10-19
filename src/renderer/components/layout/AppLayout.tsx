import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Layout, message, Modal, Spin } from "antd";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { Sidebar } from "./Sidebar";
import { KEEPALIVE_ROUTE_COMPONENTS } from "../../router";
import { useOptionalIdentity } from '../../IdentityContext';
import { OnboardingWizard } from "../OnboardingWizard";
import { globalStatusNotices, GLOBAL_STATUS_TOAST_DURATION_SECONDS, type GlobalStatusNotice } from './app-layout-status';

const { Content } = Layout;

/** 路由级 keep-alive：登记过的页面切走只隐藏不卸载，切回来零重挂、零 loading 闪变。
 *  · 缓存键 = pathname；从别的页面带着新 query 深链进来时换新实例（页面挂载时读 query 的语义不变）；
 *  · 同页 query 变化保持挂载，由页面自行响应（与 TanStack 默认一致）；
 *  · 未登记的路由照常走 <Outlet />，行为与从前完全相同。
 *  隐藏期间轻量轮询照跑（send:status 等），send:progress 持续入缓存 —— 回来即实况。 */
function KeepAliveOutlet() {
  const { pathname, searchStr } = useRouterState({ select: s => ({ pathname: s.location.pathname, searchStr: s.location.searchStr }) });
  const cacheRef = useRef<Map<string, { el: React.ReactNode; searchStr: string }>>(new Map());
  const prevPathRef = useRef<string>(pathname);

  const Comp = KEEPALIVE_ROUTE_COMPONENTS[pathname];
  if (Comp) {
    const cache = cacheRef.current;
    const entry = cache.get(pathname);
    if (!entry) {
      cache.set(pathname, { el: <Comp />, searchStr });
    } else if (prevPathRef.current !== pathname && entry.searchStr !== searchStr) {
      cache.set(pathname, { el: <Comp key={searchStr} />, searchStr });
    }
  }
  prevPathRef.current = pathname;

  return (
    <>
      {[...cacheRef.current.entries()].map(([p, e]) => (
        <div key={p} hidden={p !== pathname} style={p === pathname ? undefined : { height: "100%" }}>{e.el}</div>
      ))}
      {!Comp && <Outlet />}
    </>
  );
}

const btn: React.CSSProperties = {
  width: 46, height: "var(--app-titlebar-height)", border: "none", background: "transparent",
  color: "#999", cursor: "pointer", display: "inline-flex",
  alignItems: "center", justifyContent: "center", borderRadius: 0,
};

// ponytail: 无边框窗口自定义标题栏 — 匹配旧 PE 布局
export function TitleBar() {
  return (
    <div className="app-titlebar titlebar-drag">
      <div className="app-titlebar-spacer" aria-hidden="true" />

      <div className="app-window-controls titlebar-nodrag">
        <button onClick={() => window.api.send("window:minimize")} style={btn}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.08)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          title="最小化"
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><rect y="4" width="10" height="1.5" fill="currentColor"/></svg>
        </button>
        <button onClick={() => window.api.send("window:maximize")} style={btn}
          onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.08)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
          title="最大化"
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" rx="1"/></svg>
        </button>
        <button onClick={() => window.api.send("window:close")} style={btn}
          onMouseEnter={e => { e.currentTarget.style.background = "#e81123"; e.currentTarget.style.color = "#fff"; }}
          onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#999"; }}
          title="关闭"
        >
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.5"/></svg>
        </button>
      </div>
    </div>
  );
}

/** 内容区滚动容器：每个路由记住自己的 scrollTop，切页互不串位置（keep-alive 后必需）。 */
function ScrollArea({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const posMap = useRef<Map<string, number>>(new Map());
  const activePath = useRef<string>(pathname);

  useLayoutEffect(() => {
    activePath.current = pathname;
    if (scrollRef.current) scrollRef.current.scrollTop = posMap.current.get(pathname) ?? 0;
  }, [pathname]);

  return (
    <div
      ref={scrollRef}
      onScroll={e => posMap.current.set(activePath.current, e.currentTarget.scrollTop)}
      style={{ height: "100%", overflow: "auto", padding: '16px 20px' }}
    >
      {children}
    </div>
  );
}

export function AppLayout() {
  const pathname = useRouterState({ select: s => s.location.pathname });
  const session = useOptionalIdentity();
  const localAvailable = !session || session.localAvailable;
  const centerUnavailable = session?.status === 'offline' && pathname === '/messages';
  const [messageApi, contextHolder] = message.useMessage();
  const shownNoticeKeys = useRef<Set<GlobalStatusNotice['key']>>(new Set());
  const statusNotices = globalStatusNotices({
    offline: session?.status === 'offline',
    centerUnavailable,
    localAvailable,
    pathname,
  });
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [onboardingEmail, setOnboardingEmail] = useState("");
  const [onboardingSignal, setOnboardingSignal] = useState(0);
  useEffect(() => {
    const positions = new WeakMap<HTMLElement, { left: number; top: number }>();
    const timers = new WeakMap<HTMLElement, { x?: number; y?: number }>();
    const selector = '.prospector-page-table .ant-table-content, .prospector-page-table .ant-table-body';
    const onScroll = (event: Event) => {
      const element = event.target;
      if (!(element instanceof HTMLElement) || !element.matches(selector)) return;
      const previous = positions.get(element) ?? { left: element.scrollLeft, top: element.scrollTop };
      const next = { left: element.scrollLeft, top: element.scrollTop };
      positions.set(element, next);
      const timer = timers.get(element) ?? {};
      if (next.left !== previous.left) {
        element.classList.add('is-scrolling-x');
        if (timer.x !== undefined) window.clearTimeout(timer.x);
        timer.x = window.setTimeout(() => element.classList.remove('is-scrolling-x'), 520);
      }
      if (next.top !== previous.top) {
        element.classList.add('is-scrolling-y');
        if (timer.y !== undefined) window.clearTimeout(timer.y);
        timer.y = window.setTimeout(() => element.classList.remove('is-scrolling-y'), 520);
      }
      timers.set(element, timer);
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, []);
  useEffect(() => {
    const email = session?.identity?.email?.trim().toLowerCase();
    if (!email || window.localStorage.getItem("prospector:registered-email") !== email) return;
    setOnboardingEmail(email);
    setWelcomeOpen(true);
  }, [session?.identity?.email]);
  useEffect(() => {
    const open = () => setOnboardingSignal(value => value + 1);
    window.addEventListener("open-onboarding", open);
    return () => window.removeEventListener("open-onboarding", open);
  }, []);
  useEffect(() => {
    const activeKeys = new Set(statusNotices.map(notice => notice.key));
    for (const notice of statusNotices) {
      if (shownNoticeKeys.current.has(notice.key)) continue;
      shownNoticeKeys.current.add(notice.key);
      messageApi.open({
        key: `global-status-${notice.key}`,
        type: notice.type,
        content: notice.content,
        duration: GLOBAL_STATUS_TOAST_DURATION_SECONDS,
      });
    }
    for (const key of shownNoticeKeys.current) {
      if (!activeKeys.has(key)) shownNoticeKeys.current.delete(key);
    }
  }, [messageApi, statusNotices]);
  const openOnboarding = () => {
    setWelcomeOpen(false);
    window.localStorage.removeItem("prospector:registered-email");
    window.dispatchEvent(new Event("open-onboarding"));
  };
  return (
    <div className="app-shell">
      {contextHolder}
      <TitleBar />
      <Layout className="app-body" hasSider>
        <Sidebar />
        <Layout>
          <Content style={{ background: "#f5f5f5", minHeight: 0, overflow: "hidden" }}>
            <ScrollArea pathname={pathname}>
              <div hidden={centerUnavailable}>{!localAvailable && pathname === '/settings' ? <Spin /> : !localAvailable && !['/customers', '/customers-online', '/account', '/messages'].includes(pathname) ? null : <KeepAliveOutlet />}</div>
            </ScrollArea>
          </Content>
        </Layout>
      </Layout>
      <Modal open={welcomeOpen} title="欢迎使用 Prospector" centered okText="配置账号" cancelText="稍后配置"
        onOk={openOnboarding} onCancel={() => { setWelcomeOpen(false); window.localStorage.removeItem("prospector:registered-email"); }}>
        <p style={{ margin: 0, color: "#666" }}>是否现在配置邮箱账号？</p>
      </Modal>
      <OnboardingWizard autoCheck={false} prefillEmail={onboardingEmail} openSignal={onboardingSignal} />
    </div>
  );
}
