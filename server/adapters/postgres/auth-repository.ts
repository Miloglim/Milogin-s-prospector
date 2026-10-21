import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { success, failure, type Result, type LogSink } from "../../core/crm";
import { AUTH_LIMITS, type AuthRepository, type Credential, type FixtureUser, type Identity, type NavigatorAccess, type SessionDraft } from "../../core/auth";
import { AUTH_SCHEMA_SQL, AUTH_SCHEMA_LOCK, AUTH_SCHEMA_VERSION } from "./auth-schema";
import { assertCenterDatabasePool } from "./config";
import { PostgresAdminRepository } from "./admin-repository";
import {PASSWORD_SCHEMA_LOCK,PASSWORD_SCHEMA_SQL,PASSWORD_SCHEMA_VERSION} from './password-schema';
import {ADMIN_LOCK} from './admin-schema';
import type { DesktopSessionDraft, DesktopRotation } from '../../core/desktop-session';
import { DESKTOP_SCHEMA_LOCK, DESKTOP_SCHEMA_SQL, DESKTOP_SCHEMA_VERSION } from './desktop-session-schema';
import { ACCOUNT_PROFILE_SCHEMA_LOCK, ACCOUNT_PROFILE_SCHEMA_SQL, ACCOUNT_PROFILE_SCHEMA_VERSION } from './account-profile-schema';
import { ACCOUNT_GROWTH_SCHEMA_LOCK, ACCOUNT_GROWTH_SCHEMA_SQL, ACCOUNT_GROWTH_SCHEMA_VERSION } from './account-growth-schema';
import { PASSWORD_COMPAT_SCHEMA_LOCK, PASSWORD_COMPAT_SCHEMA_SQL, PASSWORD_COMPAT_SCHEMA_VERSION } from './password-compat-schema';
import { LEGACY_ACCOUNT_MAPPING_SCHEMA_LOCK, LEGACY_ACCOUNT_MAPPING_SCHEMA_SQL, LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION } from './legacy-account-mapping-schema';
import type { AccountProfile, AccountProfilePatch } from '../../core/account-profile';
import { growthEventRule, growthSummary, type GrowthEventInput, type GrowthEventReceipt } from '../../core/account-growth';

const IDENTITY_COLUMNS = `u.user_id AS "userId",u.display_name AS "displayName",e.email,
  (e.verified_at IS NOT NULL) AS "emailVerified",u.identity_admin AS "identityAdmin",u.must_change_password AS "mustChangePassword",
  (SELECT a.capabilities FROM identity.product_access a WHERE a.user_id=u.user_id AND a.product_id='crm') AS "crmCapabilities",
  ARRAY(SELECT g.role FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active
    AND NOT EXISTS(SELECT 1 FROM identity.product_access a WHERE a.user_id=u.user_id AND a.product_id='crm' AND NOT a.active) ORDER BY g.role) AS "crmRoles"`;
const SESSION_FILTER = `s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
  AND u.active AND s.security_revision=u.security_revision`;
