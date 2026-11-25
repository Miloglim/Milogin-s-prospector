import type { Identity } from '../core/auth';
import { canManageAi, type AiChatInput, type AiModelProfile, type AiRepository, type AiUsageEvent, type AiUserPolicy } from '../core/ai';
import { readEnvironmentSecret } from '../adapters/environment-secret';

const PROVIDER_TIMEOUT_MS = 90_000;

function upstreamConfig() {
  const baseUrl = (process.env.CENTER_AI_BASE_URL || '').trim().replace(/\/$/, '');
  const apiKey = readEnvironmentSecret('CENTER_AI_API_KEY');
  const model = (process.env.CENTER_AI_MODEL || '').trim();
  return { baseUrl, apiKey, model };
}

async function resolveModel(repo: AiRepository, feature: AiChatInput['feature']) {
  const models = await repo.listModels();
  const selected = models.find(model => model.enabled && model.allowedFeatures.includes(feature))
    || models.find(model => model.enabled && model.isDefault)
    || null;
  if (!selected) {
    const cfg = upstreamConfig();
    return cfg.baseUrl && cfg.apiKey && cfg.model ? { profile: null as AiModelProfile | null, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model, wireApi: 'chat_completions' as const, maxOutputTokens: 2048 } : null;
  }
  const key = (await repo.modelApiKey(selected.modelId)) || readEnvironmentSecret(selected.keyEnv) || readEnvironmentSecret('CENTER_AI_API_KEY');
  return key ? { profile: selected, baseUrl: selected.baseUrl.replace(/\/$/, ''), apiKey: key, model: selected.modelName, wireApi: selected.wireApi, maxOutputTokens: selected.maxOutputTokens } : null;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function usageTokens(payload: any, input: AiChatInput, outputText: string) {
  const inputTokens = Number(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens);
  const outputTokens = Number(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens);
  return {
    inputTokens: Number.isFinite(inputTokens) && inputTokens > 0 ? Math.floor(inputTokens) : input.messages.reduce((sum, item) => sum + estimateTokens(item.content || ''), 0),
    outputTokens: Number.isFinite(outputTokens) && outputTokens > 0 ? Math.floor(outputTokens) : estimateTokens(outputText),
  };
}

type ChatMessage = AiChatInput['messages'][number];

function responsesTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools?.length) return undefined;
  const converted = tools.flatMap(tool => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return [];
    const value = tool as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } };
    if (value.type !== 'function' || typeof value.function?.name !== 'string') return [];
    return [{
      type: 'function', name: value.function.name,
      ...(typeof value.function.description === 'string' ? { description: value.function.description } : {}),
      parameters: value.function.parameters && typeof value.function.parameters === 'object' ? value.function.parameters : { type: 'object', properties: {} },
    }];
  });
  return converted.length ? converted : undefined;
}

function responsesToolChoice(choice: unknown): unknown {
  if (typeof choice === 'string') return choice;
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return undefined;
  const value = choice as { type?: unknown; function?: { name?: unknown } };
  return value.type === 'function' && typeof value.function?.name === 'string' ? { type: 'function', name: value.function.name } : undefined;
}

export function responsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id || '', output: typeof message.content === 'string' ? message.content : '' });
      continue;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.tool_calls) {
        if (!call || typeof call !== 'object' || Array.isArray(call)) continue;
        const value = call as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        if (typeof value.function?.name !== 'string') continue;
        input.push({
          type: 'function_call', call_id: typeof value.id === 'string' ? value.id : '',
          name: value.function.name, arguments: typeof value.function.arguments === 'string' ? value.function.arguments : JSON.stringify(value.function.arguments ?? {}),
        });
      }
      continue;
    }
    input.push({ role: message.role, content: message.content ?? '' });
  }
  return input;
}

