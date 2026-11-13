# Prospector Database Schema

## 2026-11-12 收件箱置顶与文件夹（本地 SQLite）

| 表/字段 | 变更与用途 |
|---|---|
| `inbox_labels.source/status` | 区分用户文件夹和 AI 建议文件夹；`source=user|ai`，`status=active|suggested` |
| `inbox_label_candidates` | 保存 AI 建议文件夹的候选邮件；用户确认后才转入 `inbox_message_labels` |
| `inbox_pinned_messages` | 当前账号置顶邮件；`message_id` 主键并随邮件级联删除 |
| `inbox_folder_suggestion_dismissals` | 用户删除 AI 建议后记录规范化名称，避免下次启动重复建议 |

迁移名：`v0.72-inbox-folders`。旧标签默认补为 `source=user/status=active`，不丢失原有邮件关联；所有数据只存在当前账号本机 SQLite。

## 2026-11-09 个人收件 AI 分析（本地 SQLite）

| 表 | 字段 | 约束与用途 |
|---|---|---|
| `inbox_mail_analyses` | `message_id`、`content_hash`、`category`、`priority`、`requires_action`、`summary`、`next_action`、`due_hint`、`confidence`、`evidence_json`、`source`、`analyzer_version`、`status`、`error`、`updated_at` | 每封本地邮件一行；`message_id` 主键并随邮件级联删除；`status` 为 `pending/ready/failed`；人工结果以 `source=human` 标记且不会被 AI 覆盖 |
| `mail_analysis_jobs` | `job_key`、`payload_json`、`status`、`attempt`、`next_attempt_at`、`last_error`、`created_at`、`updated_at`、`completed_at` | 客户邮件 AI 分析的本地可恢复队列；主键为幂等任务键；状态为 `pending/running/retrying/completed/failed`；启动时 `running` 恢复为 `pending`，完成记录保留7天、失败记录保留30天 |
| `inbox_todo_states` | `message_id`、`state`、`operation_key`、`updated_at` | 单封邮件内联待办状态；`message_id` 主键并随邮件级联删除；`state=open/done`；`operation_key` 唯一用于幂等；与邮件已读状态独立 |
| `inbox_seen_outbox` | `account_id`、`message_id`、`attempts`、`last_error`、`created_at`、`updated_at` | 程序内已读待回写 IMAP `\Seen` 的持久 outbox；`(account_id,message_id)` 主键；服务器确认前保留，重启或回写失败不会恢复未读 |

迁移名：`v0.72-inbox-mail-analyses`、`v0.72-mail-analysis-queue`、`v0.72-inbox-todo-states`。三张表只存在当前账号本机 SQLite，不同步中心，不保存正文、附件或模型原始响应；最近 200 封只作为回填起点，不是固定能力上限。分析任务表只保存恢复所需输入和状态，重启后恢复 `pending/retrying`，崩溃遗留的 `running` 回到 `pending` 后重新提交。待办状态表只记录用户已处理/重新打开，不修改原邮件或 AI 分析记录。

## 2026-11-09 换机事务（066-067，工作区已实现，正式未部署）

| 迁移 | 主要对象 | 事实与边界 |
|---|---|---|
| `066-device-handoff` | `public.identity_device_handoffs` | 记录换机请求、旧/新设备、旧 session、状态、盘点摘要、接管原因和过期时间 |
| `067-device-handoff-audit` | `public.identity_audit` 事件约束 | 允许记录 begin、ready、blocked、completed、takeover、cancelled 六类换机审计 |

`identity_device_handoffs` 的唯一键为 `(user_id,desktop_product,request_key)`，同一用户同一产品同时只能存在一个 `waiting_old_device / ready / blocked` 请求。token 只保存哈希；摘要只保存计数、阻断项与检查时间，不保存密码、邮件正文、邮件凭据、OAuth、会话令牌或 `master.key`。完成事务锁住请求和用户，在一个事务内撤销旧 session、创建新 session、标记请求完成并写审计；旧 access/refresh 后续返回 `DEVICE_REPLACED`。

运行 SQL 在 `server/adapters/postgres/device-handoff-schema.ts`，正式库可单独执行 `deployment-templates/company-postgres-device-handoff-066-067.sql`。独立脚本不写迁移 checksum；中心启动时仍按运行 SQL 的 SHA-256 校验并记录迁移版本。

## 2026-11-06 收件箱自定义标签（本地 SQLite）

