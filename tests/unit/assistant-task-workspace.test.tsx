// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AssistantTaskWorkspace } from '../../src/renderer/components/AssistantTaskWorkspace';
import type { AssistantReminder } from '../../src/shared/assistant';

const ids = [43, 47, 39, 41, 45];
function item(kind: 'mail' | 'task', id: number): AssistantReminder {
  return {
    reminderId: `queue:${kind}:${id}`,
    kind,
    title: `邮件 ${id}`,
    detail: `处理 ${id}`,
    target: `inbox:${id}`,
    priority: 2,
    source: 'rule',
    createdAt: '2026-11-23T08:00:00.000Z',
    facts: { messageId: id, subject: `邮件 ${id}`, items: kind === 'task' ? [{ id: `t-${id}`, title: `邮件 ${id}`, detail: '处理', target: `inbox:${id}` }] : undefined, total: kind === 'task' ? 1 : undefined },
  };
}
const items = [
  ...ids.slice(0, 4).map(id => item('mail', id)),
  ...ids.map(id => item('task', id)),
];

const noop = () => undefined;

describe('assistant task workspace source queue', () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function mount(list: AssistantReminder[] = items, onComplete: (item: AssistantReminder) => void = noop) {
    await act(async () => {
      root.render(<AssistantTaskWorkspace items={list} onOpen={noop} onDismiss={noop} onOpenTarget={noop} onSelectCandidate={noop} onComplete={onComplete} />);
      await new Promise(resolve => setTimeout(resolve, 20));
    });
  }
  function tab(label: string): HTMLButtonElement {
    return Array.from(host.querySelectorAll('button')).find(button => button.textContent?.startsWith(label)) as HTMLButtonElement;
  }
  function rows(): number {
    return host.querySelectorAll('aside [data-task-row]').length;
  }

  it('counts inbox todos separately and dedupes the all view by message', async () => {
    await mount();
    expect(tab('回复').textContent).toContain('4');
    expect(tab('待办').textContent).toContain('5');
    expect(rows()).toBe(5);
    await act(async () => { tab('待办').click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(rows()).toBe(5);
    await act(async () => { tab('回复').click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(rows()).toBe(4);
  });

  it('splits backlog from today by real received time and completes from the checkbox', async () => {
    const stale = item('mail', 51);
    stale.facts = { ...stale.facts, receivedAt: '2026-11-19T02:00:00.000Z' };
    const fresh = item('mail', 52);
    fresh.facts = { ...fresh.facts, receivedAt: new Date().toISOString() };
    const completed: string[] = [];
    await mount([stale, fresh], entry => completed.push(entry.reminderId));
    expect(host.textContent).toContain('逾期未处理');
    expect(host.textContent).toContain('今天');
    const boxes = Array.from(host.querySelectorAll<HTMLButtonElement>('aside [role="checkbox"]'));
    expect(boxes).toHaveLength(2);
    await act(async () => { boxes[0]!.click(); await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(completed).toEqual(['queue:mail:51']);
    expect(boxes[0]!.getAttribute('aria-checked')).toBe('true');
  });
});
