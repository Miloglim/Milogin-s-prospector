import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const SOURCE_ENV = "C:\\ProgramData\\FreightRate\\freight-postgres.env";
const TARGET_CONFIG = "C:\\ProgramData\\MiloginCenter\\postgres.json";
const SOURCE_PRODUCT = "navigator";
const APPLY = process.argv.includes("--apply");
const GROWTH_LEVELS_PER_CYCLE = 50;
const GROWTH_LEVEL_BASE_XP = 12;
const GROWTH_LEVEL_MAX_XP = 30;
const GROWTH_LEGACY_XP_PER_LEVEL = 10;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const AVATAR_PATTERN = /^av(?:2-[wm]\d{2}-[1-3]|-\d{2})$/;

function log(level, message) {
  process.stdout.write(`[${new Date().toISOString()}] [account-profile.migrate] [${level}] ${message}\n`);
}

function readSourceDsn() {
  if (process.env.PROSPECTOR_ACCOUNT_MIGRATION_SOURCE_DSN) return process.env.PROSPECTOR_ACCOUNT_MIGRATION_SOURCE_DSN;
  const line = fs.readFileSync(SOURCE_ENV, "utf8").split(/\r?\n/).find(value => value.startsWith("FREIGHT_POSTGRES_DSN="));
  if (!line) throw new Error("缺少 Navigator PostgreSQL 配置");
  return line.slice("FREIGHT_POSTGRES_DSN=".length).trim();
}

function readTargetConfig() {
  const value = JSON.parse(fs.readFileSync(TARGET_CONFIG, "utf8"));
  if (value.marker !== "milogin-center-postgres-v1" || value.host !== "127.0.0.1"
    || value.port !== 55846 || value.database !== "milogin_center" || value.app !== "milogin_app"
    || typeof value.appPassword !== "string" || !value.appPassword) throw new Error("正式中心配置不匹配");
  return value;
}