export function normalizedResponse(payload: any): { choices: unknown[]; outputText: string } {
  if (Array.isArray(payload?.choices)) {
    const first = payload.choices[0];
    const content = typeof first?.message?.content === 'string' ? first.message.content : '';
    return { choices: payload.choices, outputText: content };
  }
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const toolCalls: unknown[] = [];
  let text = '';
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      toolCalls.push({ id: item.call_id || item.id || '', type: 'function', function: { name: item.name || '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}) } });
    } else if (item.type === 'message') {
      for (const part of Array.isArray(item.content) ? item.content : []) if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
    }
  }
  if (!text && typeof payload?.output_text === 'string') text = payload.output_text;
  text = text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').replace(/<\/?think\b[^>]*>/gi, '').trim();
  return {
    choices: [{ message: { role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    outputText: text,
  };
}

export function createAiService(repo: AiRepository) {
  async function ensureQuota(identity: Identity, input: AiChatInput): Promise<{ policy: AiUserPolicy; error?: string }> {
    const policy = await repo.policy(identity.userId);
    if (!policy) return { policy: { userId: identity.userId, enabled: false, dailyTokenLimit: 0, monthlyTokenLimit: 0, maxOutputTokens: 0, allowedFeatures: [], updatedAt: null, updatedBy: null }, error: 'AI 策略不存在' };
    if (!policy.enabled) return { policy, error: '当前账号未启用 AI' };
    if (!policy.allowedFeatures.includes(input.feature)) return { policy, error: '当前功能未授权' };
    const rows = await repo.listPolicies();
    const row = rows.find(item => item.userId === identity.userId);
    if (row && row.dailyTokens >= policy.dailyTokenLimit) return { policy, error: '今日 AI 用量已达上限' };
    if (row && row.monthlyTokens >= policy.monthlyTokenLimit) return { policy, error: '本月 AI 用量已达上限' };
    return { policy };
  }

  return {
    async status(identity: Identity) {
      const policy = await repo.policy(identity.userId);
      const model = await resolveModel(repo, 'agent');
      return { ...policy, available: Boolean(policy?.enabled && model) };
    },
    async chat(identity: Identity, input: AiChatInput): Promise<{ status: number; body: unknown }> {
      const started = Date.now();
      const checked = await ensureQuota(identity, input);
      if (checked.error) {
        await repo.recordUsage({ userId: identity.userId, product: 'prospector', feature: input.feature, model: input.model || 'blocked', inputTokens: 0, outputTokens: 0, status: 'blocked', latencyMs: Date.now() - started });
        return { status: 403, body: { error: { message: checked.error, type: 'ai_policy_blocked' } } };
      }
      const cfg = await resolveModel(repo, input.feature);
      if (!cfg) {
        return { status: 503, body: { error: { message: '中心 AI 服务未配置', type: 'ai_unavailable' } } };
      }
      try {
        const wireApi = cfg.wireApi || 'chat_completions';
        const maxTokens = Math.min(input.max_tokens || checked.policy.maxOutputTokens, checked.policy.maxOutputTokens, cfg.maxOutputTokens, input.feature === 'agent' ? 1400 : cfg.maxOutputTokens);
        const tools = wireApi === 'responses' ? responsesTools(input.tools) : input.tools;
        const toolChoice = wireApi === 'responses' ? responsesToolChoice(input.tool_choice) : input.tool_choice;
        const response = await fetch(`${cfg.baseUrl}/${wireApi === 'responses' ? 'responses' : 'chat/completions'}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(wireApi === 'responses'
            ? { model: cfg.model, input: responsesInput(input.messages), max_output_tokens: maxTokens, ...(input.feature === 'agent' ? { reasoning: { effort: 'none' } } : {}), ...(tools?.length ? { tools } : {}), ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }) }
            : { model: cfg.model, messages: input.messages, max_tokens: maxTokens, ...(input.temperature === undefined ? {} : { temperature: input.temperature }), ...(tools?.length ? { tools } : {}), ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }) }),
          signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        });
        const text = await response.text();
        let payload: any = null;
        try { payload = JSON.parse(text); } catch { payload = { error: { message: '上游返回非 JSON', type: 'bad_upstream_response' } }; }
        const normalized = normalizedResponse(payload);
        const outputText = normalized.outputText;
        const tokens = usageTokens(payload, input, outputText);
        await repo.recordUsage({ userId: identity.userId, product: 'prospector', feature: input.feature, model: cfg.model, ...tokens, status: response.ok ? 'ok' : 'error', latencyMs: Date.now() - started, modelProfile: cfg.profile?.modelId || 'env', httpStatus: response.status, errorCode: response.ok ? null : String(payload?.error?.type || payload?.error?.code || 'upstream_error') });
        return { status: response.status, body: wireApi === 'responses' && response.ok ? { choices: normalized.choices, usage: payload?.usage || null } : payload };
      } catch (error) {
        await repo.recordUsage({ userId: identity.userId, product: 'prospector', feature: input.feature, model: cfg.model, inputTokens: 0, outputTokens: 0, status: 'error', latencyMs: Date.now() - started, modelProfile: cfg.profile?.modelId || 'env', httpStatus: 0, errorCode: 'upstream_exception' });
        return { status: 502, body: { error: { message: error instanceof Error ? error.message : '中心 AI 请求失败', type: 'ai_upstream_error' } } };
      }
    },
    async policies(identity: Identity) {
      if (!canManageAi(identity)) return { ok: false as const, error: 'FORBIDDEN' as const };
      return { ok: true as const, data: await repo.listPolicies() };
    },
    async updatePolicy(identity: Identity, input: Parameters<AiRepository['updatePolicy']>[1]) {
      if (!canManageAi(identity)) return { ok: false as const, error: 'FORBIDDEN' as const };
      return { ok: true as const, data: await repo.updatePolicy(identity.userId, input) };
    },
    async usage(identity: Identity, days = 30) {
      if (!canManageAi(identity)) return { ok: false as const, error: 'FORBIDDEN' as const };
      return { ok: true as const, data: await repo.usageSummary(days) };
    },
    async usageEvents(identity: Identity, input: Parameters<AiRepository['usageEvents']>[0]) {
      if (!canManageAi(identity)) return { ok: false as const, error: 'FORBIDDEN' as const };
      return { ok: true as const, data: await repo.usageEvents(input) };
    },
    async receipts(identity: Identity, limit = 20) {
      return await repo.receipts(identity.userId, limit);
    },
    async models(identity: Identity) {
      if (!canManageAi(identity)) return { ok: false as const, error: 'FORBIDDEN' as const };
      return { ok: true as const, data: await repo.listModels() };
    },
    async saveModel(identity: Identity, input: AiModelProfile) {
      if (!canManageAi(identity)) return { ok: false as const, error: 'FORBIDDEN' as const };
      return { ok: true as const, data: await repo.saveModel(input, input.apiKey) };
    },
  };
}

export type AiService = ReturnType<typeof createAiService>;
