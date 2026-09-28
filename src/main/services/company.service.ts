import { getDb, getRawDb } from "../db";
import { companies, type CompanyRow, type InsertCompanyRow } from "../db/schema/companies";
import { contacts } from "../db/schema/contacts";
import { interactions } from "../db/schema/interactions";
import { eq, like, or, and, sql, count } from "drizzle-orm";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import { saveDatabase } from "../db";
import { deleteContactCascade } from "./contact.service";
import { classifyClientType, type ClientType } from "./client-type.service";

export async function getCompanyById(id: number): Promise<Result<CompanyRow>> {
  Log.debug("company.getById", `id=${id}`);

  const row = getDb().select().from(companies).where(eq(companies.id, id)).get();

  if (!row) {
    return failResult(`公司不存在: id=${id}`);
  }

  return okResult(row);
}

export async function listCompanies(search?: string): Promise<Result<CompanyRow[]>> {
  Log.debug("company.list", `search=${search}`);

  let query = getDb().select().from(companies);

  if (search?.trim()) {
    const pattern = `%${search.trim()}%`;
    query = query.where(
      or(like(companies.name, pattern), like(companies.domain, pattern))
    ) as typeof query;
  }

  const rows = query.orderBy(sql`${companies.updatedAt} DESC`).all();
  return okResult(rows);
}

