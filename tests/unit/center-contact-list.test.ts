import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { createLeadService } from '../../server/services/leads';
import { createCrmHandler } from '../../server/transport/crm-http';
import { createOnlineCrmService } from '../../src/main/services/online-crm.service';
import { createOfflineCrmService } from '../../src/main/services/offline-crm.service';
import { emptyOfflineCrmState, type OfflineCrmContext } from '../../src/main/core/offline-crm';
import { failure, success } from '../../server/core/crm';

const token = 'a'.repeat(43);
const query = { search: 'name & 100%', limit: 50, offset: 0, stage: 'f2', status: 'replied', tags: 'quoting', country: 'Brazil', clientType: 'agent', language: 'PT', touchStatus: 'contacted' as const };
const page = { items: [], total: 0 };
const repository = () => ({ listContacts: vi.fn(async () => success(page)) });
const tokens = { hash: (value: string) => `hash:${value}` };

describe('authorized center contact list contracts', () => {
  it('uses the unified local read port after contract validation without issuing a center page request', async () => {
    const contacts = vi.fn(async () => success(page)), request = vi.fn();
    const service = createOnlineCrmService({ contacts, request } as never);
    expect(await service.contacts(query)).toEqual(success(page)); expect(contacts).toHaveBeenCalledWith(query); expect(request).not.toHaveBeenCalled();
    expect(await service.contacts({ ...query, ownerUserId: 'another-user' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } }); expect(contacts).toHaveBeenCalledTimes(1);
  });
  it('validates pagination and filters before querying and rejects user-supplied ownership', async () => {
    const repo = repository();
    const service = createLeadService(repo as never, tokens as never);
    expect(await service.contacts(token, query)).toEqual(success(page));
    expect(repo.listContacts).toHaveBeenCalledWith(`hash:${token}`, query);
    for (const invalid of [{ ...query, limit: 0 }, { ...query, offset: -1 }, { ...query, limit: 101 }, { ...query, country: [] }, { ...query, touchStatus: 'invalid' }, { ...query, userId: 'another-account' }]) {
      expect(await service.contacts(token, invalid)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(await service.contacts('', query)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(repo.listContacts).toHaveBeenCalledTimes(1);
  });

  it('exposes the same validated query through real HTTP, never treating it as a customer summary', async () => {
    const repo = repository();
    const handler = createCrmHandler(createLeadService(repo as never, tokens as never));
    const server = createServer((request, response) => { void handler(request, response); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const parameters = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
      const base = `http://127.0.0.1:${address.port}/api/crm/contacts`;
      const response = await fetch(`${base}?${parameters}`, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(success(page));
      expect(repo.listContacts).toHaveBeenCalledWith(`hash:${token}`, query);
      const forbiddenParameter = await fetch(`${base}?userId=another`, { headers: { Authorization: `Bearer ${token}` } });
      expect(forbiddenParameter.status).toBe(400);
      const repeatedFilter = await fetch(`${base}?country=Brazil&country=Mexico`, { headers: { Authorization: `Bearer ${token}` } });
      expect(repeatedFilter.status).toBe(400);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('uses the existing authenticated/synchronized request port, with literal filter encoding', async () => {
    const request = vi.fn(async (_method: string, _path: string) => success(page));
    const service = createOnlineCrmService({ request, login: vi.fn(), logout: vi.fn(), preview: vi.fn(), feed: vi.fn() });
    expect(await service.contacts(query)).toEqual(success(page));
    const [method, path] = request.mock.calls[0]!;
    expect(method).toBe('GET');
    const url = new URL(path as string, 'http://fixture');
    expect(url.pathname).toBe('/api/crm/contacts');
    for (const [key, value] of Object.entries(query)) expect(url.searchParams.get(key)).toBe(String(value));
    expect(await service.contacts({ ...query, limit: 0 })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retains only the loaded query snapshot offline and clears it when permission changes', async () => {
    let state = emptyOfflineCrmState('original-permission');
    const store = { load: () => structuredClone(state), save: (_ctx: OfflineCrmContext, next: typeof state) => { state = structuredClone(next); } };
    const sync = () => createOfflineCrmService(store, () => 'operation', () => new Date().toISOString());
    const context: OfflineCrmContext = { userId: 'account-one', baseUrl: 'http://127.0.0.1:55844', permissionKey: 'original-permission', active: () => true, online: () => true };
    const network = vi.fn(async (method: string, path: string) => path.startsWith('/api/crm/contacts?') ? success(page) : failure('UNAVAILABLE', 'synthetic connection unavailable'));
    const path = '/api/crm/contacts?search=&limit=50&offset=0';
    expect(await sync().request(context, 'GET', path, undefined, network as never)).toEqual(success(page));
    const offline = { ...context, online: () => false };
    const unreachable = vi.fn(async () => failure('UNAVAILABLE', 'offline'));
    expect(await sync().request(offline, 'GET', path, undefined, unreachable)).toEqual(success(page));
    expect(await sync().request(offline, 'GET', path.replace('offset=0', 'offset=50'), undefined, unreachable)).toMatchObject({ ok: false });
    expect(await sync().request({ ...offline, permissionKey: 'changed-permission' }, 'GET', path, undefined, unreachable)).toMatchObject({ ok: false });
    expect(await sync().request({ ...offline, active: () => false }, 'GET', path, undefined, unreachable)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
    expect(unreachable).not.toHaveBeenCalled();
  });
});
