import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { DownOutlined, CloseOutlined } from '@ant-design/icons';
import type { LoginAccount, OnlineHandoffBeginResult, OnlineLogin, Result } from '../../shared/online-crm';
import { AUTH_LIMITS } from '../../shared/online-crm';
import { useIdentity } from '../IdentityContext';
import { DotPattern } from './ui/dot-pattern';
import { DiamondLogo } from './DiamondLogo';
import { TitleBar } from './layout/AppLayout';
import './OnboardingWizard.css';
import './ProductLogin.css';
import { subscribeWorkspaceDark, workspaceDarkEnabled } from '../lib/workspace-preferences';

const PASSWORD_MIN_LENGTH = AUTH_LIMITS.passwordMin;
const MASCOT_SIZE = 52;
const HANDOFF_POLL_MS = 2000;
const HANDOFF_REQUEST_KEY_PREFIX = 'prospector.handoff.request.';
type PendingReplacement = { login: OnlineLogin; requestKey: string };

function handoffRequestStorageKey(baseUrl: string, email: string) {
  return `${HANDOFF_REQUEST_KEY_PREFIX}${encodeURIComponent(baseUrl)}:${encodeURIComponent(email.trim().toLowerCase())}`;
}

function createHandoffRequestKey() {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
}

function handoffRequestKey(baseUrl: string, email: string) {
  const storageKey = handoffRequestStorageKey(baseUrl, email);
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved && /^[A-Za-z0-9_-]{8,128}$/.test(saved)) return saved;
  } catch { /* Local storage can be unavailable in hardened test shells; a per-login key still works. */ }
  const created = createHandoffRequestKey();
  try { localStorage.setItem(storageKey, created); } catch { /* Do not fail login only because idempotency cannot be persisted. */ }
  return created;
}

function clearHandoffRequestKey(baseUrl: string, email: string) {
  try { localStorage.removeItem(handoffRequestStorageKey(baseUrl, email)); } catch { /* Cleanup is best effort; the server still expires stale requests. */ }
}

