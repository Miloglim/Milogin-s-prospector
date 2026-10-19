import {
  CRM_STAGES, CONTACT_PAGE_DEFAULT, CONTACT_PAGE_MAX, FIELD_TEXT_MAX, FOLLOWUP_TEXT_MAX, failure,
  type CompanyDraft, type ContactDraft, type ContactQuery, type CrmRepository, type CrmStage, type JsonValue,
} from "../core/crm";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_JSON_DEPTH = 20;
const positiveId = (id: number) => Number.isSafeInteger(id) && id > 0;
function jsonSafe(value: unknown, seen = new Set<object>(), depth = 0): value is JsonValue {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  seen.add(value);
  const safe = Object.values(value).every(v => jsonSafe(v, seen, depth + 1));
  seen.delete(value);
  return safe;
}
function fieldsSafe(input: object): boolean {
  return Object.values(input).every(v => typeof v !== "string" || v.length <= FIELD_TEXT_MAX);
}

/** Use cases depend only on the contract. No DB, files, clock, HTTP or Electron IO. */
export function createCrmService(repository: CrmRepository) {
  return {
    createCompany(input: CompanyDraft) {
      if (!input.name?.trim() || !fieldsSafe(input) || (input.backcheckData != null && !jsonSafe(input.backcheckData))) {
        return Promise.resolve(failure("INVALID_INPUT", "公司资料无效"));
      }
      return repository.createCompany({ ...input, name: input.name.trim() });
    },
    createContact(input: ContactDraft) {
      const email = input.email?.trim().toLowerCase();
      if (!email || !EMAIL_PATTERN.test(email) || !fieldsSafe(input)
        || (input.companyId != null && !positiveId(input.companyId))
        || (input.tags && (!Array.isArray(input.tags) || input.tags.some(t => !CRM_STAGES.includes(t))))
        || (input.extra != null && (!jsonSafe(input.extra) || Array.isArray(input.extra) || typeof input.extra !== "object"))) {
        return Promise.resolve(failure("INVALID_INPUT", "联系人资料无效"));
      }
      return repository.createContact({ ...input, email });
    },
    getContact(id: number) {
      return positiveId(id) ? repository.getContact(id) : Promise.resolve(failure("INVALID_INPUT", "联系人 ID 无效"));
    },
    listContacts(query: ContactQuery = {}) {
      const limit = query.limit ?? CONTACT_PAGE_DEFAULT;
      const offset = query.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > CONTACT_PAGE_MAX
        || !Number.isSafeInteger(offset) || offset < 0 || (query.search?.length ?? 0) > FIELD_TEXT_MAX) {
        return Promise.resolve(failure("INVALID_INPUT", "分页或搜索条件无效"));
      }
      return repository.listContacts({ search: query.search?.trim() ?? "", limit, offset });
    },
    addFollowup(id: number, note: string) {
      if (!positiveId(id) || !note?.trim() || note.length > FOLLOWUP_TEXT_MAX) {
        return Promise.resolve(failure("INVALID_INPUT", "跟进内容或联系人 ID 无效"));
      }
      return repository.addFollowup(id, note.trim());
    },
    changeStage(id: number, stage: string) {
      if (!positiveId(id) || !CRM_STAGES.includes(stage as CrmStage)) {
        return Promise.resolve(failure("INVALID_INPUT", "CRM 阶段或联系人 ID 无效"));
      }
      return repository.changeStage(id, stage as CrmStage);
    },
    listInteractions(id: number) {
      return positiveId(id) ? repository.listInteractions(id) : Promise.resolve(failure("INVALID_INPUT", "联系人 ID 无效"));
    },
  };
}
