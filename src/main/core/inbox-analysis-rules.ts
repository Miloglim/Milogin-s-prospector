import type { InboxAnalysisCategory, InboxAnalysisPriority } from '../../shared/inbox';

export interface InboxRuleInput {
  fromEmail: string;
  subject: string | null;
  bodyPreview: string | null;
  classification: string | null;
  senderIsInternal?: boolean;
}

export interface InboxRuleResult {
  category: InboxAnalysisCategory;
  priority: InboxAnalysisPriority;
  requiresAction: boolean;
  summary: string;
  nextAction: string | null;
  dueHint: string | null;
  confidence: number;
  evidence: string[];
  source: 'rule';
}

const MARKETING_MARKERS = [
  'unsubscribe', 'opt out', 'newsletter', '退订', '取消订阅', '电子报', '促销', '限时优惠',
] as const;
const NOTIFICATION_MARKERS = [
  'verification code', 'security alert', 'login alert', 'password reset', 'sign-in code',
  '验证码', '安全提醒', '登录提醒', '密码重置', '登录验证',
] as const;
const INVOICE_MARKERS = [
  'invoice', 'receipt', 'statement', '账单', '发票', '对账单', '付款成功', 'payment received',
] as const;
const INVOICE_ACTION_MARKERS = ['overdue', 'unpaid', 'payment due', '逾期', '待支付', '未付款'] as const;
const RECRUITMENT_MARKERS = ['recruit', 'hiring', 'job opening', 'candidate', 'interview', '招聘', '职位', '面试'] as const;
const NOTIFICATION_SENDERS = ['noreply', 'donotreply', 'notification', 'notifications', 'alerts', 'system'] as const;
const RECRUITMENT_SENDERS = ['recruit', 'recruiting', 'career', 'careers', 'jobs', 'talent'] as const;
const RATE_UPDATE_MARKERS = [
  '运价', '运费', '报价', '价格', '船期', '舱位', '航线', '有效期', '船司', '截关',
  'price', 'rate', 'quotation', 'validity', 'valid until', 'pod', 'pol', 'nor',
] as const;
const INTERNAL_REQUEST_MARKERS = [
  '请回复', '请确认', '请报价', '请处理', '需要你', '麻烦你', 'please reply', 'please confirm', 'please quote', 'action required',
] as const;

function normalized(value: string | null): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function mailText(input: InboxRuleInput): string {
  return `${normalized(input.subject)}\n${normalized(input.bodyPreview)}`;
}

function senderLocalPart(email: string): string {
  return normalized(email).split('@')[0]?.replace(/[._-]+/g, '') ?? '';
}

function hasMarker(text: string, markers: readonly string[]): boolean {
  return markers.some(marker => text.includes(marker));
}

function senderMatches(localPart: string, markers: readonly string[]): boolean {
  return markers.some(marker => localPart.includes(marker));
}

function rule(
  input: InboxRuleInput,
  category: InboxAnalysisCategory,
  options: {
    priority?: InboxAnalysisPriority;
    requiresAction?: boolean;
    summary?: string;
    nextAction?: string | null;
    dueHint?: string | null;
    confidence?: number;
  } = {},
): InboxRuleResult {
  return {
    category,
    priority: options.priority ?? 'normal',
    requiresAction: options.requiresAction ?? false,
    summary: options.summary ?? input.subject?.trim() ?? '收到一封邮件',
    nextAction: options.nextAction ?? null,
    dueHint: options.dueHint ?? null,
    confidence: options.confidence ?? 0.97,
    evidence: [],
    source: 'rule',
  };
}

/** High-confidence local routing. Ambiguous mail falls through to the AI analyzer. */
export function classifyInboxByRule(input: InboxRuleInput): InboxRuleResult | null {
  if (input.classification === 'bounce') return rule(input, 'notification', {
    priority: 'important', requiresAction: true, summary: input.subject || '邮件退信',
    nextAction: '核对并修正联系人邮箱', dueHint: '同日内', confidence: 0.99,
  });
  if (input.classification === 'autoreply') return rule(input, 'notification', {
    summary: input.subject || '自动回复', confidence: 0.99,
  });

  const text = mailText(input);
  const sender = senderLocalPart(input.fromEmail);
  if (input.senderIsInternal && hasMarker(text, RATE_UPDATE_MARKERS) && !hasMarker(text, INTERNAL_REQUEST_MARKERS)) {
    return rule(input, 'rate_update', {
      summary: input.subject?.trim() || '同事发来的运价更新',
      confidence: 0.9,
    });
  }
  if (hasMarker(text, MARKETING_MARKERS)) return rule(input, 'marketing', {
    summary: input.subject || '推广或订阅邮件',
  });
  if ((senderMatches(sender, NOTIFICATION_SENDERS) && hasMarker(text, NOTIFICATION_MARKERS))
    || hasMarker(text, NOTIFICATION_MARKERS)) {
    return rule(input, 'notification', {
      priority: 'important', summary: input.subject || '系统通知',
    });
  }
  if (hasMarker(text, INVOICE_MARKERS)) {
    const requiresAction = hasMarker(text, INVOICE_ACTION_MARKERS);
    return rule(input, 'invoice', {
      priority: requiresAction ? 'important' : 'normal',
      requiresAction,
      summary: input.subject || '账单或付款通知',
      nextAction: requiresAction ? '核对账单并处理付款或争议' : null,
    });
  }
  if (senderMatches(sender, RECRUITMENT_SENDERS) && hasMarker(text, RECRUITMENT_MARKERS)) {
    return rule(input, 'recruitment', { summary: input.subject || '招聘或候选人邮件' });
  }
  return null;
}
