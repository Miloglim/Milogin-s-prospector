import { drizzle } from "drizzle-orm/better-sqlite3";
import type { Database as RawDb } from "better-sqlite3";
import * as schema from "./schema";
import { DB_PATH } from "../config";
import { Log } from "../logger";
import { migrateTagsValue } from "./tags-migrate";
import { BASE_SCHEMA_SQL } from "./schema-sql";
import * as path from "path";
import * as fs from "fs";

// ── P1-1：sql.js（内存全量导出）→ better-sqlite3（原生绑定，逐事务落盘 + 真 WAL）──
// 懒加载 require：原生绑定只在 initDatabase() 运行时加载（Electron ABI 编译产物），
// vitest 等 Node 环境 import 本模块不会触发原生加载，单测不受 ABI 影响。

type DrizzleDB = ReturnType<typeof drizzle<typeof schema>>;

let dbInstance: DrizzleDB | null = null;
let rawDb: RawDb | null = null;

/** 初始化数据库 — 必须在 app ready 后调用一次 */
export async function initDatabase(): Promise<DrizzleDB> {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  Log.info("db.init", `数据库路径: ${DB_PATH}`);

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3Ctor = require("better-sqlite3") as typeof import("better-sqlite3");
  const opened: RawDb = new BetterSqlite3Ctor(DB_PATH); // 文件不存在则创建；存在直接打开（SQLite 标准格式，旧库零转换）
  rawDb = opened;
  opened.pragma("journal_mode = WAL");     // 这次是真 WAL：读写不互斥、崩溃可恢复
  opened.pragma("foreign_keys = ON");
  opened.pragma("busy_timeout = 5000");
  opened.pragma("cache_size = -64000");        // 64MB page cache (KB)
  opened.pragma("mmap_size = 268435456");      // 256MB mmap for faster reads
  opened.pragma("wal_autocheckpoint = 1000");  // WAL auto-checkpoint every 1000 pages
  opened.pragma("synchronous = NORMAL");       // safe under WAL (lose last commit at worst, no corruption)
  const ver = (opened.prepare("SELECT sqlite_version() AS v").get() as { v: string }).v;
  Log.info("db.init", `better-sqlite3 就绪（SQLite ${ver}，WAL 模式）`);

  dbInstance = drizzle(opened, { schema });
  return dbInstance;
}

/** 获取数据库实例（需先 initDatabase） */
export function getDb(): DrizzleDB {
  if (!dbInstance) throw new Error("数据库未初始化，先调用 initDatabase()");
  return dbInstance;
}

/** 获取底层 better-sqlite3 实例（直接 SQL 查询用，替代旧 getSqlJsDb） */
export function getRawDb(): RawDb {
  if (!rawDb) throw new Error("数据库未初始化，先调用 initDatabase()");
  return rawDb;
}

/** 持久化。P1-1 后每次写操作已逐事务落盘，此函数转为 WAL checkpoint —— 调用点无需改动 */
export function saveDatabase(): void {
  try {
    rawDb?.pragma("wal_checkpoint(PASSIVE)");
  } catch { /* checkpoint 失败不影响业务，WAL 会自动管理 */ }
}

/** 关闭数据库（退出时调用，确保 WAL 收尾） */
export function closeDatabase(): void {
  try { rawDb?.close(); } catch { /* 已关闭 */ }
  rawDb = null;
  dbInstance = null;
}