export async function upsertCompany(
  input: Partial<InsertCompanyRow> & { id?: number; name?: string }
): Promise<Result<CompanyRow>> {
  if (!input?.name) return failResult("公司名必填");

  const result = await (async () => {
    const name = input.name || "";
    if (input.id) {
      const existing = getDb().select().from(companies).where(eq(companies.id, input.id)).get();
      if (!existing) return failResult(`公司不存在: id=${input.id}`);

      getDb().update(companies).set({ ...input }).where(eq(companies.id, input.id)).run();
      saveDatabase();
      return okResult(getDb().select().from(companies).where(eq(companies.id, input.id)).get()!);
    } else {
      const existing = getDb().select().from(companies).where(eq(companies.name, name)).get();
      if (existing) return okResult(existing);

      getDb().insert(companies).values({
        name: name,
        domain: input.domain ?? null,
        industry: input.industry ?? null,
        country: input.country ?? null,
        size: input.size ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as InsertCompanyRow).run();
      saveDatabase();
      return okResult(getDb().select().from(companies).where(eq(companies.name, name)).get()!);
    }
  })();
  return result;
}

export interface CompanyWithCounts {
  id: number; name: string; domain: string | null; industry: string | null;
  country: string | null; size: string | null;
  contactCount: number; sentCount: number; repliedCount: number;
  createdAt: string; updatedAt: string;
}

/** 公司列表 — 含联系人数量和发送统计。分页，用 SQL 子查询避免循环查 DB */
export function listCompaniesWithCounts(search?: string, page = 1, pageSize = 100): Result<{ items: CompanyWithCounts[]; total: number }> {
  const db = getDb();
  const safePage = Math.max(1, page);
  const safeSize = Math.min(Math.max(1, pageSize), 200);
  const offset = (safePage - 1) * safeSize;

  // 用 SQL 子查询一次性拿到每个公司的统计，避免 O(n) 次 DB 查询
  const sdb = getRawDb();
  const searchTerm = search?.trim() ? `%${search.trim()}%` : null;

  const dataParams = searchTerm ? [searchTerm, searchTerm, safeSize, offset] : [safeSize, offset];
  const rows = sdb.prepare(`
    SELECT
      c.id, c.name, c.domain, c.industry, c.country, c.size,
      c.created_at AS createdAt, c.updated_at AS updatedAt,
      COUNT(DISTINCT co.id) AS contactCount,
      COUNT(DISTINCT CASE WHEN i.type = 'sent' THEN i.id END) AS sentCount,
      COUNT(DISTINCT CASE WHEN i.type = 'replied' THEN i.id END) AS repliedCount
    FROM companies c
    INNER JOIN contacts co ON co.company_id = c.id
    LEFT JOIN interactions i ON i.contact_id = co.id
    ${searchTerm ? `WHERE (c.name LIKE ? OR c.domain LIKE ?)` : ""}
    GROUP BY c.id
    HAVING contactCount > 0
    ORDER BY c.updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...dataParams) as Array<Record<string, unknown>>;

  // 总数
  const countParams = searchTerm ? [searchTerm, searchTerm] : [];
  const cntObj = sdb.prepare(`
    SELECT COUNT(DISTINCT c.id) AS cnt
    FROM companies c
    INNER JOIN contacts co ON co.company_id = c.id
    ${searchTerm ? `WHERE (c.name LIKE ? OR c.domain LIKE ?)` : ""}
  `).get(...countParams) as { cnt: number } | undefined;

  const items: CompanyWithCounts[] = rows.map(r => ({
    id: Number(r.id), name: String(r.name || ""), domain: r.domain as string | null,
    industry: r.industry as string | null, country: r.country as string | null, size: r.size as string | null,
    contactCount: Number(r.contactCount),
    sentCount: Number(r.sentCount),
    repliedCount: Number(r.repliedCount),
    createdAt: String(r.createdAt || ""), updatedAt: String(r.updatedAt || ""),
  }));

  return okResult({ items, total: Number(cntObj?.cnt) || 0 });
}

export interface CompanyDetail {
  company: CompanyRow;
  contacts: Array<{
    id: number; email: string; firstName: string | null; lastName: string | null;
    title: string | null; phone: string | null; stage: string | null; status: string | null;
  }>;
  sentCount: number; repliedCount: number;
}

/** 公司详情 — 含联系人列表和发送统计 */
export function getCompanyDetail(companyId: number): Result<CompanyDetail> {
  const db = getDb();
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) return failResult("公司不存在");

  const contactRows = db.select({
    id: contacts.id, email: contacts.email,
    firstName: contacts.firstName, lastName: contacts.lastName,
    title: contacts.title, phone: contacts.phone, stage: contacts.stage, status: contacts.status,
  }).from(contacts).where(eq(contacts.companyId, companyId)).all();

  const contactIds = contactRows.map(r => r.id);
  let sentCount = 0, repliedCount = 0;
  if (contactIds.length > 0) {
    const sentRow = db.select({ n: count() }).from(interactions)
      .where(and(eq(interactions.contactId, contactIds[0]!), eq(interactions.type, "sent"))).get();
    sentCount = sentRow?.n || 0;
    const repliedRow = db.select({ n: count() }).from(interactions)
      .where(and(eq(interactions.contactId, contactIds[0]!), eq(interactions.type, "replied"))).get();
    repliedCount = repliedRow?.n || 0;
  }

  return okResult({ company, contacts: contactRows, sentCount, repliedCount });
}

export interface SavedBackcheck {
  id: number;
  clientType: ClientType;
}

/** 保存背调报告，并同步可识别的客户类型到该公司的联系人。 */
export function saveBackcheck(input: { name: string; domain?: string; report: unknown }): Result<SavedBackcheck> {
  Log.debug("company.saveBackcheck", `name=${input.name}`);
  const name = input.name.trim();
  if (!name) return failResult("公司名必填");

  let backcheckData: string | undefined;
  try {
    backcheckData = JSON.stringify(input.report);
  } catch (error) {
    Log.warn("company.saveBackcheck", `报告无法序列化: ${error instanceof Error ? error.message : String(error)}`);
    return failResult("背调报告无法保存");
  }
  if (backcheckData === undefined) return failResult("背调报告不能为空");

  const db = getDb();
  const now = new Date().toISOString();
  let company = db.select().from(companies).where(eq(companies.name, name)).get();
  if (company) {
    db.update(companies).set({
      domain: input.domain ?? company.domain,
      backcheckData,
      updatedAt: now,
    }).where(eq(companies.id, company.id)).run();
  } else {
    db.insert(companies).values({
      name,
      domain: input.domain ?? null,
      backcheckData,
      createdAt: new Date().toISOString(),
      updatedAt: now,
    } as InsertCompanyRow).run();
    company = db.select().from(companies).where(eq(companies.name, name)).get()!;
  }

  const clientType = classifyClientType(name);
  if (clientType) {
    db.update(contacts).set({ clientType, updatedAt: now })
      .where(eq(contacts.companyId, company.id)).run();
  }
  saveDatabase();
  return okResult({ id: company.id, clientType });
}

/** 读取已保存的背调报告。坏数据只影响本次读取，不能阻断开发信起草。 */
export function getBackcheckReport(name: string): unknown | null {
  const normalizedName = name.trim();
  if (!normalizedName) return null;

  const company = getDb().select({ backcheckData: companies.backcheckData })
    .from(companies).where(eq(companies.name, normalizedName)).get();
  if (!company?.backcheckData) return null;

  try {
    return JSON.parse(company.backcheckData);
  } catch (error) {
    Log.warn("company.getBackcheckReport", `报告 JSON 无法解析: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function deleteCompany(id: number): Promise<Result<void>> {
  Log.debug("company.delete", `id=${id}`);
  if (!Number.isInteger(id) || id <= 0) return failResult(`无效的 ID: ${id}`);

  const existing = getDb().select().from(companies).where(eq(companies.id, id)).get();
  if (!existing) return failResult(`公司不存在: id=${id}`);

  // 连带删除该公司下所有联系人（含各自子表级联）
  const contactIds = getDb().select({ id: contacts.id })
    .from(contacts).where(eq(contacts.companyId, id)).all();
  for (const c of contactIds) deleteContactCascade(c.id);

  getDb().delete(companies).where(eq(companies.id, id)).run();
  saveDatabase();
  Log.debug("company.delete", `公司 ${id} 及 ${contactIds.length} 个联系人已删除`);
  return okResult(undefined);
}
