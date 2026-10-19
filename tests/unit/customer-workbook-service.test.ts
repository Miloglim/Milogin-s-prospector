import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createLeadService } from '../../server/services/leads';
import type { LeadRepository } from '../../server/core/leads';
const token = 'a'.repeat(43);
describe('B1 center request boundary', () => {
 it('keeps semantic row failures for individual receipts while rejecting forged request structure', async () => {
  const importWorkbook = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const service = createLeadService({ importWorkbook } as unknown as LeadRepository, { hash: () => 'hash', create: () => token });
  const input = { source: 'synthetic', sourceDetail: '', kind: 'operations', idempotencyKey: 'request', rows: [{ entity: 'customer', sourceRef: '', companyName: '', sheetName: 'customers', rowNumber: 2, rawRow: {} }] };
  expect((await service.importWorkbook(token, input)).ok).toBe(true);
  expect(importWorkbook).toHaveBeenCalledWith('hash', input);
  for (const bad of [{ ...input, ownerUserId: randomUUID() }, { ...input, kind: 'sales' }, { ...input, rows: [] }, { ...input, rows: Array(201).fill(input.rows[0]) }, { ...input, rows: [{ ...input.rows[0], rowNumber: 0 }] }, { ...input, rows: [{ ...input.rows[0], email: null }] }]) expect(await service.importWorkbook(token, bad)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  expect(await service.importWorkbook('invalid-token', input)).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  expect(importWorkbook).toHaveBeenCalledTimes(1);
 });
 it('allows a real empty contact set or name/phone contact without email, never an empty placeholder', async () => {
  const createCustomer = vi.fn().mockResolvedValue({ ok: true, data: {} });
  const service = createLeadService({ createCustomer } as unknown as LeadRepository, { hash: () => 'hash', create: () => token });
  const input = { companyName: 'Synthetic', source: 'test', sourceDetail: '', idempotencyKey: 'create', contacts: [], businessType: '代理', developmentRestriction: '不跟进', sourceCreatedAt: '2020-01-01' };
  expect((await service.createCustomer(token, input)).ok).toBe(true);
  expect((await service.createCustomer(token, { ...input, contacts: [{ email: '', phone: 'synthetic phone' }, { email: '', name: 'synthetic name' }] })).ok).toBe(true);
  expect(await service.createCustomer(token, { ...input, contacts: [{ email: '' }] })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  expect(await service.createCustomer(token, { ...input, sourceCreatedAt: 'not-a-date' })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  expect(await service.createCustomer(token, { ...input, contacts: [{ email: 'SAME@example.invalid' }, { email: 'same@example.invalid' }] })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  expect(createCustomer).toHaveBeenCalledTimes(2);
 });
});
