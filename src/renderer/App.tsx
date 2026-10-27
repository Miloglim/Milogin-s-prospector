import { RouterProvider } from "@tanstack/react-router";
import { ConfigProvider, App as AntApp, Modal } from "antd";
import { AppProvider } from "./AppContext";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateDomain } from "./lib/cacheDeps";
import { router } from "./router";
import { brandTheme } from "./lib/brand-theme";
import { IdentityProvider, useIdentity } from './IdentityContext';
import { NotificationProvider } from './NotificationContext';
import { ProductLogin } from './components/ProductLogin';
import { DiamondLogo } from './components/DiamondLogo';
import { subscribeWorkspaceDark, workspaceDarkEnabled } from './lib/workspace-preferences';
import './components/ProductLogin.css';

function AppEmptyState() {
  return <div className="app-empty-state">
    <span className="app-empty-mark"><DiamondLogo size={18} state="static" /></span>
    <span>暂无数据</span>
  </div>;
}

function RestartRequestDialog() {
  const session = useIdentity();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!session.identity || session.identity.mustChangePassword) return;
    return window.api.on('app:restartRequest', () => setOpen(true));
  }, [session.identity?.userId, session.identity?.mustChangePassword]);
  useEffect(() => {
    if (!session.identity || session.identity.mustChangePassword) setOpen(false);
  }, [session.identity?.userId, session.identity?.mustChangePassword]);
  const respond = (confirmed: boolean) => { setOpen(false); void window.api.invoke('system:restartConfirm', confirmed); };
  return <Modal open={open} title="重启应用" centered closable={false} maskClosable={false}
    okText="重启应用" cancelText="取消" onOk={() => respond(true)} onCancel={() => respond(false)}>
    <p className="restart-dialog-copy">未保存的内容将丢失，正在执行的任务将中断。</p>
  </Modal>;
}

type UpdatePromptInfo = { version: string; prerelease?: boolean };

function UpdateAvailableDialog() {
  const session = useIdentity();
  const [update, setUpdate] = useState<UpdatePromptInfo | null>(null);
  const prompted = useRef(new Set<string>());
  useEffect(() => window.api.on('update:available', (value: unknown) => {
    const info = value as Partial<UpdatePromptInfo> | null;
    const version = typeof info?.version === 'string' ? info.version.trim() : '';
    if (!version || prompted.current.has(version)) return;
    prompted.current.add(version);
    if (router.state.location.pathname === '/settings') return;
    setUpdate({ version, prerelease: info?.prerelease === true });
  }), []);
  useEffect(() => {
    if (!session.identity || session.identity.mustChangePassword) setUpdate(null);
  }, [session.identity?.userId, session.identity?.mustChangePassword]);
  const openSettings = () => {
    setUpdate(null);
    void router.navigate({ to: '/settings' });
    window.setTimeout(() => document.getElementById('settings-update')?.scrollIntoView({ block: 'center' }), 100);
  };
  return <Modal open={!!update && !!session.identity && !session.identity.mustChangePassword}
    title="发现新版本" centered okText="前往更新" cancelText="稍后"
    onOk={openSettings} onCancel={() => setUpdate(null)}>
    {update && <p>v{update.version} 已发布</p>}
  </Modal>;
}

function IdentityGate() {
  const session = useIdentity();
  const [pathname, setPathname] = useState(() => router.state.location.pathname);
  const enteredUser = useRef<string | null>(null);
  const [initialRoutePending, setInitialRoutePending] = useState(true);
  const targetPath = session.localAvailable && session.status === 'offline' ? '/inbox' : '/customers';
  useEffect(() => {
    setPathname(router.state.location.pathname);
    return router.subscribe('onResolved', () => setPathname(router.state.location.pathname));
  }, []);
  useEffect(() => {
    if (!session.identity) { enteredUser.current = null; setInitialRoutePending(true); return; }
    if (enteredUser.current !== session.identity.userId) setInitialRoutePending(true);
    if (session.localAvailable && session.status === 'offline' && enteredUser.current !== session.identity.userId) void router.navigate({ to: '/inbox', replace: true });
    if (session.localAvailable) enteredUser.current = session.identity.userId;
    if (session.identity && !session.localAvailable && !session.identity.mustChangePassword) void router.navigate({ to: '/customers', replace: true });
  }, [session.identity?.userId, session.localAvailable, session.identity?.mustChangePassword, session.status]);
  useEffect(() => {
    if (session.identity && pathname === targetPath) setInitialRoutePending(false);
  }, [pathname, targetPath, session.identity]);
  if (!session.ready) return <div className="login-restore-screen"><DiamondLogo size={32} state="running" /><span>正在恢复登录…</span></div>;
  if (!session.identity || session.identity.mustChangePassword) return <ProductLogin />;
  return <div className="identity-app-shell" key={JSON.stringify([session.identity.userId, session.identity.crmRoles, session.identity.crmCapabilities, session.localAvailable])} style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <RouterProvider router={router} />
    {initialRoutePending && <div className="identity-route-loading" aria-live="polite"><DiamondLogo size={32} state="running" /></div>}
  </div>;
}

function BusinessEvents() {
  const session = useIdentity();
  const qc = useQueryClient();
  useEffect(() => {
    if (!session.identity || session.identity.mustChangePassword) return;
    const inbox = window.api.on('inbox:newMail', () => { void invalidateDomain(qc, 'inbox'); });
    const send = window.api.on('send:progress', () => { void invalidateDomain(qc, 'send'); });
    return () => { inbox(); send(); };
  }, [qc, session.identity?.userId, session.identity?.mustChangePassword]);
  return null;
}

function ApplicationTheme() {
  const [workspaceDark, setWorkspaceDark] = useState(workspaceDarkEnabled);
  useEffect(() => subscribeWorkspaceDark(setWorkspaceDark), []);
  return (
    <ConfigProvider
      renderEmpty={() => <AppEmptyState />}
      theme={brandTheme(workspaceDark)}>
      <AntApp>
        <NotificationProvider><RestartRequestDialog /><UpdateAvailableDialog /><BusinessEvents /><IdentityGate /></NotificationProvider>
      </AntApp>
    </ConfigProvider>
  );
}

export function App() {
  return (
    <AppProvider>
      <IdentityProvider><ApplicationTheme /></IdentityProvider>
    </AppProvider>
  );
}
