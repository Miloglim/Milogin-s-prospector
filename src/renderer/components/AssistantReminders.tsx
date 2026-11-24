import { useCallback, useEffect, useState } from 'react';
import { Checkbox, Modal, Segmented, Switch, Tooltip } from 'antd';
import { EyeOutlined, RightOutlined, SettingOutlined } from '@ant-design/icons';
import { DiamondLogo } from './DiamondLogo';
import { useAssistantPulse, useSharedAssistantPulse } from '../hooks/useAssistantPulse';
import { ASSISTANT_CHANNELS, ASSISTANT_INTERVAL_OPTIONS, type AssistantChecks, type AssistantReminder } from '../../shared/assistant';
import { AssistantCardPreview } from './AssistantCardPreview';
import { AssistantActionCard, AssistantAttentionList } from './AssistantBriefingCards';
import { AssistantTaskWorkspace, reminderKind } from './AssistantTaskWorkspace';
import { assistantQueueItems } from '../lib/assistant-queue';
import { DEV_ASSISTANT_MOCK_EVENT, clearAssistantMock, readAssistantMock, saveAssistantMock } from '../lib/dev-assistant-mock';
import { useOptionalIdentity } from '../IdentityContext';

const CHECK_LABELS: Array<[keyof AssistantChecks, string]> = [
  ['mail', '客户待回复'], ['task', '今天到期待办'], ['quoteReview', '待确认报价'], ['stalled', '停滞线索'],
];

function jump(target: string): void {
  if (target === 'team_review') { window.location.hash = '#/team?section=workspace'; return; }
  if (target.startsWith('inbox:')) {
    const id = target.slice(6);
    window.location.hash = !id || id.startsWith('mock') ? '#/inbox' : `#/inbox?detail=${encodeURIComponent(id)}`;
    return;
  }
  if (target.startsWith('customers:')) {
    const [, customerId, contactId] = target.split(':');
    window.location.hash = contactId && contactId !== '0' && customerId
      ? `#/customers?view=table&centerContact=${encodeURIComponent(contactId)}&centerCustomer=${encodeURIComponent(customerId)}`
      : '#/customers?view=table';
  }
}

