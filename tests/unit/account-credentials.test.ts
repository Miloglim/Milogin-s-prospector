import { describe, expect, it, vi } from 'vitest';
import { createDesktopSessionService } from '../../server/services/desktop-session';
import { createAdminService } from '../../server/services/admin';
import { success } from '../../server/core/crm';

function fixture() {
  const createSalesAccount = vi.fn(async () => success({ email: 'created@example.invalid' }));
  const mutate = vi.fn(async () => success(undefined));
  const hash = vi.fn(async () => 'synthetic-hash');
  const passwords = { hash, verify: async () => true };
  const tokens = { create: () => 'a'.repeat(43), hash: (value: string) => value };
  const clock = { now: () => 0 };
  const desktop = createDesktopSessionService({ createSalesAccount } as never, passwords, tokens, clock, 3600);
  const admin = createAdminService({ mutate } as never, {} as never, passwords, tokens, clock,
    { me: async () => success({ identityAdmin: true, email: 'admin@example.invalid' }) } as never);
  return { desktop, admin, createSalesAccount, mutate, hash };
}

describe('account creation character policy', () => {
  it.each(['abc!123', 'abc 123', '密码123456', 'abc123\n', '12345'])('rejects a new password before hashing: %j', async password => {
    const f = fixture();
    expect(await f.desktop.register({ email: 'new@example.invalid', password })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.hash).not.toHaveBeenCalled();
    expect(f.createSalesAccount).not.toHaveBeenCalled();
  });
  it.each(['中文@example.invalid', 'new @example.invalid', '.new@example.invalid', 'new..name@example.invalid', 'new@-example.invalid', 'new@example..invalid'])('rejects the same invalid email in self-registration and administrator creation: %s', async email => {
    const f = fixture();
    expect((await f.desktop.register({ email, password: 'Abc123' })).ok).toBe(false);
    expect((await f.admin.mutate('session', { action: 'user.create', email, role: 'sales', reason: 'test' })).ok).toBe(false);
    expect(f.hash).not.toHaveBeenCalled();
    expect(f.mutate).not.toHaveBeenCalled();
  });
  it.each(['New.Name+tag@example.invalid', "o'hara@example.invalid", 'first_last@sub.example.invalid'])('preserves valid ASCII email syntax: %s', async email => {
    const f = fixture();
    expect((await f.desktop.register({ email, password: 'Abc123' })).ok).toBe(true);
    expect(f.createSalesAccount).toHaveBeenCalledWith({ email: email.toLowerCase(), passwordHash: 'synthetic-hash', product: 'crm' });
    expect((await f.admin.mutate('session', { action: 'user.create', email, role: 'sales', reason: 'test' }, 'Abc123')).ok).toBe(true);
  });
});
