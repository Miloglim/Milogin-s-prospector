// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { InfoTab } from '../../src/renderer/components/ContactDetail';
import type { Contact } from '../../src/renderer/hooks/useContacts';

describe('contact field durable save', () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  afterEach(async () => { await act(async () => root.render(null)); });
  it('keeps the submitted text until persistence succeeds, and on failure retains it for retry', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let finish!: (result: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const contact = { id: 42, firstName: 'Original', tags: '[]', extra: '{}', dataSource: 'center' } as unknown as Contact;
    await act(async () => root.render(<InfoTab contact={contact} canEditField={field => field === 'firstName'} onSaveField={save} />));
    await act(async () => host.querySelector<HTMLButtonElement>('button:not(:disabled)')!.click());
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Submitted'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(save).toHaveBeenCalledWith('firstName', 'Submitted');
    expect(host.querySelector('input')?.value).toBe('Submitted');
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(save).toHaveBeenCalledTimes(1);
    await act(async () => finish(false));
    expect(host.querySelector('input')?.value).toBe('Submitted');
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(save).toHaveBeenCalledTimes(2);
    await act(async () => finish(true));
    expect(host.querySelector('input')).toBeNull();
  });
  it('retires the active field editor when its permission is removed and later restored', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const save = vi.fn();
    const contact = { id: 42, firstName: 'Original', tags: '[]', extra: '{}', dataSource: 'center' } as unknown as Contact;
    const render = async (editable: boolean) => act(async () => root.render(<InfoTab contact={contact} canEditField={field => editable && field === 'firstName'} onSaveField={save} />));
    await render(true);
    await act(async () => host.querySelector<HTMLButtonElement>('button:not(:disabled)')!.click());
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Stale draft'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await render(false);
    expect(host.querySelector('input')).toBeNull();
    expect(save).not.toHaveBeenCalled();
    await render(true);
    expect(host.querySelector('input')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('button:not(:disabled)')!.click());
    expect(host.querySelector('input')?.value).toBe('Original');
  });
});
