import { useEffect, useMemo, useRef, useState } from 'react';
import { BugOutlined, CloseOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { buildRandomAssistantMock, clearAssistantMock, saveAssistantMock } from '../lib/dev-assistant-mock';
import { useOptionalIdentity } from '../IdentityContext';

type Tab = 'api' | 'actions' | 'buttons' | 'events' | 'config';

type DevActionType = 'navigate' | 'invoke' | 'event' | 'reload' | 'reset' | 'mock' | 'clear-mock';

interface DevAction {
  label: string;
  type: DevActionType;
  target?: string;
  args?: unknown[];
  navigate?: string;
}

interface CallRecord {
  at: number;
  channel: string;
  args: unknown[];
  result?: unknown;
  error?: string;
}

const ACTIONS_KEY = 'prospector.dev-overlay.actions';
const MAX_CALLS = 20;
const MAX_LOG = 50;
const MAX_JSON = 24000;

const DEFAULT_ACTIONS: DevAction[] = [
  { label: '去任务', type: 'navigate', target: '#/assistant' },
  { label: '去收件箱', type: 'navigate', target: '#/inbox' },
  { label: '去客户', type: 'navigate', target: '#/customers' },
  { label: '去我的团队', type: 'navigate', target: '#/team?section=overview' },
  { label: '去设置', type: 'navigate', target: '#/settings' },
  { label: '助手快照', type: 'invoke', target: 'assistant:snapshot' },
  { label: '整理提醒', type: 'invoke', target: 'assistant:run', args: [true] },
  { label: '卡片预览', type: 'event', target: 'dev:assistant-preview', navigate: '#/assistant' },
  { label: 'Mock 10 条卡片', type: 'mock', args: [10] },
  { label: '清除 Mock', type: 'clear-mock' },
  { label: '刷新窗口', type: 'reload' },
  { label: '重置动作', type: 'reset' },
];

const CHANNELS = window.api.channels.invoke.map(channel => {
  const separator = channel.indexOf(':');
  return { group: separator < 0 ? channel : channel.slice(0, separator), name: separator < 0 ? channel : channel.slice(separator + 1), channel };
});

const EVENT_CHANNELS = window.api.channels.events.map(channel => ({ name: channel, channel }));

function channelRisk(channel: string): { label: '危险' | '写' | '读'; className: string } {
  if (/(delete|remove|dissolve|logout|revoke|terminate|clear|reset|cancel|stop|reject|decline|kick)/i.test(channel)) {
    return { label: '危险', className: 'bg-red-900/50 text-red-300' };
  }
  if (/(create|update|upsert|import|send|start|accept|set|save|add|move|assign|publish|mark|complete|run|dismiss|archive|upload|followup|decide|invite)/i.test(channel)) {
    return { label: '写', className: 'bg-amber-900/40 text-amber-300' };
  }
  return { label: '读', className: 'bg-slate-800 text-slate-400' };
}

function loadActions(): DevAction[] {
  try {
    const raw = localStorage.getItem(ACTIONS_KEY);
    if (!raw) return DEFAULT_ACTIONS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_ACTIONS;
    const valid = parsed.filter((item): item is DevAction => !!item && typeof item === 'object'
      && typeof (item as DevAction).label === 'string' && typeof (item as DevAction).type === 'string'
      && ['navigate', 'invoke', 'event', 'reload', 'reset', 'mock', 'clear-mock'].includes((item as DevAction).type));
    return valid.length ? valid : DEFAULT_ACTIONS;
  } catch { /* 开发配置损坏时回到默认动作 */ return DEFAULT_ACTIONS; }
}

function shortJson(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > MAX_JSON ? `${text.slice(0, MAX_JSON)}\n…（已截断）` : text;
}

function time(value: number): string {
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

export function DevOverlay() {
  const identity = useOptionalIdentity()?.identity ?? null;
  const userId = identity?.userId ?? null;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('actions');
  const [actions, setActions] = useState<DevAction[]>(loadActions);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState('ALL');
  const [selected, setSelected] = useState(CHANNELS[0]?.channel ?? '');
  const [argsText, setArgsText] = useState('[]');
  const [result, setResult] = useState<{ channel: string; text: string; ok: boolean } | null>(null);
  const [eventChannel, setEventChannel] = useState(EVENT_CHANNELS[0]?.channel ?? '');
  const [logs, setLogs] = useState<Array<{ at: number; channel: string; value: unknown }>>([]);
  const [pageButtons, setPageButtons] = useState<Array<{ el: HTMLButtonElement; label: string; disabled: boolean; danger: boolean }>>([]);
  const [actionsText, setActionsText] = useState(() => JSON.stringify(loadActions(), null, 2));
  const unsubscribe = useRef<null | (() => void)>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        setOpen(value => !value);
      } else if (event.key === 'Escape' && open) {
        const modalOpen = Array.from(document.querySelectorAll('.ant-modal-wrap'))
          .some(node => (node as HTMLElement).getClientRects().length > 0);
        if (modalOpen) return;
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  useEffect(() => () => { unsubscribe.current?.(); }, []);

  const scanButtons = () => {
    const nodes = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .filter(element => !element.closest('aside[aria-label="开发工具台"]') && element.getClientRects().length > 0);
    setPageButtons(nodes.map((element, index) => {
      const label = (element.getAttribute('aria-label') || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || `按钮 ${index + 1}`;
      return { el: element, label, disabled: element.disabled, danger: /删除|清空|解散|退出|终止|撤销|重置|注销|移除/.test(label) };
    }));
    setNotice(`已扫描 ${nodes.length} 个可见按钮`);
  };

  useEffect(() => { if (open && tab === 'buttons') scanButtons(); }, [open, tab]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return CHANNELS.filter(item => (groupFilter === 'ALL' || item.group === groupFilter)
      && (!query || `${item.group} ${item.name} ${item.channel}`.toLowerCase().includes(query)));
  }, [search, groupFilter]);

  const groups = useMemo(() => {
    const map = new Map<string, typeof CHANNELS>();
    for (const item of filtered) map.set(item.group, [...(map.get(item.group) ?? []), item]);
    return [...map.entries()];
  }, [filtered]);

  const groupCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of CHANNELS) map.set(item.group, (map.get(item.group) ?? 0) + 1);
    return map;
  }, []);

  const copyCatalog = async () => {
    try {
      await navigator.clipboard.writeText(filtered.map(item => `${item.group}.${item.name}\t${item.channel}`).join('\n'));
      setNotice(`已复制 ${filtered.length} 个接口`);
    } catch {
      setNotice('复制失败，请检查剪贴板权限');
    }
  };

  const invoke = async (channel: string, args: unknown[]) => {
    setBusy(channel);
    setNotice('');
    try {
      const value = await window.api.invoke(channel, ...args);
      const ok = !(value && typeof value === 'object' && 'success' in value && (value as { success?: boolean }).success === false)
        && !(value && typeof value === 'object' && 'ok' in value && (value as { ok?: boolean }).ok === false);
      setResult({ channel, ok, text: shortJson(value) });
      setCalls(current => [{ at: Date.now(), channel, args, result: value }, ...current].slice(0, MAX_CALLS));
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResult({ channel, ok: false, text: message });
      setCalls(current => [{ at: Date.now(), channel, args, error: message }, ...current].slice(0, MAX_CALLS));
      return null;
    } finally {
      setBusy('');
    }
  };

  const runAction = async (action: DevAction) => {
    setNotice('');
    try {
      if (action.type === 'navigate') {
        if (action.target) window.location.hash = action.target;
      } else if (action.type === 'reload') {
        window.location.reload();
      } else if (action.type === 'event') {
        if (action.navigate && window.location.hash !== action.navigate) {
          window.location.hash = action.navigate;
          await new Promise(resolve => setTimeout(resolve, 350));
        }
        if (action.target) window.dispatchEvent(new CustomEvent(action.target, { detail: action.args ?? [] }));
        setNotice(`已触发事件 ${action.target}`);
      } else if (action.type === 'invoke') {
        if (action.target) await invoke(action.target, action.args ?? []);
      } else if (action.type === 'mock') {
        const count = Math.max(4, Math.min(30, Number(action.args?.[0] ?? 10) || 10));
        saveAssistantMock(buildRandomAssistantMock(count), userId);
        if (window.location.hash !== '#/assistant') window.location.hash = '#/assistant';
        setNotice(`已生成 ${count} 条随机 Mock`);
      } else if (action.type === 'clear-mock') {
        clearAssistantMock(userId);
        setNotice('已清除 Mock，恢复真实提醒');
      } else if (action.type === 'reset') {
        localStorage.removeItem(ACTIONS_KEY);
        setActions(DEFAULT_ACTIONS);
        setActionsText(JSON.stringify(DEFAULT_ACTIONS, null, 2));
        setNotice('已恢复默认动作');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const saveActions = () => {
    try {
      const parsed = JSON.parse(actionsText) as unknown;
      if (!Array.isArray(parsed) || !parsed.every(item => item && typeof item === 'object' && typeof (item as DevAction).label === 'string' && typeof (item as DevAction).type === 'string')) {
        throw new Error('动作必须是包含 label 和 type 的数组');
      }
      const next = parsed as DevAction[];
      setActions(next);
      localStorage.setItem(ACTIONS_KEY, JSON.stringify(next));
      setNotice(`已保存 ${next.length} 个动作`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '动作 JSON 无效');
    }
  };

  const subscribe = () => {
    unsubscribe.current?.();
    unsubscribe.current = null;
    try {
      unsubscribe.current = window.api.on(eventChannel, value => {
        setLogs(current => [{ at: Date.now(), channel: eventChannel, value }, ...current].slice(0, MAX_LOG));
      });
      setNotice(`正在监听 ${eventChannel}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '事件订阅失败');
    }
  };

  if (!open) {
    return <button type="button" onClick={() => setOpen(true)}
      title="开发工具台（Ctrl+Shift+D）" aria-label="打开开发工具台"
      className="fixed right-0 top-1/2 z-[9998] flex h-14 w-6 -translate-y-1/2 flex-col items-center justify-center gap-0.5 rounded-l-md border border-r-0 border-slate-700 bg-slate-900/95 text-[8px] font-medium text-slate-300 shadow-lg transition-colors hover:border-teal-500 hover:text-teal-300">
      <BugOutlined className="text-[11px]" /><span>DEV</span>
    </button>;
  }

  return <aside className="fixed bottom-3 right-3 z-[9999] flex h-[min(720px,72vh)] w-[min(600px,calc(100vw-24px))] flex-col overflow-hidden rounded-lg border border-slate-700 bg-slate-900 text-slate-200 shadow-2xl"
    aria-label="开发工具台" onKeyDown={event => event.stopPropagation()}>
    <header className="flex items-center gap-2 border-b border-slate-700 px-3 py-2">
      <BugOutlined className="text-teal-400" />
      <strong className="text-[12px]">开发工具台</strong>
      <span className="text-[10px] text-slate-500">接口 / 动作 / 按钮 / 事件 / 配置</span>
      <button type="button" onClick={() => setOpen(false)} aria-label="关闭开发工具台" className="ml-auto text-slate-400 hover:text-white"><CloseOutlined /></button>
    </header>
    <nav className="flex gap-1 border-b border-slate-800 px-2 py-1.5">
      {([['api', '接口'], ['actions', '动作'], ['buttons', '按钮'], ['events', '事件'], ['config', '配置']] as Array<[Tab, string]>).map(([key, label]) =>
        <button key={key} type="button" onClick={() => setTab(key)}
          className={`rounded px-2.5 py-1 text-[11px] transition-colors ${tab === key ? 'bg-teal-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'}`}>{label}</button>)}
      <span className="ml-auto self-center pr-1 text-[10px] text-slate-500">Ctrl+Shift+D</span>
    </nav>
    {notice && <div className="border-b border-slate-800 bg-slate-800/60 px-3 py-1 text-[11px] text-amber-300">{notice}</div>}

    <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[11px]">
      {tab === 'api' && <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-slate-400">全部可调用接口</span>
          <span className="text-slate-500">共 {CHANNELS.length} 个 · {groupCounts.size} 组</span>
          <button type="button" onClick={() => void copyCatalog()} className="ml-auto rounded border border-slate-700 px-2 py-1 text-[10px] text-slate-300 hover:border-slate-500">复制清单</button>
        </div>
        <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索接口组、名称或通道"
          className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-[11px] text-slate-200 outline-none focus:border-teal-500" />
        <div className="flex max-h-[58px] flex-wrap gap-1 overflow-y-auto rounded border border-slate-800 p-1">
          <button type="button" onClick={() => setGroupFilter('ALL')}
            className={`rounded px-1.5 py-0.5 ${groupFilter === 'ALL' ? 'bg-teal-700/40 text-teal-200' : 'text-slate-400 hover:bg-slate-800'}`}>全部 {CHANNELS.length}</button>
          {[...groupCounts.entries()].map(([group, count]) => <button key={group} type="button" onClick={() => setGroupFilter(group)}
            className={`rounded px-1.5 py-0.5 ${groupFilter === group ? 'bg-teal-700/40 text-teal-200' : 'text-slate-400 hover:bg-slate-800'}`}>{group} {count}</button>)}
        </div>
        <div className="max-h-[280px] overflow-y-auto rounded border border-slate-800">
          {groups.length === 0 ? <div className="px-2 py-3 text-slate-500">没有匹配的接口。</div>
            : groups.map(([group, items]) => <div key={group}>
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-slate-900/95 px-2 py-1 text-[10px] text-slate-500"><span>{group}</span><span>{items.length}</span></div>
              {items.map(item => {
                const risk = channelRisk(item.channel);
                return <button key={`${item.group}:${item.name}`} type="button" onClick={() => setSelected(item.channel)}
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left ${selected === item.channel ? 'bg-teal-700/40 text-teal-200' : 'text-slate-400 hover:bg-slate-800'}`}
                  title={`${item.group}.${item.name} — ${item.channel}`}>
                  <span className="w-40 shrink-0 truncate">{item.name}</span>
                  <code className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-500">{item.channel}</code>
                  <span className={`shrink-0 rounded px-1 text-[10px] ${risk.className}`}>{risk.label}</span>
                </button>;
              })}
            </div>)}
        </div>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-slate-950 px-2 py-1 text-[11px] text-teal-300">{selected}</code>
          <button type="button" onClick={() => void invoke(selected, (() => { try { const value = JSON.parse(argsText) as unknown; return Array.isArray(value) ? value : [value]; } catch { return []; } })())}
            disabled={!selected || busy === selected}
            className="flex items-center gap-1 rounded bg-teal-600 px-2.5 py-1 font-medium text-white hover:bg-teal-500 disabled:opacity-40"><PlayCircleOutlined />{busy === selected ? '调用中' : '调用'}</button>
        </div>
        <label className="text-slate-500">参数（JSON 数组，按顺序展开）</label>
        <textarea value={argsText} onChange={event => setArgsText(event.target.value)} rows={4} spellCheck={false}
          className="w-full resize-y rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-teal-500" />
        {result && <div>
          <div className={`mb-1 flex items-center gap-2 ${result.ok ? 'text-teal-400' : 'text-red-400'}`}><span>{result.ok ? '成功' : '失败'}</span><code className="truncate text-slate-500">{result.channel}</code></div>
          <pre className="max-h-56 overflow-auto rounded bg-slate-950 p-2 font-mono text-[10px] leading-4 text-slate-300">{result.text}</pre>
        </div>}
        {calls.length > 0 && <div className="text-slate-500">最近调用：{calls.map(call => `${time(call.at)} ${call.channel}`).slice(0, 6).join(' · ')}</div>}
      </div>}

      {tab === 'actions' && <div className="flex flex-col gap-3">
        <p className="text-slate-500">共 {actions.length} 个动作；把常用页面、接口和事件收在一处，可在「配置」里增删。</p>
        <div className="grid grid-cols-2 gap-2">
          {actions.map((action, index) => <button key={`${action.label}-${index}`} type="button" onClick={() => void runAction(action)}
            className="flex min-h-[52px] flex-col rounded border border-slate-700 bg-slate-800/60 px-2.5 py-2 text-left transition-colors hover:border-teal-500 hover:bg-slate-800">
            <strong className="text-[12px] text-slate-200">{action.label}</strong>
            <small className="truncate font-mono text-[10px] text-slate-500">{action.type}{action.target ? ` · ${action.target}` : ''}</small>
          </button>)}
        </div>
        {result && <div>
          <div className={`mb-1 ${result.ok ? 'text-teal-400' : 'text-red-400'}`}>{result.ok ? '成功' : '失败'} · <code>{result.channel}</code></div>
          <pre className="max-h-56 overflow-auto rounded bg-slate-950 p-2 font-mono text-[10px] leading-4 text-slate-300">{result.text}</pre>
        </div>}
        <div className="text-slate-500">{calls.length ? `最近：${calls[0]!.channel} · ${time(calls[0]!.at)}` : '还没有接口调用'}</div>
      </div>}

      {tab === 'buttons' && <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <p className="flex-1 text-slate-500">扫描当前页面可见按钮；点击后按真实 UI 逻辑执行。</p>
          <button type="button" onClick={scanButtons} className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500"><ReloadOutlined />重新扫描</button>
        </div>
        {pageButtons.length === 0 ? <div className="text-slate-500">当前页面没有扫描到按钮。</div>
          : <div className="flex max-h-[520px] flex-col gap-1 overflow-y-auto">
            {pageButtons.map((item, index) => <button key={`${item.label}-${index}`} type="button" disabled={item.disabled}
              onClick={() => {
                if (item.danger && !window.confirm(`确定触发「${item.label}」？这可能是删除/破坏类操作。`)) return;
                item.el.click();
                setNotice(`已点击：${item.label}`);
              }}
              className="flex items-center gap-2 rounded border border-slate-800 bg-slate-800/40 px-2.5 py-1.5 text-left hover:border-slate-600 disabled:opacity-40">
              <span className="min-w-0 flex-1 truncate text-slate-200">{item.label}</span>
              {item.danger && <span className="rounded bg-red-900/50 px-1 text-[10px] text-red-300">危险</span>}
              {item.disabled && <span className="text-[10px] text-slate-500">不可用</span>}
            </button>)}
          </div>}
      </div>}

      {tab === 'events' && <div className="flex flex-col gap-2">
        <p className="text-slate-500">订阅一个主进程事件，查看真实触发顺序和载荷。</p>
        <div className="flex gap-2">
          <select value={eventChannel} onChange={event => setEventChannel(event.target.value)}
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[11px] text-slate-200 outline-none focus:border-teal-500">
            {EVENT_CHANNELS.map(item => <option key={item.channel} value={item.channel}>{item.name} — {item.channel}</option>)}
          </select>
          <button type="button" onClick={subscribe} className="rounded bg-teal-600 px-2.5 py-1 font-medium text-white hover:bg-teal-500">监听</button>
          <button type="button" onClick={() => { unsubscribe.current?.(); unsubscribe.current = null; setNotice('已停止监听'); }}
            className="rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500">停止</button>
        </div>
        {logs.length === 0 ? <div className="text-slate-500">还没有收到事件。</div>
          : <div className="flex flex-col gap-1.5">{logs.map((log, index) => <div key={`${log.at}-${index}`} className="rounded bg-slate-950 p-2">
            <div className="mb-1 flex gap-2 text-slate-500"><span>{time(log.at)}</span><code className="truncate text-teal-300">{log.channel}</code></div>
            <pre className="max-h-28 overflow-auto font-mono text-[10px] leading-4 text-slate-300">{shortJson(log.value)}</pre>
          </div>)}</div>}
      </div>}

      {tab === 'config' && <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">页面</div><code className="text-teal-300">{window.location.hash || '#/'}</code></div>
          <div className="rounded border border-slate-800 p-2"><div className="text-slate-500">窗口</div><span>{window.innerWidth} × {window.innerHeight}</span></div>
        </div>
        <label className="text-slate-500">动作列表（JSON）</label>
        <textarea value={actionsText} onChange={event => setActionsText(event.target.value)} rows={14} spellCheck={false}
          className="w-full resize-y rounded border border-slate-700 bg-slate-950 px-2 py-1.5 font-mono text-[10px] leading-4 text-slate-200 outline-none focus:border-teal-500" />
        <div className="flex gap-2">
          <button type="button" onClick={saveActions} className="rounded bg-teal-600 px-2.5 py-1 font-medium text-white hover:bg-teal-500">保存动作</button>
          <button type="button" onClick={() => { setActionsText(JSON.stringify(DEFAULT_ACTIONS, null, 2)); setNotice('已填入默认动作，点保存生效'); }}
            className="flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500"><ReloadOutlined />默认值</button>
        </div>
        <p className="text-slate-500">动作类型：navigate（页面）、invoke（接口，args 为参数数组）、event（触发事件，可先 navigate）、mock（随机提醒，args[0] 为条数）、clear-mock、reload、reset。仅写入本机 localStorage。</p>
      </div>}
    </div>
    <footer className="border-t border-slate-800 px-3 py-1 text-[10px] text-slate-500">接口调用按真实逻辑执行（含写操作）；结果可能含业务数据，仅开发端使用；正式包不会加载此面板。</footer>
  </aside>;
}
