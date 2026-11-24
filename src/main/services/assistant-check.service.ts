import type { AssistantReminder, AssistantReminderFacts, AssistantRunResult, AssistantSettings, AssistantSnapshot } from '../../shared/assistant';
import type { QuoteReviewPage, SalesCase, TaskPage } from '../../shared/online-crm';
import type { OnlineCrmPort } from './online-crm.service';
import { salesWorkflowClient } from './sales-workflow-client.service';
import { chatJson, isAiConfigured } from './ai.service';
import { assistantDue, assistantSelection, fallbackAssistantSelection, type AssistantCandidate } from '../core/assistant';
import { assistantSettings, assistantState, dismissAssistantReminder, listAssistantReminders, markAssistantRun, saveAssistantReminders, saveAssistantSettings } from '../core/assistant-storage';
import { getRawDb } from '../db';
import { Log } from '../logger';
import { currentMailAiMode } from '../core/inbox-ai-mode';

type Port = Pick<OnlineCrmPort, 'request'>;
type ChatJson = typeof chatJson;

export interface AssistantServiceOptions {
  port?: Port | null;
  chat?: ChatJson;
  now?: () => number;
}

function sameReminderView(left: AssistantSnapshot['reminders'], right: AssistantSnapshot['reminders']): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const next = right[index];
    return !!next && item.reminderId === next.reminderId && item.title === next.title
      && item.detail === next.detail && item.target === next.target && item.priority === next.priority
      && item.source === next.source && item.kind === next.kind && JSON.stringify(item.facts ?? null) === JSON.stringify(next.facts ?? null);
  });
}

const MAX_CANDIDATES = 24;
const MAIL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const TASK_WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_CASE_MS = 2 * 24 * 60 * 60 * 1000;
// 询价/报价邮件归“报价确认”卡，不再重复生成客户回复卡。
const ACTIONABLE_CATEGORIES = "('reply_needed','schedule_request','order_followup','complaint','cooperation')";
const INBOX_TODO_CATEGORIES = "('price_inquiry','quote_request','schedule_request','order_followup','complaint','cooperation')";
const SYSTEM_PROMPT = `你是货代销售助理，负责从系统筛出的候选事项中挑出真正需要今天处理的提醒。
规则：
- 只能使用候选事项里已有的客户、航线、价格、时间信息，不补充、不猜测。
- 同一客户只保留一条最紧急的事项。
- kind=mail 是客户回复，kind=quote 是报价确认，kind=task 是待办聚合，kind=followup 是跟进停滞聚合；四类各保留最多一条，总共最多 4 条。
- 广告、群发运价、纯通知、公司内部邮件不得成为提醒。
- 没有需要处理的就返回 {"items":[]}。
- title 不超过 18 个汉字，detail 不超过 40 个汉字；不要写“建议您”，直接说事情。
输出严格 JSON：{"items":[{"id":"候选 id","title":"...","detail":"..."}]}`;

