import { randomUUID } from 'node:crypto';
import type { TokenPort } from '../core/auth';
import type { Result } from '../core/crm';
import { failure } from '../core/crm';
import type { AiProposal, CreateAiProposalInput } from '../core/sales-case';
import { AI_PROPOSAL_ACTIONS, AI_PROPOSAL_TYPES, SALES_CASE_STATES, SALES_CASE_EVENT_TYPES, type SalesCaseState } from '../core/sales-case';
import type { PostgresSalesCaseRepository } from '../adapters/postgres/sales-case-repository';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export function createSalesCaseService(repo: PostgresSalesCaseRepository, tokens: TokenPort) {
  return {
    list(token: string, input: { limit?: number; offset?: number }) {
      const limit = input.limit ?? DEFAULT_LIMIT;
      const offset = input.offset ?? 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isSafeInteger(offset) || offset < 0) return Promise.resolve(failure('INVALID_INPUT', '分页参数无效'));
      return repo.list(tokens.hash(token), limit, offset);
    },
    detail(token: string, caseId: string) {
      if (!caseId.trim()) return Promise.resolve(failure('INVALID_INPUT', 'Case ID 无效'));
      return repo.detail(tokens.hash(token), caseId);
    },
    detailWithProposals(token: string, caseId: string) {
      if (!caseId.trim()) return Promise.resolve(failure('INVALID_INPUT', 'Case ID 无效'));
      return repo.detailWithProposals(tokens.hash(token), caseId);
    },
    ensure(token: string, contactId: number, customerId: string, source = 'inquiry') {
      if (!Number.isSafeInteger(contactId) || contactId < 1 || typeof customerId !== 'string' || !customerId.trim()) return Promise.resolve(failure('INVALID_INPUT', 'Case 联系人参数无效'));
      if (typeof source !== 'string' || !source.trim() || source.length > 100) return Promise.resolve(failure('INVALID_INPUT', 'Case 来源无效'));
      return repo.ensure(tokens.hash(token), contactId, customerId, source.trim());
    },
    transition(token: string, caseId: string, input: unknown) {
      if (!caseId.trim() || !input || typeof input !== 'object' || Array.isArray(input)) return Promise.resolve(failure('INVALID_INPUT', '销售 Case 推进参数无效'));
      const value = input as Record<string, unknown>;
      if (!SALES_CASE_STATES.includes(value.state as never)) return Promise.resolve(failure('INVALID_INPUT', '销售 Case 状态无效'));
      if (value.nextAction !== undefined && (typeof value.nextAction !== 'string' || value.nextAction.length > 500)) return Promise.resolve(failure('INVALID_INPUT', '下一步无效'));
      if (value.summary !== undefined && (typeof value.summary !== 'string' || value.summary.length > 2000)) return Promise.resolve(failure('INVALID_INPUT', '摘要无效'));
      if (value.eventType !== undefined && !SALES_CASE_EVENT_TYPES.includes(value.eventType as never)) return Promise.resolve(failure('INVALID_INPUT', '事件类型无效'));
      return repo.transition(tokens.hash(token), caseId, { state: value.state as SalesCaseState, nextAction: typeof value.nextAction === 'string' ? value.nextAction : null, summary: typeof value.summary === 'string' ? value.summary : null, eventType: typeof value.eventType === 'string' ? value.eventType as never : undefined, payload: value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) ? value.payload as Record<string, unknown> : {}, evidence: Array.isArray(value.evidence) ? value.evidence : [] });
    },
    listProposals(token: string, caseId: string, status?: string) {
      if (!caseId.trim()) return Promise.resolve(failure('INVALID_INPUT', 'Case ID 无效'));
      if (status !== undefined && !['pending', 'applied_pending_confirmation', 'accepted', 'edited', 'ignored', 'cancelled', 'expired', 'blocked'].includes(status)) return Promise.resolve(failure('INVALID_INPUT', '建议状态无效'));
      return repo.listProposals(tokens.hash(token), caseId, status);
    },
    proposal(token: string, caseId: string, proposalId: string) {
      if (!caseId.trim() || !proposalId.trim()) return Promise.resolve(failure('INVALID_INPUT', '建议参数无效'));
      return repo.proposal(tokens.hash(token), caseId, proposalId);
    },
    createProposal(token: string, caseId: string, input: unknown): Promise<Result<AiProposal>> {
      if (!caseId.trim()) return Promise.resolve(failure('INVALID_INPUT', 'Case ID 无效'));
      if (!input || typeof input !== 'object' || Array.isArray(input)) return Promise.resolve(failure('INVALID_INPUT', '建议内容无效'));
      const value = input as Record<string, unknown>;
      if (!AI_PROPOSAL_TYPES.includes(value.proposalType as never)) return Promise.resolve(failure('INVALID_INPUT', '建议类型无效'));
      if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) return Promise.resolve(failure('INVALID_INPUT', '建议内容无效'));
      if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) return Promise.resolve(failure('INVALID_INPUT', '建议置信度无效'));
      if (value.evidence !== undefined && (!Array.isArray(value.evidence) || value.evidence.length > 20)) return Promise.resolve(failure('INVALID_INPUT', '建议依据无效'));
      if (value.expiresAt !== undefined && value.expiresAt !== null && (typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)))) return Promise.resolve(failure('INVALID_INPUT', '建议有效期无效'));
      const parsed: CreateAiProposalInput & { proposalId: string } = {
        proposalId: randomUUID(), proposalType: value.proposalType as CreateAiProposalInput['proposalType'],
        payload: value.payload as Record<string, unknown>, evidence: value.evidence as unknown[] | undefined,
        confidence: value.confidence, model: typeof value.model === 'string' ? value.model.slice(0, 120) : null,
        version: typeof value.version === 'string' ? value.version.slice(0, 80) : null,
        expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
      };
      return repo.createProposal(tokens.hash(token), caseId, parsed);
    },
    actProposal(token: string, caseId: string, proposalId: string, input: unknown): Promise<Result<AiProposal>> {
      if (!caseId.trim() || !proposalId.trim()) return Promise.resolve(failure('INVALID_INPUT', '建议参数无效'));
      if (!input || typeof input !== 'object' || Array.isArray(input)) return Promise.resolve(failure('INVALID_INPUT', '建议操作无效'));
      const value = input as Record<string, unknown>;
      if (!AI_PROPOSAL_ACTIONS.includes(value.action as never)) return Promise.resolve(failure('INVALID_INPUT', '建议动作无效'));
      if (value.payload !== undefined && (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload))) return Promise.resolve(failure('INVALID_INPUT', '建议内容无效'));
      if (value.action === 'edit' && value.payload === undefined) return Promise.resolve(failure('INVALID_INPUT', '修改建议必须提供内容'));
      return repo.actProposal(tokens.hash(token), caseId, proposalId, value.action as 'accept' | 'edit' | 'ignore' | 'cancel', value.payload as Record<string, unknown> | undefined);
    },
  };
}

export type SalesCaseService = ReturnType<typeof createSalesCaseService>;