| 表 | 字段 | 约束与用途 |
|---|---|---|
| `inbox_labels` | `id`、`name`、`color`、`created_at`、`updated_at` | 本地用户标签；名称忽略大小写唯一，颜色为 `#rrggbb` |
| `inbox_message_labels` | `message_id`、`label_id`、`created_at` | 邮件与标签多对多；`(message_id,label_id)` 主键；邮件或标签删除时级联清理关系 |
| `inbox_label_operations` | `operation_key`、`result_json`、`created_at` | 标签写操作幂等回执；保留 30 天，重复请求返回同一结果 |

迁移名：`v0.71-inbox-labels`。该能力只写本机业务 SQLite，不同步中心，也不替代邮件分类或联系人标签。

## 2026-11-03 线索范围重叠（065，工作区已实现，正式未部署）

| 对象 | 变更 |
|---|---|
| `contacts` | 移除全局 `idx_contacts_email`，保留普通邮箱查询索引；同邮箱可跨运营/个人范围并存 |
| `crm_customers` | 唯一索引改为 `source + customer_key + origin + owner_user_id`，不同范围客户键互不冲突 |
| `crm_lead_overlaps` | 新增重叠记录：两端联系人/客户、`same_email`/`same_company_country`/`similar_company`、状态和时间 |
| `crm_deal_overlap_notices` | 新增成交通知：重叠、成交联系人、接收负责人、商机、确认状态和版本 |

迁移版本 `065-lead-scope-overlaps`，运行 SQL 在 `server/adapters/postgres/lead-overlap-schema.ts`，公司库模板在 `deployment-templates/company-postgres-lead-overlap-065.sql`。导入不因跨范围相同邮箱失败，只记录重叠；同范围仍由现线索冲突流程判重。成交 `closed_won` 生成幂等通知，不修改历史归属。

## 2026-10-30 团队解散与软删除（064-organization-dissolution）

`064` 为中心组织树增加软解散生命周期：`crm_org_units` 增加 `dissolved_at/dissolved_by`，`crm_org_assignments` 增加 `ended_at`，新增追加式 `crm_org_dissolution_audits`。解散事务只结束当前组织关系、取消 pending 邀请、删除展示分组并递增单元版本；组织行、联系人、联系人归属、当前分配、导入批次和来源组织快照全部保留。

运行时的团队上下文、详情、管理列表、候选、分配主管、监督、监控和绩效查询只使用 `dissolved_at IS NULL` 的组织和 `ended_at IS NULL` 的关系。公司根不能解散；有活动下级的运营组必须先移动或解散下级；只有 primary leader、运营管理员和超级管理员可以执行。`TeamSnapshot.canDissolve` 由服务端结合身份和活动下级计算，不在前端猜权限。

迁移 checksum 为 `ebfe752781fb2df4be1bd8169804883cf69e968150d2e9742697665a24ad522d`。完整 bootstrap 和 DMS 表/可编程对象均包含该版本；隔离空库实测为 `115` 表、`2` 视图、`1119` 字段、`1306` 约束、`321` 索引、`46` 条迁移，组织解散审计触发器存在。

## 2026-10-30 本地邮件首次同步状态（0.69.0 工作区）

本机 SQLite 新增 `email_sync_state`，主键为 `(account_id, folder)`，随邮箱账号删除级联删除。记录 `phase`、时间窗口、UID 游标、目标/扫描/新增/匹配/剩余数量、首次完成时间、最近增量时间、错误和更新时间。它只是当前设备上 IMAP 首次/历史同步的可恢复进度，不是中心共享事实，也不保存邮件正文或凭据。

首次窗口为最近 90 天入站邮件与服务器最新 200 封的并集；每批最多 500 封，后台会连续推进直到窗口完成。窗口完成后才允许 `inbox:syncHistory` 向更早月份继续补拉。迁移名称为 `v0.69-email-sync-state`，与 `schema-sql.ts` 同步。

## 2026-10-30 CRM 核心迁移 057-062（工作区基线，未部署）

以下迁移均由 `server/adapters/postgres/*-schema.ts` 的 SQL 文本计算 SHA-256。`company-postgres-bootstrap.sql` 与 `company-postgres-tables.sql` 已写入相同版本和 checksum；应用启动发现记录一致时跳过重复建表，不一致时拒绝继续。当前工作区基线不代表本机 `55847` 或正式中心已经应用。

