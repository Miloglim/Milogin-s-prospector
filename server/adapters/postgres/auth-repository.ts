import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { success, failure, type Result, type LogSink } from "../../core/crm";
import { AUTH_LIMITS, type AuthRepository, type Credential, type FixtureUser, type Identity, type NavigatorAccess, type SessionDraft } from "../../core/auth";
import { AUTH_SCHEMA_SQL, AUTH_SCHEMA_LOCK, AUTH_SCHEMA_VERSION } from "./auth-schema";
import { assertCenterDatabasePool } from "./config";
import { PostgresAdminRepository } from "./admin-repository";
import {PASSWORD_SCHEMA_LOCK,PASSWORD_SCHEMA_SQL,PASSWORD_SCHEMA_VERSION} from './password-schema';
import {ADMIN_LOCK} from './admin-schema';
import type { DesktopSessionDraft, DesktopHandoffSessionDraft, DesktopRotation, RegistrationProduct } from '../../core/desktop-session';
import { DESKTOP_SCHEMA_LOCK, DESKTOP_SCHEMA_SQL, DESKTOP_SCHEMA_VERSION } from './desktop-session-schema';
import { DESKTOP_DEVICE_SCHEMA_LOCK, DESKTOP_DEVICE_SCHEMA_SQL, DESKTOP_DEVICE_SCHEMA_VERSION } from './desktop-device-schema';
import { ACCOUNT_PROFILE_SCHEMA_LOCK, ACCOUNT_PROFILE_SCHEMA_SQL, ACCOUNT_PROFILE_SCHEMA_VERSION } from './account-profile-schema';
import { ACCOUNT_GROWTH_SCHEMA_LOCK, ACCOUNT_GROWTH_SCHEMA_SQL, ACCOUNT_GROWTH_SCHEMA_VERSION } from './account-growth-schema';
import { PASSWORD_COMPAT_SCHEMA_LOCK, PASSWORD_COMPAT_SCHEMA_SQL, PASSWORD_COMPAT_SCHEMA_VERSION } from './password-compat-schema';
import { LEGACY_ACCOUNT_MAPPING_SCHEMA_LOCK, LEGACY_ACCOUNT_MAPPING_SCHEMA_SQL, LEGACY_ACCOUNT_MAPPING_SCHEMA_VERSION } from './legacy-account-mapping-schema';
import { DEVICE_HANDOFF_AUDIT_SCHEMA_LOCK, DEVICE_HANDOFF_AUDIT_SCHEMA_SQL, DEVICE_HANDOFF_AUDIT_SCHEMA_VERSION, DEVICE_HANDOFF_SCHEMA_LOCK, DEVICE_HANDOFF_SCHEMA_SQL, DEVICE_HANDOFF_SCHEMA_VERSION } from './device-handoff-schema';
import type { AccountProfile, AccountProfilePatch } from '../../core/account-profile';
import { growthEventRule, growthSummary, type GrowthEventInput, type GrowthEventReceipt } from '../../core/account-growth';
import type { DeviceHandoffState, DeviceHandoffBeginInput, DeviceHandoffPreparation } from '../../core/device-handoff';

const IDENTITY_COLUMNS = `u.user_id AS "userId",u.display_name AS "displayName",e.email,
  (e.verified_at IS NOT NULL) AS "emailVerified",u.identity_admin AS "identityAdmin",u.must_change_password AS "mustChangePassword",
  (SELECT a.capabilities FROM public.identity_product_access a WHERE a.user_id=u.user_id AND a.product_id='crm') AS "crmCapabilities",
  ARRAY(SELECT g.role FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='crm' AND g.active
    AND NOT EXISTS(SELECT 1 FROM public.identity_product_access a WHERE a.user_id=u.user_id AND a.product_id='crm' AND NOT a.active) ORDER BY g.role) AS "crmRoles"`;
const SESSION_FILTER = `s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()
  AND u.active AND s.security_revision=u.security_revision`;
const GROWTH_RULE_VERSION = 2;
const HANDOFF_COLUMNS = `h.handoff_id AS "handoffId",h.status,h.expires_at AS "expiresAt",
  COALESCE(h.old_device_name,'原电脑') AS "oldDeviceName",h.new_device_name AS "newDeviceName",
  h.summary,h.takeover_reason AS "takeoverReason"`;
const HANDOFF_RETURNING = `handoff_id AS "handoffId",status,expires_at AS "expiresAt",
  COALESCE(old_device_name,'原电脑') AS "oldDeviceName",new_device_name AS "newDeviceName",
  summary,takeover_reason AS "takeoverReason"`;