function iso(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function short(value: string | null | undefined, max: number): string {
  return (value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function whenLabel(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

function mailCandidates(now: number): AssistantCandidate[] {
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = getRawDb().prepare(`SELECT a.message_id AS messageId,a.priority,a.summary,a.next_action AS nextAction,a.due_hint AS dueHint,
        a.updated_at AS updatedAt,m.subject,m.from_name AS fromName,m.from_email AS fromEmail,m.received_at AS receivedAt,m.body_preview AS bodyPreview,
        acc.email AS accountEmail
      FROM inbox_mail_analyses a JOIN inbox_messages m ON m.id=a.message_id
      LEFT JOIN inbox_todo_states t ON t.message_id=a.message_id
      LEFT JOIN email_accounts acc ON acc.id=m.account_id
      WHERE a.status='ready' AND a.requires_action=1 AND a.category IN ${ACTIONABLE_CATEGORIES}
        AND COALESCE(t.state,'')<>'done' AND m.received_at>=?
      ORDER BY CASE a.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,m.received_at DESC LIMIT 12`)
      .all(new Date(now - MAIL_WINDOW_MS).toISOString()) as Array<Record<string, unknown>>;
  } catch (error) {
    Log.warn('assistant.mail', `读取待回复邮件失败: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  return rows.map(row => {
    const messageId = Number(row.messageId);
    const sender = short(String(row.fromName || row.fromEmail || '客户'), 30);
    const received = iso(String(row.receivedAt ?? ''));
    const waitedHours = Number.isFinite(received) ? Math.max(0, Math.floor((now - received) / 3_600_000)) : null;
    const senderDomain = String(row.fromEmail || '').toLowerCase().split('@')[1] || '';
    const accountDomain = String(row.accountEmail || '').toLowerCase().split('@')[1] || '';
    const internal = Boolean(senderDomain && accountDomain && senderDomain === accountDomain);
    const lastAction = String(row.nextAction || row.summary || row.subject || '打开邮件处理');
    return {
      id: `mail-${messageId}`, signature: `mail:${messageId}:${String(row.updatedAt || '')}`,
      kind: 'mail' as const,
      title: `${internal ? '同事' : '客户'}在等回复：${sender}`,
      detail: short(lastAction, 60),
      target: `inbox:${messageId}`, priority: row.priority === 'urgent' ? 1 : row.priority === 'important' ? 2 : 3,
      facts: {
        messageId,
        senderEmail: row.fromEmail ? String(row.fromEmail) : null,
        customerName: row.fromName ? String(row.fromName) : null,
        subject: row.subject ? String(row.subject) : null,
        waitedHours,
        receivedAt: Number.isFinite(received) ? new Date(received).toISOString() : null,
        lastAction: short(lastAction, 120),
        analysis: [row.summary, row.nextAction, row.dueHint].filter(value => typeof value === 'string' && value.trim()).map(value => String(value).trim()).join('\n'),
        mailExcerpt: row.bodyPreview ? String(row.bodyPreview).slice(0, 1200) : null,
      },
    };
  });
}

/** Inbox todos use the same admission rules as the inbox 待办 counter. */
function todoCandidates(now: number): AssistantCandidate[] {
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = getRawDb().prepare(`SELECT a.message_id AS messageId,a.priority,a.category,a.summary,a.next_action AS nextAction,
        a.due_hint AS dueHint,a.updated_at AS updatedAt,m.subject,m.from_name AS fromName,m.from_email AS fromEmail,
        m.received_at AS receivedAt,m.body_preview AS bodyPreview,m.my_role AS myRole,acc.email AS accountEmail
      FROM inbox_mail_analyses a JOIN inbox_messages m ON m.id=a.message_id
      LEFT JOIN inbox_todo_states t ON t.message_id=a.message_id
      LEFT JOIN email_accounts acc ON acc.id=m.account_id
      WHERE a.status='ready' AND COALESCE(t.state,'')<>'done' AND COALESCE(m.my_role,'')<>'cc'
        AND (t.state='open' OR (a.requires_action=1 AND a.confidence>=0.75 AND a.category IN ${INBOX_TODO_CATEGORIES}))
        AND m.received_at>=?
      ORDER BY CASE a.priority WHEN 'urgent' THEN 0 WHEN 'important' THEN 1 ELSE 2 END,m.received_at DESC LIMIT 50`)
      .all(new Date(now - MAIL_WINDOW_MS).toISOString()) as Array<Record<string, unknown>>;
  } catch (error) {
    Log.warn('assistant.todo', `读取收件箱待办失败: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  return rows.flatMap(row => {
    const messageId = Number(row.messageId);
    if (!messageId) return [];
    const senderDomain = String(row.fromEmail || '').toLowerCase().split('@')[1] || '';
    const accountDomain = String(row.accountEmail || '').toLowerCase().split('@')[1] || '';
    if (senderDomain && accountDomain && senderDomain === accountDomain) return [];
    const subject = String(row.subject || row.summary || '待处理邮件');
    const action = String(row.nextAction || row.summary || '打开邮件处理');
    const received = iso(String(row.receivedAt ?? ''));
    const waitedHours = Number.isFinite(received) ? Math.max(0, Math.floor((now - received) / 3_600_000)) : null;
    return [{
      id: `todo-${messageId}`, signature: `todo:${messageId}:${String(row.updatedAt || '')}`,
      kind: 'task' as const,
      title: short(subject, 60), detail: short(action, 60), target: `inbox:${messageId}`,
      priority: row.priority === 'urgent' ? 1 : row.priority === 'important' ? 2 : 3,
      facts: {
        messageId,
        senderEmail: row.fromEmail ? String(row.fromEmail) : null,
        customerName: row.fromName ? String(row.fromName) : null,
        subject,
        waitedHours,
        receivedAt: Number.isFinite(received) ? new Date(received).toISOString() : null,
        lastAction: short(action, 120),
        analysis: [row.summary, row.nextAction, row.dueHint].filter(value => typeof value === 'string' && value.trim()).map(value => String(value).trim()).join('\n'),
        mailExcerpt: row.bodyPreview ? String(row.bodyPreview).slice(0, 1200) : null,
        items: [{ id: `todo-${messageId}`, title: short(subject, 60), detail: short(action, 80), target: `inbox:${messageId}`, meta: row.dueHint ? String(row.dueHint) : '待处理' }],
        total: 1,
      },
    } satisfies AssistantCandidate];
  });
}

async function taskCandidates(port: Port | null, now: number): Promise<AssistantCandidate[]> {
  if (!port) return [];
  const result = await port.request<TaskPage>('GET', '/api/crm/tasks?status=open&mine=true&limit=50&offset=0');
  if (!result.ok) return [];
  const items = result.data.items.flatMap(task => {
    const due = iso(task.dueAt);
    if (!Number.isFinite(due) || due > now + TASK_WINDOW_MS) return [];
    return [{
      id: `task-${task.taskId}`,
      title: short(task.title, 60) || '待办需要处理',
      detail: due < now ? `已逾期，原定 ${whenLabel(due)}` : `到期 ${whenLabel(due)}`,
      target: task.sourceContactId ? `customers:${task.customerId}:${task.sourceContactId}` : 'customers:',
      due,
      overdue: due < now,
    }];
  });
  if (!items.length) return [];
  items.sort((left, right) => left.due - right.due);
  const overdueCount = items.filter(item => item.overdue).length;
  return [{
    id: 'task-batch', signature: `tasks:${items.map(item => `${item.id}:${item.due}`).join('|')}`,
    kind: 'task' as const,
    title: `待办到期：${items.length} 项`,
    detail: overdueCount ? `${overdueCount} 项已逾期 · 最早 ${whenLabel(items[0]!.due)}` : `最早 ${whenLabel(items[0]!.due)} 到期`,
    target: items[0]!.target,
    priority: overdueCount ? 1 : 2,
    facts: {
      items: items.map(item => ({ id: item.id, title: item.title, detail: item.detail, target: item.target, meta: item.overdue ? '已逾期' : '今天到期' })),
      total: items.length,
      overdueCount,
      dueAt: new Date(items[0]!.due).toISOString(),
      earliestDueAt: new Date(items[0]!.due).toISOString(),
    },
  } satisfies AssistantCandidate];
}

const QUOTE_FIELD_LABELS: Record<string, string> = {
  pol: '起运港', pod: '目的港', containerTypes: '柜型', quantity: '数量', commodity: '品名',
  weight: '重量', incoterm: '贸易条款', targetPrice: '目标价', validity: '有效期',
};

function quoteFieldText(raw: unknown): string {
  if (raw == null) return '';
  if (Array.isArray(raw)) return raw.map(quoteFieldText).filter(Boolean).join(', ');
  if (typeof raw === 'object') {
    const value = (raw as { value?: unknown }).value;
    return value === undefined ? '' : quoteFieldText(value);
  }
  return String(raw).trim();
}

type QuoteFactsCandidate = NonNullable<AssistantReminderFacts['candidates']>[number];

function quoteCandidates(raw: string | null): QuoteFactsCandidate[] {
  try {
    const parsed = raw ? JSON.parse(raw) as unknown : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(value => {
      if (!value || typeof value !== 'object') return [];
      const row = value as Record<string, unknown>;
      const id = String(row.id ?? '').trim();
      if (!id) return [];
      return [{
        id,
        carrier: row.carrier == null ? null : String(row.carrier),
        pol: row.pol == null ? null : String(row.pol),
        pod: row.pod == null ? null : String(row.pod),
        containerType: row.containerType == null ? null : String(row.containerType),
        price: typeof row.price === 'number' ? row.price : null,
        currency: row.currency == null ? null : String(row.currency),
        validTo: row.validTo == null ? null : String(row.validTo),
      }];
    }).slice(0, 12);
  } catch { /* 损坏的本地报价缓存不阻塞提醒 */ return []; }
}

function quoteFactsFromLocal(row: Record<string, unknown>): AssistantReminderFacts {
  const candidates = quoteCandidates(row.candidatesJson == null ? null : String(row.candidatesJson));
  let selected: QuoteFactsCandidate | null = null;
  try {
    const parsed = row.selectedJson ? JSON.parse(String(row.selectedJson)) as Record<string, unknown> : null;
    if (parsed && typeof parsed.id === 'string') selected = quoteCandidates(JSON.stringify([parsed]))[0] ?? null;
  } catch { /* 未选报价时保持 null */ }
  const chosen = selected ?? candidates[0] ?? null;
  let fields: Record<string, unknown> = {};
  try { fields = row.fieldsJson ? JSON.parse(String(row.fieldsJson)) as Record<string, unknown> : {}; }
  catch { fields = {}; /* 字段缓存损坏时只显示报价条目 */ }
  const fieldSummary = Object.entries(QUOTE_FIELD_LABELS).flatMap(([key, label]) => {
    const value = quoteFieldText(fields[key]);
    return value ? [{ label, value }] : [];
  });
  return {
    messageId: Number(row.messageId),
    quoteCaseId: row.quoteCaseId ? String(row.quoteCaseId) : null,
    customerName: row.fromName ? String(row.fromName) : null,
    customerEmail: row.fromEmail ? String(row.fromEmail) : null,
    subject: row.subject ? String(row.subject) : null,
    analysis: row.summary ? String(row.summary) : null,
    mailExcerpt: row.bodyPreview ? String(row.bodyPreview).slice(0, 1200) : null,
    pol: chosen?.pol ?? (quoteFieldText(fields.pol) || null),
    pod: chosen?.pod ?? (quoteFieldText(fields.pod) || null),
    carrier: chosen?.carrier ?? null,
    containerType: chosen?.containerType ?? (quoteFieldText(fields.containerTypes) || null),
    selectedCandidateId: chosen?.id ?? null,
    price: chosen?.price ?? null,
    currency: chosen?.currency ?? null,
    validTo: chosen?.validTo ?? null,
    fieldSummary,
    candidates,
    receivedAt: row.receivedAt ? String(row.receivedAt) : null,
    source: 'navigator',
  };
}

function localQuoteCandidates(now: number): AssistantCandidate[] {
  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = getRawDb().prepare(`SELECT c.message_id AS messageId,c.quote_case_id AS quoteCaseId,c.state,
        c.fields_json AS fieldsJson,c.missing_fields_json AS missingJson,c.selected_candidate_json AS selectedJson,
        c.candidates_json AS candidatesJson,c.summary,c.updated_at AS updatedAt,
        m.from_email AS fromEmail,m.from_name AS fromName,m.subject,m.body_preview AS bodyPreview,m.received_at AS receivedAt
      FROM inbox_quote_cards c JOIN inbox_messages m ON m.id=c.message_id
      WHERE c.state IN ('ready','fields_pending','querying','failed')
      ORDER BY c.updated_at DESC LIMIT 20`).all() as Array<Record<string, unknown>>;
  } catch (error) {
    Log.warn('assistant.quote', `读取本地报价卡失败: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  return rows.map(row => {
    const facts = quoteFactsFromLocal(row);
    const candidates = facts.candidates ?? [];
    const customer = String(row.fromName || row.fromEmail || '客户');
    const lane = [facts.pol, facts.pod].filter(Boolean).join('→');
    const hasQuote = !!facts.price;
    const detail = hasQuote
      ? [lane, facts.carrier, facts.containerType, `${facts.currency || 'USD'} ${facts.price}`].filter(Boolean).join(' · ')
      : candidates.length ? `${candidates.length} 条匹配报价 · 待选择` : '等待补充运输需求';
    return {
      id: `inquiry-quote-${row.messageId}`, signature: `inquiry-quote:${String(row.quoteCaseId || row.messageId)}:${String(row.updatedAt)}:${candidates.length}`,
      kind: 'quote' as const,
      title: `${hasQuote || candidates.length ? '报价待你确认' : '询价待补充'}：${short(customer, 24)}`,
      detail: short(detail, 60),
      target: `inbox:${String(row.messageId)}`,
      priority: rows.length && iso(String(row.receivedAt ?? '')) && now - iso(String(row.receivedAt)) > 2 * 60 * 60 * 1000 ? 1 : 2,
      facts,
    } satisfies AssistantCandidate;
  });
}

async function quoteReviewCandidates(port: Port | null, now: number): Promise<AssistantCandidate[]> {
  const local = localQuoteCandidates(now);
  const localCases = new Set(local.map(item => item.facts?.quoteCaseId).filter(Boolean));
  if (!port) return local;
  const result = await port.request<QuoteReviewPage>('GET', '/api/crm/quote-cases/reviews?status=pending&limit=10&offset=0');
  if (!result.ok) return local;
  const reviews = result.data.items.filter(item => !localCases.has(item.quoteCaseId)).map(item => {
    const candidate = item.selectedCandidate;
    const lane = [candidate?.pol, candidate?.pod].filter(Boolean).join('→');
    const created = iso(item.createdAt);
    const age = Number.isFinite(created) ? now - created : 0;
    return {
      id: `review-${item.reviewId}`, signature: `review:${item.reviewId}`,
      kind: 'quote' as const,
      title: `报价待你确认：${short(item.customerName || '客户', 24)}`,
      detail: short([lane, candidate?.carrier, candidate?.containerType, candidate?.price == null ? '' : `${candidate.currency || 'USD'} ${candidate.price}`].filter(Boolean).join(' · ') || '等待核对报价', 60),
      target: 'team_review', priority: age > 4 * 60 * 60 * 1000 ? 1 : 2,
      facts: {
        quoteCaseId: item.quoteCaseId, customerName: item.customerName, subject: item.subject,
        pol: candidate?.pol ?? null, pod: candidate?.pod ?? null, carrier: candidate?.carrier ?? null,
        containerType: candidate?.containerType ?? null, price: candidate?.price ?? null, currency: candidate?.currency ?? null,
        selectedCandidateId: candidate?.id ?? null,
        validTo: candidate?.validTo ?? null,
        candidates: item.candidates.slice(0, 12).map(value => ({ id: value.id, carrier: value.carrier, pol: value.pol, pod: value.pod, containerType: value.containerType, price: value.price, currency: value.currency, validTo: value.validTo })),
        receivedAt: Number.isFinite(created) ? new Date(created).toISOString() : null,
        source: 'center',
      },
    } satisfies AssistantCandidate;
  });
  return [...local, ...reviews];
}

async function stalledCandidates(port: Port | null, now: number): Promise<AssistantCandidate[]> {
  if (!port) return [];
  const result = await port.request<SalesCase[]>('GET', '/api/crm/sales-cases?limit=50&offset=0');
  if (!result.ok) return [];
  const items = result.data.flatMap(item => {
    if (['won', 'lost', 'paused'].includes(item.state) || !item.nextAction) return [];
    const updated = iso(item.updatedAt);
    if (!Number.isFinite(updated) || now - updated < STALE_CASE_MS) return [];
    const days = Math.floor((now - updated) / 86_400_000);
    return [{
      id: `case-${item.caseId}`,
      days,
      title: `跟进停了 ${days} 天：${short(item.nextAction, 40)}`,
      detail: short(item.latestSummary || item.source || '确认客户下一步', 80),
      target: `customers:${item.customerId}:${item.contactId}`,
    }];
  });
  if (!items.length) return [];
  items.sort((left, right) => right.days - left.days);
  return [{
    id: 'followup-batch', signature: `followups:${items.map(item => `${item.id}:${item.days}`).join('|')}`,
    kind: 'followup' as const,
    title: `跟进停滞：${items.length} 个客户`,
    detail: `最久 ${items[0]!.days} 天 · ${short(items[0]!.title.replace(/^跟进停了 \d+ 天：/, ''), 40)}`,
    target: items[0]!.target,
    priority: 2,
    facts: {
      items: items.map(item => ({ id: item.id, title: item.title, detail: item.detail, target: item.target, meta: `停了 ${item.days} 天` })),
      total: items.length,
      maxDays: items[0]!.days,
    },
  } satisfies AssistantCandidate];
}

export function createAssistantService(options: AssistantServiceOptions = {}) {
  const clock = options.now ?? (() => Date.now());
  const chat = options.chat ?? chatJson;
  let running = false;

  const snapshot = (): AssistantSnapshot => {
    const settings = assistantSettings();
    const state = assistantState();
    return {
      reminders: listAssistantReminders(clock()),
      settings,
      lastCheckedAt: state.lastCheckedAt,
      lastError: state.lastError,
      aiConfigured: currentMailAiMode() === 'live' && isAiConfigured(),
      due: settings.enabled && assistantDue(state.lastCheckedAt, settings.intervalMinutes, clock()),
    };
  };

  const evaluate = async (useModel: boolean, recordCheck: boolean): Promise<AssistantRunResult> => {
    const before = snapshot();
    if (!before.settings.enabled) return { ...before, ran: false };
    if (running) return { ...before, ran: false };
    running = true;
    const now = clock();
    try {
      const port = options.port !== undefined ? options.port : salesWorkflowClient();
      const checks = before.settings.checks;
      const groups = await Promise.all([
        checks.mail ? Promise.resolve(mailCandidates(now)) : Promise.resolve([]),
        checks.task ? taskCandidates(port, now) : Promise.resolve([]),
        checks.quoteReview ? quoteReviewCandidates(port, now) : Promise.resolve([]),
        checks.stalled ? stalledCandidates(port, now) : Promise.resolve([]),
      ]);
      const candidates = groups.flat().slice(0, MAX_CANDIDATES);
      if (!candidates.length) {
        saveAssistantReminders([], 'rule', now);
        if (recordCheck) markAssistantRun('empty', null);
        return { ...snapshot(), ran: true };
      }
      let selected = fallbackAssistantSelection(candidates);
      let source: 'ai' | 'rule' = 'rule';
      // Development mock/off modes must not spend real model calls on reminders.
      if (useModel && before.aiConfigured && currentMailAiMode() === 'live') {
        const answer = await chat(SYSTEM_PROMPT, JSON.stringify({ now: new Date(now).toISOString(), candidates }), { feature: 'summary', signal: AbortSignal.timeout(25_000) });
        if (answer.success) {
          selected = assistantSelection(answer.data, candidates);
          source = 'ai';
        } else {
          if (recordCheck) markAssistantRun('rule', short(answer.error, 200));
          saveAssistantReminders(selected, 'rule', now);
          return { ...snapshot(), ran: true };
        }
      }
      saveAssistantReminders(selected, source, now);
      if (recordCheck) markAssistantRun(source, null);
      return { ...snapshot(), ran: true };
    } catch (error) {
      Log.warn('assistant.run', `巡检失败: ${error instanceof Error ? error.message : String(error)}`);
      if (recordCheck) markAssistantRun('failed', '巡检暂不可用');
      return { ...snapshot(), ran: false };
    } finally { running = false; }
  };

  const run = async (force = false): Promise<AssistantRunResult> => {
    const before = snapshot();
    if (!before.settings.enabled) return { ...before, ran: false };
    if (!force && !before.due) return { ...before, ran: false };
    return evaluate(before.aiConfigured, true);
  };

  /** Source changes refresh reminders immediately with rules; the model keeps its configured cadence. */
  const wake = async (): Promise<AssistantRunResult> => {
    const before = snapshot();
    if (!before.settings.enabled) return { ...before, ran: false };
    const result = await evaluate(before.aiConfigured && before.due, before.due);
    return sameReminderView(before.reminders, result.reminders) ? { ...result, ran: false } : result;
  };

  /** Full work queue straight from the source tables; unlike reminders it is not capped by model selection. */
  const queue = async (): Promise<AssistantReminder[]> => {
    const now = clock();
    const port = options.port !== undefined ? options.port : salesWorkflowClient();
    const groups = await Promise.all([
      quoteReviewCandidates(port, now),
      Promise.resolve(mailCandidates(now)),
      Promise.resolve(todoCandidates(now)),
      taskCandidates(port, now),
      stalledCandidates(port, now),
    ]);
    const createdAt = new Date(now).toISOString();
    return groups.flat().slice(0, 200).map(item => ({
      reminderId: `queue:${item.signature}`,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      target: item.target,
      priority: item.priority,
      source: 'rule' as const,
      createdAt,
      facts: item.facts,
    }));
  };

  const dismiss = (reminderId: string): AssistantSnapshot => {
    if (typeof reminderId === 'string' && reminderId) dismissAssistantReminder(reminderId);
    return snapshot();
  };

  const updateSettings = (patch: Partial<AssistantSettings>): AssistantSnapshot => {
    const clean: Partial<AssistantSettings> = {};
    if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
    if (Number.isSafeInteger(patch.intervalMinutes) && Number(patch.intervalMinutes) >= 5 && Number(patch.intervalMinutes) <= 1440) clean.intervalMinutes = Number(patch.intervalMinutes);
    if (patch.checks && typeof patch.checks === 'object') clean.checks = patch.checks;
    saveAssistantSettings(clean);
    return snapshot();
  };

  return { snapshot, run, wake, queue, dismiss, updateSettings };
}

export type AssistantService = ReturnType<typeof createAssistantService>;
