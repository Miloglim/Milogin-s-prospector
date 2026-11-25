import { createHash } from 'node:crypto';
import { Pool } from 'pg';
import type { CrmRole } from '../../core/auth';
import type { AiFeature, AiModelProfile, AiPolicyRow, AiPolicyUpdate, AiRepository, AiUsageEvent, AiUsageReceipt, AiUsageSummary, AiUserPolicy } from '../../core/ai';
import { decryptAiSecret, encryptAiSecret } from '../ai-secret';

export const AI_SCHEMA_VERSION = '074-ai-user-policies';
export const AI_OPERATIONS_SCHEMA_VERSION = '075-ai-operations';
export const AI_SECRET_SCHEMA_VERSION = '083-ai-model-secret';
const AI_SQL = `
CREATE TABLE IF NOT EXISTS public.ai_user_policies (
  user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id),
  enabled boolean NOT NULL DEFAULT false,
  daily_token_limit bigint NOT NULL DEFAULT 200000 CHECK(daily_token_limit >= 0),
  monthly_token_limit bigint NOT NULL DEFAULT 3000000 CHECK(monthly_token_limit >= 0),
  max_output_tokens integer NOT NULL DEFAULT 2048 CHECK(max_output_tokens BETWEEN 128 AND 32768),
  allowed_features text[] NOT NULL DEFAULT ARRAY['agent','draft','backcheck','mail_analysis','summary']::text[],
  updated_by uuid REFERENCES public.identity_users(user_id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  event_id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  product text NOT NULL,
  feature text NOT NULL CHECK(feature IN ('agent','draft','backcheck','mail_analysis','summary')),
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  status text NOT NULL CHECK(status IN ('ok','error','blocked')),
  latency_ms integer NOT NULL DEFAULT 0,
  request_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created ON public.ai_usage_events(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON public.ai_usage_events(created_at DESC);
`;

const AI_OPERATIONS_SQL = `
ALTER TABLE public.ai_usage_events
  ADD COLUMN IF NOT EXISTS model_profile text,
  ADD COLUMN IF NOT EXISTS http_status integer,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS quota_remaining bigint;
CREATE TABLE IF NOT EXISTS public.ai_model_profiles (
  model_id text PRIMARY KEY,
  label text NOT NULL,
  base_url text NOT NULL,
  model_name text NOT NULL,
  wire_api text NOT NULL DEFAULT 'chat_completions' CHECK(wire_api IN ('chat_completions','responses')),
  key_env text NOT NULL,
  allowed_features text[] NOT NULL DEFAULT ARRAY['agent','draft','backcheck','mail_analysis','summary']::text[],
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  max_output_tokens integer NOT NULL DEFAULT 2048 CHECK(max_output_tokens BETWEEN 128 AND 32768),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS public.ai_policy_audit (
  audit_id bigserial PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  target_user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  before_json jsonb,
  after_json jsonb NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_ai_policy_audit_target ON public.ai_policy_audit(target_user_id,created_at DESC);
`;

const AI_SECRET_SQL = ` 
ALTER TABLE public.ai_model_profiles ADD COLUMN IF NOT EXISTS api_key_ciphertext text;
`;

const DEFAULT_POLICY: Omit<AiUserPolicy, 'userId'> = {
  enabled: false,
  dailyTokenLimit: 200000,
  monthlyTokenLimit: 3000000,
  maxOutputTokens: 2048,
  allowedFeatures: ['agent', 'draft', 'backcheck', 'mail_analysis', 'summary'],
  updatedAt: null,
  updatedBy: null,
};

function mapPolicy(row: any): AiUserPolicy {
  if (!row) return { userId: '', ...DEFAULT_POLICY };
  return {
    userId: String(row.user_id),
    enabled: row.enabled == null ? DEFAULT_POLICY.enabled : Boolean(row.enabled),
    dailyTokenLimit: row.daily_token_limit == null ? DEFAULT_POLICY.dailyTokenLimit : Number(row.daily_token_limit),
    monthlyTokenLimit: row.monthly_token_limit == null ? DEFAULT_POLICY.monthlyTokenLimit : Number(row.monthly_token_limit),
    maxOutputTokens: row.max_output_tokens == null ? DEFAULT_POLICY.maxOutputTokens : Number(row.max_output_tokens),
    allowedFeatures: (row.allowed_features || DEFAULT_POLICY.allowedFeatures) as AiFeature[],
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    updatedBy: row.updated_by ? String(row.updated_by) : null,
  };
}

