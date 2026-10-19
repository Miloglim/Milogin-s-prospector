import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  success, failure, type Result, type CompanyDraft, type Company, type ContactDraft, type Contact,
  type ContactQuery, type ContactPage, type CrmRepository, type CrmStage, type Interaction, type LogSink,
} from "../../core/crm";
import { CRM_SCHEMA_SQL, CRM_SCHEMA_VERSION, CRM_SCHEMA_LOCK } from "./schema";
import { assertCenterDatabasePool } from "./config";

type Row = Record<string, unknown>;
const COMPANY_COLUMNS = `id, name, domain, industry, country, size, backcheck_data AS "backcheckData",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const CONTACT_COLUMNS = `id, COALESCE(email,'') AS email, company_id AS "companyId", first_name AS "firstName", last_name AS "lastName",
  title, phone, linkedin AS "linkedinUrl", country, client_type AS "clientType", language, stage, status, tags,
  extra, assignee, source, source_detail AS "sourceDetail", created_at AS "createdAt", updated_at AS "updatedAt"`;
const INTERACTION_COLUMNS = `id, contact_id AS "contactId", type, direction, channel,
  body_preview AS "bodyPreview", metadata, created_at AS "createdAt"`;
const EMAIL_CONFLICT = "23505";
const FOREIGN_KEY_ERROR = "23503";
const CHECK_ERROR = "23514";
function dates<T>(row: Row): T {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value])) as T;
}
function sqlCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]+$/.test(error.code)) return error.code;
  return "UNKNOWN";
}
function literalSearch(text: string) { return `%${text.replace(/[\\%_]/g, "\\$&")}%`; }

export class PostgresCrmRepository implements CrmRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) {
    assertCenterDatabasePool(pool);
    pool.on("error", error => { this.log.write("ERROR", "crm.pg.pool", `闲置连接错误 code=${sqlCode(error)}`); });
  }
  private async execute<T>(context: string, action: () => Promise<Result<T>>): Promise<Result<T>> {
    try { return await action(); }
    catch (error) {
      const code = sqlCode(error);
      this.log.write("ERROR", context, `数据库操作失败 code=${code}`);
      if (code === EMAIL_CONFLICT) return failure("CONFLICT", "资料已存在，未覆盖现有记录");
      if (code === FOREIGN_KEY_ERROR || code === CHECK_ERROR) return failure("INVALID_INPUT", "资料引用或约束无效");
      return failure("DATABASE_ERROR", "数据库操作失败，请检查测试服务状态");
    }
  }
  private async transaction<T>(action: (client: PoolClient) => Promise<Result<T>>): Promise<Result<T>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query(result.ok ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { this.log.write("ERROR", "crm.pg.rollback", `回滚失败 code=${sqlCode(rollbackError)}`); }
      throw error;
    } finally { client.release(); }
  }
  migrate(): Promise<Result<void>> {
    return this.execute("crm.pg.migrate", () => this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [CRM_SCHEMA_LOCK]);
      await client.query(`CREATE TABLE IF NOT EXISTS crm_schema_migrations (
        version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const checksum = createHash("sha256").update(CRM_SCHEMA_SQL).digest("hex");
      const existing = await client.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1", [CRM_SCHEMA_VERSION]);
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) return failure("CONFLICT", "已应用迁移校验不一致，拒绝覆盖");
      } else {
        await client.query(CRM_SCHEMA_SQL);
        await client.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES ($1,$2)", [CRM_SCHEMA_VERSION, checksum]);
        this.log.write("INFO", "crm.pg.migrate", `迁移完成 version=${CRM_SCHEMA_VERSION}`);
      }
      return success(undefined);
    }));
  }
  createCompany(input: CompanyDraft): Promise<Result<Company>> {
    return this.execute("crm.pg.company", async () => {
      const result = await this.pool.query(`INSERT INTO companies(name,domain,industry,country,size,backcheck_data)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING ${COMPANY_COLUMNS}`,
      [input.name,input.domain ?? null,input.industry ?? null,input.country ?? null,input.size ?? null,
        input.backcheckData == null ? null : JSON.stringify(input.backcheckData)]);
      return success(dates<Company>(result.rows[0]));
    });
  }
  createContact(input: ContactDraft): Promise<Result<Contact>> {
    return this.execute("crm.pg.contact", async () => {
      const result = await this.pool.query(`INSERT INTO contacts(email,company_id,first_name,last_name,title,phone,
        linkedin,country,client_type,language,stage,status,tags,extra,assignee,source,source_detail)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING ${CONTACT_COLUMNS}`,
      [input.email,input.companyId ?? null,input.firstName ?? null,input.lastName ?? null,input.title ?? null,
        input.phone ?? null,input.linkedinUrl ?? null,input.country ?? null,input.clientType ?? null,input.language ?? null,
        input.stage ?? "cold",input.status ?? "",JSON.stringify(input.tags ?? []),JSON.stringify(input.extra ?? {}),
        input.assignee ?? "",input.source ?? "manual",input.sourceDetail ?? null]);
      return success(dates<Contact>(result.rows[0]));
    });
  }
  getContact(id: number): Promise<Result<Contact>> {
    return this.execute("crm.pg.getContact", async () => {
      const result = await this.pool.query(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id=$1`, [id]);
      return result.rows.length ? success(dates<Contact>(result.rows[0])) : failure("NOT_FOUND", "联系人不存在");
    });
  }
  listContacts(query: Required<ContactQuery>): Promise<Result<ContactPage>> {
    return this.execute("crm.pg.listContacts", () => this.transaction(async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const filter = `WHERE ($1 = '' OR email ILIKE $2 ESCAPE '\\' OR first_name ILIKE $2 ESCAPE '\\'
        OR last_name ILIKE $2 ESCAPE '\\')`;
      const params = [query.search, literalSearch(query.search)];
      const count = await client.query(`SELECT count(*)::int AS total FROM contacts ${filter}`, params);
      const rows = await client.query(`SELECT ${CONTACT_COLUMNS} FROM contacts ${filter}
        ORDER BY updated_at DESC,id DESC LIMIT $3 OFFSET $4`, [...params,query.limit,query.offset]);
      return success({ items: rows.rows.map(row => dates<Contact>(row)), total: count.rows[0].total as number });
    }));
  }
  addFollowup(contactId: number, note: string): Promise<Result<Interaction>> {
    return this.execute("crm.pg.followup", () => this.transaction(async client => {
      const contact = await client.query("SELECT id FROM contacts WHERE id=$1 FOR KEY SHARE", [contactId]);
      if (!contact.rows.length) return failure("NOT_FOUND", "联系人不存在");
      const result = await client.query(`INSERT INTO interactions(contact_id,type,body_preview)
        VALUES($1,'followup',$2) RETURNING ${INTERACTION_COLUMNS}`, [contactId,note]);
      return success(dates<Interaction>(result.rows[0]));
    }));
  }
  changeStage(contactId: number, stage: CrmStage): Promise<Result<Contact>> {
    return this.execute("crm.pg.stage", () => this.transaction(async client => {
      const before = await client.query("SELECT tags FROM contacts WHERE id=$1 FOR UPDATE", [contactId]);
      if (!before.rows.length) return failure("NOT_FOUND", "联系人不存在");
      const previous = before.rows[0].tags as CrmStage[];
      if (previous.length === 1 && previous[0] === stage) {
        const unchanged = await client.query(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id=$1`, [contactId]);
        return success(dates<Contact>(unchanged.rows[0]));
      }
      const updated = await client.query(`UPDATE contacts SET tags=$2,updated_at=clock_timestamp()
        WHERE id=$1 RETURNING ${CONTACT_COLUMNS}`, [contactId,JSON.stringify([stage])]);
      await client.query("INSERT INTO interactions(contact_id,type,metadata) VALUES($1,'stage',$2)",
        [contactId,JSON.stringify({ from: previous, to: stage })]);
      return success(dates<Contact>(updated.rows[0]));
    }));
  }
  listInteractions(contactId: number): Promise<Result<Interaction[]>> {
    return this.execute("crm.pg.timeline", async () => {
      const result = await this.pool.query(`SELECT ${INTERACTION_COLUMNS} FROM interactions WHERE contact_id=$1 ORDER BY id DESC`, [contactId]);
      return success(result.rows.map(row => dates<Interaction>(row)));
    });
  }
}