| 迁移 | checksum | 主要对象 | 事实与边界 |
|---|---|---|---|
| `057-contact-assignment-state` | `a3d4bb7bebfcb3e8ddcf3bbd1ff8d99a38bbdabc3ce8f98327d390e6cd30f8fb` | `crm_contact_ownership`、`crm_contact_monitor_audits`，分配请求增加 7 天到期、转交字段和来源组织快照 | 当前归属取 `crm_contact_ownership` 的唯一开放行；接受、拒绝、撤回、过期、转交待确认都有历史。主管监督读取单独审计，不授予普通联系人读写。 |
| `058-lead-ingress-conflict` | `e4cd1b6e1c376c8e2e75451980f0b63621dd7378831189bf5bf4bacf5ddae773` | `crm_lead_match_decisions` | 记录统一入口的邮箱、域名、公司名、国家、候选、裁决、幂等和受限结果；用于审批与重放，不替代联系人主档。 |
| `059-contact-mail-analysis` | `15f634196a13af8dbc9d132b813393d766bd2b471fd726b4ce780a781aac616b` | `crm_contact_mail_analyses`、`crm_contact_mail_task_suggestions` | 追加式规则/AI/人工分析、当前版本指针、结构化信号和任务建议。主键组合保证同一邮件分析幂等；人工锁定优先，不存正文或附件。 |
| `060-team-attention-task-gating` | `4cc0018361fe8ab3faf6d9f9d1aa638dfca9bcbc1b1f4ecea78c77b00f5f716d` | 跟进任务来源字段与去重索引、`crm_team_attention_items/audits/idempotency/notifications` | 只有明确询价、报价、投诉、订单动作或退信修正进入待办门槛；关注项独立于客户待办，状态为 `open/acknowledged/resolved/dismissed`。 |
| `061-team-monitoring` | `32f0c44454c2d03069355411944de177169557290d2597c30332dd8e114e4095` | `crm_team_monitoring_audits`、邮件/分析/任务聚合索引 | 联系人和邮件下钻先写审计；审计表由触发器禁止更新和删除。接口只返回结构化摘要，不读取邮件正文或附件。 |
| `062-sales-performance-customer-grade` | `abd5a75764ef941846171b0c7c91732de94225024a79741dab9315d9effac38a` | `crm_customer_grade_overrides/audits/idempotency`、查询索引 | 销售指标和 A/B/C 等级实时派生；只持久化人工覆盖、原因、版本和审计，不保存评分或等级快照。 |

所有新 Prospector 对象使用 `prospector` schema，身份引用使用 `public.identity_users`，消息复用 `public.identity_outbox`。`company-postgres-schema-split.sql` 与 rollback 已包含 057-062 的新增表；`company-postgres-programmable.sql` 包含 061/062 的追加式审计触发器。完整 bootstrap 的 DMS 表文件是全新库的一次性结构工单；传输重试的幂等由各表唯一键、操作回执和迁移 checksum 完成，不承诺把已部分执行的 DMS 工单本身重复执行。DMS 文件保留 44 条迁移记录并故意不记录 `056`，让应用启动补建组织触发器；057-062 六条记录均已写入。

隔离验证（2026-10-30）：完整 bootstrap 在临时空库执行成功，得到 `114` 张表、`2` 个视图、`1107` 字段、`1286` 个约束、`316` 个索引、`45` 条迁移和 061/062 两个追加式触发器。DMS 表文件加可编程对象在另一临时空库执行成功，结果为 `57` 张 Prospector 表、`549` 字段、`821` 约束、`178` 索引。两套临时库均已删除，未连接或修改现有中心。

## 2026-10-29 Prospector 单活跃设备（008-desktop-active-device-public）

`public.identity_sessions` 新增 `desktop_product`、`desktop_device_id`、`desktop_device_name`、`desktop_platform`、`desktop_app_version` 和 `revocation_reason`。部分唯一索引 `idx_identity_sessions_active_desktop_product(user_id,desktop_product)` 只覆盖 `desktop_product IS NOT NULL AND revoked_at IS NULL`，保证同一 CRM 桌面用户最多一个活跃设备，同时不影响 Navigator、浏览器和旧版无设备信息的 API 会话。

登录事务锁住中心用户后再检查/撤销旧会话，旧 refresh token 随原 session 一起失效。部署模板 `company-postgres-tables.sql` 与 `company-postgres-bootstrap.sql` 已同步；当前一次性空库执行基线为 101 张表、936 个字段、1,039 个约束、258 个索引、39 条迁移和 2 个视图。该类会话元数据属于运行状态，含设备显示名但不保存账号密码、邮箱授权码或 Token 原文。

