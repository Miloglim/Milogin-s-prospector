import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, List, Pagination, Space } from 'antd';
import { ONLINE_CHANNELS as CHANNEL, ONLINE_LIMITS, TASK_LIMITS } from '../../../shared/online-crm';
import type { Result, LeadDetail, FollowupTask, TaskPage, TaskCreate, TaskReschedule, TaskComplete } from '../../../shared/online-crm';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';

const TASK_PAGE_SIZE = 50;
const PREWRITE_ERRORS = ['INVALID_INPUT', 'FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'CONFLICT', 'PASSWORD_CHANGE_REQUIRED'];
type DraftCommand = { channel: string; input: TaskCreate | TaskReschedule | TaskComplete };
type EditTask = { task: FollowupTask; action: 'complete' | 'reschedule' };
function dueIso(value: string): string | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function localDate(value: string): string {
  const date = new Date(value);
  return [date.getFullYear(), '-', String(date.getMonth() + 1).padStart(2, '0'), '-', String(date.getDate()).padStart(2, '0'), 'T', String(date.getHours()).padStart(2, '0'), ':', String(date.getMinutes()).padStart(2, '0')].join('');
}
async function invoke<T>(channel: string, input: unknown): Promise<Result<T>> {
  try { return await window.api.invoke(channel, input) as Result<T>; }
  catch { return { ok: false, error: { code: 'UNAVAILABLE', message: '任务中心连接中断，请重试' } }; } // Do not fall back to a local task write.
}

/** Keyed by account and customer; old responses cannot populate a different customer's task list. */
export function FollowupTasks({ detail, canCreate, opportunity }: { detail: LeadDetail; canCreate: boolean; opportunity?: {opportunityId:string;title:string} }) {
  const [tasks, setTasks] = useState<FollowupTask[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState<EditTask | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const alive = useRef(true);
  const pending = useRef<DraftCommand | null>(null);
  const loading = useRef(false);
  const mutation = useRef(false);
  const listSequence = useRef(0);
  const highlightedTask = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('taskId');
  async function refresh() {
    if (loading.current || mutation.current) return;
    loading.current = true;
    const sequence = ++listSequence.current;
    const result = await invoke<TaskPage>(CHANNEL.TASK_LIST, { customerId: detail.customerId, limit: TASK_PAGE_SIZE, offset: (page - 1) * TASK_PAGE_SIZE });
    loading.current = false;
    if (!alive.current || sequence !== listSequence.current) return;
    if (result.ok && result.data && Array.isArray(result.data.items) && Number.isSafeInteger(result.data.total)) {
      setTasks(result.data.items); setTotal(result.data.total);
    } else if (result.ok) {
      setTasks([]); setTotal(0); setError('任务列表响应无效');
    } else {
      setError(result.error.message);
      if (['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'PASSWORD_CHANGE_REQUIRED'].includes(result.error.code)) setTasks([]);
    }
  }
  useEffect(() => {
    alive.current = true; void refresh();
    return () => { alive.current = false; listSequence.current++; };
  }, [page]);
  useVisiblePolling(refresh, ONLINE_LIMITS.pollMs);
  useEffect(() => {
    if (highlightedTask && tasks.some(task => task.taskId === highlightedTask)) document.getElementById(`task-${highlightedTask}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [highlightedTask, tasks]);
  async function save() {
    if (mutation.current) return;
    if (!pending.current) {
      const iso = dueIso(dueAt);
      const idempotencyKey = crypto.randomUUID();
      if (editing?.action === 'complete') {
        if (!feedback.trim()) { setError('请填写完成反馈'); return; }
        pending.current = { channel: CHANNEL.TASK_COMPLETE, input: { taskId: editing.task.taskId, expectedVersion: editing.task.version, idempotencyKey, feedback: feedback.trim() } };
      } else if (!iso) { setError('请选择跟进时间'); return; }
      else if (editing) pending.current = { channel: CHANNEL.TASK_RESCHEDULE, input: { taskId: editing.task.taskId, expectedVersion: editing.task.version, idempotencyKey, dueAt: iso } };
      else {
        if (!title.trim()) { setError('请填写任务'); return; }
        pending.current = { channel: CHANNEL.TASK_CREATE, input: { customerId: detail.customerId, expectedCustomerVersion: detail.version, idempotencyKey, title: title.trim(), dueAt: iso, ...(opportunity ? {opportunityId:opportunity.opportunityId}: {}) } };
      }
    }
    mutation.current = true; loading.current = false; listSequence.current++;
    setBusy(true); setError('');
    const result = await invoke<FollowupTask>(pending.current.channel, pending.current.input);
    mutation.current = false;
    if (!alive.current) return;
    setBusy(false);
    if (result.ok) {
      pending.current = null; setUncertain(false); setEditing(null); setTitle(''); setDueAt(''); setFeedback('');
      await refresh();
    } else {
      if (PREWRITE_ERRORS.includes(result.error.code)) { pending.current = null; setUncertain(false); }
      else setUncertain(true);
      setError(result.error.message);
      await refresh();
    }
  }
  const locked = busy || uncertain;
  return <section className="customer-detail-section customer-tasks">
    <div className="customer-receipt-heading"><h2>下一步</h2><Button type="text" size="small" disabled={busy} onClick={() => { setError(''); void refresh(); }}>刷新</Button></div>
    {error && <Alert type="error" message={error} />}
    {canCreate && <div className="customer-task-draft">
      {(editing?.task.opportunityTitle || (!editing && opportunity?.title)) && <span>{editing?.task.opportunityTitle ?? opportunity?.title}</span>}
      {editing?.action === 'complete' ? <Input.TextArea rows={2} aria-label="完成反馈" placeholder="完成反馈" value={feedback} maxLength={TASK_LIMITS.feedback} disabled={locked} onChange={event => setFeedback(event.target.value)} /> : <>
        {!editing && <Input aria-label="下一步任务" placeholder="下一步任务" value={title} maxLength={TASK_LIMITS.title} disabled={locked} onChange={event => setTitle(event.target.value)} />}
        <Input type="datetime-local" aria-label="下次跟进时间" value={dueAt} disabled={locked} onChange={event => setDueAt(event.target.value)} />
      </>}
      <Space><Button type="primary" size="small" loading={busy} onClick={() => void save()}>{uncertain ? '重试' : editing?.action === 'complete' ? '保存反馈' : editing ? '保存时间' : '安排跟进'}</Button>{editing && <Button size="small" disabled={locked} onClick={() => { setEditing(null); setDueAt(''); setFeedback(''); setError(''); }}>取消</Button>}</Space>
    </div>}
    <List size="small" locale={{ emptyText: '暂无任务' }} dataSource={tasks} renderItem={task => {
      const completed = task.status === 'completed';
      return <List.Item id={`task-${task.taskId}`} className={task.taskId === highlightedTask ? 'customer-task-highlight' : undefined} actions={!completed && task.canManage ? [<Button key="complete" type="text" size="small" disabled={locked} onClick={() => { setEditing({ task, action: 'complete' }); setFeedback(''); setError(''); }}>完成</Button>, <Button key="reschedule" type="text" size="small" disabled={locked} onClick={() => { setEditing({ task, action: 'reschedule' }); setDueAt(localDate(task.dueAt)); setError(''); }}>延期</Button>] : undefined}>
        <List.Item.Meta title={<span>{task.title}</span>} description={<><span className={!completed && new Date(task.dueAt).getTime() < Date.now() ? 'customer-task-overdue' : ''}>{completed ? '已完成' : new Date(task.dueAt).toLocaleString('zh-CN')}</span>{task.opportunityTitle && <span> · {task.opportunityTitle}</span>}{task.responsibleName && <span> · {task.responsibleName}</span>}{completed && task.feedback && <div>{task.feedback}</div>}</>} />
      </List.Item>;
    }} />
    {total > TASK_PAGE_SIZE && <Pagination size="small" current={page} total={total} pageSize={TASK_PAGE_SIZE} showSizeChanger={false} onChange={value => setPage(value)} />}
  </section>;
}