function stableEventId(legacyUserId, sourceEventId) {
  const bytes = createHash("sha256").update(`${SOURCE_PRODUCT}:${legacyUserId}:${sourceEventId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function levelCost(level) {
  const index = Math.max(0, Math.min(GROWTH_LEVELS_PER_CYCLE - 1, level - 1));
  return GROWTH_LEVEL_BASE_XP + Math.floor(index * (GROWTH_LEVEL_MAX_XP - GROWTH_LEVEL_BASE_XP) / (GROWTH_LEVELS_PER_CYCLE - 1));
}

const growthLevels = Array.from({ length: GROWTH_LEVELS_PER_CYCLE }, (_, index) => levelCost(index + 1));
const GROWTH_XP_PER_CYCLE = growthLevels.reduce((sum, value) => sum + value, 0);

function thresholdForCompletedLevels(completedLevels) {
  const cycles = Math.floor(completedLevels / GROWTH_LEVELS_PER_CYCLE);
  const levels = completedLevels % GROWTH_LEVELS_PER_CYCLE;
  return cycles * GROWTH_XP_PER_CYCLE + growthLevels.slice(0, levels).reduce((sum, value) => sum + value, 0);
}

function mapLegacyXp(total) {
  if (total <= 0) return 0;
  const completed = Math.floor(total / GROWTH_LEGACY_XP_PER_LEVEL);
  const remainder = total % GROWTH_LEGACY_XP_PER_LEVEL;
  const start = thresholdForCompletedLevels(completed);
  const cost = levelCost(completed % GROWTH_LEVELS_PER_CYCLE + 1);
  return start + Math.floor(remainder * cost / GROWTH_LEGACY_XP_PER_LEVEL);
}

function growthSummary(totalXp) {
  const total = Math.max(0, Math.trunc(totalXp));
  const cycle = Math.floor(total / GROWTH_XP_PER_CYCLE) + 1;
  const withinCycle = total % GROWTH_XP_PER_CYCLE;
  let level = 1;
  let levelStartInCycle = 0;
  for (let candidate = 1; candidate <= GROWTH_LEVELS_PER_CYCLE; candidate++) {
    const cost = levelCost(candidate);
    if (withinCycle < levelStartInCycle + cost) {
      level = candidate;
      break;
    }
    levelStartInCycle += cost;
  }
  return { total, cycle, level, progress: withinCycle - levelStartInCycle, cost: levelCost(level) };
}

function businessDay(iso) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(iso));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function avatarId(preferencesJson) {
  try {
    const value = JSON.parse(preferencesJson || "{}").avatar_id;
    return typeof value === "string" && AVATAR_PATTERN.test(value) ? value : "default";
  } catch {
    return "default"; // Invalid legacy preferences stay out of shared profile data.
  }
}

function normalizeEvent(row, legacyUserId) {
  const occurredAt = new Date(row.created_at);
  const points = Number(row.points), ruleVersion = Number(row.rule_version);
  if (!row.event_type || !row.subject_key || !Number.isSafeInteger(points) || points <= 0
    || !Number.isSafeInteger(ruleVersion) || ruleVersion <= 0 || Number.isNaN(occurredAt.getTime())) {
    throw new Error(`Navigator event invalid: ${legacyUserId}/${row.event_id}`);
  }
  return {
    eventId: stableEventId(legacyUserId, String(row.event_id)),
    eventType: String(row.event_type), subjectKey: String(row.subject_key), points, ruleVersion,
    occurredAt: occurredAt.toISOString(), sourceEventId: String(row.event_id),
  };
}

async function sourceInventory(source) {
  await source.query("BEGIN READ ONLY");
  try {
    const accounts = (await source.query(`SELECT user_id::text AS legacy_user_id,name,display_name,preferences_json
      FROM operators WHERE active=1 ORDER BY user_id`)).rows;
    const events = (await source.query(`SELECT event_id,user_id::text AS legacy_user_id,event_type,subject_key,points,rule_version,created_at
      FROM account_experience_events ORDER BY user_id,created_at,event_id`)).rows;
    await source.query("COMMIT");
    return { accounts, events };
  } catch (error) {
    await source.query("ROLLBACK");
    throw error;
  }
}

async function targetInventory(target, centerIds) {
  if (!centerIds.length) return { accounts: new Map(), mappings: new Map(), events: new Map() };
  const accounts = await target.query(`SELECT u.user_id::text AS user_id,u.display_name,e.email,p.avatar_id,p.bio,
      g.total_xp,g.cycle,g.level
      FROM identity.users u JOIN identity.login_emails e USING(user_id)
      LEFT JOIN identity.user_profiles p USING(user_id)
      LEFT JOIN identity.account_growth_projection g USING(user_id)
      WHERE u.user_id=ANY($1::uuid[]) ORDER BY u.user_id,e.email`,[centerIds]);
  const mappings = await target.query(`SELECT legacy_user_id,legacy_login_alias,center_user_id::text,status
      FROM identity.legacy_account_mappings WHERE source_product=$1`,[SOURCE_PRODUCT]);
  const events = await target.query(`SELECT user_id::text,event_type,subject_key,points,rule_version,occurred_at
      FROM identity.account_experience_events WHERE source_product=$1 AND user_id=ANY($2::uuid[])`,[SOURCE_PRODUCT,centerIds]);
  const accountMap = new Map();
  for (const row of accounts.rows) {
    const existing = accountMap.get(row.user_id) ?? { ...row, emails: [] };
    existing.emails.push(row.email);
    accountMap.set(row.user_id, existing);
  }
  const eventMap = new Map(), eventsByUser = new Map();
  for (const row of events.rows) {
    eventMap.set(`${row.user_id}\0${row.event_type}\0${row.subject_key}`, row);
    const list = eventsByUser.get(row.user_id) ?? [];
    list.push(row);
    eventsByUser.set(row.user_id, list);
  }
  return {
    accounts: accountMap,
    mappings: new Map(mappings.rows.map(row => [row.legacy_user_id, row])),
    events: eventMap,
    eventsByUser,
  };
}

function resolveCenterId(account, target) {
  const mapping = target.mappings.get(account.legacy_user_id);
  const email = String(account.name || "").trim().toLowerCase();
  const byEmail = EMAIL_PATTERN.test(email) ? [...target.accounts.values()].filter(item => item.emails.includes(email)) : [];
  if (mapping && byEmail.length && mapping.center_user_id !== byEmail[0].user_id) throw new Error(`账号映射冲突: ${account.legacy_user_id}`);
  if (mapping) return mapping.center_user_id;
  if (byEmail.length === 1) return byEmail[0].user_id;
  if (byEmail.length > 1) throw new Error(`中心邮箱对应多个身份: ${email}`);
  return null;
}

async function main() {
  const targetConfig = process.env.PROSPECTOR_ACCOUNT_MIGRATION_TARGET_DSN ? null : readTargetConfig();
  const source = new Client({ connectionString: readSourceDsn(), options: "-c default_transaction_read_only=on" });
  const target = targetConfig
    ? new Client({ host: targetConfig.host, port: targetConfig.port, database: targetConfig.database, user: targetConfig.app, password: targetConfig.appPassword })
    : new Client({ connectionString: process.env.PROSPECTOR_ACCOUNT_MIGRATION_TARGET_DSN });
  await source.connect();
  await target.connect();
  try {
    const [sourceData, centerIds] = await Promise.all([
      sourceInventory(source),
      target.query("SELECT user_id::text FROM identity.users WHERE active AND deleted_at IS NULL").then(result => result.rows.map(row => row.user_id)),
    ]);
    const targetData = await targetInventory(target, centerIds);
    const migrationActor = (await target.query("SELECT user_id::text FROM identity.users WHERE identity_admin AND active AND deleted_at IS NULL ORDER BY created_at LIMIT 2")).rows;
    if (APPLY && migrationActor.length !== 1) throw new Error("正式迁移需要唯一活动超级管理员作为审计主体");
    const eventsByLegacyUser = new Map();
    for (const row of sourceData.events) {
      const list = eventsByLegacyUser.get(row.legacy_user_id) ?? [];
      list.push(normalizeEvent(row, row.legacy_user_id));
      eventsByLegacyUser.set(row.legacy_user_id, list);
    }
    const plans = [], conflicts = [], skipped = [];
    const todayKey = businessDay(new Date().toISOString());
    for (const account of sourceData.accounts) {
      const centerId = resolveCenterId(account, targetData);
      if (!centerId) { skipped.push(account.legacy_user_id); continue; }
      const center = targetData.accounts.get(centerId);
      if (!center) { skipped.push(account.legacy_user_id); continue; }
      const sourceEvents = eventsByLegacyUser.get(account.legacy_user_id) ?? [];
      const displayName = String(account.display_name || "").trim() || String(account.name || "").trim();
      if (!displayName || displayName.length > 64) conflicts.push(`${account.legacy_user_id}: display name invalid`);
      const localPart = String(account.name || "").split("@")[0].toLowerCase();
      if (center.display_name !== displayName && center.display_name && center.display_name.toLowerCase() !== localPart) {
        conflicts.push(`${account.legacy_user_id}: central display name already differs`);
      }
      const avatar = avatarId(account.preferences_json);
      if (center.avatar_id && center.avatar_id !== "default" && avatar !== "default" && center.avatar_id !== avatar) {
        conflicts.push(`${account.legacy_user_id}: central avatar already differs`);
      }
      if (center.bio) conflicts.push(`${account.legacy_user_id}: central bio already set`);
      const legacyXp = sourceEvents.filter(event => event.ruleVersion === 1).reduce((sum, event) => sum + event.points, 0);
      const currentXp = sourceEvents.filter(event => event.ruleVersion >= 2).reduce((sum, event) => sum + (event.eventType === "account_growth_reset" ? -event.points : event.points), 0);
      const totalXp = mapLegacyXp(legacyXp) + currentXp;
      const growth = growthSummary(totalXp);
      growth.todayXp = sourceEvents.filter(event => event.ruleVersion >= 2 && event.eventType !== 'account_growth_reset' && businessDay(event.occurredAt) === todayKey).reduce((sum, event) => sum + event.points, 0);
      if (center.total_xp != null && Number(center.total_xp) !== totalXp) conflicts.push(`${account.legacy_user_id}: central growth total already differs`);
      const sourceKeys = new Set(sourceEvents.map(event => `${event.eventType}\0${event.subjectKey}`));
      for (const event of sourceEvents) {
        const existing = targetData.events.get(`${centerId}\0${event.eventType}\0${event.subjectKey}`);
        if (existing && (Number(existing.points) !== event.points || Number(existing.rule_version) !== event.ruleVersion || new Date(existing.occurred_at).toISOString() !== event.occurredAt)) {
          conflicts.push(`${account.legacy_user_id}: central growth event already differs`);
          break;
        }
      }
      if ((targetData.eventsByUser.get(centerId) ?? []).some(event => !sourceKeys.has(`${event.event_type}\0${event.subject_key}`))) {
        conflicts.push(`${account.legacy_user_id}: central has growth events absent from Navigator`);
      }
      const mapping = targetData.mappings.get(account.legacy_user_id);
      if (mapping && mapping.center_user_id !== centerId) conflicts.push(`${account.legacy_user_id}: mapping already targets another center identity`);
      plans.push({ account, centerId, center, avatar, displayName, growth, events: sourceEvents, mappingMissing: !mapping });
    }
    const overview = {
      mode: APPLY ? "apply" : "dry-run",
      activeSourceAccounts: sourceData.accounts.length,
      plannedAccounts: plans.length,
      skippedUnmapped: skipped.length,
      sourceGrowthEvents: plans.reduce((sum, plan) => sum + plan.events.length, 0),
      missingMappings: plans.filter(plan => plan.mappingMissing).length,
      auditActor: migrationActor.length === 1 ? migrationActor[0].user_id : null,
      conflicts: conflicts.length,
      sample: plans.map(plan => ({ legacyUserId: plan.account.legacy_user_id, centerUserId: plan.centerId, events: plan.events.length, level: plan.growth.level, cycle: plan.growth.cycle })),
    };
    log("INFO", JSON.stringify(overview));
    if (conflicts.length) throw new Error(`发现 ${conflicts.length} 个资料冲突，拒绝写入: ${conflicts.join(" | ")}`);
    if (!APPLY) return;
    await target.query("BEGIN");
    try {
      await target.query("SELECT user_id FROM identity.users WHERE user_id=ANY($1::uuid[]) FOR UPDATE", [plans.map(plan => plan.centerId)]);
      for (const plan of plans) {
        await target.query("UPDATE identity.users SET display_name=$2,management_revision=management_revision+1 WHERE user_id=$1 AND display_name<>$2", [plan.centerId, plan.displayName]);
        await target.query(`INSERT INTO identity.user_profiles(user_id,avatar_id,bio) VALUES($1,$2,'')
          ON CONFLICT(user_id) DO UPDATE SET avatar_id=EXCLUDED.avatar_id,updated_at=now()
          WHERE identity.user_profiles.avatar_id='default' OR identity.user_profiles.avatar_id=EXCLUDED.avatar_id`, [plan.centerId, plan.avatar]);
        if (plan.mappingMissing) {
          await target.query(`INSERT INTO identity.legacy_account_mappings
            (source_product,legacy_user_id,legacy_login_alias,center_user_id,status,requires_password_reset,reason)
            VALUES('navigator',$1,$2,$3,'migrated',false,'账号资料与成长迁移时补齐显式映射')`,
          [plan.account.legacy_user_id, String(plan.account.name).trim().toLowerCase(), plan.centerId]);
        }
        await target.query(`INSERT INTO identity.account_growth_projection(user_id,total_xp,cycle,level,today_xp,today_key)
          VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(user_id) DO UPDATE SET total_xp=EXCLUDED.total_xp,cycle=EXCLUDED.cycle,level=EXCLUDED.level,today_xp=EXCLUDED.today_xp,today_key=EXCLUDED.today_key,updated_at=now()`,
        [plan.centerId, plan.growth.total, plan.growth.cycle, plan.growth.level, plan.growth.todayXp, todayKey]);
        if (plan.events.length) {
          const events = plan.events.map(event => ({ event_id: event.eventId, user_id: plan.centerId, event_type: event.eventType, subject_key: event.subjectKey, points: event.points, rule_version: event.ruleVersion, occurred_at: event.occurredAt }));
          await target.query(`INSERT INTO identity.account_experience_events
            (event_id,user_id,source_product,event_type,subject_key,points,rule_version,occurred_at)
            SELECT event_id,user_id,'navigator',event_type,subject_key,points,rule_version,occurred_at
            FROM jsonb_to_recordset($1::jsonb) AS x(event_id uuid,user_id uuid,event_type text,subject_key text,points integer,rule_version integer,occurred_at timestamptz)
            ON CONFLICT DO NOTHING`, [JSON.stringify(events)]);
        }
        await target.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,product_id,reason)
          VALUES($1,$2,'identity.navigator.profile.migrated','navigator',$3)`,
        [migrationActor[0].user_id, plan.centerId, `账号资料与成长迁移；events=${plan.events.length};total_xp=${plan.growth.total}`]);
      }
      const verify = await target.query(`SELECT p.user_id::text,p.total_xp,p.cycle,p.level,
        (SELECT count(*)::int FROM identity.account_experience_events e WHERE e.user_id=p.user_id AND e.source_product='navigator') AS events
        FROM identity.account_growth_projection p WHERE p.user_id=ANY($1::uuid[])`, [plans.map(plan => plan.centerId)]);
      const projections = new Map(verify.rows.map(row => [row.user_id, row]));
      for (const plan of plans) {
        const current = projections.get(plan.centerId);
        if (!current || Number(current.total_xp) !== plan.growth.total || Number(current.cycle) !== plan.growth.cycle || Number(current.level) !== plan.growth.level || Number(current.events) !== plan.events.length) {
          throw new Error(`成长投影核对失败: ${plan.account.legacy_user_id}`);
        }
      }
      await target.query("COMMIT");
      log("INFO", `迁移提交完成 accounts=${plans.length} events=${plans.reduce((sum, plan) => sum + plan.events.length, 0)}`);
    } catch (error) {
      await target.query("ROLLBACK");
      throw error;
    }
  } finally {
    await Promise.allSettled([source.end(), target.end()]);
  }
}

try {
  await main();
} catch (error) {
  log("ERROR", error instanceof Error ? error.message : "账号资料迁移失败");
  process.exitCode = 1;
}