export class PostgresAiRepository implements AiRepository {
  constructor(private pool: Pool, private log: { write(level: string, context: string, message: string): void }) {}

  async migrate() {
    const client = await this.pool.connect();
    try {
      const checksum = createHash('sha256').update(AI_SQL).digest('hex');
      const old = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [AI_SCHEMA_VERSION]);
      if (old.rows.length && old.rows[0].checksum !== checksum) return { ok: false as const, error: 'AI 迁移校验不一致' };
      if (!old.rows.length) {
        await client.query('BEGIN');
        try {
          await client.query(AI_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [AI_SCHEMA_VERSION, checksum]);
          await client.query('COMMIT');
          this.log.write('INFO', 'ai.migrate', `迁移完成 version=${AI_SCHEMA_VERSION}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      const operationChecksum = createHash('sha256').update(AI_OPERATIONS_SQL).digest('hex');
      const operationOld = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [AI_OPERATIONS_SCHEMA_VERSION]);
      if (operationOld.rows.length && operationOld.rows[0].checksum !== operationChecksum) return { ok: false as const, error: 'AI 运营迁移校验不一致' };
      if (!operationOld.rows.length) {
        await client.query('BEGIN');
        try {
          await client.query(AI_OPERATIONS_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [AI_OPERATIONS_SCHEMA_VERSION, operationChecksum]);
          await client.query('COMMIT');
          this.log.write('INFO', 'ai.migrate', `迁移完成 version=${AI_OPERATIONS_SCHEMA_VERSION}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      const secretChecksum = createHash('sha256').update(AI_SECRET_SQL).digest('hex');
      const secretOld = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [AI_SECRET_SCHEMA_VERSION]);
      if (secretOld.rows.length && secretOld.rows[0].checksum !== secretChecksum) return { ok: false as const, error: 'AI 密钥存储迁移校验不一致' };
      if (!secretOld.rows.length) {
        await client.query('BEGIN');
        try {
          await client.query(AI_SECRET_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [AI_SECRET_SCHEMA_VERSION, secretChecksum]);
          await client.query('COMMIT');
          this.log.write('INFO', 'ai.migrate', `迁移完成 version=${AI_SECRET_SCHEMA_VERSION}`);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : 'AI 迁移失败' };
    } finally {
      client.release();
    }
  }

  async policy(userId: string): Promise<AiUserPolicy | null> {
    const result = await this.pool.query('SELECT * FROM public.ai_user_policies WHERE user_id=$1', [userId]);
    return result.rows.length ? mapPolicy(result.rows[0]) : { userId, ...DEFAULT_POLICY };
  }

  async listPolicies(): Promise<AiPolicyRow[]> {
    const result = await this.pool.query(`
      SELECT u.user_id,e.email,u.display_name,p.enabled,p.daily_token_limit,p.monthly_token_limit,p.max_output_tokens,p.allowed_features,p.updated_at,p.updated_by,
        ARRAY(SELECT role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' ORDER BY role) AS crm_roles,
        COALESCE(day.input_tokens,0)+COALESCE(day.output_tokens,0) AS daily_tokens,
        COALESCE(month.input_tokens,0)+COALESCE(month.output_tokens,0) AS monthly_tokens,
        COALESCE(month.requests,0) AS request_count,
        month.last_used_at
      FROM public.identity_users u
      JOIN public.identity_login_emails e USING(user_id)
      LEFT JOIN public.ai_user_policies p ON p.user_id=u.user_id
      LEFT JOIN LATERAL (
        SELECT sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens
        FROM public.ai_usage_events e WHERE e.user_id=u.user_id AND e.created_at >= date_trunc('day',clock_timestamp())
      ) day ON true
      LEFT JOIN LATERAL (
        SELECT sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,count(*) AS requests,max(created_at) AS last_used_at
        FROM public.ai_usage_events e WHERE e.user_id=u.user_id AND e.created_at >= date_trunc('month',clock_timestamp())
      ) month ON true
      WHERE u.deleted_at IS NULL
      ORDER BY e.email COLLATE "C" ASC
    `);
    return result.rows.map(row => ({
      ...mapPolicy(row),
      userId: String(row.user_id),
      email: String(row.email),
      displayName: row.display_name ? String(row.display_name) : null,
      crmRoles: (row.crm_roles || []) as CrmRole[],
      dailyTokens: Number(row.daily_tokens) || 0,
      monthlyTokens: Number(row.monthly_tokens) || 0,
      requestCount: Number(row.request_count) || 0,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    }));
  }

  async updatePolicy(actorUserId: string, input: AiPolicyUpdate): Promise<AiUserPolicy> {
    const before = await this.pool.query('SELECT * FROM public.ai_user_policies WHERE user_id=$1', [input.userId]);
    const result = await this.pool.query(`
      INSERT INTO public.ai_user_policies(user_id,enabled,daily_token_limit,monthly_token_limit,max_output_tokens,allowed_features,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp())
      ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,daily_token_limit=excluded.daily_token_limit,monthly_token_limit=excluded.monthly_token_limit,max_output_tokens=excluded.max_output_tokens,allowed_features=excluded.allowed_features,updated_by=excluded.updated_by,updated_at=clock_timestamp()
      RETURNING *
    `, [input.userId, input.enabled, input.dailyTokenLimit, input.monthlyTokenLimit, input.maxOutputTokens, input.allowedFeatures, actorUserId]);
    await this.pool.query(`INSERT INTO public.ai_policy_audit(actor_user_id,target_user_id,before_json,after_json,reason) VALUES($1,$2,$3,$4,$5)`, [actorUserId, input.userId, before.rows[0] ? JSON.stringify(before.rows[0]) : null, JSON.stringify(result.rows[0]), input.reason.trim()]);
    return mapPolicy(result.rows[0]);
  }

  async usageSummary(days: number): Promise<AiUsageSummary> {
    const result = await this.pool.query(`
      SELECT count(*) AS requests,COALESCE(sum(input_tokens),0) AS input_tokens,COALESCE(sum(output_tokens),0) AS output_tokens,
        count(*) FILTER (WHERE status='error') AS errors,count(*) FILTER (WHERE status='blocked') AS blocked
      FROM public.ai_usage_events WHERE created_at >= clock_timestamp() - ($1::int * interval '1 day')
    `, [days]);
    const row = result.rows[0] || {};
    return { days, requests: Number(row.requests) || 0, inputTokens: Number(row.input_tokens) || 0, outputTokens: Number(row.output_tokens) || 0, errors: Number(row.errors) || 0, blocked: Number(row.blocked) || 0 };
  }

  async recordUsage(event: Omit<AiUsageEvent, 'eventId' | 'createdAt'>): Promise<void> {
    await this.pool.query(`
      INSERT INTO public.ai_usage_events(user_id,product,feature,model,input_tokens,output_tokens,status,latency_ms,request_id,model_profile,http_status,error_code,quota_remaining)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [event.userId, event.product, event.feature, event.model, event.inputTokens, event.outputTokens, event.status, event.latencyMs, `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`, event.modelProfile || null, event.httpStatus || null, event.errorCode || null, event.quotaRemaining ?? null]);
  }

  async usageEvents(input: { userId?: string; feature?: AiFeature; status?: 'ok' | 'error' | 'blocked'; days: number; limit: number; offset: number }): Promise<AiUsageReceipt[]> {
    const result = await this.pool.query(`
      SELECT e.*,le.email,u.display_name,
        (COALESCE(p.monthly_token_limit,0) - COALESCE(month.tokens,0)) AS remaining
      FROM public.ai_usage_events e
      JOIN public.identity_users u ON u.user_id=e.user_id
      JOIN public.identity_login_emails le ON le.user_id=e.user_id
      LEFT JOIN public.ai_user_policies p ON p.user_id=e.user_id
      LEFT JOIN LATERAL (SELECT COALESCE(sum(input_tokens),0)+COALESCE(sum(output_tokens),0) AS tokens FROM public.ai_usage_events x WHERE x.user_id=e.user_id AND x.created_at>=date_trunc('month',clock_timestamp())) month ON true
      WHERE e.created_at >= clock_timestamp() - ($1::int * interval '1 day')
        AND ($2::uuid IS NULL OR e.user_id=$2)
        AND ($3::text IS NULL OR e.feature=$3)
        AND ($4::text IS NULL OR e.status=$4)
      ORDER BY e.created_at DESC LIMIT $5 OFFSET $6
    `, [input.days, input.userId || null, input.feature || null, input.status || null, input.limit, input.offset]);
    return result.rows.map(r => ({ eventId: Number(r.event_id), userId: r.user_id, userName: r.display_name, userEmail: r.email, product: r.product, feature: r.feature, model: r.model, inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), status: r.status, latencyMs: Number(r.latency_ms), createdAt: new Date(r.created_at).toISOString(), httpStatus: r.http_status === null ? null : Number(r.http_status), errorCode: r.error_code, quotaRemaining: r.remaining === null ? null : Number(r.remaining) }));
  }

  async receipts(userId: string, limit: number): Promise<AiUsageReceipt[]> {
    return this.usageEvents({ userId, days: 30, limit, offset: 0 });
  }

  async listModels(): Promise<AiModelProfile[]> {
    const result = await this.pool.query('SELECT *, (api_key_ciphertext IS NOT NULL) AS has_api_key FROM public.ai_model_profiles ORDER BY is_default DESC,label ASC');
    return result.rows.map(r => ({ modelId: r.model_id, label: r.label, baseUrl: r.base_url, modelName: r.model_name, wireApi: r.wire_api, keyEnv: r.key_env, allowedFeatures: r.allowed_features, enabled: Boolean(r.enabled), isDefault: Boolean(r.is_default), maxOutputTokens: Number(r.max_output_tokens), updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null, hasApiKey: Boolean(r.has_api_key) }));
  }

  async saveModel(model: AiModelProfile, apiKey?: string | null): Promise<AiModelProfile> {
    if (model.isDefault) await this.pool.query('UPDATE public.ai_model_profiles SET is_default=false');
    const encrypted = apiKey && apiKey.trim() ? encryptAiSecret(apiKey.trim()) : null;
    await this.pool.query(`
      INSERT INTO public.ai_model_profiles(model_id,label,base_url,model_name,wire_api,key_env,allowed_features,enabled,is_default,max_output_tokens,api_key_ciphertext,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())
      ON CONFLICT(model_id) DO UPDATE SET label=excluded.label,base_url=excluded.base_url,model_name=excluded.model_name,wire_api=excluded.wire_api,key_env=excluded.key_env,allowed_features=excluded.allowed_features,enabled=excluded.enabled,is_default=excluded.is_default,max_output_tokens=excluded.max_output_tokens,api_key_ciphertext=COALESCE(excluded.api_key_ciphertext,public.ai_model_profiles.api_key_ciphertext),updated_at=clock_timestamp()
    `, [model.modelId, model.label, model.baseUrl, model.modelName, model.wireApi, model.keyEnv, model.allowedFeatures, model.enabled, model.isDefault, model.maxOutputTokens, encrypted]);
    const rows = await this.listModels();
    return rows.find(row => row.modelId === model.modelId)!;
  }

  async modelApiKey(modelId: string): Promise<string | null> {
    const result = await this.pool.query('SELECT api_key_ciphertext FROM public.ai_model_profiles WHERE model_id=$1', [modelId]);
    return decryptAiSecret(result.rows[0]?.api_key_ciphertext);
  }
}
