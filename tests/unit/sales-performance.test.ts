import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { success } from '../../server/core/crm';
import {
  CUSTOMER_GRADE_THRESHOLDS,
  customerGradeScopeFor,
  customerGradeFor,
  durationMetric,
  salesPerformanceScopeFor,
  salesRateMetric,
  type SalesPerformanceRepository,
} from '../../server/core/sales-performance';
import { createSalesPerformanceService } from '../../server/services/sales-performance';
import { createSalesPerformanceHandler } from '../../server/transport/sales-performance-http';

const TOKEN = 'a'.repeat(43);
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
const TEAM_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const BATCH_ID = '44444444-4444-4444-8444-444444444444';
const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-02-01T00:00:00.000Z';

function repository(): SalesPerformanceRepository {
  return {
    performance: vi.fn(async () => success({} as never)),
    customerGrades: vi.fn(async () => success({} as never)),
    setCustomerGradeOverride: vi.fn(async () => success({} as never)),
    clearCustomerGradeOverride: vi.fn(async () => success({} as never)),
  };
}

describe('CP7 sales performance core', () => {
  it('calculates interpolated median and P90 with an explicit sample gate', () => {
    expect(durationMetric([10, 20, 30, 40])).toMatchObject({
      sampleCount: 4, minimumSampleSize: 5, sufficient: false,
      medianSeconds: 25, p90Seconds: 37,
    });
    expect(durationMetric([10, 20, 30, 40, 50])).toMatchObject({
      sampleCount: 5, sufficient: true, medianSeconds: 30, p90Seconds: 46,
    });
  });

  it('keeps rates unclaimed when the denominator is too small', () => {
    expect(salesRateMetric(1, 2)).toMatchObject({ rate: 0.5, sampleCount: 2, sufficient: false });
    expect(salesRateMetric(0, 0)).toMatchObject({ rate: null, sampleCount: 0, sufficient: false });
  });

  it('derives A/B/C grades from the fixed thresholds', () => {
    expect(customerGradeFor({ wonOpportunityCount: CUSTOMER_GRADE_THRESHOLDS.gradeAWonOpportunities, validReplyCount: 0, repeatPurchaseCount: 0, openOpportunityCount: 0 }))
      .toEqual({ grade: 'A', reasons: ['won_opportunity'] });
    expect(customerGradeFor({ wonOpportunityCount: 0, validReplyCount: 3, repeatPurchaseCount: 0, openOpportunityCount: 0 }))
      .toEqual({ grade: 'A', reasons: ['three_valid_replies'] });
    expect(customerGradeFor({ wonOpportunityCount: 0, validReplyCount: 1, repeatPurchaseCount: 0, openOpportunityCount: 0 }))
      .toEqual({ grade: 'B', reasons: ['valid_reply'] });
    expect(customerGradeFor({ wonOpportunityCount: 0, validReplyCount: 0, repeatPurchaseCount: 0, openOpportunityCount: 1 }))
      .toEqual({ grade: 'B', reasons: ['open_opportunity'] });
    expect(customerGradeFor({ wonOpportunityCount: 0, validReplyCount: 0, repeatPurchaseCount: 0, openOpportunityCount: 0 }))
      .toEqual({ grade: 'C', reasons: ['insufficient_customer_signal'] });
  });

  it('restricts aggregate performance to administrators and above', () => {
    expect(salesPerformanceScopeFor({ identityAdmin: true, roles: ['sales'], isLeader: true })).toBe('superadmin');
    expect(salesPerformanceScopeFor({ identityAdmin: false, roles: ['operations', 'sales'], isLeader: false })).toBe('operations');
    expect(salesPerformanceScopeFor({ identityAdmin: false, roles: ['sales'], isLeader: true })).toBeNull();
    expect(salesPerformanceScopeFor({ identityAdmin: false, roles: ['sales'], isLeader: false })).toBeNull();
    expect(salesPerformanceScopeFor({ identityAdmin: false, roles: ['auditor'], isLeader: false })).toBeNull();
  });

  it('keeps customer-grade scope available to sales while performance is closed', () => {
    expect(customerGradeScopeFor({ identityAdmin: false, roles: ['sales'], isLeader: true })).toBe('leader');
    expect(customerGradeScopeFor({ identityAdmin: false, roles: ['sales'], isLeader: false })).toBe('self');
  });
});

