import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { DownOutlined, CloseOutlined } from '@ant-design/icons';
import type { LoginAccount } from '../../shared/online-crm';
import { AUTH_LIMITS } from '../../shared/online-crm';
import { useIdentity } from '../IdentityContext';
import { DotPattern } from './ui/dot-pattern';
import { DiamondLogo } from './DiamondLogo';
import { TitleBar } from './layout/AppLayout';
import './OnboardingWizard.css';
import './ProductLogin.css';
import { DEFAULT_MAIL_SERVERS } from '../../shared/mail-defaults';

const PASSWORD_MIN_LENGTH = AUTH_LIMITS.passwordMin;
const MASCOT_SIZE = 52;

/** The original onboarding surface, adapted only for product authentication. */
export function ProductLogin() {
  const session = useIdentity();
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [autoLogin, setAutoLogin] = useState(false);
  const [accountId, setAccountId] = useState<string>();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const initialAccountChosen = useRef(false);
  const accountField = useRef<HTMLDivElement>(null);
  const accounts = (session.accounts ?? []).filter(account => !!account.email);
  const selected = accounts.find(account => account.accountId === accountId && account.email === email);
  const savedCredential = Boolean(!creating && selected?.remembered && remember && !password);
  async function provisionMailAccount(accountEmail: string, accountPassword: string): Promise<void> {
    const payload = {
      email: accountEmail,
      password: accountPassword,
      smtpHost: DEFAULT_MAIL_SERVERS.smtpHost,
      smtpPort: DEFAULT_MAIL_SERVERS.smtpPort,
      imapHost: DEFAULT_MAIL_SERVERS.imapHost,
      imapPort: DEFAULT_MAIL_SERVERS.imapPort,
      validateConnection: false,
    };
    const attempts = 8;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const result = await window.api.invoke('accounts:upsert', payload) as { success?: boolean };
        if (result?.success) return;
      } catch { /* 本地资料库可能仍在绑定，稍后重试；登录结果不受影响。 */ }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  function chooseAccount(account: LoginAccount) {
    initialAccountChosen.current = true;setEmail(account.email);setPassword('');setAccountId(account.accountId);
    setRemember(account.remembered);setAutoLogin(account.autoLogin);setAccountsOpen(false);setNotice('');
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
        window.localStorage.setItem('prospector:registered-email', accountEmail.toLowerCase());
        setEmail(accountEmail); setCreating(false); setNotice('账号已创建，请登录');
      }
    } else {
      setNotice('');
      setAccountsOpen(false);
      if(savedCredential && selected) void session.loginAccount({accountId:selected.accountId,autoLogin});
      else {
        const accountEmail = String(form.get('email') ?? '').trim();
        const accountPassword = String(form.get('password') ?? '');
        const loggedIn = await session.login({ baseUrl: session.baseUrl, email: accountEmail, password: accountPassword, remember, autoLogin:remember&&autoLogin });
        if (loggedIn) void provisionMailAccount(accountEmail, accountPassword);
      }
    }
  }
  const busyLabel = restricted ? '正在更新密码…' : creating ? '正在创建账号…' : '正在验证账号…';
  return <div className={`product-login${session.busy ? ' is-submitting' : ''}`}>
    <TitleBar />
    <div className={`product-login-busybar${session.busy ? ' is-visible' : ''}`} role="status" aria-live="polite"><span>{session.busy ? busyLabel : ''}</span></div>
    <main className="ob-root show product-login-main">
      <DotPattern width={20} height={20} cr={1.3} className="product-login-pattern [mask-image:radial-gradient(560px_circle_at_50%_42%,white,transparent)]" />
      <section className={`ob-card product-login-card${!restricted && !creating ? ' product-login-card-signin' : ''}`} aria-labelledby="product-login-title">
        <div key={restricted ? 'password' : creating ? 'register' : 'login'} className="ob-step">
          <div className="product-login-mascot" aria-hidden="true"><DiamondLogo size={MASCOT_SIZE} state={session.busy ? 'running' : 'idle'} /></div>
          <div className="product-login-brand"><span className="product-login-brand-owner">Milogin’s</span><span className="product-login-brand-name">Prospector<span className="product-login-brand-dot">.</span></span></div>
          <h2 id="product-login-title" className={restricted || creating ? 'ob-h2' : 'sr-only'}>{restricted ? '设置您的新密码' : creating ? '创建账号' : '登录'}</h2>
          <form key={`${restricted}:${creating}`} onSubmit={event => void submit(event)} aria-busy={session.busy}>
            <fieldset className="product-login-fields" disabled={session.busy}>
              <div className="ob-form">
                {restricted ? <>
                  <p className="product-login-account">{session.identity?.email}</p>
                  <LoginField name="currentPassword" label="当前密码" type="password" autoComplete="current-password" />
                  <LoginField name="newPassword" label="新密码" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} placeholder={`至少 ${PASSWORD_MIN_LENGTH} 个字符`} />
                  <LoginField name="confirmation" label="确认新密码" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />
                </> : <>
                  <div ref={accountField} className="product-login-account-field">
                    <LoginField name="email" label="邮箱" type="email" autoComplete="username" placeholder="your@email.com" value={email} onChange={value=>{initialAccountChosen.current=true;setEmail(value);setAccountId(undefined);setPassword('');setAutoLogin(false);}}>
                      {!creating && accounts.length>0 && <button type="button" className="product-login-account-toggle" aria-label="选择账号" aria-expanded={accountsOpen} aria-controls="login-account-presets" onClick={()=>setAccountsOpen(value=>!value)}><DownOutlined/></button>}
                    </LoginField>
                    {!creating && accountsOpen && <div id="login-account-presets" className="product-login-presets" role="group" aria-label="已保存账号">
                      {accounts.map(account=><div key={account.accountId} className={`product-login-preset${account.accountId===accountId?' is-selected':''}`}>
                        <button type="button" className="product-login-preset-select" data-account-id={account.accountId} onClick={()=>chooseAccount(account)}><span className="product-login-preset-avatar" aria-hidden="true">{account.email.slice(0,1).toUpperCase()}</span><span>{account.email}</span></button>
                        <button type="button" className="product-login-preset-remove" aria-label={`移除 ${account.email}`} title="移除账号" onClick={()=>{void session.removeAccount(account.accountId).then(removed=>{if(removed&&account.accountId===accountId){setAccountId(undefined);setPassword('');setRemember(false);setAutoLogin(false);}});}}><CloseOutlined/></button>
                      </div>)}
                    </div>}
                  </div>
                  <LoginField name="password" label="密码" type="password" autoComplete={creating ? 'new-password' : 'current-password'} minLength={creating ? PASSWORD_MIN_LENGTH : undefined} placeholder={creating ? `至少${PASSWORD_MIN_LENGTH}个字符` : savedCredential ? '••••••••' : '请输入密码'} value={password} onChange={setPassword} required={!savedCredential} />
                  {creating && <LoginField name="confirmation" label="确认密码" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />}
                </>}
              </div>
              {(session.error || notice) && <div className="ob-error product-login-error" role="alert">{session.error || notice}</div>}
              <div className="ob-actions"><button className="ob-btn" type="submit" aria-busy={session.busy}>{session.busy ? busyLabel : restricted ? '修改密码并重新登录' : creating ? '创建账号' : '登录'}</button></div>
              {restricted ? <button className="ob-skip" type="button" onClick={() => void session.logout()}>返回登录</button> : <>
                <div className="product-login-links">
                  {!creating && <div className="product-login-options">
                    <label className="product-login-remember"><input name="remember" type="checkbox" checked={remember} onChange={event=>{setRemember(event.target.checked);if(!event.target.checked)setAutoLogin(false);}} />记住密码</label>
                    <label className="product-login-remember"><input name="autoLogin" type="checkbox" checked={autoLogin} onChange={event=>{setAutoLogin(event.target.checked);if(event.target.checked)setRemember(true);}} />自动登录</label>
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