## 2026-10-29 公司三 schema 正式落位

`milogin_center` 已从全部对象集中在 `public` 改为三 schema：`public` 保留 17 张共享身份/公共表，`prospector` 保存 32 张 CRM 业务表，`navigator` 保存 40 张运价及运行表。迁移工单 `28630577` 仅执行 `ALTER TABLE/SEQUENCE SET SCHEMA`，89 张表、379 个约束、219 个索引和业务数据均保持不变。

Prospector 生产连接使用 `search_path=prospector,public`，Navigator 使用 `FREIGHT_POSTGRES_SCHEMA=navigator` 生成 `search_path=navigator,public`。后续新建 Prospector 表必须落在 `prospector`，Navigator 表落在 `navigator`，共享账号和产品种子继续留在 `public`。

## 2026-10-29 组织关系（051/052 / 053 / 055 canonical / 056 integrity）

`051-team-foundation-public` 与 `052-team-tree-public` 只保留为旧团队表兼容层。`055-organization-canonical` 建立运行时唯一组织模型：

| 表 | 作用 | 关键约束 |
|---|---|---|
| `prospector.crm_org_units` | 公司根、运营组、销售团队的 canonical 组织树 | `kind=company/operations_group/sales_team`；公司根唯一；销售团队为叶子；同一父级名称大小写不敏感唯一 |
| `prospector.crm_org_assignments` | 负责人/普通成员关系 | 普通成员在全部销售团队中最多一条；每个组织单元最多一个 primary leader；leader 可管理多个销售团队 |
| `prospector.crm_org_invitations` | 邀请和生命周期历史 | pending/accepted/declined/cancelled/expired；同一单元同一账号只有一条 pending；取消更新状态而不删除历史 |
| `prospector.crm_org_idempotency` | 创建、移动、换负责人、成员和分组操作的幂等回执 | `(actor_id,operation,idempotency_key)` 主键；相同请求重放首次结果，不同请求冲突 |
| `prospector.crm_org_member_groups` | 团队内展示分组 | 有条目版本；只用于展示，不改变归属或权限 |
| `prospector.crm_org_member_group_members` | 展示分组成员 | 只允许当前团队负责人或普通成员，跨团队引用被外键拒绝 |

`053-org-supervision-public` 为联系人分配增加直属主管快照和来源组织字段；`055` 将旧团队数据一次性迁入 canonical 表并冻结旧表，运行时不再读写 `crm_teams/crm_team_members`。`056-organization-assignment-integrity` 在数据库触发器中强制“普通成员不能同时成为其他团队负责人”，并按用户序列化并发关系写入。

普通销售只能读取本人成员行，但 `TeamSnapshot.memberCount` 始终返回服务端聚合的完整人数。运营管理员共享运营来源权限，不是组织成员关系；超级管理员查看完整公司树但不写入成员关系。`company-postgres-bootstrap.sql` 包含完整 canonical 对象、触发器以及 055/056 迁移记录；DMS 使用的 `company-postgres-tables.sql` 只包含普通表和索引，保留 055 记录但故意不记录 056，应用启动时会应用 056 创建或替换触发器，避免把触发器混入表工单。迁移记录按 SQL 文本 SHA-256 校验，已存在记录的 checksum 不一致时服务会拒绝继续，而不是覆盖。文档只描述工作区基线，不表示任何本地或正式中心已经部署 055/056。

## 2026-10-28 历史映射：拆分前全部使用 public

这是 2026-10-29 拆分前的历史映射。中心账号区仍保留在 `public`：

- `identity.users` → `public.identity_users`
- `identity.login_emails` → `public.identity_login_emails`
- `identity.credentials` → `public.identity_credentials`
- `identity.product_grants` → `public.identity_product_grants`
- `identity.product_access` → `public.identity_product_access`
- `identity.sessions` → `public.identity_sessions`
- 其他中心表同理使用 `public.identity_*`。

拆分后 Prospector 业务表迁入 `prospector`，Navigator 运价和运行表迁入 `navigator`。历史交付文中出现的 `identity.*` 和全部 `public` 业务表描述只代表当时结构，不代表当前部署 SQL。中心迁移版本仍按 checksum 核验，不能把旧 schema 的关键词替换当作已完成迁移。

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