function handoffState(row: Record<string, unknown>): DeviceHandoffState {
  return {
    handoffId:String(row.handoffId), status:row.status as DeviceHandoffState['status'],
    expiresAt:row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt),
    oldDeviceName:String(row.oldDeviceName), newDeviceName:String(row.newDeviceName),
    ...(row.summary && typeof row.summary === 'object' ? { summary: row.summary as DeviceHandoffState['summary'] } : {}),
    ...(row.takeoverReason == null ? {} : { takeoverReason: String(row.takeoverReason) }),
  };
}
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
        await client.query('SELECT pg_advisory_xact_lock($1)', [DESKTOP_DEVICE_SCHEMA_LOCK]);
        const checksum = createHash('sha256').update(DESKTOP_DEVICE_SCHEMA_SQL).digest('hex');
        const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [DESKTOP_DEVICE_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum) return failure('CONFLICT', '桌面设备迁移校验不一致');
        if (!existing.rows.length) {
          await client.query(DESKTOP_DEVICE_SCHEMA_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [DESKTOP_DEVICE_SCHEMA_VERSION, checksum]);
          this.log.write('INFO', 'identity.pg.migrate', `迁移完成 version=${DESKTOP_DEVICE_SCHEMA_VERSION}`);
        }
        return success(undefined);
      }));
    }).then(async result => {
      if (!result.ok) return result;
      return this.execute(() => this.tx(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [DEVICE_HANDOFF_SCHEMA_LOCK]);
        const checksum = createHash('sha256').update(DEVICE_HANDOFF_SCHEMA_SQL).digest('hex');
        const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [DEVICE_HANDOFF_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum) return failure('CONFLICT', '换机交接迁移校验不一致');
        if (!existing.rows.length) {
          await client.query(DEVICE_HANDOFF_SCHEMA_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [DEVICE_HANDOFF_SCHEMA_VERSION, checksum]);
          this.log.write('INFO', 'identity.pg.migrate', `迁移完成 version=${DEVICE_HANDOFF_SCHEMA_VERSION}`);
        }
        return success(undefined);
      }));
    }).then(async result => {
      if (!result.ok) return result;
      return this.execute(() => this.tx(async client => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [DEVICE_HANDOFF_AUDIT_SCHEMA_LOCK]);
        const checksum = createHash('sha256').update(DEVICE_HANDOFF_AUDIT_SCHEMA_SQL).digest('hex');
        const existing = await client.query('SELECT checksum FROM crm_schema_migrations WHERE version=$1', [DEVICE_HANDOFF_AUDIT_SCHEMA_VERSION]);
        if (existing.rows.length && existing.rows[0].checksum !== checksum) return failure('CONFLICT', '换机审计迁移校验不一致');
        if (!existing.rows.length) {
          await client.query(DEVICE_HANDOFF_AUDIT_SCHEMA_SQL);
          await client.query('INSERT INTO crm_schema_migrations(version,checksum) VALUES($1,$2)', [DEVICE_HANDOFF_AUDIT_SCHEMA_VERSION, checksum]);
          this.log.write('INFO', 'identity.pg.migrate', `迁移完成 version=${DEVICE_HANDOFF_AUDIT_SCHEMA_VERSION}`);
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
      const existing = await client.query("SELECT user_id FROM public.identity_login_emails WHERE email=$1",[input.email]);
      if(existing.rows.length) return existing.rows[0].user_id === input.userId ? success(undefined) : failure("CONFLICT", "测试邮箱已有其他身份，保留现状");
      const created = await client.query("INSERT INTO public.identity_users(user_id,display_name,identity_admin,must_change_password) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING user_id",[input.userId,input.displayName,input.identityAdmin,input.mustChangePassword??false]);
      if(!created.rows.length) return failure("CONFLICT", "测试身份已存在但邮箱不匹配");
      await client.query("INSERT INTO public.identity_login_emails(user_id,email) VALUES($1,$2)",[input.userId,input.email]);
      await client.query("INSERT INTO public.identity_credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1')",[input.userId,input.passwordHash]);
      for(const role of input.crmRoles) await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,'crm',$2)",[input.userId,role]);
      await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'fixture')",[input.userId]);
      return success(undefined);
    }));
  }
  createSalesAccount(input: { email: string; passwordHash: string; product: RegistrationProduct }): Promise<Result<{ email: string }>> {
    return this.execute(() => this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_LOCK]);
      const existing = await client.query('SELECT e.user_id,u.deleted_at FROM public.identity_login_emails e JOIN public.identity_users u USING(user_id) WHERE e.email=$1 FOR UPDATE OF u', [input.email]);
      if (existing.rows.length) return failure('CONFLICT', existing.rows[0].deleted_at ? '该邮箱已归档，请联系管理员恢复账号' : '该邮箱已注册');
      const userId = randomUUID();
      await client.query('INSERT INTO public.identity_users(user_id,display_name,identity_admin) VALUES($1,$2,false)', [userId, input.email.split('@')[0]]);
      await client.query('INSERT INTO public.identity_login_emails(user_id,email,verified_at) VALUES($1,$2,NULL)', [userId, input.email]);
      await client.query("INSERT INTO public.identity_credentials(user_id,password_hash,hash_scheme) VALUES($1,$2,'scrypt-v1')", [userId, input.passwordHash]);
      for(const product of ["crm","navigator"]) await client.query("INSERT INTO public.identity_product_grants(user_id,product_id,role) VALUES($1,$2,'sales')", [userId, product]);
      for(const product of ["crm","navigator"]) await client.query("INSERT INTO public.identity_product_access(user_id,product_id,scope) VALUES($1,$2,'own')", [userId, product]);
      const reason = '邮箱自助注册；邮箱未验证';
      await client.query('INSERT INTO public.identity_management_audit(actor_id,target_id,action,product_id,reason) VALUES($1,$1,$2,$3,$4)', [userId, 'identity.register', input.product, reason]);
      await client.query('INSERT INTO public.identity_outbox(event_type,user_id,product_id,revision) VALUES($1,$2,$3,$4)', ['identity.register', userId, input.product, 1]);
      return success({ email: input.email });
    }));
  }
  credential(email: string): Promise<Result<Credential | null>> {
    return this.execute(async () => {
      const rows = await this.pool.query(`SELECT u.user_id AS "userId",c.password_hash AS "passwordHash",u.active,u.security_revision AS "securityRevision",u.must_change_password AS "mustChangePassword"
        FROM public.identity_login_emails e JOIN public.identity_users u USING(user_id) JOIN public.identity_credentials c USING(user_id) WHERE e.email=$1`,[email]);
      return success(rows.rows[0] ?? null);
    });
  }
  createSession(input: SessionDraft): Promise<Result<Identity | null>> {
    return this.execute(() => this.tx(async client => {
      const user = await client.query("SELECT user_id FROM public.identity_users WHERE user_id=$1 AND active AND security_revision=$2 FOR SHARE",[input.userId,input.securityRevision]);
      if(!user.rows.length) return success(null);
      await client.query("INSERT INTO public.identity_sessions(token_hash,user_id,security_revision,expires_at,client) VALUES($1,$2,$3,$4,$5)",[input.tokenHash,input.userId,input.securityRevision,input.expiresAt,input.client??'api']);
      await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'login')",[input.userId]);
      const result = await client.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id) WHERE u.user_id=$1`,[input.userId]);
      return success(result.rows[0] as Identity);
    }));
  }
  identity(tokenHash: string,client:"api"|"browser"='api'): Promise<Result<Identity | null>> {
    return this.execute(async () => {
      const result = await this.pool.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) JOIN public.identity_login_emails e USING(user_id) WHERE ${SESSION_FILTER} AND s.client=$2`,[tokenHash,client]);
      return success(result.rows[0] ?? null);
    });
  }
  accountProfile(tokenHash: string): Promise<Result<AccountProfile | null>> {
    return this.execute(async () => {
      const result = await this.pool.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",
        COALESCE(p.avatar_id,'default') AS "avatarId",COALESCE(p.bio,'') AS bio,
        g.total_xp AS "totalXp",g.today_xp AS "todayXp",g.today_key::text AS "todayKey"
        FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
        LEFT JOIN public.identity_user_profiles p USING(user_id)
        LEFT JOIN public.identity_account_growth_projection g USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api'`,[tokenHash]);
      return success(profileFromRow(result.rows[0]));
    });
  }
  updateAccountProfile(tokenHash: string, patch: AccountProfilePatch): Promise<Result<AccountProfile | null>> {
    return this.execute(() => this.tx(async client => {
      const allowed=await client.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",
        COALESCE(p.avatar_id,'default') AS "avatarId",COALESCE(p.bio,'') AS bio
        FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
        LEFT JOIN public.identity_user_profiles p USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api' FOR UPDATE OF u`,[tokenHash]);
      if(!allowed.rows.length)return success(null);
      const userId=allowed.rows[0].userId,current=allowed.rows[0];
      const displayChanged=patch.displayName!==undefined&&patch.displayName!==current.displayName;
      const profileChanged=(patch.avatarId!==undefined&&patch.avatarId!==current.avatarId)||(patch.bio!==undefined&&patch.bio!==current.bio);
      if(displayChanged)await client.query('UPDATE public.identity_users SET display_name=$2,management_revision=management_revision+1 WHERE user_id=$1',[userId,patch.displayName]);
      if(profileChanged) {
        await client.query(`INSERT INTO public.identity_user_profiles(user_id,avatar_id,bio) VALUES($1,COALESCE($2,'default'),COALESCE($3,''))
          ON CONFLICT(user_id) DO UPDATE SET avatar_id=COALESCE($2,public.identity_user_profiles.avatar_id),bio=COALESCE($3,public.identity_user_profiles.bio),updated_at=now()`,
        [userId,patch.avatarId??null,patch.bio??null]);
      }
      if(displayChanged||profileChanged)await client.query(`INSERT INTO public.identity_management_audit(actor_id,target_id,action,reason)
        VALUES($1,$1,'identity.profile.updated','本人更新共享账号资料')`,[userId]);
      const result=await client.query(`SELECT u.user_id AS "userId",u.display_name AS "displayName",
        COALESCE(p.avatar_id,'default') AS "avatarId",COALESCE(p.bio,'') AS bio,
        g.total_xp AS "totalXp",g.today_xp AS "todayXp",g.today_key::text AS "todayKey"
        FROM public.identity_users u LEFT JOIN public.identity_user_profiles p USING(user_id)
        LEFT JOIN public.identity_account_growth_projection g USING(user_id) WHERE u.user_id=$1`,[userId]);
      return success(profileFromRow(result.rows[0]));
    }));
  }
  recordGrowthEvent(tokenHash: string, event: GrowthEventInput): Promise<Result<GrowthEventReceipt | null>> {
    return this.execute(() => this.tx(async client => {
      const allowed=await client.query(`SELECT u.user_id AS "userId" FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api' AND EXISTS(
          SELECT 1 FROM public.identity_product_access a WHERE a.user_id=u.user_id AND a.product_id=$2 AND a.active
        ) FOR UPDATE OF u`,[tokenHash,event.sourceProduct]);
      if(!allowed.rows.length)return success(null);
      const userId=allowed.rows[0].userId, rule=growthEventRule(event.sourceProduct,event.eventType);
      if(!rule || event.ruleVersion!==GROWTH_RULE_VERSION || event.points>rule.points)return failure('INVALID_INPUT','成长事件不符合中心规则');
      const state=await client.query(`SELECT (($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)::text AS "occurredDay",
        ((now() AT TIME ZONE 'Asia/Shanghai')::date)::text AS "todayKey"`,[event.occurredAt]);
      const projection=await client.query('SELECT total_xp,today_xp,today_key::text FROM public.identity_account_growth_projection WHERE user_id=$1 FOR UPDATE',[userId]);
      if(!projection.rows.length) {
        const count=await client.query('SELECT count(*)::int AS n FROM public.identity_account_experience_events WHERE user_id=$1',[userId]);
        if(count.rows[0].n>0)return failure('CONFLICT','中心成长投影缺失，请先完成历史迁移');
        await client.query("INSERT INTO public.identity_account_growth_projection(user_id) VALUES($1) ON CONFLICT DO NOTHING",[userId]);
      }
      const current=(await client.query('SELECT total_xp,today_xp,today_key::text FROM public.identity_account_growth_projection WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
      const duplicate=await client.query(`SELECT 1 FROM public.identity_account_experience_events
        WHERE user_id=$1 AND source_product=$2 AND event_type=$3 AND subject_key=$4`,[userId,event.sourceProduct,event.eventType,event.subjectKey]);
      if(duplicate.rows.length)return success(noGrowthAward(growthSummary(Number(current.total_xp),Number(current.today_xp),current.today_key)));
      const earned=(await client.query(`SELECT COALESCE(SUM(points),0)::int AS n FROM public.identity_account_experience_events
        WHERE user_id=$1 AND rule_version>=2 AND event_type<>'account_growth_reset'
          AND (occurred_at AT TIME ZONE 'Asia/Shanghai')::date=$2::date`,[userId,state.rows[0].occurredDay])).rows[0].n;
      const awarded=rule.dailyCap===null?event.points:Math.min(event.points,Math.max(0,rule.dailyCap-Number(earned)));
      if(awarded<=0)return success(noGrowthAward(growthSummary(Number(current.total_xp),Number(current.today_xp),current.today_key)));
      const inserted=await client.query(`INSERT INTO public.identity_account_experience_events
        (event_id,user_id,source_product,event_type,subject_key,points,rule_version,occurred_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING event_id`,
      [stableGrowthEventId(userId,event.sourceProduct,event.eventId),userId,event.sourceProduct,event.eventType,event.subjectKey,awarded,event.ruleVersion,event.occurredAt]);
      if(!inserted.rows.length)return success(noGrowthAward(growthSummary(Number(current.total_xp),Number(current.today_xp),current.today_key)));
      const total=Math.max(0,Number(current.total_xp)+awarded);
      const summary=growthSummary(total,state.rows[0].occurredDay===state.rows[0].todayKey?Number(earned)+awarded:Number(current.today_xp),state.rows[0].occurredDay===state.rows[0].todayKey?state.rows[0].todayKey:current.today_key);
      await client.query(`UPDATE public.identity_account_growth_projection SET total_xp=$2,cycle=$3,level=$4,today_xp=$5,today_key=$6,updated_at=now() WHERE user_id=$1`,
      [userId,summary.totalXp,summary.cycle,summary.level,summary.todayXp,summary.todayKey]);
      const receipt: GrowthEventReceipt = {awarded:true,awardedPoints:awarded,summary};
      return success(receipt);
    }));
  }
  navigatorAccess(tokenHash: string): Promise<Result<NavigatorAccess | null>> {
    return this.execute(async () => {
      const result = await this.pool.query(`SELECT u.user_id AS "userId",e.email,u.display_name AS "displayName",
        CASE WHEN u.identity_admin THEN 'superadmin'
          WHEN a.active AND EXISTS(SELECT 1 FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='navigator' AND g.role='operations' AND g.active) THEN 'operator'
          WHEN a.active AND EXISTS(SELECT 1 FROM public.identity_product_grants g WHERE g.user_id=u.user_id AND g.product_id='navigator' AND g.role='sales' AND g.active) THEN 'sales'
          ELSE NULL END AS role
        FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) JOIN public.identity_login_emails e USING(user_id)
        LEFT JOIN public.identity_product_access a ON a.user_id=u.user_id AND a.product_id='navigator'
        WHERE ${SESSION_FILTER} AND s.client IN ('api','browser') AND NOT u.must_change_password`,[tokenHash]);
      const row=result.rows[0];return success(row?.role ? row as NavigatorAccess : null);
    });
  }
  revoke(tokenHash: string): Promise<Result<void>> {
    return this.execute(() => this.tx(async client => {
      const result = await client.query("UPDATE public.identity_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING user_id",[tokenHash]);
      if(result.rows.length) await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'logout')",[result.rows[0].user_id]);
      return success(undefined);
    }));
  }
  listUsers(tokenHash: string): Promise<Result<Identity[]>> {
    return this.execute(async () => {
      // Authorization and result rows share one statement snapshot: no revoke-between-check-and-read gap.
      const rows = await this.pool.query(`WITH allowed AS (
        SELECT 1 FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) WHERE ${SESSION_FILTER} AND s.client='api' AND u.identity_admin AND NOT u.must_change_password
      ), items AS (
        SELECT ${IDENTITY_COLUMNS} FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id)
        WHERE u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM allowed) ORDER BY u.created_at,u.user_id LIMIT $2
      ) SELECT EXISTS(SELECT 1 FROM allowed) AS allowed,
        COALESCE((SELECT jsonb_agg(to_jsonb(items)) FROM items),'[]'::jsonb) AS items`,[tokenHash,AUTH_LIMITS.usersPage]);
      return rows.rows[0].allowed ? success(rows.rows[0].items as Identity[]) : failure("FORBIDDEN","无账号管理权限");
    });
  }
  ready(): Promise<Result<void>> {
    return this.execute(async () => {
      await this.pool.query("SELECT 1 FROM public.identity_users LIMIT 1");
      return success(undefined);
    });
  }
  createDesktopSession(input: DesktopSessionDraft): Promise<Result<Identity | null>> {
    return this.execute(() => this.tx(async client => {
      const user = await client.query('SELECT user_id FROM public.identity_users WHERE user_id=$1 AND active AND security_revision=$2 FOR UPDATE', [input.userId, input.securityRevision]);
      if (!user.rows.length) return success(null);
      const desktop = input.desktop;
      if (desktop) {
        await client.query(`UPDATE public.identity_sessions SET revoked_at=now(),revocation_reason='expired'
          WHERE user_id=$1 AND desktop_product=$2 AND revoked_at IS NULL AND expires_at<=now()`, [input.userId, desktop.product]);
        const active = await client.query(`SELECT desktop_device_id FROM public.identity_sessions
          WHERE user_id=$1 AND desktop_product=$2 AND revoked_at IS NULL FOR UPDATE`, [input.userId, desktop.product]);
        if (active.rows.some(row => row.desktop_device_id !== desktop.deviceId) && !desktop.replaceActiveDevice) {
          return failure('DEVICE_REPLACEMENT_REQUIRED', '该账号正在另一台电脑使用。继续登录会退出原电脑。');
        }
        await client.query(`UPDATE public.identity_sessions SET revoked_at=now(),revocation_reason='replaced'
          WHERE user_id=$1 AND desktop_product=$2 AND revoked_at IS NULL`, [input.userId, desktop.product]);
      }
      const session = await client.query(`INSERT INTO public.identity_sessions(
        token_hash,user_id,security_revision,expires_at,client,desktop_product,desktop_device_id,
        desktop_device_name,desktop_platform,desktop_app_version
      ) VALUES($1,$2,$3,$4,'api',$5,$6,$7,$8,$9) RETURNING session_id`, [
        input.tokenHash,input.userId,input.securityRevision,input.expiresAt,
        desktop?.product??null,desktop?.deviceId??null,desktop?.deviceName??null,desktop?.platform??null,desktop?.appVersion??null,
      ]);
      await client.query('INSERT INTO public.identity_desktop_refresh_tokens(token_hash,session_id,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4)', [input.refreshHash, session.rows[0].session_id, input.idleExpiresAt, input.absoluteExpiresAt]);
      await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'login')", [input.userId]);
      const identity = await client.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id) WHERE u.user_id=$1`, [input.userId]);
      return success(identity.rows[0]);
    }));
  }
  beginDesktopHandoff(input: DeviceHandoffBeginInput): Promise<Result<DeviceHandoffState>> {
    return this.execute(() => this.tx(async client => {
      const user = await client.query('SELECT user_id FROM public.identity_users WHERE user_id=$1 AND active AND security_revision IS NOT NULL FOR UPDATE', [input.userId]);
      if (!user.rows.length) return failure('UNAUTHORIZED', '账号不可用');
      await client.query(`UPDATE public.identity_device_handoffs SET status='expired',updated_at=now()
        WHERE user_id=$1 AND desktop_product=$2 AND status IN ('waiting_old_device','ready','blocked') AND expires_at<=now()`, [input.userId, input.desktop.product]);
      const previous = await client.query(`SELECT ${HANDOFF_COLUMNS} FROM public.identity_device_handoffs h
        WHERE h.user_id=$1 AND h.desktop_product=$2 AND h.request_key=$3 FOR UPDATE`, [input.userId, input.desktop.product, input.requestKey]);
      if (previous.rows.length) {
        const row = previous.rows[0];
        if (!['waiting_old_device','ready','blocked'].includes(String(row.status))) return failure('CONFLICT', '本次换机请求已经结束，请重新发起');
        const renewed = await client.query(`UPDATE public.identity_device_handoffs h SET token_hash=$2,expires_at=$3,updated_at=now()
          WHERE h.handoff_id=$1 RETURNING ${HANDOFF_RETURNING}`, [row.handoffId, input.tokenHash, input.expiresAt]);
        return success(handoffState(renewed.rows[0]));
      }
      const active = await client.query(`SELECT s.session_id,s.desktop_device_id,s.desktop_device_name
        FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
        WHERE s.user_id=$1 AND s.desktop_product=$2 AND s.revoked_at IS NULL AND s.expires_at>now()
          AND u.active AND u.security_revision=s.security_revision
        ORDER BY s.created_at DESC LIMIT 1 FOR UPDATE OF s`, [input.userId, input.desktop.product]);
      if (!active.rows.length) return failure('CONFLICT', '原电脑已经退出，请重新登录');
      if (String(active.rows[0].desktop_device_id ?? '') === input.desktop.deviceId) return failure('CONFLICT', '当前电脑已经是活跃设备');
      const pending = await client.query(`SELECT handoff_id FROM public.identity_device_handoffs
        WHERE user_id=$1 AND desktop_product=$2 AND status IN ('waiting_old_device','ready','blocked') FOR UPDATE`, [input.userId, input.desktop.product]);
      if (pending.rows.length) return failure('CONFLICT', '已有一台新电脑正在发起换机，请稍后重试');
      const inserted = await client.query(`INSERT INTO public.identity_device_handoffs(
        handoff_id,token_hash,request_key,user_id,desktop_product,old_session_id,old_device_id,old_device_name,
        new_device_id,new_device_name,new_platform,new_app_version,status,expires_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'waiting_old_device',$13)
      RETURNING ${HANDOFF_RETURNING}`, [
        input.handoffId,input.tokenHash,input.requestKey,input.userId,input.desktop.product,active.rows[0].session_id,
        active.rows[0].desktop_device_id,active.rows[0].desktop_device_name,input.desktop.deviceId,input.desktop.deviceName,
        input.desktop.platform,input.desktop.appVersion,input.expiresAt,
      ]);
      await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'device.handoff.begin')", [input.userId]);
      return success(handoffState(inserted.rows[0]));
    }));
  }
  desktopHandoffStatus(tokenHash: string): Promise<Result<DeviceHandoffState>> {
    return this.execute(() => this.tx(async client => {
      await client.query(`UPDATE public.identity_device_handoffs SET status='expired',updated_at=now()
        WHERE token_hash=$1 AND status IN ('waiting_old_device','ready','blocked') AND expires_at<=now()`, [tokenHash]);
      const result = await client.query(`SELECT ${HANDOFF_COLUMNS} FROM public.identity_device_handoffs h
        JOIN public.identity_users u USING(user_id) WHERE h.token_hash=$1 AND u.active FOR UPDATE OF h`, [tokenHash]);
      return result.rows.length ? success(handoffState(result.rows[0])) : failure('UNAUTHORIZED', '换机请求已失效');
    }));
  }
  pendingDesktopHandoff(refreshHash: string): Promise<Result<{ handoffId: string; newDeviceName: string; expiresAt: string } | null>> {
    return this.execute(() => this.tx(async client => {
      await client.query(`UPDATE public.identity_device_handoffs h SET status='expired',updated_at=now()
        FROM public.identity_desktop_refresh_tokens r
        WHERE h.old_session_id=r.session_id AND r.token_hash=$1
          AND h.status IN ('waiting_old_device','ready','blocked') AND h.expires_at<=now()`, [refreshHash]);
      const result = await client.query(`SELECT h.handoff_id AS "handoffId",h.new_device_name AS "newDeviceName",h.expires_at AS "expiresAt"
        FROM public.identity_desktop_refresh_tokens r JOIN public.identity_sessions s USING(session_id)
        JOIN public.identity_device_handoffs h ON h.old_session_id=s.session_id
        WHERE r.token_hash=$1 AND r.consumed_at IS NULL AND r.idle_expires_at>now() AND r.absolute_expires_at>now()
          AND s.revoked_at IS NULL AND s.expires_at>now() AND h.status IN ('waiting_old_device','ready','blocked')
        ORDER BY h.created_at DESC LIMIT 1`, [refreshHash]);
      if (!result.rows.length) return success(null);
      const row = result.rows[0];
      return success({ handoffId:String(row.handoffId), newDeviceName:String(row.newDeviceName), expiresAt:row.expiresAt instanceof Date ? row.expiresAt.toISOString() : String(row.expiresAt) });
    }));
  }
  prepareDesktopHandoff(refreshHash: string, input: DeviceHandoffPreparation): Promise<Result<DeviceHandoffState>> {
    return this.execute(() => this.tx(async client => {
      const result = await client.query(`SELECT ${HANDOFF_COLUMNS},s.user_id
        FROM public.identity_desktop_refresh_tokens r JOIN public.identity_sessions s USING(session_id)
        JOIN public.identity_device_handoffs h ON h.old_session_id=s.session_id
        WHERE r.token_hash=$1 AND r.consumed_at IS NULL AND r.idle_expires_at>now() AND r.absolute_expires_at>now()
          AND s.revoked_at IS NULL AND s.expires_at>now() AND h.status IN ('waiting_old_device','ready','blocked')
        ORDER BY h.created_at DESC LIMIT 1 FOR UPDATE OF h`, [refreshHash]);
      if (!result.rows.length) return failure('CONFLICT', '当前没有等待处理的换机请求');
      const row = result.rows[0];
      if (new Date(row.expiresAt).getTime() <= Date.now()) {
        await client.query("UPDATE public.identity_device_handoffs SET status='expired',updated_at=now() WHERE handoff_id=$1", [row.handoffId]);
        return failure('UNAUTHORIZED', '换机请求已过期');
      }
      const status = input.summary.blockers.length ? 'blocked' : 'ready';
      const updated = await client.query(`UPDATE public.identity_device_handoffs h SET status=$2,summary=$3::jsonb,prepared_at=now(),updated_at=now()
        WHERE h.handoff_id=$1 RETURNING ${HANDOFF_RETURNING}`, [row.handoffId,status,JSON.stringify(input.summary)]);
      await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,$2)", [row.user_id,status === 'ready' ? 'device.handoff.ready' : 'device.handoff.blocked']);
      return success(handoffState(updated.rows[0]));
    }));
  }
  completeDesktopHandoff(tokenHash: string, input: DesktopHandoffSessionDraft, takeoverReason?: string): Promise<Result<Identity | null>> {
    return this.execute(() => this.tx(async client => {
      const handoff = await client.query(`SELECT ${HANDOFF_COLUMNS},h.user_id,u.security_revision AS "securityRevision",h.old_session_id,h.new_device_id,h.new_device_name,h.new_platform,h.new_app_version,h.desktop_product
        FROM public.identity_device_handoffs h JOIN public.identity_users u USING(user_id)
        WHERE h.token_hash=$1 AND u.active FOR UPDATE OF h,u`, [tokenHash]);
      if (!handoff.rows.length) return success(null);
      const row = handoff.rows[0];
      if (new Date(row.expiresAt).getTime() <= Date.now()) {
        await client.query("UPDATE public.identity_device_handoffs SET status='expired',updated_at=now() WHERE handoff_id=$1", [row.handoffId]);
        return failure('UNAUTHORIZED', '换机请求已过期');
      }
      if (row.status === 'completed') return failure('CONFLICT', '本次换机已经完成，请直接登录新电脑');
      if (!['waiting_old_device','ready','blocked'].includes(String(row.status))) return failure('UNAUTHORIZED', '换机请求已失效');
      if (row.status !== 'ready' && !takeoverReason) return failure('CONFLICT', '原电脑尚未完成数据准备');
      await client.query(`UPDATE public.identity_sessions SET revoked_at=now(),revocation_reason=$2
        WHERE user_id=$1 AND desktop_product=$3 AND revoked_at IS NULL`, [row.user_id,takeoverReason?'device-takeover':'device-handoff',row.desktop_product]);
      const session = await client.query(`INSERT INTO public.identity_sessions(
        token_hash,user_id,security_revision,expires_at,client,desktop_product,desktop_device_id,
        desktop_device_name,desktop_platform,desktop_app_version
      ) VALUES($1,$2,$3,$4,'api',$5,$6,$7,$8,$9) RETURNING session_id`, [
        input.tokenHash,row.user_id,row.securityRevision,input.expiresAt,row.desktop_product,row.new_device_id,row.new_device_name,
        row.new_platform,row.new_app_version,
      ]);
      await client.query('INSERT INTO public.identity_desktop_refresh_tokens(token_hash,session_id,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4)', [input.refreshHash, session.rows[0].session_id, input.idleExpiresAt, input.absoluteExpiresAt]);
      await client.query(`UPDATE public.identity_device_handoffs SET status='completed',takeover_reason=$2,completed_at=now(),updated_at=now()
        WHERE handoff_id=$1`, [row.handoffId,takeoverReason ?? null]);
      await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,$2)", [row.user_id,takeoverReason ? 'device.handoff.takeover' : 'device.handoff.completed']);
      const identity = await client.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id) WHERE u.user_id=$1`, [row.user_id]);
      return success(identity.rows[0]);
    }));
  }
  cancelDesktopHandoff(tokenHash: string): Promise<Result<void>> {
    return this.execute(() => this.tx(async client => {
      const cancelled = await client.query(`UPDATE public.identity_device_handoffs SET status='cancelled',cancelled_at=now(),updated_at=now()
        WHERE token_hash=$1 AND status IN ('waiting_old_device','ready','blocked') RETURNING user_id`, [tokenHash]);
      if (!cancelled.rows.length) return success(undefined);
      await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'device.handoff.cancelled')", [cancelled.rows[0].user_id]);
      return success(undefined);
    }));
  }
  rotateDesktopSession(refreshHash: string, input: DesktopRotation): Promise<Result<{ identity: Identity; expiresAt: string; absoluteExpiresAt: string } | null>> {
    return this.execute(() => this.tx(async client => {
      // Lock the same stable session that admin revoke targets. No independent refresh grant can survive it.
      const session = await client.query(`SELECT s.session_id,s.user_id,r.absolute_expires_at FROM public.identity_desktop_refresh_tokens r
        JOIN public.identity_sessions s USING(session_id) JOIN public.identity_users u USING(user_id)
        WHERE r.token_hash=$1 AND r.consumed_at IS NULL AND r.idle_expires_at>now() AND r.absolute_expires_at>now()
        AND s.revoked_at IS NULL AND u.active AND s.security_revision=u.security_revision FOR UPDATE OF s,r FOR SHARE OF u`, [refreshHash]);
      if (!session.rows.length) {
        const replaced = await client.query(`SELECT 1 FROM public.identity_desktop_refresh_tokens r
          JOIN public.identity_sessions s USING(session_id) JOIN public.identity_users u USING(user_id)
          WHERE r.token_hash=$1 AND s.revocation_reason IN ('replaced','device-handoff','device-takeover') AND u.active`, [refreshHash]);
        return replaced.rows.length ? failure('DEVICE_REPLACED', '该账号已在另一台电脑登录') : success(null);
      }
      const row = session.rows[0];
      const consumed = await client.query('UPDATE public.identity_desktop_refresh_tokens SET consumed_at=now() WHERE token_hash=$1 AND consumed_at IS NULL RETURNING token_hash', [refreshHash]);
      if (!consumed.rows.length) return success(null);
      const updated = await client.query('UPDATE public.identity_sessions SET token_hash=$2,expires_at=LEAST($3::timestamptz,$4::timestamptz) WHERE session_id=$1 RETURNING expires_at', [row.session_id, input.tokenHash, input.expiresAt, row.absolute_expires_at]);
      await client.query('INSERT INTO public.identity_desktop_refresh_tokens(token_hash,session_id,idle_expires_at,absolute_expires_at) VALUES($1,$2,LEAST($3::timestamptz,$4::timestamptz),$4)', [input.refreshHash, row.session_id, input.idleExpiresAt, row.absolute_expires_at]);
      const identity = await client.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_users u JOIN public.identity_login_emails e USING(user_id) WHERE u.user_id=$1`, [row.user_id]);
      return success({ identity: identity.rows[0], expiresAt: updated.rows[0].expires_at.toISOString(), absoluteExpiresAt: row.absolute_expires_at.toISOString() });
    }));
  }
  desktopIdentity(tokenHash: string): Promise<Result<Identity | null>> {
    return this.execute(async () => {
      const result = await this.pool.query(`SELECT ${IDENTITY_COLUMNS} FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) JOIN public.identity_login_emails e USING(user_id)
        WHERE ${SESSION_FILTER} AND s.client='api' AND EXISTS(SELECT 1 FROM public.identity_desktop_refresh_tokens r WHERE r.session_id=s.session_id AND r.consumed_at IS NULL AND r.idle_expires_at>now() AND r.absolute_expires_at>now())`, [tokenHash]);
      if (result.rows[0]) return success(result.rows[0]);
      const replaced = await this.pool.query(`SELECT 1 FROM public.identity_sessions s JOIN public.identity_users u USING(user_id)
        WHERE s.token_hash=$1 AND s.client='api' AND s.revocation_reason IN ('replaced','device-handoff','device-takeover') AND u.active`, [tokenHash]);
      return replaced.rows.length ? failure('DEVICE_REPLACED', '该账号已在另一台电脑登录') : success(null);
    });
  }
  revokeDesktopSession(refreshHash: string): Promise<Result<void>> {
    return this.execute(() => this.tx(async client => {
      const revoked = await client.query(`UPDATE public.identity_sessions s SET revoked_at=now(),revocation_reason='logout' FROM public.identity_desktop_refresh_tokens r WHERE r.token_hash=$1 AND r.session_id=s.session_id AND s.revoked_at IS NULL RETURNING s.user_id`, [refreshHash]);
      if (revoked.rows.length) await client.query("INSERT INTO public.identity_audit(user_id,event) VALUES($1,'logout')", [revoked.rows[0].user_id]);
      return success(undefined);
    }));
  }
  changePassword(hash:string,expectedHash:string,revision:number,newHash:string,clientType:'api'|'browser'='browser'):Promise<Result<void>> {
    return this.execute(()=>this.tx(async client=>{
      await client.query('SELECT pg_advisory_xact_lock($1)',[ADMIN_LOCK]);
      const actor=await client.query(`SELECT u.user_id FROM public.identity_sessions s JOIN public.identity_users u USING(user_id) JOIN public.identity_credentials c USING(user_id)
        WHERE s.token_hash=$1 AND s.client=$4 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active AND u.security_revision=s.security_revision
        AND u.security_revision=$2 AND c.password_hash=$3 FOR UPDATE OF u,c`,[hash,revision,expectedHash,clientType]);
      if(!actor.rows.length)return failure('UNAUTHORIZED','会话或密码已变化，请重新登录');
      const id=actor.rows[0].user_id;
      await client.query('UPDATE public.identity_credentials SET password_hash=$2,changed_at=now() WHERE user_id=$1',[id,newHash]);
      await client.query('UPDATE public.identity_users SET must_change_password=false,security_revision=security_revision+1,management_revision=management_revision+1 WHERE user_id=$1',[id]);
      await client.query("UPDATE public.identity_sessions SET revoked_at=now(),revocation_reason='password-changed' WHERE user_id=$1 AND revoked_at IS NULL",[id]);
      await client.query('UPDATE public.identity_management_challenges SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',[id]);
      await client.query("INSERT INTO public.identity_management_audit(actor_id,target_id,action,reason) VALUES($1,$1,'identity.password.changed','用户主动设置新密码，全部旧会话已撤销')",[id]);
      await client.query("INSERT INTO public.identity_outbox(event_type,user_id,revision) SELECT 'identity.password.changed',user_id,management_revision FROM public.identity_users WHERE user_id=$1",[id]);
      return success(undefined);
    }));
  }
}
