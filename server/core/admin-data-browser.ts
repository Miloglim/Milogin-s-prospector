import type { Result } from "./crm";

export type AdminDataDirection = "asc" | "desc";
export type AdminDataValueKind = "text" | "number" | "boolean" | "date" | "json" | "other";

export interface AdminDataTableInfo {
  id: string;
  group: string;
  label: string;
  description: string;
}

export interface AdminDataTableDefinition extends AdminDataTableInfo {
  schema: string;
  table: string;
  keyColumn: string;
  defaultSort: string;
  defaultDirection: AdminDataDirection;
}

export interface AdminDataColumn {
  key: string;
  label: string;
  type: string;
  kind: AdminDataValueKind;
  sortable: boolean;
  searchable: boolean;
}

export interface AdminDataQuery {
  table: string;
  search: string;
  limit: number;
  offset: number;
  sort?: string;
  direction?: AdminDataDirection;
}

export interface AdminDataPage {
  table: AdminDataTableInfo;
  columns: AdminDataColumn[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
  search: string;
  sort: string;
  direction: AdminDataDirection;
  keyColumn: string;
}

export interface AdminDataBrowserRepository {
  dataTables(tokenHash: string): Promise<Result<AdminDataTableInfo[]>>;
  dataPage(tokenHash: string, query: AdminDataQuery): Promise<Result<AdminDataPage>>;
}

export const ADMIN_DATA_BROWSER_LIMITS = {
  page: 25,
  pageMax: 100,
  pageSizes: [25, 50, 100],
  searchMax: 254,
  statement_timeout_seconds: 5,
} as const;

/** Security, token, challenge, and refresh-credential tables are intentionally absent. */
export const ADMIN_DATA_TABLES: readonly AdminDataTableDefinition[] = [
  { id: "identity.users", group: "账号与权限", label: "用户", description: "中心账号、启用状态与权限修订", schema: "identity", table: "users", keyColumn: "user_id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "identity.login_emails", group: "账号与权限", label: "登录邮箱", description: "账号登录邮箱与验证状态", schema: "identity", table: "login_emails", keyColumn: "email", defaultSort: "email", defaultDirection: "asc" },
  { id: "identity.products", group: "账号与权限", label: "产品", description: "统一管理中心产品目录", schema: "identity", table: "products", keyColumn: "product_id", defaultSort: "product_id", defaultDirection: "asc" },
  { id: "identity.product_grants", group: "账号与权限", label: "产品角色", description: "用户在各产品中的角色授权", schema: "identity", table: "product_grants", keyColumn: "user_id", defaultSort: "user_id", defaultDirection: "asc" },
  { id: "identity.product_access", group: "账号与权限", label: "产品准入", description: "产品启用状态、数据范围与能力", schema: "identity", table: "product_access", keyColumn: "user_id", defaultSort: "user_id", defaultDirection: "asc" },
  { id: "identity.management_audit", group: "账号与权限", label: "管理审计", description: "中心后台管理动作与原因", schema: "identity", table: "management_audit", keyColumn: "id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "public.companies", group: "客户与联系人", label: "公司", description: "共享公司主档与背调资料", schema: "public", table: "companies", keyColumn: "id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "public.contacts", group: "客户与联系人", label: "联系人", description: "中心联系人主档与联系状态", schema: "public", table: "contacts", keyColumn: "id", defaultSort: "updated_at", defaultDirection: "desc" },
  { id: "public.crm_customers", group: "客户与联系人", label: "客户", description: "客户容器、归属、来源与关系阶段", schema: "public", table: "crm_customers", keyColumn: "customer_id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "public.crm_customer_contacts", group: "客户与联系人", label: "客户联系人", description: "客户容器与联系人的归属关系", schema: "public", table: "crm_customer_contacts", keyColumn: "contact_id", defaultSort: "contact_id", defaultDirection: "asc" },
  { id: "public.crm_contact_assignment_requests", group: "协作与跟进", label: "线索分配", description: "联系人分配请求与接受状态", schema: "public", table: "crm_contact_assignment_requests", keyColumn: "request_id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "public.crm_contact_shares", group: "协作与跟进", label: "联系人共享", description: "联系人字段、跟进与阶段协作授权", schema: "public", table: "crm_contact_shares", keyColumn: "share_id", defaultSort: "created_at", defaultDirection: "desc" },
  { id: "public.crm_followup_tasks", group: "协作与跟进", label: "跟进任务", description: "开放与已完成的客户跟进任务", schema: "public", table: "crm_followup_tasks", keyColumn: "task_id", defaultSort: "updated_at", defaultDirection: "desc" },
  { id: "public.crm_opportunities", group: "协作与跟进", label: "商机", description: "客户商机、阶段、金额与关闭结果", schema: "public", table: "crm_opportunities", keyColumn: "opportunity_id", defaultSort: "updated_at", defaultDirection: "desc" },
  { id: "public.crm_import_batches", group: "协作与跟进", label: "导入批次", description: "客户导入批次与字段映射，不展示原始行", schema: "public", table: "crm_import_batches", keyColumn: "batch_id", defaultSort: "created_at", defaultDirection: "desc" },
] as const;

const COLUMN_LABELS: Readonly<Record<string, string>> = {
  user_id: "用户 ID", display_name: "姓名", email: "邮箱", verified_at: "邮箱验证时间",
  active: "启用", identity_admin: "超级管理员", security_revision: "安全修订",
  management_revision: "管理修订", must_change_password: "必须改密", deleted_at: "归档时间",
  product_id: "产品", name: "名称", connected: "已连接", description: "说明", role: "角色",
  scope: "数据范围", capabilities: "能力", actor_id: "操作人", target_id: "目标用户",
  action: "动作", reason: "原因", created_at: "创建时间", updated_at: "更新时间",
  id: "ID", company_id: "公司 ID", domain: "域名", industry: "行业", country: "国家",
  size: "规模", backcheck_data: "背调资料", first_name: "名", last_name: "姓",
  title: "职位 / 标题", phone: "电话", linkedin: "LinkedIn", client_type: "客户类型",
  language: "语言", stage: "阶段", status: "状态", tags: "标签", extra: "扩展字段",
  assignee: "原归属", source: "来源", source_detail: "来源说明", crm_touch_status: "联系状态",
  crm_contact_version: "联系人版本", customer_id: "客户 ID", customer_key: "客户来源键",
  owner_user_id: "负责人", created_by: "创建人", version: "版本", origin: "身份来源",
  business_type: "业务类型", development_restriction: "开发限制", source_created_at: "来源创建时间",
  relationship_stage: "关系阶段", stage_needs_review: "阶段待复核", legacy_stage_snapshot: "历史阶段快照",
  contact_id: "联系人 ID", request_id: "分配请求 ID", target_user_id: "目标用户",
  notify_user_ids: "通知用户", decided_at: "决定时间", share_id: "共享 ID",
  grantor_user_id: "授权人", editable_fields: "可编辑字段", can_followup: "可跟进",
  can_change_stage: "可改阶段", task_id: "任务 ID", opportunity_id: "商机 ID", due_at: "到期时间",
  completed_at: "完成时间", completed_by: "完成人", feedback: "反馈", pol: "起运港", pod: "目的港",
  container_type: "箱型", amount: "金额", currency: "币种", lost_reason: "丢单原因",
  evidence: "赢单证据", closed_at: "关闭时间", closed_by: "关闭人", batch_id: "批次 ID",
  mapping: "字段映射",
};

const SENSITIVE_COLUMN = /(?:^|_)(password|passwd|token|secret|hash|credential|challenge)(?:_|$)/i;

export function findAdminDataTable(id: string): AdminDataTableDefinition | undefined {
  return ADMIN_DATA_TABLES.find(table => table.id === id);
}

export function adminDataTableInfo(table: AdminDataTableDefinition): AdminDataTableInfo {
  return { id: table.id, group: table.group, label: table.label, description: table.description };
}

export function isSafeAdminDataColumn(name: string): boolean {
  return !SENSITIVE_COLUMN.test(name);
}

export function adminDataColumnLabel(name: string): string {
  return COLUMN_LABELS[name] ?? name;
}

export function adminDataValueKind(type: string): AdminDataValueKind {
  if (["smallint", "integer", "bigint", "decimal", "numeric", "real", "double precision"].includes(type)) return "number";
  if (type === "boolean") return "boolean";
  if (type === "date" || type.startsWith("timestamp")) return "date";
  if (type === "json" || type === "jsonb") return "json";
  if (["text", "character varying", "character", "uuid"].includes(type)) return "text";
  return "other";
}

/** Database browsing is stricter than the general management dashboard read permission. */
export function canReadAdminData(actor: { identityAdmin: boolean }): boolean {
  return actor.identityAdmin;
}
