# Prospector Database Schema

## 2026-10-21 收件箱 IMAP 续抓游标

本账号 `prospector.db` 的 `email_accounts` 增加两个可空列：`imap_fetch_uid_validity TEXT` 与 `imap_fetch_last_uid INTEGER`。两者必须成组解释：UIDVALIDITY 与当前邮箱一致时才使用最后 UID 继续下一批；UIDVALIDITY 变化视为服务器 UID 空间重建，从最近时间窗口重新开始。列由基础 `schema-sql.ts` 和幂等迁移 `v0.55-accounts-imap-fetch-cursor` 同源补齐，迁移不删除、不改写邮件或账号数据。中心 PostgreSQL 无结构变化。

## 2026-10-16 联系人索引分页（0.50.1，无中心迁移）

原crm-offline.db的crm_contact_mirror四列保持：contact_id INTEGER PK、customer_id TEXT NOT NULL、email_normalized TEXT可空、snapshot TEXT NOT NULL。新增page、followup_page、source_page、search_page四个crm_contact_mirror_前缀表达式索引。使用原JSON时间/来源/归属/搜索字段，无派生业务列或新副本。运行时先注册crm_contact_lower/time，再按唯一adapter DDL建索引。外部只读SELECT正常；不注册函数的镜像写入/integrity_check受限，旧版回滚先移除4索引。完整字段、索引、磁盘/写入成本和回滚SQL见[0.50.1交付](contact-pagination-delivery-20261016.md)。PostgreSQL无结构变更。

## 2026-10-16 确认命令保留与容量（0.50，无中心迁移）

crm_contact_commands仍为原permission_key、command_id、payload三列，原联合主键不变；新增5个查询/部分表达式索引。完整命令JSON增加confirmedAt，成功确认满30天且无未解决直接前驱依赖后变为显式receipt JSON，永久保留摘要和原/退役键。旧日期缺失先起完整保留期；pending/conflict/failed保留原内容。此前0.49“未自动清理”是该版本快照，本版只压缩完整输入，不删除去重凭据。无新表列或第二套CRM；完整字段与维护/容量边界见[0.50字典及交付](sync-capacity-delivery-20261016.md)。

## 2026-10-16 联系人离线命令（0.49，无中心迁移）

新增表在既有账号crm-offline.db，路径由accountProfileRoot按中心URL与不可变userId生成；不是新增数据库。DDL唯一来源src/main/adapters/contact-mirror-store.adapter.ts，CREATE IF NOT EXISTS按需执行。表结构：

```text
crm-offline.db
└─ crm_contact_commands
   ├─ permission_key TEXT NOT NULL ┐ composite PK
   ├─ command_id     TEXT NOT NULL ┘
   └─ payload        TEXT NOT NULL   JSON命令/处理状态
```

