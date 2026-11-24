import type { InboxAnalysisCategory, InboxAnalysisPriority } from '../../shared/inbox';

export interface MockInboxAnalysisDraft {
  category: InboxAnalysisCategory;
  priority: InboxAnalysisPriority;
  requiresAction: boolean;
  summary: string;
  nextAction: string | null;
  dueHint: string | null;
  confidence: number;
  evidence: string[];
}

const MARKER = /\[MOCK:([a-z_]+)\]/i;

const DRAFTS: Record<string, MockInboxAnalysisDraft> = {
  quote_request: {
    category: 'quote_request', priority: 'important', requiresAction: true,
    summary: '客户在询问上海到鹿特丹的运价，货量和箱型尚未说明。',
    nextAction: '核对货量、箱型和出运日期后回复报价。', dueHint: '24 小时内', confidence: 0.92,
    evidence: ['Please quote Shanghai to Rotterdam'],
  },
  schedule_request: {
    category: 'schedule_request', priority: 'important', requiresAction: true,
    summary: '客户在确认下周船期和截关时间，需要回复可订舱位。',
    nextAction: '查询船期后回复可选船名和截关时间。', dueHint: '同日内', confidence: 0.9,
    evidence: ['Please confirm the sailing and cut-off'],
  },
  order_followup: {
    category: 'order_followup', priority: 'important', requiresAction: true,
    summary: '客户在跟进已有订单的进度，询问预计出运时间。',
    nextAction: '核对订单状态并回复客户预计时间。', dueHint: '24 小时内', confidence: 0.88,
    evidence: ['Any update on our booking?'],
  },
  complaint: {
    category: 'complaint', priority: 'urgent', requiresAction: true,
    summary: '客户投诉到港延误且未收到通知，情绪明显不满。',
    nextAction: '先确认延误原因和责任方，再给出处理时限。', dueHint: '立即处理', confidence: 0.95,
    evidence: ['We were not informed about the delay'],
  },
  cooperation: {
    category: 'cooperation', priority: 'normal', requiresAction: true,
    summary: '对方提出合作或代理合作意向，具体条款尚未展开。',
    nextAction: '了解合作范围和预期，再决定是否进入商务沟通。', dueHint: null, confidence: 0.82,
    evidence: ['We would like to explore cooperation'],
  },
  reply_needed: {
    category: 'reply_needed', priority: 'normal', requiresAction: true,
    summary: '对方提出了一个需要答复的问题，但未直接涉及报价或订单。',
    nextAction: '确认问题背景后回复对方。', dueHint: null, confidence: 0.8,
    evidence: ['Could you clarify this point?'],
  },
  internal_request: {
    category: 'reply_needed', priority: 'important', requiresAction: true,
    summary: '同事请你确认客户运价，属于内部协作请求。',
    nextAction: '核对价格后回复同事。', dueHint: '同日内', confidence: 0.9,
    evidence: ['请确认客户运价'],
  },
  no_action: {
    category: 'other', priority: 'normal', requiresAction: false,
    summary: '这是一封知会性质的邮件，没有明确需要处理的动作。',
    nextAction: null, dueHint: null, confidence: 0.78,
    evidence: ['For your information'],
  },
  rate_update: {
    category: 'rate_update', priority: 'normal', requiresAction: false,
    summary: '这是一封运价更新通知，覆盖范围和有效期已经写明，可按需查阅。',
    nextAction: null, dueHint: null, confidence: 0.88, evidence: ['FAK运价', '有效期'],
  },
  ambiguous: {
    category: 'other', priority: 'normal', requiresAction: false,
    summary: '邮件意图看起来不明确，可能是合作或普通咨询，需要进一步确认。',
    nextAction: null, dueHint: null, confidence: 0.4,
    evidence: ['Let us know what you think'],
  },
};

/** Deterministic development analyzer keyed by a [MOCK:<scenario>] subject marker. */
export function mockInboxAnalysis(userPrompt: string): MockInboxAnalysisDraft {
  const key = MARKER.exec(userPrompt)?.[1]?.toLowerCase() || '';
  return DRAFTS[key] ?? {
    category: 'other', priority: 'normal', requiresAction: false,
    summary: 'Mock 场景缺少分析配置，按无需处理返回。', nextAction: null, dueHint: null,
    confidence: 0.2, evidence: [],
  };
}

export const MOCK_INBOX_SCENARIOS = Object.freeze(Object.keys(DRAFTS));
