import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ONLINE_CHANNELS, ONLINE_LIMITS } from '../shared/online-crm';
import type { Identity, OnlineLogin, OnlineSessionSnapshot, Result, OnlineRegistration, RegisteredAccount, OnlineHandoffBegin, OnlineHandoffBeginResult, OnlineHandoffComplete, OnlineHandoffState, OnlineHandoffTakeover, OnlineHandoffToken } from '../shared/online-crm';
import type { LoginAccount, LoginAccountQuery, SavedAccountLogin, OnlineLogout } from '../shared/online-crm';
import { clearSessionTranscript } from './hooks/useAgentTranscript';
import { useVisiblePolling } from './hooks/useVisiblePolling';

export type IdentityStatus = 'restoring' | 'anonymous' | 'password-required' | 'authenticated' | 'offline';
export interface IdentityContextValue {
  identity: Identity | null;
  status: IdentityStatus;
  ready: boolean;
  error: string;
  baseUrl: string;
  remembered: boolean;
  accounts: LoginAccount[];
  selectedAccountId?: string;
  loginAccount: (input: SavedAccountLogin) => Promise<boolean>;
  removeAccount: (accountId: string) => Promise<boolean>;
  localAvailable: boolean;
  busy: boolean;
  login: (input: OnlineLogin) => Promise<Result<void>>;
  beginHandoff: (input: OnlineHandoffBegin) => Promise<Result<OnlineHandoffBeginResult>>;
  handoffStatus: (input: OnlineHandoffToken) => Promise<Result<OnlineHandoffState>>;
  completeHandoff: (input: OnlineHandoffComplete) => Promise<Result<void>>;
  takeoverHandoff: (input: OnlineHandoffTakeover) => Promise<Result<void>>;
  cancelHandoff: (input: OnlineHandoffToken) => Promise<Result<void>>;
  register: (input: OnlineRegistration) => Promise<boolean>;
  logout: (input?: OnlineLogout) => Promise<void>;
  refresh: () => Promise<void>;
  reconnect: () => Promise<boolean>;
  changePassword: (input: { currentPassword: string; newPassword: string }) => Promise<boolean>;
}
const IdentityContext = createContext<IdentityContextValue | null>(null);
/** Compatibility for isolated page tests; the application always supplies a provider. */
export function useOptionalIdentity() { return useContext(IdentityContext); }
export function useIdentity() {
  const value = useOptionalIdentity();
  if (!value) throw new Error('useIdentity requires IdentityProvider');
  return value;
}
async function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  try { return await window.api.invoke(channel, ...args) as Result<T>; }
  catch { // Transport rejection is reported as a visible connection error, never login success.
    return { ok: false, error: { code: 'UNAVAILABLE', message: '账号中心连接中断，请重试' } };
  }
}
const activeStatus = (identity: Identity | null): IdentityStatus => identity?.mustChangePassword ? 'password-required' : identity ? 'authenticated' : 'anonymous';
const scopeKey = (identity: Identity | null) => identity ? JSON.stringify([
  identity.userId,
  identity.identityAdmin,
  identity.crmRoles.slice().sort(),
  identity.crmCapabilities?.slice().sort() ?? [],
  identity.mustChangePassword,
]) : '';

