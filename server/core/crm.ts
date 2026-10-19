/** PostgreSQL foundation contracts. No runtime, database or framework imports. */
export const CRM_STAGES = ["reaching", "quoting", "trial", "cooperating", "lost", "other"] as const;
export type CrmStage = typeof CRM_STAGES[number];
export const CONTACT_PAGE_MAX = 100;
export const CONTACT_PAGE_DEFAULT = 25;
export const FIELD_TEXT_MAX = 4096;
export const FOLLOWUP_TEXT_MAX = 20000;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type ErrorCode = "INVALID_INPUT" | "NOT_FOUND" | "CONFLICT" | "DATABASE_ERROR"
  | "UNAUTHORIZED" | "FORBIDDEN" | "RATE_LIMITED" | "UNAVAILABLE" | "PAYLOAD_TOO_LARGE" | "PASSWORD_CHANGE_REQUIRED";
export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: ErrorCode; message: string } };
export const success = <T>(data: T): Result<T> => ({ ok: true, data });
export const failure = (code: ErrorCode, message: string): Result<never> => ({ ok: false, error: { code, message } });
export interface LogSink { write(level: "INFO" | "WARN" | "ERROR", context: string, message: string): void; }

export interface CompanyDraft {
  name: string; domain?: string | null; country?: string | null;
  industry?: string | null; size?: string | null; backcheckData?: JsonObject | null;
}
export interface Company extends CompanyDraft { id: number; createdAt: string; updatedAt: string; }
export interface ContactDraft {
  email: string; companyId?: number | null; firstName?: string | null; lastName?: string | null;
  title?: string | null; phone?: string | null; linkedinUrl?: string | null; country?: string | null;
  clientType?: string | null; language?: string | null; stage?: string; status?: string;
  tags?: CrmStage[]; extra?: JsonObject; assignee?: string; source?: string; sourceDetail?: string | null;
}
export interface Contact extends ContactDraft {
  id: number; tags: CrmStage[]; extra: JsonObject; stage: string; status: string;
  createdAt: string; updatedAt: string;
}
export interface ContactQuery { search?: string; limit?: number; offset?: number; }
export interface ContactPage { items: Contact[]; total: number; }
export interface Interaction {
  id: number; contactId: number; type: "followup" | "stage"; direction: "internal";
  channel: "crm"; bodyPreview: string | null; metadata: JsonObject; createdAt: string;
}
export interface CrmRepository {
  createCompany(input: CompanyDraft): Promise<Result<Company>>;
  createContact(input: ContactDraft): Promise<Result<Contact>>;
  getContact(id: number): Promise<Result<Contact>>;
  listContacts(query: Required<ContactQuery>): Promise<Result<ContactPage>>;
  addFollowup(contactId: number, note: string): Promise<Result<Interaction>>;
  changeStage(contactId: number, stage: CrmStage): Promise<Result<Contact>>;
  listInteractions(contactId: number): Promise<Result<Interaction[]>>;
}