function timeLabel(value: string | null): string {
  if (!value) return '尚未整理';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? `上次模型整理 ${parsed.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '尚未整理';
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 11 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
}

function assistantPrompt(item: AssistantReminder): string {
  return `帮我处理这件事：${item.title}。${item.detail}\n先告诉我你准备怎么做；涉及发信、改客户或入队之前先让我确认。`;
}

/** 引导对话不按功能菜单排，而是跟着当前事项走；用户直接说一句就能开始。 */
function guidedPrompts(reminders: readonly AssistantReminder[]): string[] {
  const prompts: string[] = [];
  const has = (prefix: string) => reminders.some(item => item.title.startsWith(prefix));
  if (has('客户在等回复')) prompts.push('先把等我回复的客户按紧急程度排一下，并起草最急的一封');
  if (has('待办')) prompts.push('把今天到期的跟进整理成一份行动清单');
  if (has('报价待你确认')) prompts.push('帮我逐条核对这几条待确认报价');
  if (has('跟进停了')) prompts.push('找出停太久的客户，给我今天该联系的名单');
  prompts.push('总结今天的邮箱，告诉我最该先回谁');
  prompts.push('查一条运价：上海 → 汉堡，40HQ');
  prompts.push('按联系人库推荐今天适合发开发信的一组客户');
  return [...new Set(prompts)].slice(0, 3);
}

/** 任务工作台；cards 变体保留给旧对话页和卡片预览。 */
export function AssistantReminders({ onSend, variant = 'cards' }: { onSend?: (text: string) => void; variant?: 'cards' | 'workspace' }) {
  const identity = useOptionalIdentity()?.identity ?? null;
  const userId = identity?.userId ?? null;
  const sharedAssistant = useSharedAssistantPulse();
  const localAssistant = useAssistantPulse(!sharedAssistant);
  const assistant = sharedAssistant ?? localAssistant;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [queue, setQueue] = useState<AssistantReminder[] | null>(null);
  const [mock, setMock] = useState<AssistantReminder[] | null>(() => import.meta.env.DEV ? readAssistantMock(userId) : null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const openPreview = () => setPreviewOpen(true);
    const syncMock = () => setMock(readAssistantMock(userId));
    setMock(readAssistantMock(userId));
    window.addEventListener('dev:assistant-preview', openPreview);
    window.addEventListener(DEV_ASSISTANT_MOCK_EVENT, syncMock);
    return () => {
      window.removeEventListener('dev:assistant-preview', openPreview);
      window.removeEventListener(DEV_ASSISTANT_MOCK_EVENT, syncMock);
    };
  }, [userId]);
  const reminders = [...(mock ?? assistant.snapshot?.reminders ?? [])].sort((left, right) => left.priority - right.priority);
  const urgent = reminders.filter(item => item.priority === 1);
  const actions = urgent.length ? urgent : reminders.slice(0, 1);
  const attention = reminders.filter(item => !actions.includes(item));
  const prompts = guidedPrompts(reminders);
  const settings = assistant.snapshot?.settings ?? { enabled: true, intervalMinutes: 60, checks: { mail: true, task: true, quoteReview: true, stalled: true } };
  const loading = !mock && !assistant.snapshot && assistant.busy;
  const workspace = variant === 'workspace';
  const loadQueue = useCallback(async () => {
    try {
      const items = assistantQueueItems(await window.api.invoke(ASSISTANT_CHANNELS.QUEUE));
      if (items) setQueue(items);
      return items;
    } catch { /* fall back to curated reminders */ return null; }
  }, []);
  useEffect(() => {
    if (!workspace) return;
    void loadQueue();
  }, [workspace, loadQueue, assistant.snapshot?.lastCheckedAt, assistant.snapshot?.reminders.length]);
  const workspaceItems = queue ?? reminders;
  const workspaceCounts = workspaceItems.reduce((counts, item) => { counts[reminderKind(item)] += 1; return counts; }, { mail: 0, quote: 0, task: 0, followup: 0 });
  const title = loading ? '正在整理今天的事项'
    : workspace ? '待处理'
      : reminders.length ? `${greeting()}，${reminders.length} 件事等你处理`
        : `${greeting()}，今天暂时没有紧急事项`;
  const summary = loading ? '稍等一下。'
    : workspace
      ? (workspaceItems.length ? `回复 ${workspaceCounts.mail} · 报价 ${workspaceCounts.quote} · 待办 ${workspaceCounts.task} · 跟进 ${workspaceCounts.followup}` : '今天没有待处理事项')
      : reminders.length ? `我先按优先级整理好了${attention.length ? `，另外 ${attention.length} 件在下面` : ''}。你也可以直接告诉我想做什么。`
        : '需要查客户、看运价或处理待办，直接告诉我。';
  const dismiss = (item: AssistantReminder) => {
    if (item.reminderId.startsWith('queue:')) return;
    if (mock) { saveAssistantMock(mock.filter(entry => entry.reminderId !== item.reminderId), userId); return; }
    void assistant.dismiss(item);
  };
  const selectQuoteCandidate = async (item: AssistantReminder, candidateId: string) => {
    const messageId = item.facts?.messageId;
    if (!messageId) return;
    if (mock) {
      const candidate = item.facts?.candidates?.find(value => value.id === candidateId) ?? null;
      saveAssistantMock(mock.map(entry => entry.reminderId === item.reminderId && candidate
        ? { ...entry, facts: { ...entry.facts, selectedCandidateId: candidate.id, carrier: candidate.carrier, pol: candidate.pol, pod: candidate.pod, containerType: candidate.containerType, price: candidate.price, currency: candidate.currency, validTo: candidate.validTo } }
        : entry), userId);
      return;
    }
    const result = await window.api.invoke('inbox:quoteSelect', { messageId, candidateId }) as { success?: boolean } | null;
    if (result?.success) window.location.hash = `#/inbox?detail=${messageId}`;
  };
  const completeInboxItem = async (item: AssistantReminder) => {
    const messageId = item.facts?.messageId;
    if (!messageId) return;
    try {
      const result = await window.api.invoke('inbox:todoState', {
        messageId, state: 'done', idempotencyKey: `assistant-done-${messageId}-${Date.now()}`,
      }) as { success?: boolean } | null;
      if (!result?.success) { void loadQueue(); return; }
      await loadQueue();
    } catch { void loadQueue(); }
  };
  return <>
    <section className={`w-full flex flex-col ${workspace ? 'h-full min-h-0' : 'gap-4'}`} aria-label={workspace ? '任务工作台' : '助手建议'}>
      {!workspace && <header className="flex items-start gap-3">
        <span className="mt-0.5 flex-none"><DiamondLogo size={26} state={assistant.busy ? 'running' : 'idle'} /></span>
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold leading-6 text-gray-800">{title}</h2>
          <p className="mt-0.5 text-[12px] leading-5 text-gray-400">{summary}</p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 text-gray-400">
          {import.meta.env.DEV && mock && <button type="button" onClick={() => clearAssistantMock(userId)} title="清除 Mock，回到真实提醒" className="mr-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 hover:bg-amber-100">Mock {mock.length} 条 ×</button>}
          {import.meta.env.DEV && <Tooltip title="卡片预览"><button type="button" aria-label="卡片预览" className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-gray-100 hover:text-teal-700" onClick={() => setPreviewOpen(true)}><EyeOutlined /></button></Tooltip>}
          <Tooltip title="提醒设置"><button type="button" aria-label="提醒设置" className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-gray-100 hover:text-teal-700" onClick={() => setSettingsOpen(true)}><SettingOutlined /></button></Tooltip>
        </div>
      </header>}

      {workspace ? (loading ? <div className="grid min-h-0 flex-1 grid-cols-[360px_minmax(0,1fr)] overflow-hidden bg-white max-[1180px]:grid-cols-[320px_minmax(0,1fr)]">
        <div className="flex flex-col gap-3 border-r border-gray-100 p-3">
          {[0, 1, 2, 3, 4].map(row => <div key={row} className="h-11 animate-pulse rounded bg-gray-50" />)}
        </div>
        <div className="p-5"><div className="h-4 w-1/3 animate-pulse rounded bg-gray-100" /><div className="mt-3 h-3 w-2/3 animate-pulse rounded bg-gray-50" /><div className="mt-6 h-24 animate-pulse rounded bg-gray-50" /></div>
      </div> : <AssistantTaskWorkspace items={workspaceItems} busy={assistant.busy}
        onOpen={item => jump(item.target)}
        onDismiss={dismiss}
        onOpenTarget={jump}
        onComplete={item => { void completeInboxItem(item); }}
        onSelectCandidate={(item, candidateId) => { void selectQuoteCandidate(item, candidateId); }} />)
        : <>
          {actions.map(action => <AssistantActionCard key={action.reminderId} item={action}
            onOpen={() => jump(action.target)}
            onAsk={onSend ? () => onSend(assistantPrompt(action)) : undefined}
            onDismiss={() => dismiss(action)}
            onOpenTarget={jump}
            onSelectCandidate={(candidateId) => { void selectQuoteCandidate(action, candidateId); }} />)}

          {attention.length > 0 && <AssistantAttentionList items={attention} onOpen={item => jump(item.target)} />}

          {onSend && <section aria-label="可以这样问">
            <div className="px-1 text-[11px] text-gray-400">可以这样问</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {prompts.map(prompt => <button key={prompt} type="button" onClick={() => onSend(prompt)}
                className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[12px] text-gray-600 transition-colors hover:border-teal-300 hover:bg-teal-50/60 hover:text-teal-700">
                <span className="truncate">{prompt}</span>
                <RightOutlined className="!text-[10px] text-gray-300 group-hover:text-teal-500" />
              </button>)}
            </div>
          </section>}
        </>}
    </section>
    <Modal open={settingsOpen} title="提醒设置" footer={null} width={380} onCancel={() => setSettingsOpen(false)}>
      <div className="flex flex-col gap-3.5">
        <label className="flex items-center justify-between text-[12px] text-gray-700"><span>自动整理</span><Switch checked={settings.enabled} onChange={enabled => void assistant.updateSettings({ enabled })} /></label>
        <div className="flex flex-col gap-1.5 text-[12px] text-gray-700"><span>模型整理间隔</span>
          <Segmented size="small" value={settings.intervalMinutes} options={ASSISTANT_INTERVAL_OPTIONS.map(value => ({ value, label: value < 60 ? `${value} 分钟` : `${value / 60} 小时` }))} onChange={value => void assistant.updateSettings({ intervalMinutes: Number(value) })} />
        </div>
        <div className="flex flex-col gap-1.5 text-[12px] text-gray-700"><span>提醒来源</span>
          {CHECK_LABELS.map(([key, label]) => <Checkbox key={key} checked={settings.checks[key]} onChange={event => void assistant.updateSettings({ checks: { ...settings.checks, [key]: event.target.checked } })}>{label}</Checkbox>)}
        </div>
        <div className="border-t border-gray-100 pt-3 text-[11px] text-gray-400">{timeLabel(assistant.snapshot?.lastCheckedAt ?? null)} · 状态变化会即时更新</div>
      </div>
    </Modal>
    {import.meta.env.DEV && <AssistantCardPreview open={previewOpen} onClose={() => setPreviewOpen(false)} />}
  </>;
}