/** Main owns every credential; only the current public identity enters renderer memory. */
export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<IdentityStatus>('restoring');
  const [error, setError] = useState('');
  const [baseUrl, setBaseUrl] = useState<string>(ONLINE_LIMITS.defaultUrl);
  const [remembered, setRemembered] = useState(false);
  const [accounts, setAccounts] = useState<LoginAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>();
  const [localAvailable, setLocalAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const epoch = useRef(0);
  const currentIdentity = useRef<Identity | null>(null);
  const polling = useRef(false);
  const actionPending = useRef(false);
  const switchingAccount = useRef(false);
  const refreshAccounts = useCallback(async () => {
    const result = await invoke<LoginAccountQuery>(ONLINE_CHANNELS.ACCOUNT_LIST);
    if (result?.ok && Array.isArray(result.data?.accounts)) {setAccounts(result.data.accounts);setSelectedAccountId(result.data.selectedAccountId);}
  }, []);
  const apply = useCallback((next: Identity | null) => {
    if (scopeKey(next) !== scopeKey(currentIdentity.current)) {
      void queryClient.cancelQueries();
      queryClient.clear();
      clearSessionTranscript();
    }
    currentIdentity.current = next;
    setIdentity(next);
    setStatus(activeStatus(next));
  }, [queryClient]);
  const refresh = useCallback(async () => {
    if (polling.current || actionPending.current || switchingAccount.current) return;
    polling.current = true;
    const version = epoch.current;
    const result = await invoke<OnlineSessionSnapshot>(ONLINE_CHANNELS.STATUS);
    polling.current = false;
    if (version !== epoch.current) return;
    if (result.ok) {
      apply(result.data.identity);
      setBaseUrl(result.data.baseUrl);
      setRemembered(result.data.remembered);
      setLocalAvailable(result.data.localAvailable === true);
      if (result.data.connection === 'offline' && result.data.identity && !result.data.identity.mustChangePassword) setStatus('offline');
      setError('');
      if (!result.data.identity) void refreshAccounts();
    } else {
      setError(result.error.message);
      if (['UNAVAILABLE', 'DATABASE_ERROR', 'TIMEOUT'].includes(result.error.code)) setStatus(currentIdentity.current ? activeStatus(currentIdentity.current) === 'password-required' ? 'password-required' : 'offline' : 'anonymous');
      else { epoch.current++; apply(null); }
    }
  }, [apply, refreshAccounts]);
  useVisiblePolling(refresh, ONLINE_LIMITS.pollMs);
  useEffect(() => {
    let alive = true;
    const version = ++epoch.current;
    void invoke<OnlineSessionSnapshot>(ONLINE_CHANNELS.RESTORE).then(result => {
      if (!alive || version !== epoch.current) return;
      if (result.ok) { apply(result.data.identity); setBaseUrl(result.data.baseUrl); setRemembered(result.data.remembered); setLocalAvailable(result.data.localAvailable === true); if (result.data.connection === 'offline' && result.data.identity && !result.data.identity.mustChangePassword) setStatus('offline'); }
      else { setError(result.error.message); apply(null); }
      void refreshAccounts();
    });
    return () => { alive = false; epoch.current++; };
  }, [apply, refresh, refreshAccounts]);
  const register = useCallback(async (input: OnlineRegistration) => {
    if (actionPending.current || currentIdentity.current) return false;
    actionPending.current = true;
    const version = ++epoch.current;
    setBusy(true); setError('');
    const result = await invoke<RegisteredAccount>(ONLINE_CHANNELS.REGISTER, input);
    actionPending.current = false;
    if (version !== epoch.current) return false;
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return false; }
    return true;
  }, []);
  const login = useCallback(async (input: OnlineLogin): Promise<Result<void>> => {
    if (actionPending.current) return { ok: false, error: { code: 'CONFLICT', message: '正在处理登录请求' } };
    actionPending.current = true;
    const version = ++epoch.current;
    apply(null); setLocalAvailable(false); setBusy(true); setError('');
    const result = await invoke<Identity>(ONLINE_CHANNELS.LOGIN, input);
    actionPending.current = false;
    if (version !== epoch.current) return { ok: false, error: { code: 'UNAUTHORIZED', message: '登录已取消' } };
    if (!result.ok) { setBusy(false); setError(result.error.message); return result; }
    setBaseUrl(input.baseUrl); setRemembered(Boolean(input.remember)); apply(result.data);
    setBusy(false);
    void refreshAccounts();
    void refresh();
    return { ok: true, data: undefined };
  }, [apply, refresh, refreshAccounts]);
  const loginAccount = useCallback(async (input: SavedAccountLogin) => {
    if(actionPending.current)return false;
    actionPending.current=true;const version=++epoch.current;apply(null);setLocalAvailable(false);setBusy(true);setError('');
    const result=await invoke<OnlineSessionSnapshot>(ONLINE_CHANNELS.ACCOUNT_LOGIN,input);
    if(version!==epoch.current){actionPending.current=false;return false;}
    await refreshAccounts();
    if(!result.ok){actionPending.current=false;setBusy(false);setError(result.error.message);return false;}
    apply(result.data.identity);setBaseUrl(result.data.baseUrl);setRemembered(result.data.remembered);
    if(result.data.connection==='offline'&&result.data.identity&&!result.data.identity.mustChangePassword)setStatus('offline');
    setBusy(false);actionPending.current=false;void refresh();return true;
  }, [apply,refresh,refreshAccounts]);
  const beginHandoff = useCallback(async (input: OnlineHandoffBegin) => {
    if (actionPending.current) return { ok: false as const, error: { code: 'CONFLICT' as const, message: '正在处理登录请求' } };
    actionPending.current = true; setBusy(true); setError('');
    const result = await invoke<OnlineHandoffBeginResult>(ONLINE_CHANNELS.HANDOFF_BEGIN, input);
    actionPending.current = false; setBusy(false);
    if (!result.ok) setError(result.error.message);
    return result;
  }, []);
  const handoffStatus = useCallback((input: OnlineHandoffToken) => invoke<OnlineHandoffState>(ONLINE_CHANNELS.HANDOFF_STATUS, input), []);
  const finishHandoff = useCallback(async (channel: string, input: OnlineHandoffComplete | OnlineHandoffTakeover): Promise<Result<void>> => {
    if (actionPending.current) return { ok: false, error: { code: 'CONFLICT', message: '正在处理换机请求' } };
    actionPending.current = true;
    const version = ++epoch.current;
    setBusy(true); setError('');
    const result = await invoke<Identity>(channel, input);
    actionPending.current = false;
    if (version !== epoch.current) return { ok: false, error: { code: 'UNAUTHORIZED', message: '登录已取消' } };
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return result; }
    setRemembered(Boolean(input.remember)); apply(result.data);
    void refreshAccounts(); void refresh();
    return { ok: true, data: undefined };
  }, [apply, refresh, refreshAccounts]);
  const completeHandoff = useCallback((input: OnlineHandoffComplete) => finishHandoff(ONLINE_CHANNELS.HANDOFF_COMPLETE, input), [finishHandoff]);
  const takeoverHandoff = useCallback((input: OnlineHandoffTakeover) => finishHandoff(ONLINE_CHANNELS.HANDOFF_TAKEOVER, input), [finishHandoff]);
  const cancelHandoff = useCallback(async (input: OnlineHandoffToken) => invoke<void>(ONLINE_CHANNELS.HANDOFF_CANCEL, input), []);
  const removeAccount = useCallback(async (accountId:string) => {
    if(actionPending.current)return false;
    actionPending.current=true;setBusy(true);setError('');
    const result=await invoke<void>(ONLINE_CHANNELS.ACCOUNT_REMOVE,accountId);
    actionPending.current=false;setBusy(false);
    if(!result.ok){setError(result.error.message);return false;}await refreshAccounts();return true;
  }, [refreshAccounts]);
  const logout = useCallback(async (input?: OnlineLogout) => {
    if (actionPending.current) return;
    const switching = input?.switchAccount === true;
    actionPending.current = true;
    ++epoch.current;
    if (switching) {
      switchingAccount.current = true;
    } else {
      apply(null);
      setRemembered(false);
      setBusy(true);
    }
    setError('');
    const result = input ? await invoke<void>(ONLINE_CHANNELS.LOGOUT, input) : await invoke<void>(ONLINE_CHANNELS.LOGOUT);
    actionPending.current = false;
    if (!switching) setBusy(false);
    if (switching && !result.ok) switchingAccount.current = false;
    if (!result.ok) setError(result.error.message);
    if (!switching) void refreshAccounts();
  }, [apply,refreshAccounts]);
  const reconnect = useCallback(async () => {
    if (polling.current || actionPending.current) return false;
    actionPending.current = true;
    const version = ++epoch.current;
    setBusy(true); setError('');
    const result = await invoke<OnlineSessionSnapshot>(ONLINE_CHANNELS.RESTORE);
    actionPending.current = false;
    if (version !== epoch.current) return false;
    setBusy(false);
    if (result.ok) {
      apply(result.data.identity); setBaseUrl(result.data.baseUrl); setRemembered(result.data.remembered);
      setLocalAvailable(result.data.localAvailable === true);
      if (result.data.connection === 'offline' && result.data.identity) { setStatus('offline'); setError('中心暂时不可用，当前为离线工作区'); return false; }
      setError(''); return !!result.data.identity;
    }
    setError(result.error.message);
    if (currentIdentity.current) setStatus('offline');
    return false;
  }, [apply]);
  const changePassword = useCallback(async (input: { currentPassword: string; newPassword: string }) => {
    if (actionPending.current) return false;
    actionPending.current = true;
    const version = ++epoch.current;
    setBusy(true); setError('');
    const result = await invoke<void>(ONLINE_CHANNELS.PASSWORD, input);
    actionPending.current = false;
    if (version !== epoch.current) return false;
    setBusy(false);
    if (!result.ok) { setError(result.error.message); return false; }
    apply(null); setRemembered(false); setError('密码已修改，请使用新密码登录');
    void refreshAccounts();
    return true;
  }, [apply,refreshAccounts]);
  return <IdentityContext.Provider value={{ identity, status, ready: status !== 'restoring', error, baseUrl, remembered, accounts, selectedAccountId, loginAccount, removeAccount, localAvailable, busy, register, login: login as IdentityContextValue['login'], beginHandoff, handoffStatus, completeHandoff, takeoverHandoff, cancelHandoff, logout, refresh, reconnect, changePassword }}>{children}</IdentityContext.Provider>;
}
