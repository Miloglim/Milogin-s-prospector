import { invalidateDomain } from "../../lib/cacheDeps";
import { isPermissionDenied } from "../../lib/permissionGate";
import { useState, useEffect, useCallback, useDeferredValue, useMemo, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Button, Input, message, Modal, Tooltip, Progress, notification, Dropdown, Popover, Select, Upload, type UploadFile } from "antd";

// (Button etc. used in sub-components)
import {
  ReloadOutlined, MailOutlined, SearchOutlined,
  DeleteOutlined, InboxOutlined, EyeOutlined, PlusOutlined, MoreOutlined, CheckSquareOutlined,
  FolderOutlined, FolderOpenOutlined, PushpinOutlined,
  BulbOutlined, PaperClipOutlined,
  CaretDownOutlined, CaretRightOutlined,
  CalendarOutlined, LeftOutlined, RightOutlined,
  CheckOutlined, UndoOutlined, CloseOutlined,
} from "@ant-design/icons";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { askAssistant } from "../../lib/ask-ai";
import { DiamondLogo } from "../../components/DiamondLogo";
import { STATUS_META, CRM_STAGES } from "../../components/ContactDetail";
import { useOptionalIdentity } from '../../IdentityContext';
import { ONLINE_CHANNELS, TASK_LIMITS, centerContactDisplayStatus, type ContactDelete, type ContactDeleteReceipt, type CenterContactRef, type CenterContactDetail, type ContactTouchStatus, type CustomerStage, type ContactMailAnalysisView, type FollowupTask, type TaskPage } from '../../../shared/online-crm';
import { INBOX_ANALYSIS_CATEGORY_LABELS, INBOX_EVENTS, INBOX_FETCH_PHASES, INBOX_LIST_LIMITS, INBOX_SYNC_PHASES, inboxAnalysisAdmitsAttention, inboxAnalysisAdmitsTodo, normalizeInboxSubject, type InboxAnalysisView, type InboxConversationState, type InboxConversationStateBatchResult, type InboxFetchPhase, type InboxFetchProgress, type InboxLabel, type InboxListPage, type InboxSummary, type InboxSyncSnapshot, type InboxTodoBatchResult, type InboxTodoState, type InboxTodoStateResult } from '../../../shared/inbox';
import { inboxMailNeedsReply, type InboxNeedsReplyMail } from '../../../shared/inbox-needs-reply';
import { completeInboxTask, completeRepliedTask, openInboxTask, type InboxTaskRef } from './inbox-task-sync';
import type { InboxQuoteCard } from '../../../shared/inbox';
import { InboxQuoteCardView } from './InboxQuoteCard';
import { centerInvoke } from '../customers/centerContactPort';
import { MailAnalysisPanel, mailAnalysisListIndicator } from '../customers/CenterContactDetail';
import { projectContactMailHistory } from '../customers/contactMailTimeline';
import { useVisiblePolling } from '../../hooks/useVisiblePolling';
import { useTeamContext } from '../team/team-data';
import { saveTeamEmailReference } from '../team/team-compose';

interface MatchedContact { id: number; email: string; company: string; contactVersion?: number; canDelete?: boolean; centerReference?: CenterContactRef }
interface MatchContactRow { id: number; email: string; companyName: string | null; contactVersion?: number; canDelete?: boolean; centerReference?: CenterContactRef }
const CENTER_STATUS: Record<string, ContactTouchStatus> = { reached: 'contacted', replied: 'replied', bounced: 'bounced', autoreply: 'autoreply', '': 'uncontacted' };
const TODO_FEEDBACK_KEY = 'inbox-todo-feedback';
const FOLDER_COLORS = ['#2563eb', '#0f766e', '#7c3aed', '#c2413b', '#b45309', '#475569'] as const;
const INBOX_DATE_LABEL = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
const CAMPAIGN_INBOX_STATUSES = ['sent', 'replied', 'bounced', 'autoreply'] as const;
const BODY_CACHE_LIMIT = 80;
/** Drop the oldest rendered bodies once the cache is full; HTML bodies are the biggest renderer allocation. */
function rememberBody(cache: Map<number, string | null>, messageId: number, html: string | null): void {
  cache.delete(messageId);
  cache.set(messageId, html);
  while (cache.size > BODY_CACHE_LIMIT) cache.delete(cache.keys().next().value as number);
}
type CampaignInboxStatus = typeof CAMPAIGN_INBOX_STATUSES[number];
const CAMPAIGN_INBOX_STATUS_LABELS: Record<CampaignInboxStatus, string> = { sent: '已发出', replied: '已收到', bounced: '退信', autoreply: '自动回复' };
const FETCH_PHASE_LABEL: Record<InboxFetchPhase, string> = {
  [INBOX_FETCH_PHASES.CONNECTING]: "连接中",
  [INBOX_FETCH_PHASES.SEARCHING]: "查找邮件",
  [INBOX_FETCH_PHASES.SCANNING]: "扫描中",
  [INBOX_FETCH_PHASES.CALIBRATING]: "校准未读",
  [INBOX_FETCH_PHASES.PROCESSING]: "保存与匹配",
  [INBOX_FETCH_PHASES.POST_PROCESSING]: "收尾处理",
  [INBOX_FETCH_PHASES.COMPLETE]: "已完成",
  [INBOX_FETCH_PHASES.FAILED]: "失败",
};
const SYNC_PHASE_LABEL: Record<string, string> = {
  [INBOX_SYNC_PHASES.INITIAL]: "首次同步",
  [INBOX_SYNC_PHASES.HISTORY]: "同步更早邮件",
  [INBOX_SYNC_PHASES.READY]: "已同步",
  [INBOX_SYNC_PHASES.FAILED]: "失败",
  [INBOX_SYNC_PHASES.UNCONFIGURED]: "未配置收信",
  [INBOX_SYNC_PHASES.IDLE]: "等待同步",
};
function openMatchedContact(contact: { id: number; centerReference?: CenterContactRef }): void {
  const reference = contact.centerReference;
  window.location.hash = reference
    ? `#/customers?view=table&centerContact=${reference.contactId}&centerCustomer=${encodeURIComponent(reference.customerId)}`
    : `#/customers?view=table&detail=${contact.id}`;
}

interface InboxItem {
  id: number; fromEmail: string; fromName: string | null;
  subject: string | null; bodyPreview: string | null;
  classification: string | null; intent: string | null; matchedContactId: number | null;
  isRead: number; receivedAt: string;
  myRole?: string | null;
  to?: string | null;
  cc?: string | null;
  accountId?: number; messageId?: string | null;
  _accountEmail?: string | null;
  _contactStatus?: string | null;
  _contactTags?: string | null;
  _labelIds?: number[];
  _pinned?: boolean;
  _centerContact?: CenterContactRef & { companyName?: string; email?: string } | null;
  _centerMessageKeys?: string[];
  _centerContacts?: Array<CenterContactRef & { role?: string; status?: string; tags?: string[]; email?: string; companyName?: string; contactVersion?: number; canDelete?: boolean }>;
  _analysis?: InboxAnalysisView | null;
  _quoteCard?: InboxQuoteCard | null;
  _todoState?: InboxTodoState | null;
  _conversationState?: InboxConversationState | null;
}

interface InboxListResponse {
  success: boolean;
  data?: InboxItem[] | InboxListPage<InboxItem>;
  error?: string;
}
function inboxResponsePage(response: InboxListResponse | undefined): InboxListPage<InboxItem> {
  if (!response?.success || !response.data) return { items: [], total: 0, nextCursor: null };
  return Array.isArray(response.data) ? { items: response.data, total: response.data.length, nextCursor: null } : response.data;
}
function mapInboxResponseItems(response: InboxListResponse, mapper: (item: InboxItem) => InboxItem): InboxListResponse {
  if (!response.success || !response.data) return response;
  if (!Array.isArray(response.data) && !Array.isArray(response.data.items)) return response;
  return Array.isArray(response.data)
    ? { ...response, data: response.data.map(mapper) }
    : { ...response, data: { ...response.data, items: response.data.items.map(mapper) } };
}
type InboxCache = InboxListResponse | { pages: InboxListResponse[]; pageParams: unknown[] };
function mapInboxCacheItems(value: unknown, mapper: (item: InboxItem) => InboxItem): unknown {
  if (!value || typeof value !== 'object') return value;
  if ('pages' in value && Array.isArray((value as { pages?: unknown }).pages)) {
    const cache = value as InboxCache & { pages: InboxListResponse[] };
    return { ...cache, pages: cache.pages.map(page => mapInboxResponseItems(page, mapper)) };
  }
  return mapInboxResponseItems(value as InboxListResponse, mapper);
}

interface CampaignInboxTarget { contactId: number; email: string; status: string; centerReference?: CenterContactRef }
interface CampaignInboxDetail { campaign: { id: string; name: string; status: string } | null; targets: CampaignInboxTarget[] }

type MailTypeMeta = { label: string; dot: string };
const OTHER_MAIL_TYPE: MailTypeMeta = { label: "其他", dot: "#8b8b8b" };
const TYPE: Record<string, MailTypeMeta> = {
  replied: { label: "已收到", dot: "#22a644" },
  bounce: { label: "退信", dot: "#e5484d" },
  autoreply: { label: "自动回复", dot: "#e6a817" },
  sent: { label: "已发送", dot: "#2563eb" },
  other: OTHER_MAIL_TYPE,
};

const EMAIL_ADDRESS_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
type InboxContactStage = 'action' | 'review' | 'waiting' | 'new' | 'info' | 'bounce' | 'autoreply' | 'analyzing' | 'failed';

interface InboxContactInsight {
  stage: InboxContactStage;
  label: string;
  tone: string;
  summary: string;
  nextAction: string | null;
  dueHint: string | null;
  latestAt: string;
  latestSubject: string | null;
}

interface InboxContactGroup {
  email: string;
  name: string | null;
  count: number;
  unread: number;
  insight: InboxContactInsight;
}

interface InboxAccountScope {
  key: string;
  email: string;
  total: number;
  unread: number;
  latestAt: number;
}

type CleanListRow =
  | { kind: 'header'; key: string; groupKey: string; label: string; top: number; height: number }
  | { kind: 'mail'; key: string; item: InboxItem; top: number; height: number };

const CLEAN_GROUP_H = 25;
const TODO_GROUP_H = 31;
const TODO_ROW_H = 74;
const DAY_MS = 24 * 60 * 60 * 1000;
const FOLLOWUP_SUGGESTION_DAYS = 3;
const INBOX_DROP_CHUNK_SIZE = 200;
const CLEAN_WEEKDAYS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'] as const;

function cleanListGroupMeta(value: string): { key: string; label: string } {
  const date = new Date(value);
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((todayStart.getTime() - day.getTime()) / 864e5);
  if (diff === 0) return { key: 'today', label: '今天' };
  if (diff === 1) return { key: 'yesterday', label: '昨天' };
  const mondayOffset = (todayStart.getDay() + 6) % 7;
  const thisWeekStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), todayStart.getDate() - mondayOffset);
  if (day >= thisWeekStart) return { key: `week-day-${day.getTime()}`, label: CLEAN_WEEKDAYS[(day.getDay() + 6) % 7]! };
  const previousWeekStart = new Date(thisWeekStart.getFullYear(), thisWeekStart.getMonth(), thisWeekStart.getDate() - 7);
  if (day >= previousWeekStart) return { key: `week-1-${previousWeekStart.getTime()}`, label: '上周' };
  const twoWeeksStart = new Date(previousWeekStart.getFullYear(), previousWeekStart.getMonth(), previousWeekStart.getDate() - 7);
  if (day >= twoWeeksStart) return { key: `week-2-${twoWeeksStart.getTime()}`, label: '两周前' };
  const threeWeeksStart = new Date(twoWeeksStart.getFullYear(), twoWeeksStart.getMonth(), twoWeeksStart.getDate() - 7);
  if (day >= threeWeeksStart) return { key: `week-3-${threeWeeksStart.getTime()}`, label: '三周前' };
  const previousMonthStart = new Date(todayStart.getFullYear(), todayStart.getMonth() - 1, 1);
  if (day >= previousMonthStart) return { key: `month-${previousMonthStart.getFullYear()}-${previousMonthStart.getMonth() + 1}`, label: '上个月' };
  return { key: 'earlier', label: '更早' };
}

