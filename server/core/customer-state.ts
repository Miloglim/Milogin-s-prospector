export const CUSTOMER_JOURNEY_STEPS = [
  { key: 'uncontacted', label: '未触达' },
  { key: 'contacted', label: '已触达' },
  { key: 'replied', label: '已回复' },
  { key: 'quoting', label: '询价/报价' },
  { key: 'negotiating', label: '试单/谈判' },
  { key: 'won_pending', label: '成交待确认' },
  { key: 'won', label: '已成交' },
] as const;

export type CustomerJourneyState = typeof CUSTOMER_JOURNEY_STEPS[number]['key'] | 'lost';

export interface CustomerJourneyFacts {
  status?: CustomerJourneyState | null;
  sourceLabel?: CustomerJourneyView['source'];
  relationshipStage?: string | null;
  touchStatuses?: ReadonlyArray<string | null | undefined>;
  aiDealPending?: boolean;
}

export interface CustomerJourneyStepView {
  key: typeof CUSTOMER_JOURNEY_STEPS[number]['key'];
  label: string;
  status: 'done' | 'current' | 'upcoming';
}

export interface CustomerJourneyView {
  state: CustomerJourneyState;
  label: string;
  source: 'AI 识别' | '关系阶段' | '联系记录' | '状态账本' | '人工记录' | '系统识别' | '导入';
  currentIndex: number;
  steps: CustomerJourneyStepView[];
  lost: boolean;
}

const LABELS: Record<CustomerJourneyState, string> = {
  uncontacted: '未触达',
  contacted: '已触达',
  replied: '已回复',
  quoting: '询价/报价',
  negotiating: '试单/谈判',
  won_pending: '成交待确认',
  won: '已成交',
  lost: '已流失',
};

function touched(statuses: ReadonlyArray<string | null | undefined>): boolean {
  return statuses.some(status => ['contacted', 'replied', 'autoreply'].includes(status ?? ''));
}

function replied(statuses: ReadonlyArray<string | null | undefined>): boolean {
  return statuses.includes('replied');
}

export function customerJourneyView(facts: CustomerJourneyFacts): CustomerJourneyView {
  const statuses = facts.touchStatuses ?? [];
  let state: CustomerJourneyState;
  let source: CustomerJourneyView['source'];
  if (facts.status) {
    state = facts.status;
    source = facts.sourceLabel ?? '状态账本';
  } else if (facts.aiDealPending) {
    state = 'won_pending';
    source = 'AI 识别';
  } else if (facts.relationshipStage === 'lost') {
    state = 'lost';
    source = '关系阶段';
  } else if (facts.relationshipStage === 'cooperating') {
    state = 'won';
    source = '关系阶段';
  } else if (facts.relationshipStage === 'trial') {
    state = 'negotiating';
    source = '关系阶段';
  } else if (facts.relationshipStage === 'quoting') {
    state = 'quoting';
    source = '关系阶段';
  } else if (replied(statuses)) {
    state = 'replied';
    source = '联系记录';
  } else if (facts.relationshipStage === 'reaching' || touched(statuses)) {
    state = 'contacted';
    source = '联系记录';
  } else {
    state = 'uncontacted';
    source = '联系记录';
  }
  const currentIndex = CUSTOMER_JOURNEY_STEPS.findIndex(step => step.key === state);
  return {
    state,
    label: LABELS[state],
    source,
    currentIndex,
    lost: state === 'lost',
    steps: CUSTOMER_JOURNEY_STEPS.map((step, index) => ({
      ...step,
      status: state === 'lost' ? 'upcoming' : index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming',
    })),
  };
}
