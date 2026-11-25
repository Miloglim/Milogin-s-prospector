import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiService } from '../../server/services/ai';
import type { AiPolicyRow, AiRepository, AiUsageEvent, AiUserPolicy } from '../../server/core/ai';
import type { Identity } from '../../server/core/auth';

const user = { userId: '11111111-1111-4111-8111-111111111111', email: 'user@example.test', displayName: 'User', identityAdmin: false, crmRoles: ['sales'] } as Identity;
const admin = { ...user, identityAdmin: true } as Identity;

function policy(overrides: Partial<AiUserPolicy> = {}): AiUserPolicy {
  return { userId: user.userId, enabled: true, dailyTokenLimit: 1000, monthlyTokenLimit: 5000, maxOutputTokens: 512, allowedFeatures: ['summary'], updatedAt: null, updatedBy: null, ...overrides };
}

function repo(overrides: Partial<AiRepository> = {}) {
  const events: Array<Omit<AiUsageEvent, 'eventId' | 'createdAt'>> = [];
  const base: AiRepository = {
    migrate: async () => ({ ok: true }),
    policy: async () => policy(),
    listPolicies: async () => [{ ...policy(), email: user.email, displayName: 'User', crmRoles: ['sales'], dailyTokens: 0, monthlyTokens: 0, requestCount: 0, lastUsedAt: null } as AiPolicyRow],
    updatePolicy: async (_actor, input) => policy(input),
    usageSummary: async days => ({ days, requests: 0, inputTokens: 0, outputTokens: 0, errors: 0, blocked: 0 }),
    usageEvents: async () => [],
    receipts: async () => [],
    listModels: async () => [],
    saveModel: async model => model,
    modelApiKey: async () => null,
    recordUsage: async event => { events.push(event); },
    ...overrides,
  };
  return { repo: base, events };
}

afterEach(() => { vi.unstubAllGlobals(); delete process.env.CENTER_AI_BASE_URL; delete process.env.CENTER_AI_API_KEY; delete process.env.CENTER_AI_MODEL; delete process.env.TEST_AI_KEY; });

describe('center AI proxy', () => {
  it('blocks disabled users and records blocked usage', async () => {
    const { repo: fake, events } = repo({ policy: async () => policy({ enabled: false }) });
    const result = await createAiService(fake).chat(user, { feature: 'summary', messages: [{ role: 'user', content: 'hi' }] });
    expect(result.status).toBe(403);
    expect(events[0]).toMatchObject({ status: 'blocked', feature: 'summary' });
  });
  it('proxies enabled users with server-side model config and records usage', async () => {
    process.env.CENTER_AI_BASE_URL = 'https://ai.example.test/v1';
    process.env.CENTER_AI_API_KEY = 'server-secret';
    process.env.CENTER_AI_MODEL = 'model-a';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const { repo: fake, events } = repo();
    const result = await createAiService(fake).chat(user, { feature: 'summary', messages: [{ role: 'user', content: 'hello' }], max_tokens: 9999 });
    expect(result.status).toBe(200);
    expect(events[0]).toMatchObject({ status: 'ok', model: 'model-a', inputTokens: 3, outputTokens: 4 });
    const fetchMock = vi.mocked(fetch);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ model: 'model-a', max_tokens: 512 });
  });
  it('keeps AI management restricted to admin identities', async () => {
    const { repo: fake } = repo();
    const ai = createAiService(fake);
    expect((await ai.policies(user)).ok).toBe(false);
    expect((await ai.policies(admin)).ok).toBe(true);
  });
  it('uses an explicit model profile and its key environment variable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    process.env.TEST_AI_KEY = 'profile-key';
    const { repo: fake } = repo({ policy: async () => policy({ allowedFeatures: ['mail_analysis'] }), listModels: async () => [{ modelId: 'profile-a', label: 'Profile A', baseUrl: 'https://profile.example.test/v1', modelName: 'profile-model', wireApi: 'chat_completions', keyEnv: 'TEST_AI_KEY', allowedFeatures: ['mail_analysis'], enabled: true, isDefault: true, maxOutputTokens: 1024, updatedAt: null }] });
    const result = await createAiService(fake).chat(user, { feature: 'mail_analysis', messages: [{ role: 'user', content: 'hello' }] });
    expect(result.status).toBe(200);
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://profile.example.test/v1/chat/completions');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string,string>).Authorization).toBe('Bearer profile-key');
  });
});
