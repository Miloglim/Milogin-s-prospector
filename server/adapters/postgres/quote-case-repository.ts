import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { failure, success, type LogSink, type Result } from '../../core/crm';
import {
  canTransitionQuote,
  missingQuoteFields,
  type QuoteCandidate,
  type QuoteCase,
  type QuoteCaseDetail,
  type QuoteCaseState,
  type QuoteDraft,
  type QuoteFieldKey,
  type QuoteFields,
  type QuoteReviewRequest,
  type QuoteReviewListItem,
  type QuoteReviewPage,
  type UpsertQuoteCaseInput,
} from '../../core/quote-case';

type ActorRole = 'admin' | 'operations' | 'sales' | 'auditor';
interface Actor { userId: string; identityAdmin: boolean; roles: ActorRole[] }

const ISO = (value: unknown): string | null => value instanceof Date ? value.toISOString() : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const JSON_OBJECT = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function mapCandidate(value: unknown): QuoteCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id || ''), carrier: typeof row.carrier === 'string' ? row.carrier : null,
    pol: typeof row.pol === 'string' ? row.pol : null, pod: typeof row.pod === 'string' ? row.pod : null,
    containerType: typeof row.containerType === 'string' ? row.containerType : null,
    price: typeof row.price === 'number' && Number.isFinite(row.price) ? row.price : null,
    currency: typeof row.currency === 'string' ? row.currency : null,
    etd: typeof row.etd === 'string' ? row.etd : null,
    validFrom: typeof row.validFrom === 'string' ? row.validFrom : null,
    validTo: typeof row.validTo === 'string' ? row.validTo : null,
    sourceUpdatedAt: typeof row.sourceUpdatedAt === 'string' ? row.sourceUpdatedAt : null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
  };
}

function mapCase(row: Record<string, any>): QuoteCase {
  return {
    quoteCaseId: String(row.quote_case_id), caseId: String(row.case_id), messageKey: String(row.message_key),
    threadKey: String(row.thread_key), state: String(row.state) as QuoteCaseState,
    fields: JSON_OBJECT(row.fields_json) as QuoteFields,
    missingFields: Array.isArray(row.missing_fields_json) ? row.missing_fields_json as QuoteFieldKey[] : [],
    selectedQuote: mapCandidate(row.selected_quote_json), version: Number(row.version),
    createdAt: ISO(row.created_at)!, updatedAt: ISO(row.updated_at)!,
  };
}

function mapDraft(row: Record<string, any>, quoteCase: QuoteCase): QuoteDraft {
  const candidates = Array.isArray(row.candidates_json) ? row.candidates_json.map(mapCandidate).filter((item): item is QuoteCandidate => !!item) : [];
  return {
    quoteId: String(row.quote_id), quoteCaseId: String(row.quote_case_id), version: Number(row.version),
    status: String(row.status) as QuoteCaseState, fields: quoteCase.fields, missingFields: quoteCase.missingFields,
    selectedCandidate: mapCandidate(row.selected_candidate_json), candidates,
    subject: row.subject ? String(row.subject) : null, body: row.body ? String(row.body) : null,
    createdAt: ISO(row.created_at)!, updatedAt: ISO(row.updated_at)!,
  };
}

