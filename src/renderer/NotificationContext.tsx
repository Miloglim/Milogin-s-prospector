import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ONLINE_CHANNELS as CHANNEL, ONLINE_LIMITS, TASK_DUE_EVENT, OPPORTUNITY_EVENTS } from '../shared/online-crm';
import type { LeadBootstrap, LeadDetail, CenterContactDetail, OnlineFeed, OnlineNotification, NotificationReadAllReceipt, Result } from '../shared/online-crm';
import { useIdentity } from './IdentityContext';
import { useVisiblePolling } from './hooks/useVisiblePolling';

const MAX_ITEMS = 100;
const MAX_FEED_PAGES = Math.ceil(MAX_ITEMS / ONLINE_LIMITS.feedPage);
const READ_ALL_FALLBACK_CONCURRENCY = 8;
export interface Notifications {
  items: OnlineNotification[]; unread: number; error: string; loading: boolean;
  refresh: (reset?: boolean) => Promise<void>; read: (id: string) => Promise<boolean>; readAll: () => Promise<boolean>;
  open: (item: OnlineNotification) => Promise<string | null>;
}
const Context = createContext<Notifications | null>(null);
export const useOptionalNotifications = () => useContext(Context);
async function invoke<T>(channel: string, ...args: unknown[]): Promise<Result<T>> {
  try { return await window.api.invoke(channel, ...args) as Result<T>; }
  catch { /* A transport rejection is an explicit failure, never a read receipt. */ return { ok: false, error: { code: 'UNAVAILABLE', message: '消息中心连接中断，请重试' } }; }
}
const isActionableNotification = (item: OnlineNotification) => item.eventType.startsWith('crm.contact.') || item.eventType === TASK_DUE_EVENT || item.eventType === 'crm.lead.followup' || Object.values(OPPORTUNITY_EVENTS).includes(item.eventType as typeof OPPORTUNITY_EVENTS.created);
export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const session = useIdentity();
  const scope = JSON.stringify([session.identity?.userId, session.identity?.crmRoles, session.identity?.crmCapabilities, session.identity?.mustChangePassword]);
  const enabled = !!session.identity && !session.identity.mustChangePassword;
  const currentScope = useRef(scope); currentScope.current = scope;
  const accessScope = useRef(''); const replay = useRef(true);
  const replayScan = useRef<{ scope: string; items: Map<string, OnlineNotification> } | null>(null);
  const observedActionable = useRef(new Set<string>());
  const wasHidden = useRef(document.visibilityState === 'hidden');
  const epoch = useRef(0); const pending = useRef<number | null>(null);
  const [state, setState] = useState<{ scope: string; items: OnlineNotification[] }>({ scope, items: [] });
  const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const items = state.scope === scope ? state.items : [];
  const reject = useCallback((result: Extract<Result<unknown>, { ok: false }>) => {
    setError(result.error.message);
    if (['UNAUTHORIZED', 'FORBIDDEN', 'PASSWORD_CHANGE_REQUIRED'].includes(result.error.code)) {
      epoch.current++; pending.current = null; setState({ scope: currentScope.current, items: [] }); setLoading(false); void session.refresh();
    }
  }, [session.refresh]);
  const refresh = useCallback(async (reset = false) => {
    if (!enabled || pending.current === epoch.current) return;
    let generation = epoch.current; const startedScope = scope;
    pending.current = generation; setLoading(true);
    const access = await invoke<LeadBootstrap>(CHANNEL.BOOTSTRAP);
    if (generation !== epoch.current || startedScope !== currentScope.current) return;
    if (!access.ok) { pending.current = null; setLoading(false); reject(access); return; }
    if (!Array.isArray(access.data.capabilities)) { pending.current = null; setLoading(false); setError('消息权限查询失败'); return; }
    const signature = JSON.stringify([access.data.userId, access.data.capabilities.slice().sort(), access.data.scope]);
    if (accessScope.current !== signature) { if (accessScope.current) { generation = ++epoch.current; pending.current = generation; } accessScope.current = signature; replay.current = true; setState({ scope: startedScope, items: [] }); }
    // Scope-sensitive cached summaries must be replaced after ownership/task state changes.
    const startReplay = reset || replay.current;
    if (startReplay) replayScan.current = { scope: startedScope, items: new Map() };
    const scan = replayScan.current?.scope === startedScope ? replayScan.current : null;
    let result = await invoke<OnlineFeed>(CHANNEL.FEED, { reset: startReplay });
    const pages: OnlineNotification[] = result.ok ? [...result.data.items] : [];
    for (let page = 1; result.ok && result.data.hasMore && page < MAX_FEED_PAGES; page++) {
      if (generation !== epoch.current || startedScope !== currentScope.current) return;
      const previousCursor = result.data.nextCursor;
      result = await invoke<OnlineFeed>(CHANNEL.FEED, { reset: false });
      if (result.ok) { pages.push(...result.data.items); if (result.data.nextCursor === previousCursor) break; }
    }
    if (generation !== epoch.current || startedScope !== currentScope.current) return;
    pending.current = null; setLoading(false);
    if (!result.ok) { reject(result); return; }
    replay.current = false; setError('');
    const freshActionable = pages.some(item => isActionableNotification(item) && !observedActionable.current.has(item.id));
    for (const item of pages) if (isActionableNotification(item)) observedActionable.current.add(item.id);
    if (freshActionable && !startReplay) replay.current = true;
    for (const item of pages) scan?.items.set(item.id, item);
    const replace = !!scan && !result.data.hasMore;
    const currentPage = replace ? Array.from(scan!.items.values()) : pages;
    if (replace) replayScan.current = null;
    setState(previous => {
      const existing = new Map((previous.scope === startedScope ? previous.items : []).map(item => [item.id, item]));
      const merged = replace ? new Map<string, OnlineNotification>() : new Map(existing);
      for (const item of currentPage) merged.set(item.id, { ...item, read: item.read || existing.get(item.id)?.read === true || merged.get(item.id)?.read === true });
      return { scope: startedScope, items: Array.from(merged.values()).slice(-MAX_ITEMS) };
    });
  }, [enabled, scope, reject]);
  useEffect(() => {
    const visibilityChanged = () => {
      const hidden = document.visibilityState === 'hidden';
      if (wasHidden.current && !hidden) replay.current = true;
      wasHidden.current = hidden;
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    return () => document.removeEventListener('visibilitychange', visibilityChanged);
  }, []);
  useVisiblePolling(() => refresh(), ONLINE_LIMITS.pollMs, enabled);
  useEffect(() => {
    epoch.current++; pending.current = null; replay.current = true; replayScan.current = null; observedActionable.current.clear(); wasHidden.current = document.visibilityState === 'hidden'; accessScope.current = ''; setState({ scope, items: [] }); setError(''); setLoading(false);
    if (!enabled) return;
    void refresh();
    return () => { epoch.current++; };
  }, [scope, enabled, refresh]);
  const read = useCallback(async (id: string) => {
    if (!enabled || scope !== currentScope.current) return false;
    const generation = epoch.current; const startedScope = scope;
    const result = await invoke<void>(CHANNEL.READ, id);
    if (generation !== epoch.current || startedScope !== currentScope.current) return false;
    if (!result.ok) { if (result.error.code === 'NOT_FOUND') { setState(previous => ({ ...previous, items: previous.items.filter(item => item.id !== id) })); replay.current = true; } reject(result); return false; }
    setState(previous => ({ ...previous, items: previous.items.map(item => item.id === id ? { ...item, read: true } : item) })); return true;
  }, [enabled, scope, reject]);
  const readAll = useCallback(async () => {
    if (!enabled || scope !== currentScope.current) return false;
    const generation = epoch.current; const startedScope = scope;
    const result = await invoke<NotificationReadAllReceipt>(CHANNEL.READ_ALL);
    if (generation !== epoch.current || startedScope !== currentScope.current) return false;
    if (!result.ok) {
      // Older centers do not have the bulk route yet. Keep the client compatible with
      // their existing one-notification read endpoint until the center is upgraded.
      if (result.error.code !== 'NOT_FOUND') { reject(result); return false; }
      const unreadIds = items.filter(item => !item.read).map(item => item.id);
      for (let index = 0; index < unreadIds.length; index += READ_ALL_FALLBACK_CONCURRENCY) {
        const batch = unreadIds.slice(index, index + READ_ALL_FALLBACK_CONCURRENCY);
        const reads = await Promise.all(batch.map(id => invoke<void>(CHANNEL.READ, id)));
        if (generation !== epoch.current || startedScope !== currentScope.current) return false;
        const failed = reads.find(read => !read.ok && read.error.code !== 'NOT_FOUND');
        if (failed && !failed.ok) { reject(failed); return false; }
      }
    }
    setState(previous => ({ ...previous, items: previous.items.map(item => item.read ? item : { ...item, read: true }) }));
    return true;
  }, [enabled, scope, reject, items]);
  const open = useCallback(async (item: OnlineNotification) => {
    if (!enabled || scope !== currentScope.current || item.canOpen === false || (!item.customerId && !item.requestId && !item.shareId)) return null;
    const generation = epoch.current; const startedScope = scope;
    // Request visibility comes from the authorized feed. Reading the notification
    // opens the decision page only; it must never accept or open the whole company.
    if (item.eventType.startsWith('crm.contact.share.')) {
      if (!await read(item.id)) return null;
      return generation === epoch.current && startedScope === currentScope.current ? item.shareId ?? item.customerId : null;
    }
    if (item.requestId) {
      if (!await read(item.id)) return null;
      return generation === epoch.current && startedScope === currentScope.current ? item.requestId : null;
    }
    if (item.contactId) {
      const result = await invoke<CenterContactDetail>(CHANNEL.CONTACT_DETAIL, { contactId: item.contactId, customerId: item.customerId });
      if (generation !== epoch.current || startedScope !== currentScope.current) return null;
      if (!result.ok) { reject(result); return null; }
      if (result.data.contact.contactId !== item.contactId || result.data.contact.customerId !== item.customerId) { setError('联系人详情不匹配，请刷新消息'); return null; }
      if (!await read(item.id)) return null;
      return generation === epoch.current && startedScope === currentScope.current ? item.customerId : null;
    }
    const result = await invoke<LeadDetail>(CHANNEL.DETAIL, item.customerId);
    if (generation !== epoch.current || startedScope !== currentScope.current) return null;
    if (!result.ok) { if(result.error.code==='NOT_FOUND'){setState(previous=>({...previous,items:previous.items.filter(value=>value.customerId!==item.customerId)}));replay.current=true;} reject(result); return null; }
    if (result.data.customerId !== item.customerId) { setError('客户详情不匹配，请刷新消息'); return null; }
    if (!await read(item.id)) return null;
    return generation === epoch.current && startedScope === currentScope.current ? item.customerId : null;
  }, [enabled, scope, read, reject]);
  return <Context.Provider value={{ items, unread: items.filter(item => !item.read).length, error, loading, refresh, read, readAll, open }}>{children}</Context.Provider>;
}