describe('CP7 sales performance service', () => {
  it('normalizes the default window and forwards bounded strata', async () => {
    const repo = repository();
    const service = createSalesPerformanceService(repo, { hash: value => value.padEnd(64, '0'), create: () => TOKEN }, { now: () => Date.parse(TO) });
    const result = await service.performance(TOKEN, { groupBy: 'country', country: 'CN', limit: 10, offset: 20 });
    expect(result.ok).toBe(true);
    expect(repo.performance).toHaveBeenCalledWith(TOKEN.padEnd(64, '0'), expect.objectContaining({
      to: TO, groupBy: 'country', country: 'CN', limit: 10, offset: 20,
    }));
    const parsed = vi.mocked(repo.performance).mock.calls[0]![1];
    expect(Date.parse(parsed.from)).toBeLessThan(Date.parse(parsed.to));
  });

  it('rejects malformed windows, pagination and overrides before repository calls', async () => {
    const repo = repository();
    const service = createSalesPerformanceService(repo, { hash: value => value.padEnd(64, '0'), create: () => TOKEN }, { now: () => Date.parse(TO) });
    expect(await service.performance(TOKEN, { from: TO, to: FROM, groupBy: 'lead', limit: 25, offset: 0 }))
      .toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await service.performance(TOKEN, { from: FROM, to: TO, groupBy: 'source', batchId: 'bad', limit: 25, offset: 0 }))
      .toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await service.customerGrades(TOKEN, { from: FROM, to: TO, limit: 101, offset: 0 }))
      .toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await service.setCustomerGradeOverride(TOKEN, CUSTOMER_ID, { expectedVersion: 0, grade: 'D', reason: 'manual', idempotencyKey: 'grade:1' }))
      .toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(repo.performance).not.toHaveBeenCalled();
    expect(repo.customerGrades).not.toHaveBeenCalled();
    expect(repo.setCustomerGradeOverride).not.toHaveBeenCalled();
  });

  it('forwards valid filters and override audit data', async () => {
    const repo = repository();
    const service = createSalesPerformanceService(repo, { hash: value => value.padEnd(64, '0'), create: () => TOKEN }, { now: () => Date.parse(TO) });
    await service.performance(TOKEN, { from: FROM, to: TO, groupBy: 'lead', teamId: TEAM_ID, memberUserId: MEMBER_ID, batchId: BATCH_ID, limit: 20, offset: 5 });
    expect(repo.performance).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ teamId: TEAM_ID, memberUserId: MEMBER_ID, batchId: BATCH_ID }));
    await service.setCustomerGradeOverride(TOKEN, CUSTOMER_ID, { expectedVersion: 0, grade: 'A', reason: 'Strategic account', idempotencyKey: 'grade:set:1' });
    expect(repo.setCustomerGradeOverride).toHaveBeenCalledWith(expect.any(String), {
      customerId: CUSTOMER_ID, expectedVersion: 0, grade: 'A', reason: 'Strategic account', idempotencyKey: 'grade:set:1',
    });
    await service.clearCustomerGradeOverride(TOKEN, CUSTOMER_ID, { expectedVersion: 1, reason: 'Back to computed grade', idempotencyKey: 'grade:clear:1' });
    expect(repo.clearCustomerGradeOverride).toHaveBeenCalledWith(expect.any(String), {
      customerId: CUSTOMER_ID, expectedVersion: 1, reason: 'Back to computed grade', idempotencyKey: 'grade:clear:1',
    });
  });
});

describe('CP7 sales performance HTTP', () => {
  let server: Server | undefined;
  let base: string;
  let repo: SalesPerformanceRepository;

  afterEach(async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    server = undefined;
  });

  async function start() {
    repo = repository();
    const service = createSalesPerformanceService(repo, { hash: value => value.padEnd(64, '0'), create: () => TOKEN }, { now: () => Date.parse(TO) });
    const handler = createSalesPerformanceHandler(service);
    server = createServer((request, response) => { void handler(request, response); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }

  it('routes aggregate and grade reads without duplicate query parameters', async () => {
    await start();
    const headers = { Authorization: `Bearer ${TOKEN}` };
    const performance = await fetch(`${base}/api/crm/sales-performance?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&groupBy=source&limit=10&offset=0`, { headers });
    expect(performance.status).toBe(200);
    expect(repo.performance).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ groupBy: 'source' }));
    const duplicate = await fetch(`${base}/api/crm/sales-performance?limit=10&limit=20`, { headers });
    expect(duplicate.status).toBe(400);
    const grades = await fetch(`${base}/api/crm/sales-performance/customer-grades?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&limit=10&offset=0`, { headers });
    expect(grades.status).toBe(200);
    expect(repo.customerGrades).toHaveBeenCalled();
  });

  it('routes auditable set and clear operations', async () => {
    await start();
    const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
    const set = await fetch(`${base}/api/crm/sales-performance/customer-grades/${CUSTOMER_ID}/override`, {
      method: 'POST', headers, body: JSON.stringify({ expectedVersion: 0, grade: 'B', reason: 'Manual review', idempotencyKey: 'grade:set:1' }),
    });
    expect(set.status).toBe(200);
    expect(repo.setCustomerGradeOverride).toHaveBeenCalled();
    const clear = await fetch(`${base}/api/crm/sales-performance/customer-grades/${CUSTOMER_ID}/override`, {
      method: 'DELETE', headers, body: JSON.stringify({ expectedVersion: 1, reason: 'Computed is better', idempotencyKey: 'grade:clear:1' }),
    });
    expect(clear.status).toBe(200);
    expect(repo.clearCustomerGradeOverride).toHaveBeenCalled();
  });
});