/** 应用启动时自动执行迁移。建表 SQL 单一事实源在 schema-sql.ts（评测沙箱共用） */
export function runMigrations(): void {
  if (!rawDb) throw new Error("数据库未初始化");
  const raw = rawDb;

  const SCHEMA_SQL = BASE_SCHEMA_SQL;

  const statements = SCHEMA_SQL.split(";").map(s => s.trim()).filter(s => s.length > 0);
  raw.exec(SCHEMA_SQL); // better-sqlite3 exec 支持多语句，一次执行

  // ── 迁移版本表（P1）：记录已应用的迁移名，幂等跳过 ──
  raw.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  const applied = new Set(
    (raw.prepare("SELECT name FROM _migrations").all() as Array<{ name: string }>).map(r => r.name),
  );
  // 命名迁移：已应用跳过；成功才记账；失败记日志并继续（与旧 try/catch 吞错语义一致）
  const step = (name: string, fn: () => void): void => {
    if (applied.has(name)) return;
    try {
      fn();
      raw.prepare("INSERT INTO _migrations (name) VALUES (?)").run(name);
      Log.info("db.migrate", `迁移完成: ${name}`);
    } catch (e) {
      Log.warn("db.migrate", `迁移失败（跳过）: ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const tableCols = (t: string): string[] =>
    (raw.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map(r => r.name);

  // 旧库列迁移 — contacts 表删除冗余字段
  step("v4.0-contacts-drop-legacy-cols", () => {
    const cols = tableCols("contacts");
    for (const col of ["is_bounced", "bounce_reason", "last_sent_at", "last_sent_acct", "followup_note"]) {
      if (cols.includes(col)) raw.exec(`ALTER TABLE contacts DROP COLUMN ${col};`);
    }
  });

  // v4.1: templates 表补 stage 列
  step("v4.1-templates-stage", () => {
    if (!tableCols("templates").includes("stage")) {
      raw.exec("ALTER TABLE templates ADD COLUMN stage text;");
    }
  });

  // 收信健康度：email_accounts 补 last_fetch_error / last_fetch_at / fetch_fail_count 列
  step("v4.x-accounts-fetch-health", () => {
    const acols = tableCols("email_accounts");
    if (!acols.includes("last_fetch_error")) { raw.exec("ALTER TABLE email_accounts ADD COLUMN last_fetch_error text;"); }
    if (!acols.includes("last_fetch_at")) { raw.exec("ALTER TABLE email_accounts ADD COLUMN last_fetch_at text;"); }
    if (!acols.includes("fetch_fail_count")) { raw.exec("ALTER TABLE email_accounts ADD COLUMN fetch_fail_count integer DEFAULT 0 NOT NULL;"); }
  });

  // v5.7 发信受阻熔断（docs/sender-block-circuit-spec.md）：email_accounts 补 circuit_reason 列
  // （send_block_events 表本身由 BASE_SCHEMA_SQL 的 CREATE TABLE IF NOT EXISTS 幂等建出）
  step("v5.7-accounts-circuit-reason", () => {
    if (!tableCols("email_accounts").includes("circuit_reason")) {
      raw.exec("ALTER TABLE email_accounts ADD COLUMN circuit_reason text;");
    }
  });

  // v4.2/v4.4: send_queue 补列
  step("v4.2-send-queue-cols", () => {
    const qcols = tableCols("send_queue");
    if (!qcols.includes("tpl_body")) raw.exec("ALTER TABLE send_queue ADD COLUMN tpl_body text;");
    if (!qcols.includes("contact_vars")) raw.exec("ALTER TABLE send_queue ADD COLUMN contact_vars text;");
    if (!qcols.includes("cc")) raw.exec("ALTER TABLE send_queue ADD COLUMN cc text;");
    if (!qcols.includes("tpl_name")) raw.exec("ALTER TABLE send_queue ADD COLUMN tpl_name text;");
    if (!qcols.includes("country")) raw.exec("ALTER TABLE send_queue ADD COLUMN country text;");
    if (!qcols.includes("language")) raw.exec("ALTER TABLE send_queue ADD COLUMN language text;");
  });

  // v4.3: inbox_messages 补 cc + my_role + related_contact_ids 列；v5.0.2 补 to（收件人，详情栏常驻显示）
  step("v4.3-inbox-cols", () => {
    const icols = tableCols("inbox_messages");
    if (!icols.includes("cc")) raw.exec("ALTER TABLE inbox_messages ADD COLUMN cc text;");
    if (!icols.includes("my_role")) raw.exec("ALTER TABLE inbox_messages ADD COLUMN my_role text;");
    if (!icols.includes("related_contact_ids")) raw.exec("ALTER TABLE inbox_messages ADD COLUMN related_contact_ids text;");
    if (!icols.includes("to")) raw.exec(`ALTER TABLE inbox_messages ADD COLUMN "to" text;`);
  });

  // v4.0: contacts 表补 language 列
  step("v4.0-contacts-language", () => {
    if (!tableCols("contacts").includes("language")) {
      raw.exec("ALTER TABLE contacts ADD COLUMN language text;");
    }
  });

  // v5.0.3: agent_conversations 补 archived_at（侧栏删除=移入归档；彻底删除只在设置页归档区）
  step("v5.0.3-agent-archived-at", () => {
    if (!tableCols("agent_conversations").includes("archived_at")) {
      raw.exec("ALTER TABLE agent_conversations ADD COLUMN archived_at text;");
    }
  });

  // v5.0.3: inbox_messages 补 intent（收信意图识别 + AI 兜底一级分类，见 docs/inbox-intent-spec.md）
  step("v5.0.3-inbox-intent", () => {
    if (!tableCols("inbox_messages").includes("intent")) {
      raw.exec("ALTER TABLE inbox_messages ADD COLUMN intent text;");
    }
  });

  // 运价镜像补列：老库缺列会让 drizzle 全列 INSERT 直接崩，必须逐列守卫
  step("v5.x-rate-quotes-cols", () => {
    const rcols = tableCols("rate_quotes");
    if (rcols.length) {
      if (!rcols.includes("etd")) { raw.exec("ALTER TABLE rate_quotes ADD COLUMN etd text;"); }
      if (!rcols.includes("status")) { raw.exec("ALTER TABLE rate_quotes ADD COLUMN status text;"); }
      if (!rcols.includes("message_text")) { raw.exec("ALTER TABLE rate_quotes ADD COLUMN message_text text;"); }
    }
  });

  // v5.8 开发任务（UI 向导创建）：send_campaigns 补 created_by/account_policy/account_ids_json/schedule_json
  step("v5.8-send-campaigns-cols", () => {
    const scols = tableCols("send_campaigns");
    if (!scols.includes("created_by")) { raw.exec("ALTER TABLE send_campaigns ADD COLUMN created_by text DEFAULT 'agent' NOT NULL;"); }
    if (!scols.includes("account_policy")) { raw.exec("ALTER TABLE send_campaigns ADD COLUMN account_policy text DEFAULT 'rotate' NOT NULL;"); }
    if (!scols.includes("account_ids_json")) { raw.exec("ALTER TABLE send_campaigns ADD COLUMN account_ids_json text;"); }
    if (!scols.includes("schedule_json")) { raw.exec("ALTER TABLE send_campaigns ADD COLUMN schedule_json text;"); }
  });

  // v5.9 任务驱动队列：send_queue 补 campaign_id（队列运行情况挂到任务卡片背后）。
  // 仅老库升级时清一次无归属 pending 组 —— 旧「独立队列页/快速发信」模式的遗留
  // （用户定案"把后台清掉"），留着反而会在下次开始发送时把旧内容发出去。
  step("v5.9-send-queue-campaign-id", () => {
    if (!tableCols("send_queue").includes("campaign_id")) {
      raw.exec("ALTER TABLE send_queue ADD COLUMN campaign_id text;");
      const cleared = raw.prepare("DELETE FROM send_queue WHERE campaign_id IS NULL AND status = 'pending'").run().changes;
      if (cleared > 0) Log.info("db.migrate", `任务驱动模式升级：清掉 ${cleared} 组无归属遗留待发组`);
    }
  });

  // v6.1 发送方式可切换（用户拍板）：send_campaigns 补 send_mode（默认 individual 单发）；
  // send_queue 补 send_mode 默认 bcc —— 存量待发组是合并语义，不能悄悄变成 To 群发
  step("v6.1-send-mode", () => {
    const scols = tableCols("send_campaigns");
    if (!scols.includes("send_mode")) {
      raw.exec("ALTER TABLE send_campaigns ADD COLUMN send_mode text DEFAULT 'individual' NOT NULL;");
    }
    const qcols = tableCols("send_queue");
    if (!qcols.includes("send_mode")) {
      raw.exec("ALTER TABLE send_queue ADD COLUMN send_mode text DEFAULT 'bcc' NOT NULL;");
    }
  });

  // v4.x: stage 大小写归一化
  step("v4.x-stage-normalize", () => {
    let n = 0;
    for (const [from, to] of [["F1", "f1"], ["F2", "f2"], ["F3", "f3"], ["F4", "f4"]]) {
      n += raw.prepare(`UPDATE contacts SET stage = ? WHERE stage = ?`).run(to, from).changes;
    }
    if (n > 0) Log.info("db.migrate", `stage 大小写归一化 ${n} 条`);
  });

  // v4.x: country 缩写归一化
  step("v4.x-country-normalize", () => {
    let n = 0;
    for (const [from, to] of [
      ["BR", "Brazil"], ["MX", "Mexico"], ["AR", "Argentina"], ["CL", "Chile"],
      ["PE", "Peru"], ["CO", "Colombia"], ["EC", "Ecuador"], ["UY", "Uruguay"],
      ["PY", "Paraguay"], ["VE", "Venezuela"], ["PA", "Panama"], ["CR", "Costa Rica"],
      ["US", "United States"], ["CA", "Canada"], ["CN", "China"], ["HK", "Hong Kong"],
      ["TW", "Taiwan"], ["JP", "Japan"], ["KR", "South Korea"], ["SG", "Singapore"],
      ["TH", "Thailand"], ["VN", "Vietnam"], ["ID", "Indonesia"], ["IN", "India"],
      ["AE", "United Arab Emirates"], ["UAE", "United Arab Emirates"],
      ["GB", "United Kingdom"], ["England", "United Kingdom"],
      ["DE", "Germany"], ["FR", "France"], ["IT", "Italy"], ["ES", "Spain"],
      ["PT", "Portugal"], ["NL", "Netherlands"], ["BE", "Belgium"],
      ["PL", "Poland"], ["RU", "Russia"], ["AU", "Australia"], ["NZ", "New Zealand"],
      ["ZA", "South Africa"], ["EG", "Egypt"],
    ]) {
      n += raw.prepare(`UPDATE contacts SET country = ? WHERE country = ?`).run(to, from).changes;
    }
    if (n > 0) Log.info("db.migrate", `country 缩写归一化 ${n} 条`);
  });

  // v4.0: tags 收敛为固定 6 值分类单选
  step("v4.0-tags-converge", () => {
    const rows = raw.prepare("SELECT id, tags, status FROM contacts").all() as
      Array<{ id: number; tags: string | null; status: string | null }>;
    for (const r of rows) {
      const oldTags = r.tags || "";
      const status = r.status || "";
      const newTags = migrateTagsValue(oldTags, status);
      if (newTags !== (oldTags || null)) {
        if (newTags === null) raw.prepare("UPDATE contacts SET tags = NULL WHERE id = ?").run(r.id);
        else raw.prepare("UPDATE contacts SET tags = ? WHERE id = ?").run(newTags, r.id);
      }
    }
  });

  // v4.1: 回填 inbox 关联（幂等）
  step("v4.1-inbox-backfill", () => {
    const bfMatched = raw.prepare(`
      UPDATE inbox_messages
      SET matched_contact_id = (
        SELECT c.id FROM contacts c
        WHERE lower(c.email) = lower(inbox_messages.from_email)
        LIMIT 1
      )
      WHERE matched_contact_id IS NULL
    `).run().changes;
    const bfInteractions = raw.prepare(`
      INSERT INTO interactions (contact_id, type, direction, channel, subject, body_preview, message_id, account_id, created_at)
      SELECT i.matched_contact_id,
             CASE i.classification WHEN 'bounce' THEN 'bounced' WHEN 'replied' THEN 'replied' WHEN 'autoreply' THEN 'autoreply' END,
             'inbound', 'email', i.subject, i.body_preview, i.message_id, i.account_id, i.received_at
      FROM inbox_messages i
      WHERE i.matched_contact_id IS NOT NULL
        AND i.classification IN ('bounce','replied','autoreply')
        AND NOT EXISTS (
          SELECT 1 FROM interactions it
          WHERE it.contact_id = i.matched_contact_id
            AND it.message_id = i.message_id
            AND it.type IN ('bounced','replied','autoreply')
        )
    `).run().changes;
    if (bfMatched > 0 || bfInteractions > 0) {
      Log.info("db.backfill", `inbox 关联回填: matched=${bfMatched} interactions=${bfInteractions}`);
    }
  });

  // v5.1 退信↔被退联系人关联表种子（幂等，规范 docs/bounce-multi-match-spec.md）：
  // 存量单列已匹配的退信各补一行；放在上面单列回填之后，让刚补出来的值也一并进表。
  // ON CONFLICT 靠表上的 UNIQUE(message_id, contact_id)。
  step("v5.1-bounce-matches-seed", () => {
    const seeded = raw.prepare(`
      INSERT INTO inbox_bounce_matches (message_id, contact_id)
      SELECT i.id, i.matched_contact_id FROM inbox_messages i
      WHERE i.classification = 'bounce' AND i.matched_contact_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM contacts c WHERE c.id = i.matched_contact_id)
      ON CONFLICT(message_id, contact_id) DO NOTHING
    `).run().changes;
    if (seeded > 0) Log.info("db.migrate", `被退联系人关联表种子 ${seeded} 条`);
  });

  Log.info("db.migrations", `${statements.length} 条建表语句已执行`);
}
