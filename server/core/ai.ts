import type { CrmRole } from './auth';

export const AI_ROUTES = {
  status: '/api/ai/status',
  chat: '/api/ai/chat/completions',
  receipts: '/api/ai/receipts',
} as const;

export const AI_ADMIN_ROUTES = {
  policies: '/admin-api/ai/policies',
  policy: '/admin-api/ai/policy',
  usage: '/admin-api/ai/usage',
  models: '/admin-api/ai/models',
  model: '/admin-api/ai/model',
  usageEvents: '/admin-api/ai/usage-events',
} as const;

export const AI_FEATURES = ['agent', 'draft', 'backcheck', 'mail_analysis', 'summary'] as const;
export type AiFeature = typeof AI_FEATURES[number];

export interface AiUserPolicy {
  userId: string;
  enabled: boolean;
  dailyTokenLimit: number;
  monthlyTokenLimit: number;
  maxOutputTokens: number;
  allowedFeatures: AiFeature[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface AiPolicyRow extends AiUserPolicy {
  email: string;
  displayName: string | null;
  crmRoles: CrmRole[];
  dailyTokens: number;
  monthlyTokens: number;
  requestCount: number;
  lastUsedAt: string | null;
}

export interface AiPolicyUpdate {
  userId: string;
  enabled: boolean;
  dailyTokenLimit: number;
  monthlyTokenLimit: number;
  maxOutputTokens: number;
  allowedFeatures: AiFeature[];
  reason: string;
}

export interface AiUsageEvent {
  eventId: number;
  userId: string;
  product: string;
  feature: AiFeature;
  model: string;
  inputTokens: number;
  outputTokens: number;
  status: 'ok' | 'error' | 'blocked';
  latencyMs: number;
  modelProfile?: string | null;
  httpStatus?: number | null;
  errorCode?: string | null;
  quotaRemaining?: number | null;
  createdAt: string;
}

export interface AiUsageSummary {
  days: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
  blocked: number;
}

export const AI_WIRE_APIS = ['chat_completions', 'responses'] as const;
export type AiWireApi = typeof AI_WIRE_APIS[number];

export interface AiModelProfile {
  modelId: string;
  label: string;
  baseUrl: string;
  modelName: string;
  wireApi: AiWireApi;
  keyEnv: string;
  allowedFeatures: AiFeature[];
  enabled: boolean;
  isDefault: boolean;
  maxOutputTokens: number;
  updatedAt: string | null;
}

export interface AiUsageReceipt extends AiUsageEvent {
  userName: string | null;
  userEmail: string | null;
  httpStatus: number | null;
  errorCode: string | null;
  quotaRemaining: number | null;
}

export interface AiChatInput {
  feature: AiFeature;
  model?: string;
  messages: Array<{ role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }>;
  max_tokens?: number;
  temperature?: number;
  tools?: unknown[];
  tool_choice?: unknown;
}

export function isAiFeature(value: unknown): value is AiFeature {
  return typeof value === 'string' && (AI_FEATURES as readonly string[]).includes(value);
}

export interface AiRepository {
  migrate(): Promise<{ ok: true } | { ok: false; error: string }>;
  policy(userId: string): Promise<AiUserPolicy | null>;
  listPolicies(): Promise<AiPolicyRow[]>;
  updatePolicy(actorUserId: string, input: AiPolicyUpdate): Promise<AiUserPolicy>;
  usageSummary(days: number): Promise<AiUsageSummary>;
  usageEvents(input: { userId?: string; feature?: AiFeature; status?: 'ok' | 'error' | 'blocked'; days: number; limit: number; offset: number }): Promise<AiUsageReceipt[]>;
  receipts(userId: string, limit: number): Promise<AiUsageReceipt[]>;
  listModels(): Promise<AiModelProfile[]>;
  saveModel(model: AiModelProfile): Promise<AiModelProfile>;
  recordUsage(event: Omit<AiUsageEvent, 'eventId' | 'createdAt'>): Promise<void>;
}

export function canManageAi(identity: { identityAdmin: boolean; crmRoles: readonly CrmRole[] }): boolean {
  return identity.identityAdmin || identity.crmRoles.includes('admin');
}