payload字段与状态转换详见[本节点字段字典](offline-contact-delivery-20261016.md#持久化字段)。仅保存请求、版本、依赖和必要历史，不重复存整份公司背调、邮件及活动详情。原crm_contact_mirror/details仅写中心确认；草稿在读详情时叠加。confirmed命令保留用于去重，未自动清理或迁移旧SQLite联系人。PostgreSQL仍沿原contacts、活动、幂等与outbox，无新增表列。

## 2026-10-16 已发回执迟到归档（025，0.48）

中心增加public.crm_send_authorizations（18字段，操作者/发送编号/联系人复合唯一、一次性消费邮件事实）；原crm_contact_mail_events增加archive_only boolean默认false。迟到归档新事实不影响当前摘要/阶段/版本，已有正常事实保持其原有贡献。025同一事务执行，既有迁移不改；不新增重复账号发送编号索引。

本账号data/prospector.db增加crm_send_authorizations（send_key、center_scope、payload、recorded_at，前两列复合主键）；命名迁移v0.48-center-send-authorizations。原receipt payload追加authorizations；crm-offline.db原mail队列payload追加sendAuthorizationId和必要的smtpAcceptance，仍是一份联系人投影。新旧邮件API职责不混用。全字段、图示与验收见[迟到回执交付](late-send-receipt-delivery-20261016.md)。

## 2026-10-16 邮件分类更正（024，0.47）

中心原 `crm_contact_mail_events` 增加 `classification_correction jsonb NULL` 与 `classification_revision integer NULL`。旧事实两列均空，更正均非空且修订号正整数；JSON严格限定前驱与目标分类，入站且禁止推进发送阶段。新增按操作者/邮箱/邮件/联系人/客户的唯一修订号索引、流检索索引、activity_id部分索引。DDL唯一来源 `server/adapters/postgres/contact-mail-correction-schema.ts`，原020/021不改。原邮件和活动不删除，当前摘要排除被更正贡献。

本账号 `data/prospector.db` 新增 `inbox_classification_changes` 七列：id、change_key、center_scope、message_id、source_json、status、created_at；id自增。change_key唯一UUID；center_scope为中心URL+账号；source_json捕获本次邮件元数据及目标分类；pending等待关联，queued只表示已入原镜像队列，不代表中心确认。命名迁移 `v0.47-inbox-classification-changes`，DDL唯一来源 `src/main/core/mail-classification-storage.ts`，Drizzle声明与基础schema同源。原 `crm-offline.db` 邮件事件payload承载更正链，不新增第二份CRM联系人。完整表字段与确认语义见mail-classification-correction-delivery-20261016.md。

## 2026-10-16 生命周期增量（022-crm-lifecycle）

只增5列和1索引，不新建业务表。contacts增加crm_deleted_at timestamptz、crm_deleted_by uuid→identity.users(user_id)；companies增加crm_created_by uuid、crm_deleted_at timestamptz、crm_deleted_by uuid，其中账号引用均指向identity.users。索引idx_crm_companies_creator覆盖有效公司的创建者。迁移唯一来源server/adapters/postgres/crm-lifecycle-schema.ts，原迁移checksum不变。

正式中心联系人/公司查询排除软删除行，详情、授权、导入关联及通知可打开判断同步过滤；历史SQL/管理审计可保留原始记录。删除递增原contact_version并写现有outbox/idempotency，不级联删除关系、活动、任务、商机或邮件事实；邮箱唯一约束保留，不能同邮箱自动重建。空公司删除须同时不存在contacts（含已删）及crm_customers，故客户关联任务/商机/历史仍受保护。

本地授权投影收到删除回执立即失效对应联系人，完整同步发现缺失也移除；待上传邮件事件转blocked、保留载荷，不假装已同步，不阻塞其他联系人。详见 [本次字段、链路、验证与部署范围](crm-lifecycle-delivery-20261016.md)。

## Current Authority

Current node: 0.38.0-alpha.1 (2026-10-15, workspace, not released). Contact list/detail and confirmed update/followup use the structured account projection. Full column-level inventory, constraints, indexes, JSON keys and extraction boundaries: [database-dictionary-20261015.md](database-dictionary-20261015.md). Earlier version-specific descriptions below are historical; detail now uses the shared base and downloaded supplements.

As of 2026-10-14 (0.36.0-alpha.1, local deployment, not released), the formal customer page reads and writes the central PostgreSQL CRM. Identity lives in its identity schema; contacts, companies, customer containers, activities, tasks, opportunities and assignment requests live in the same database. The executable DDL is under server/adapters/postgres, applied through the center migration registry. This is a model map, not a second DDL source.

2026-10-18 正式中心已导入 Navigator 的5个邮箱账号，并写入 `identity.legacy_account_mappings` 与 Navigator 产品授权；旧非邮箱账号（包括 `admin`）未迁移，中心原超级管理员继续作为唯一身份管理员。4个空显示名按邮箱补全。密码摘要以迁移期兼容算法保存，首次成功登录后由受控路径重算为中心 scrypt。

The desktop still uses SQLite through Drizzle ORM and `better-sqlite3` in WAL mode for existing personal mail/local functionality, historical contacts and account-scoped offline snapshots/compatibility queues. These historical contacts are not automatically migrated or deleted. Central contact IDs must never be passed to legacy local contact/mail write protocols. The tables below describe that local model unless explicitly marked central; SQLite is no longer the formal customer-page CRM authority.

`src/main/db/schema-sql.ts` is the executable schema source shared by production migrations and evaluation sandboxes. `src/main/db/schema/*.ts` supplies the typed Drizzle definitions. `src/main/db/index.ts` owns idempotent migrations for existing installations. This document is a map of the current model, not a second DDL source.

## Central contact assignment (019-contact-assignment-acceptance)

| Table/column | Purpose and constraints |
|---|---|
| contacts.crm_contact_version | Positive integer, default 1; contact-level optimistic version independent of customer container version |
| crm_contact_assignment_requests | request_id UUID PK; contact_id, customer_id, actor_id, target_user_id, notify_user_ids, status, version, created_at, decided_at |
| Assignment relationships | Identity user FKs and composite customer_id/contact_id FK to crm_customer_contacts; preserve the actual contact/customer association |
| Active assignment index | Unique contact_id where status is pending or accepted; no second active request for the same contact |
| List indexes | target_user_id/status/created_at and actor_id/status/created_at for role-specific pagination |

Statuses are pending, accepted, rejected and cancelled. Pending confers no contact-detail or development permission; effective contact owner is accepted target first, existing customer owner otherwise. Acceptance does not rewrite whole-customer ownership or copy contacts. Selected contacts, request decisions, optimistic versions, idempotency receipts and outbox events commit atomically; business failure rolls back the whole batch. Reassignment/release after acceptance is not implemented in this node. Customer-level tasks/opportunities retain their existing authorization; access to one contact does not grant sibling contacts or all company business data. See contact-assignment-delivery-20261014.md for runtime evidence and remaining mail/local migration boundaries.

## Sales Data

| Table | Purpose | Key fields |
|---|---|---|
| `companies` | Company profile and research data | `name`, `domain`, `country`, `backcheck_data` |
| `contacts` | Prospect and customer contacts | `email`, `company_id`, `stage`, `status`, `client_type`, `tags` |
| `crm_stages` | Current CRM stage and reminder for a contact | `contact_id`, `stage`, `reminder_at` |
| `crm_relations` | Contact-to-contact relationships | `contact_id_a`, `contact_id_b`, `relation_type` |
| `interactions` | Immutable contact timeline entries | `contact_id`, `type`, `direction`, `channel`, `metadata` |
| `templates` | Versioned email templates | `name`, `language`, `subject`, `body`, `version` |

`contacts.email` is the primary mailbox-matching identity. Interaction records provide the communication history; do not infer a contact state solely from a UI label.

## Mail Delivery and Inbox

| Table | Purpose | Key fields |
|---|---|---|
| `email_accounts` | Configured sending and receiving accounts | `email`, SMTP/IMAP settings, encrypted password, circuit-breaker state, IMAP UIDVALIDITY/last-UID fetch cursor |
| `send_block_events` | Auditable reasons a sender is blocked | `account_id`, `reason`, `created_at` |
| `send_queue` | Legacy and standalone delivery queue | `contact_id`, `account_id`, `status`, `scheduled_at`, `error_kind` |
| `send_campaigns` | Campaign definition and lifecycle | `name`, `status`, `sequence_json`, `started_at`, `completed_at` |
| `send_campaign_targets` | Per-contact campaign progress | `campaign_id`, `contact_id`, `status`, `next_touch_at`, `last_error` |

### N7-1 中心自动开发任务（已撤销后续方向，历史保留）

| 表 | 用途 | 关键字段 |
|---|---|---|
| `crm_campaigns` | 中心任务定义与状态 | `campaign_id`, `created_by`, `state`, `version`, `auto_send`, `confirmed_at`, `next_run_at` |
| `crm_campaign_targets` | 触点账本与租约 | `target_id`, `campaign_id`, `contact_id`, `customer_id`, `contact_version`, `round`, `state`, `lease_owner`, `lease_until`, `attempt_count` |
| `crm_campaign_attempts` | 一次 dry-run/未来执行尝试 | `attempt_id`, `target_id`, `execution_key`, `state`, `requested_at`, `completed_at` |
| `crm_campaign_receipts` | 尝试回执事实 | `receipt_id`, `attempt_id`, `state`, `recorded_at`, `detail` |

这些表来自已撤销的服务器托管发信预研，`auto_send` 强制为 `false`，不连接邮箱凭据、不执行 SMTP。当前正式方案是销售端本地发信，中心只保存同步记录；表结构暂保留用于审计和回退，不列入后续开发计划。
| `inbox_messages` | Imported incoming and sent-mail headers and previews | `account_id`, `message_id`, `from_email`, `classification`, `intent`, `matched_contact_id` |
| `inbox_bounce_matches` | Bounce-to-contact reconciliation | `message_id`, `contact_id`, `created_at` |

The application stores mail previews and metadata in the database. Message bodies are handled by the inbox services and are not represented by the obsolete `raw_source` column described in earlier versions of this document.

## Agent Control Plane

| Table | Purpose | Key fields |
|---|---|---|
| `agent_conversations` | Conversation metadata | `id`, `title`, `created_at`, `updated_at` |
| `agent_messages` | Persisted user and assistant messages | `conversation_id`, `role`, `content` |
| `agent_tool_calls` | Tool-call audit trail | `conversation_id`, `tool_name`, `arguments`, `result`, `status` |
| `agent_gaps` | Evidence or workflow gaps raised by the agent | `conversation_id`, `kind`, `status`, `payload` |
| `agent_suggestions` | Retained suggestion records for migration compatibility | `day`, `payload` |
| `agent_facts` | Persisted extracted facts | `conversation_id`, `fact`, `source` |
| `agent_working_memory` | Bounded structured context replayed during an agent session | `conversation_id`, `kind`, `payload`, `created_at` |

## Rate Data

| Table | Purpose | Key fields |
|---|---|---|
| `rate_quotes` | Quoted freight rates | `record_id`, `lane`, `carrier`, `valid_from`, `valid_to`, `source_group`, `msg_time` |
| `space_records` | Capacity and space observations | `record_id`, `lane`, `pod_raw`, `space_type`, `msg_time`, `source_group` |

The raw mirror remains the source of record. Query-side cleaning derives a presentation model and must preserve its source reference.

## Migration Rules

1. Change the typed Drizzle schema and `schema-sql.ts` together.
2. Add an idempotent named migration in `src/main/db/index.ts` for existing databases.
3. Preserve the production schema contract in `schema-sql.ts`, which evaluation sandboxes also execute.
4. Add or update migration tests before relying on a new column or index.

## Operational Notes

### Search index (0.9.0-alpha.1)

`search_idx` is an FTS5 virtual table installed by the named `v0.9-search-fts5` migration, after legacy business-table migrations. Only `content` is indexed; `kind`, `sourceId`, `contactId`, `title`, and `body` are UNINDEXED. Stable row ids encode the source table and id. Contacts, manual notes, and inbox rows are backfilled on migration and maintained by insert/update/delete triggers, including company-name changes. Full locally cached email bodies replace previews in the index.

The connection registers deterministic `search_latin` before migrations. Chinese text is retained in unindexed fields for LIKE fallback. FTS DDL is intentionally separate from `BASE_SCHEMA_SQL`: existing sql.js evaluation sandboxes lack FTS5, while the Electron/better-sqlite3 integration test executes the actual named migration and triggers. No business-table columns change. Both contact foreign-key indexes already exist in `schema-sql.ts` and now have matching Drizzle declarations.

SQLite runs in WAL mode. `saveDatabase()` performs a checkpoint after batches and during shutdown; individual writes are already durable. Backup location and retention are operational configuration, not schema.

## Mail dataflow (020-contact-mail-events, 2026-10-14)

Central crm_contact_mail_events stores actor/contact/customer/mailbox/message/event keys, kind/direction, occurred_at vs recorded_at, subject/preview/address metadata, digest and optional activity_id. UNIQUE(actor_id,event_key) and composite customer-contact FK; event/activity/touch/outbox commit together. Executable DDL: server/adapters/postgres/contact-mail-schema.ts.

Per-account crm-offline.db adds crm_contact_mirror(contact_id PK,customer_id,email_normalized,snapshot), crm_contact_mail_links(message_key,local_mail_id,mail_account_id,mailbox,contact_id,customer_id,role), crm_contact_mail_events(event_key PK,payload,status,error). Existing JSON cache/compatibility queue remains in the same file. Native schema lives in src/main/adapters/contact-mirror-store.adapter.ts. Both personal and accepted assigned contacts share mirror; only full authorized scan replaces snapshots. Pending facts and unique local mail/body are not disposable cache. No central ID written to legacy local contact FK; no automatic historical migration. Full scope: docs/mail-dataflow-delivery-20261014.md.
## Local contact read completeness (2026-10-15)

Existing per-account crm-offline.db adds crm_contact_mirror_meta(id INTEGER PRIMARY KEY CHECK(id=1),permission_key TEXT NOT NULL,format_version INTEGER NOT NULL). This singleton is committed atomically with a complete authorized snapshot replacement; partial upserts do not establish completeness. Empty complete snapshots are valid. Old snapshots without assignmentStatus require a fresh compatible full scan. Permission fingerprints are checked by both contact list and inbox matching. Explicit center authorization failures invalidate the projection and marker, preserving mail links and pending facts. No new central schema migration or database file: assignmentStatus is projected from existing pending/accepted request rows. Source: src/main/adapters/contact-mirror-store.adapter.ts and docs/local-contact-read-delivery-20261015.md.

## Viewed contact supplements (0.38.0-alpha.1)

Same-file crm_contact_details(contact_id INTEGER NOT NULL,customer_id TEXT NOT NULL,permission_key TEXT NOT NULL,snapshot TEXT NOT NULL,PRIMARY KEY(contact_id,customer_id)) stores downloaded CenterContactDetail responses. Displayed base/permissions always come from crm_contact_mirror. Snapshot includes company, activities, mailEvents and center response fields. Offline base-only responses have supplementAvailable=false and are not saved as complete history. Full contact scans do not download all histories.

saveDetail checks contact/customer versions and commits the accepted base plus supplements together. Complete replacement prunes missing or differently scoped supplements; explicit detail denial removes the exact local reference. Known invalidation increments sync revision; inflight write/mail receipts cannot add removed membership. Pending mail facts and source links are preserved. This is not a complete remote revocation/deletion protocol. No PostgreSQL table/column change or new database file.

## N4 outbound receipt (0.39.0-alpha.1)

PostgreSQL 021 adds crm_contact_mail_events.send_stage_advanced boolean NOT NULL DEFAULT false. Existing metadata digest is preserved; confirmed sent/outbound advance, marker and fact/activity/touch/outbox commit atomically. Ordinary Sent scans do not advance stages; duplicate confirmation upgrades once.

Account prospector.db adds nullable send_campaign_targets.center_reference_json TEXT and crm_send_receipts(send_key TEXT PRIMARY KEY NOT NULL,center_scope TEXT NOT NULL,payload TEXT NOT NULL,mail_ids TEXT NOT NULL,recorded_at TEXT NOT NULL,synced_at TEXT,history_hidden INTEGER NOT NULL DEFAULT 0), pending scope/synced index. Receipt payload includes original local HTML, account email, accepted recipients with explicit center reference, messageId/time and advance flag. Existing queue JSON preserves scope/reference. No new DB file; native receipt and original mailbox insert plus sent queue state are atomic. Pending receipt isn't disposable cache; history clearing only hides presentation. Full current catalog/JSON dictionary: database-dictionary-20261015-n4.md.

## 2026-10-15 AI联系人偏好局部写

没有新增表列或迁移。原contact-update输入增preferences?:string[]，最终保存到已有contacts.extra.preferences；服务器只更新该键，不替换其他extra字段。触达状态、关系阶段、发送阶段、真实tags彼此独立；contact-followup不再为阶段兼容覆盖tags。结构仍以database-dictionary-20261015-n4.md为准，本轮行为与边界见agent-contact-review-20261015.md。


## 2026-10-16 联系人协作授权增量（023）

新增public.crm_contact_shares，13列、3个业务索引及主键，关联原contacts、crm_customers、identity.users与crm_customer_contacts；不复制联系人，不新增SQLite业务表。逐列类型、约束、权限派生及同步边界见[共享交付与字段表](contact-sharing-delivery-20261016.md)。
## 2026-10-16 N6 中心联系人增量同步

新增 PostgreSQL `crm_contact_change_seq` 序列和 `crm_contact_changes` 表：`change_seq`、`event_id`、`recipient_user_id`、`contact_id`、`customer_id`、`event_type`、`version`、`created_at`，唯一键为 `event_id + recipient_user_id + contact_id`，索引为 `(recipient_user_id, change_seq)`。`007-contact-change-feed-n6` 迁移由服务启动时按 checksum 执行，并由 `identity.outbox` 触发器记录联系人投影变化。变化接口只返回当前授权快照或墓碑；本地 `contact-incremental-sync` 仅提供事务顺序应用器，运行时完整扫描仍是当前实际路径。历史事件不回填，启用时先做完整基线。

`008-contact-change-import-capture` 将上述迁移改为可重复执行，并把变化触发器收件人补充为 outbox 操作者本人。平面导入必须先插入联系人关联，再写客户创建/更新 outbox，确保触发器能看到新联系人；联系人本地镜像读取格式同时升到 v2，旧镜像首次启动会丢弃增量游标并做一次完整授权基线同步。

## 2026-10-16 N6-2 本地增量游标

`crm_contact_mirror_meta` 新增 `sync_cursor TEXT`，旧 SQLite 在打开时通过加法迁移补列。完整替换先清空游标，成功取得中心 `headCursor` 后写入；增量页成功应用后更新游标。该游标按账号资料库隔离，不改变旧联系人表或邮件表。

## 2026-10-22 联系状态与收件箱分类统一（031，工作区）

`031-contact-touch-outcomes` 把 `contacts.crm_touch_status` 和 `crm_shared_activities.contact_status` 扩展为 `uncontacted/contacted/replied/bounced/autoreply`。迁移按旧 `status` 回填回复、退信和自动回复，旧 `unreachable` 保守归一为 `uncontacted`；不新增列或重复状态表。跟进看板准入读取后四类中的任一类，已回复/退信/自动回复在 UI 额外显示“已触达”。

## 2026-10-18 统一账号资料与成长域（026/027，工作区）

中心 PostgreSQL 新增四张 `identity` 表：

- `identity.user_profiles`：跨产品头像和简介；`identity.users.display_name` 继续保存通用昵称。
- `identity.login_aliases`：跨产品登录别名，用于迁移旧 Navigator `operators.name`，不再建立 `navigator_users`。
- `identity.account_experience_events`：跨产品经验事实，带 `source_product`、规则版本和 `(user_id,source_product,event_type,subject_key)` 幂等键。
- `identity.account_growth_projection`：可重建的经验总量、循环、等级和当天经验投影。

迁移版本为 `026-unified-account-profile` 和 `027-unified-account-growth`，由身份仓储按 checksum 执行。该节点只建立中心 schema 和约束，不迁移 Navigator 数据、不切换登录、不新增公开 IPC/HTTP，也不写正式数据库。Navigator 航线偏好、来源群和报价发布身份仍属于 Navigator 产品库；Prospector 发信人名称和邮箱配置仍属于 Prospector。

`028-legacy-pbkdf2-compat` 将中心凭据约束扩展为允许迁移期的 `pbkdf2_sha256`。`PasswordAdapter` 只接受固定格式和 100000–1000000 的迭代次数，继续优先使用中心 `scrypt-v1`。2026-10-18 已导入5个 Navigator 邮箱账号；首次成功登录后由受控路径重算 scrypt，全部完成后关闭旧算法并恢复仅 scrypt 约束。

`029-legacy-account-mapping` 新增 `identity.legacy_account_mappings`，保存旧产品账号到中心账号的显式映射和状态：`pending`、`matched`、`needs_review`、`migrated`、`rejected`。表中不保存密码摘要、会话或 Token；`center_user_id` 允许为空，避免把未确认账号自动并入中心。删除中心用户前必须先处理映射记录，防止历史账号关系悬空。

## 030-lead-field-extension（2026-10-19，未部署正式中心）

`companies.customer_type text NULL CHECK IN ('代理','直客')`；`contacts.whatsapp/source_level1/source_level2 text NULL`。公司业务类型复用industry、网站复用domain；一二级来源不进入公司表。扩展联系人共享字段约束允许whatsapp，历史约束原迁移不改写；实际权限排除公司类型和国家。公司无分类时仅兼容读旧contact.client_type，不自动猜测回填。新迁移置于lead迁移链末尾，隔离实例创建与重复migrate通过。详见 `lead-import-fields-20261019.md`。