const GROWTH_RULE_VERSION = 2;
function profileFromRow(row: Record<string, unknown> | undefined): AccountProfile | null {
  if (!row) return null;
  return {
    userId:String(row.userId),displayName:String(row.displayName),avatarId:String(row.avatarId),bio:String(row.bio),
    growth:row.totalXp==null?null:growthSummary(Number(row.totalXp),Number(row.todayXp),row.todayKey as string | null),
  };
}
function stableGrowthEventId(userId: string, sourceProduct: string, sourceEventId: string): string {
  const bytes=createHash('sha256').update(`${sourceProduct}:${userId}:${sourceEventId}`).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&0x0f)|0x50;bytes[8]=(bytes[8]!&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
function noGrowthAward(summary: AccountProfile['growth']): GrowthEventReceipt {
  if(!summary)throw new Error('growth summary missing');
  return {awarded:false,awardedPoints:0,summary};
}
function code(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]+$/.test(error.code) ? error.code : "UNKNOWN";
}
export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly pool: Pool, private readonly log: LogSink) {
    assertCenterDatabasePool(pool);
    pool.on("error", error => log.write("ERROR", "identity.pg.pool", `连接错误 code=${code(error)}`));
  }
  private async execute<T>(action: () => Promise<Result<T>>): Promise<Result<T>> {
    try { return await action(); }
    catch(error) {
      this.log.write("ERROR", "identity.pg", `数据库操作失败 code=${code(error)}`);
      return failure("DATABASE_ERROR", "身份服务暂不可用");
    }
  }
  private async tx<T>(action: (client: PoolClient) => Promise<Result<T>>): Promise<Result<T>> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await action(client); await client.query(result.ok ? "COMMIT" : "ROLLBACK"); return result; }
    catch(error) {
      try { await client.query("ROLLBACK"); } catch(rollback) { this.log.write("ERROR", "identity.pg.rollback", `回滚失败 code=${code(rollback)}`); }
      throw error;
    } finally { client.release(); }
  }
  migrate(): Promise<Result<void>> {
    return this.execute(() => this.tx(async client => {
      await client.query("SELECT pg_advisory_xact_lock($1)",[AUTH_SCHEMA_LOCK]);
      const checksum = createHash("sha256").update(AUTH_SCHEMA_SQL).digest("hex");
      const existing = await client.query("SELECT checksum FROM crm_schema_migrations WHERE version=$1",[AUTH_SCHEMA_VERSION]);
      if (existing.rows.length) {
        if(existing.rows[0].checksum !== checksum) return failure("CONFLICT", "身份迁移校验不一致，拒绝覆盖");
      } else {
        await client.query(AUTH_SCHEMA_SQL);
        await client.query("INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)",[AUTH_SCHEMA_VERSION,checksum]);
        this.log.write("INFO", "identity.pg.migrate", `迁移完成 version=${AUTH_SCHEMA_VERSION}`);
      }
      return success(undefined);
    })).then(async result => result.ok ? new PostgresAdminRepository(this.pool,this.log).migrate() : result).then(async result=>{
      if(!result.ok)return result;
      return this.execute(()=>this.tx(async client=>{
        await client.query('SELECT pg_advisory_xact_lock($1)',[PASSWORD_SCHEMA_LOCK]);const checksum=createHash('sha256').update(PASSWORD_SCHEMA_SQL).digest('hex');
        const existing=await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1',[PASSWORD_SCHEMA_VERSION]);
        if(existing.rows.length&&existing.rows[0].checksum!==checksum)return failure('CONFLICT','改密迁移校验不一致');
        if(!existing.rows.length){await client.query(PASSWORD_SCHEMA_SQL);await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)',[PASSWORD_SCHEMA_VERSION,checksum]);}
        return success(undefined);
      }));
    }).then(async result => {
      if (!result.ok) return result;
      return this.execute(() => this.tx(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [DESKTOP_SCHEMA_LOCK]);
        const checksum = createHash('sha256').update(DESKTOP_SCHEMA_SQL).digest('hex');
        const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [DESKTOP_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum) return failure('CONFLICT', '桌面会话迁移校验不一致');
        if (!existing.rows.length) {
          await client.query(DESKTOP_SCHEMA_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [DESKTOP_SCHEMA_VERSION, checksum]);
        }
        return success(undefined);
      }));
    }).then(async result => {
      if (!result.ok) return result;
      return this.execute(() => this.tx(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [ACCOUNT_PROFILE_SCHEMA_LOCK]);
        const checksum = createHash('sha256').update(ACCOUNT_PROFILE_SCHEMA_SQL).digest('hex');
        const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [ACCOUNT_PROFILE_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum) return failure('CONFLICT', '账号资料迁移校验不一致');
        if (!existing.rows.length) {
          await client.query(ACCOUNT_PROFILE_SCHEMA_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [ACCOUNT_PROFILE_SCHEMA_VERSION, checksum]);
          this.log.write('INFO', 'identity.pg.migrate', `迁移完成 version=${ACCOUNT_PROFILE_SCHEMA_VERSION}`);
        }
        return success(undefined);
      }));
    }).then(async result => {
      if (!result.ok) return result;
      return this.execute(() => this.tx(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [ACCOUNT_GROWTH_SCHEMA_LOCK]);
        const checksum = createHash('sha256').update(ACCOUNT_GROWTH_SCHEMA_SQL).digest('hex');
        const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [ACCOUNT_GROWTH_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum) return failure('CONFLICT', '账号成长迁移校验不一致');
        if (!existing.rows.length) {
          await client.query(ACCOUNT_GROWTH_SCHEMA_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [ACCOUNT_GROWTH_SCHEMA_VERSION, checksum]);
          this.log.write('INFO', 'identity.pg.migrate', `迁移完成 version=${ACCOUNT_GROWTH_SCHEMA_VERSION}`);
        }
        return success(undefined);
      }));
    }).then(async result => {
      if (!result.ok) return result;
      return this.execute(() => this.tx(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [PASSWORD_COMPAT_SCHEMA_LOCK]);
        const checksum = createHash('sha256').update(PASSWORD_COMPAT_SCHEMA_SQL).digest('hex');
        const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [PASSWORD_COMPAT_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum) return failure('CONFLICT', '旧密码兼容迁移校验不一致');
        if (!existing.rows.length) {
          await client.query(PASSWORD_COMPAT_SCHEMA_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [PASSWORD_COMPAT_SCHEMA_VERSION, checksum]);
          this.log.write('INFO', 'identity.pg.migrate', `迁移完成 version=${PASSWORD_COMPAT_SCHEMA_VERSION}`);
        }
        return success(undefined);
      }));
    }).then(async result => {
      if (!result.ok) return result;
      return this.execute(() => this.tx(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [LEGACY_ACCOUNT_MAPPING_SCHEMA_LOCK]);
        const checksum = createHash('sha256').update(LEGACY_ACCOUNT_MAPPING_SCHEMA_SQL).digest('hex');
        const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum) return failure('CONFLICT', '旧账号映射迁移校验不一致');
        if (!existing.rows.length) {
          await client.query(LEGACY_ACCOUNT_MAPPING_SCHEMA_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION, checksum]);
          this.log.write('INFO', 'identity.pg.migrate', `迁移完成 version=${LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION}`);
        }
        return success(undefined);
      }));
    });
  }
  ensureFixture(input: FixtureUser): Promise<Result<void>> {
    return this.execute(() => this.tx(async client => {
      // A fixed fixture ID must never overwrite an existing identity or resurrect permissions.
      await client.query("SELECT pg_advisory_xact_lock($1)",[AUTH_SCHEMA_LOCK]);
      const existing = await client.query("SELECT user_id FROM identity.login_emails WHERE email=$1",[input.email]);
      if(existing.rows.length) return existing.rows[0].user_id === input.userId ? success(undefined) : failure("CONFLICT", "测试邮箱已有其他身份，保留现状");
      const created = await client.query("INSERT INTO identity.users(user_id,display_name,identity_admin,must_change_password) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING user_id",[input.userId,input.displayName,input.identityAdmin,input.mustChangePassword??false]);
      if(!created.rows.length) return failure("CONFLICT", "测试身份已存在但邮箱不匹配");
      await client.query("INSERT INTO identity.login_emails(user_id,email) VALUES($1,$2)",[input.userId,input.email]);
      await client.query("INSERT INTO identity.credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1')",[input.userId,input.passwordHash]);
      for(const role of input.crmRoles) await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[input.userId,role]);
      await client.query("INSERT INTO identity.audit(user_id,event) VALUES($1,'fixture')",[input.userId]);
      return success(undefined);
    }));
  }
  createSalesAccount(input: { email: string; passwordHash: string }): Promise<Result<{ email: string }>> {
    return this.execute(() => this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_LOCK]);
      const existing = await client.query('SELECT user_id FROM identity.login_emails WHERE email=$1', [input.email]);
      if (existing.rows.length) return failure('CONFLICT', '该邮箱已注册');
      const userId = randomUUID();
      await client.query('INSERT INTO identity.users(user_id,display_name,identity_admin) VALUES($1,$2,false)', [userId, input.email.split('@')[0]]);
      await client.query('INSERT INTO identity.login_emails(user_id,email,verified_at) VALUES($1,$2,NULL)', [userId, input.email]);
      await client.query("INSERT INTO identity.credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1')", [userId, input.passwordHash]);
      await client.query("INSERT INTO identity.product_grants(user_id,product_id,role) VALUES($1,'crm','sales')", [userId]);
      await client.query("INSERT INTO identity.product_access(user_id,product_id,scope) VALUES($1,'crm','own')", [userId]);
      await client.query("INSERT INTO identity.management_audit(actor_id,target_id,action,product_id,reason) VALUES($1,$1,'identity.register','crm','邮箱自助注册；邮箱未验证')", [userId]);
      await client.query("INSERT INTO identity.outbox(event_type,user_id,product_id,revision) VALUES('identity.register',$1,'crm',1)", [userId]);
      return success({ email: input.email });
    }));
  }
  credential(email: string): Promise<Result<Credential | null>> {
    return this.execute(async () => {
      const rows = await this.pool.query(`SELECT u.user_id AS "userId",c.password_hash AS "passwordHash",u.active,u.security_revision AS "securityRevision",u.must_change_password AS "mustChangePassword"
        FROM identity.login_emails e JOIN identity.users u USING(user_id) JOIN identity.credentials c USING(user_id) WHERE e.email=$1`,[email]);
      return success(rows.rows[0] ?? null);
    });
  }
  createSession(input: SessionDraft): Promise<Result<Identity | null>> {
    return this.execute(() => this.tx(async client => {
      const user = await client.query("SELECT user_id FROM identity.users WHERE user_id=$1 AND active AND security_revision=$2 FOR SHARE",[input.userId,input.securityRevision]);
      if(!user.rows.length) return success(null);
      await client.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,$3,$4,$5)",[input.tokenHash,input.userId,input.securityRevision,input.expiresAt,input.client??'api']);
      await client.query("INSERT INTO identity.audit(user_id,event) VALUES($1,'login')",[input.userId]);
      const result = await client.query(`SELECT ${IDENTITY_COLUMNS} FROM identity.users u JOIN identity.login_emails e USING(user_id) WHERE u.user_id=$1`,[input.userId]);
      return success(result.rows[0] as Identity);
    }));
  }
  identity(tokenHash: string,client:"api"|"browser"='api'): Promise<Result<Identity | null>> {
    return this.execute(async () => {
      const result = await this.pool.query(`SELECT ${IDENTITY_COLUMNS} FROM identity.sessions s JOIN identity.users u USING(user_id) JOIN identity.login_emails e USING(user_id) WHERE ${SESSION_FILTER} AND s.client=$2`,[tokenHash,client]);
      return success(result.rows[0] ?? null);
    });
  }
  accountProfile(tokenHash: string): Promise<Result<AccountProfile | null>> {
    return this.execute(async () => {
      const result = await this.pool.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",
        COALESCE(p.avatar_id,'default') AS "avatarId",COALESCE(p.bio,'') AS bio,
        g.total_xp AS "totalXp",g.today_xp AS "todayXp",g.today_key::text AS "todayKey"
        FROM identity.sessions s JOIN identity.users u USING(user_id)
        LEFT JOIN identity.user_profiles p USING(user_id)
        LEFT JOIN identity.account_growth_projection g USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api'`,[tokenHash]);
      return success(profileFromRow(result.rows[0]));
    });
  }
  updateAccountProfile(tokenHash: string, patch: AccountProfilePatch): Promise<Result<AccountProfile | null>> {
    return this.execute(() => this.tx(async client => {
      const allowed=await client.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",
        COALESCE(p.avatar_id,'default') AS "avatarId",COALESCE(p.bio,'') AS bio
        FROM identity.sessions s JOIN identity.users u USING(user_id)
        LEFT JOIN identity.user_profiles p USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api' FOR UPDATE OF u`,[tokenHash]);
      if(!allowed.rows.length)return success(null);
      const userId=allowed.rows[0].userId,current=allowed.rows[0];
      const displayChanged=patch.displayName!==undefined&&patch.displayName!==current.displayName;
      const profileChanged=(patch.avatarId!==undefined&&patch.avatarId!==current.avatarId)||(patch.bio!==undefined&&patch.bio!==current.bio);
      if(displayChanged)await client.query('UPDATE identity.users SET display_name=$2,management_revision=management_revision+1 WHERE user_id=$1',[userId,patch.displayName]);
      if(profileChanged) {
        await client.query(`INSERT INTO identity.user_profiles(user_id,avatar_id,bio) VALUES($1,COALESCE($2,'default'),COALESCE($3,''))
          ON CONFLICT(user_id) DO UPDATE SET avatar_id=COALESCE($2,identity.user_profiles.avatar_id),bio=COALESCE($3,identity.user_profiles.bio),updated_at=now()`,
        [userId,patch.avatarId??null,patch.bio??null]);
      }
      if(displayChanged||profileChanged)await client.query(`INSERT INTO identity.management_audit(actor_id,target_id,action,reason)
        VALUES($1,$1,'identity.profile.updated','本人更新共享账号资料')`,[userId]);
      const result=await client.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",
        COALESCE(p.avatar_id,'default') AS "avatarId",COALESCE(p.bio,'') AS bio,
        g.total_xp AS "totalXp",g.today_xp AS "todayXp",g.today_key::text AS "todayKey"
        FROM identity.users u LEFT JOIN identity.user_profiles p USING(user_id)
        LEFT JOIN identity.account_growth_projection g USING(user_id) WHERE u.user_id=$1`,[userId]);
      return success(profileFromRow(result.rows[0]));
    }));
  }
  recordGrowthEvent(tokenHash: string, event: GrowthEventInput): Promise<Result<GrowthEventReceipt | null>> {
    return this.execute(() => this.tx(async client => {
      const allowed=await client.query(`SELECT u.user_id AS "userId" FROM identity.sessions s JOIN identity.users u USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api' AND EXISTS(
          SELECT 1 FROM identity.product_access a WHERE a.user_id=u.user_id AND a.product_id=$2 AND a.active
        ) FOR UPDATE OF u`,[tokenHash,event.sourceProduct]);
      if(!allowed.rows.length)return success(null);
      const userId=allowed.rows[0].userId, rule=growthEventRule(event.sourceProduct,event.eventType);
      if(!rule || event.ruleVersion!==GROWTH_RULE_VERSION || event.points>rule.points)return failure('INVALID_INPUT','成长事件不符合中心规则');
      const state=await client.query(`SELECT (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)::text AS "occurredDay",
        ((now() AT TIME ZONE 'Asia/Shanghai')::date)::text AS "todayKey"`,[event.occurredAt]);
      const projection=await client.query('SELECT total_xp,today_xp,today_key::text FROM identity.account_growth_projection WHERE user_id=$1 FOR UPDATE',[userId]);
      if(!projection.rows.length) {
        const count=await client.query('SELECT count(*)::int AS n FROM identity.account_experience_events WHERE user_id=$1',[userId]);
        if(count.rows[0].n>0)return failure('CONFLICT','中心成长投影缺失，请先完成历史迁移');
        await client.query("INSERT INTO identity.account_growth_projection(user_id) VALUES($1) ON CONFLICT DO NOTHING",[userId]);
      }
      const current=(await client.query('SELECT total_xp,today_xp,today_key::text FROM identity.account_growth_projection WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
      const duplicate=await client.query(`SELECT 1 FROM identity.account_experience_events
        WHERE user_id=$1 AND source_product=$2 AND event_type=$3 AND subject_key=$4`,[userId,event.sourceProduct,event.eventType,event.subjectKey]);
      if(duplicate.rows.length)return success(noGrowthAward(growthSummary(Number(current.total_xp),Number(current.today_xp),current.today_key)));
      const earned=(await client.query(`SELECT COALESCE(SUM(points),0)::int AS n FROM identity.account_experience_events
        WHERE user_id=$1 AND rule_version>=2 AND event_type<>'account_growth_reset'
          AND (occurred_at AT TIME ZONE 'Asia/Shanghai')::date=$2::date`,[userId,state.rows[0].occurredDay])).rows[0].n;
      const awarded=rule.dailyCap===null?event.points:Math.min(event.points,Math.max(0,rule.dailyCap-Number(earned)));
      if(awarded<=0)return success(noGrowthAward(growthSummary(Number(current.total_xp),Number(current.today_xp),current.today_key)));
      const inserted=await client.query(`INSERT INTO identity.account_experience_events
        (event_id,user_id,source_product,event_type,subject_key,points,rule_version,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING event_id`,
      [stableGrowthEventId(userId,event.sourceProduct,event.eventId),userId,event.sourceProduct,event.eventType,event.subjectKey,awarded,event.ruleVersion,event.occurredAt]);
      if(!inserted.rows.length)return success(noGrowthAward(growthSummary(Number(current.total_xp),Number(current.today_xp),current.today_key)));
      const total=Math.max(0,Number(current.total_xp)+awarded);
      const summary=growthSummary(total,state.rows[0].occurredDay===state.rows[0].todayKey?Number(earned)+awarded:Number(current.today_xp),state.rows[0].occurredDay===state.rows[0].todayKey?state.rows[0].todayKey:current.today_key);
      await client.query(`UPDATE identity.account_growth_projection SET total_xp=$2,cycle=$3,level=$4,today_xp=$5,today_key=$6,updated_at=now() WHERE user_id=$1`,
      [userId,summary.totalXp,summary.cycle,summary.level,summary.todayXp,summary.todayKey]);
      const receipt: GrowthEventReceipt = {awarded:true,awardedPoints:awarded,summary};
      return success(receipt);
    }));
  }
  navigatorAccess(tokenHash: string): Promise<Result<NavigatorAccess | null>> {
    return this.execute(async () => {
      const result = await this.pool.query(`SELECT u.user_id AS "userId",e.email,u.display_name AS "displayName",
        CASE WHEN u.identity_admin THEN 'admin'
          WHEN a.active AND EXISTS(SELECT 1 FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='navigator' AND g.role='operations' AND g.active) THEN 'operator'
          WHEN a.active AND EXISTS(SELECT 1 FROM identity.product_grants g WHERE g.user_id=u.user_id AND g.product_id='navigator' AND g.role='sales' AND g.active) THEN 'sales'
          ELSE NULL END AS role
        FROM identity.sessions s JOIN identity.users u USING(user_id) JOIN identity.login_emails e USING(user_id)
        LEFT JOIN identity.product_access a ON a.user_id=u.user_id AND a.product_id='navigator'
        WHERE ${SESSION_FILTER} AND s.client IN ('api','browser') AND NOT u.must_change_password`,[tokenHash]);
      const row=result.rows[0];return success(row?.role ? row as NavigatorAccess : null);
    });
  }
  revoke(tokenHash: string): Promise<Result<void>> {
    return this.execute(() => this.tx(async client => {
      const result = await client.query("UPDATE identity.sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING user_id",[tokenHash]);
      if(result.rows.length) await client.query("INSERT INTO identity.audit(user_id,event) VALUES($1,'logout')",[result.rows[0].user_id]);
      return success(undefined);
    }));
  }
  listUsers(tokenHash: string): Promise<Result<Identity[]>> {
    return this.execute(async () => {
      // Authorization and result rows share one statement snapshot: no revoke-between-check-and-read gap.
      const rows = await this.pool.query(`WITH allowed AS (
        SELECT 1 FROM identity.sessions s JOIN identity.users u USING(user_id) WHERE ${SESSION_FILTER} AND s.client='api' AND u.identity_admin AND NOT u.must_change_password
      ), items AS (
        SELECT ${IDENTITY_COLUMNS} FROM identity.users u JOIN identity.login_emails e USING(user_id)
        WHERE u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM allowed) ORDER BY u.created_at,u.user_id LIMIT $2
      ) SELECT EXISTS(SELECT 1 FROM allowed) AS allowed,
        COALESCE((SELECT jsonb_agg(to_jsonb(items)) FROM items),'[]'::jsonb) AS items`,[tokenHash,AUTH_LIMITS.usersPage]);
      return rows.rows[0].allowed ? success(rows.rows[0].items as Identity[]) : failure("FORBIDDEN","无账号管理权限");
    });
  }
  ready(): Promise<Result<void>> {
    return this.execute(async () => {
      await this.pool.query("SELECT 1 FROM identity.users LIMIT 1");
      return success(undefined);
    });
  }
  createDesktopSession(input: DesktopSessionDraft): Promise<Result<Identity | null>> {
    return this.execute(() => this.tx(async client => {
      const user = await client.query('SELECT user_id FROM identity.users WHERE user_id=$1 AND active AND security_revision=$2 FOR SHARE', [input.userId, input.securityRevision]);
      if (!user.rows.length) return success(null);
      const session = await client.query("INSERT INTO identity.sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,$3,$4,'api') RETURNING session_id", [input.tokenHash, input.userId, input.securityRevision, input.expiresAt]);
      await client.query('INSERT INTO identity.desktop_refresh_tokens(token_hash,session_id,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4)', [input.refreshHash, session.rows[0].session_id, input.idleExpiresAt, input.absoluteExpiresAt]);
      await client.query("INSERT INTO identity.audit(user_id,event) VALUES($1,'login')", [input.userId]);
      const identity = await client.query(`SELECT ${IDENTITY_COLUMNS} FROM identity.users u JOIN identity.login_emails e USING(user_id) WHERE u.user_id=$1`, [input.userId]);
      return success(identity.rows[0]);
    }));
  }
  rotateDesktopSession(refreshHash: string, input: DesktopRotation): Promise<Result<{ identity: Identity; expiresAt: string; absoluteExpiresAt: string } | null>> {
    return this.execute(() => this.tx(async client => {
      // Lock the same stable session that admin revoke targets. No independent refresh grant can survive it.
      const session = await client.query(`SELECT s.session_id,s.user_id,r.absolute_expires_at FROM identity.desktop_refresh_tokens r
        JOIN identity.sessions s USING(session_id) JOIN identity.users u USING(user_id)
        WHERE r.token_hash=$1 AND r.consumed_at IS NULL AND r.idle_expires_at>now() AND r.absolute_expires_at>now()
        AND s.revoked_at IS NULL AND u.active AND s.security_revision=u.security_revision FOR UPDATE OF s,r FOR SHARE OF u`, [refreshHash]);
      if (!session.rows.length) return success(null);
      const row = session.rows[0];
      const consumed = await client.query('UPDATE identity.desktop_refresh_tokens SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL RETURNING token_hash', [refreshHash]);
      if (!consumed.rows.length) return success(null);
      const updated = await client.query('UPDATE identity.sessions SET token_hash=$2,expires_at=LEAST($3::timestamptz,$4::timestamptz) WHERE session_id=$1 RETURNING expires_at', [row.session_id, input.tokenHash, input.expiresAt, row.absolute_expires_at]);
      await client.query('INSERT INTO identity.desktop_refresh_tokens(token_hash,session_id,idle_expires_at,absolute_expires_at) VALUES($1,$2,LEAST($3::timestamptz,$4::timestamptz),$4)', [input.refreshHash, row.session_id, input.idleExpiresAt, row.absolute_expires_at]);
      const identity = await client.query(`SELECT ${IDENTITY_COLUMNS} FROM identity.users u JOIN identity.login_emails e USING(user_id) WHERE u.user_id=$1`, [row.user_id]);
      return success({ identity: identity.rows[0], expiresAt: updated.rows[0].expires_at.toISOString(), absoluteExpiresAt: row.absolute_expires_at.toISOString() });
    }));
  }
  desktopIdentity(tokenHash: string): Promise<Result<Identity | null>> {
    return this.execute(async () => {
      const result = await this.pool.query(`SELECT ${IDENTITY_COLUMNS} FROM identity.sessions s JOIN identity.users u USING(user_id) JOIN identity.login_emails e USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api' AND EXISTS(SELECT 1 FROM identity.desktop_refresh_tokens r WHERE r.session_id=s.session_id AND r.consumed_at IS NULL AND r.idle_expires_at>now() AND r.absolute_expires_at>now())`, [tokenHash]);
      return success(result.rows[0] ?? null);
    });
  }
  revokeDesktopSession(refreshHash: string): Promise<Result<void>> {
    return this.execute(() => this.tx(async client => {
      const revoked = await client.query(`UPDATE identity.sessions s SET revoked_at=now() FROM identity.desktop_refresh_tokens r WHERE r.token_hash=$1 AND r.session_id=s.session_id AND s.revoked_at IS NULL RETURNING s.user_id`, [refreshHash]);
      if (revoked.rows.length) await client.query("INSERT INTO identity.audit(user_id,event) VALUES($1,'logout')", [revoked.rows[0].user_id]);
      return success(undefined);
    }));
  }
  changePassword(hash:string,expectedHash:string,revision:number,newHash:string,clientType:'api'|'browser'='browser'):Promise<Result<void>> {
    return this.execute(()=>this.tx(async client=>{
      await client.query('SELECT pg_advisory_xact_lock($1)',[ADMIN_LOCK]);
      const actor=await client.query(`SELECT u.user_id FROM identity.sessions s JOIN identity.users u USING(user_id) JOIN identity.credentials c USING(user_id)
        WHERE s.token_hash=$1 AND s.client=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND u.security_revision=s.security_revision
        AND u.security_revision=$2 AND c.password_hash=$3 FOR UPDATE OF u,c`,[hash,revision,expectedHash,clientType]);
      if(!actor.rows.length)return failure('UNAUTHORIZED','会话或密码已变化，请重新登录');
      const id=actor.rows[0].user_id;
      await client.query('UPDATE identity.credentials SET password_hash=$2,changed_at=now() WHERE user_id=$1',[id,newHash]);
      await client.query('UPDATE identity.users SET must_change_password=false,security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1',[id]);
      await client.query('UPDATE identity.sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',[id]);
      await client.query('UPDATE identity.management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[id]);
      await client.query("INSERT INTO identity.management_audit(actor_id,target_id,action,reason) VALUES($1,$1,'identity.password.changed','用户主动设置新密码，全部旧会话已撤销')",[id]);
      await client.query("INSERT INTO identity.outbox(event_type,user_id,revision) SELECT 'identity.password.changed',user_id,management_revision FROM identity.users WHERE user_id=$1",[id]);
      return success(undefined);
    }));
  }
}
