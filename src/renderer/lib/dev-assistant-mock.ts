import type { AssistantReminder } from '../../shared/assistant';

export const DEV_ASSISTANT_MOCK_KEY = 'prospector.dev-assistant-mock';
export const DEV_ASSISTANT_MOCK_EVENT = 'dev:assistant-mock-changed';

function storageKey(userId?: string | null): string {
  return userId ? `${DEV_ASSISTANT_MOCK_KEY}:${userId}` : DEV_ASSISTANT_MOCK_KEY;
}

const SENDERS = ['SANTOS 客户', 'BlueWave Logistics', 'Acme Trading', 'Nordwind GmbH', 'Pacific Rim', 'MSC 客户'];
const CUSTOMERS = ['Acme', 'Nordwind', 'MSC', 'SANTOS', 'BlueWave', 'Pacific Rim'];
const POL = ['Shanghai', 'Ningbo', 'Shenzhen', 'Qingdao'];
const POD = ['Santos', 'Hamburg', 'Los Angeles', 'Rotterdam', 'Jebel Ali'];
const CARRIERS = ['CMA', 'Maersk', 'MSC', 'COSCO', 'ONE'];
const CONTAINERS = ['40HQ', '20GP', '40GP', '40NOR'];
const TASKS = ['核对订单条款', '补一封跟进', '确认目的港费用', '更新客户等级', '安排样品寄送'];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function between(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function mail(index: number): AssistantReminder {
  const sender = pick(SENDERS);
  const waitedHours = between(2, 36);
  const subject = pick(['询价 40HQ 上海到 Santos', '想确认最近船期和目的港费用', '请更新一下报价有效期', '关于上周报价的确认']);
  const lastAction = pick(['想要目的港费用明细', '最后一条是价格确认', '在问最近船期', '希望今天给价']);
  return {
    reminderId: `mock-mail-${index}`,
    kind: 'mail',
    title: `客户在等回复：${sender}`,
    detail: `已等 ${waitedHours} 小时 · 询价 ${pick(CONTAINERS)} · ${lastAction}`,
    target: `inbox:mock-${index}`,
    priority: 1,
    source: 'ai',
    createdAt: new Date().toISOString(),
    facts: {
      messageId: 1000 + index,
      senderEmail: `buyer${index}@${sender.toLowerCase().replace(/[^a-z]/g, '') || 'customer'}.example.com`,
      customerName: sender,
      subject,
      waitedHours,
      lastAction,
      analysis: `客户在邮件里明确询问报价，等待 ${waitedHours} 小时。${lastAction}。建议先确认目的港费用，再给出可用船期。`,
      mailExcerpt: `Hi, we are looking for a ${pick(CONTAINERS)} quotation. Please advise the latest rate and destination charges.`,
    },
  };
}

function quote(index: number): AssistantReminder {
  const customer = pick(CUSTOMERS);
  const pol = pick(POL);
  const pod = pick(POD);
  const container = pick(CONTAINERS);
  const candidates = Array.from({ length: 3 }, (_, item) => ({
    id: `mock-quote-${index}-${item}`,
    carrier: CARRIERS[(index + item) % CARRIERS.length]!,
    pol,
    pod,
    containerType: container,
    price: between(900, 3200),
    currency: 'USD',
    validTo: '2026-11-30',
  }));
  const chosen = candidates[0]!;
  return {
    reminderId: `mock-quote-${index}`,
    kind: 'quote',
    title: `报价待你确认：${customer}`,
    detail: `${pol} → ${pod} · ${chosen.carrier} · ${container} · USD ${chosen.price}`,
    target: `inbox:mock-quote-${index}`,
    priority: 1,
    source: 'ai',
    createdAt: new Date().toISOString(),
    facts: {
      messageId: 2000 + index,
      quoteCaseId: `mock-case-${index}`,
      customerName: customer,
      customerEmail: `buyer${index}@${customer.toLowerCase().replace(/[^a-z]/g, '') || 'customer'}.example.com`,
      subject: `询价：${pol} → ${pod} ${container}`,
      analysis: `客户询价 ${pol} → ${pod} ${container}，Navigator 返回 ${candidates.length} 条匹配报价。`,
      mailExcerpt: `Please quote your best all-in rate for ${container} from ${pol} to ${pod}.`,
      pol,
      pod,
      carrier: chosen.carrier,
      containerType: container,
      selectedCandidateId: chosen.id,
      price: chosen.price,
      currency: 'USD',
      validTo: chosen.validTo,
      source: 'navigator',
      fieldSummary: [
        { label: '起运港', value: pol },
        { label: '目的港', value: pod },
        { label: '柜型', value: container },
        { label: '品名', value: 'General cargo' },
        { label: '贸易条款', value: 'FOB' },
      ],
      candidates,
    },
  };
}

function task(index: number): AssistantReminder {
  const count = between(1, 3);
  const items = Array.from({ length: count }, (_, item) => {
    const days = between(1, 5);
    const customer = pick(CUSTOMERS);
    return {
      id: `mock-task-${index}-${item}`,
      title: `待办：${pick(TASKS)}`,
      detail: `${days} 天前到期 · ${customer} · 还没有下一步`,
      target: `customers:mock-${index}-${item}:1`,
      meta: days > 0 ? `逾期 ${days} 天` : '今天到期',
    };
  });
  return {
    reminderId: `mock-task-${index}`,
    kind: 'task',
    title: `待办到期：${count} 项`,
    detail: `${count} 项已逾期 · 最早 ${items[0]!.detail.split(' · ')[0]}`,
    target: items[0]!.target,
    priority: 2,
    source: 'rule',
    createdAt: new Date().toISOString(),
    facts: { items, total: count, overdueCount: count, earliestDueAt: new Date().toISOString() },
  };
}

function followup(index: number): AssistantReminder {
  const count = between(1, 3);
  const items = Array.from({ length: count }, (_, item) => {
    const days = between(3, 18);
    return {
      id: `mock-followup-${index}-${item}`,
      title: `跟进停了 ${days} 天：${pick(CUSTOMERS)}`,
      detail: pick(['上次联系后没有下一步', '报价后客户没有回复', '样品寄出后没有跟进', '客户问过交期但没有下文']),
      target: `customers:mock-${index}-${item}:1`,
      meta: `停了 ${days} 天`,
    };
  });
  return {
    reminderId: `mock-followup-${index}`,
    kind: 'followup',
    title: `跟进停滞：${count} 个客户`,
    detail: `${items[0]!.meta} · ${items[0]!.title.replace(/^跟进停了 \d+ 天：/, '')}`,
    target: items[0]!.target,
    priority: 2,
    source: 'rule',
    createdAt: new Date().toISOString(),
    facts: { items, total: count, maxDays: Number(items[0]!.meta.replace(/\D/g, '')) || 0 },
  };
}

/** 开发端 Mock：先保证四种行动卡各一条，再随机补足到 count 条。 */
export function buildRandomAssistantMock(count = 10): AssistantReminder[] {
  const builders = [mail, quote, task, followup];
  const items: AssistantReminder[] = builders.map((build, index) => ({ ...build(index + 1), priority: 1 as const }));
  for (let index = items.length; index < count; index++) {
    const build = pick(builders);
    items.push({ ...build(index + 1), priority: Math.random() < 0.55 ? 2 : 3 });
  }
  return items.slice(0, Math.max(4, count));
}

export function readAssistantMock(userId?: string | null): AssistantReminder[] | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const parse = (raw: string | null): AssistantReminder[] | null => {
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) && parsed.length ? parsed as AssistantReminder[] : null;
    };
    const scoped = parse(localStorage.getItem(storageKey(userId)));
    if (scoped || !userId) return scoped;
    const legacy = parse(localStorage.getItem(DEV_ASSISTANT_MOCK_KEY));
    if (!legacy) return null;
    localStorage.setItem(storageKey(userId), JSON.stringify(legacy));
    localStorage.removeItem(DEV_ASSISTANT_MOCK_KEY);
    return legacy;
  } catch { /* 坏掉的开发数据当作没有 Mock */ return null; }
}

export function saveAssistantMock(items: readonly AssistantReminder[], userId?: string | null): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(items));
    window.dispatchEvent(new Event(DEV_ASSISTANT_MOCK_EVENT));
  } catch { /* 存不进去就保持现有页面状态 */ }
}

export function clearAssistantMock(userId?: string | null): void {
  try {
    localStorage.removeItem(storageKey(userId));
    localStorage.removeItem(DEV_ASSISTANT_MOCK_KEY);
    window.dispatchEvent(new Event(DEV_ASSISTANT_MOCK_EVENT));
  } catch { /* 清不掉时下次刷新会再试 */ }
}
