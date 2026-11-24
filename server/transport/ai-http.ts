import type { AuthService } from '../services/auth';
import type { AiService } from '../services/ai';
import { AI_ROUTES, isAiFeature, type AiChatInput } from '../core/ai';
import { body, send, type BrowserHandler } from './http';
import { failure, success } from '../core/crm';

const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

function messageText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === 'string') { parts.push(part); continue; }
    if (!part || typeof part !== 'object' || Array.isArray(part)) return undefined;
    const text = (part as { text?: unknown }).text;
    if (typeof text !== 'string') return undefined;
    parts.push(text);
  }
  return parts.join('');
}

export function chatInput(value: unknown): AiChatInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const feature = input.feature === undefined ? 'agent' : input.feature;
  if (!isAiFeature(feature) || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 100) return null;
  const messages = input.messages.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const content = messageText(row.content);
    if (typeof row.role !== 'string' || (content === undefined && !Array.isArray(row.tool_calls))) return null;
    if (typeof content === 'string' && content.length > 200000) return null;
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls.slice(0, 32) : undefined;
    const toolCallId = typeof row.tool_call_id === 'string' ? row.tool_call_id.slice(0, 200) : undefined;
    const name = typeof row.name === 'string' ? row.name.slice(0, 200) : undefined;
    return { role: row.role, content: content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}), ...(toolCallId ? { tool_call_id: toolCallId } : {}), ...(name ? { name } : {}) };
  });
  if (messages.some(item => !item)) return null;
  const maxTokens = input.max_tokens === undefined ? undefined : Number(input.max_tokens);
  const temperature = input.temperature === undefined ? undefined : Number(input.temperature);
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768)) return null;
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) return null;
  const tools = Array.isArray(input.tools) && input.tools.length <= 128 ? input.tools : undefined;
  return { feature, messages: messages as AiChatInput['messages'], ...(typeof input.model === 'string' ? { model: input.model.slice(0, 200) } : {}), ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }), ...(temperature === undefined ? {} : { temperature }), ...(tools ? { tools } : {}), ...(input.tool_choice === undefined ? {} : { tool_choice: input.tool_choice }) };
}

export function createAiHandler(auth: AuthService, ai: AiService): BrowserHandler {
  return async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (!Object.values(AI_ROUTES).some(route => route === url.pathname)) { send(response, failure('NOT_FOUND', 'AI 接口不存在')); return; }
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1] ?? '';
    if (!token) { send(response, failure('UNAUTHORIZED', '请先登录中心账号')); return; }
    const identity = await auth.me(token, 'api');
    if (!identity.ok) { send(response, identity); return; }
    if (request.method === 'GET' && url.pathname === AI_ROUTES.status) {
      send(response, success(await ai.status(identity.data)));
      return;
    }
    if (request.method === 'GET' && url.pathname === AI_ROUTES.receipts) {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) { send(response, failure('INVALID_INPUT', '回执数量无效')); return; }
      send(response, success(await ai.receipts(identity.data, limit)));
      return;
    }
    if (request.method === 'POST' && url.pathname === AI_ROUTES.chat) {
      const input = await body(request, 1024 * 1024);
      if (!input.ok) { send(response, input); return; }
      const parsed = chatInput(input.data);
      if (!parsed) { send(response, failure('INVALID_INPUT', 'AI 请求参数无效')); return; }
      const result = await ai.chat(identity.data, parsed);
      response.statusCode = result.status;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(result.body));
      return;
    }
    send(response, failure('NOT_FOUND', 'AI 接口不存在'));
  };
}
