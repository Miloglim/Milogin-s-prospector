import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Alert, App, Button, ConfigProvider, Empty, Form, Input, Menu, Modal, Select, Space, Spin, Switch, Table, Tabs, Typography } from "antd";
import { ADMIN_LIMITS, productPermissionsFor, productRoleFor, type AdminCommand, type AuditInfo, type DataScope, type MutationResult, type SessionInfo } from "../server/core/admin";
import { AUTH_LIMITS, CRM_ROLES, CRM_ROLE_LABELS, identityRoleLabel, PASSWORD_PATTERN, type CrmRole } from "../server/core/auth";
import { brandTheme } from "../src/renderer/lib/brand-theme";
import { api, ApiError, configureSession, type Identity, type ManagedUser } from "./api";
import { delegationCapabilities, scopesFor } from "./permissions";
import { ProductManagement, type ManagedProduct } from './product-management';
import { OperationsManagement } from './operations-management';

const ROLE_NAMES = CRM_ROLE_LABELS;
type Section = "identity" | "products" | "operations";
type Pending = { title: string; targetEmail?: string; deletion?: boolean; command: (reason?: string) => AdminCommand };
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败";
const date = (value: string) => new Date(value).toLocaleString("zh-CN");

export function AdminApp({ initialChallenge }: { initialChallenge: string | null }) {
  const [dark, setDark] = useState(() => localStorage.getItem("admin-theme") === "dark");
  const theme = brandTheme(dark);
  return <ConfigProvider theme={{ ...theme, token: { ...theme.token, colorPrimary: dark ? "#83a9c2" : "#20465e" } }} componentSize="small"><App><Workspace dark={dark} toggleTheme={() => setDark(value => { localStorage.setItem("admin-theme", value ? "light" : "dark"); return !value; })} initialChallenge={initialChallenge}/></App></ConfigProvider>;
}