/** The original onboarding surface, adapted only for product authentication. */
export function ProductLogin() {
  const session = useIdentity();
  const [workspaceDark, setWorkspaceDark] = useState(workspaceDarkEnabled);
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // Desktop work must survive a center outage. Users can still opt out before login.
  const [remember, setRemember] = useState(true);
  const [autoLogin, setAutoLogin] = useState(true);
  const [accountId, setAccountId] = useState<string>();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [pendingReplacement, setPendingReplacement] = useState<PendingReplacement>();
  const [handoff, setHandoff] = useState<OnlineHandoffBeginResult>();
  const [handoffPolling, setHandoffPolling] = useState(false);
  const initialAccountChosen = useRef(false);
  const handoffRun = useRef(0);
  const accountField = useRef<HTMLDivElement>(null);
  const accounts = (session.accounts ?? []).filter(account => !!account.email);
  const selected = accounts.find(account => account.accountId === accountId && account.email === email);
  const savedCredential = Boolean(!creating && selected?.remembered && remember && !password);
  const blockers = handoff?.state.summary?.blockers ?? [];
  const blockedMessage = blockers.length > 1 ? `${blockers[0]}（共 ${blockers.length} 项）` : blockers[0];
  const loginMessage = handoff ? handoff.state.status === 'ready'
    ? '原电脑已完成数据准备，正在切换。'
    : handoff.state.status === 'blocked'
      ? blockedMessage || '原电脑还有内容没有处理完。'
      : handoff.state.status === 'waiting_old_device'
        ? `正在等待 ${handoff.state.oldDeviceName || '原电脑'} 整理数据。原电脑上线后会自动继续。`
        : '本次换机已结束，请重新登录。'
    : pendingReplacement ? '该账号正在另一台电脑使用。换机前会先检查原电脑的数据。' : session.error || notice;
  const canTakeOver = Boolean(pendingReplacement && handoff && ['waiting_old_device', 'blocked'].includes(handoff.state.status));
  useEffect(() => subscribeWorkspaceDark(setWorkspaceDark), []);
  useEffect(() => () => { handoffRun.current++; }, []);
  function chooseAccount(account: LoginAccount) {
    initialAccountChosen.current = true;setEmail(account.email);setPassword('');setAccountId(account.accountId);
    setRemember(account.remembered);setAutoLogin(account.autoLogin);setAccountsOpen(false);setNotice('');setPendingReplacement(undefined);
  }
  useEffect(() => {
    if(initialAccountChosen.current || !accounts.length)return;
    const initial = accounts.find(account => account.accountId === session.selectedAccountId) ?? accounts[0];
    if(initial)chooseAccount(initial);
  }, [session.accounts, session.selectedAccountId]);
  useEffect(() => {
    if(!accountsOpen)return;
    const close = (event:PointerEvent) => {if(!accountField.current?.contains(event.target as Node))setAccountsOpen(false);};
    const escape = (event:KeyboardEvent) => {if(event.key==='Escape')setAccountsOpen(false);};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
    return () => {document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};
  }, [accountsOpen]);
  const restricted = Boolean(session.identity?.mustChangePassword);
  function resetHandoff(login?: OnlineLogin) {
    handoffRun.current++;
    if (login) clearHandoffRequestKey(login.baseUrl, login.email);
    setHandoff(undefined);
    setPendingReplacement(undefined);
    setHandoffPolling(false);
  }
  async function pollHandoff(token: string, login: OnlineLogin, run: number) {
    setHandoffPolling(true);
    try {
      while (handoffRun.current === run) {
        const current = await session.handoffStatus({ handoffToken: token });
        if (handoffRun.current !== run) return;
        if (!current.ok) { setNotice(current.error.message); resetHandoff(); return; }
        if (['completed', 'cancelled', 'expired'].includes(current.data.status)) {
          setNotice(current.data.status === 'completed' ? '换机已完成，请重新登录。' : '本次换机已失效，请重新登录。');
          resetHandoff(login);
          return;
        }
        setHandoff((value: OnlineHandoffBeginResult | undefined) => value ? { ...value, state: current.data } : value);
        if (current.data.status === 'ready') {
          const completed = await session.completeHandoff({ handoffToken: token, remember: login.remember, autoLogin: login.autoLogin });
          if (handoffRun.current !== run) return;
          if (completed.ok) clearHandoffRequestKey(login.baseUrl, login.email);
          else setNotice(completed.error.message);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, HANDOFF_POLL_MS));
      }
    } finally { if (handoffRun.current === run) setHandoffPolling(false); }
  }
  async function replaceActiveDevice() {
    const pending=pendingReplacement;if(!pending)return;
    if (handoff) {
      if (!canTakeOver) return;
      const confirmed = window.confirm(`原电脑仍可能在同步数据。确定已经无法使用 ${handoff.state.oldDeviceName || '原电脑'}，并在这台电脑继续吗？`);
      if (!confirmed) return;
      handoffRun.current++;
      setHandoffPolling(false);
      setNotice('');
      const result = await session.takeoverHandoff({
        handoffToken: handoff.handoffToken,
        reason: '旧电脑无法使用，用户确认继续接管',
        remember: pending.login.remember,
        autoLogin: pending.login.autoLogin,
      });
      if (result.ok) clearHandoffRequestKey(pending.login.baseUrl, pending.login.email);
      else setNotice(result.error.message);
      return;
    }
    if (session.busy || handoffPolling) return;
    setNotice('');
    const started = await session.beginHandoff({ ...pending.login, requestKey: pending.requestKey });
    if (!started.ok) { setNotice(started.error.message); return; }
    setHandoff(started.data);
    const run = ++handoffRun.current;
    void pollHandoff(started.data.handoffToken, pending.login, run);
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (session.busy) return;
    const form = new FormData(event.currentTarget);
    if (restricted) {
      const newPassword = String(form.get('newPassword') ?? '');
      if (newPassword !== form.get('confirmation')) { setNotice('两次密码不一致'); return; }
      setNotice('');
      void session.changePassword({ currentPassword: String(form.get('currentPassword') ?? ''), newPassword });
    } else if (creating) {
      const password = String(form.get('password') ?? '');
      if (password !== form.get('confirmation')) { setNotice('两次密码不一致'); return; }
      const accountEmail = String(form.get('email') ?? '').trim();
      setNotice('');
      if (await session.register({ email: accountEmail, password })) {
        setEmail(accountEmail); setCreating(false); setNotice('账号已创建，请登录');
      }
    } else {
      setNotice('');
      setAccountsOpen(false);
      handoffRun.current++;
      setPendingReplacement(undefined);
      setHandoff(undefined);
      if(savedCredential && selected) void session.loginAccount({accountId:selected.accountId,autoLogin});
      else {
        const accountEmail = String(form.get('email') ?? '').trim();
        const accountPassword = String(form.get('password') ?? '');
        const result = await session.login({ baseUrl: session.baseUrl, email: accountEmail, password: accountPassword, remember, autoLogin:remember&&autoLogin }) as Result<void>|boolean|undefined;
        const failureCode = result && typeof result === 'object' && 'ok' in result && !result.ok ? result.error.code : undefined;
        if (failureCode === 'DEVICE_REPLACEMENT_REQUIRED') {
          setPendingReplacement({login:{baseUrl:session.baseUrl,email:accountEmail,password:accountPassword,remember,autoLogin:remember&&autoLogin},requestKey:handoffRequestKey(session.baseUrl,accountEmail)});
        } else if (result === true || result && typeof result === 'object' && result.ok) setNotice('登录成功。发信邮箱请在设置中单独配置。');
      }
    }
  }
  const busyLabel = restricted ? '正在更新密码…' : creating ? '正在创建账号…' : '正在验证账号…';
  return <div className={`product-login${session.busy ? ' is-submitting' : ''}`}>
    <TitleBar tone={workspaceDark ? 'dark' : 'light'} transparent />
    <div className={`product-login-busybar${session.busy ? ' is-visible' : ''}`} role="status" aria-live="polite"><span>{session.busy ? busyLabel : ''}</span></div>
    <main className="ob-root show product-login-main">
      <DotPattern width={20} height={20} cr={1.3} className="product-login-pattern [mask-image:radial-gradient(560px_circle_at_50%_42%,white,transparent)]" />
      <section className={`ob-card product-login-card${!restricted && !creating ? ' product-login-card-signin' : ''}`} aria-labelledby="product-login-title">
        <div key={restricted ? 'password' : creating ? 'register' : 'login'} className="ob-step">
          <div className="product-login-mascot" aria-hidden="true"><DiamondLogo size={MASCOT_SIZE} state={session.busy ? 'running' : 'idle'} /></div>
          <div className="product-login-brand"><span className="product-login-brand-owner">Milogin’s</span><span className="product-login-brand-name">Prospector<span className="product-login-brand-dot">.</span></span></div>
          <h2 id="product-login-title" className={restricted || creating ? 'ob-h2' : 'sr-only'}>{restricted ? '设置您的新密码' : creating ? '创建账号' : '登录'}</h2>
          <form key={`${restricted}:${creating}`} onSubmit={event => void submit(event)} aria-busy={session.busy}>
            <fieldset className="product-login-fields" disabled={session.busy || Boolean(handoff)}>
              <div className="ob-form">
                {restricted ? <>
                  <p className="product-login-account">{session.identity?.email}</p>
                  <LoginField name="currentPassword" label="当前密码" type="password" autoComplete="current-password" />
                  <LoginField name="newPassword" label="新密码" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} placeholder={`至少 ${PASSWORD_MIN_LENGTH} 个字符`} />
                  <LoginField name="confirmation" label="确认新密码" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
                </> : <>
                  <div ref={accountField} className="product-login-account-field">
                    <LoginField name="email" label="邮箱" type="email" autoComplete="username" placeholder="your@email.com" value={email} onChange={value=>{initialAccountChosen.current=true;setEmail(value);setAccountId(undefined);setPassword('');setAutoLogin(false);setPendingReplacement(undefined);}}>
                      {!creating && accounts.length>0 && <button type="button" className="product-login-account-toggle" aria-label="选择账号" aria-expanded={accountsOpen} aria-controls="login-account-presets" onClick={()=>setAccountsOpen(value=>!value)}><DownOutlined/></button>}
                    </LoginField>
                    {!creating && accounts.length>0 && <div id="login-account-presets" className={`product-login-presets${accountsOpen?' is-open':''}`} role="group" aria-label="已保存账号" aria-hidden={!accountsOpen}>
                      <div className="product-login-presets-inner">
                        {accounts.map(account=><div key={account.accountId} className={`product-login-preset${account.accountId===accountId?' is-selected':''}`}>
                          <button type="button" className="product-login-preset-select" data-account-id={account.accountId} onClick={()=>chooseAccount(account)}><span className="product-login-preset-avatar" aria-hidden="true">{account.email.slice(0,1).toUpperCase()}</span><span>{account.email}</span></button>
                          <button type="button" className="product-login-preset-remove" aria-label={`移除 ${account.email}`} title="移除账号" onClick={()=>{void session.removeAccount(account.accountId).then(removed=>{if(removed&&account.accountId===accountId){setAccountId(undefined);setPassword('');setRemember(false);setAutoLogin(false);}});}}><CloseOutlined/></button>
                        </div>)}
                      </div>
                    </div>}
                  </div>
                  <LoginField name="password" label="密码" type="password" autoComplete={creating ? 'new-password' : 'current-password'} minLength={creating ? PASSWORD_MIN_LENGTH : undefined} placeholder={creating ? `至少${PASSWORD_MIN_LENGTH}个字符` : savedCredential ? '••••••••' : '请输入密码'} value={password} onChange={value=>{setPassword(value);setPendingReplacement(undefined);}} required={!savedCredential} />
                  {creating && <LoginField name="confirmation" label="确认密码" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />}
                </>}
              </div>
              {loginMessage && <div className="ob-error product-login-error" role="alert"><span>{loginMessage}</span>{pendingReplacement&&(!handoff||canTakeOver)&&<button className="product-login-replace" type="button" disabled={session.busy} onClick={()=>void replaceActiveDevice()}>{session.busy?'正在切换…':handoff?'旧电脑不可用，继续接管':'检查原电脑后换机'}</button>}</div>}
              <div className="ob-actions"><button className="ob-btn" type="submit" disabled={session.busy || Boolean(handoff)} aria-busy={session.busy}>{session.busy ? busyLabel : handoff ? '正在换机…' : restricted ? '修改密码并重新登录' : creating ? '创建账号' : '登录'}</button></div>
              {restricted ? <button className="ob-skip" type="button" onClick={() => void session.logout()}>返回登录</button> : <>
                <div className="product-login-links">
                  {!creating && <div className="product-login-options">
                    <label className="product-login-remember"><input name="remember" type="checkbox" checked={remember} onChange={event=>{setRemember(event.target.checked);if(!event.target.checked)setAutoLogin(false);setPendingReplacement(undefined);}} />记住密码</label>
                    <label className="product-login-remember"><input name="autoLogin" type="checkbox" checked={autoLogin} onChange={event=>{setAutoLogin(event.target.checked);if(event.target.checked)setRemember(true);setPendingReplacement(undefined);}} />自动登录</label>
                  </div>}
                  <div className="product-login-secondary-links">
                    <button className="ob-skip" type="button" onClick={() => { setNotice(''); setPassword('');setAccountsOpen(false);setCreating(value => !value); }}>{creating ? '返回登录' : '创建账号'}</button>
                    {!creating && <button className="ob-skip" type="button">忘记密码</button>}
                  </div>
                </div>
              </>}
            </fieldset>
          </form>
        </div>
      </section>
    </main>
  </div>;
}

function LoginField({ name, label, type, autoComplete, placeholder, minLength, defaultValue, value, onChange, required=true, children }: {
  name: string; label: string; type: string; autoComplete: string; placeholder?: string; minLength?: number; defaultValue?: string; value?:string;onChange?:(value:string)=>void;required?:boolean;children?:ReactNode;
}) {
  return <div className="ob-field"><label htmlFor={name}>{label}</label><input id={name} name={name} type={type} autoComplete={autoComplete} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={placeholder} minLength={minLength} defaultValue={defaultValue} value={value} onChange={onChange?event=>onChange(event.target.value):undefined} required={required} />{children}</div>;
}