export function cleanListTime(value: string, now = new Date()): string {
  const date = new Date(value);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (day.getTime() === today.getTime()) return time;
  const mondayOffset = (today.getDay() + 6) % 7;
  const weekStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset);
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
  if (day >= weekStart && day < weekEnd) return `周${'日一二三四五六'[day.getDay()]} ${time}`;
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`;
}

function todoGroupMeta(item: InboxItem): { key: string; label: string; order: number } {
  if (item._todoState === 'done') return { key: 'done', label: '已处理', order: 3 };
  if (item._analysis?.priority === 'urgent') return { key: 'urgent', label: '优先处理', order: 0 };
  if (item._analysis?.priority === 'important') return { key: 'important', label: '重要跟进', order: 1 };
  return { key: 'normal', label: '常规待办', order: 2 };
}

function inboxContactEmail(item: InboxItem): string {
  if (item.classification !== 'sent') return item.fromEmail.trim().toLocaleLowerCase();
  const ownAddress = item._accountEmail?.trim().toLocaleLowerCase() || '';
  const recipients = [item.to, item.cc]
    .flatMap(value => value?.match(EMAIL_ADDRESS_RE) || [])
    .map(value => value.trim().toLocaleLowerCase())
    .filter(value => value && value !== ownAddress);
  return recipients[0] || item.fromEmail.trim().toLocaleLowerCase();
}

function inboxConversationKey(item: InboxItem): string {
  const subject = normalizeInboxSubject(item.subject);
  return `${inboxContactEmail(item)}::${subject || `message:${item.id}`}`;
}

function inboxNeedsReply(item: InboxItem): boolean {
  if (item._conversationState) return item._conversationState === 'needs_reply';
  if (item.myRole === 'cc') return false;
  return inboxMailNeedsReply(inboxNeedsReplyMail(item));
}

function inboxWaitingOther(item: InboxItem): boolean {
  if (item._conversationState) return item._conversationState === 'waiting_other';
  return item.classification === 'sent';
}

function inboxWaitingDays(item: InboxItem): number {
  if (item.classification !== 'sent') return 0;
  const sentAt = Date.parse(item.receivedAt);
  if (!Number.isFinite(sentAt)) return 0;
  return Math.max(0, Math.floor((Date.now() - sentAt) / DAY_MS));
}

function inboxHasOpenFollowupTask(item: InboxItem, sourceMessageKeys: ReadonlySet<string>, localMailIds: ReadonlySet<number>): boolean {
  return localMailIds.has(item.id) || Boolean(item._centerMessageKeys?.some(key => sourceMessageKeys.has(key)));
}

function inboxNeedsFollowup(item: InboxItem, sourceMessageKeys: ReadonlySet<string>, localMailIds: ReadonlySet<number>): boolean {
  return inboxHasOpenFollowupTask(item, sourceMessageKeys, localMailIds)
    || inboxWaitingOther(item) && inboxWaitingDays(item) >= FOLLOWUP_SUGGESTION_DAYS;
}

function inboxAccountKey(item: InboxItem): string {
  return item.accountId ? String(item.accountId) : item._accountEmail?.trim().toLocaleLowerCase() || '';
}

function inboxNeedsReplyMail(item: InboxItem): InboxNeedsReplyMail {
  return {
    classification: item.classification,
    isRead: Boolean(item.isRead),
    myRole: item.myRole,
    todoState: item._todoState,
    analysis: item._analysis,
  };
}

function inboxContactName(messages: InboxItem[]): string | null {
  return messages.find(item => item.classification !== 'sent' && item.fromName?.trim())?.fromName?.trim() || null;
}

function inboxFolderSuggestions(messages: InboxItem[]): Array<{ name: string; messageIds: number[] }> {
  const companies = new Map<string, Set<number>>();
  for (const message of messages) {
    const references = message._centerContacts?.length ? message._centerContacts : message._centerContact ? [message._centerContact] : [];
    const companyNames = references.map(reference => (reference as CenterContactRef & { companyName?: string }).companyName?.trim()).filter((name): name is string => Boolean(name));
    const names = [...new Set(companyNames)];
    if (names.length !== 1) continue;
    const name = names[0]!;
    if (name.length < 2 || name.length > 24 || /^(unknown|n\/a|none|未命名|未知公司)$/i.test(name)) continue;
    const ids = companies.get(name) ?? new Set<number>();
    ids.add(message.id);
    companies.set(name, ids);
  }
  return [...companies.entries()]
    .filter(([, ids]) => ids.size >= 2)
    .map(([name, ids]) => ({ name, messageIds: [...ids] }))
    .sort((left, right) => right.messageIds.length - left.messageIds.length || left.name.localeCompare(right.name, 'zh-CN'))
    .slice(0, 6);
}

function inboxConfidenceLabel(confidence: number): string {
  if (!Number.isFinite(confidence) || confidence <= 0) return '暂无判断依据';
  if (confidence >= 0.85) return `依据较明确 ${Math.round(confidence * 100)}%`;
  if (confidence >= 0.65) return `建议核对 ${Math.round(confidence * 100)}%`;
  return `把握较低 ${Math.round(confidence * 100)}%`;
}

function inboxContactInsight(messages: InboxItem[]): InboxContactInsight {
  const ordered = [...messages].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  const latest = ordered[0]!;
  const latestAnalysis = latest._analysis;
  const latestSubject = latest.subject || null;
  let stage: InboxContactStage = 'info';
  let label = '多为知会';
  let tone = 'neutral';
  let summary = latestSubject || latest.bodyPreview || '收到一封邮件';
  let nextAction: string | null = null;
  let dueHint: string | null = null;
  if (latest.classification === 'sent') {
    stage = 'waiting'; label = '等待回复'; tone = 'waiting'; nextAction = '等待对方回复';
    summary = latestSubject ? `你最近发出：${latestSubject}` : '你最近已发出一封邮件';
  } else if (latestAnalysis?.status === 'failed') {
    stage = 'failed'; label = '需人工判断'; tone = 'danger'; nextAction = '打开邮件核对内容';
    summary = latestAnalysis.error || latestSubject || '这封邮件未能自动判断';
  } else if (latestAnalysis?.status === 'pending') {
    stage = 'analyzing'; label = '正在判断'; tone = 'pending';
    summary = latestSubject || '正在结合往来记录判断';
  } else if (latest.classification === 'bounce') {
    stage = 'bounce'; label = '邮箱退信'; tone = 'danger'; nextAction = '核对联系人邮箱';
    summary = latestSubject || '发送地址被拒绝';
  } else if (latest.classification === 'autoreply') {
    stage = 'autoreply'; label = '自动回复'; tone = 'info';
    summary = latestSubject || '收到自动回复';
  } else if (latestAnalysis?.status === 'ready' && latest._todoState === 'done') {
    stage = 'info'; label = '已处理'; tone = 'neutral';
    summary = latestAnalysis.summary || summary;
  } else if (latestAnalysis?.status === 'ready' && latestAnalysis.requiresAction) {
    stage = 'action';
    label = latestAnalysis.priority === 'urgent' ? '优先处理' : '待你回复';
    tone = latestAnalysis.priority === 'urgent' ? 'danger' : 'action';
    summary = latestAnalysis.summary || summary;
    nextAction = latestAnalysis.nextAction;
    dueHint = latestAnalysis.dueHint;
  } else if (latestAnalysis?.status === 'ready' && latestAnalysis.priority !== 'normal') {
    stage = 'review'; label = '建议查看'; tone = 'review';
    summary = latestAnalysis.summary || summary;
    nextAction = latestAnalysis.nextAction;
    dueHint = latestAnalysis.dueHint;
  } else if (latestAnalysis?.status === 'ready') {
    summary = latestAnalysis.summary || summary;
  } else if (!latest.isRead) {
    stage = 'new'; label = '新来信'; tone = 'waiting';
  }

  return {
    stage, label, tone, summary, nextAction, dueHint,
    latestAt: latest.receivedAt,
    latestSubject,
  };
}

type InboxManagementScope = "all" | "unread" | "needs_reply" | "waiting_other" | "follow_up";
type InboxAnalysisFilter = "action" | "important";
type InboxDropTarget =
  | { kind: 'conversation'; key: string; state: InboxConversationState; label: string }
  | { kind: 'pin'; key: string }
  | { kind: 'folder'; key: string; labelId: number; name: string }
  | { kind: 'blank-folder'; key: string };
const INBOX_ANALYSIS_RUN_CHANNEL = 'inbox:analysisRun';
function inboxEmailDomain(value: string | null | undefined): string {
  return value?.trim().toLocaleLowerCase().split('@')[1] || '';
}

function inboxSenderIsInternal(item: InboxItem): boolean {
  const senderDomain = inboxEmailDomain(item.fromEmail);
  const accountDomain = inboxEmailDomain(item._accountEmail);
  return Boolean(senderDomain && accountDomain && senderDomain === accountDomain);
}

function inboxAnalysisIsAutoTodo(item: InboxItem): boolean {
  return inboxAnalysisAdmitsTodo(item._analysis, { internal: inboxSenderIsInternal(item), ccOnly: item.myRole === 'cc' });
}

function inboxIsTodo(item: InboxItem): boolean {
  if (item._conversationState) return item._conversationState === 'todo';
  if (item._todoState === 'done') return false;
  if (item._todoState === 'open') return true;
  return Boolean(item._analysis && item._analysis.status === 'ready' && inboxAnalysisIsAutoTodo(item));
}

function matchesInboxAnalysisFilter(item: InboxItem, filter: InboxAnalysisFilter): boolean {
  if (item._conversationState) return item._conversationState === (filter === 'action' ? 'todo' : 'important');
  if (item.myRole === 'cc') return false;
  const analysis = item._analysis;
  if (filter === 'action') return inboxIsTodo(item);
  if (item._todoState === 'done' || item._todoState === 'open') return false;
  return inboxAnalysisAdmitsAttention(analysis, { internal: inboxSenderIsInternal(item), ccOnly: item.myRole === 'cc' });
}

const FILTERS = [
  { key: "all", label: "全部" },
  { key: "sent", label: "已发送" },
  { key: "replied", label: "已收到" },
  { key: "autoreply", label: "自动回复" },
  { key: "bounce", label: "退信" },
  { key: "other", label: "其他" },
];

const INTENT_LABELS: Record<string, string> = {
  price_inquiry: '询价', quote_request: '报价请求', schedule_request: '船期', order_followup: '订单跟进',
  complaint: '投诉', cooperation: '合作', no_action: '无需处理', other: '其他',
};

const ANALYSIS_PRIORITY_LABELS = { normal: '普通', important: '重要', urgent: '紧急' } as const;

function inboxAnalysisSourceLabel(analysis: InboxAnalysisView): string {
  if (analysis.source === 'mock' || analysis.analyzerVersion.includes('mock')) return 'MOCK';
  if (analysis.source === 'rule') return '规则';
  if (analysis.source === 'human') return '人工';
  return 'AI';
}

function inboxLocalAnalysisLabel(analysis: InboxAnalysisView): string {
  if (analysis.status === 'pending') return '分析中';
  if (analysis.status === 'failed') return '分析失败';
  const category = INBOX_ANALYSIS_CATEGORY_LABELS[analysis.category] || '其他';
  if (analysis.confidence < 0.65) return `建议关注 · ${category}`;
  if (analysis.requiresAction) return `建议处理 · ${category}`;
  if (analysis.priority !== 'normal') return `建议查看 · ${category}`;
  return `多为知会 · ${category}`;
}

function inboxLocalAnalysisColor(analysis: InboxAnalysisView): string {
  if (analysis.status === 'failed') return '#c2413b';
  if (analysis.priority === 'urgent') return '#c2413b';
  if (analysis.requiresAction || analysis.priority === 'important') return '#9a6700';
  return '#6b7280';
}

function inboxAnalysisTagParts(label: string): { verdict: string; category: string } {
  const [verdict, ...category] = label.split(' · ');
  return { verdict: verdict || label, category: category.join(' · ') };
}

function inboxListIndicator(item: InboxItem): string {
  if (item.intent && INTENT_LABELS[item.intent]) return INTENT_LABELS[item.intent]!;
  if (item.classification === 'sent') return '已发送';
  return TYPE[item.classification || 'other']?.label || '其他';
}

function inboxAnalysisEvent(detail: CenterContactDetail, item: InboxItem) {
  const events = projectContactMailHistory(detail.mailEvents || []).mail;
  const subject = (item.subject || '').trim().toLocaleLowerCase();
  const itemTime = Date.parse(item.receivedAt);
  return events.find(event => {
    const eventSubject = (event.subject || '').trim().toLocaleLowerCase();
    const delta = Math.abs(Date.parse(event.occurredAt) - itemTime);
    return eventSubject === subject && Number.isFinite(delta) && delta <= 5 * 60 * 1000;
  });
}

// ── 未读追踪：真源 = DB isRead（抓取认 \Seen + 程序内标读回写服务器 + 校准对齐，
//    见 main/transport/inbox.ipc.ts 的未读校准）——列表未读点直接读行的 isRead 字段

function shortTime(s: string): string {
  if (!s) return "";
  const d = new Date(s), n = new Date();
  if (n.getTime() - d.getTime() < 864e5 && d.getDate() === n.getDate()) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (n.getTime() - d.getTime() < 1728e5) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── 主组件 ──

// ── 从邮箱地址提取公司名猜测 ──
function guessCompanyFromEmail(email: string): string {
  const m = email.match(/@(.+)$/);
  if (!m || !m[1]) return "";
  const domain = (m[1].split(".")[0] || "");
  return domain
    .replace(/[-_.]/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .slice(0, 50);
}

// ── 从姓名提取 firstName/lastName ──
function guessName(fromName: string | null): { firstName: string; lastName: string } {
  if (!fromName) return { firstName: "", lastName: "" };
  const parts = fromName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] || "", lastName: "" };
  return { firstName: parts[0] || "", lastName: parts[parts.length - 1] || "" };
}

function InboxDetailRow({ label, children, wide = false }: {
  label: string; children: React.ReactNode; wide?: boolean;
}) {
  return <div className={"inbox-detail-row" + (wide ? " is-wide" : "")}>
    <span className="inbox-detail-label">{label}</span>
    <div className="inbox-detail-value">{children}</div>
  </div>;
}

type FolderEditorValue = { labelId?: number; name: string; color: string };

export function isoWeekNumber(value: Date): number {
  const target = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

function localDateKey(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

type InboxCalendarCount = { total: number; unread: number };

function addCalendarDays(value: Date, days: number): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
}

function InboxCalendarPanel({ value, filtering, counts, onSelect, onClear }: {
  value: Date;
  filtering: boolean;
  counts: ReadonlyMap<string, InboxCalendarCount>;
  onSelect: (value: Date) => void;
  onClear: () => void;
}) {
  const [month, setMonth] = useState(() => new Date(value.getFullYear(), value.getMonth(), 1));
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = addCalendarDays(first, -((first.getDay() + 6) % 7));
  const weeks = Array.from({ length: 6 }, (_, weekIndex) => {
    const weekStart = addCalendarDays(start, weekIndex * 7);
    return { week: isoWeekNumber(weekStart), days: Array.from({ length: 7 }, (_, dayIndex) => addCalendarDays(weekStart, dayIndex)) };
  });
  const monthTotal = [...counts.entries()].reduce((total, [key, count]) => key.startsWith(`${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`) ? total + count.total : total, 0);
  const todayKey = localDateKey(new Date());
  return <div className="inbox-calendar-panel">
    <div className="inbox-calendar-panel-head">
      <div><strong>{month.getFullYear()}年{month.getMonth() + 1}月</strong><span>{monthTotal} 封邮件 · 周一开始 · ISO 周</span></div>
      <div className="inbox-calendar-nav">
        <button type="button" aria-label="上个月" title="上个月" onClick={() => setMonth(current => new Date(current.getFullYear(), current.getMonth() - 1, 1))}><LeftOutlined /></button>
        <button type="button" aria-label="下个月" title="下个月" onClick={() => setMonth(current => new Date(current.getFullYear(), current.getMonth() + 1, 1))}><RightOutlined /></button>
      </div>
    </div>
    <div className="inbox-calendar-grid inbox-calendar-weekdays"><span>WK</span>{['一', '二', '三', '四', '五', '六', '日'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="inbox-calendar-weeks">{weeks.map(week => <div className="inbox-calendar-grid inbox-calendar-week" key={localDateKey(week.days[0]!)}>
      <span className="inbox-calendar-week-number">WK {week.week}</span>
      {week.days.map(day => {
        const key = localDateKey(day);
        const count = counts.get(key);
        const outside = day.getMonth() !== month.getMonth();
        const selected = filtering && localDateKey(value) === key;
        return <button key={key} type="button" className={`inbox-calendar-day${outside ? ' is-outside' : ''}${selected ? ' is-selected' : ''}${todayKey === key ? ' is-today' : ''}${count?.total ? ' has-mail' : ''}`} aria-label={`${day.getMonth() + 1}月${day.getDate()}日，${count?.total ?? 0}封邮件`} aria-pressed={selected} onClick={() => onSelect(day)}>
          <span>{day.getDate()}</span>
          {!!count?.total && <em>{count.total > 99 ? '99+' : count.total}</em>}
          {!!count?.unread && <i aria-label={`${count.unread}封未读`} />}
        </button>;
      })}
    </div>)}</div>
    <div className="inbox-calendar-legend"><span><i />未读</span><span><em>8</em>邮件量</span>{filtering && <button type="button" onClick={onClear}>全部日期</button>}</div>
  </div>;
}

function InboxDateHeading({ value, filtering, counts, onChange, onClear }: { value: Date; filtering: boolean; counts: ReadonlyMap<string, InboxCalendarCount>; onChange: (value: Date) => void; onClear: () => void }) {
  const [open, setOpen] = useState(false);
  const week = isoWeekNumber(value);
  const selectedCount = counts.get(localDateKey(value));
  return <Popover trigger="click" placement="bottomLeft" open={open} onOpenChange={setOpen} content={<InboxCalendarPanel value={value} filtering={filtering} counts={counts} onSelect={date => { onChange(date); setOpen(false); }} onClear={() => { onClear(); setOpen(false); }} />}>
    <button type="button" className={`inbox-calendar-trigger${filtering ? ' is-filtering' : ''}`} aria-label="选择日期筛选邮件" aria-pressed={filtering} title={`${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日 · WK ${week}${filtering ? ' · 正在筛选当天邮件' : ''}`}>
      <CalendarOutlined />
      <span><strong>{INBOX_DATE_LABEL.format(value)}</strong><small>{value.getFullYear()} · WK {week}{filtering ? ` · ${selectedCount?.total ?? 0} 封` : ''}</small></span>
    </button>
  </Popover>;
}

function FolderEditorCard({ initial, saving, onCancel, onSave }: {
  initial: FolderEditorValue;
  saving: boolean;
  onCancel: () => void;
  onSave: (value: FolderEditorValue) => void;
}) {
  const [draft, setDraft] = useState(initial);
  return <div className="inbox-label-editor is-card">
    <label><span>名称</span><Input autoFocus maxLength={24} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} placeholder="例如：询价、重点客户" /></label>
    <label><span>颜色</span><div className="inbox-label-color-field"><input type="color" value={draft.color} onChange={event => setDraft(current => ({ ...current, color: event.target.value }))} /><i style={{ background: draft.color }} /><strong>{draft.name.trim() || '文件夹名称'}</strong></div></label>
    <div className="inbox-label-color-swatches" aria-label="文件夹颜色">
      {FOLDER_COLORS.map(color => <button key={color} type="button" className={draft.color === color ? 'is-active' : ''} style={{ background: color }} aria-label={`选择颜色 ${color}`} title={color} onClick={() => setDraft(current => ({ ...current, color }))} />)}
    </div>
    <div className="inbox-label-editor-actions"><Button onClick={onCancel} disabled={saving}>取消</Button><Button type="primary" loading={saving} disabled={!draft.name.trim()} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>保存</Button></div>
  </div>;
}

function EmailReferenceMemberPicker({ onChoose }: { onChoose: (teamId: string, member: { userId: string; displayName: string; email: string | null; role?: string }) => void }) {
  const query = useTeamContext(true);
  const team = query.data?.ok ? query.data.data.team : null;
  if (query.isLoading) return <div className="inbox-folder-empty">正在读取团队成员</div>;
  if (query.data && !query.data.ok) return <div className="inbox-folder-empty">{query.data.error.message}</div>;
  if (!team) return <div className="inbox-folder-empty">当前账号没有可用的团队成员</div>;
  if (!team.members.length) return <div className="inbox-folder-empty">暂无可选成员</div>;
  return <div className="inbox-team-member-picker">{team.members.map(member => <button key={member.userId} type="button" onClick={() => onChoose(team.teamId, member)}><span className="team-admin-member-avatar">{member.displayName.slice(0, 1).toUpperCase()}</span><span><strong>{member.displayName}</strong><small>{member.email || (member.role === 'leader' ? '负责人' : '成员')}</small></span></button>)}</div>;
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取附件失败'));
    reader.readAsDataURL(file);
  });
}

export function InboxList() {
  const identity = useOptionalIdentity();
  const offline = identity?.status === 'offline';
  const actorScope = JSON.stringify([identity?.baseUrl, identity?.identity?.userId]);
  const currentActorScope = useRef(actorScope);
  currentActorScope.current = actorScope;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useRouterState({ select: s => s.location });
  const routeParams = new URLSearchParams(location.searchStr);
  const rawDetail = Number(routeParams.get("detail"));
  const routeDetail = location.pathname === "/inbox" && Number.isSafeInteger(rawDetail) && rawDetail > 0 ? rawDetail : null;
  const routeMailSubject = routeParams.get("mailSubject")?.trim() || null;
  const routeMailAt = routeParams.get("mailAt");
  const routeCenterMail = routeParams.get("centerMail")?.trim() || null;
  const routeMailContact = Number(routeParams.get("centerContact"));
  const routeMailCustomer = routeParams.get("centerCustomer");
  const routeCampaignId = routeParams.get("campaign")?.trim() || null;
  const routeCampaignStatusValue = routeParams.get("campaignStatus");
  const routeCampaignStatus = CAMPAIGN_INBOX_STATUSES.includes(routeCampaignStatusValue as CampaignInboxStatus) ? routeCampaignStatusValue as CampaignInboxStatus : null;
  const handledMailRoute = useRef<string | null>(null);
  const [includeId, setIncludeId] = useState<number | null>(null);
  const [sid, setSid] = useState<number | null>(null);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const [managementScope, setManagementScope] = useState<InboxManagementScope>("all");
  const [analysisFilter, setAnalysisFilter] = useState<InboxAnalysisFilter | null>(null);
  const [labelFilter, setLabelFilter] = useState<number | null>(null);
  const [pinnedFolderOpen, setPinnedFolderOpen] = useState(true);
  const [foldersOpen, setFoldersOpen] = useState(true);
  const [analysisDetailOpen, setAnalysisDetailOpen] = useState(true);
  const [threadStackOpen, setThreadStackOpen] = useState(true);
  const [contactMatchesOpen, setContactMatchesOpen] = useState(true);
  const [contextSidebarOpen, setContextSidebarOpen] = useState(false);
  const [labelEditor, setLabelEditor] = useState<FolderEditorValue | null>(null);
  const [folderCreatorOpen, setFolderCreatorOpen] = useState(false);
  const [labelSaving, setLabelSaving] = useState(false);
  const [emailReferenceOpen, setEmailReferenceOpen] = useState(false);
  const [replyDraft, setReplyDraft] = useState<{ item: InboxItem; accountId: number; to: string; cc: string; subject: string; body: string; attachments: UploadFile[] } | null>(null);
  const [replyBusy, setReplyBusy] = useState(false);
  const [inboxDate, setInboxDate] = useState(() => new Date());
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [body, setBody] = useState<string | null>(null);
  const [bl, setBl] = useState(false);
  const [analysisRetryingId, setAnalysisRetryingId] = useState<number | null>(null);
  const [followupTasks, setFollowupTasks] = useState<Record<number, FollowupTask>>({});
  const folderSuggestionSignature = useRef('');
  const centerDeleteRequests = useRef(new Map<string, ContactDelete>());
  // 前端正文缓存：点开过的邮件切回秒开，不重复 invoke / 不闪 loading
  const bodyCache = useRef<Map<number, string | null>>(new Map());
  const [analysisByMessage, setAnalysisByMessage] = useState<Record<number, ContactMailAnalysisView>>({});

  // 联系人库（选中邮件后才加载）
  const { data: contactsData, isLoading: contactsLoading, isError: contactsFailed, error: contactsError } = useQuery({
    queryKey: ["contacts", "match", identity?.baseUrl, identity?.identity?.userId],
    queryFn: () => window.api.invoke("contacts:listForMatch") as Promise<{ success: boolean; data?: MatchContactRow[]; error?: string }>,
    enabled: sid !== null,
  });
  const contactMatchError = contactsFailed
    ? contactsError instanceof Error ? contactsError.message : '联系人读取失败'
    : contactsData?.success === false ? contactsData.error || '联系人读取失败' : null;

  const [sel, setSel] = useState<Set<number>>(new Set());
  const [last, setLast] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; item: InboxItem } | null>(null);
  const [draggingCount, setDraggingCount] = useState<number | null>(null);
  const [activeDropTarget, setActiveDropTarget] = useState<string | null>(null);
  const dragMessageIds = useRef<number[]>([]);
  const dropBusy = useRef(false);
  // 虚拟滚动：只渲染可视区，避免千余封邮件全量渲染卡顿
  const ROW_H = 66; // 固定行高：主题、发信人和匹配状态三行可读
  const SENDER_ROW_H = 72; // 联系人行高：压缩后的阶段、摘要和判断层级
  const CLEAN_ROW_H = 44; // 全部邮件：Foxmail 式日期分组两行列表
  const OVERSCAN = 6; // 上下多渲染几行，滚动不露白
  const listRef = useRef<HTMLDivElement>(null);
  const [listH, setListH] = useState(600);
  const [scrollTop, setScrollTop] = useState(0);
  // 视图切换：全部邮件 / 联系人往来
  const [view, setView] = useState<"flat" | "sender">("flat");
  const [senderFilter, setSenderFilter] = useState<string | null>(null); // 选中的联系人邮箱
  const [collapsedCleanGroups, setCollapsedCleanGroups] = useState<Set<string>>(new Set());
  const todoView = analysisFilter === 'action' && view === 'flat';
  const mailRowHeight = todoView ? TODO_ROW_H : view === "flat" ? CLEAN_ROW_H : ROW_H;
  const deferredSearch = useDeferredValue(search.trim());
  const dateRange = useMemo(() => {
    if (!dateFilter) return null;
    const start = new Date(`${dateFilter}T00:00:00`);
    if (!Number.isFinite(start.getTime())) return null;
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { startAt: start.toISOString(), endAt: end.toISOString() };
  }, [dateFilter]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery<InboxListResponse, Error, InfiniteData<InboxListResponse>, readonly unknown[], string | null>({
    queryKey: ["inbox", includeId, routeCenterMail, deferredSearch, filter, accountFilter, dateFilter],
    initialPageParam: null as string | null,
    placeholderData: previous => previous,
    queryFn: ({ pageParam }) => window.api.invoke("inbox:list", {
      limit: INBOX_LIST_LIMITS.page,
      ...(pageParam ? { cursor: pageParam } : {}),
      ...(includeId ? { includeId } : {}),
      ...(routeCenterMail ? { centerMessageKey: routeCenterMail } : {}),
      ...(deferredSearch ? { search: deferredSearch } : {}),
      ...(filter !== 'all' ? { classification: filter } : {}),
      ...(accountFilter && /^\d+$/.test(accountFilter) ? { accountId: Number(accountFilter) } : {}),
      ...(dateRange ?? {}),
    }) as Promise<InboxListResponse>,
    getNextPageParam: last => last.success ? inboxResponsePage(last).nextCursor ?? undefined : undefined,
  });
  const latestInboxResponse = data?.pages[data.pages.length - 1];
  const nextInboxPageCursor = latestInboxResponse ? inboxResponsePage(latestInboxResponse).nextCursor : null;
  const inboxSummaryQuery = useQuery({
    queryKey: ["inbox", "summary", accountFilter],
    queryFn: () => window.api.invoke("inbox:summary", {
      ...(accountFilter && /^\d+$/.test(accountFilter) ? { accountId: Number(accountFilter) } : {}),
    }) as Promise<{ success: boolean; data?: InboxSummary; error?: string }>,
    staleTime: 5_000,
  });
  const inboxSummary = inboxSummaryQuery.data?.success && inboxSummaryQuery.data.data && !Array.isArray(inboxSummaryQuery.data.data)
    ? inboxSummaryQuery.data.data : undefined;
  const campaignMailQuery = useQuery({
    queryKey: ["inbox", "campaign-detail", identity?.baseUrl, identity?.identity?.userId, routeCampaignId],
    enabled: !!routeCampaignId,
    queryFn: () => window.api.invoke("send:campaignDetail", routeCampaignId) as Promise<{ success: boolean; data?: CampaignInboxDetail; error?: string }>,
  });
  const campaignMailDetail = campaignMailQuery.data?.success ? campaignMailQuery.data.data : undefined;
  const campaignMailError = campaignMailQuery.data && !campaignMailQuery.data.success ? campaignMailQuery.data.error || '任务邮件读取失败' : campaignMailQuery.error instanceof Error ? campaignMailQuery.error.message : null;
  const syncStateQuery = useQuery({
    queryKey: ["inbox-sync-state"],
    queryFn: () => window.api.invoke("inbox:syncState") as Promise<InboxSyncSnapshot>,
    staleTime: 5_000,
  });
  const replyAccounts = (syncStateQuery.data?.accounts ?? []).filter(account => account.hasImap);
  const defaultReplyAccountId = replyAccounts[0]?.accountId ?? 0;
  const labelsQuery = useQuery({
    queryKey: ["inbox-labels"],
    queryFn: () => window.api.invoke("inbox:labels") as Promise<{ success: boolean; data?: InboxLabel[]; error?: string }>,
    staleTime: 5_000,
  });
  const inboxLabels = labelsQuery.data?.success ? labelsQuery.data.data || [] : [];
  const activeInboxFolders = useMemo(() => inboxLabels.filter(folder => folder.status !== 'suggested'), [inboxLabels]);
  const suggestedInboxFolders = useMemo(() => inboxLabels.filter(folder => folder.status === 'suggested'), [inboxLabels]);
  const labelsById = useMemo(() => new Map(inboxLabels.map(label => [label.labelId, label])), [inboxLabels]);

  const [fetching, setFetching] = useState(false);
  const [fetchProgressOpen, setFetchProgressOpen] = useState(false);
  const syncPrompted = useRef(false);
  // 多账号进度按 accountId 聚合，避免并行拉取时互相覆盖导致进度条跳变
  const [fetchProgress, setFetchProgress] = useState<Record<string, InboxFetchProgress>>({});
  const doFetch = async () => {
    try {
      const raw = await window.api.invoke("inbox:syncState") as InboxSyncSnapshot | { success: boolean; data?: InboxSyncSnapshot };
      const snapshot = raw && "accounts" in raw ? raw : raw?.success ? raw.data : null;
      if (snapshot && !snapshot.accounts.some(account => account.hasImap)) {
        message.warning("没有可收取的邮箱账号，请先在设置中添加并启用收发信账号");
        return;
      }
    } catch {
      // 预检失败不阻断正式拉取，由拉取请求返回真实错误。
    }
    setFetching(true);
    setFetchProgressOpen(true);
    setFetchProgress({});
    try {
      const result = await window.api.invoke("inbox:fetch") as { success: boolean; error?: string };
      if (!result?.success) throw new Error(result?.error || "邮件拉取失败");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "邮件拉取失败");
    } finally {
      setFetching(false);
      void invalidateDomain(qc, "inbox");
      void syncStateQuery.refetch();
    }
  };
  const progressRunning = Object.values(fetchProgress).some(progress =>
    progress.phase !== INBOX_FETCH_PHASES.COMPLETE && progress.phase !== INBOX_FETCH_PHASES.FAILED,
  );
  const syncRunning = fetching || progressRunning || Boolean(syncStateQuery.data?.initializing);
  useVisiblePolling(async () => { await syncStateQuery.refetch(); }, 1_000,
    fetchProgressOpen || syncRunning);

  useEffect(() => {
    if (!syncStateQuery.data?.initializing || syncPrompted.current) return;
    syncPrompted.current = true;
    setFetchProgressOpen(true);
  }, [syncStateQuery.data?.initializing]);

  const syncRows = useMemo(() => {
    const savedAccounts = (syncStateQuery.data?.accounts ?? []).filter(account => account.hasImap);
    const accountIds = new Set<number>([
      ...savedAccounts.map(account => account.accountId),
      ...Object.values(fetchProgress).map(progress => progress.accountId),
    ]);
    return [...accountIds].map(accountId => {
      const live = fetchProgress[String(accountId)];
      const saved = savedAccounts.find(account => account.accountId === accountId);
      const current = live?.processedCount ?? live?.scanned ?? saved?.scannedCount ?? 0;
      const required = live?.requiredCount ?? live?.total ?? saved?.targetCount ?? 0;
      const failed = live?.phase === INBOX_FETCH_PHASES.FAILED || saved?.phase === INBOX_SYNC_PHASES.FAILED || Boolean(saved?.lastError);
      const phaseLabel = live
        ? FETCH_PHASE_LABEL[live.phase] || live.phase
        : SYNC_PHASE_LABEL[saved?.phase ?? ""] || "处理中";
      return {
        accountId,
        email: live?.email || saved?.email || `账号 #${accountId}`,
        phase: live?.phase ?? saved?.phase ?? null,
        current,
        required,
        newCount: live?.newCount ?? saved?.newCount ?? 0,
        subject: live?.currentSubject,
        message: live?.message || saved?.lastError,
        phaseLabel,
        failed,
      };
    });
  }, [fetchProgress, syncStateQuery.data]);

  const allSyncRowsComplete = syncRows.length > 0 && syncRows.every(row =>
    !row.failed && (row.phase === INBOX_FETCH_PHASES.COMPLETE || row.phase === INBOX_SYNC_PHASES.READY),
  );

  useEffect(() => {
    if (!fetchProgressOpen || fetching || progressRunning || syncStateQuery.data?.initializing || !allSyncRowsComplete) return;
    const timer = window.setTimeout(() => setFetchProgressOpen(false), 300);
    return () => window.clearTimeout(timer);
  }, [allSyncRowsComplete, fetching, fetchProgressOpen, progressRunning, syncStateQuery.data?.initializing]);

  // 收信健康度：主进程每轮抓取推送 → 失败账号弹常驻通知，同时刷新设置页账号列表缓存
  useEffect(() => {
    return window.api.on("inbox:health", (data) => {
      const list = data as Array<{ accountId: number; email: string; ok: boolean; error?: string }>;
      const bad = (list || []).filter(x => !x.ok);
      if (bad.length > 0) {
        notification.error({
          key: "inbox-health",
          message: bad.length === 1 ? `${bad[0]!.email} 收信失败` : `${bad.length} 个账号收信失败`,
          description: bad.map(b => `${b.email}：${b.error || "未知错误"}`).join("；"),
          duration: 0,
          btn: <Button size="small" onClick={() => { notification.destroy("inbox-health"); void navigate({ to: "/settings" }); }}>检查账号</Button>,
        });
      } else if (list?.length) {
        notification.destroy?.("inbox-health");
      }
      invalidateDomain(qc, "accounts");
    });
  }, [navigate, qc]);

  const classMut = useMutation({
    mutationFn: async (p: { id: number; classification: string }) => {
      const result=await window.api.invoke("inbox:classify",p) as {success:boolean;error?:string};
      if (!result?.success) throw new Error(result?.error || '分类修改失败');
      return result;
    },
    onSettled: () => invalidateDomain(qc, "inbox", "contacts"),
  });
  const readMut = useMutation({
    mutationFn: async (ids: number[]) => {
      const results = await Promise.all(ids.map(id => window.api.invoke("inbox:markRead", id))) as Array<{ success: boolean; error?: string }>;
      const failed = results.find(result => !result?.success);
      if (failed) throw new Error(failed.error || '标记已读失败');
      return ids;
    },
    onMutate: async (ids) => {
      await qc.cancelQueries({ queryKey: ['inbox'] });
      const idSet = new Set(ids);
      const snapshots = qc.getQueriesData({ queryKey: ['inbox'] });
      qc.setQueriesData({ queryKey: ['inbox'] }, value => mapInboxCacheItems(value, item => idSet.has(item.id) ? { ...item, isRead: 1 } : item));
      return snapshots;
    },
    onError: (_error, _ids, snapshots) => {
      for (const [key, value] of snapshots ?? []) qc.setQueryData(key, value);
    },
    onSettled: () => invalidateDomain(qc, "inbox"),
  });
  const delMut = useMutation({
    mutationFn: (ids: number[]) => Promise.all(ids.map(id => window.api.invoke("inbox:delete", id))),
    onSuccess: () => { setSid(null); setSel(new Set()); invalidateDomain(qc, "inbox"); },
  });
  const patchTodoStateCache = (messageIds: number[], state: InboxTodoState) => {
    const ids = new Set(messageIds);
    qc.setQueriesData({
      predicate: query => query.queryKey[0] === 'inbox' && typeof query.queryKey[1] !== 'string',
    }, current => mapInboxCacheItems(current, item => ids.has(item.id) ? { ...item, _todoState: state } : item));
  };
  const todoTaskRef = useCallback((item: InboxItem): InboxTaskRef | null => {
    const center = item._centerContact ?? item._centerContacts?.[0] ?? null;
    const messageKey = item._centerMessageKeys?.[0] ?? null;
    if (!center?.customerId || !center.contactId || !messageKey) return null;
    return {
      customerId: center.customerId, contactId: center.contactId, messageKey,
      threadKey: normalizeInboxSubject(item.subject),
      title: (item._analysis?.nextAction || `处理邮件：${item.subject || '客户邮件'}`).slice(0, 500),
    };
  }, []);
  const syncTodoTask = useCallback(async (item: InboxItem, state: InboxTodoState) => {
    const ref = todoTaskRef(item);
    if (!ref) return;
    const invoke = (channel: string, ...args: unknown[]) => window.api.invoke(channel, ...args);
    const result = state === 'open' ? await openInboxTask(ref, invoke) : await completeInboxTask(ref, invoke);
    if (result === 'failed') message.warning({ key: 'inbox-task-sync', content: '邮件待办已保存，但中心跟进任务同步失败' });
  }, [todoTaskRef]);
  const todoMut = useMutation({
    mutationFn: async (input: { messageId: number; state: InboxTodoState; feedback?: string; item?: InboxItem }) => {
      const result = await window.api.invoke('inbox:todoState', {
        messageId: input.messageId,
        state: input.state,
        idempotencyKey: crypto.randomUUID(),
      }) as { success: boolean; data?: InboxTodoStateResult; error?: string };
      if (!result?.success) throw new Error(result?.error || '待办状态保存失败');
      return result;
    },
    onSuccess: (_result, input) => {
      patchTodoStateCache([input.messageId], input.state);
      if (input.state === 'done') patchConversationCache([input.messageId], null);
      message.success({ key: TODO_FEEDBACK_KEY, content: input.feedback ?? (input.state === 'done' ? '已处理，已从待办和待回复移除' : '已重新打开，已回到待办和待回复') });
      if (input.item) void syncTodoTask(input.item, input.state);
      void invalidateDomain(qc, 'inbox');
    },
    onError: error => message.error({ key: TODO_FEEDBACK_KEY, content: error instanceof Error ? error.message : '待办状态保存失败' }),
  });
  const todoBatchMut = useMutation({
    mutationFn: async (items: InboxItem[]) => {
      const result = await window.api.invoke('inbox:todoStateBatch', {
        messageIds: items.map(item => item.id),
        state: 'done',
        idempotencyKey: crypto.randomUUID(),
      }) as { success: boolean; data?: InboxTodoBatchResult; error?: string };
      if (!result?.success) throw new Error(result?.error || '待办状态保存失败');
      return result.data;
    },
    onSuccess: (result, items) => {
      if (result?.messageIds?.length) patchTodoStateCache(result.messageIds, result.state);
      if (result?.messageIds?.length) patchConversationCache(result.messageIds, null);
      message.success({ key: TODO_FEEDBACK_KEY, content: `已处理 ${result?.updated ?? 0} 项，已从待办和待回复移除` });
      const done = new Set(result?.messageIds ?? []);
      void (async () => { for (const item of items) if (done.has(item.id)) await syncTodoTask(item, 'done'); })();
      void invalidateDomain(qc, 'inbox');
    },
    onError: error => message.error({ key: TODO_FEEDBACK_KEY, content: error instanceof Error ? error.message : '待办状态保存失败' }),
  });
  const delBounceMut = useMutation({
    mutationFn: () => window.api.invoke("inbox:deleteBounce"),
    onSuccess: (r: unknown) => {
      const rr = r as { success: boolean; data?: { deleted: number; archive: string | null }; error?: string };
      message[rr?.success ? "success" : "error"](rr?.success ? `已删除 ${rr.data?.deleted ?? 0} 位被退联系人，删除前档案已归档` : (rr?.error || "失败"));
      setSid(null); setSel(new Set());
      void invalidateDomain(qc, "inbox", "contacts");
    },
  });

  const retryInboxAnalysis = useCallback(async (messageId: number) => {
    if (analysisRetryingId !== null) return;
    setAnalysisRetryingId(messageId);
    try {
      const result = await window.api.invoke(INBOX_ANALYSIS_RUN_CHANNEL, messageId) as {
        success: boolean; data?: { queued: number }; error?: string;
      };
      if (!result.success) {
        message.error(result.error || '重试失败');
        return;
      }
      if (!result.data?.queued) {
        message.warning('当前邮件暂时无法重新分析');
        return;
      }
      await qc.invalidateQueries({ queryKey: ['inbox'] });
      message.success('已重新提交分析');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '重试请求失败');
    } finally {
      setAnalysisRetryingId(null);
    }
  }, [analysisRetryingId, qc]);

  // Status/stage selections follow the explicit center reference; legacy IDs use their original local-only path.
  const overwriteMut = useMutation({
    mutationFn: async (p: { id: number; email: string; centerReference?: CenterContactRef; field: "status" | "tags"; value: string | null }) => {
      if (p.centerReference) {
        if (offline) return { success: false, error: '当前离线，无法修改中心联系人' };
        const loaded = await centerInvoke<CenterContactDetail>(ONLINE_CHANNELS.CONTACT_DETAIL, p.centerReference);
        if (currentActorScope.current !== actorScope) return { success: false, error: '账号已切换，请重新操作' };
        if (!loaded.ok) return { success: false, error: loaded.error.message };
        const current = loaded.data;
        const allowed = p.field === 'tags' ? current.permissions?.canChangeStage ?? current.canFollowup : current.canFollowup;
        if (isPermissionDenied(allowed) || p.field === 'status' && !(p.value === null || p.value === '' || p.value in CENTER_STATUS)) return { success: false, error: '当前联系人不可修改' };
        const common = { ...p.centerReference, expectedVersion: current.contact.contactVersion ?? current.contact.customerVersion, idempotencyKey: crypto.randomUUID() };
        // Mail classifications are immutable mail facts, never contact status patches.
        const result = await centerInvoke<CenterContactDetail>(ONLINE_CHANNELS.CONTACT_FOLLOWUP, p.field === 'tags'
          ? { ...common, method: 'note', note: `设置跟进阶段：${CRM_STAGES.find(item => item.key === p.value)?.label || '清除'}`, stage: (p.value || 'cold') as CustomerStage }
          : { ...common, method: 'other', note: `设置联系人状态：${STATUS_META[p.value || '']?.label || '清除'}`, contactStatus: CENTER_STATUS[p.value || ''] });
        return result.ok ? { success: true } : { success: false, error: result.error.message };
      }
      return window.api.invoke("contacts:upsert", {
        id: p.id,
        email: p.email,
        ...(p.field === "status"
          ? { status: p.value ?? "" }
          : { tags: p.value ? JSON.stringify([p.value]) : null }),
      }) as Promise<{ success: boolean; error?: string }>;
    },
    onSuccess: (r: unknown) => {
      const rr = r as { success: boolean; error?: string };
      if (rr?.success) message.success("已更新");
      else message.error(rr?.error || "更新失败");
      void invalidateDomain(qc, "inbox", "contacts");
      void qc.invalidateQueries({ queryKey: ['center-contacts'] });
      void qc.invalidateQueries({ queryKey: ['center-contact-detail'] });
    },
    onError: error => message.error(error instanceof Error ? error.message : '更新失败'),
  });

  // 被退联系人同源数据（规范 docs/bounce-multi-match-spec.md）：
  // 计数由后端全库现拉 —— 按钮显示多少、确认弹窗列谁、删的就是谁；单封列表供详情首栏
  const { data: bounceStatsData } = useQuery({
    queryKey: ["inbox", "bounceStats"],
    queryFn: () => window.api.invoke("inbox:bounceMatchStats") as Promise<{ success: boolean; data?: { count: number; emails: string[] } }>,
  });
  const bounceStats = bounceStatsData?.success ? bounceStatsData.data : undefined;
  const { data: bounceMatchesData } = useQuery({
    queryKey: ["inbox", "bounceMatches", sid],
    queryFn: () => window.api.invoke("inbox:bounceMatches", sid) as Promise<{ success: boolean; data?: MatchContactRow[] }>,
    enabled: !!sid,
  });

  /** 删除单个联系人（详情两栏共用：被退栏 / 正文提及栏）；级联与孤儿公司清理在主进程 */
  const confirmDeleteContact = (c: { id: number; email: string; contactVersion?: number; canDelete?: boolean; centerReference?: CenterContactRef }) => {
    if (c.canDelete === false) { message.error('该联系人已分配或当前无删除权限'); return; }
    if (c.centerReference && (!Number.isSafeInteger(c.contactVersion) || (c.contactVersion ?? 0) < 1)) {
      message.error('联系人版本未加载，请刷新后重试'); return;
    }
    Modal.confirm({
      title: `删除联系人 ${c.email}？`,
      content: c.centerReference ? "删除后不再参与匹配和新发送任务，历史记录保留。" : "其往来记录一并删除，此操作不可撤销。",
      okText: "删除", okType: "danger", cancelText: "取消",
      onOk: async () => {
        if (c.centerReference) {
          const center={...c.centerReference,expectedVersion:c.contactVersion!};
          const signature=JSON.stringify(center);
          let request=centerDeleteRequests.current.get(signature);
          if(!request){request={contacts:[center],idempotencyKey:crypto.randomUUID()};centerDeleteRequests.current.set(signature,request);}
          const r=await centerInvoke<ContactDeleteReceipt>(ONLINE_CHANNELS.CONTACT_DELETE,request);
          if(r.ok){centerDeleteRequests.current.delete(signature);message.success('已删除');void invalidateDomain(qc,'inbox','contacts');}
          else {if(r.error.code==='CONFLICT')centerDeleteRequests.current.delete(signature);message.error(r.error.message||'删除失败');}
          return;
        }
        const r=await window.api.invoke("contacts:delete",c.id) as {success:boolean;error?:string};
        if(r?.success){message.success('已删除');void invalidateDomain(qc,'inbox','contacts');}
        else message.error(r?.error||'删除失败');
      },
    });
  };

  const allItems = useMemo(() => {
    const seen = new Set<number>();
    const items: InboxItem[] = [];
    for (const page of data?.pages ?? []) {
      for (const item of inboxResponsePage(page).items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
    }
    return items;
  }, [data]);

  const accountGroups = useMemo<InboxAccountScope[]>(() => {
    const groups = new Map<string, InboxAccountScope>();
    for (const account of syncStateQuery.data?.accounts ?? []) {
      if (!account.hasImap) continue;
      groups.set(String(account.accountId), { key: String(account.accountId), email: account.email, total: 0, unread: 0, latestAt: 0 });
    }
    if (inboxSummary) {
      for (const [key, count] of Object.entries(inboxSummary.byAccount)) {
        groups.set(key, { key, email: count.email?.trim() || key || '未命名邮箱', total: count.total, unread: count.unread, latestAt: count.latestAt ?? 0 });
      }
    } else {
      for (const item of allItems) {
        const key = inboxAccountKey(item);
        const current = groups.get(key) ?? { key, email: item._accountEmail?.trim() || '未命名邮箱', total: 0, unread: 0, latestAt: 0 };
        current.total += 1;
        if (!item.isRead) current.unread += 1;
        current.latestAt = Math.max(current.latestAt, Date.parse(item.receivedAt) || 0);
        groups.set(key, current);
      }
    }
    return [...groups.values()].sort((a, b) => b.latestAt - a.latestAt || a.email.localeCompare(b.email, 'zh-CN'));
  }, [allItems, inboxSummary, syncStateQuery.data]);

  useEffect(() => {
    if (accountFilter !== null && !accountGroups.some(group => group.key === accountFilter)) setAccountFilter(null);
  }, [accountFilter, accountGroups]);

  const scopedItems = useMemo(() => accountFilter === null
    ? allItems
    : allItems.filter(item => inboxAccountKey(item) === accountFilter), [accountFilter, allItems]);
  const campaignScopedItems = useMemo(() => {
    if (!routeCampaignId) return scopedItems;
    if (!campaignMailDetail) return [];
    const targetIds = new Set(campaignMailDetail.targets.map(target => target.contactId));
    const targetEmails = new Set(campaignMailDetail.targets.map(target => target.email.trim().toLocaleLowerCase()).filter(Boolean));
    const targetRefs = new Set(campaignMailDetail.targets.flatMap(target => target.centerReference ? [`${target.centerReference.contactId}:${target.centerReference.customerId}`] : []));
    const classification = routeCampaignStatus === 'bounced' ? 'bounce' : routeCampaignStatus;
    return scopedItems.filter(item => {
      if (classification && item.classification !== classification) return false;
      if (item.matchedContactId && targetIds.has(item.matchedContactId)) return true;
      if (targetEmails.has(item.fromEmail.trim().toLocaleLowerCase())) return true;
      const linked = [...(item._centerContacts ?? []), ...(item._centerContact ? [item._centerContact] : [])];
      return linked.some(reference => targetRefs.has(`${reference.contactId}:${reference.customerId}`) || !!reference.email && targetEmails.has(reference.email.trim().toLocaleLowerCase()));
    });
  }, [campaignMailDetail, routeCampaignId, routeCampaignStatus, scopedItems]);
  const mailCountsByDate = useMemo(() => {
    if (inboxSummary) return new Map(Object.entries(inboxSummary.byDate).map(([key, count]) => [key, { total: count.total, unread: count.unread }]));
    const counts = new Map<string, InboxCalendarCount>();
    for (const item of campaignScopedItems) {
      const key = localDateKey(item.receivedAt);
      const current = counts.get(key) ?? { total: 0, unread: 0 };
      current.total += 1;
      if (!item.isRead) current.unread += 1;
      counts.set(key, current);
    }
    return counts;
  }, [campaignScopedItems, inboxSummary]);
  const dateScopedItems = useMemo(() => dateFilter ? campaignScopedItems.filter(item => localDateKey(item.receivedAt) === dateFilter) : campaignScopedItems, [campaignScopedItems, dateFilter]);
  const pinnedItems = useMemo(() => {
    const items = (inboxSummary?.pinnedItems as InboxItem[] | undefined) ?? dateScopedItems.filter(item => item._pinned);
    return [...items].filter(item => !dateFilter || localDateKey(item.receivedAt) === dateFilter).sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt));
  }, [dateFilter, dateScopedItems, inboxSummary]);
  const pinnedCount = pinnedItems.length;
  const scopedLabelCounts = useMemo(() => {
    if (inboxSummary) return new Map(Object.entries(inboxSummary.labels).map(([key, count]) => [Number(key), count]));
    const counts = new Map<number, number>();
    for (const item of dateScopedItems) for (const labelId of item._labelIds ?? []) counts.set(labelId, (counts.get(labelId) ?? 0) + 1);
    return counts;
  }, [dateScopedItems, inboxSummary]);
  useEffect(() => {
    if (!allItems.length || labelsQuery.isLoading || !labelsQuery.data?.success) return;
    const existingNames = new Set(inboxLabels.map(folder => folder.name.trim().toLocaleLowerCase('zh-CN')));
    const suggestions = inboxFolderSuggestions(allItems).filter(suggestion => !existingNames.has(suggestion.name.toLocaleLowerCase('zh-CN')));
    if (!suggestions.length) return;
    const signature = JSON.stringify(suggestions);
    if (folderSuggestionSignature.current === signature) return;
    folderSuggestionSignature.current = signature;
    void window.api.invoke('inbox:folderSuggest', { suggestions, idempotencyKey: crypto.randomUUID() })
      .then((response: unknown) => {
        const result = response as { success: boolean; data?: { created: number } };
        if (result?.success && (result.data?.created ?? 0) > 0) void qc.invalidateQueries({ queryKey: ['inbox-labels'] });
        else if (!result?.success) folderSuggestionSignature.current = '';
      })
      .catch(() => { folderSuggestionSignature.current = ''; });
  }, [allItems, inboxLabels, labelsQuery.isLoading, qc]);
  const latestByConversation = useMemo(() => {
    const latest = new Map<string, InboxItem>();
    // Summary conversations can lag behind freshly analyzed mail; counters and the
    // list must be derived from the same live page data.
    for (const item of dateScopedItems) {
      const key = inboxConversationKey(item);
      const current = latest.get(key);
      if (!current || Date.parse(item.receivedAt) > Date.parse(current.receivedAt)) latest.set(key, item);
    }
    return latest;
  }, [dateScopedItems]);
  const latestConversationItems = useMemo(() => [...latestByConversation.values()], [latestByConversation]);
  const followupTaskQuery = useQuery({
    queryKey: ['inbox-followup-tasks', actorScope],
    enabled: !!identity?.identity?.userId && !!identity?.baseUrl,
    staleTime: 0,
    queryFn: async () => {
      const first = await centerInvoke<TaskPage>(ONLINE_CHANNELS.TASK_LIST, { status: 'open', limit: TASK_LIMITS.pageMax, offset: 0 });
      if (!first.ok) return null;
      const items = [...first.data.items];
      for (let offset = first.data.items.length; offset < first.data.total && first.data.items.length > 0; offset += TASK_LIMITS.pageMax) {
        const page = await centerInvoke<TaskPage>(ONLINE_CHANNELS.TASK_LIST, { status: 'open', limit: TASK_LIMITS.pageMax, offset });
        if (!page.ok) return null;
        if (!page.data.items.length) break;
        items.push(...page.data.items);
      }
      return items.filter(task => task.sourceKind === 'mail_manual' && !!task.sourceMessageKey);
    },
  });
  const followupTaskSourceKeys = useMemo(() => new Set([
    ...(followupTaskQuery.data ?? []).map(task => task.sourceMessageKey).filter((key): key is string => !!key),
    ...Object.values(followupTasks).map(task => task.sourceMessageKey).filter((key): key is string => !!key),
  ]), [followupTaskQuery.data, followupTasks]);
  const localFollowupMailIds = useMemo(() => new Set(Object.keys(followupTasks).map(Number)), [followupTasks]);
  const filteredItems = useMemo(() => {
    let next = dateScopedItems;
    if (filter !== "all") next = next.filter(i => i.classification === filter);
    // 阅读中的邮件先留在未读队列，避免点开瞬间整行从当前光标下消失。
    if (managementScope === "unread") next = next.filter(i => !i.isRead || i.id === sid);
    if (managementScope === "needs_reply") next = next.filter(i => latestByConversation.get(inboxConversationKey(i))?.id === i.id && inboxNeedsReply(i));
    if (managementScope === "waiting_other") next = next.filter(i => latestByConversation.get(inboxConversationKey(i))?.id === i.id && inboxWaitingOther(i));
    if (managementScope === "follow_up") next = next.filter(i => latestByConversation.get(inboxConversationKey(i))?.id === i.id && inboxNeedsFollowup(i, followupTaskSourceKeys, localFollowupMailIds));
    if (analysisFilter === 'action') next = next.filter(i => matchesInboxAnalysisFilter(i, 'action'));
    else if (analysisFilter) next = next.filter(i => matchesInboxAnalysisFilter(i, 'important') || i.id === sid);
    if (labelFilter) next = next.filter(i => (i._labelIds || []).includes(labelFilter));
    if (deferredSearch) {
      const q = deferredSearch.toLowerCase();
      next = next.filter(i => (i.subject || "").toLowerCase().includes(q) || i.fromEmail.toLowerCase().includes(q) || (i.fromName || "").toLowerCase().includes(q));
    }
    return next;
  }, [analysisFilter, dateScopedItems, deferredSearch, filter, followupTaskSourceKeys, labelFilter, latestByConversation, localFollowupMailIds, managementScope, sid]);
  const todoOpenItems = useMemo(
    () => todoView ? filteredItems.filter(item => item._todoState !== 'done') : [],
    [filteredItems, todoView],
  );
  const todoOpenIds = useMemo(() => todoOpenItems.map(item => item.id), [todoOpenItems]);
  // 联系人往来聚合：收到的邮件按发件人，已发送邮件按首个外部收件人归入同一联系人。
  const senderGroups = useMemo<InboxContactGroup[]>(() => {
    if (view !== "sender") return [];
    const visibleContacts = new Set(filteredItems.map(inboxContactEmail));
    const map = new Map<string, InboxItem[]>();
    for (const i of allItems) {
      const email = inboxContactEmail(i);
      if (!visibleContacts.has(email)) continue;
      const existing = map.get(email);
      if (existing) existing.push(i);
      else map.set(email, [i]);
    }
    return [...map.entries()].map(([email, messages]) => ({
      email,
      name: inboxContactName(messages),
      count: messages.length,
      unread: messages.filter(item => !item.isRead).length,
      insight: inboxContactInsight(messages),
    })).sort((a, b) => Date.parse(b.insight.latestAt) - Date.parse(a.insight.latestAt));
  }, [allItems, filteredItems, view]);

  const items = useMemo(() => {
    // 除待办分组外，所有邮件和联系人视图都按最近时间倒序。
    let next = view === "sender" && senderFilter ? filteredItems.filter(i => inboxContactEmail(i) === senderFilter) : filteredItems;
    return [...next].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  }, [analysisFilter, filteredItems, filter, senderFilter, view]);
  const backfilledTodoKeys = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (identity?.status !== 'authenticated') return;
    const pending = items
      .filter(item => item._todoState === 'open' && (item._centerMessageKeys?.length ?? 0) > 0)
      .filter(item => !backfilledTodoKeys.current.has(item._centerMessageKeys![0]!))
      .slice(0, 20);
    if (!pending.length) return;
    void (async () => {
      let created = 0;
      for (const item of pending) {
        const ref = todoTaskRef(item);
        if (!ref) continue;
        backfilledTodoKeys.current.add(ref.messageKey);
        const result = await openInboxTask(ref, (channel, ...args) => window.api.invoke(channel, ...args));
        if (result === 'created') created += 1;
      }
      if (created > 0) message.success({ key: 'inbox-task-backfill', content: `已同步 ${created} 条历史邮件待办到客户跟进任务` });
    })();
  }, [items, identity?.status, todoTaskRef]);
  const handledSentReplies = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (identity?.status !== 'authenticated') return;
    const sent = items.filter(item => item.classification === 'sent' && !!item._centerContact && !handledSentReplies.current.has(item.id));
    if (!sent.length) return;
    void (async () => {
      let completed = 0;
      for (const item of sent) {
        handledSentReplies.current.add(item.id);
        const result = await completeRepliedTask(item._centerContact!.customerId, normalizeInboxSubject(item.subject), item.receivedAt, (channel, ...args) => window.api.invoke(channel, ...args));
        if (result === 'completed') completed += 1;
      }
      if (completed > 0) message.success({ key: 'inbox-reply-task', content: `已根据已发送邮件完成 ${completed} 条跟进待办` });
    })();
  }, [items, identity?.status]);
  useEffect(() => {
    if ((!routeMailSubject && !routeCenterMail) || isLoading || !latestInboxResponse?.success) return;
    const routeKey = `${routeCenterMail || ''}:${routeMailContact}:${routeMailCustomer || ''}:${routeMailSubject}:${routeMailAt || ''}`;
    if (handledMailRoute.current === routeKey) return;
    handledMailRoute.current = routeKey;
    const normalized = normalizeInboxSubject(routeMailSubject);
    const exact = routeCenterMail ? allItems.find(item => item._centerMessageKeys?.includes(routeCenterMail)) : undefined;
    const candidates = exact ? [exact] : allItems.filter(item => {
      if (normalizeInboxSubject(item.subject) !== normalized) return false;
      if (!Number.isSafeInteger(routeMailContact) || routeMailContact <= 0) return true;
      const references = item._centerContacts?.length ? item._centerContacts : item._centerContact ? [item._centerContact] : [];
      return references.some(reference => reference.contactId === routeMailContact && (!routeMailCustomer || reference.customerId === routeMailCustomer));
    });
    if (!candidates.length) {
      setFilter('all');
      setManagementScope('all');
      setAnalysisFilter(null);
      setLabelFilter(null);
      setDateFilter(null);
      setView('flat');
      setSenderFilter(null);
      setSearch(routeMailSubject || '');
      setSid(null);
      setSel(new Set());
      setLast(null);
      setBody(null);
      setBl(false);
      message.warning('目标邮件尚未同步到本地，请重新拉取后再试');
      return;
    }
    const routeTime = Date.parse(routeMailAt || '');
    const target = candidates.slice().sort((left, right) => {
      const leftDelta = Number.isFinite(routeTime) ? Math.abs(Date.parse(left.receivedAt) - routeTime) : 0;
      const rightDelta = Number.isFinite(routeTime) ? Math.abs(Date.parse(right.receivedAt) - routeTime) : 0;
      return leftDelta - rightDelta || Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
    })[0]!;
    setFilter('all');
    setManagementScope('all');
    setAnalysisFilter(null);
    setLabelFilter(null);
    setDateFilter(null);
    setView('flat');
    setSenderFilter(null);
    setSearch('');
    setSid(target.id);
    setSel(new Set([target.id]));
    setLast(target.id);
    void navigate({ to: '/inbox', search: {}, replace: true });
  }, [allItems, isLoading, latestInboxResponse?.success, navigate, routeCenterMail, routeMailAt, routeMailContact, routeMailCustomer, routeMailSubject]);
  useEffect(() => {
    if (routeMailSubject || view !== 'flat' || isLoading) return;
    if (items.length === 0) {
      setSid(null);
      setSel(new Set());
      return;
    }
    if (sid !== null && items.some(item => item.id === sid)) return;
    const first = items[0]!;
    setSid(first.id);
    setSel(new Set([first.id]));
    setLast(first.id);
  }, [isLoading, items, routeMailSubject, sid, view]);
  const { cleanRows, cleanTotalHeight } = useMemo(() => {
    if (view !== 'flat') return { cleanRows: [] as CleanListRow[], cleanTotalHeight: 0 };
    const groups = new Map<string, { label: string; latest: number; order: number; items: InboxItem[] }>();
    for (const item of items) {
      const meta = todoView ? todoGroupMeta(item) : { ...cleanListGroupMeta(item.receivedAt), order: 0 };
      const group = groups.get(meta.key);
      const latest = Date.parse(item.receivedAt);
      if (group) {
        group.items.push(item);
        group.latest = Math.max(group.latest, latest);
      } else groups.set(meta.key, { label: meta.label, latest, order: meta.order, items: [item] });
    }
    const rows: CleanListRow[] = [];
    let top = 0;
    for (const [key, group] of [...groups.entries()].sort((a, b) => todoView ? a[1].order - b[1].order || b[1].latest - a[1].latest : b[1].latest - a[1].latest)) {
      rows.push({ kind: 'header', key: `header:${key}`, groupKey: key, label: `${group.label} (${group.items.length})`, top, height: todoView ? TODO_GROUP_H : CLEAN_GROUP_H });
      top += todoView ? TODO_GROUP_H : CLEAN_GROUP_H;
      if (collapsedCleanGroups.has(key)) continue;
      for (const item of group.items) {
        const height = todoView ? TODO_ROW_H : CLEAN_ROW_H;
        rows.push({ kind: 'mail', key: `mail:${item.id}`, item, top, height });
        top += height;
      }
    }
    return { cleanRows: rows, cleanTotalHeight: top };
  }, [collapsedCleanGroups, items, todoView, view]);
  useEffect(() => {
    if (!hasNextPage || !nextInboxPageCursor || isFetchingNextPage || isLoading) return;
    const loadedHeight = view === 'flat' ? cleanTotalHeight : items.length * SENDER_ROW_H;
    const remaining = loadedHeight - (scrollTop + listH);
    if (remaining <= SENDER_ROW_H * 8) void fetchNextPage();
  }, [cleanTotalHeight, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, items.length, listH, nextInboxPageCursor, scrollTop, view]);
  const sel_ = items.find(i => i.id === sid) || null;
  const autoOpenedQuote = useRef<number | null>(null);
  useEffect(() => {
    const quoteCard = sel_?._quoteCard;
    if (!quoteCard || autoOpenedQuote.current === quoteCard.messageId) return;
    autoOpenedQuote.current = quoteCard.messageId;
    setContextSidebarOpen(true);
  }, [sel_?._quoteCard]);
  const selectedItems = useMemo(() => allItems.filter(item => sel.has(item.id)), [allItems, sel]);
  const selectedAllPinned = selectedItems.length > 0 && selectedItems.every(item => item._pinned);
  const legacyBounceMatches = bounceMatchesData?.success ? bounceMatchesData.data || [] : [];
  const centerBounceMatches: MatchContactRow[] = (sel_?._centerContacts ?? []).filter(link => link.role === 'bounce').map(link => ({
    id: link.contactId,
    email: link.email || '',
    companyName: link.companyName || null,
    contactVersion: link.contactVersion,
    canDelete: link.canDelete,
    centerReference: { contactId: link.contactId, customerId: link.customerId },
  }));
  const bounceMatches = Array.isArray(sel_?._centerContacts) ? centerBounceMatches : legacyBounceMatches;

  // 虚拟滚动可视区计算
  const startIdx = Math.max(0, Math.floor(scrollTop / mailRowHeight) - OVERSCAN);
  const endIdx = Math.min(items.length, Math.ceil((scrollTop + listH) / mailRowHeight) + OVERSCAN);
  const visibleItems = items.slice(startIdx, endIdx);
  const cleanStartIdx = (() => {
    let lo = 0, hi = cleanRows.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const row = cleanRows[mid]!;
      if (row.top + row.height <= scrollTop) lo = mid + 1;
      else hi = mid;
    }
    return Math.max(0, lo - OVERSCAN);
  })();
  const cleanEndIdx = (() => {
    let idx = cleanStartIdx;
    const bottom = scrollTop + listH;
    while (idx < cleanRows.length && cleanRows[idx]!.top < bottom) idx++;
    return Math.min(cleanRows.length, idx + OVERSCAN);
  })();
  const visibleCleanRows = cleanRows.slice(cleanStartIdx, cleanEndIdx);
  // 发信人可视区（独立行高）
  const senderStart = Math.max(0, Math.floor(scrollTop / SENDER_ROW_H) - OVERSCAN);
  const senderEnd = Math.min(senderGroups.length, Math.ceil((scrollTop + listH) / SENDER_ROW_H) + OVERSCAN);
  const visibleSenders = senderGroups.slice(senderStart, senderEnd);

  // 邮箱匹配 — 参照旧 PE _extractBodyContacts（memo 化，避免每次渲染重复正则处理大正文）
  const { matchedContacts, unmatchedEmails, senderContact, matchReady } = useMemo(() => {
    const matched: MatchedContact[] = [];
    const unmatched: string[] = [];
    let sender: MatchedContact | null = null;
    const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const ready = !!(body && contactsData?.success);
    if (ready) {
      const contacts = contactsData!.data || [];
      const idx: Record<string, MatchedContact> = {};
      const ambiguous = new Set<string>();
      for (const c of contacts) {
        if (!c.email) continue;
        const key = c.email.toLowerCase().trim();
        if (ambiguous.has(key)) continue;
        const previous = idx[key]?.centerReference;
        if (previous && c.centerReference && (previous.contactId !== c.centerReference.contactId || previous.customerId !== c.centerReference.customerId)) {
          delete idx[key]; ambiguous.add(key); continue;
        }
        idx[key] = { company: c.companyName || "", id: c.id, email: c.email, contactVersion: c.contactVersion, canDelete: c.canDelete, centerReference: c.centerReference };
      }
      // ① 发件人
      if (sel_) {
        const sk = sel_.fromEmail.toLowerCase().trim();
        const sc = idx[sk];
        if (sc) { sender = sc; matched.push({ ...sc, email: sel_.fromEmail }); }
        else unmatched.push(sel_.fromEmail);
      }
      // ② 正文：剥 HTML 标签 + 拼接 raw 原文，跟旧 PE 一样
      const seen = new Set<string>();
      if (sel_) seen.add(sel_.fromEmail.toLowerCase().trim());
      const textBody = body!
        .replace(/<[^>]+>/g, " ")      // 剥 HTML → 纯文本
        .replace(/&[#a-z0-9]+;/gi, " ") // 实体解码
        .replace(/\s+/g, " ");          // 合并空白
      const emails = textBody.match(EMAIL_RE) || [];
      for (const em of emails) {
        if (matched.length >= 20) break;
        const key = em.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        const c = idx[key];
        if (c) matched.push({ ...c, email: em });
        else unmatched.push(em);
      }
      // Address headers may contain colleagues or customer contacts that never appear in the body.
      // Only surface those that already exist; internal addresses must not become add-contact prompts.
      for (const em of [sel_?.to, sel_?.cc].flatMap(value => value?.match(EMAIL_RE) || [])) {
        if (matched.length >= 20) break;
        const key = em.toLowerCase().trim();
        if (seen.has(key)) continue;
        seen.add(key);
        const c = idx[key];
        if (c) matched.push({ ...c, email: em });
      }
    }
    return { matchedContacts: matched, unmatchedEmails: unmatched, senderContact: sender, matchReady: ready };
  }, [body, contactsData, sel_]);
  const senderReference = senderContact?.centerReference;
  const followupReference = senderReference ?? matchedContacts.find(contact => contact.centerReference)?.centerReference;
  const senderDetail = useQuery({
    queryKey: ['center-contact-detail', identity?.baseUrl, identity?.identity?.userId, senderReference?.customerId, senderReference?.contactId],
    enabled: !!senderReference,
    queryFn: () => centerInvoke<CenterContactDetail>(ONLINE_CHANNELS.CONTACT_DETAIL, senderReference),
  });
  const selectedMailEvent = useMemo(() => {
    const center = senderDetail.data?.ok ? senderDetail.data.data : undefined;
    return sel_ && center ? inboxAnalysisEvent(center, sel_) : undefined;
  }, [sel_, senderDetail.data]);
  const selectedFollowupTask = sel_ ? followupTasks[sel_.id] ?? followupTaskQuery.data?.find(task =>
    task.sourceMessageKey === selectedMailEvent?.messageKey || Boolean(task.sourceMessageKey && sel_._centerMessageKeys?.includes(task.sourceMessageKey))
  ) : undefined;
  const selectedAnalysisQuery = useMemo(() => selectedMailEvent?.contentHash ? {
    contactId: selectedMailEvent.contactId,
    customerId: selectedMailEvent.customerId,
    mailboxKey: selectedMailEvent.mailboxKey,
    messageKey: selectedMailEvent.messageKey,
    contentHash: selectedMailEvent.contentHash,
    includeHistory: true,
    historyLimit: 20,
  } : null, [selectedMailEvent]);
  const createFollowupTask = useMutation({
    mutationFn: async () => {
      if (!sel_ || !followupReference) throw new Error('请先匹配中心联系人');
      const loaded = senderDetail.data?.ok ? senderDetail.data.data : null;
      let center = loaded;
      if (!center) {
        const result = await centerInvoke<CenterContactDetail>(ONLINE_CHANNELS.CONTACT_DETAIL, followupReference);
        if (!result.ok) throw new Error(result.error.message);
        center = result.data;
      }
      const waitingDays = inboxWaitingDays(sel_);
      const dueAt = new Date(Date.now() + (waitingDays >= FOLLOWUP_SUGGESTION_DAYS ? DAY_MS : FOLLOWUP_SUGGESTION_DAYS * DAY_MS)).toISOString();
      const title = (sel_._analysis?.nextAction || `跟进：${sel_.subject || '客户邮件'}`).slice(0, 500);
      const result = await centerInvoke<FollowupTask>(ONLINE_CHANNELS.TASK_CREATE, {
        customerId: center.contact.customerId,
        title,
        dueAt,
        expectedCustomerVersion: center.contact.customerVersion,
        ...(selectedMailEvent ? { sourceKind: 'mail_manual' as const, sourceMessageKey: selectedMailEvent.messageKey } : {}),
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: task => {
      if (sel_) setFollowupTasks(current => ({ ...current, [sel_.id]: task }));
      void qc.invalidateQueries({ queryKey: ['inbox-followup-tasks'] });
      message.success('已创建 3 天后跟进任务');
    },
    onError: error => message.error(error instanceof Error ? error.message : '跟进任务创建失败'),
  });
  const cancelFollowupTask = useMutation({
    mutationFn: async () => {
      if (!sel_ || !selectedFollowupTask) throw new Error('跟进任务不存在');
      const result = await centerInvoke<FollowupTask>(ONLINE_CHANNELS.TASK_CANCEL, {
        taskId: selectedFollowupTask.taskId,
        expectedVersion: selectedFollowupTask.version,
        reason: '用户取消 3 天跟进任务',
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    },
    onSuccess: () => {
      if (sel_) setFollowupTasks(current => {
        const next = { ...current };
        delete next[sel_.id];
        return next;
      });
      void qc.invalidateQueries({ queryKey: ['inbox-followup-tasks'] });
      message.success('已取消跟进任务');
    },
    onError: error => message.error(error instanceof Error ? error.message : '取消跟进失败'),
  });
  const rememberSelectedAnalysis = useCallback((view: ContactMailAnalysisView) => {
    if (sel_) setAnalysisByMessage(current => ({ ...current, [sel_.id]: view }));
  }, [sel_?.id]);
  useEffect(() => { setAnalysisByMessage({}); }, [actorScope]);

  // 正文 iframe 文档（memo 化，避免每次渲染重新拼接大字符串触发 iframe 重载）
  const bodyDoc = useMemo(() => {
    if (!body) return undefined;
    return "<!DOCTYPE html><html><head><meta charset=utf-8><style>" +
      "html,body{margin:0;padding:0}" +
      "body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.8;color:#333;padding:0 20px 20px}" +
      "a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}" +
      "blockquote{border-left:3px solid #d0d5dd;padding:4px 0 4px 12px;color:#667085;margin:12px 0}" +
      "table{border-collapse:collapse}" +
      "td,th{border:1px solid #e5e5e5;padding:6px 10px;font-size:13px}" +
      "pre{background:#f5f5f5;padding:10px 14px;border-radius:4px;font-size:12px;overflow-x:auto}" +
      "</style><script>var z=1;document.addEventListener('wheel',function(e){if(e.ctrlKey){e.preventDefault();z*=e.deltaY<0?1.1:0.9;z=Math.min(3,Math.max(0.3,z));document.body.style.zoom=z}},{passive:false})</script></head><body>" + body + "</body></html>";
  }, [body]);

  useEffect(() => {
    if (routeDetail) return; // 深链切回全部分类时，不能清掉正在定位的目标。
    setSid(null); setSel(new Set()); setLast(null);
  }, [analysisFilter, filter, labelFilter, managementScope]);

  // 测量列表容器高度
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setListH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 过滤/搜索/视图/发信人变化时回到顶部
  useEffect(() => {
    setScrollTop(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [analysisFilter, filter, labelFilter, managementScope, search, view, senderFilter]);

  // 选中邮件 → 加载正文 + 量高度（优先前端缓存，切回已看邮件秒开）
  useEffect(() => {
    let active = true;
    if (!sid) { setBody(null); setBl(false); return; }
    const cached = bodyCache.current.get(sid);
    if (cached !== undefined) {
      setBody(cached);
      setBl(false);
      return;
    }
    setBl(true);
    setBody(null);
    window.api.invoke("inbox:getBody", sid).then((r: unknown) => {
      const rr = r as { success: boolean; data?: string };
      const html = rr?.success ? rr.data || null : null;
      rememberBody(bodyCache.current, sid, html);
      if (active) setBody(html);
    }).catch(() => { if (active) setBody(null); }).finally(() => { if (active) setBl(false); });
    return () => { active = false; };
  }, [sid, bodyCache]);


  // 未读标记只随点击/右键标读消失（存 localStorage 跨会话）；不再「首载全标已读」——
  // 那会把你还没看的邮件在打开页面瞬间全部清标

  useEffect(() => {
    const off = window.api.on("inbox:newMail", (p: unknown) => {
      const pp = p as { count: number; byClass?: Record<string, number> };
      if (pp?.count) {
        const labels: Record<string, string> = { replied: "回复", bounce: "退信", autoreply: "自动回复", other: "其他", sent: "已发送" };
        const detail = pp.byClass ? Object.entries(pp.byClass).map(([k, v]) => `${labels[k] || k} ${v}`).join("、") : "";
        message.info(`拉取到 ${pp.count} 封新邮件${detail ? `：${detail}` : ""}`);
      }
      // App 的全局监听统一刷新数据，这里仅负责新邮件提示。
      void qc.invalidateQueries({ queryKey: ['contacts', 'match'] });
      void qc.invalidateQueries({ queryKey: ['center-contacts'] });
      void qc.invalidateQueries({ queryKey: ['center-contact-detail'] });
    });
    const offAnalysis = window.api.on(INBOX_EVENTS.ANALYSIS_UPDATED, () => {
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    });
    return () => { off(); offAnalysis(); };
  }, [qc]);
  useEffect(() => {
    const off = window.api.on("inbox:fetchProgress", (p: unknown) => {
      const pp = p as InboxFetchProgress;
      if (pp && typeof pp.accountId === "number" && typeof pp.phase === "string") {
        setFetchProgress(prev => {
          const key = String(pp.accountId);
          const current = prev[key];
          if (current?.phase === INBOX_FETCH_PHASES.FAILED && pp.phase !== INBOX_FETCH_PHASES.FAILED) return prev;
          const scanning = pp.phase === INBOX_FETCH_PHASES.SCANNING;
          return {
            ...prev,
            [key]: {
              ...current,
              ...pp,
              scanned: scanning || pp.scanned > 0 ? pp.scanned : current?.scanned ?? 0,
              total: scanning || pp.total > 0 ? pp.total : current?.total ?? 0,
              newCount: scanning || pp.newCount > 0 ? pp.newCount : current?.newCount ?? 0,
              remaining: scanning || pp.remaining > 0 ? pp.remaining : current?.remaining ?? 0,
              processedCount: pp.processedCount ?? current?.processedCount,
              requiredCount: pp.requiredCount ?? current?.requiredCount,
              currentSubject: pp.currentSubject ?? current?.currentSubject,
            },
          };
        });
      }
    });
    return off;
  }, []);

  // 从联系人/CRM跳转来 → 自动搜索邮箱
  useEffect(() => {
    if (location.pathname !== "/inbox") return;
    const qs = location.searchStr;
    if (!qs) return;
    const sp = new URLSearchParams(qs);
    const detail = Number(sp.get("detail"));
    if (Number.isSafeInteger(detail) && detail > 0) {
      setIncludeId(detail); setSid(detail); setSel(new Set([detail])); setLast(detail);
      setFilter("all"); setManagementScope("all"); setAnalysisFilter(null); setLabelFilter(null); setSearch(""); setView("flat"); setSenderFilter(null);
      return;
    }
    const q = sp.get("search");
    if (q) {
      setSearch(q);
      setFilter("all"); setManagementScope("all"); setAnalysisFilter(null); setLabelFilter(null); setView("flat"); setSenderFilter(null);
      void navigate({ to: "/inbox", search: {}, replace: true });
    }
  }, [location.pathname, location.searchStr, navigate]);

  useEffect(() => {
    if (!routeDetail || includeId !== routeDetail || isLoading || !latestInboxResponse) return;
    if (!latestInboxResponse.success) { message.error(latestInboxResponse.error || "邮件加载失败"); return; }
    if (filter !== "all" || managementScope !== "all" || analysisFilter !== null || labelFilter !== null || view !== "flat" || search || senderFilter) return;
    const index = items.findIndex(i => i.id === routeDetail);
    if (index < 0) {
      message.warning("该邮件已删除或无法找到"); setSid(null); setSel(new Set());
    } else {
      const top = index * ROW_H;
      if (listRef.current) listRef.current.scrollTop = top;
      setScrollTop(top);
    }
    void navigate({ to: "/inbox", search: {}, replace: true });
  }, [routeDetail, includeId, isLoading, latestInboxResponse, filter, managementScope, analysisFilter, labelFilter, view, search, senderFilter, navigate]);

  const replyToMessage = useCallback((item: InboxItem) => {
    if (!item.accountId && !defaultReplyAccountId) { message.warning('请先在设置中配置发信账号'); return; }
    const subject = item.subject?.match(/^Re:\s*/i) ? item.subject : `Re: ${item.subject || ''}`;
    setReplyDraft({ item, accountId: item.accountId || defaultReplyAccountId, to: item.fromEmail, cc: '', subject, body: '', attachments: [] });
  }, [defaultReplyAccountId]);
  const sendReply = async () => {
    if (!replyDraft || replyBusy) return;
    setReplyBusy(true);
    try {
      const files = replyDraft.attachments.map(file => file.originFileObj).filter((file): file is NonNullable<typeof file> => !!file);
      if (files.length > 10) throw new Error('附件最多 10 个');
      if (files.reduce((sum, file) => sum + file.size, 0) > 25 * 1024 * 1024) throw new Error('附件总大小超过 25MB');
      const attachments = await Promise.all(files.map(async file => ({ filename: file.name, contentType: file.type || undefined, dataBase64: await fileBase64(file) })));
      const result = await window.api.invoke('inbox:reply', {
        accountId: replyDraft.accountId,
        to: replyDraft.to.split(/[,;]/).map(value => value.trim()).filter(Boolean),
        cc: replyDraft.cc.split(/[,;]/).map(value => value.trim()).filter(Boolean),
        subject: replyDraft.subject,
        body: replyDraft.body,
        attachments,
      }) as { success: boolean; data?: { messageId: string; sentAt: string; localId: number | null }; error?: string };
      if (!result?.success) throw new Error(result?.error || '发送失败');
      const item = replyDraft.item;
      const sentAt = result.data?.sentAt ?? new Date().toISOString();
      if (item._todoState === 'open') {
        const done = await window.api.invoke('inbox:todoState', { messageId: item.id, state: 'done', idempotencyKey: crypto.randomUUID() }) as { success?: boolean };
        if (done?.success) { patchTodoStateCache([item.id], 'done'); patchConversationCache([item.id], null); }
      }
      const ref = todoTaskRef(item);
      if (ref) await completeRepliedTask(ref.customerId, ref.threadKey, sentAt, (channel, ...args) => window.api.invoke(channel, ...args));
      if (result.data && result.data.localId === null) message.warning('邮件已发送，但本地记录未保存');
      message.success('已发送');
      setReplyDraft(null);
      void invalidateDomain(qc, 'inbox');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发送失败');
    } finally { setReplyBusy(false); }
  };

  const click = useCallback((e: React.MouseEvent, item: InboxItem) => {
    const id = item.id;
    let ns = new Set(sel);
    if (e.shiftKey && last !== null) {
      const vi = items.map(i => i.id), ap = vi.indexOf(last), cp = vi.indexOf(id);
      if (ap >= 0 && cp >= 0) { const [f, t] = ap < cp ? [ap, cp] : [cp, ap]; ns = new Set(vi.slice(f, t + 1)); }
    } else if (e.ctrlKey || e.metaKey) { ns.has(id) ? ns.delete(id) : ns.add(id); }
    else { ns = ns.has(id) && ns.size === 1 ? new Set() : new Set([id]); }
    setSel(ns); setLast(id); setSid(id);
    readMut.mutate([id]);
  }, [items, sel, last]);

  const ctxMenu = useCallback((e: React.MouseEvent, item: InboxItem) => {
    e.preventDefault();
    if (!sel.has(item.id)) { setSel(new Set([item.id])); setSid(item.id); }
    setMenu({ x: e.clientX, y: e.clientY, item });
  }, [sel]);

  useEffect(() => { if (!menu) return; const c = () => setMenu(null); document.addEventListener("click", c); return () => document.removeEventListener("click", c); }, [menu]);

  const batchRead = async () => {
    try {
      await readMut.mutateAsync([...sel]);
      message.success("已标为已读");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "标记已读失败");
    }
  };
  const batchDel = () => {
    if (!sel.size) return;
    Modal.confirm({ title: `删除 ${sel.size} 封？`, okText: "删除", okType: "danger", cancelText: "取消", onOk: () => delMut.mutate([...sel]) });
  };
  const batchType = async (t: string) => {
    const startedScope=actorScope;
    try {
      for (const id of sel) {
        if(currentActorScope.current!==startedScope)return;
        await classMut.mutateAsync({id,classification:t});
      }
      if(currentActorScope.current===startedScope)message.success(`已标为 ${TYPE[t]?.label || t}`);
    } catch(error) {
      if(currentActorScope.current===startedScope)message.error(error instanceof Error?error.message:'分类修改失败');
    }
  };
  const batchUnread = async () => {
    if (!sel.size) return;
    const response = await window.api.invoke('inbox:setReadState', { messageIds: [...sel], read: false, idempotencyKey: crypto.randomUUID() }) as { success: boolean; error?: string };
    if (!response?.success) { message.error(response?.error || '标记未读失败'); return; }
    void invalidateDomain(qc, 'inbox');
    message.success('已标为未读');
  };
  const batchPinSelected = async (pinned: boolean) => {
    if (!sel.size) return;
    const startedScope = actorScope;
    try {
      for (const messageId of sel) {
        if (currentActorScope.current !== startedScope) return;
        const response = await window.api.invoke('inbox:pinMessage', { messageId, pinned, idempotencyKey: crypto.randomUUID() }) as { success: boolean; error?: string };
        if (!response?.success) throw new Error(response?.error || '置顶邮件保存失败');
      }
      if (currentActorScope.current === startedScope) {
        void invalidateDomain(qc, 'inbox');
        message.success(pinned ? '已置顶' : '已取消置顶');
      }
    } catch (error) {
      if (currentActorScope.current === startedScope) message.error(error instanceof Error ? error.message : '置顶邮件保存失败');
    }
  };
  const batchMoveToFolder = async (labelId: number | null) => {
    if (!sel.size) return;
    const startedScope = actorScope;
    try {
      for (const messageId of sel) {
        if (currentActorScope.current !== startedScope) return;
        const response = await window.api.invoke('inbox:messageLabels', { messageId, labelIds: labelId ? [labelId] : [], idempotencyKey: crypto.randomUUID() }) as { success: boolean; error?: string };
        if (!response?.success) throw new Error(response?.error || '移动文件夹失败');
      }
      if (currentActorScope.current === startedScope) {
        refreshLabels();
        message.success(labelId ? '已移动到文件夹' : '已移出文件夹');
      }
    } catch (error) {
      if (currentActorScope.current === startedScope) message.error(error instanceof Error ? error.message : '移动文件夹失败');
    }
  };

  const inboxSnapshots = () => qc.getQueriesData({
    predicate: query => query.queryKey[0] === 'inbox' && typeof query.queryKey[1] !== 'string',
  });
  const restoreInboxSnapshots = (snapshots: ReturnType<typeof inboxSnapshots>) => {
    for (const [key, value] of snapshots) qc.setQueryData(key, value);
  };
  const patchConversationCache = (messageIds: number[], state: InboxConversationState | null) => {
    const ids = new Set(messageIds);
    const keys = new Set(allItems.filter(item => ids.has(item.id)).map(inboxConversationKey));
    const snapshots = inboxSnapshots();
    const latest = new Map<string, { id: number; at: number }>();
    for (const item of allItems) {
      const conversationKey = inboxConversationKey(item);
      const at = Date.parse(item.receivedAt) || 0;
      const current = latest.get(conversationKey);
      if (!current || at > current.at) latest.set(conversationKey, { id: item.id, at });
    }
    qc.setQueriesData({ predicate: query => query.queryKey[0] === 'inbox' && typeof query.queryKey[1] !== 'string' }, value => mapInboxCacheItems(value, item => {
      const conversationKey = inboxConversationKey(item);
      if (!keys.has(conversationKey)) return item;
      return { ...item, _conversationState: latest.get(conversationKey)?.id === item.id ? state : null };
    }));
    return snapshots;
  };
  const patchPinnedCache = (messageIds: number[], pinned: boolean) => {
    const ids = new Set(messageIds);
    const snapshots = inboxSnapshots();
    qc.setQueriesData({ predicate: query => query.queryKey[0] === 'inbox' && typeof query.queryKey[1] !== 'string' }, value => mapInboxCacheItems(value, item => ids.has(item.id) ? { ...item, _pinned: pinned } : item));
    return snapshots;
  };
  const patchFolderCache = (messageIds: number[], labelId: number) => {
    const ids = new Set(messageIds);
    const snapshots = inboxSnapshots();
    qc.setQueriesData({ predicate: query => query.queryKey[0] === 'inbox' && typeof query.queryKey[1] !== 'string' }, value => mapInboxCacheItems(value, item => ids.has(item.id) ? { ...item, _labelIds: [labelId] } : item));
    return snapshots;
  };
  const chunkIds = (ids: number[]) => {
    const chunks: number[][] = [];
    for (let index = 0; index < ids.length; index += INBOX_DROP_CHUNK_SIZE) chunks.push(ids.slice(index, index + INBOX_DROP_CHUNK_SIZE));
    return chunks;
  };
  const applyConversationDrop = async (target: Extract<InboxDropTarget, { kind: 'conversation' }>, messageIds: number[]) => {
    if (dropBusy.current || !messageIds.length) return;
    dropBusy.current = true;
    const startedScope = actorScope;
    const snapshots = patchConversationCache(messageIds, target.state);
    try {
      for (const chunk of chunkIds(messageIds)) {
        if (currentActorScope.current !== startedScope) return;
        const response = await window.api.invoke('inbox:conversationStateBatch', {
          messageIds: chunk,
          state: target.state,
          idempotencyKey: crypto.randomUUID(),
        }) as { success: boolean; data?: InboxConversationStateBatchResult; error?: string };
        if (!response?.success) throw new Error(response?.error || '会话分类保存失败');
      }
      if (currentActorScope.current === startedScope) {
        message.success(`已移入${target.label}`);
        void invalidateDomain(qc, 'inbox');
      }
    } catch (error) {
      restoreInboxSnapshots(snapshots);
      if (currentActorScope.current === startedScope) message.error(error instanceof Error ? error.message : '会话分类保存失败');
    } finally {
      dropBusy.current = false;
    }
  };
  const clearConversationState = async (messageIds: number[]) => {
    if (dropBusy.current || !messageIds.length) return;
    dropBusy.current = true;
    const snapshots = patchConversationCache(messageIds, null);
    try {
      for (const chunk of chunkIds(messageIds)) {
        const response = await window.api.invoke('inbox:conversationStateBatch', {
          messageIds: chunk,
          state: null,
          idempotencyKey: crypto.randomUUID(),
        }) as { success: boolean; error?: string };
        if (!response?.success) throw new Error(response?.error || '移出分类失败');
      }
      message.success('已移出当前分类');
      void invalidateDomain(qc, 'inbox');
    } catch (error) {
      restoreInboxSnapshots(snapshots);
      message.error(error instanceof Error ? error.message : '移出分类失败');
    } finally {
      dropBusy.current = false;
    }
  };
  const applyPinDrop = async (messageIds: number[]) => {
    if (dropBusy.current || !messageIds.length) return;
    dropBusy.current = true;
    const snapshots = patchPinnedCache(messageIds, true);
    try {
      for (const chunk of chunkIds(messageIds)) {
        const response = await window.api.invoke('inbox:messagesPinBatch', {
          messageIds: chunk,
          pinned: true,
          idempotencyKey: crypto.randomUUID(),
        }) as { success: boolean; error?: string };
        if (!response?.success) throw new Error(response?.error || '置顶保存失败');
      }
      message.success('已置顶');
      refreshLabels();
      void invalidateDomain(qc, 'inbox');
    } catch (error) {
      restoreInboxSnapshots(snapshots);
      message.error(error instanceof Error ? error.message : '置顶保存失败');
    } finally {
      dropBusy.current = false;
    }
  };
  const applyFolderDrop = async (target: Extract<InboxDropTarget, { kind: 'folder' }>, messageIds: number[]) => {
    if (dropBusy.current || !messageIds.length) return;
    dropBusy.current = true;
    const snapshots = patchFolderCache(messageIds, target.labelId);
    try {
      for (const chunk of chunkIds(messageIds)) {
        const response = await window.api.invoke('inbox:messageLabelsBatch', {
          messageIds: chunk,
          labelIds: [target.labelId],
          idempotencyKey: crypto.randomUUID(),
        }) as { success: boolean; error?: string };
        if (!response?.success) throw new Error(response?.error || '移动文件夹失败');
      }
      message.success(`已移动到${target.name}`);
      refreshLabels();
      void invalidateDomain(qc, 'inbox');
    } catch (error) {
      restoreInboxSnapshots(snapshots);
      message.error(error instanceof Error ? error.message : '移动文件夹失败');
    } finally {
      dropBusy.current = false;
    }
  };
  const autoFolderName = (item: InboxItem): string => {
    const legacyCompany = item.matchedContactId ? contactsData?.data?.find(row => row.id === item.matchedContactId)?.companyName : null;
    const centerCompany = item._centerContacts?.find(link => link.role === 'primary')?.companyName || item._centerContacts?.find(link => link.companyName)?.companyName || null;
    const company = (legacyCompany || centerCompany || '').trim();
    if (company) return company.slice(0, 24);
    if (item.classification !== 'sent' && item.fromName?.trim()) return item.fromName.trim().slice(0, 24);
    const email = inboxContactEmail(item);
    return (email.split('@')[0] || email).slice(0, 24);
  };
  const applyBlankFolderDrop = async (messageIds: number[]) => {
    if (dropBusy.current || !messageIds.length) return;
    const ids = new Set(messageIds);
    const groups = new Map<string, { name: string; messageIds: number[] }>();
    for (const item of allItems) {
      if (!ids.has(item.id)) continue;
      const name = autoFolderName(item) || '未命名';
      const key = name.toLocaleLowerCase();
      const group = groups.get(key) || { name, messageIds: [] };
      group.messageIds.push(item.id);
      groups.set(key, group);
    }
    if (!groups.size) return;
    dropBusy.current = true;
    try {
      for (const group of groups.values()) {
        const existing = activeInboxFolders.find(folder => folder.name.trim().toLocaleLowerCase() === group.name.toLocaleLowerCase());
        let labelId = existing?.labelId;
        if (!labelId) {
          const created = await window.api.invoke('inbox:labelSave', {
            name: group.name,
            color: '#0f766e',
            idempotencyKey: crypto.randomUUID(),
          }) as { success: boolean; data?: InboxLabel; error?: string };
          if (!created?.success || !created.data?.labelId) throw new Error(created?.error || '文件夹创建失败');
          labelId = created.data.labelId;
        }
        for (const chunk of chunkIds(group.messageIds)) {
          const moved = await window.api.invoke('inbox:messageLabelsBatch', {
            messageIds: chunk,
            labelIds: [labelId],
            idempotencyKey: crypto.randomUUID(),
          }) as { success: boolean; error?: string };
          if (!moved?.success) throw new Error(moved?.error || '移动文件夹失败');
        }
      }
      refreshLabels();
      void invalidateDomain(qc, 'inbox');
      message.success(groups.size > 1 ? `已建立并放入 ${groups.size} 个文件夹` : '已建立文件夹并放入');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '文件夹创建失败');
    } finally {
      dropBusy.current = false;
    }
  };
  const runDropTarget = (target: InboxDropTarget, messageIds: number[]) => {
    if (target.kind === 'conversation') return applyConversationDrop(target, messageIds);
    if (target.kind === 'pin') return applyPinDrop(messageIds);
    if (target.kind === 'blank-folder') return applyBlankFolderDrop(messageIds);
    return applyFolderDrop(target, messageIds);
  };
  const beginMailDrag = (event: React.DragEvent, item: InboxItem) => {
    const ids = sel.has(item.id) && sel.size > 0 ? [...sel] : [item.id];
    if (!sel.has(item.id)) {
      setSel(new Set([item.id]));
      setSid(item.id);
      setLast(item.id);
    }
    dragMessageIds.current = ids;
    setDraggingCount(ids.length);
    setActiveDropTarget(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', ids.join(','));
    const frame = document.createElement('div');
    frame.className = 'inbox-drag-frame';
    frame.textContent = ids.length > 1 ? String(ids.length) : '';
    document.body.appendChild(frame);
    event.dataTransfer.setDragImage(frame, 9, 9);
    window.setTimeout(() => frame.remove(), 0);
  };
  const endMailDrag = () => {
    dragMessageIds.current = [];
    setDraggingCount(null);
    setActiveDropTarget(null);
  };
  const dropTargetProps = (target: InboxDropTarget) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragMessageIds.current.length) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      if (activeDropTarget !== target.key) setActiveDropTarget(target.key);
    },
    onDragLeave: (event: React.DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setActiveDropTarget(current => current === target.key ? null : current);
    },
    onDrop: (event: React.DragEvent) => {
      if (!dragMessageIds.current.length) return;
      event.preventDefault();
      event.stopPropagation();
      const ids = [...dragMessageIds.current];
      endMailDrag();
      void runDropTarget(target, ids);
    },
  });
  const dropClass = (target: InboxDropTarget) => `inbox-drop-target${activeDropTarget === target.key ? ' is-drop-active' : ''}`;
  const conversationDropTarget = (state: InboxConversationState, label: string): InboxDropTarget => ({ kind: 'conversation', key: `state:${state}`, state, label });
  const pinDropTarget: InboxDropTarget = { kind: 'pin', key: 'pin' };
  const blankFolderDropTarget: InboxDropTarget = { kind: 'blank-folder', key: 'folder:blank' };

  // ── 键盘选择层（实测缺口：选择只有鼠标三件套，Ctrl+A 被浏览器抢去「全选文字」，看着像坏了）──
  // Ctrl/Cmd+A 全选（虚拟列表按全量选，不只看得见的那几行）· Esc 清空 · ↑/↓ 移动并打开
  // （Shift 扩选）· Space 切换选中 · Delete 删除所选（走既有确认弹窗）。输入框/弹层内一律不劫持。
  const batchDelRef = useRef(batchDel);
  batchDelRef.current = batchDel;
  const kbRef = useRef({ items, sid, sel, last, groupMode: view === "sender" && !senderFilter });
  kbRef.current = { items, sid, sel, last, groupMode: view === "sender" && !senderFilter };

  const scrollRowIntoView = useCallback((idx: number) => {
    const el = listRef.current;
    if (!el) return;
    const top = idx * mailRowHeight;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + mailRowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + mailRowHeight - el.clientHeight;
  }, [mailRowHeight]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable
        || t.closest?.(".ant-modal-wrap, .ant-drawer, .ant-popover"))) return;
      const s = kbRef.current;
      if (s.groupMode) return;                 // 发信人分组视图没有邮件选择语义，不抢键
      const n = s.items.length;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "a" || e.key === "A")) {
        e.preventDefault();                    // 不给浏览器原生「全选文字」留机会
        setSel(new Set(s.items.map(i => i.id)));
        if (n) setLast(s.sid ?? s.items[0]!.id);
        return;
      }
      if (e.key === "Escape") { setSel(new Set()); setMenu(null); return; }
      if (e.key === "Delete" && s.sel.size) { e.preventDefault(); batchDelRef.current(); return; }
      if (e.key === " " && s.sid !== null) {
        e.preventDefault();
        const id = s.sid;
        setSel(prev => { const ns = new Set(prev); if (ns.has(id)) ns.delete(id); else ns.add(id); return ns; });
        return;
      }
      const movingDown = e.key === "ArrowDown" || e.key === "j" || e.key === "J";
      const movingUp = e.key === "ArrowUp" || e.key === "k" || e.key === "K";
      if ((movingDown || movingUp) && n) {
        e.preventDefault();
        const dir = movingDown ? 1 : -1;
        const cur = s.items.findIndex(i => i.id === s.sid);
        const next = cur < 0 ? 0 : Math.min(n - 1, Math.max(0, cur + dir));
        const it = s.items[next]!;
        if (e.shiftKey && s.sid !== null && cur >= 0) {
          const anchor = s.items.findIndex(i => i.id === (s.last ?? s.sid));
          const [f, tt] = anchor <= next ? [anchor, next] : [next, anchor];
          setSel(new Set(s.items.slice(Math.max(0, f), tt + 1).map(i => i.id)));
        } else {
          setSel(new Set([it.id]));
          setLast(it.id);
        }
        setSid(it.id);
        scrollRowIntoView(next);
        // 与点击同语义：打开即算已读
        readMut.mutate([it.id]);
        return;
      }
      if ((e.key === "r" || e.key === "R") && s.sid !== null) {
        const current = s.items.find(item => item.id === s.sid);
        if (current) {
          e.preventDefault();
          replyToMessage(current);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [replyToMessage, scrollRowIntoView]);

  // 左栏计数来自独立的全量汇总，不随当前分类、搜索或日期过滤缩水。
  const counts: Record<string, number> = { bounce: 0, replied: 0, autoreply: 0, sent: 0, other: 0 };
  if (inboxSummary) for (const key of Object.keys(counts)) counts[key] = inboxSummary.byClassification[key]?.total ?? 0;
  else dateScopedItems.forEach(i => { const t = i.classification || "other"; if (counts[t] !== undefined) counts[t]++; });
  const unreadCount = inboxSummary?.unread ?? dateScopedItems.filter(i => !i.isRead).length;
  const needsReplyCount = latestConversationItems.filter(inboxNeedsReply).length;
  const waitingOtherCount = latestConversationItems.filter(inboxWaitingOther).length;
  const followUpCount = latestConversationItems.filter(item => inboxNeedsFollowup(item, followupTaskSourceKeys, localFollowupMailIds)).length;
  // The analysis filters operate on every message (see matchesInboxAnalysisFilter),
  // so their counters must use the same set instead of latest-per-conversation.
  const analysisSource = dateScopedItems;
  const analysisCounts: Record<InboxAnalysisFilter, number> = {
    action: analysisSource.filter(item => matchesInboxAnalysisFilter(item, 'action')).length,
    important: analysisSource.filter(item => matchesInboxAnalysisFilter(item, 'important')).length,
  };
  const managementActive = analysisFilter ? `analysis:${analysisFilter}` : labelFilter !== null ? `label:${labelFilter}` : managementScope !== 'all' ? `scope:${managementScope}` : `filter:${filter}`;
  const applyAccount = (key: string | null) => {
    setAccountFilter(key);
    setManagementScope('all');
    setFilter('all');
    setAnalysisFilter(null);
    setLabelFilter(null);
    setSenderFilter(null);
  };
  const applyScope = (scope: InboxManagementScope) => {
    setManagementScope(scope);
    setFilter('all');
    setAnalysisFilter(null);
    setLabelFilter(null);
    if (scope === 'needs_reply' || scope === 'waiting_other') setView('flat');
    setSenderFilter(null);
  };
  const applyClassification = (classification: string) => {
    setManagementScope('all');
    setFilter(classification);
    setAnalysisFilter(null);
    setLabelFilter(null);
    setSenderFilter(null);
  };
  const applyAnalysis = (analysis: InboxAnalysisFilter) => {
    setManagementScope('all');
    setFilter('all');
    setLabelFilter(null);
    setAnalysisFilter(analysis);
    if (analysis === 'action') setView('flat');
    setSenderFilter(null);
  };
  const applyLabel = (labelId: number) => {
    setManagementScope('all');
    setFilter('all');
    setAnalysisFilter(null);
    setLabelFilter(labelId);
    setSenderFilter(null);
  };
  const refreshLabels = () => {
    void qc.invalidateQueries({ queryKey: ['inbox-labels'] });
    void invalidateDomain(qc, 'inbox');
  };
  const saveFolder = async (value: FolderEditorValue) => {
    if (!value.name.trim()) return;
    setLabelSaving(true);
    try {
      const response = await window.api.invoke('inbox:labelSave', {
        labelId: value.labelId,
        name: value.name.trim(),
        color: value.color,
        idempotencyKey: crypto.randomUUID(),
      }) as { success: boolean; error?: string };
      if (!response?.success) throw new Error(response?.error || '文件夹保存失败');
      setLabelEditor(null);
      setFolderCreatorOpen(false);
      refreshLabels();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '文件夹保存失败');
    } finally {
      setLabelSaving(false);
    }
  };
  const deleteLabel = (label: InboxLabel) => {
    Modal.confirm({
      title: `删除文件夹“${label.name}”？`,
      content: '邮件不会被删除，只会移除这个文件夹及其中关联。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        const response = await window.api.invoke('inbox:labelDelete', { labelId: label.labelId, idempotencyKey: crypto.randomUUID() }) as { success: boolean; error?: string };
        if (!response?.success) { message.error(response?.error || '文件夹删除失败'); return; }
        if (labelFilter === label.labelId) setLabelFilter(null);
        refreshLabels();
      },
    });
  };
  const confirmFolder = async (folder: InboxLabel) => {
    const response = await window.api.invoke('inbox:folderConfirm', { labelId: folder.labelId, idempotencyKey: crypto.randomUUID() }) as { success: boolean; error?: string };
    if (!response?.success) { message.error(response?.error || '文件夹确认失败'); return; }
    refreshLabels();
  };
  const togglePinned = async () => {
    if (!sel_) return;
    const nextPinned = !sel_._pinned;
    const response = await window.api.invoke('inbox:pinMessage', { messageId: sel_.id, pinned: nextPinned, idempotencyKey: crypto.randomUUID() }) as { success: boolean; error?: string };
    if (!response?.success) { message.error(response?.error || '邮件置顶失败'); return; }
    refreshLabels();
  };
  const toggleMessageLabel = async (labelId: number) => {
    if (!sel_) return;
    const current = sel_._labelIds || [];
    const next = current.includes(labelId) ? current.filter(id => id !== labelId) : [...current, labelId];
    const response = await window.api.invoke('inbox:messageLabels', { messageId: sel_.id, labelIds: next, idempotencyKey: crypto.randomUUID() }) as { success: boolean; error?: string };
    if (!response?.success) { message.error(response?.error || '邮件文件夹保存失败'); return; }
    refreshLabels();
  };
  const selectedType: MailTypeMeta = TYPE[sel_?.classification || "other"] ?? OTHER_MAIL_TYPE;
  const selectedLabels = (sel_?._labelIds || []).map(labelId => labelsById.get(labelId)).filter((label): label is InboxLabel => Boolean(label));
  const selectedThreadItems = useMemo(() => {
    const selected = allItems.find(item => item.id === sid);
    if (!selected) return [];
    const key = inboxConversationKey(selected);
    return allItems.filter(item => inboxConversationKey(item) === key).sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt));
  }, [allItems, sid]);

  // ── 渲染 ──

  return (
    <div className={`inbox-workspace prospector-inbox-page flex h-full${draggingCount !== null ? ' is-mail-dragging' : ''}`} data-fetch-progress-open={fetchProgressOpen ? "true" : "false"} style={{ height: "100%", minHeight: 0, overflow: "hidden" }} onClick={() => setMenu(null)}>

      <aside className="inbox-management-pane" aria-label="邮件管理">
        <div className="inbox-management-heading is-date"><InboxDateHeading value={inboxDate} filtering={!!dateFilter} counts={mailCountsByDate} onChange={value => { setInboxDate(value); setDateFilter(localDateKey(value)); }} onClear={() => setDateFilter(null)} /></div>
        <div className="inbox-management-scroll"
          onDragOver={event => {
            if (!dragMessageIds.current.length) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
          }}
          onDrop={event => {
            if (!dragMessageIds.current.length) return;
            event.preventDefault();
          }}>
          {accountGroups.length > 1 && <section className="inbox-management-section inbox-management-accounts">
            <h3><MailOutlined />收信账号</h3>
            <button type="button" title="全部账号" className={`inbox-management-item${accountFilter === null ? ' is-active' : ''}`} onClick={() => applyAccount(null)}>
              <InboxOutlined /><span>全部账号</span><em>{inboxSummary?.allTotal ?? allItems.length}</em>
            </button>
            {accountGroups.map(group => <button key={group.key || 'unnamed'} type="button" title={group.email} className={`inbox-management-item inbox-management-account${accountFilter === group.key ? ' is-active' : ''}`} onClick={() => applyAccount(group.key)}>
              <MailOutlined /><span>{group.email}</span><em title={`${group.unread} 封未读 · 共 ${group.total} 封`}>{group.unread > 0 ? `${group.unread}/${group.total}` : group.total}</em>
            </button>)}
          </section>}

          <section className="inbox-management-section">
            <button type="button" title="全部邮件" className={`inbox-management-item${managementActive === 'filter:all' ? ' is-active' : ''}`} onClick={() => { applyScope('all'); setFilter('all'); }}>
              <InboxOutlined /><span>全部邮件</span><em>{inboxSummary?.total ?? scopedItems.length}</em>
            </button>
            <button type="button" title="未读" className={`inbox-management-item${managementScope === 'unread' ? ' is-active' : ''}`} onClick={() => applyScope('unread')}>
              <EyeOutlined /><span>未读</span><em>{unreadCount}</em>
            </button>
            {FILTERS.filter(item => item.key !== 'all').map(item => <button key={item.key} type="button" title={item.label} className={`inbox-management-item${managementActive === `filter:${item.key}` ? ' is-active' : ''}`} onClick={() => applyClassification(item.key)}>
              <i className="inbox-management-dot" style={{ background: TYPE[item.key]?.dot || OTHER_MAIL_TYPE.dot }} /><span>{item.label}</span><em>{counts[item.key] ?? 0}</em>
            </button>)}
          </section>

          <section className="inbox-management-section">
            <button type="button" title="待办" className={`inbox-management-item ${dropClass(conversationDropTarget('todo', '待办'))}${analysisFilter === 'action' ? ' is-active' : ''}`} onClick={() => applyAnalysis('action')} {...dropTargetProps(conversationDropTarget('todo', '待办'))}>
              <CheckSquareOutlined /><span>待办</span><em>{analysisCounts.action}</em>
            </button>
            <button type="button" title="待我回复" className={`inbox-management-item ${dropClass(conversationDropTarget('needs_reply', '待我回复'))}${managementScope === 'needs_reply' ? ' is-active' : ''}`} onClick={() => applyScope('needs_reply')} {...dropTargetProps(conversationDropTarget('needs_reply', '待我回复'))}>
              <i className="inbox-management-dot" style={{ background: '#9a6700' }} /><span>待我回复</span><em>{needsReplyCount}</em>
            </button>
            <button type="button" title="等待对方" className={`inbox-management-item ${dropClass(conversationDropTarget('waiting_other', '等待对方'))}${managementScope === 'waiting_other' ? ' is-active' : ''}`} onClick={() => applyScope('waiting_other')} {...dropTargetProps(conversationDropTarget('waiting_other', '等待对方'))}>
              <i className="inbox-management-dot" style={{ background: '#2563eb' }} /><span>等待对方</span><em>{waitingOtherCount}</em>
            </button>
            <button type="button" title="待跟进" className={`inbox-management-item${managementScope === 'follow_up' ? ' is-active' : ''}`} onClick={() => applyScope('follow_up')}>
              <i className="inbox-management-dot" style={{ background: '#0f766e' }} /><span>待跟进</span><em>{followUpCount}</em>
            </button>
            <button type="button" title="需关注" className={`inbox-management-item ${dropClass(conversationDropTarget('important', '需关注'))}${analysisFilter === 'important' ? ' is-active' : ''}`} onClick={() => applyAnalysis('important')} {...dropTargetProps(conversationDropTarget('important', '需关注'))}>
              <i className="inbox-management-dot" style={{ background: '#c2413b' }} /><span>需关注</span><em>{analysisCounts.important}</em>
            </button>
          </section>

          <section className={`inbox-management-section inbox-folder-section ${dropClass(pinDropTarget)}`} {...dropTargetProps(pinDropTarget)}>
            <div className="inbox-folder-group-row">
              <button type="button" title="置顶邮件" className="inbox-folder-group-main" aria-expanded={pinnedFolderOpen} onClick={() => setPinnedFolderOpen(open => !open)}>
                <PushpinOutlined /><span>置顶邮件</span><em>{pinnedCount}</em>
              </button>
            </div>
            {pinnedFolderOpen && <div className="inbox-folder-children">
              {pinnedItems.length === 0 ? <div className="inbox-folder-empty">暂无置顶邮件</div> : pinnedItems.map(item => (
                <button key={item.id} type="button" className="inbox-folder-mail-row" title={item.subject || item.fromEmail} onClick={() => {
                  setManagementScope('all');
                  setFilter('all');
                  setAnalysisFilter(null);
                  setLabelFilter(null);
                  setView('flat');
                  setSenderFilter(null);
                  setSid(item.id);
                  setSel(new Set([item.id]));
                  setLast(item.id);
                }}>
                  <span>{item.subject || item.fromEmail}</span><em>{cleanListTime(item.receivedAt)}</em>
                </button>
              ))}
            </div>}
          </section>

          <section
            className={`inbox-management-section inbox-folder-section ${activeDropTarget === blankFolderDropTarget.key ? 'is-blank-drop-active' : ''}`}
            onDragOver={event => {
              if (!dragMessageIds.current.length) return;
              const target = event.target as Element;
              if (!(target instanceof Element) || target.closest('.inbox-folder-row, .inbox-ai-folder-suggestions, .inbox-folder-group-row, .inbox-folder-add')) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              if (activeDropTarget !== blankFolderDropTarget.key) setActiveDropTarget(blankFolderDropTarget.key);
            }}
            onDragLeave={event => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setActiveDropTarget(current => current === blankFolderDropTarget.key ? null : current);
            }}
            onDrop={event => {
              if (!dragMessageIds.current.length) return;
              const target = event.target as Element;
              if (!(target instanceof Element) || target.closest('.inbox-folder-row, .inbox-ai-folder-suggestions, .inbox-folder-group-row, .inbox-folder-add')) return;
              event.preventDefault();
              event.stopPropagation();
              const ids = [...dragMessageIds.current];
              endMailDrag();
              void applyBlankFolderDrop(ids);
            }}>
            <div className="inbox-folder-group-row">
              <button type="button" title="文件夹" className="inbox-folder-group-main" aria-expanded={foldersOpen} onClick={() => setFoldersOpen(open => !open)}>
                <FolderOpenOutlined /><span>文件夹</span><em>{activeInboxFolders.length}</em>
              </button>
              <Popover trigger="click" placement="rightTop" open={folderCreatorOpen} onOpenChange={open => { if (!labelSaving) setFolderCreatorOpen(open); }} content={<FolderEditorCard initial={{ name: '', color: '#2563eb' }} saving={labelSaving} onCancel={() => setFolderCreatorOpen(false)} onSave={value => void saveFolder(value)} />}>
                <button type="button" className="inbox-folder-add" title="新建文件夹" aria-label="新建文件夹"><PlusOutlined /></button>
              </Popover>
            </div>
            {foldersOpen && <div className="inbox-folder-children">
              {suggestedInboxFolders.length > 0 && <div className="inbox-ai-folder-suggestions">
                <div className="inbox-ai-folder-heading"><BulbOutlined /><strong>AI建议</strong><em>{suggestedInboxFolders.length}</em></div>
                {suggestedInboxFolders.map(label => {
                  const count = label.candidateCount ?? label.count;
                  return <div key={label.labelId} className="inbox-folder-row is-suggested">
                    <button type="button" title={label.name} className="inbox-folder-main" disabled>
                      <FolderOutlined style={{ color: label.color }} /><span>{label.name}</span><em>{count}</em>
                    </button>
                    <div className="inbox-folder-actions">
                      <button type="button" className="is-confirm" title="确认文件夹" aria-label={`确认文件夹 ${label.name}`} onClick={() => void confirmFolder(label)}><CheckOutlined /></button>
                      <button type="button" className="is-delete" title="删除建议" aria-label={`删除文件夹建议 ${label.name}`} onClick={() => deleteLabel(label)}><DeleteOutlined /></button>
                    </div>
                  </div>;
                })}
              </div>}
              {activeInboxFolders.length === 0 ? <div className="inbox-folder-empty">暂无文件夹</div> : activeInboxFolders.map(label => {
                const count = scopedLabelCounts.get(label.labelId) ?? label.count;
                const folderTarget: InboxDropTarget = { kind: 'folder', key: `folder:${label.labelId}`, labelId: label.labelId, name: label.name };
                return <div key={label.labelId} className={`inbox-folder-row ${dropClass(folderTarget)}${labelFilter === label.labelId ? ' is-active' : ''}`} {...dropTargetProps(folderTarget)}>
                  <button type="button" title={label.name} className="inbox-folder-main" onClick={() => applyLabel(label.labelId)}>
                    <FolderOutlined style={{ color: label.color }} /><span>{label.name}</span><em>{count}</em>
                  </button>
                  <Dropdown trigger={['click']} menu={{ items: [{ key: 'edit', label: '编辑' }, { key: 'delete', label: '删除', danger: true }], onClick: ({ key }) => key === 'edit' ? setLabelEditor({ labelId: label.labelId, name: label.name, color: label.color }) : deleteLabel(label) }}>
                    <button type="button" className="inbox-folder-menu" title="文件夹操作" aria-label={`${label.name} 操作`}><MoreOutlined /></button>
                  </Dropdown>
                </div>;
              })}
              <div className="inbox-folder-blank-drop" aria-hidden="true" />
            </div>}
          </section>
        </div>
      </aside>

      {/* ══ 左侧 ══ */}
      <div className="inbox-list-pane flex flex-col flex-shrink-0" style={{ width: "34%", minWidth: 380, maxWidth: 620, minHeight: 0, userSelect: "none", borderRight: "1px solid var(--workspace-line)" }}>

        {/* 顶部 */}
        <div className="inbox-action-bar">
          <Button size="small" onClick={syncRunning ? () => setFetchProgressOpen(true) : doFetch} disabled={!syncRunning && offline}
            title={syncRunning && !fetchProgressOpen ? "后台拉取中" : "拉取"}
            aria-label={syncRunning && !fetchProgressOpen ? "后台拉取中" : "拉取"}
            icon={<ReloadOutlined className={fetching ? "animate-spin" : ""} />} />
          <Input
            size="small"
            prefix={<SearchOutlined />}
            allowClear
            placeholder="搜索..." value={search} onChange={e => setSearch(e.target.value)}
          />
          {sel.size > 1 && <Button size="small" onClick={batchRead} title="Ctrl+A 全选 · ↑↓ 移动（Shift 扩选）· Space 切换选中">已读</Button>}
          {sel.size > 1 && <Button size="small" danger onClick={batchDel} title="已选 {n} 封 · Delete 键同样可删（有确认）· Esc 取消选择">删({sel.size})</Button>}
        </div>
        {routeCampaignId && <div className={`inbox-campaign-filter${campaignMailError ? ' is-error' : ''}`} role="status">
          <MailOutlined aria-hidden="true" />
          <span><strong>{campaignMailDetail?.campaign?.name || (campaignMailQuery.isLoading ? '正在读取任务邮件' : campaignMailError ? '任务邮件读取失败' : '任务邮件')}</strong>{routeCampaignStatus && <small>{CAMPAIGN_INBOX_STATUS_LABELS[routeCampaignStatus]}</small>}</span>
          <button type="button" onClick={() => { window.location.hash = '#/inbox'; }} aria-label="清除任务邮件筛选" title="清除任务邮件筛选"><CloseOutlined /></button>
        </div>}
        {/* 拉取进度弹窗 — 分账号详细显示 */}
        <Modal title="收取邮件" open={fetchProgressOpen} width={520} destroyOnHidden
          onCancel={() => setFetchProgressOpen(false)}
          maskClosable
          footer={<div className="flex items-center justify-between gap-4">
            <span className="min-w-0 truncate text-[12px] text-gray-500" title={syncRows.map(row => row.email).join("；")}>
              {syncRows.length === 1 ? syncRows[0]!.email : `${syncRows.length || 0} 个邮箱`}
            </span>
            <div className="flex shrink-0 gap-2">
              {syncRows.some(row => row.failed) && <Button onClick={() => { setFetchProgressOpen(false); void navigate({ to: "/settings" }); }}>检查账号</Button>}
              <Button onClick={() => setFetchProgressOpen(false)}>{syncRows.some(row => row.failed) ? "关闭" : "转入后台"}</Button>
            </div>
          </div>}>
          {(() => {
            const rows = syncRows;
            if (rows.length === 0) return <div className="py-8 text-center text-xs text-gray-400">正在启动收取...</div>;
            return <div>
              {rows.map(row => (
                <div key={row.accountId} className="flex gap-3 py-3" style={{ borderBottom: "1px solid var(--workspace-line)" }}>
                  <div className="flex shrink-0 items-center justify-center" style={{ width: 52, height: 52, borderRadius: 6, background: "#f3f0ea", color: "#74808b", fontSize: 25 }}>
                    <MailOutlined />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <div className="min-w-0 flex-1 truncate text-[13px] font-medium text-gray-800" title={row.subject || row.email}>
                        {row.subject || row.email}
                      </div>
                      <div className="shrink-0 text-[12px] tabular-nums text-gray-600">
                        {row.required > 0 ? `已拉取 ${row.current} / 共需拉取 ${row.required}` : "正在统计邮件"}
                      </div>
                    </div>
                    <Progress percent={row.required > 0 ? Math.min(100, Math.round(row.current / row.required * 100)) : 0}
                      showInfo={false} size="small" status={row.failed ? "exception" : "normal"}
                      strokeColor="#71879a" trailColor="#e7ebee" style={{ margin: "7px 0 4px" }} />
                    <div className={`flex items-center justify-between gap-3 text-[11px] ${row.failed ? "text-red-500" : "text-gray-400"}`}>
                      <span className="min-w-0 truncate">{row.message || `${row.phaseLabel} · 新增 ${row.newCount} 封`}</span>
                      <span className="shrink-0">{row.phaseLabel}</span>
                    </div>
                  </div>
                </div>
              ))}
              <div className="mt-3 flex items-center justify-between text-[11px] text-gray-400">
                <span>邮箱地址</span>
                <span>状态</span>
              </div>
              {rows.map(row => <div key={`account-${row.accountId}`} className="flex items-center justify-between gap-4 py-1.5 text-[12px]">
                <span className="min-w-0 truncate font-mono text-gray-600">{row.email}</span>
                <span className={row.failed ? "shrink-0 text-red-500" : "shrink-0 text-gray-500"}>{row.phaseLabel}</span>
              </div>)}
            </div>;
          })()}
        </Modal>

        <Modal title={labelEditor?.labelId ? '编辑文件夹' : '新建文件夹'} open={!!labelEditor} width={360} footer={null}
          onCancel={() => { if (!labelSaving) setLabelEditor(null); }}
          >
          {labelEditor && <FolderEditorCard key={labelEditor.labelId ?? 'new-modal'} initial={labelEditor} saving={labelSaving} onCancel={() => setLabelEditor(null)} onSave={value => void saveFolder(value)} />}
        </Modal>

        <Modal title="引用邮件给成员" open={emailReferenceOpen} width={420} footer={null} onCancel={() => setEmailReferenceOpen(false)}>
          {!selectedMailEvent ? <div className="inbox-folder-empty">该邮件尚未形成中心同步记录</div>
            : <EmailReferenceMemberPicker onChoose={(teamId, member) => {
              const referenceId = crypto.randomUUID();
              saveTeamEmailReference({
                teamId,
                memberUserId: member.userId,
                referenceId,
                createdAt: new Date().toISOString(),
                payload: {
                  messageKey: selectedMailEvent.messageKey,
                  subject: selectedMailEvent.subject || sel_?.subject || '无主题',
                  from: selectedMailEvent.fromEmail || sel_?.fromEmail || '',
                  to: selectedMailEvent.toEmails,
                  occurredAt: selectedMailEvent.occurredAt,
                  summary: selectedMailEvent.preview || sel_?.bodyPreview || undefined,
                  customerId: senderReference?.customerId ?? selectedMailEvent.customerId,
                  contactId: senderReference?.contactId ?? selectedMailEvent.contactId,
                },
              });
              setEmailReferenceOpen(false);
              window.location.hash = '#/team?section=overview';
            }} />}
        </Modal>

        {/* 待办使用专用队列，不显示邮件/联系人视图切换。 */}
        {!todoView && <div className="inbox-switch-bar">
          <div className="inbox-view-switch" role="tablist" aria-label="邮件视图">
            {[{ value: 'flat', label: '全部邮件' }, { value: 'sender', label: '联系人' }].map(option => <button key={option.value} type="button" role="tab"
              aria-selected={view === option.value}
              className={view === option.value ? 'is-active' : ''}
              onClick={() => { setView(option.value as 'flat' | 'sender'); setSenderFilter(null); }}>
              {option.label}
            </button>)}
          </div>
        </div>}

        {/* 联系人选中后的面包屑栏：让用户一眼看出当前查看的是哪段往来 */}
        {view === "sender" && senderFilter && (() => {
          const cur = senderGroups.find(g => g.email === senderFilter);
          const curName = cur?.name || senderFilter;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderBottom: "1px solid #e8e8e8", background: "#fafafa", flexShrink: 0 }}>
              <button onClick={() => setSenderFilter(null)}
                style={{ display: "flex", alignItems: "center", gap: 4, padding: "1px 7px", fontSize: 10, cursor: "pointer", border: "1px solid #e5e5e5", borderRadius: 5, background: "#fff", color: "#555", flexShrink: 0, transition: "all .12s" }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = "#2563eb"; (e.currentTarget as HTMLElement).style.color = "#2563eb"; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = "#e5e5e5"; (e.currentTarget as HTMLElement).style.color = "#555"; }}>
                ← 返回联系人
              </button>
              <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#1a1a1a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{curName}</span>
                {curName !== senderFilter && (
                  <span style={{ fontSize: 10, color: "#999", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{senderFilter}</span>
                )}
              </div>
            </div>
          );
        })()}

        {view === "sender" && senderFilter && (() => {
          const cur = senderGroups.find(g => g.email === senderFilter);
          if (!cur) return null;
          return (
            <div className={`inbox-contact-insight is-${cur.insight.tone}`}>
              <div className="inbox-contact-insight-top">
                <span className="inbox-contact-insight-state">{cur.insight.label}</span>
                <span className="inbox-contact-insight-count">{cur.count} 封 · {shortTime(cur.insight.latestAt)}</span>
              </div>
              <div className="inbox-contact-insight-summary" title={cur.insight.summary}>{cur.insight.summary}</div>
              {(cur.insight.nextAction || cur.insight.dueHint) && (
                <div className="inbox-contact-insight-next">
                  {cur.insight.nextAction || '建议查看这封邮件'}
                  {cur.insight.dueHint ? ` · ${cur.insight.dueHint}` : ''}
                </div>
              )}
            </div>
          );
        })()}

        {/* 退信删除：计数/弹窗/执行同一数据源（后端全库），所见即所删；删除前主进程先归档 */}
        {filter === "bounce" && (bounceStats?.count ?? 0) > 0 && (() => {
          const cnt = bounceStats!.count;
          const shown = bounceStats!.emails.slice(0, 6).join("、");
          return (
            <button onClick={() => { Modal.confirm({
              title: `确定删除这 ${cnt} 个被退联系人？`,
              content: (
                <div style={{ fontSize: 12, lineHeight: 1.7 }}>
                  <div>联系人及其往来记录一并删除，退信邮件保留。此操作不可撤销。</div>
                  <div style={{ color: "#888", wordBreak: "break-all" }}>{shown}{cnt > bounceStats!.emails.length ? ` …共 ${cnt} 人` : ""}</div>
                  <div style={{ color: "#888" }}>删除前先把被删者档案归档一份。</div>
                </div>
              ),
              okText: "删除", okType: "danger", cancelText: "取消", onOk: () => delBounceMut.mutate() }); }}
              style={{ width: "100%", padding: "4px 0", border: 0, fontSize: 10.5, fontWeight: 500, cursor: "pointer", color: "#fff", background: "#e5484d", flexShrink: 0 }}>一键删除被退联系人 ({cnt})</button>
          );
        })()}

        {todoView && <div className="inbox-todo-overview">
          <span><strong>{todoOpenIds.length}</strong> 项待处理</span>
          <button type="button" disabled={todoBatchMut.isPending || todoOpenIds.length === 0}
            onClick={() => todoBatchMut.mutate(todoOpenItems)}>
            <CheckOutlined />一键已处理
          </button>
        </div>}

        {/* 列表 */}
        <div ref={listRef} style={{ flex: 1, overflow: "auto" }}
          onScroll={e => {
            const top = e.currentTarget.scrollTop;
            const rowH = (view === "sender" && !senderFilter) ? SENDER_ROW_H : mailRowHeight;
            setScrollTop(prev => (Math.abs(prev - top) >= rowH ? top : prev));
          }}>
          {view === "sender" && !senderFilter ? (
            senderGroups.length === 0 ? (
              <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: "#ccc" }}>暂无邮件</div>
            ) : (
              <div style={{ height: senderGroups.length * SENDER_ROW_H, position: "relative" }}>
                {visibleSenders.map((g, idx) => {
                  const realIdx = senderStart + idx;
                  return (
                    <div key={g.email} onClick={() => setSenderFilter(g.email)}
                      className={`inbox-contact-row is-${g.insight.tone} ${g.unread > 0 ? 'is-unread' : 'is-read'}`}
                      style={{ position: "absolute", top: realIdx * SENDER_ROW_H, left: 0, right: 0, height: SENDER_ROW_H }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = "rgba(0,0,0,.015)"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                      <div className="inbox-contact-row-head">
                        <strong title={g.name || g.email}>{g.name || g.email}</strong>
                        <span className="inbox-contact-row-state">{g.insight.label}</span>
                        {g.unread > 0 && <span className="inbox-contact-row-unread"><i />{g.unread} 未读</span>}
                        <time>{shortTime(g.insight.latestAt)}</time>
                      </div>
                      <div className="inbox-contact-row-summary" title={g.insight.summary}>{g.insight.summary}</div>
                      <div className="inbox-contact-row-meta">
                        <span>{g.count} 封</span>
                        {g.insight.nextAction && <em title={g.insight.nextAction}>{g.insight.nextAction}</em>}
                      </div>
                      <div className="inbox-contact-row-signals" aria-hidden="true">
                        <span className={`is-${g.insight.tone}`} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )
          ) : view === "flat" ? (
            isLoading ? <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: "#ccc" }}>加载中...</div>
              : cleanRows.length === 0 ? <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: "#ccc" }}>{search ? "无匹配" : "暂无邮件"}</div>
                : <div style={{ height: cleanTotalHeight, position: "relative" }}>
                  {visibleCleanRows.map(row => row.kind === 'header' ? (
                    <button key={row.key} type="button" className={`inbox-clean-group-header${todoView ? ' inbox-todo-group-header' : ''}`}
                      aria-expanded={!collapsedCleanGroups.has(row.groupKey)}
                      style={{ position: "absolute", top: row.top, left: 0, right: 0, height: row.height }}
                      onClick={() => setCollapsedCleanGroups(current => {
                        const next = new Set(current);
                        if (next.has(row.groupKey)) next.delete(row.groupKey); else next.add(row.groupKey);
                        return next;
                      })}>
                      <span className="inbox-clean-group-toggle">
                        {collapsedCleanGroups.has(row.groupKey) ? <CaretRightOutlined /> : <CaretDownOutlined />}
                        <span>{row.label}</span>
                      </span>
                    </button>
                  ) : todoView ? (() => {
                    const i = row.item;
                    const analysis = i._analysis;
                    const done = i._todoState === 'done';
                    const priority = analysis?.priority ?? 'normal';
                    const action = analysis?.nextAction || i.subject || i.fromName || i.fromEmail;
                    return <div key={row.key}
                      onClick={e => click(e, i)}
                      onContextMenu={e => ctxMenu(e, i)}
                      className={`inbox-todo-row is-${priority}${done ? ' is-done' : ''}${i.id === sid ? ' is-active' : ''}${sel.has(i.id) ? ' is-selected' : ''}`}
                      style={{ position: 'absolute', top: row.top, left: 0, right: 0, height: row.height }}
                      title={`${action}${i.subject && i.subject !== action ? `\n${i.subject}` : ''}`}>
                      <div className="inbox-todo-copy">
                        <div className="inbox-todo-action-row">
                          <span className="inbox-todo-action">{action}</span>
                          <time>{shortTime(i.receivedAt)}</time>
                        </div>
                        <div className="inbox-todo-context">
                          <strong>{i.fromName || i.fromEmail}</strong>
                          {analysis?.dueHint && <span className="inbox-todo-due">{analysis.dueHint}</span>}
                        </div>
                        <div className="inbox-todo-meta">
                          {i._accountEmail && <span>{i._accountEmail}</span>}
                          {analysis && <span>{INBOX_ANALYSIS_CATEGORY_LABELS[analysis.category]}</span>}
                        </div>
                      </div>
                      <button type="button" className="inbox-todo-state" disabled={todoMut.isPending}
                        title={done ? '重新打开' : '标记已处理'}
                        aria-label={done ? '重新打开' : '标记已处理'}
                        onClick={event => { event.stopPropagation(); todoMut.mutate({ messageId: i.id, item: i, state: done ? 'open' : 'done', ...(done ? { feedback: '已重新打开' } : {}) }); }}>
                        {done ? <UndoOutlined /> : <CheckOutlined />}
                      </button>
                    </div>;
                  })() : (() => {
                    const i = row.item;
                    const t = TYPE[i.classification || "other"]!;
                    const isNew = !i.isRead;
                    const isSel = sel.has(i.id);
                    const isAct = i.id === sid;
                    return <div key={row.key}
                      onClick={e => click(e, i)}
                      onContextMenu={e => ctxMenu(e, i)}
                      draggable
                      onDragStart={event => beginMailDrag(event, i)}
                      onDragEnd={endMailDrag}
                      className={`inbox-clean-row${isNew ? " is-unread" : ""}${isAct ? " is-active" : ""}${isSel ? " is-selected" : ""}`}
                      style={{ position: "absolute", top: row.top, left: 0, right: 0, height: row.height }}
                      title={`${i.fromEmail} · ${i.subject || ''}`}
                    >
                      <div className="inbox-clean-copy">
                        <div className="inbox-clean-top">
                          <span className="inbox-clean-subject" title={i.subject || ''}>{i.subject || '(无主题)'}</span>
                          <time>{cleanListTime(i.receivedAt)}</time>
                        </div>
                        <span className="inbox-clean-email" title={i.fromEmail}>{i.fromEmail}</span>
                      </div>
                      {analysisFilter === 'action' && i._analysis?.requiresAction && i._todoState !== 'done' && (
                        <button type="button" className="inbox-clean-row-action" title="标记已处理"
                          disabled={todoMut.isPending}
                          onClick={event => { event.stopPropagation(); todoMut.mutate({ messageId: i.id, item: i, state: 'done' }); }}>
                          <CheckOutlined />
                        </button>
                      )}
                      {analysisFilter === 'important' && matchesInboxAnalysisFilter(i, 'important') && (
                        <button type="button" className="inbox-clean-row-action" title="加入待办" aria-label="加入待办"
                          disabled={todoMut.isPending}
                          onClick={event => { event.stopPropagation(); todoMut.mutate({ messageId: i.id, item: i, state: 'open', feedback: '已加入待办' }); }}>
                          <PlusOutlined />
                        </button>
                      )}
                    </div>;
                  })())}
                </div>
          ) : isLoading ? <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: "#ccc" }}>加载中...</div>
            : items.length === 0 ? <div style={{ textAlign: "center", padding: "40px 0", fontSize: 13, color: "#ccc" }}>{search ? "无匹配" : "暂无邮件"}</div>
              : (
                <div style={{ height: items.length * mailRowHeight, position: "relative" }}>
                  {visibleItems.map((i, idx) => {
                    const realIdx = startIdx + idx;
                    const t = TYPE[i.classification || "other"]!;
                const isNew = !i.isRead;
                const isSel = sel.has(i.id);
                const isAct = i.id === sid;
                const localAnalysis = i._analysis;
                const primaryText = analysisFilter === 'action' && localAnalysis?.status === 'ready' && localAnalysis.nextAction
                  ? localAnalysis.nextAction
                  : i.subject || i.fromName || i.fromEmail;
                return (
                  <div key={i.id}
                    onClick={e => click(e, i)}
                    onContextMenu={e => ctxMenu(e, i)}
                    draggable
                    onDragStart={event => beginMailDrag(event, i)}
                    onDragEnd={endMailDrag}
                    className={`inbox-mail-row${isNew ? " is-unread" : " is-read"}${isAct ? " is-active" : ""}${isSel ? " is-selected" : ""}`}
                    style={{ position: "absolute", top: realIdx * mailRowHeight, left: 0, right: 0, height: mailRowHeight }}
                  >
                    <div className="inbox-mail-copy">
                      <div className="inbox-mail-subject-row">
                        <span className="inbox-mail-subject" title={primaryText}>
                          {primaryText}
                        </span>
                        <time>{shortTime(i.receivedAt)}</time>
                      </div>
                      <div className="inbox-mail-sender-row">
                        <span className="inbox-mail-sender-name" title={i.fromName || i.fromEmail}>{i.fromName || i.fromEmail}</span>
                        <span className="inbox-mail-type-label" style={{ background: t.dot + "12", color: t.dot }}>{t.label}</span>
                      </div>
                      {/* 已匹配 + 联系人状态（始终显示） */}
                      {(() => {
                        const messageLabels = (i._labelIds || []).map(labelId => labelsById.get(labelId)).filter((label): label is InboxLabel => Boolean(label));
                        const hasAny = i.matchedContactId || i._centerContact || i._contactStatus || messageLabels.length > 0;
                        if (localAnalysis) {
                          const color = inboxLocalAnalysisColor(localAnalysis);
                          const parts = inboxAnalysisTagParts(inboxLocalAnalysisLabel(localAnalysis));
                          return <div className="inbox-mail-analysis-row" title={`${inboxLocalAnalysisLabel(localAnalysis)} · ${ANALYSIS_PRIORITY_LABELS[localAnalysis.priority]}`}>
                            <span className="inbox-mail-analysis-tag" style={{ borderLeftColor: color }}>
                              <i className="inbox-mail-analysis-ai">{inboxAnalysisSourceLabel(localAnalysis)}</i>
                              <strong>{parts.verdict}</strong>
                              {parts.category && <em>{parts.category}</em>}
                              {localAnalysis.status === 'ready' && localAnalysis.priority !== 'normal' && <b>{ANALYSIS_PRIORITY_LABELS[localAnalysis.priority]}</b>}
                            </span>
                          </div>;
                        }
                        const analysis = analysisByMessage[i.id];
                        if (analysis) {
                          const color = analysis.current.requiresAction && analysis.current.relevance === 'customer_business' ? '#8a5800' : '#6f7982';
                          const parts = inboxAnalysisTagParts(mailAnalysisListIndicator(analysis));
                          return <div className="inbox-mail-analysis-row" title={mailAnalysisListIndicator(analysis)}>
                            <span className="inbox-mail-analysis-tag" style={{ borderLeftColor: color }}>
                              <i className="inbox-mail-analysis-ai">AI</i>
                              <strong>{parts.verdict}</strong>
                              {parts.category && <em>{parts.category}</em>}
                            </span>
                          </div>;
                        }
                        if (!hasAny) return <div className="inbox-mail-analysis-row">{inboxListIndicator(i)}</div>;
                        return (
                          <div className="inbox-mail-analysis-row is-inline">
                            {(i.matchedContactId || i._centerContact) && <span>已匹配</span>}
                            {i._contactStatus && (
                              <>
                                <span style={{
                                  width: 5, height: 5, borderRadius: "50%", display: "inline-block",
                                  background: i._contactStatus === "replied" ? "#22a644" : i._contactStatus === "bounced" ? "#e5484d" : i._contactStatus === "autoreply" ? "#e6a817" : i._contactStatus === "reached" ? "#2563eb" : "#ccc",
                                }} />
                                <span>{i._contactStatus}</span>
                              </>
                            )}
                            {messageLabels.map(label => <span key={label.labelId} style={{ padding: '0 5px', borderRadius: 999, color: label.color, background: `${label.color}16` }}>{label.name}</span>)}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
                  })}
                </div>
              )}
        </div>
      </div>

      {!sel_ ? (
        <div className="inbox-reader-pane flex-1 flex flex-col overflow-hidden" style={{ minWidth: 0, minHeight: 0 }}>
          <div className="inbox-reader-empty flex-1 flex flex-col items-center justify-center">
            <MailOutlined style={{ fontSize: 32, marginBottom: 10 }} />
            {/* 原先左侧列表顶部那行计数条迁到这里：左栏少一行、多出一屏邮件 */}
            <div className="inbox-reader-empty-stats">
              <span>退信 {counts.bounce ?? 0}</span>
              <span>回复 {counts.replied ?? 0}</span>
              <span>已发送 {counts.sent ?? 0}</span>
              <span>自动回复 {counts.autoreply ?? 0}</span>
              <span>其他 {counts.other ?? 0}</span>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="inbox-reader-main flex-1 flex flex-col overflow-hidden" style={{ minWidth: 0, minHeight: 0 }}>
            {/* 邮件详情头部 */}
            <div className="inbox-detail-header selectable">
              <div className="inbox-detail-subject-row">
                <h2>{sel_.subject || "无主题"}</h2>
                <div className="inbox-detail-subject-actions">
                  <span className="inbox-detail-classification"><span style={{ background: selectedType.dot }} />{selectedType.label}</span>
                  {selectedLabels.map(label => <span key={label.labelId} className="inbox-detail-label-chip" style={{ color: label.color, background: `${label.color}16`, borderColor: `${label.color}35` }}>{label.name}</span>)}
                  {followupReference && sel_.classification === 'sent' && (selectedFollowupTask
                    ? <button type="button" className="inbox-detail-followup is-created" disabled={cancelFollowupTask.isPending} onClick={() => cancelFollowupTask.mutate()} title="取消已创建的 3 天跟进任务">{cancelFollowupTask.isPending ? '取消中…' : '取消跟进'}</button>
                    : <button type="button" className="inbox-detail-followup" disabled={createFollowupTask.isPending} onClick={() => createFollowupTask.mutate()} title="在现有跟进任务中创建跟进提醒">{createFollowupTask.isPending ? '创建中…' : inboxWaitingDays(sel_) >= FOLLOWUP_SUGGESTION_DAYS ? `等待 ${inboxWaitingDays(sel_)} 天 · 跟进` : '3天后跟进'}</button>)}
                  {inboxIsTodo(sel_) && sel_._todoState !== 'done' && <button type="button" className="inbox-detail-todo is-handled" disabled={todoMut.isPending} onClick={() => todoMut.mutate({ messageId: sel_.id, item: sel_, state: 'done' })}><CheckOutlined />已处理</button>}
                  {sel_._todoState === 'done' && <button type="button" className="inbox-detail-todo" disabled={todoMut.isPending} onClick={() => todoMut.mutate({ messageId: sel_.id, item: sel_, state: 'open', feedback: '已重新打开' })}><UndoOutlined />重新打开</button>}
                  {sel_._todoState !== 'open' && sel_._todoState !== 'done' && <button type="button" className="inbox-detail-todo" disabled={todoMut.isPending} onClick={() => todoMut.mutate({ messageId: sel_.id, item: sel_, state: 'open', feedback: '已加入待办' })}><PlusOutlined />加入待办</button>}
                  <button type="button" className={`inbox-detail-pin${sel_._pinned ? ' is-active' : ''}`} onClick={() => void togglePinned()} title={sel_._pinned ? '取消置顶' : '置顶邮件'}><PushpinOutlined />{sel_._pinned ? '已置顶' : '置顶'}</button>
                  <button type="button" className="inbox-detail-reply" disabled={!selectedMailEvent} onClick={() => setEmailReferenceOpen(true)} title={selectedMailEvent ? '引用这封邮件给团队成员' : '该邮件尚未形成中心同步记录'}><MailOutlined />引用</button>
                  <button type="button" className="inbox-detail-reply" onClick={() => replyToMessage(sel_)} title="回复邮件（R）"><MailOutlined />回复</button>
                  <Popover trigger="click" placement="bottomRight" content={<div className="inbox-label-picker">
                    {activeInboxFolders.length === 0 ? <div className="inbox-label-picker-empty">暂无文件夹</div> : activeInboxFolders.map(label => <label key={label.labelId}>
                      <input type="checkbox" checked={(sel_._labelIds || []).includes(label.labelId)} onChange={() => void toggleMessageLabel(label.labelId)} />
                      <i style={{ background: label.color }} />{label.name}
                    </label>)}
                    <button type="button" onClick={() => setLabelEditor({ name: '', color: '#2563eb' })}><PlusOutlined />新建文件夹</button>
                  </div>}>
                    <button type="button" className="inbox-detail-label-trigger"><FolderOutlined />文件夹</button>
                  </Popover>
                </div>
              </div>

              <div className="inbox-detail-sender-row">
                <span className="inbox-detail-label">发件人</span>
                <div className="inbox-detail-sender-copy">
                  <strong>{sel_.fromName || sel_.fromEmail}</strong>
                  {!!sel_.fromName && sel_.fromName !== sel_.fromEmail && <span>&lt;{sel_.fromEmail}&gt;</span>}
                </div>
                <Tooltip title="引用这封邮件，让 AI 起草回复" placement="top">
                  <button type="button" className="inbox-detail-ai" aria-label="引用邮件让 AI 起草回复"
                    onClick={() => askAssistant({ ctx: `message:${sel_.id}`, question: "根据这封邮件帮我起草一封回复，语气专业简洁" })}>
                    <DiamondLogo size={12} state="static" />
                  </button>
                </Tooltip>
                <time>{new Date(sel_.receivedAt).toLocaleString("zh-CN")}</time>
              </div>

              <div className="inbox-detail-meta-grid">
                <InboxDetailRow label="收件人" wide>{sel_.to || (sel_.classification === "sent" ? `${sel_.fromName || ""} <${sel_.fromEmail}>` : "—")}</InboxDetailRow>
                <InboxDetailRow label="抄送" wide>{sel_.cc || "—"}</InboxDetailRow>
                <InboxDetailRow label="账号">{(sel_ as InboxItem & { _accountEmail?: string })._accountEmail || "—"}</InboxDetailRow>
                <InboxDetailRow label="关联">
                  {senderContact
                    ? <button type="button" className="inbox-detail-link" onClick={() => openMatchedContact(senderContact)} title="点击打开联系人详情">{senderContact.company || "已匹配联系人"}</button>
                    : <span className="inbox-detail-empty">—</span>}
                  {senderContact && senderContact.canDelete !== false && <DeleteOutlined
                    style={{ fontSize: 11, color: "#ccc", cursor: "pointer", marginLeft: 6 }}
                    title="删除该联系人"
                    onClick={(event) => { event.stopPropagation(); confirmDeleteContact(senderContact); }}
                  />}
                </InboxDetailRow>
              </div>

              {(() => {
                const center = senderDetail.data?.ok ? senderDetail.data.data : undefined;
                const status = center ? centerContactDisplayStatus(center.contact) : sel_._contactStatus ?? null;
                const rawTags = center ? JSON.stringify(center.contact.relationshipStage && center.contact.relationshipStage !== 'cold' ? [center.contact.relationshipStage] : center.contact.tags) : sel_._contactTags || "[]";
                const tags: string[] = (() => { try { const t = JSON.parse(rawTags); return Array.isArray(t) ? t : []; } catch { return []; } })();
                const statusMeta = STATUS_META as Record<string, { label: string; color: string }>;
                const statusLabel = (s: string) => statusMeta[s]?.label || s;
                const statusDot: Record<string, string> = { replied: "#22a644", bounced: "#e5484d", autoreply: "#e6a817", reached: "#2563eb" };
                const statusItems = [{ key: "__clear__", label: <span style={{ color: "#999" }}>清除状态</span> }, ...Object.entries(statusMeta).filter(([key]) => !senderReference || key in CENTER_STATUS).map(([k, m]) => ({ key: k, label: m.label }))];
                const tagItems = [{ key: "__clear__", label: <span style={{ color: "#999" }}>清除标签</span> }, ...CRM_STAGES.map(s => ({ key: s.key, label: s.label }))];
                const editable = !!senderContact && !offline && !overwriteMut.isPending;
                const statusEditable = editable && (!senderReference || !isPermissionDenied(center?.canFollowup));
                const stageEditable = editable && (!senderReference || !isPermissionDenied(center?.permissions?.canChangeStage ?? center?.canFollowup));
                const pick = (field: "status" | "tags", key: string) => {
                  if (!senderContact) return;
                  const value = key === "__clear__" ? null : key;
                  if (field === "status" && (value ?? "") === (status || "")) return;
                  if (field === "tags" && (value === null ? tags.length === 0 : tags[0] === value)) return;
                  overwriteMut.mutate({ id: senderContact.id, email: senderContact.email, centerReference: senderContact.centerReference, field, value });
                };
                const statusValue = statusEditable
                  ? <Dropdown menu={{ items: statusItems, onClick: ({ key }) => pick("status", key) }} trigger={["click"]} placement="bottomLeft">
                      <button type="button" className="inbox-detail-inline-action" title="点击修改状态">
                        {status && <span className="inbox-detail-dot" style={{ background: statusDot[status] || "#ccc" }} />}
                        {status ? statusLabel(status) : "—"}
                      </button>
                    </Dropdown>
                  : <span className={status ? "inbox-detail-value-text" : "inbox-detail-empty"}>
                      {status && <span className="inbox-detail-dot" style={{ background: statusDot[status] || "#ccc" }} />}{status ? statusLabel(status) : "—"}
                    </span>;
                const tagValue = stageEditable
                  ? <Dropdown menu={{ items: tagItems, onClick: ({ key }) => pick("tags", key) }} trigger={["click"]} placement="bottomLeft">
                      <button type="button" className="inbox-detail-inline-action" title="点击修改标签">{tags.length ? tags.join(" · ") : "—"}</button>
                    </Dropdown>
                  : <span className={tags.length ? "inbox-detail-value-text" : "inbox-detail-empty"}>{tags.length ? tags.join(" · ") : "—"}</span>;
                return <div className="inbox-detail-meta-grid inbox-detail-meta-grid--pair">
                  <InboxDetailRow label="状态">{statusValue}</InboxDetailRow>
                  <InboxDetailRow label="标签">{tagValue}</InboxDetailRow>
                </div>;
              })()}
              {sel_._analysis && <section className="inbox-detail-collapsible inbox-analysis-section">
                <button type="button" className="inbox-detail-collapsible-heading" aria-expanded={analysisDetailOpen} onClick={() => setAnalysisDetailOpen(open => !open)}>
                  <strong style={{ color: '#27313b' }}>业务判断</strong>
                  <span style={{ color: inboxLocalAnalysisColor(sel_._analysis) }}>
                    {inboxAnalysisSourceLabel(sel_._analysis) !== 'AI' ? `${inboxAnalysisSourceLabel(sel_._analysis)} · ` : ''}
                    {inboxLocalAnalysisLabel(sel_._analysis)}
                  </span>
                  {sel_._analysis.status === 'ready' && <span style={{ marginLeft: 'auto', color: '#7d8790', fontSize: 10 }}>{inboxConfidenceLabel(sel_._analysis.confidence)}</span>}
                  {analysisDetailOpen ? <CaretDownOutlined className="inbox-detail-collapsible-caret" /> : <CaretRightOutlined className="inbox-detail-collapsible-caret" />}
                </button>
                {analysisDetailOpen && <div className="inbox-detail-collapsible-body">
                {sel_._analysis.status === 'pending' && <div style={{ color: '#8a939c' }}>正在分析这封邮件…</div>}
                {sel_._analysis.status === 'failed' && <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: '#c2413b' }}>{sel_._analysis.error || '分析失败'}</span>
                  <button type="button" className="inbox-detail-link" disabled={analysisRetryingId !== null}
                    onClick={() => void retryInboxAnalysis(sel_.id)}>
                    {analysisRetryingId === sel_.id ? '重试中…' : '重试'}
                  </button>
                </div>}
                {sel_._analysis.status === 'ready' && <>
                  <div style={{ color: '#27313b', lineHeight: 1.55 }}>{sel_._analysis.summary}</div>
                  {sel_._analysis.nextAction
                    ? <div><strong>待办：</strong>{sel_._analysis.nextAction}{sel_._analysis.dueHint ? ` · ${sel_._analysis.dueHint}` : ''}</div>
                    : <div style={{ color: '#7d8790' }}>参考邮件，暂不生成待办。</div>}
                  {sel_._analysis.confidence < 0.65 && <div style={{ color: '#a15c16' }}>依据不足，请打开原文核对后再处理。</div>}
                  {sel_._analysis.evidence.length > 0 && <div style={{ color: '#7d8790' }}>
                    依据：{sel_._analysis.evidence.slice(0, 2).map(item => `“${item}”`).join('；')}
                  </div>}
                </>}
                </div>}
              </section>}
            </div>
            <div className="detail-body" style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
              <div className="body-pane" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                {bl ? (
                  <div style={{ textAlign: "center", padding: "60px 0", color: "#ccc", fontSize: 13 }}>加载正文中...</div>
                ) : body ? (
                  <iframe className="body-iframe" style={{ flex: 1, minHeight: 0, width: "100%" }}
                    scrolling="auto" sandbox="allow-scripts"
                    srcDoc={bodyDoc}
                  />
                ) : (
                  <div className="body-preview selectable">{sel_.bodyPreview || "(无法加载正文)"}</div>
                )}
              </div>
            </div>
          </div>
          <aside className={`inbox-detail-context-sidebar${contextSidebarOpen && selectedThreadItems.length > 1 ? ' has-thread-stack' : ''}${contextSidebarOpen ? '' : ' is-collapsed'}`} aria-label="邮件上下文">
            <button type="button" className="inbox-context-collapse" aria-label={contextSidebarOpen ? '收起邮件上下文' : '展开邮件上下文'} aria-expanded={contextSidebarOpen} title={contextSidebarOpen ? '收起' : '展开'} onClick={() => setContextSidebarOpen(open => !open)}>
              <span className="inbox-context-collapse-glyph" aria-hidden="true">{contextSidebarOpen ? '›' : '‹'}</span>
            </button>
            {contextSidebarOpen && <>
            {selectedThreadItems.length > 1 && <section className="inbox-thread-stack" aria-label="切换会话">
              <button type="button" className="inbox-thread-heading inbox-detail-collapsible-heading" aria-expanded={threadStackOpen} onClick={() => setThreadStackOpen(open => !open)}>
                <strong>切换会话</strong><span>{selectedThreadItems.length} 封</span>
                {threadStackOpen ? <CaretDownOutlined className="inbox-detail-collapsible-caret" /> : <CaretRightOutlined className="inbox-detail-collapsible-caret" />}
              </button>
              {threadStackOpen && <div className="inbox-thread-list">
                {selectedThreadItems.map(item => {
                  const sent = item.classification === 'sent';
                  return <button key={item.id} type="button" className={`inbox-thread-row${item.id === sel_.id ? ' is-current' : ''}`}
                    onClick={() => { setSid(item.id); setSel(new Set([item.id])); setLast(item.id); readMut.mutate([item.id]); }}>
                    <span className={`inbox-thread-direction${sent ? ' is-sent' : ''}`}>{sent ? '我' : '来'}</span>
                    <span className="inbox-thread-copy"><strong>{sent ? (item.to || '我方发送') : (item.fromName || item.fromEmail)}</strong><small>{item.subject || '无主题'}</small></span>
                    <time>{shortTime(item.receivedAt)}</time>
                  </button>;
                })}
              </div>}
            </section>}
            {sel_._quoteCard && <div className="inbox-quote-dock"><InboxQuoteCardView card={sel_._quoteCard} onUpdated={() => { void qc.invalidateQueries({ queryKey: ['inbox'] }); void qc.invalidateQueries({ queryKey: ['inbox-analysis'] }); }} /></div>}
            {/* 联系人匹配栏 — 始终显示 */}

            {sid && (
              <div className="inbox-match-bar">
                <button type="button" className="inbox-match-heading inbox-detail-collapsible-heading" aria-expanded={contactMatchesOpen} onClick={() => setContactMatchesOpen(open => !open)}>
                  <strong>联系人与未匹配地址</strong>
                  {contactMatchesOpen ? <CaretDownOutlined className="inbox-detail-collapsible-caret" /> : <CaretRightOutlined className="inbox-detail-collapsible-caret" />}
                </button>
                {contactMatchesOpen && <div className="inbox-match-body">
                {/* 被退联系人：一键删除同源名单（红色段）——不依赖正文扫描，正文未加载也在 */}
                {bounceMatches.length > 0 && (
                  <div style={{ marginBottom: 4 }}>
                    <span style={{ fontSize: 10, color: "#e5484d", textTransform: "uppercase", letterSpacing: ".5px" }}>被退 {bounceMatches.length} 人</span>
                    {bounceMatches.map(c => (
                      <div key={`bm-${c.id}`} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 0", fontSize: 11 }}>
                        <span
                          onClick={() => openMatchedContact(c)}
                          style={{ color: "#1565c0", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "2px" }}
                          title="点击打开联系人详情"
                        >{c.email}</span>
                        <span style={{ color: "#ccc" }}>→</span>
                        <b>{c.companyName || "未知公司"}</b>
                        <DeleteOutlined
                          style={{ fontSize: 11, color: "#ccc", cursor: "pointer", marginLeft: 4 }}
                          title="删除该联系人"
                          onClick={(e) => { e.stopPropagation(); confirmDeleteContact(c); }}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {!matchReady ? (
                  <span style={{ fontSize: 10, color: contactMatchError ? "#d93025" : "#ccc" }}>{contactsLoading || bl ? "加载中..." : contactMatchError ? `联系人读取失败：${contactMatchError}` : "未提取"}</span>
                ) : (() => {
                  // 松口径扫描（正文里出现的在库地址：签名/抄送/被引用者都可能在）排除已入「被退」段的，避免两栏重复+误导
                  const bset = new Set(bounceMatches.map(b => b.id));
                  const others = matchedContacts.filter(c => !bset.has(c.id)
                    && !(senderContact && (senderContact.centerReference
                      ? c.centerReference?.contactId === senderContact.centerReference.contactId && c.centerReference.customerId === senderContact.centerReference.customerId
                      : c.id === senderContact.id)));
                  return (
                  <>
                    {others.length > 0 && (
                      <div style={{ marginBottom: unmatchedEmails.length > 0 ? 4 : 0 }}>
                        <span style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: ".5px" }}>邮件中的其他联系人 {others.length} 人</span>
                        {others.map((c, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 0", fontSize: 11 }}>
                            <span
                              onClick={() => openMatchedContact(c)}
                              style={{ color: "#1565c0", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: "2px" }}
                              title="点击打开联系人详情"
                            >{c.email}</span>
                            <span style={{ color: "#ccc" }}>→</span>
                            <b>{c.company || "未知公司"}</b>
                            {c.canDelete !== false && <DeleteOutlined
                              style={{ fontSize: 11, color: "#ccc", cursor: "pointer", marginLeft: 4 }}
                              title="删除该联系人"
                              onClick={(e) => { e.stopPropagation(); confirmDeleteContact(c); }}
                            />}
                          </div>
                        ))}
                      </div>
                    )}
                    {unmatchedEmails.length > 0 && (
                      <div>
                        <span style={{ fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: ".5px" }}>未匹配 {unmatchedEmails.length} 个邮箱 — 点击添加</span>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "2px 6px", marginTop: 2 }}>
                          {unmatchedEmails.slice(0, 10).map((e, i) => {
                            const company = guessCompanyFromEmail(e);
                            const senderEmail = sel_?.fromEmail.toLowerCase().trim();
                            const name = sel_ && e.toLowerCase().trim() === senderEmail
                              ? guessName(sel_.fromName)
                              : { firstName: "", lastName: "" };
                            return (
                              <Tooltip key={`${e}-${i}`} title={company ? `推测公司: ${company}` : "添加为联系人"}>
                                <span
                                  onClick={() => {
                                    const params = new URLSearchParams();
                                    params.set("view", "table");
                                    params.set("add", "1");
                                    if (sel_) params.set("inbox", String(sel_.id));
                                    params.set("email", e);
                                    if (company) params.set("company", company);
                                    if (name.firstName) params.set("firstName", name.firstName);
                                    if (name.lastName) params.set("lastName", name.lastName);
                                    window.location.hash = `#/customers?${params.toString()}`;
                                  }}
                                  style={{
                                    fontSize: 10, background: "#e8f4fd", padding: "1px 8px",
                                    borderRadius: 3, color: "#1565c0", cursor: "pointer",
                                    border: "1px solid #bbdefb", transition: "all .12s",
                                  }}
                                  onMouseEnter={t => {
                                    t.currentTarget.style.background = "#bbdefb";
                                    t.currentTarget.style.borderColor = "#90caf9";
                                  }}
                                  onMouseLeave={t => {
                                    t.currentTarget.style.background = "#e8f4fd";
                                    t.currentTarget.style.borderColor = "#bbdefb";
                                  }}
                                >+ {e}</span>
                              </Tooltip>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {others.length === 0 && unmatchedEmails.length === 0 && bounceMatches.length === 0 && (
                      <span style={{ fontSize: 10, color: "#ccc" }}>未提取</span>
                    )}
                  </>
                  );
                })()}
                </div>}
              </div>
            )}
            {selectedAnalysisQuery && <section className="inbox-analysis-dock" aria-label="邮件分析">
              <MailAnalysisPanel
                key={selectedMailEvent?.eventId}
                queryInput={selectedAnalysisQuery}
                onCurrent={rememberSelectedAnalysis}
              />
            </section>}
            </>}
              </aside>
        </>
      )}

      {/* 右键菜单 */}
      {menu && (
        <div className="ctx-menu" style={{ position: "fixed", zIndex: 50, left: menu.x, top: menu.y, minWidth: 168, maxHeight: "70vh", overflowY: "auto", background: "#fff", borderRadius: 6, padding: "4px 0", border: "1px solid #e5e5e5", boxShadow: "0 4px 16px rgba(0,0,0,.08)", fontSize: 12 }}>
          <div className="ctx-item" onClick={() => { replyToMessage(menu.item); setMenu(null); }}>回复</div>
          <div className="ctx-item" onClick={() => { void batchRead(); setMenu(null); }}>{sel.size > 1 ? `标为已读 (${sel.size})` : '标为已读'}</div>
          <div className="ctx-item" onClick={() => { void batchUnread(); setMenu(null); }}>{sel.size > 1 ? `标为未读 (${sel.size})` : '标为未读'}</div>
          <div className="ctx-item" onClick={() => { void batchPinSelected(!selectedAllPinned); setMenu(null); }}>{selectedAllPinned ? '取消置顶' : '置顶邮件'}</div>
          {sel.size === 1 && !inboxIsTodo(menu.item) && menu.item._todoState !== 'done' && <div className="ctx-item" onClick={() => { todoMut.mutate({ messageId: menu.item.id, item: menu.item, state: 'open', feedback: '已加入待办' }); setMenu(null); }}>加入待办</div>}
          {menu.item._conversationState && <div className="ctx-item" onClick={() => { void clearConversationState([menu.item.id]); setMenu(null); }}>移出当前分类</div>}
          {sel.size === 1 && inboxIsTodo(menu.item) && <div className="ctx-item" onClick={() => { todoMut.mutate({ messageId: menu.item.id, item: menu.item, state: 'done', feedback: '已处理，已从待办和待回复移除' }); setMenu(null); }}>标记待办已处理</div>}
          <div style={{ borderTop: "1px solid #eee", margin: "2px 0" }} />
          <div className="ctx-section-title">移动到文件夹</div>
          {activeInboxFolders.length === 0 ? <div className="ctx-empty">暂无文件夹</div> : activeInboxFolders.map(folder => (
            <div key={folder.labelId} className="ctx-item ctx-folder-item" onClick={() => { void batchMoveToFolder(folder.labelId); setMenu(null); }}>
              <span>{folder.name}</span><em>{scopedLabelCounts.get(folder.labelId) ?? folder.count}</em>
            </div>
          ))}
          {labelFilter !== null && <div className="ctx-item" onClick={() => { void batchMoveToFolder(null); setMenu(null); }}>移出当前文件夹</div>}
          <div style={{ borderTop: "1px solid #eee", margin: "2px 0" }} />
          <div className="ctx-section-title">邮件分类</div>
          {(["replied", "bounce", "autoreply", "sent", "other"] as const).filter(t => t !== (menu.item.classification || "other")).map(t => (
            <div key={t} className="ctx-item" onClick={() => { batchType(t); setMenu(null); }} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: TYPE[t]!.dot }} />设为 {TYPE[t]!.label}
            </div>
          ))}
          <div style={{ borderTop: "1px solid #eee", margin: "2px 0" }} />
          <div className="ctx-item" style={{ color: "#e5484d" }} onClick={() => { delMut.mutate([...sel]); setMenu(null); }}>
            {sel.size > 1 ? `删除选中 (${sel.size})` : "删除"}
          </div>
        </div>
      )}

      <Modal title="回复邮件" open={!!replyDraft} width={680} okText="发送" cancelText="取消" confirmLoading={replyBusy}
        onOk={() => void sendReply()} onCancel={() => { if (!replyBusy) setReplyDraft(null); }}>
        {replyDraft && <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[12px] text-gray-600">发件账号
              <Select value={replyDraft.accountId} options={replyAccounts.map(account => ({ value: account.accountId, label: account.email }))} onChange={value => setReplyDraft(current => current && { ...current, accountId: Number(value) })} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-gray-600">收件人
              <Input value={replyDraft.to} onChange={event => setReplyDraft(current => current && { ...current, to: event.target.value })} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1 text-[12px] text-gray-600">抄送
              <Input value={replyDraft.cc} placeholder="可选，逗号分隔" onChange={event => setReplyDraft(current => current && { ...current, cc: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-[12px] text-gray-600">主题
              <Input value={replyDraft.subject} onChange={event => setReplyDraft(current => current && { ...current, subject: event.target.value })} />
            </label>
          </div>
          <Input.TextArea value={replyDraft.body} autoSize={{ minRows: 10, maxRows: 22 }} placeholder="输入回复内容" onChange={event => setReplyDraft(current => current && { ...current, body: event.target.value })} />
          <Upload multiple beforeUpload={() => false} fileList={replyDraft.attachments}
            onChange={({ fileList }) => setReplyDraft(current => current && { ...current, attachments: fileList.slice(0, 10) })}>
            <Button size="small" icon={<PaperClipOutlined />}>添加附件</Button>
          </Upload>
        </div>}
      </Modal>

      {/* 右键菜单 hover 样式 */}
      <style>{`
        .ctx-item{padding:6px 12px;cursor:pointer;transition:background .1s}.ctx-item:hover{background:#f5f5f5}
        .ctx-section-title{padding:5px 12px 3px;color:#8a939c;font-size:10px}.ctx-empty{padding:3px 12px 6px;color:#a0a7ae;font-size:10px}
        .ctx-folder-item{display:flex;align-items:center;justify-content:space-between;gap:12px}.ctx-folder-item em{color:#8a939c;font-style:normal;font-variant-numeric:tabular-nums}
        .btn{border:1px solid #e5e5e5;border-radius:6px;background:#fff;cursor:pointer;transition:all .12s;display:flex;align-items:center}
        .btn:hover{background:#f5f5f5;border-color:#d5d5d5}
        .btn:active{background:#eee}
        .detail-body .ant-tabs-tabpane{overflow:visible!important}
        .body-pane{min-width:0;overflow:hidden!important}
        .body-iframe{width:100%!important;border:0!important;display:block!important}
        .body-preview{flex:1!important;padding:20px!important;font-size:14px!important;color:#555!important;white-space:pre-wrap!important;line-height:1.9!important;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;overflow-y:auto!important}
      `}</style>
    </div>
  );
}