function Workspace({ dark, toggleTheme, initialChallenge }: { dark: boolean; toggleTheme: () => void; initialChallenge: string | null }) {
  const { message } = App.useApp();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [boot, setBoot] = useState(!initialChallenge);
  const [challenge, setChallenge] = useState(initialChallenge);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<Section>("identity");
  const [managedProduct, setManagedProduct] = useState<ManagedProduct>('prospector');
  const [view, setView] = useState("members");
  const [detailProduct, setDetailProduct] = useState("crm");
  const [detailView, setDetailView] = useState("identity");
  const [detailAudit, setDetailAudit] = useState<AuditInfo[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [self, setSelf] = useState<ManagedUser | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [audit, setAudit] = useState<AuditInfo[]>([]);
  const [selected, setSelected] = useState<ManagedUser | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionError, setSessionError] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [invite, setInvite] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [issued, setIssued] = useState<MutationResult | null>(null);
  const [issuedTitle, setIssuedTitle] = useState("");
  const refreshVersion = useRef(0);
  const sessionVersion = useRef(0);
  const [reauthForm] = Form.useForm();
  const clearIdentityState = useCallback(() => {
    sessionVersion.current++; refreshVersion.current++;
    setIdentity(null); setSelected(null); setPending(null); setPasswordOpen(false); setIssued(null); setInvite(false);
    setUsers([]); setAudit([]); setSelf(null); setSessions([]); setSessionError("");
    setTotal(0); setPage(1); setSearch(""); setView("members"); setSection("identity");
    setLoading(false); setBusy(false); reauthForm.resetFields();
  }, [reauthForm]);
  const expired = useCallback(() => { clearIdentityState(); setError("会话已失效，请重新登录"); }, [clearIdentityState]);
  const signedIn = useCallback((state: { identity: Identity; csrf: string }) => { clearIdentityState(); configureSession(state.csrf, expired); setIdentity(state.identity); setSection("identity"); setError(""); }, [clearIdentityState, expired]);
  useEffect(() => {
    let cancelled = false; configureSession("", expired);
    if (!initialChallenge) void api.me().then(state => { if (!cancelled) signedIn(state); }).catch(e => {
      if (cancelled) return;
      // A missing initial session is the normal login state; network failures remain visible.
      setError(e instanceof ApiError && e.status === 401 ? "" : errorText(e));
    }).finally(() => { if (!cancelled) setBoot(false); });
    return () => { cancelled = true; };
  }, [expired, initialChallenge, signedIn]);
  useEffect(() => {
    let cancelled = false; const version = sessionVersion.current;
    setSelf(null);
    if (identity && !identity.mustChangePassword) {
      const current = () => !cancelled && version === sessionVersion.current;

      void api.users(identity.email, ADMIN_LIMITS.page, 0, "crm").then(result => { if (current()) setSelf(result.items.find(u => u.userId === identity.userId) ?? null); }).catch(() => {
        // No member-read capability means no delegation preview; editing remains disabled.
        if (current()) setSelf(null);
      });
    }
    return () => { cancelled = true; };
  }, [identity]);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    if (!identity || identity.mustChangePassword || section === "products" || section === "operations") return;
    setLoading(true); setError("");
    try {
      if (view === "audit") { const result = await api.audit(identity.identityAdmin ? undefined : "crm"); if (version === refreshVersion.current) setAudit(result); }
      else { const result = await api.users(search, ADMIN_LIMITS.page, (page - 1) * ADMIN_LIMITS.page, identity.identityAdmin ? undefined : "crm"); if (version === refreshVersion.current) { setUsers(result.items); setTotal(result.total); } }
    } catch (e) { if (version === refreshVersion.current) { setUsers([]); setAudit([]); setError(errorText(e)); } } finally { if (version === refreshVersion.current) setLoading(false); }
  }, [identity, section, view, search, page]);
  useEffect(() => { void refresh(); return () => { refreshVersion.current++; }; }, [refresh]);
  useEffect(() => {
    let cancelled = false; const version = sessionVersion.current;
    setSessions([]); setSessionError(""); setDetailProduct("crm"); setDetailView("identity");
    if (selected && identity?.identityAdmin) void api.sessions(selected.userId).then(result => { if (!cancelled && version === sessionVersion.current) setSessions(result); }).catch(e => { if (!cancelled && version === sessionVersion.current) setSessionError(errorText(e)); });
    return () => { cancelled = true; };
  }, [selected, identity]);
  useEffect(() => {
    let cancelled = false; const version = sessionVersion.current;
    setDetailAudit([]); setDetailError(""); setDetailLoading(false);
    if (selected && detailView === "audit" && detailProduct !== "navigator") {
      setDetailLoading(true);
      void api.audit(detailProduct === "identity" ? undefined : detailProduct, selected.userId)
        .then(result => { if (!cancelled && version === sessionVersion.current) setDetailAudit(result); })
        .catch(e => { if (!cancelled && version === sessionVersion.current) setDetailError(errorText(e)); })
        .finally(() => { if (!cancelled && version === sessionVersion.current) setDetailLoading(false); });
    }
    return () => { cancelled = true; };
  }, [selected, detailView, detailProduct]);
  const canAccess = !!self?.accessActive && self.capabilities.includes("access.manage");
  const canRoles = !!self?.accessActive && self.capabilities.includes("roles.manage");
  const canReadOperations = !!identity?.identityAdmin || !!self?.accessActive && self.scope === "summary" && self.capabilities.includes("metrics.read") && self.crmRoles.some(role => role === "admin" || role === "auditor");
  const saveDirect = async (command: AdminCommand, password?: string) => {
    const version = sessionVersion.current; setBusy(true); setError("");
    try { password === undefined ? await api.command(command) : await api.command(command, password); if (version !== sessionVersion.current) return; setInvite(false); setSelected(null); void message.success(command.action === "user.create" ? "账号已创建，首次登录必须修改初始密码" : "已保存"); await refresh(); const state = await api.me(); if (version === sessionVersion.current) { configureSession(state.csrf, expired); setIdentity(state.identity); } }
    catch (e) { if (version === sessionVersion.current) setError(errorText(e)); }
    finally { if (version === sessionVersion.current) setBusy(false); }
  };
  const queue = (title: string, command: Pending["command"], targetEmail?: string, deletion = false) => { setError(""); reauthForm.resetFields(); setPending({ title, command, targetEmail, deletion }); };
  const mutate = async (values: { password: string; reason?: string }) => {
    if (!pending) return; const version = sessionVersion.current; setBusy(true); setError("");
    try { const result = await api.command(pending.command(pending.deletion ? values.reason ?? "" : values.reason!), values.password); if (version !== sessionVersion.current) return; setPending(null); reauthForm.resetFields(); setSelected(null); setIssuedTitle(pending.title); setIssued(result.challengeToken ? result : null); void message.success("操作已完成，已记录审计原因"); await refresh(); if (identity && version === sessionVersion.current) { const state = await api.me(); if (version === sessionVersion.current) { configureSession(state.csrf, expired); setIdentity(state.identity); } } }
    catch (e) { if (version === sessionVersion.current) setError(errorText(e)); } finally { if (version === sessionVersion.current) setBusy(false); }
  };
  const logout = async () => {
    const version = sessionVersion.current; setBusy(true);
    try { await api.logout(); if (version === sessionVersion.current) { clearIdentityState(); configureSession("", expired); setError(""); } }
    catch (e) { if (version === sessionVersion.current) setError(errorText(e)); } finally { if (version === sessionVersion.current) setBusy(false); }
  };
  const login = async (values: { email: string; password: string }) => { setBusy(true); setError(""); try { signedIn(await api.login(values.email, values.password)); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const consume = async (values: { password: string }) => { if (!challenge) return; setBusy(true); setError(""); try { await api.challenge(challenge, values.password); setChallenge(null); void message.success("密码已设置，一次性链接已使用，请登录"); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } };
  const changePassword = async(values:{currentPassword:string;newPassword:string}) => {
    const version=sessionVersion.current;setBusy(true);setError('');
    try {await api.password(values.currentPassword,values.newPassword);if(version!==sessionVersion.current)return;setPasswordOpen(false);clearIdentityState();configureSession('',expired);void message.success('密码已更新，请使用新密码重新登录');}
    catch(e){if(version===sessionVersion.current)setError(errorText(e));}finally{if(version===sessionVersion.current)setBusy(false);}
  };
  const style = { "--page-bg": dark ? "#141414" : "#f5f5f5", "--surface": dark ? "#1a1a1a" : "#fff", "--border": dark ? "#404040" : "#e0e0e0", "--text": dark ? "#eee" : "#1a1a1a" } as CSSProperties;
  return <div className="shell" style={style}>
    <header className="topbar"><div className="brand">Milogin<span>管理中心</span></div><Space><Button type="text" onClick={toggleTheme}>{dark ? "浅色" : "深色"}</Button>{identity && <><span>{identity.displayName}</span><Button type="text" onClick={() => { setError(""); setPasswordOpen(true); }}>修改密码</Button><Button loading={busy} onClick={() => void logout()}>退出</Button></>}</Space></header>
    {boot ? <div className="login-wrap"><Spin tip="正在检查会话"/></div> : !identity || challenge ? <div className="login-wrap"><div className="login-form"><h1>{challenge ? "设置账号密码" : "登录管理工作台"}</h1><p className="muted">{challenge ? "一次性激活或恢复链接；完成后重新登录。" : "使用已获授权的管理账号。"}</p>{error && <Alert type="error" message={error} showIcon className="section-gap"/>}<Form layout="vertical" onFinish={challenge ? consume : login}>{!challenge && <Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email", message: "请输入有效邮箱" }]}><Input autoComplete="username" maxLength={AUTH_LIMITS.emailMax}/></Form.Item>}<Form.Item name="password" label={challenge ? "新密码" : "密码"} rules={[{ required: true, message: "请输入密码" }, ...(challenge ? [{ min: AUTH_LIMITS.passwordMin, message: `至少 ${AUTH_LIMITS.passwordMin} 位` }, { pattern: PASSWORD_PATTERN, message: "仅允许英文字母和数字" }] : [])]}><Input.Password autoComplete={challenge ? "new-password" : "current-password"} maxLength={AUTH_LIMITS.passwordMax}/></Form.Item>{challenge && <Form.Item name="confirm" label="确认新密码" dependencies={["password"]} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, value) => value === getFieldValue("password") ? Promise.resolve() : Promise.reject(new Error("两次密码不一致")) })]}><Input.Password autoComplete="new-password"/></Form.Item>}<Button type="primary" htmlType="submit" loading={busy} block>{challenge ? "设置密码" : "登录"}</Button></Form></div></div> : identity.mustChangePassword ? <div className="login-wrap"><div className="login-form"><h1>首次登录，请修改密码</h1><p className="muted">修改初始密码后才能使用管理工作台。新密码至少6位，仅允许英文字母和数字。</p>{error&&<Alert type="error" message={error} showIcon/>}<Form layout="vertical" onFinish={changePassword}><Form.Item name="currentPassword" label="当前密码" rules={[{required:true}]}><Input.Password autoComplete="current-password" maxLength={AUTH_LIMITS.passwordMax}/></Form.Item><Form.Item name="newPassword" label="新密码" rules={[{required:true},{min:AUTH_LIMITS.passwordMin,message:'至少6位'},{pattern:PASSWORD_PATTERN,message:'仅允许英文字母和数字'}]}><Input.Password autoComplete="new-password" maxLength={AUTH_LIMITS.passwordMax}/></Form.Item><Form.Item name="confirm" label="确认新密码" dependencies={['newPassword']} rules={[{required:true},({getFieldValue})=>({validator:(_,value)=>value===getFieldValue('newPassword')?Promise.resolve():Promise.reject(new Error('两次密码不一致'))})]}><Input.Password autoComplete="new-password"/></Form.Item><Button type="primary" htmlType="submit" loading={busy} block>修改密码并重新登录</Button></Form></div></div> : <div className="workspace">
      <aside className="sidebar"><Menu mode="inline" defaultOpenKeys={['products']} selectedKeys={[section === 'products' ? managedProduct : section]} onClick={({ key }) => { if (key === 'prospector' || key === 'navigator') { setManagedProduct(key); setSection('products'); } else { setSection(key as Section); } setView("members"); setPage(1); setSearch(""); setSelected(null); }} items={[{ key: "identity", label: "用户管理中心" }, ...(canReadOperations ? [{ key: "operations", label: "系统运行" }] : []), { key: "products", label: "产品管理中心", children: [{ key: 'prospector', label: 'Prospector' }, { key: 'navigator', label: 'Navigator' }] }]}/></aside>
      <main className="content"><div hidden={!!selected}>
        {section !== "operations" && <div className="toolbar"><h1>{section === "identity" ? "用户管理中心" : "产品管理中心"}</h1>{section === "identity" && <Space>{identity.identityAdmin && <Button onClick={() => setInvite(true)}type="primary">创建用户</Button>}<Button onClick={() => void refresh()}>刷新</Button></Space>}</div>}
        {error && <Alert type="error" message={error} showIcon closable onClose={() => setError("")} style={{ marginBottom: 16 }}/>} 
        {section === "operations" ? <OperationsManagement identity={identity}/> : section === "products" ? <ProductManagement identity={identity} product={managedProduct}/> : <>
          <div className="account-list-card"><Tabs activeKey={view} onChange={setView} items={[{ key: "members", label: "用户" }, { key: "audit", label: "管理审计" }]}/>
          {view === "audit" ? <Table size="small" rowKey="id" loading={loading} dataSource={audit} scroll={{ x: 720 }} locale={{ emptyText: <Empty description="暂无管理审计记录"/> }} columns={[{ title: "时间", dataIndex: "createdAt", render: date }, { title: "操作人", dataIndex: "actorName" }, { title: "对象", dataIndex: "targetName" }, { title: "操作", dataIndex: "action" }, { title: "原因", dataIndex: "reason" }]} pagination={{ pageSize: ADMIN_LIMITS.page }}/> : <>
            <div className="toolbar"><Input.Search placeholder="搜索姓名或邮箱" allowClear maxLength={ADMIN_LIMITS.searchMax} style={{ width: 320, maxWidth: "100%" }} value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} onSearch={() => void refresh()}/><Typography.Text type="secondary">共 {total} 位用户</Typography.Text></div>
            <Table size="small" rowKey="userId" loading={loading} dataSource={users} scroll={{ x: 650 }} locale={{ emptyText: <Empty description="没有匹配用户"/> }} pagination={{ current: page, pageSize: ADMIN_LIMITS.page, total, showSizeChanger: false, onChange: setPage }} columns={[
              { title: "人员 / 账号", dataIndex: "displayName", render: (name: string, user: ManagedUser) => <div className="account-cell"><Button type="link" style={{ padding: 0 }} onClick={() => setSelected(user)}>{name}</Button><span>{user.email}</span></div> },
              { title: "登录状态", render: (_, u: ManagedUser) => <span className={u.active ? "account-status enabled" : "account-status"}>{u.active ? "可登录" : "已停用"}</span> },
              { title: "身份", render: (_, u: ManagedUser) => identityRoleLabel(u) },
              { title: "邮箱状态", render: (_, u: ManagedUser) => u.emailVerified ? "已验证" : "待验证" },
              { title: "操作", render: (_, u: ManagedUser) => <Button type="link" onClick={() => setSelected(u)}>查看档案</Button> }
            ]}/>
          </>}
        </div></>}
      </div>{selected && <section className="account-detail">
      <div className="account-breadcrumb"><Button type="link" onClick={() => setSelected(null)}>用户管理中心</Button><span>/ {selected.displayName}</span></div>
      <header className="account-person"><div className="account-avatar">{Array.from(selected.displayName)[0]}</div><div><h2>{selected.displayName}</h2><div className="account-person-meta"><span>{identityRoleLabel(selected)}</span><span className={selected.active ? "account-status enabled" : "account-status"}>{selected.active ? "可登录" : "已停用"}</span></div><p>{selected.email}</p></div><Button className="account-back" onClick={() => setSelected(null)}>返回列表</Button></header>
      <div className="account-detail-body"><Tabs activeKey={detailView} onChange={key => { setDetailView(key); if (detailProduct === "identity") setDetailProduct("crm"); }} items={[{ key: "identity", label: "账号档案", children: <><dl className="account-profile"><dt>显示名称</dt><dd>{selected.displayName}</dd><dt>登录邮箱</dt><dd>{selected.email}</dd><dt>账号编号</dt><dd>{selected.userId}</dd><dt>身份</dt><dd>{identityRoleLabel(selected)}</dd><dt>登录状态</dt><dd>{selected.active ? "可登录" : "已停用"}</dd><dt>邮箱状态</dt><dd>{selected.emailVerified ? "已验证" : "待验证"}</dd></dl></> }, { key: "security", label: "安全与登录", children: <><p>全局身份：{selected.active ? "启用" : "停用"} · {selected.identityAdmin ? "超级管理员" : "普通身份"}</p>{identity?.identityAdmin && <Form layout="vertical" initialValues={{ active: selected.active, identityAdmin: selected.identityAdmin }} onFinish={(v: { active: boolean; identityAdmin: boolean }) => void saveDirect({ action: "user.update", userId: selected.userId, revision: selected.revision, ...v, reason: "用户管理中心保存账号权限" })}><Form.Item name="active" label="全局账号启用" valuePropName="checked"><Switch/></Form.Item><Form.Item name="identityAdmin" label="超级管理员权限" valuePropName="checked"><Switch/></Form.Item><Button htmlType="submit" loading={busy}>保存配置</Button></Form>}{identity?.identityAdmin && <div className="account-actions"><Button disabled={!selected.active || selected.userId === identity.userId} onClick={() => queue("重置密码", reason => ({ action: "user.reset-password", userId: selected.userId, revision: selected.revision, reason: reason ?? "" }), selected.email)}>重置密码</Button></div>}<h3 className="section-gap">会话</h3>{identity?.identityAdmin ? <>{sessionError && <Alert type="error" message={sessionError}/>}<Table size="small" rowKey="sessionId" dataSource={sessions} pagination={false} columns={[{ title: "设备类型", dataIndex: "client" }, { title: "到期", dataIndex: "expiresAt", render: date }, { title: "状态", render: (_, s: SessionInfo) => s.revoked ? "已撤销" : "有效" }, { title: "", render: (_, s: SessionInfo) => <Button disabled={s.revoked} onClick={() => queue("撤销该会话", reason => ({ action: "session.revoke", userId: selected.userId, sessionId: s.sessionId, reason: reason ?? "" }))}>撤销</Button> }]}/></> : <Typography.Text type="secondary">需要身份会话管理权限</Typography.Text>}</> }, { key: "product", label: "产品权限", children: <>
      <div className="product-selector"><Select aria-label="权限产品" value={detailProduct} onChange={setDetailProduct} options={[{ value: "crm", label: "Prospector" }, { value: "navigator", label: "Navigator" }]}/></div>
      {detailProduct === "crm" ? <ProductEditor key={`${selected.userId}-${selected.revision}`} user={selected} canAccess={canAccess} canRoles={canRoles} delegable={delegationCapabilities(self)} scopeCeiling={self?.scope ?? "own"} submit={v => void saveDirect({ action: "product.update", userId: selected.userId, revision: selected.revision, productId: "crm", ...v, reason: "用户管理中心保存产品权限" })}/> : <NavigatorEditor key={`${selected.userId}-${selected.revision}`} user={selected} editable={identity.identityAdmin} submit={v => void saveDirect({ action: "navigator.update", userId: selected.userId, revision: selected.revision, ...v, reason: "用户管理中心保存 Navigator 权限" })}/>}
    </> }, { key: "activity", label: "交互记录", children: <>
      <div className="product-selector"><Select aria-label="记录产品" value={detailProduct} onChange={setDetailProduct} options={[{ value: "crm", label: "Prospector" }, { value: "navigator", label: "Navigator" }]}/></div>
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={detailProduct === "crm" ? "Prospector 用户交互记录尚未接入" : "Navigator 用户交互记录尚未接入"}/>
    </> }, { key: "audit", label: "管理审计", children: <>
      <div className="product-selector"><Select aria-label="审计范围" value={detailProduct} onChange={setDetailProduct} options={[...(identity?.identityAdmin ? [{ value: "identity", label: "账号与安全" }] : []), { value: "crm", label: "Prospector" }, { value: "navigator", label: "Navigator" }]}/></div>
      {detailError && <Alert type="error" message={detailError} showIcon/>}
      <Table size="small" rowKey="id" loading={detailLoading} dataSource={detailAudit} pagination={{ pageSize: ADMIN_LIMITS.page }} locale={{ emptyText: "暂无该用户的管理审计记录" }} columns={[{ title: "时间", dataIndex: "createdAt", render: date }, { title: "操作人", dataIndex: "actorName" }, { title: "操作", dataIndex: "action" }, { title: "原因", dataIndex: "reason" }]}/>
    </> }]}/>{identity?.identityAdmin && <div className="danger-zone"><Button danger disabled={selected.userId === identity.userId} onClick={() => queue("删除用户", reason => ({ action: "user.delete", userId: selected.userId, revision: selected.revision, reason }), selected.email, true)}>删除用户</Button></div>}</div></section>}
      </main>
    </div>}


    <Modal title="修改密码" open={passwordOpen} onCancel={() => { setPasswordOpen(false); setError(""); }} footer={null} destroyOnClose><Alert className="section-gap" type="info" message="修改后，当前账号的所有设备都会退出登录。"/>{error && <Alert className="section-gap" type="error" message={error} showIcon/>}<Form layout="vertical" onFinish={changePassword}><Form.Item name="currentPassword" label="当前密码" rules={[{required:true,message:"请输入当前密码"}]}><Input.Password autoComplete="current-password" maxLength={AUTH_LIMITS.passwordMax}/></Form.Item><Form.Item name="newPassword" label="新密码" rules={[{required:true,message:"请输入新密码"},{min:AUTH_LIMITS.passwordMin,message:`至少 ${AUTH_LIMITS.passwordMin} 位`},{pattern:PASSWORD_PATTERN,message:"仅允许英文字母和数字"}]}><Input.Password autoComplete="new-password" maxLength={AUTH_LIMITS.passwordMax}/></Form.Item><Form.Item name="confirm" label="确认新密码" dependencies={["newPassword"]} rules={[{required:true,message:"请再次输入新密码"},({getFieldValue})=>({validator:(_,value)=>value===getFieldValue("newPassword")?Promise.resolve():Promise.reject(new Error("两次密码不一致"))})]}><Input.Password autoComplete="new-password" maxLength={AUTH_LIMITS.passwordMax}/></Form.Item><Button type="primary" htmlType="submit" loading={busy} block>修改密码并重新登录</Button></Form></Modal>

    <Modal title={pending?.title} open={!!pending} onCancel={() => { setPending(null); reauthForm.resetFields(); }} footer={null} destroyOnClose>{pending?.deletion && <Alert className="section-gap" type="warning" message="删除后无法登录，历史业务记录保留。"/>}{pending?.deletion && <Typography.Text>请二次确认用户邮箱：{pending.targetEmail}</Typography.Text>}{pending?.title !== "删除用户" && <Typography.Text>{pending?.targetEmail}</Typography.Text>}{pending?.title === "重置密码" && <Alert className="section-gap" type="warning" message="该用户所有设备将退出登录。"/>}{error && <Alert type="error" message={error}/>}<Form form={reauthForm} layout="vertical" onFinish={mutate}>{pending?.deletion && <Form.Item name="confirmEmail" label="再次输入用户邮箱" rules={[{ required: true, message: "请再次输入用户邮箱" }, { validator: (_, value) => value === pending.targetEmail ? Promise.resolve() : Promise.reject(new Error("邮箱不一致")) }]}><Input autoComplete="off" spellCheck={false}/></Form.Item>}<Form.Item name="password" label="请验证管理员密码" rules={[{ required: true, message: "请输入当前管理员密码" }]}><Input.Password autoComplete="current-password" maxLength={AUTH_LIMITS.passwordMax}/></Form.Item><Form.Item name="reason" label="操作原因（可选）" rules={pending?.deletion ? [] : [{ required: true, whitespace: true, message: "请填写原因" }]}><Input.TextArea maxLength={ADMIN_LIMITS.reasonMax} showCount/></Form.Item><Button type="primary" htmlType="submit" loading={busy}>确认变更</Button></Form></Modal>
    <Modal title="创建用户" open={invite} onCancel={() => setInvite(false)} footer={null} destroyOnClose>{error && <Alert type="error" message={error}/>}<Alert className="section-gap" type="info" message="请设置初始密码并安全交给本人；首次登录后必须修改。"/><Form layout="vertical" initialValues={{ role: "sales" }} onFinish={(v: { email: string; role: CrmRole; password: string }) => void saveDirect({ action: "user.create", email: v.email, role: v.role, reason: "用户管理中心创建账号" }, v.password)}><Form.Item name="email" label="邮箱" rules={[{ required: true, type: "email" }]}><Input maxLength={AUTH_LIMITS.emailMax} autoComplete="off" spellCheck={false}/></Form.Item><Form.Item name="role" label="身份" rules={[{ required: true }]}><Select options={CRM_ROLES.map(role => ({ value: role, label: ROLE_NAMES[role] }))}/></Form.Item><Form.Item name="password" label="初始密码" rules={[{ required: true, message: "请设置初始密码" }, { min: AUTH_LIMITS.passwordMin, message: `至少 ${AUTH_LIMITS.passwordMin} 位` }, { pattern: PASSWORD_PATTERN, message: "仅允许英文字母和数字" }]}><Input.Password autoComplete="new-password" maxLength={AUTH_LIMITS.passwordMax}/></Form.Item><Form.Item name="confirm" label="确认初始密码" dependencies={["password"]} rules={[{ required: true, message: "请再次输入初始密码" }, ({ getFieldValue }) => ({ validator: (_, value) => value === getFieldValue("password") ? Promise.resolve() : Promise.reject(new Error("两次密码不一致")) })]}><Input.Password autoComplete="new-password" maxLength={AUTH_LIMITS.passwordMax}/></Form.Item><Button type="primary" htmlType="submit" loading={busy}>创建用户</Button></Form></Modal>
    <Modal title={issuedTitle === "重置密码" ? "密码重置链接" : "账号激活链接"} open={!!issued} onCancel={() => setIssued(null)} footer={<Button onClick={() => setIssued(null)}>关闭并清除链接</Button>} destroyOnClose><Alert type="warning" message="链接未通过邮件发送，请复制交给本人。仅可使用一次。"/><p>到期：{issued?.expiresAt ? date(issued.expiresAt) : "见服务端有效期"}</p><Typography.Text className="one-time-link">{issued?.challengeToken ? `${window.location.origin}/?challenge=${encodeURIComponent(issued.challengeToken)}` : ""}</Typography.Text><Button className="section-gap" onClick={() => { if (issued?.challengeToken) void navigator.clipboard.writeText(`${window.location.origin}/?challenge=${encodeURIComponent(issued.challengeToken)}`).then(() => { void message.success("链接已复制"); }).catch(() => { void message.error("复制失败，请手动复制"); }); }}>复制链接</Button></Modal>
  </div>;
}

function ProductEditor({ user, canAccess, canRoles, delegable, scopeCeiling, submit }: { user: ManagedUser; canAccess: boolean; canRoles: boolean; delegable: string[]; scopeCeiling: DataScope; submit: (v: { active: boolean; role: CrmRole; roles: CrmRole[]; capabilities: string[]; scope: DataScope }) => void }) {
  const [active, setActive] = useState(user.accessActive);
  const [role, setRole] = useState<CrmRole | undefined>(productRoleFor(user.crmRoles));
  const permitted = (value: CrmRole) => {
    const grant = productPermissionsFor(value);
    return grant.capabilities.every(capability => delegable.includes(capability)) && scopesFor(grant.roles, scopeCeiling).includes(grant.scope);
  };
  return <Form layout="vertical"><Form.Item label="产品准入"><Switch checked={active} onChange={setActive} disabled={!canAccess}/></Form.Item><Form.Item label="身份"><Select aria-label="产品身份" value={role} placeholder="选择身份" disabled={!canRoles} onChange={setRole} options={CRM_ROLES.map(value => ({ value, label: ROLE_NAMES[value], disabled: !permitted(value) }))}/></Form.Item><Button className="section-gap" disabled={(!canAccess && !canRoles) || !role || !permitted(role)} onClick={() => { if (role) submit({ active, role, ...productPermissionsFor(role) }); }}>保存配置</Button></Form>;
}

function NavigatorEditor({ user, editable, submit }: { user: ManagedUser; editable: boolean; submit: (v: { active: boolean; role: "operations" | "sales" }) => void }) {
  const [active, setActive] = useState(user.navigatorActive);
  const [role, setRole] = useState<"operations" | "sales" | undefined>(user.navigatorRole ?? undefined);
  if(user.identityAdmin) return <Typography.Text>中心超级管理员 · Navigator 管理员</Typography.Text>;
  return <Form layout="vertical"><Form.Item label="Navigator 准入"><Switch checked={active} onChange={setActive} disabled={!editable}/></Form.Item><Form.Item label="运价库身份"><Select aria-label="Navigator 身份" value={role} placeholder="选择身份" disabled={!editable} onChange={setRole} options={[{value:"operations",label:"航管"},{value:"sales",label:"销售"}]}/></Form.Item><Button className="section-gap" disabled={!editable || !role} onClick={() => { if(role) submit({active,role}); }}>保存配置</Button></Form>;
}