export class PostgresQuoteCaseRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) {}

  private async actor(client: PoolClient, hash: string): Promise<Actor | null> {
    const result = await client.query(
      `SELECT u.user_id,u.identity_admin,ARRAY(
         SELECT g.role FROM public.identity_product_grants g
         WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active ORDER BY g.role
       ) AS roles
       FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
       WHERE s.token_hash=$1 AND s.client='api' AND s.revoked_at IS NULL
         AND s.expires_at>now() AND u.active AND NOT u.must_change_password
         AND s.security_revision=u.security_revision`,
      [hash],
    );
    return result.rows.length ? { userId: String(result.rows[0].user_id), identityAdmin: Boolean(result.rows[0].identity_admin), roles: (result.rows[0].roles || []) as ActorRole[] } : null;
  }

  private async authorizeCase(client: PoolClient, actor: Actor, caseId: string): Promise<boolean> {
    const row = (await client.query(
      `SELECT c.owner_user_id AS case_owner,customer.origin,customer.owner_user_id AS customer_owner,customer.created_by
       FROM crm_sales_cases c JOIN crm_customers customer USING(customer_id) WHERE c.case_id=$1`,
      [caseId],
    )).rows[0];
    if (!row) return false;
    if (actor.identityAdmin || actor.roles.includes('admin')) return true;
    if (actor.roles.includes('operations') && String(row.origin) === 'operations') return true;
    return [row.case_owner, row.customer_owner, row.created_by].map(String).includes(actor.userId);
  }

  private async detailIn(client: PoolClient, quoteCaseId: string): Promise<Result<QuoteCaseDetail>> {
    const caseRow = (await client.query('SELECT * FROM crm_quote_cases WHERE quote_case_id=$1', [quoteCaseId])).rows[0];
    if (!caseRow) return failure('NOT_FOUND', '报价 Case 不存在');
    const quoteCase = mapCase(caseRow);
    const draftRow = (await client.query('SELECT * FROM crm_quote_drafts WHERE quote_case_id=$1 ORDER BY version DESC LIMIT 1', [quoteCaseId])).rows[0];
    if (!draftRow) return failure('NOT_FOUND', '报价草稿不存在');
    return success({ quoteCase, draft: mapDraft(draftRow, quoteCase) });
  }

  async list(hash: string, input: { caseId?: string; messageKey?: string; limit: number; offset: number }): Promise<Result<QuoteCase[]>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      const admin = actor.identityAdmin || actor.roles.includes('admin');
      const operations = actor.roles.includes('operations');
      const rows = (await client.query(
        `SELECT qc.* FROM crm_quote_cases qc
         WHERE ($1::text IS NULL OR qc.case_id=$1) AND ($2::text IS NULL OR qc.message_key=$2)
           AND ($3::boolean OR EXISTS(
             SELECT 1 FROM crm_sales_cases c JOIN crm_customers customer USING(customer_id)
             WHERE c.case_id=qc.case_id AND (
               ($4::boolean AND customer.origin='operations')
               OR c.owner_user_id=$5 OR customer.owner_user_id=$5 OR customer.created_by=$5
             )
           ))
         ORDER BY qc.updated_at DESC LIMIT $6 OFFSET $7`,
        [input.caseId || null, input.messageKey || null, admin, operations, actor.userId, input.limit, input.offset],
      )).rows;
      return success(rows.map(mapCase));
    } catch (error) {
      this.log.write('ERROR', 'quote-case.pg', `报价 Case 列表失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '报价 Case 列表暂不可用');
    } finally { client.release(); }
  }

  async detail(hash: string, quoteCaseId: string): Promise<Result<QuoteCaseDetail>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      const quote = (await client.query('SELECT case_id FROM crm_quote_cases WHERE quote_case_id=$1', [quoteCaseId])).rows[0];
      if (!quote || !await this.authorizeCase(client, actor, String(quote.case_id))) return failure('NOT_FOUND', '报价 Case 不存在');
      return this.detailIn(client, quoteCaseId);
    } catch (error) {
      this.log.write('ERROR', 'quote-case.pg', `报价 Case 详情失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '报价 Case 详情暂不可用');
    } finally { client.release(); }
  }

  async upsert(hash: string, input: UpsertQuoteCaseInput, actorUserId?: string): Promise<Result<QuoteCaseDetail>> {
    const client = await this.pool.connect();
    try {
      const actor = actorUserId ? { userId: actorUserId, identityAdmin: true, roles: ['admin'] as ActorRole[] } : await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      await client.query('BEGIN');
      if (!await this.authorizeCase(client, actor, input.caseId)) {
        await client.query('ROLLBACK');
        return failure('NOT_FOUND', '销售 Case 不存在');
      }
      const current = (await client.query(
        `SELECT qc.*,qd.quote_id,qd.version AS draft_version,qd.status AS draft_status,qd.subject,qd.body,qd.candidates_json,qd.selected_candidate_json
         FROM crm_quote_cases qc LEFT JOIN LATERAL (
           SELECT * FROM crm_quote_drafts d WHERE d.quote_case_id=qc.quote_case_id ORDER BY d.version DESC LIMIT 1
         ) qd ON true WHERE qc.case_id=$1 AND qc.message_key=$2 FOR UPDATE OF qc`,
        [input.caseId, input.messageKey],
      )).rows[0];
      const nextState = input.state || (input.candidates?.length ? 'candidates_ready' : 'fields_pending');
      const missing = input.missingFields ?? missingQuoteFields(input.fields);
      const selected = input.selectedCandidate ?? null;
      const candidates = input.candidates ?? [];
      let quoteCaseId: string;
      let quoteId: string;
      let version: number;
      if (!current) {
        quoteCaseId = randomUUID();
        quoteId = randomUUID();
        version = 1;
        await client.query(
          `INSERT INTO crm_quote_cases(quote_case_id,case_id,message_key,thread_key,state,fields_json,missing_fields_json,selected_quote_json)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [quoteCaseId, input.caseId, input.messageKey, input.threadKey, nextState, JSON.stringify(input.fields), JSON.stringify(missing), selected ? JSON.stringify(selected) : null],
        );
        await client.query(
          `INSERT INTO crm_quote_drafts(quote_id,quote_case_id,version,status,subject,body,selected_candidate_json,candidates_json)
           VALUES($1,$2,1,$3,$4,$5,$6,$7)`,
          [quoteId, quoteCaseId, nextState, input.subject || null, input.body || null, selected ? JSON.stringify(selected) : null, JSON.stringify(candidates)],
        );
      } else {
        quoteCaseId = String(current.quote_case_id);
        quoteId = String(current.quote_id);
        version = Number(current.draft_version) + 1;
        const from = String(current.state) as QuoteCaseState;
        if (from !== nextState && !canTransitionQuote(from, nextState)) {
          await client.query('ROLLBACK');
          return failure('CONFLICT', `报价状态不能从 ${from} 变为 ${nextState}`);
        }
        await client.query(
          `UPDATE crm_quote_cases SET thread_key=$2,state=$3,fields_json=$4,missing_fields_json=$5,
             selected_quote_json=$6,version=version+1,updated_at=clock_timestamp() WHERE quote_case_id=$1`,
          [quoteCaseId, input.threadKey, nextState, JSON.stringify(input.fields), JSON.stringify(missing), selected ? JSON.stringify(selected) : null],
        );
        await client.query(
          `UPDATE crm_quote_drafts SET version=$2,status=$3,subject=$4,body=$5,selected_candidate_json=$6,
             candidates_json=$7,updated_at=clock_timestamp() WHERE quote_id=$1`,
          [quoteId, version, nextState, input.subject || null, input.body || null, selected ? JSON.stringify(selected) : null, JSON.stringify(candidates)],
        );
      }
      await client.query(
        `INSERT INTO crm_quote_revisions(revision_id,quote_id,version,status,fields_json,selected_candidate_json,candidates_json,subject,body,actor_user_id,reason)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [randomUUID(), quoteId, version, nextState, JSON.stringify(input.fields), selected ? JSON.stringify(selected) : null,
          JSON.stringify(candidates), input.subject || null, input.body || null, actor.userId, input.reason || null],
      );
      const detail = await this.detailIn(client, quoteCaseId);
      if (!detail.ok) { await client.query('ROLLBACK'); return detail; }
      await client.query('COMMIT');
      return detail;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
      this.log.write('ERROR', 'quote-case.pg', `报价 Case 保存失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '报价 Case 保存失败');
    } finally { client.release(); }
  }

  async review(hash: string, quoteId: string, input: { reviewerUserId: string; reason?: string; linkedMessageId?: string; linkedTaskId?: string }): Promise<Result<QuoteReviewRequest>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      const quote = (await client.query(
        `SELECT d.quote_id,qc.case_id FROM crm_quote_drafts d JOIN crm_quote_cases qc USING(quote_case_id) WHERE d.quote_id=$1`,
        [quoteId],
      )).rows[0];
      if (!quote || !await this.authorizeCase(client, actor, String(quote.case_id))) return failure('NOT_FOUND', '报价草稿不存在');
      const reviewer = (await client.query(
        `SELECT 1 FROM public.identity_users u
         WHERE u.user_id=$1 AND u.active AND (u.identity_admin
           OR EXISTS(SELECT 1 FROM public.identity_product_access pa WHERE pa.user_id=u.user_id AND pa.product_id='crm' AND pa.active)
           OR EXISTS(SELECT 1 FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active))`,
        [input.reviewerUserId],
      )).rows[0];
      if (!reviewer) return failure('INVALID_INPUT', '审核人不可用');
      const pendingReview = (await client.query(
        "SELECT 1 FROM crm_quote_review_requests WHERE quote_id=$1 AND status='pending'",
        [quoteId],
      )).rows[0];
      if (pendingReview) return failure('CONFLICT', '报价已在审核中');
      const reviewId = randomUUID();
      const row = (await client.query(
        `INSERT INTO crm_quote_review_requests(review_id,quote_id,requested_by,reviewer_user_id,status,reason,linked_message_id,linked_task_id)
         VALUES($1,$2,$3,$4,'pending',$5,$6,$7) RETURNING *`,
        [reviewId, quoteId, actor.userId, input.reviewerUserId, input.reason || null, input.linkedMessageId || null, input.linkedTaskId || null],
      )).rows[0];
      return success({
        reviewId: String(row.review_id), quoteId: String(row.quote_id), requestedBy: String(row.requested_by),
        reviewerUserId: String(row.reviewer_user_id), status: row.status, reason: row.reason || null,
        decisionNote: row.decision_note || null, linkedMessageId: row.linked_message_id || null,
        linkedTaskId: row.linked_task_id || null, createdAt: ISO(row.created_at)!, decidedAt: ISO(row.decided_at),
      });
    } catch (error) {
      this.log.write('ERROR', 'quote-case.pg', `报价审核请求失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '报价审核请求失败');
    } finally { client.release(); }
  }

  async listReviews(hash: string, status: 'pending' | 'approved' | 'rejected' | 'cancelled', limit: number, offset: number): Promise<Result<QuoteReviewPage>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      const [rows, total] = await Promise.all([
        client.query(
          `SELECT r.*,qc.quote_case_id,qc.case_id,d.subject,d.selected_candidate_json,d.candidates_json,
                  requester.display_name AS requested_by_name,company.name AS customer_name
           FROM crm_quote_review_requests r
           JOIN crm_quote_drafts d ON d.quote_id=r.quote_id
           JOIN crm_quote_cases qc ON qc.quote_case_id=d.quote_case_id
           JOIN crm_sales_cases sc ON sc.case_id=qc.case_id
           JOIN crm_customers customer ON customer.customer_id=sc.customer_id
           JOIN companies company ON company.id=customer.company_id
           JOIN public.identity_users requester ON requester.user_id=r.requested_by
           WHERE r.reviewer_user_id=$1 AND r.status=$2
           ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`,
          [actor.userId, status, limit, offset],
        ),
        client.query('SELECT count(*)::int AS total FROM crm_quote_review_requests WHERE reviewer_user_id=$1 AND status=$2', [actor.userId, status]),
      ]);
      return success({ items: rows.rows.map(row => this.mapReviewItem(row)), total: Number(total.rows[0]?.total ?? 0) });
    } catch (error) {
      this.log.write('ERROR', 'quote-case.pg', `报价审核列表失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '报价审核列表暂不可用');
    } finally { client.release(); }
  }

  async decideReview(hash: string, reviewId: string, action: 'approve' | 'reject', note?: string): Promise<Result<QuoteReviewRequest>> {
    const client = await this.pool.connect();
    try {
      const actor = await this.actor(client, hash);
      if (!actor) return failure('UNAUTHORIZED', 'CRM 会话已失效');
      await client.query('BEGIN');
      const row = (await client.query(
        `SELECT r.*,d.quote_case_id,qc.case_id FROM crm_quote_review_requests r
         JOIN crm_quote_drafts d ON d.quote_id=r.quote_id
         JOIN crm_quote_cases qc ON qc.quote_case_id=d.quote_case_id
         WHERE r.review_id=$1 FOR UPDATE OF r`,
        [reviewId],
      )).rows[0];
      if (!row) { await client.query('ROLLBACK'); return failure('NOT_FOUND', '报价审核不存在'); }
      if (String(row.reviewer_user_id) !== actor.userId && !actor.identityAdmin && !actor.roles.includes('admin')) { await client.query('ROLLBACK'); return failure('FORBIDDEN', '只有指定审核人可以处理'); }
      if (String(row.status) !== 'pending') { await client.query('ROLLBACK'); return failure('CONFLICT', '报价审核已处理'); }
      const status = action === 'approve' ? 'approved' : 'rejected';
      const quoteStatus = action === 'approve' ? 'approved' : 'review_rejected';
      const updated = (await client.query('UPDATE crm_quote_review_requests SET status=$2,decision_note=$3,decided_at=now() WHERE review_id=$1 RETURNING *', [reviewId, status, note || null])).rows[0];
      await client.query('UPDATE crm_quote_drafts SET status=$2,updated_at=now() WHERE quote_id=$1', [row.quote_id, quoteStatus]);
      await client.query('UPDATE crm_quote_cases SET state=$2,updated_at=now(),version=version+1 WHERE quote_case_id=$1', [row.quote_case_id, quoteStatus]);
      await client.query(`UPDATE crm_sales_cases SET next_action=$2,latest_summary=$3,updated_at=now() WHERE case_id=$1`, [row.case_id, action === 'approve' ? '发送报价' : '修改报价并重新提交', action === 'approve' ? '报价已通过主管确认' : '主管退回报价，需要修改']);
      await client.query(`INSERT INTO crm_case_events(case_id,event_key,event_type,source,payload_json,evidence_json,actor_user_id)
        VALUES($1,$2,$3,'user',$4,'[]'::jsonb,$5) ON CONFLICT(event_key) DO NOTHING`,
        [row.case_id, `quote.review.${status}:${reviewId}`, action === 'approve' ? 'quote.confirmed' : 'quote.rejected', JSON.stringify({ reviewId, action, note: note || null }), actor.userId]);
      await client.query('COMMIT');
      return success({
        reviewId: String(updated.review_id), quoteId: String(updated.quote_id), requestedBy: String(updated.requested_by),
        reviewerUserId: String(updated.reviewer_user_id), status: updated.status, reason: updated.reason || null,
        decisionNote: updated.decision_note || null, linkedMessageId: updated.linked_message_id || null,
        linkedTaskId: updated.linked_task_id || null, createdAt: ISO(updated.created_at)!, decidedAt: ISO(updated.decided_at),
      });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* transaction may already be closed */ }
      this.log.write('ERROR', 'quote-case.pg', `报价审核处理失败 code=${(error as any)?.code || 'UNKNOWN'}`);
      return failure('DATABASE_ERROR', '报价审核处理失败');
    } finally { client.release(); }
  }

  private mapReviewItem(row: Record<string, any>): QuoteReviewListItem {
    return {
      reviewId: String(row.review_id), quoteId: String(row.quote_id), requestedBy: String(row.requested_by),
      reviewerUserId: String(row.reviewer_user_id), status: row.status, reason: row.reason || null,
      decisionNote: row.decision_note || null, linkedMessageId: row.linked_message_id || null,
      linkedTaskId: row.linked_task_id || null, createdAt: ISO(row.created_at)!, decidedAt: ISO(row.decided_at),
      quoteCaseId: String(row.quote_case_id), caseId: String(row.case_id), requestedByName: String(row.requested_by_name || ''),
      customerName: String(row.customer_name || ''), subject: row.subject ? String(row.subject) : null,
      selectedCandidate: mapCandidate(row.selected_candidate_json),
      candidates: Array.isArray(row.candidates_json) ? row.candidates_json.map(mapCandidate).filter((item): item is QuoteCandidate => !!item) : [],
    };
  }
}
