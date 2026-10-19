# Prospector 实际数据库字典 · 2026-10-15

结构采集时间：2026-10-15T01:36:29.073Z。这是本机隔离中心测试库和当前源码新建的隔离原生 SQLite 快照，不是生产数据库普查。只读取 PostgreSQL 系统目录/迁移版本；未读取客户、邮件、口令、令牌或其他业务字段的值。

## 1. 权威、存储职责与 ID 边界

| 存储 | 当前职责 | 标识和边界 |
|---|---|---|
| 中心 PostgreSQL public/identity | 正式联系人、公司、客户、分配、跟进、商机、任务、通知、统一身份 | 身份/customer/request/event多用UUID；contact/company为中心整数ID。公司共享不授予同公司全部联系人或业务权限。 |
| 账号本地 data/prospector.db | 个人邮件账号与收件箱、正文检索、历史本地联系人/互动、发送任务、Agent、运价镜像 | 本地contact.id和中心contactId不是同一命名空间；禁止把中心ID写入旧local contact FK。正文文件仍单独存储。 |
| 账号本地 crm-offline.db | 授权联系人镜像、完整性标记、跨文件邮件关联、待同步邮件事实、兼容离线CRM JSON工作集 | 中心URL与不变userId联合SHA256定位accounts目录；不同账号不共享工作集。projection可以失效；邮件关联与待同步事实不是可随意丢弃的缓存。 |

路径与归属依据：`src/main/adapters/desktop-local-scope.adapter.ts`、`src/main/config.ts`、`src/main/adapters/offline-crm-store.adapter.ts`、`src/main/adapters/contact-mirror-store.adapter.ts`。当前旧目录、匿名历史库不自动迁移、复制、归属或删除。本次未打开任何人用本地数据库，因此不声称所有账号旧库均已升级。

## 2. 提取、校验与漂移核对

- PostgreSQL 18.6，实际36张表/278列。使用REPEATABLE READ READ ONLY事务获取pg_class/pg_attribute/pg_attrdef/pg_constraint/pg_indexes/pg_trigger；information_schema可用但本次用pg_catalog保留identity/generated和格式化类型。
- 原生Electron/better-sqlite3实际SQLite 3.53.2：执行真实initDatabase/runMigrations两遍，路径/logger替换为隔离fixture；31张表/276列，其中FTS5虚拟/影子表与sqlite_sequence也完整列出。离线库实际6张表/24列，通过真实Store初始化。
- 17个中心源码迁移与实际注册表逐项SHA256核对，匹配17个；本地命名迁移记录23项。跳号是现有版本命名，不补造缺号。
- 源DDL到实际PG另核对35表/275列的名称、类型、可空性和24个源码显式索引存在性；发现0项差异。迁移注册表本身由repository.ts创建，单独完整列入。
- 注册表checksum匹配只证明应用记录对应当前DDL，不证明库从未被手工ALTER。实际默认值、完整约束/索引表达式、触发器均逐表列出；本次未通过另建PG重放整个DDL来证明这些表达式逐字/语义完全相同。
- SQLite约束以实际sqlite_master CREATE SQL、PRAGMA table_xinfo/foreign_key_list/index_list/index_xinfo为准。INTEGER PRIMARY KEY的PRAGMA notnull可能为0；不将它误写为业务允许空主键，PK仍控制行标识。源schema-sql不含后来命名迁移新增的archived_at/intent/error_kind/FTS，已采用完整迁移后结构。
- 个人SQLite另在原生内存库执行BASE_SCHEMA_SQL并逐列对照完整迁移结果：新增列`agent_conversations.archived_at`、`inbox_messages.intent`、`send_queue.error_kind`；新增表`_migrations`、`crm_send_receipts`、`search_idx`、`search_idx_config`、`search_idx_content`、`search_idx_data`、`search_idx_docsize`、`search_idx_idx`；基底列缺失0项，基底列PRAGMA定义变化0项。新增项来自db/index.ts/runMigrations及search-index.ts，非本次比对发现的额外漂移。未穷举用户旧库DDL，也未证明每个Drizzle声明与目录定义完全同构。
- 结构原件：`.work/center-send/schema-inventory.json`；可重采脚本：`dictionary-extract.cjs`、`dictionary-native.cjs`、`dictionary-render.cjs`。脚本仅使用已安装esbuild/pg/better-sqlite3与标准库，无新增依赖。

## 3. 中心 PostgreSQL：每表、每列与真实约束

### identity.audit

身份登录审计

源码依据：`server/adapters/postgres/auth-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | bigint | 否 | identity=a;  | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `user_id` | uuid | 是 | — | 中心身份用户UUID |
| `event` | text | 否 | — | 身份审计事件类型 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `audit_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `audit_event_check` [c]：`CHECK (event = ANY (ARRAY['login'::text, 'logout'::text, 'fixture'::text]))`；validated=true，deferrable=false
- `audit_event_not_null` [n]：`NOT NULL event`；validated=true，deferrable=false
- `audit_id_not_null` [n]：`NOT NULL id`；validated=true，deferrable=false
- `audit_pkey` [p]：`PRIMARY KEY (id)`；validated=true，deferrable=false
- `audit_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX audit_pkey ON identity.audit USING btree (id)`

### identity.credentials

中心口令摘要

源码依据：`server/adapters/postgres/auth-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `password_hash` | text | 否 | — | 口令不可逆摘要；只记录字段结构，不输出值 |
| `hash_scheme` | text | 否 | — | 密码摘要方案标识scrypt-v1 |
| `changed_at` | timestamp with time zone | 否 | now() | 凭据更新时刻 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `credentials_changed_at_not_null` [n]：`NOT NULL changed_at`；validated=true，deferrable=false
- `credentials_hash_scheme_check` [c]：`CHECK (hash_scheme = 'scrypt-v1'::text)`；validated=true，deferrable=false
- `credentials_hash_scheme_not_null` [n]：`NOT NULL hash_scheme`；validated=true，deferrable=false
- `credentials_password_hash_not_null` [n]：`NOT NULL password_hash`；validated=true，deferrable=false
- `credentials_pkey` [p]：`PRIMARY KEY (user_id)`；validated=true，deferrable=false
- `credentials_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `credentials_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX credentials_pkey ON identity.credentials USING btree (user_id)`

### identity.desktop_refresh_tokens

桌面刷新会话轮换

源码依据：`server/adapters/postgres/desktop-session-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `token_hash` | text | 否 | — | 会话/挑战/刷新令牌的SHA256摘要；不存可直接使用的明文令牌 |
| `session_id` | uuid | 否 | — | 中心会话UUID |
| `absolute_expires_at` | timestamp with time zone | 否 | — | 桌面刷新会话的绝对截止时间 |
| `idle_expires_at` | timestamp with time zone | 否 | — | 桌面刷新会话的空闲截止时间 |
| `consumed_at` | timestamp with time zone | 是 | — | 挑战、刷新令牌或通知事件被消费时间 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `desktop_refresh_tokens_absolute_expires_at_not_null` [n]：`NOT NULL absolute_expires_at`；validated=true，deferrable=false
- `desktop_refresh_tokens_check` [c]：`CHECK (idle_expires_at <= absolute_expires_at)`；validated=true，deferrable=false
- `desktop_refresh_tokens_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `desktop_refresh_tokens_idle_expires_at_not_null` [n]：`NOT NULL idle_expires_at`；validated=true，deferrable=false
- `desktop_refresh_tokens_pkey` [p]：`PRIMARY KEY (token_hash)`；validated=true，deferrable=false
- `desktop_refresh_tokens_session_id_fkey` [f]：`FOREIGN KEY (session_id) REFERENCES identity.sessions(session_id)`；validated=true，deferrable=false
- `desktop_refresh_tokens_session_id_not_null` [n]：`NOT NULL session_id`；validated=true，deferrable=false
- `desktop_refresh_tokens_token_hash_check` [c]：`CHECK (token_hash ~ '^[a-f0-9]{64}$'::text)`；validated=true，deferrable=false
- `desktop_refresh_tokens_token_hash_not_null` [n]：`NOT NULL token_hash`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX desktop_refresh_tokens_pkey ON identity.desktop_refresh_tokens USING btree (token_hash)`
- `CREATE INDEX idx_desktop_refresh_session ON identity.desktop_refresh_tokens USING btree (session_id)`

### identity.login_emails

中心登录邮箱

源码依据：`server/adapters/postgres/auth-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `email` | text | 否 | — | 邮箱地址；唯一性/是否允许空值见实际DDL |
| `verified_at` | timestamp with time zone | 是 | — | 登录邮箱验证时刻 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `login_emails_email_check` [c]：`CHECK (email = lower(btrim(email)) AND email <> ''::text)`；validated=true，deferrable=false
- `login_emails_email_key` [u]：`UNIQUE (email)`；validated=true，deferrable=false
- `login_emails_email_not_null` [n]：`NOT NULL email`；validated=true，deferrable=false
- `login_emails_pkey` [p]：`PRIMARY KEY (user_id)`；validated=true，deferrable=false
- `login_emails_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `login_emails_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX login_emails_email_key ON identity.login_emails USING btree (email)`
- `CREATE UNIQUE INDEX login_emails_pkey ON identity.login_emails USING btree (user_id)`

### identity.management_audit

管理操作审计

源码依据：`server/adapters/postgres/admin-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | bigint | 否 | identity=a;  | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `actor_id` | uuid | 否 | — | 操作人中心身份UUID |
| `target_id` | uuid | 是 | — | 管理操作目标用户UUID |
| `action` | text | 否 | — | 管理审计动作 |
| `product_id` | text | 是 | — | 产品标识 |
| `reason` | text | 否 | — | 管理审计操作原因 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `management_audit_action_not_null` [n]：`NOT NULL action`；validated=true，deferrable=false
- `management_audit_actor_id_fkey` [f]：`FOREIGN KEY (actor_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `management_audit_actor_id_not_null` [n]：`NOT NULL actor_id`；validated=true，deferrable=false
- `management_audit_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `management_audit_id_not_null` [n]：`NOT NULL id`；validated=true，deferrable=false
- `management_audit_pkey` [p]：`PRIMARY KEY (id)`；validated=true，deferrable=false
- `management_audit_product_id_fkey` [f]：`FOREIGN KEY (product_id) REFERENCES identity.products(product_id)`；validated=true，deferrable=false
- `management_audit_reason_check` [c]：`CHECK (btrim(reason) <> ''::text)`；validated=true，deferrable=false
- `management_audit_reason_not_null` [n]：`NOT NULL reason`；validated=true，deferrable=false
- `management_audit_target_id_fkey` [f]：`FOREIGN KEY (target_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX management_audit_pkey ON identity.management_audit USING btree (id)`

### identity.management_challenges

激活/恢复挑战

源码依据：`server/adapters/postgres/admin-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `token_hash` | text | 否 | — | 会话/挑战/刷新令牌的SHA256摘要；不存可直接使用的明文令牌 |
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `purpose` | text | 否 | — | 挑战用途activate/recover |
| `issuer_id` | uuid | 否 | — | 激活/恢复挑战签发人UUID |
| `email` | text | 否 | — | 邮箱地址；唯一性/是否允许空值见实际DDL |
| `expires_at` | timestamp with time zone | 否 | — | 有效期截止时间 |
| `consumed_at` | timestamp with time zone | 是 | — | 挑战、刷新令牌或通知事件被消费时间 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `management_challenges_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `management_challenges_email_not_null` [n]：`NOT NULL email`；validated=true，deferrable=false
- `management_challenges_expires_at_not_null` [n]：`NOT NULL expires_at`；validated=true，deferrable=false
- `management_challenges_issuer_id_fkey` [f]：`FOREIGN KEY (issuer_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `management_challenges_issuer_id_not_null` [n]：`NOT NULL issuer_id`；validated=true，deferrable=false
- `management_challenges_pkey` [p]：`PRIMARY KEY (token_hash)`；validated=true，deferrable=false
- `management_challenges_purpose_check` [c]：`CHECK (purpose = ANY (ARRAY['activate'::text, 'recover'::text]))`；validated=true，deferrable=false
- `management_challenges_purpose_not_null` [n]：`NOT NULL purpose`；validated=true，deferrable=false
- `management_challenges_token_hash_check` [c]：`CHECK (token_hash ~ '^[a-f0-9]{64}$'::text)`；validated=true，deferrable=false
- `management_challenges_token_hash_not_null` [n]：`NOT NULL token_hash`；validated=true，deferrable=false
- `management_challenges_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `management_challenges_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX management_challenges_pkey ON identity.management_challenges USING btree (token_hash)`

### identity.outbox

中心原子事务事件发件箱（不是SMTP发信队列）

源码依据：`server/adapters/postgres/admin-schema.ts`、`server/adapters/postgres/lead-schema.ts`、`server/adapters/postgres/notification-schema.ts`、`server/adapters/postgres/assignment-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `event_id` | uuid | 否 | gen_random_uuid() | 中心事件UUID；具体关联见FK |
| `event_type` | text | 否 | — | 中心Outbox/通知事件类型 |
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `product_id` | text | 是 | — | 产品标识 |
| `revision` | integer | 否 | — | 身份通知/事件修订号 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |
| `customer_id` | uuid | 是 | — | 中心客户容器UUID |
| `payload` | jsonb | 否 | '{}'::jsonb | 中心事件或本地待同步邮件事件的JSON负载；见对应契约 |
| `recipient_user_ids` | uuid[] | 是 | — | 中心事件指定接收人UUID数组 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `outbox_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `outbox_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `outbox_event_id_not_null` [n]：`NOT NULL event_id`；validated=true，deferrable=false
- `outbox_event_type_not_null` [n]：`NOT NULL event_type`；validated=true，deferrable=false
- `outbox_payload_not_null` [n]：`NOT NULL payload`；validated=true，deferrable=false
- `outbox_pkey` [p]：`PRIMARY KEY (event_id)`；validated=true，deferrable=false
- `outbox_product_id_fkey` [f]：`FOREIGN KEY (product_id) REFERENCES identity.products(product_id)`；validated=true，deferrable=false
- `outbox_revision_not_null` [n]：`NOT NULL revision`；validated=true，deferrable=false
- `outbox_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `outbox_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX outbox_pkey ON identity.outbox USING btree (event_id)`

真实触发器：

- `CREATE TRIGGER m2_test_3ddd0a79d839457ca8d2f492a188cd84 BEFORE INSERT ON identity.outbox FOR EACH ROW WHEN (new.customer_id = '3ddd0a79-d839-457c-a8d2-f492a188cd84'::uuid) EXECUTE FUNCTION crm_m2_test_outbox_failure()`

### identity.product_access

产品范围与能力授权

源码依据：`server/adapters/postgres/admin-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `product_id` | text | 否 | — | 产品标识 |
| `active` | boolean | 否 | true | 是否启用 |
| `scope` | text | 否 | — | 产品数据可见范围own/shared/summary |
| `capabilities` | jsonb | 是 | — | 能力权限JSON数组 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `product_access_active_not_null` [n]：`NOT NULL active`；validated=true，deferrable=false
- `product_access_capabilities_check` [c]：`CHECK (capabilities IS NULL OR jsonb_typeof(capabilities) = 'array'::text)`；validated=true，deferrable=false
- `product_access_pkey` [p]：`PRIMARY KEY (user_id, product_id)`；validated=true，deferrable=false
- `product_access_product_id_fkey` [f]：`FOREIGN KEY (product_id) REFERENCES identity.products(product_id)`；validated=true，deferrable=false
- `product_access_product_id_not_null` [n]：`NOT NULL product_id`；validated=true，deferrable=false
- `product_access_scope_check` [c]：`CHECK (scope = ANY (ARRAY['own'::text, 'shared'::text, 'summary'::text]))`；validated=true，deferrable=false
- `product_access_scope_not_null` [n]：`NOT NULL scope`；validated=true，deferrable=false
- `product_access_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `product_access_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX product_access_pkey ON identity.product_access USING btree (user_id, product_id)`

### identity.product_grants

产品角色授权

源码依据：`server/adapters/postgres/auth-schema.ts`、`server/adapters/postgres/admin-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `product_id` | text | 否 | — | 产品标识 |
| `role` | text | 否 | — | 身份产品角色、Agent消息角色或邮件关联角色，按所属表契约解释 |
| `active` | boolean | 否 | true | 是否启用 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `product_grants_active_not_null` [n]：`NOT NULL active`；validated=true，deferrable=false
- `product_grants_pkey` [p]：`PRIMARY KEY (user_id, product_id, role)`；validated=true，deferrable=false
- `product_grants_product_id_check` [c]：`CHECK (product_id = 'crm'::text)`；validated=true，deferrable=false
- `product_grants_product_id_not_null` [n]：`NOT NULL product_id`；validated=true，deferrable=false
- `product_grants_role_check` [c]：`CHECK (role = ANY (ARRAY['admin'::text, 'operations'::text, 'sales'::text, 'auditor'::text]))`；validated=true，deferrable=false
- `product_grants_role_not_null` [n]：`NOT NULL role`；validated=true，deferrable=false
- `product_grants_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `product_grants_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX product_grants_pkey ON identity.product_grants USING btree (user_id, product_id, role)`

### identity.products

中心产品目录

源码依据：`server/adapters/postgres/admin-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `product_id` | text | 否 | — | 产品标识 |
| `name` | text | 否 | — | 本表对象名称；迁移表为迁移名称 |
| `connected` | boolean | 否 | false | 产品是否已连接统一管理中心 |
| `description` | text | 否 | — | 本表对象说明 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `products_connected_not_null` [n]：`NOT NULL connected`；validated=true，deferrable=false
- `products_description_not_null` [n]：`NOT NULL description`；validated=true，deferrable=false
- `products_name_not_null` [n]：`NOT NULL name`；validated=true，deferrable=false
- `products_pkey` [p]：`PRIMARY KEY (product_id)`；validated=true，deferrable=false
- `products_product_id_not_null` [n]：`NOT NULL product_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX products_pkey ON identity.products USING btree (product_id)`

### identity.sessions

中心访问会话

源码依据：`server/adapters/postgres/auth-schema.ts`、`server/adapters/postgres/admin-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `token_hash` | text | 否 | — | 会话/挑战/刷新令牌的SHA256摘要；不存可直接使用的明文令牌 |
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `security_revision` | integer | 否 | — | 身份安全修订号，用于会话有效性校验 |
| `expires_at` | timestamp with time zone | 否 | — | 有效期截止时间 |
| `revoked_at` | timestamp with time zone | 是 | — | 会话撤销时间 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |
| `session_id` | uuid | 否 | gen_random_uuid() | 中心会话UUID |
| `client` | text | 否 | 'api'::text | 会话客户端类别api/browser |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `sessions_check` [c]：`CHECK (expires_at > created_at)`；validated=true，deferrable=false
- `sessions_client_check` [c]：`CHECK (client = ANY (ARRAY['api'::text, 'browser'::text]))`；validated=true，deferrable=false
- `sessions_client_not_null` [n]：`NOT NULL client`；validated=true，deferrable=false
- `sessions_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `sessions_expires_at_not_null` [n]：`NOT NULL expires_at`；validated=true，deferrable=false
- `sessions_pkey` [p]：`PRIMARY KEY (token_hash)`；validated=true，deferrable=false
- `sessions_security_revision_not_null` [n]：`NOT NULL security_revision`；validated=true，deferrable=false
- `sessions_session_id_key` [u]：`UNIQUE (session_id)`；validated=true，deferrable=false
- `sessions_session_id_not_null` [n]：`NOT NULL session_id`；validated=true，deferrable=false
- `sessions_token_hash_check` [c]：`CHECK (token_hash ~ '^[a-f0-9]{64}$'::text)`；validated=true，deferrable=false
- `sessions_token_hash_not_null` [n]：`NOT NULL token_hash`；validated=true，deferrable=false
- `sessions_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `sessions_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE INDEX idx_identity_sessions_expiry ON identity.sessions USING btree (expires_at)`
- `CREATE INDEX idx_identity_sessions_user ON identity.sessions USING btree (user_id)`
- `CREATE UNIQUE INDEX sessions_pkey ON identity.sessions USING btree (token_hash)`
- `CREATE UNIQUE INDEX sessions_session_id_key ON identity.sessions USING btree (session_id)`

### identity.users

中心统一身份

源码依据：`server/adapters/postgres/auth-schema.ts`、`server/adapters/postgres/admin-schema.ts`、`server/adapters/postgres/password-schema.ts`、`server/adapters/postgres/user-lifecycle-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `display_name` | text | 否 | — | 用户/邮箱账号显示名称 |
| `active` | boolean | 否 | true | 是否启用 |
| `identity_admin` | boolean | 否 | false | 是否拥有身份超级管理员权限 |
| `security_revision` | integer | 否 | 1 | 身份安全修订号，用于会话有效性校验 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |
| `management_revision` | integer | 否 | 1 | 管理/权限配置修订号 |
| `must_change_password` | boolean | 否 | false | 下次登录是否必须改密 |
| `deleted_at` | timestamp with time zone | 是 | — | 身份软删除时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `deleted_user_inactive` [c]：`CHECK (deleted_at IS NULL OR NOT active)`；validated=true，deferrable=false
- `users_active_not_null` [n]：`NOT NULL active`；validated=true，deferrable=false
- `users_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `users_display_name_check` [c]：`CHECK (btrim(display_name) <> ''::text)`；validated=true，deferrable=false
- `users_display_name_not_null` [n]：`NOT NULL display_name`；validated=true，deferrable=false
- `users_identity_admin_not_null` [n]：`NOT NULL identity_admin`；validated=true，deferrable=false
- `users_management_revision_not_null` [n]：`NOT NULL management_revision`；validated=true，deferrable=false
- `users_must_change_password_not_null` [n]：`NOT NULL must_change_password`；validated=true，deferrable=false
- `users_pkey` [p]：`PRIMARY KEY (user_id)`；validated=true，deferrable=false
- `users_security_revision_check` [c]：`CHECK (security_revision > 0)`；validated=true，deferrable=false
- `users_security_revision_not_null` [n]：`NOT NULL security_revision`；validated=true，deferrable=false
- `users_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX users_pkey ON identity.users USING btree (user_id)`

### public.companies

公司主档/背调；PG为中心共享基础资料，SQLite为历史本地数据

源码依据：`server/adapters/postgres/schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | integer | 否 | identity=d;  | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `name` | text | 否 | — | 本表对象名称；迁移表为迁移名称 |
| `domain` | text | 是 | — | 公司域名 |
| `industry` | text | 是 | — | 公司行业 |
| `country` | text | 是 | — | 国家 |
| `size` | text | 是 | — | 公司规模 |
| `backcheck_data` | jsonb | 是 | — | 公司背调JSON；SQLite为序列化文本，PG为jsonb对象 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |
| `updated_at` | timestamp with time zone | 否 | now() | 记录更新时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `companies_backcheck_data_check` [c]：`CHECK (backcheck_data IS NULL OR jsonb_typeof(backcheck_data) = 'object'::text)`；validated=true，deferrable=false
- `companies_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `companies_id_not_null` [n]：`NOT NULL id`；validated=true，deferrable=false
- `companies_name_check` [c]：`CHECK (btrim(name) <> ''::text)`；validated=true，deferrable=false
- `companies_name_not_null` [n]：`NOT NULL name`；validated=true，deferrable=false
- `companies_pkey` [p]：`PRIMARY KEY (id)`；validated=true，deferrable=false
- `companies_updated_at_not_null` [n]：`NOT NULL updated_at`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX companies_pkey ON public.companies USING btree (id)`
- `CREATE INDEX idx_companies_name ON public.companies USING btree (name)`

### public.contacts

联系人主档；PG是正式客户页事实源，SQLite为历史本地联系人

源码依据：`server/adapters/postgres/schema.ts`、`server/adapters/postgres/customer-profile-schema.ts`、`server/adapters/postgres/followup-schema.ts`、`server/adapters/postgres/contact-assignment-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | integer | 否 | identity=d;  | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `email` | text | 是 | — | 邮箱地址；唯一性/是否允许空值见实际DDL |
| `company_id` | integer | 是 | — | 本库公司主键；不能跨中心与个人SQLite按同号互认 |
| `first_name` | text | 是 | — | 联系人名字 |
| `last_name` | text | 是 | — | 联系人姓氏 |
| `title` | text | 是 | — | 联系人职位或本表对象标题 |
| `phone` | text | 是 | — | 联系电话 |
| `linkedin` | text | 是 | — | 领英地址 |
| `country` | text | 是 | — | 国家 |
| `client_type` | text | 是 | — | 联系人客户类型 |
| `language` | text | 是 | — | 联系人/模板语言 |
| `stage` | text | 否 | 'cold'::text | 发送轮次/旧开发字段；不以此推定中心客户关系阶段或触达状态 |
| `status` | text | 否 | ''::text | 本表状态；允许值/默认值和状态约束见下方DDL |
| `tags` | jsonb | 否 | '[]'::jsonb | 联系人标签；中心jsonb数组，SQLite为文本存储 |
| `extra` | jsonb | 否 | '{}'::jsonb | 联系人扩展JSON；业务key见后文且未规定的key用途未知 |
| `assignee` | text | 否 | ''::text | 原联系人归属显示/历史文本；不作为中心用户授权依据 |
| `source` | text | 否 | 'manual'::text | 业务来源/导入来源文本；不等同origin身份来源 |
| `source_detail` | text | 是 | — | 来源补充说明 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |
| `updated_at` | timestamp with time zone | 否 | now() | 记录更新时间 |
| `crm_touch_status` | text | 否 | 'uncontacted'::text | 中心联系人触达状态；独立于发送stage |
| `crm_contact_version` | integer | 否 | 1 | 中心联系人乐观并发版本 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `contacts_assignee_not_null` [n]：`NOT NULL assignee`；validated=true，deferrable=false
- `contacts_company_id_fkey` [f]：`FOREIGN KEY (company_id) REFERENCES companies(id)`；validated=true，deferrable=false
- `contacts_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `contacts_crm_contact_version_check` [c]：`CHECK (crm_contact_version > 0)`；validated=true，deferrable=false
- `contacts_crm_contact_version_not_null` [n]：`NOT NULL crm_contact_version`；validated=true，deferrable=false
- `contacts_crm_touch_status_check` [c]：`CHECK (crm_touch_status = ANY (ARRAY['uncontacted'::text, 'contacted'::text, 'replied'::text, 'unreachable'::text]))`；validated=true，deferrable=false
- `contacts_crm_touch_status_not_null` [n]：`NOT NULL crm_touch_status`；validated=true，deferrable=false
- `contacts_email_check` [c]：`CHECK (email = lower(btrim(email)) AND email <> ''::text)`；validated=true，deferrable=false
- `contacts_extra_check` [c]：`CHECK (jsonb_typeof(extra) = 'object'::text)`；validated=true，deferrable=false
- `contacts_extra_not_null` [n]：`NOT NULL extra`；validated=true，deferrable=false
- `contacts_id_not_null` [n]：`NOT NULL id`；validated=true，deferrable=false
- `contacts_pkey` [p]：`PRIMARY KEY (id)`；validated=true，deferrable=false
- `contacts_source_not_null` [n]：`NOT NULL source`；validated=true，deferrable=false
- `contacts_stage_not_null` [n]：`NOT NULL stage`；validated=true，deferrable=false
- `contacts_status_not_null` [n]：`NOT NULL status`；validated=true，deferrable=false
- `contacts_tags_check` [c]：`CHECK (jsonb_typeof(tags) = 'array'::text)`；validated=true，deferrable=false
- `contacts_tags_not_null` [n]：`NOT NULL tags`；validated=true，deferrable=false
- `contacts_updated_at_not_null` [n]：`NOT NULL updated_at`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX contacts_pkey ON public.contacts USING btree (id)`
- `CREATE INDEX idx_contacts_company_id ON public.contacts USING btree (company_id)`
- `CREATE UNIQUE INDEX idx_contacts_email ON public.contacts USING btree (lower(btrim(email)))`
- `CREATE INDEX idx_contacts_status ON public.contacts USING btree (status)`
- `CREATE INDEX idx_contacts_updated_at ON public.contacts USING btree (updated_at DESC, id DESC)`

### public.crm_assignment_history

历史客户容器分配记录

源码依据：`server/adapters/postgres/lead-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | bigint | 否 | identity=a;  | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `customer_id` | uuid | 否 | — | 中心客户容器UUID |
| `owner_user_id` | uuid | 否 | — | 客户容器负责人UUID；联系人接受分配后可有独立负责人 |
| `actor_id` | uuid | 否 | — | 操作人中心身份UUID |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_assignment_history_actor_id_fkey` [f]：`FOREIGN KEY (actor_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_assignment_history_actor_id_not_null` [n]：`NOT NULL actor_id`；validated=true，deferrable=false
- `crm_assignment_history_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `crm_assignment_history_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `crm_assignment_history_customer_id_not_null` [n]：`NOT NULL customer_id`；validated=true，deferrable=false
- `crm_assignment_history_id_not_null` [n]：`NOT NULL id`；validated=true，deferrable=false
- `crm_assignment_history_owner_user_id_fkey` [f]：`FOREIGN KEY (owner_user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_assignment_history_owner_user_id_not_null` [n]：`NOT NULL owner_user_id`；validated=true，deferrable=false
- `crm_assignment_history_pkey` [p]：`PRIMARY KEY (id)`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_assignment_history_pkey ON public.crm_assignment_history USING btree (id)`

### public.crm_contact_assignment_requests

联系人级分配请求与接受状态

源码依据：`server/adapters/postgres/contact-assignment-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `request_id` | uuid | 否 | gen_random_uuid() | 联系人分配请求UUID |
| `contact_id` | integer | 否 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `customer_id` | uuid | 否 | — | 中心客户容器UUID |
| `target_user_id` | uuid | 否 | — | 分配请求目标用户UUID |
| `actor_id` | uuid | 否 | — | 操作人中心身份UUID |
| `notify_user_ids` | uuid[] | 否 | '{}'::uuid[] | 分配请求额外通知对象UUID数组 |
| `status` | text | 否 | 'pending'::text | 本表状态；允许值/默认值和状态约束见下方DDL |
| `version` | integer | 否 | 1 | 本表乐观并发版本；与联系人/任务等其他表版本独立 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |
| `decided_at` | timestamp with time zone | 是 | — | 分配请求决定时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_contact_assignment_requests_actor_id_fkey` [f]：`FOREIGN KEY (actor_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_contact_assignment_requests_actor_id_not_null` [n]：`NOT NULL actor_id`；validated=true，deferrable=false
- `crm_contact_assignment_requests_contact_id_fkey` [f]：`FOREIGN KEY (contact_id) REFERENCES contacts(id)`；validated=true，deferrable=false
- `crm_contact_assignment_requests_contact_id_not_null` [n]：`NOT NULL contact_id`；validated=true，deferrable=false
- `crm_contact_assignment_requests_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `crm_contact_assignment_requests_customer_id_contact_id_fkey` [f]：`FOREIGN KEY (customer_id, contact_id) REFERENCES crm_customer_contacts(customer_id, contact_id)`；validated=true，deferrable=false
- `crm_contact_assignment_requests_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `crm_contact_assignment_requests_customer_id_not_null` [n]：`NOT NULL customer_id`；validated=true，deferrable=false
- `crm_contact_assignment_requests_notify_user_ids_not_null` [n]：`NOT NULL notify_user_ids`；validated=true，deferrable=false
- `crm_contact_assignment_requests_pkey` [p]：`PRIMARY KEY (request_id)`；validated=true，deferrable=false
- `crm_contact_assignment_requests_request_id_not_null` [n]：`NOT NULL request_id`；validated=true，deferrable=false
- `crm_contact_assignment_requests_status_check` [c]：`CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text, 'cancelled'::text]))`；validated=true，deferrable=false
- `crm_contact_assignment_requests_status_not_null` [n]：`NOT NULL status`；validated=true，deferrable=false
- `crm_contact_assignment_requests_target_user_id_fkey` [f]：`FOREIGN KEY (target_user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_contact_assignment_requests_target_user_id_not_null` [n]：`NOT NULL target_user_id`；validated=true，deferrable=false
- `crm_contact_assignment_requests_version_check` [c]：`CHECK (version > 0)`；validated=true，deferrable=false
- `crm_contact_assignment_requests_version_not_null` [n]：`NOT NULL version`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_contact_assignment_requests_pkey ON public.crm_contact_assignment_requests USING btree (request_id)`
- `CREATE UNIQUE INDEX idx_crm_contact_active_assignment ON public.crm_contact_assignment_requests USING btree (contact_id) WHERE (status = ANY (ARRAY['pending'::text, 'accepted'::text]))`
- `CREATE INDEX idx_crm_contact_assignment_actor ON public.crm_contact_assignment_requests USING btree (actor_id, status, created_at DESC)`
- `CREATE INDEX idx_crm_contact_assignment_target ON public.crm_contact_assignment_requests USING btree (target_user_id, status, created_at DESC)`

### public.crm_contact_mail_events

中心邮件事实/本地待同步事件（两库不是同一实体表）

源码依据：`server/adapters/postgres/contact-mail-schema.ts`、`server/adapters/postgres/contact-mail-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `event_id` | uuid | 否 | gen_random_uuid() | 中心事件UUID；具体关联见FK |
| `actor_id` | uuid | 否 | — | 操作人中心身份UUID |
| `contact_id` | integer | 否 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `customer_id` | uuid | 否 | — | 中心客户容器UUID |
| `event_key` | text | 否 | — | 事件幂等键；中心按actor_id联合唯一 |
| `mailbox_key` | text | 否 | — | 中心事件的账号/邮箱稳定身份键 |
| `message_key` | text | 否 | — | 本地/中心邮件匹配的稳定消息键 |
| `kind` | text | 否 | — | 邮件事件/工作记忆/搜索条目类别 |
| `direction` | text | 否 | — | 互动/邮件方向 |
| `occurred_at` | timestamp with time zone | 否 | — | 业务事实实际发生时间 |
| `subject` | text | 否 | — | 邮件主题/模板主题 |
| `preview` | text | 否 | — | 中心邮件元数据预览；不含正文文件 |
| `from_email` | text | 否 | — | 邮件发件人地址 |
| `to_emails` | jsonb | 否 | — | 收件人地址JSON数组 |
| `cc_emails` | jsonb | 否 | — | 抄送地址JSON数组 |
| `digest` | text | 否 | — | 请求/邮件事件规范化内容摘要 |
| `recorded_at` | timestamp with time zone | 否 | now() | 中心收到并记账时间 |
| `activity_id` | bigint | 是 | — | 中心共享活动ID |
| `send_stage_advanced` | boolean | 否 | false | 该已发事实是否已原子推进中心开发轮次一次 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_contact_mail_events_activity_id_fkey` [f]：`FOREIGN KEY (activity_id) REFERENCES crm_shared_activities(id)`；validated=true，deferrable=false
- `crm_contact_mail_events_actor_id_event_key_key` [u]：`UNIQUE (actor_id, event_key)`；validated=true，deferrable=false
- `crm_contact_mail_events_actor_id_fkey` [f]：`FOREIGN KEY (actor_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_contact_mail_events_actor_id_not_null` [n]：`NOT NULL actor_id`；validated=true，deferrable=false
- `crm_contact_mail_events_cc_emails_check` [c]：`CHECK (jsonb_typeof(cc_emails) = 'array'::text AND jsonb_array_length(cc_emails) <= 100)`；validated=true，deferrable=false
- `crm_contact_mail_events_cc_emails_not_null` [n]：`NOT NULL cc_emails`；validated=true，deferrable=false
- `crm_contact_mail_events_contact_id_fkey` [f]：`FOREIGN KEY (contact_id) REFERENCES contacts(id)`；validated=true，deferrable=false
- `crm_contact_mail_events_contact_id_not_null` [n]：`NOT NULL contact_id`；validated=true，deferrable=false
- `crm_contact_mail_events_customer_id_contact_id_fkey` [f]：`FOREIGN KEY (customer_id, contact_id) REFERENCES crm_customer_contacts(customer_id, contact_id)`；validated=true，deferrable=false
- `crm_contact_mail_events_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `crm_contact_mail_events_customer_id_not_null` [n]：`NOT NULL customer_id`；validated=true，deferrable=false
- `crm_contact_mail_events_digest_not_null` [n]：`NOT NULL digest`；validated=true，deferrable=false
- `crm_contact_mail_events_direction_check` [c]：`CHECK (direction = ANY (ARRAY['inbound'::text, 'outbound'::text]))`；validated=true，deferrable=false
- `crm_contact_mail_events_direction_not_null` [n]：`NOT NULL direction`；validated=true，deferrable=false
- `crm_contact_mail_events_event_id_not_null` [n]：`NOT NULL event_id`；validated=true，deferrable=false
- `crm_contact_mail_events_event_key_check` [c]：`CHECK (length(event_key) >= 1 AND length(event_key) <= 256)`；validated=true，deferrable=false
- `crm_contact_mail_events_event_key_not_null` [n]：`NOT NULL event_key`；validated=true，deferrable=false
- `crm_contact_mail_events_from_email_check` [c]：`CHECK (length(from_email) >= 1 AND length(from_email) <= 254)`；validated=true，deferrable=false
- `crm_contact_mail_events_from_email_not_null` [n]：`NOT NULL from_email`；validated=true，deferrable=false
- `crm_contact_mail_events_kind_check` [c]：`CHECK (kind = ANY (ARRAY['received'::text, 'sent'::text, 'replied'::text, 'autoreply'::text, 'bounced'::text, 'cc'::text]))`；validated=true，deferrable=false
- `crm_contact_mail_events_kind_not_null` [n]：`NOT NULL kind`；validated=true，deferrable=false
- `crm_contact_mail_events_mailbox_key_check` [c]：`CHECK (length(mailbox_key) >= 1 AND length(mailbox_key) <= 128)`；validated=true，deferrable=false
- `crm_contact_mail_events_mailbox_key_not_null` [n]：`NOT NULL mailbox_key`；validated=true，deferrable=false
- `crm_contact_mail_events_message_key_check` [c]：`CHECK (length(message_key) >= 1 AND length(message_key) <= 256)`；validated=true，deferrable=false
- `crm_contact_mail_events_message_key_not_null` [n]：`NOT NULL message_key`；validated=true，deferrable=false
- `crm_contact_mail_events_occurred_at_not_null` [n]：`NOT NULL occurred_at`；validated=true，deferrable=false
- `crm_contact_mail_events_pkey` [p]：`PRIMARY KEY (event_id)`；validated=true，deferrable=false
- `crm_contact_mail_events_preview_check` [c]：`CHECK (length(preview) <= 2000)`；validated=true，deferrable=false
- `crm_contact_mail_events_preview_not_null` [n]：`NOT NULL preview`；validated=true，deferrable=false
- `crm_contact_mail_events_recorded_at_not_null` [n]：`NOT NULL recorded_at`；validated=true，deferrable=false
- `crm_contact_mail_events_send_stage_advanced_not_null` [n]：`NOT NULL send_stage_advanced`；validated=true，deferrable=false
- `crm_contact_mail_events_subject_check` [c]：`CHECK (length(subject) <= 998)`；validated=true，deferrable=false
- `crm_contact_mail_events_subject_not_null` [n]：`NOT NULL subject`；validated=true，deferrable=false
- `crm_contact_mail_events_to_emails_check` [c]：`CHECK (jsonb_typeof(to_emails) = 'array'::text AND jsonb_array_length(to_emails) <= 100)`；validated=true，deferrable=false
- `crm_contact_mail_events_to_emails_not_null` [n]：`NOT NULL to_emails`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_contact_mail_events_actor_id_event_key_key ON public.crm_contact_mail_events USING btree (actor_id, event_key)`
- `CREATE UNIQUE INDEX crm_contact_mail_events_pkey ON public.crm_contact_mail_events USING btree (event_id)`
- `CREATE INDEX idx_crm_contact_mail_history ON public.crm_contact_mail_events USING btree (customer_id, contact_id, occurred_at DESC, event_id DESC)`

### public.crm_customer_contacts

中心客户与联系人关系；contact_id主键意味着每联系人最多归一个容器

源码依据：`server/adapters/postgres/lead-schema.ts`、`server/adapters/postgres/contact-assignment-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `customer_id` | uuid | 否 | — | 中心客户容器UUID |
| `contact_id` | integer | 否 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_customer_contacts_contact_id_fkey` [f]：`FOREIGN KEY (contact_id) REFERENCES contacts(id)`；validated=true，deferrable=false
- `crm_customer_contacts_contact_id_not_null` [n]：`NOT NULL contact_id`；validated=true，deferrable=false
- `crm_customer_contacts_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `crm_customer_contacts_customer_id_not_null` [n]：`NOT NULL customer_id`；validated=true，deferrable=false
- `crm_customer_contacts_pair` [u]：`UNIQUE (customer_id, contact_id)`；validated=true，deferrable=false
- `crm_customer_contacts_pkey` [p]：`PRIMARY KEY (contact_id)`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_customer_contacts_pair ON public.crm_customer_contacts USING btree (customer_id, contact_id)`
- `CREATE UNIQUE INDEX crm_customer_contacts_pkey ON public.crm_customer_contacts USING btree (contact_id)`
- `CREATE INDEX idx_crm_customer_contacts_customer ON public.crm_customer_contacts USING btree (customer_id, contact_id)`

### public.crm_customers

中心客户容器、来源及关系阶段

源码依据：`server/adapters/postgres/lead-schema.ts`、`server/adapters/postgres/customer-schema.ts`、`server/adapters/postgres/customer-profile-schema.ts`、`server/adapters/postgres/followup-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `customer_id` | uuid | 否 | gen_random_uuid() | 中心客户容器UUID |
| `company_id` | integer | 否 | — | 本库公司主键；不能跨中心与个人SQLite按同号互认 |
| `source` | text | 否 | — | 业务来源/导入来源文本；不等同origin身份来源 |
| `customer_key` | text | 否 | — | 原始来源客户键；与source联合唯一 |
| `source_detail` | text | 否 | — | 来源补充说明 |
| `state` | text | 否 | 'draft'::text | 中心客户容器状态draft/published/owned/paused |
| `owner_user_id` | uuid | 是 | — | 客户容器负责人UUID；联系人接受分配后可有独立负责人 |
| `created_by` | uuid | 否 | — | 创建主体；具体类型和允许值见本表DDL/契约 |
| `version` | integer | 否 | 1 | 本表乐观并发版本；与联系人/任务等其他表版本独立 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |
| `origin` | text | 否 | 'operations'::text | 线索身份来源：operations管理员来源/personal用户自有 |
| `business_type` | text | 是 | — | 客户业务类型 |
| `development_restriction` | text | 是 | — | 客户开发限制说明 |
| `source_created_at` | timestamp with time zone | 是 | — | 原始来源提供的客户创建时间 |
| `relationship_stage` | text | 否 | 'cold'::text | 中心客户关系阶段；不证明联系人已触达 |
| `stage_needs_review` | boolean | 否 | false | 历史发送阶段无法唯一映射关系阶段时的待复核标志 |
| `legacy_stage_snapshot` | jsonb | 否 | '[]'::jsonb | 历史迁移时原联系人ID与stage的JSON数组证据 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_customers_check` [c]：`CHECK ((state = 'owned'::text) = (owner_user_id IS NOT NULL))`；validated=true，deferrable=false
- `crm_customers_company_id_fkey` [f]：`FOREIGN KEY (company_id) REFERENCES companies(id)`；validated=true，deferrable=false
- `crm_customers_company_id_not_null` [n]：`NOT NULL company_id`；validated=true，deferrable=false
- `crm_customers_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `crm_customers_created_by_fkey` [f]：`FOREIGN KEY (created_by) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_customers_created_by_not_null` [n]：`NOT NULL created_by`；validated=true，deferrable=false
- `crm_customers_customer_id_not_null` [n]：`NOT NULL customer_id`；validated=true，deferrable=false
- `crm_customers_customer_key_not_null` [n]：`NOT NULL customer_key`；validated=true，deferrable=false
- `crm_customers_legacy_stage_snapshot_not_null` [n]：`NOT NULL legacy_stage_snapshot`；validated=true，deferrable=false
- `crm_customers_origin_check` [c]：`CHECK (origin = ANY (ARRAY['operations'::text, 'personal'::text]))`；validated=true，deferrable=false
- `crm_customers_origin_not_null` [n]：`NOT NULL origin`；validated=true，deferrable=false
- `crm_customers_owner_user_id_fkey` [f]：`FOREIGN KEY (owner_user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_customers_pkey` [p]：`PRIMARY KEY (customer_id)`；validated=true，deferrable=false
- `crm_customers_relationship_stage_check` [c]：`CHECK (relationship_stage = ANY (ARRAY['cold'::text, 'reaching'::text, 'quoting'::text, 'trial'::text, 'cooperating'::text, 'lost'::text, 'other'::text]))`；validated=true，deferrable=false
- `crm_customers_relationship_stage_not_null` [n]：`NOT NULL relationship_stage`；validated=true，deferrable=false
- `crm_customers_source_customer_key_key` [u]：`UNIQUE (source, customer_key)`；validated=true，deferrable=false
- `crm_customers_source_detail_not_null` [n]：`NOT NULL source_detail`；validated=true，deferrable=false
- `crm_customers_source_not_null` [n]：`NOT NULL source`；validated=true，deferrable=false
- `crm_customers_stage_needs_review_not_null` [n]：`NOT NULL stage_needs_review`；validated=true，deferrable=false
- `crm_customers_state_check` [c]：`CHECK (state = ANY (ARRAY['draft'::text, 'published'::text, 'owned'::text, 'paused'::text]))`；validated=true，deferrable=false
- `crm_customers_state_not_null` [n]：`NOT NULL state`；validated=true，deferrable=false
- `crm_customers_version_check` [c]：`CHECK (version > 0)`；validated=true，deferrable=false
- `crm_customers_version_not_null` [n]：`NOT NULL version`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_customers_pkey ON public.crm_customers USING btree (customer_id)`
- `CREATE UNIQUE INDEX crm_customers_source_customer_key_key ON public.crm_customers USING btree (source, customer_key)`
- `CREATE INDEX idx_crm_customers_creator_origin ON public.crm_customers USING btree (created_by, origin)`
- `CREATE INDEX idx_crm_customers_owner ON public.crm_customers USING btree (owner_user_id, state)`

真实触发器：

- `CREATE TRIGGER crm_opportunities_customer_owner_changed AFTER UPDATE OF owner_user_id ON crm_customers FOR EACH ROW EXECUTE FUNCTION crm_opportunities_customer_owner_changed()`
- `CREATE TRIGGER crm_tasks_customer_owner_changed AFTER UPDATE OF owner_user_id ON crm_customers FOR EACH ROW EXECUTE FUNCTION crm_tasks_customer_owner_changed()`

### public.crm_device_cursors

每账号每设备通知游标

源码依据：`server/adapters/postgres/notification-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `device_id` | text | 否 | — | 桌面设备ID |
| `cursor` | bigint | 否 | 0 | 设备已处理的通知流游标 |
| `updated_at` | timestamp with time zone | 否 | now() | 记录更新时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_device_cursors_cursor_not_null` [n]：`NOT NULL cursor`；validated=true，deferrable=false
- `crm_device_cursors_device_id_not_null` [n]：`NOT NULL device_id`；validated=true，deferrable=false
- `crm_device_cursors_pkey` [p]：`PRIMARY KEY (user_id, device_id)`；validated=true，deferrable=false
- `crm_device_cursors_updated_at_not_null` [n]：`NOT NULL updated_at`；validated=true，deferrable=false
- `crm_device_cursors_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_device_cursors_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_device_cursors_pkey ON public.crm_device_cursors USING btree (user_id, device_id)`

### public.crm_event_deliveries

按接收账号投影的通知投递

源码依据：`server/adapters/postgres/notification-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `delivery_id` | uuid | 否 | gen_random_uuid() | 中心通知投递UUID |
| `event_id` | uuid | 否 | — | 中心事件UUID；具体关联见FK |
| `recipient_user_id` | uuid | 否 | — | 通知投递接收用户UUID |
| `projection_type` | text | 否 | — | 通知投影类型 |
| `delivery_seq` | bigint | 否 | — | 用户通知流的单调递增序号 |
| `customer_id` | uuid | 否 | — | 中心客户容器UUID |
| `event_type` | text | 否 | — | 中心Outbox/通知事件类型 |
| `version` | integer | 否 | — | 本表乐观并发版本；与联系人/任务等其他表版本独立 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_event_deliveries_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `crm_event_deliveries_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `crm_event_deliveries_customer_id_not_null` [n]：`NOT NULL customer_id`；validated=true，deferrable=false
- `crm_event_deliveries_delivery_id_not_null` [n]：`NOT NULL delivery_id`；validated=true，deferrable=false
- `crm_event_deliveries_delivery_seq_check` [c]：`CHECK (delivery_seq > 0)`；validated=true，deferrable=false
- `crm_event_deliveries_delivery_seq_not_null` [n]：`NOT NULL delivery_seq`；validated=true，deferrable=false
- `crm_event_deliveries_event_id_fkey` [f]：`FOREIGN KEY (event_id) REFERENCES identity.outbox(event_id)`；validated=true，deferrable=false
- `crm_event_deliveries_event_id_not_null` [n]：`NOT NULL event_id`；validated=true，deferrable=false
- `crm_event_deliveries_event_id_recipient_user_id_projection__key` [u]：`UNIQUE (event_id, recipient_user_id, projection_type)`；validated=true，deferrable=false
- `crm_event_deliveries_event_type_not_null` [n]：`NOT NULL event_type`；validated=true，deferrable=false
- `crm_event_deliveries_pkey` [p]：`PRIMARY KEY (delivery_id)`；validated=true，deferrable=false
- `crm_event_deliveries_projection_type_check` [c]：`CHECK (projection_type = 'lead'::text)`；validated=true，deferrable=false
- `crm_event_deliveries_projection_type_not_null` [n]：`NOT NULL projection_type`；validated=true，deferrable=false
- `crm_event_deliveries_recipient_user_id_delivery_seq_key` [u]：`UNIQUE (recipient_user_id, delivery_seq)`；validated=true，deferrable=false
- `crm_event_deliveries_recipient_user_id_fkey` [f]：`FOREIGN KEY (recipient_user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_event_deliveries_recipient_user_id_not_null` [n]：`NOT NULL recipient_user_id`；validated=true，deferrable=false
- `crm_event_deliveries_version_not_null` [n]：`NOT NULL version`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_event_deliveries_event_id_recipient_user_id_projection__key ON public.crm_event_deliveries USING btree (event_id, recipient_user_id, projection_type)`
- `CREATE UNIQUE INDEX crm_event_deliveries_pkey ON public.crm_event_deliveries USING btree (delivery_id)`
- `CREATE UNIQUE INDEX crm_event_deliveries_recipient_user_id_delivery_seq_key ON public.crm_event_deliveries USING btree (recipient_user_id, delivery_seq)`

### public.crm_feed_heads

用户通知流序号头

源码依据：`server/adapters/postgres/notification-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `delivery_seq` | bigint | 否 | 0 | 用户通知流的单调递增序号 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_feed_heads_delivery_seq_check` [c]：`CHECK (delivery_seq >= 0)`；validated=true，deferrable=false
- `crm_feed_heads_delivery_seq_not_null` [n]：`NOT NULL delivery_seq`；validated=true，deferrable=false
- `crm_feed_heads_pkey` [p]：`PRIMARY KEY (user_id)`；validated=true，deferrable=false
- `crm_feed_heads_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_feed_heads_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_feed_heads_pkey ON public.crm_feed_heads USING btree (user_id)`

### public.crm_followup_tasks

中心跟进任务

源码依据：`server/adapters/postgres/task-schema.ts`、`server/adapters/postgres/opportunity-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `task_id` | uuid | 否 | gen_random_uuid() | 中心跟进任务UUID |
| `customer_id` | uuid | 否 | — | 中心客户容器UUID |
| `title` | text | 否 | — | 联系人职位或本表对象标题 |
| `due_at` | timestamp with time zone | 否 | — | 跟进任务到期时间 |
| `status` | text | 否 | 'open'::text | 本表状态；允许值/默认值和状态约束见下方DDL |
| `version` | integer | 否 | 1 | 本表乐观并发版本；与联系人/任务等其他表版本独立 |
| `created_by` | uuid | 否 | — | 创建主体；具体类型和允许值见本表DDL/契约 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |
| `updated_at` | timestamp with time zone | 否 | now() | 记录更新时间 |
| `completed_at` | timestamp with time zone | 是 | — | 任务完成时间 |
| `completed_by` | uuid | 是 | — | 完成任务的用户UUID |
| `feedback` | text | 是 | — | 任务完成反馈 |
| `opportunity_id` | uuid | 是 | — | 中心商机UUID |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_followup_tasks_check` [c]：`CHECK (status = 'open'::text AND completed_at IS NULL AND completed_by IS NULL AND feedback IS NULL OR status = 'completed'::text AND completed_at IS NOT NULL AND completed_by IS NOT NULL AND feedback IS NOT NULL AND btrim(feedback) <> ''::text AND length(feedback) <= 20000)`；validated=true，deferrable=false
- `crm_followup_tasks_completed_by_fkey` [f]：`FOREIGN KEY (completed_by) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_followup_tasks_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `crm_followup_tasks_created_by_fkey` [f]：`FOREIGN KEY (created_by) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_followup_tasks_created_by_not_null` [n]：`NOT NULL created_by`；validated=true，deferrable=false
- `crm_followup_tasks_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `crm_followup_tasks_customer_id_not_null` [n]：`NOT NULL customer_id`；validated=true，deferrable=false
- `crm_followup_tasks_due_at_check` [c]：`CHECK (isfinite(due_at))`；validated=true，deferrable=false
- `crm_followup_tasks_due_at_not_null` [n]：`NOT NULL due_at`；validated=true，deferrable=false
- `crm_followup_tasks_pkey` [p]：`PRIMARY KEY (task_id)`；validated=true，deferrable=false
- `crm_followup_tasks_status_check` [c]：`CHECK (status = ANY (ARRAY['open'::text, 'completed'::text]))`；validated=true，deferrable=false
- `crm_followup_tasks_status_not_null` [n]：`NOT NULL status`；validated=true，deferrable=false
- `crm_followup_tasks_task_id_not_null` [n]：`NOT NULL task_id`；validated=true，deferrable=false
- `crm_followup_tasks_title_check` [c]：`CHECK (btrim(title) <> ''::text AND length(title) <= 500)`；validated=true，deferrable=false
- `crm_followup_tasks_title_not_null` [n]：`NOT NULL title`；validated=true，deferrable=false
- `crm_followup_tasks_updated_at_not_null` [n]：`NOT NULL updated_at`；validated=true，deferrable=false
- `crm_followup_tasks_version_check` [c]：`CHECK (version > 0)`；validated=true，deferrable=false
- `crm_followup_tasks_version_not_null` [n]：`NOT NULL version`；validated=true，deferrable=false
- `crm_task_opportunity_customer_fk` [f]：`FOREIGN KEY (opportunity_id, customer_id) REFERENCES crm_opportunities(opportunity_id, customer_id)`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_followup_tasks_pkey ON public.crm_followup_tasks USING btree (task_id)`
- `CREATE INDEX idx_crm_task_opportunity ON public.crm_followup_tasks USING btree (opportunity_id) WHERE (opportunity_id IS NOT NULL)`
- `CREATE INDEX idx_crm_tasks_customer ON public.crm_followup_tasks USING btree (customer_id, due_at, task_id)`
- `CREATE INDEX idx_crm_tasks_due ON public.crm_followup_tasks USING btree (due_at, task_id) WHERE (status = 'open'::text)`

### public.crm_import_batches

中心导入批次

源码依据：`server/adapters/postgres/lead-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `batch_id` | uuid | 否 | gen_random_uuid() | 导入或发送批次ID；按本表所属链路解释 |
| `actor_id` | uuid | 否 | — | 操作人中心身份UUID |
| `source` | text | 否 | — | 业务来源/导入来源文本；不等同origin身份来源 |
| `source_detail` | text | 否 | — | 来源补充说明 |
| `mapping` | jsonb | 否 | '{}'::jsonb | 导入字段映射JSON |
| `version` | integer | 否 | 1 | 本表乐观并发版本；与联系人/任务等其他表版本独立 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_import_batches_actor_id_fkey` [f]：`FOREIGN KEY (actor_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_import_batches_actor_id_not_null` [n]：`NOT NULL actor_id`；validated=true，deferrable=false
- `crm_import_batches_batch_id_not_null` [n]：`NOT NULL batch_id`；validated=true，deferrable=false
- `crm_import_batches_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `crm_import_batches_mapping_not_null` [n]：`NOT NULL mapping`；validated=true，deferrable=false
- `crm_import_batches_pkey` [p]：`PRIMARY KEY (batch_id)`；validated=true，deferrable=false
- `crm_import_batches_source_detail_not_null` [n]：`NOT NULL source_detail`；validated=true，deferrable=false
- `crm_import_batches_source_not_null` [n]：`NOT NULL source`；validated=true，deferrable=false
- `crm_import_batches_version_not_null` [n]：`NOT NULL version`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_import_batches_pkey ON public.crm_import_batches USING btree (batch_id)`

### public.crm_import_rows

中心导入行与回执

源码依据：`server/adapters/postgres/lead-schema.ts`、`server/adapters/postgres/customer-profile-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `row_id` | uuid | 否 | gen_random_uuid() | 中心导入行UUID |
| `batch_id` | uuid | 否 | — | 导入或发送批次ID；按本表所属链路解释 |
| `row_index` | integer | 否 | — | 原始导入行序号 |
| `customer_key` | text | 否 | — | 原始来源客户键；与source联合唯一 |
| `raw_row` | jsonb | 否 | — | 原始导入行JSON，仅保留结构不导出实际行 |
| `customer_id` | uuid | 是 | — | 中心客户容器UUID |
| `status` | text | 否 | — | 本表状态；允许值/默认值和状态约束见下方DDL |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_import_rows_batch_id_fkey` [f]：`FOREIGN KEY (batch_id) REFERENCES crm_import_batches(batch_id)`；validated=true，deferrable=false
- `crm_import_rows_batch_id_not_null` [n]：`NOT NULL batch_id`；validated=true，deferrable=false
- `crm_import_rows_batch_id_row_index_key` [u]：`UNIQUE (batch_id, row_index)`；validated=true，deferrable=false
- `crm_import_rows_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `crm_import_rows_customer_key_not_null` [n]：`NOT NULL customer_key`；validated=true，deferrable=false
- `crm_import_rows_pkey` [p]：`PRIMARY KEY (row_id)`；validated=true，deferrable=false
- `crm_import_rows_raw_row_not_null` [n]：`NOT NULL raw_row`；validated=true，deferrable=false
- `crm_import_rows_row_id_not_null` [n]：`NOT NULL row_id`；validated=true，deferrable=false
- `crm_import_rows_row_index_not_null` [n]：`NOT NULL row_index`；validated=true，deferrable=false
- `crm_import_rows_status_check` [c]：`CHECK (status = ANY (ARRAY['created'::text, 'appended'::text, 'duplicate'::text, 'invalid'::text, 'unmatched'::text, 'ambiguous'::text, 'restricted_conflict'::text]))`；validated=true，deferrable=false
- `crm_import_rows_status_not_null` [n]：`NOT NULL status`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_import_rows_batch_id_row_index_key ON public.crm_import_rows USING btree (batch_id, row_index)`
- `CREATE UNIQUE INDEX crm_import_rows_pkey ON public.crm_import_rows USING btree (row_id)`

### public.crm_lead_idempotency

中心写操作幂等回执

源码依据：`server/adapters/postgres/lead-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `actor_id` | uuid | 否 | — | 操作人中心身份UUID |
| `operation` | text | 否 | — | 幂等操作类别 |
| `key` | text | 否 | — | JSON状态键或幂等键，按本表职责解释 |
| `digest` | text | 否 | — | 请求/邮件事件规范化内容摘要 |
| `response` | jsonb | 否 | — | 中心幂等操作保存的JSON回执 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_lead_idempotency_actor_id_fkey` [f]：`FOREIGN KEY (actor_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_lead_idempotency_actor_id_not_null` [n]：`NOT NULL actor_id`；validated=true，deferrable=false
- `crm_lead_idempotency_digest_not_null` [n]：`NOT NULL digest`；validated=true，deferrable=false
- `crm_lead_idempotency_key_not_null` [n]：`NOT NULL key`；validated=true，deferrable=false
- `crm_lead_idempotency_operation_not_null` [n]：`NOT NULL operation`；validated=true，deferrable=false
- `crm_lead_idempotency_pkey` [p]：`PRIMARY KEY (actor_id, operation, key)`；validated=true，deferrable=false
- `crm_lead_idempotency_response_not_null` [n]：`NOT NULL response`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_lead_idempotency_pkey ON public.crm_lead_idempotency USING btree (actor_id, operation, key)`

### public.crm_notification_consumed

通知Worker已消费Outbox事件

源码依据：`server/adapters/postgres/notification-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `event_id` | uuid | 否 | — | 中心事件UUID；具体关联见FK |
| `consumed_at` | timestamp with time zone | 否 | now() | 挑战、刷新令牌或通知事件被消费时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_notification_consumed_consumed_at_not_null` [n]：`NOT NULL consumed_at`；validated=true，deferrable=false
- `crm_notification_consumed_event_id_fkey` [f]：`FOREIGN KEY (event_id) REFERENCES identity.outbox(event_id)`；validated=true，deferrable=false
- `crm_notification_consumed_event_id_not_null` [n]：`NOT NULL event_id`；validated=true，deferrable=false
- `crm_notification_consumed_pkey` [p]：`PRIMARY KEY (event_id)`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_notification_consumed_pkey ON public.crm_notification_consumed USING btree (event_id)`

### public.crm_notification_reads

用户已读通知

源码依据：`server/adapters/postgres/notification-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `user_id` | uuid | 否 | — | 中心身份用户UUID |
| `delivery_id` | uuid | 否 | — | 中心通知投递UUID |
| `read_at` | timestamp with time zone | 否 | now() | 通知用户已读时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_notification_reads_delivery_id_fkey` [f]：`FOREIGN KEY (delivery_id) REFERENCES crm_event_deliveries(delivery_id)`；validated=true，deferrable=false
- `crm_notification_reads_delivery_id_not_null` [n]：`NOT NULL delivery_id`；validated=true，deferrable=false
- `crm_notification_reads_pkey` [p]：`PRIMARY KEY (user_id, delivery_id)`；validated=true，deferrable=false
- `crm_notification_reads_read_at_not_null` [n]：`NOT NULL read_at`；validated=true，deferrable=false
- `crm_notification_reads_user_id_fkey` [f]：`FOREIGN KEY (user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_notification_reads_user_id_not_null` [n]：`NOT NULL user_id`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_notification_reads_pkey ON public.crm_notification_reads USING btree (user_id, delivery_id)`

### public.crm_opportunities

中心商机

源码依据：`server/adapters/postgres/opportunity-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `opportunity_id` | uuid | 否 | gen_random_uuid() | 中心商机UUID |
| `customer_id` | uuid | 否 | — | 中心客户容器UUID |
| `title` | text | 否 | — | 联系人职位或本表对象标题 |
| `description` | text | 否 | ''::text | 本表对象说明 |
| `pol` | text | 是 | — | 起运港 |
| `pod` | text | 是 | — | 目的港 |
| `container_type` | text | 是 | — | 商机箱型 |
| `source` | text | 否 | ''::text | 业务来源/导入来源文本；不等同origin身份来源 |
| `stage` | text | 否 | 'inquiry'::text | 本表阶段；contacts为发送轮次/旧字段，客户关系/商机阶段见所属表约束 |
| `amount` | numeric | 是 | — | 商机金额；精度/范围和currency联动受CHECK约束 |
| `currency` | text | 是 | — | 三字母货币代码 |
| `lost_reason` | text | 是 | — | 商机失败关闭原因 |
| `evidence` | text | 是 | — | 商机赢单证据说明 |
| `version` | integer | 否 | 1 | 本表乐观并发版本；与联系人/任务等其他表版本独立 |
| `created_by` | uuid | 否 | — | 创建主体；具体类型和允许值见本表DDL/契约 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |
| `updated_at` | timestamp with time zone | 否 | now() | 记录更新时间 |
| `closed_at` | timestamp with time zone | 是 | — | 商机关闭时间 |
| `closed_by` | uuid | 是 | — | 关闭商机的用户UUID |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_opportunities_check` [c]：`CHECK (amount IS NULL AND currency IS NULL OR amount IS NOT NULL AND currency IS NOT NULL AND amount >= 0::numeric AND amount < power(10::numeric, 12::numeric) AND scale(amount) <= 2 AND currency ~ '^[A-Z]{3}$'::text)`；validated=true，deferrable=false
- `crm_opportunities_check1` [c]：`CHECK ((stage = ANY (ARRAY['closed_won'::text, 'closed_lost'::text])) AND closed_at IS NOT NULL AND closed_by IS NOT NULL OR (stage <> ALL (ARRAY['closed_won'::text, 'closed_lost'::text])) AND closed_at IS NULL AND closed_by IS NULL)`；validated=true，deferrable=false
- `crm_opportunities_check2` [c]：`CHECK (stage = 'closed_won'::text AND evidence IS NOT NULL AND amount IS NOT NULL AND lost_reason IS NULL OR stage = 'closed_lost'::text AND lost_reason IS NOT NULL AND evidence IS NULL OR (stage <> ALL (ARRAY['closed_won'::text, 'closed_lost'::text])) AND evidence IS NULL AND lost_reason IS NULL)`；validated=true，deferrable=false
- `crm_opportunities_closed_by_fkey` [f]：`FOREIGN KEY (closed_by) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_opportunities_container_type_check` [c]：`CHECK (length(container_type) <= 128)`；validated=true，deferrable=false
- `crm_opportunities_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `crm_opportunities_created_by_fkey` [f]：`FOREIGN KEY (created_by) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_opportunities_created_by_not_null` [n]：`NOT NULL created_by`；validated=true，deferrable=false
- `crm_opportunities_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `crm_opportunities_customer_id_not_null` [n]：`NOT NULL customer_id`；validated=true，deferrable=false
- `crm_opportunities_description_check` [c]：`CHECK (length(description) <= 20000)`；validated=true，deferrable=false
- `crm_opportunities_description_not_null` [n]：`NOT NULL description`；validated=true，deferrable=false
- `crm_opportunities_evidence_check` [c]：`CHECK (btrim(evidence) <> ''::text AND length(evidence) <= 4096)`；validated=true，deferrable=false
- `crm_opportunities_lost_reason_check` [c]：`CHECK (btrim(lost_reason) <> ''::text AND length(lost_reason) <= 2000)`；validated=true，deferrable=false
- `crm_opportunities_opportunity_id_customer_id_key` [u]：`UNIQUE (opportunity_id, customer_id)`；validated=true，deferrable=false
- `crm_opportunities_opportunity_id_not_null` [n]：`NOT NULL opportunity_id`；validated=true，deferrable=false
- `crm_opportunities_pkey` [p]：`PRIMARY KEY (opportunity_id)`；validated=true，deferrable=false
- `crm_opportunities_pod_check` [c]：`CHECK (length(pod) <= 128)`；validated=true，deferrable=false
- `crm_opportunities_pol_check` [c]：`CHECK (length(pol) <= 128)`；validated=true，deferrable=false
- `crm_opportunities_source_check` [c]：`CHECK (length(source) <= 500)`；validated=true，deferrable=false
- `crm_opportunities_source_not_null` [n]：`NOT NULL source`；validated=true，deferrable=false
- `crm_opportunities_stage_check` [c]：`CHECK (stage = ANY (ARRAY['inquiry'::text, 'quote_sent'::text, 'negotiation'::text, 'booking_confirmed'::text, 'closed_won'::text, 'closed_lost'::text]))`；validated=true，deferrable=false
- `crm_opportunities_stage_not_null` [n]：`NOT NULL stage`；validated=true，deferrable=false
- `crm_opportunities_title_check` [c]：`CHECK (btrim(title) <> ''::text AND length(title) <= 500)`；validated=true，deferrable=false
- `crm_opportunities_title_not_null` [n]：`NOT NULL title`；validated=true，deferrable=false
- `crm_opportunities_updated_at_not_null` [n]：`NOT NULL updated_at`；validated=true，deferrable=false
- `crm_opportunities_version_check` [c]：`CHECK (version > 0)`；validated=true，deferrable=false
- `crm_opportunities_version_not_null` [n]：`NOT NULL version`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_opportunities_opportunity_id_customer_id_key ON public.crm_opportunities USING btree (opportunity_id, customer_id)`
- `CREATE UNIQUE INDEX crm_opportunities_pkey ON public.crm_opportunities USING btree (opportunity_id)`
- `CREATE INDEX idx_crm_opportunities_customer ON public.crm_opportunities USING btree (customer_id, created_at, opportunity_id)`

### public.crm_opportunity_stage_history

商机阶段追加历史

源码依据：`server/adapters/postgres/opportunity-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `history_id` | uuid | 否 | gen_random_uuid() | 商机阶段历史UUID |
| `opportunity_id` | uuid | 否 | — | 中心商机UUID |
| `from_stage` | text | 是 | — | 商机变更前阶段 |
| `to_stage` | text | 否 | — | 商机变更后阶段 |
| `actor_id` | uuid | 否 | — | 操作人中心身份UUID |
| `occurred_at` | timestamp with time zone | 否 | clock_timestamp() | 业务事实实际发生时间 |
| `amount` | numeric | 是 | — | 商机金额；精度/范围和currency联动受CHECK约束 |
| `currency` | text | 是 | — | 三字母货币代码 |
| `lost_reason` | text | 是 | — | 商机失败关闭原因 |
| `evidence` | text | 是 | — | 商机赢单证据说明 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_opportunity_stage_history_actor_id_fkey` [f]：`FOREIGN KEY (actor_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_opportunity_stage_history_actor_id_not_null` [n]：`NOT NULL actor_id`；validated=true，deferrable=false
- `crm_opportunity_stage_history_check` [c]：`CHECK (amount IS NULL AND currency IS NULL OR amount IS NOT NULL AND currency IS NOT NULL AND amount >= 0::numeric AND amount < power(10::numeric, 12::numeric) AND scale(amount) <= 2 AND currency ~ '^[A-Z]{3}$'::text)`；validated=true，deferrable=false
- `crm_opportunity_stage_history_check1` [c]：`CHECK (from_stage IS DISTINCT FROM to_stage)`；validated=true，deferrable=false
- `crm_opportunity_stage_history_check2` [c]：`CHECK (to_stage = 'closed_won'::text AND evidence IS NOT NULL AND btrim(evidence) <> ''::text AND length(evidence) <= 4096 AND amount IS NOT NULL AND lost_reason IS NULL OR to_stage = 'closed_lost'::text AND lost_reason IS NOT NULL AND btrim(lost_reason) <> ''::text AND length(lost_reason) <= 2000 AND evidence IS NULL OR (to_stage <> ALL (ARRAY['closed_won'::text, 'closed_lost'::text])) AND evidence IS NULL AND lost_reason IS NULL)`；validated=true，deferrable=false
- `crm_opportunity_stage_history_from_stage_check` [c]：`CHECK (from_stage = ANY (ARRAY['inquiry'::text, 'quote_sent'::text, 'negotiation'::text, 'booking_confirmed'::text, 'closed_won'::text, 'closed_lost'::text]))`；validated=true，deferrable=false
- `crm_opportunity_stage_history_history_id_not_null` [n]：`NOT NULL history_id`；validated=true，deferrable=false
- `crm_opportunity_stage_history_occurred_at_not_null` [n]：`NOT NULL occurred_at`；validated=true，deferrable=false
- `crm_opportunity_stage_history_opportunity_id_fkey` [f]：`FOREIGN KEY (opportunity_id) REFERENCES crm_opportunities(opportunity_id)`；validated=true，deferrable=false
- `crm_opportunity_stage_history_opportunity_id_not_null` [n]：`NOT NULL opportunity_id`；validated=true，deferrable=false
- `crm_opportunity_stage_history_pkey` [p]：`PRIMARY KEY (history_id)`；validated=true，deferrable=false
- `crm_opportunity_stage_history_to_stage_check` [c]：`CHECK (to_stage = ANY (ARRAY['inquiry'::text, 'quote_sent'::text, 'negotiation'::text, 'booking_confirmed'::text, 'closed_won'::text, 'closed_lost'::text]))`；validated=true，deferrable=false
- `crm_opportunity_stage_history_to_stage_not_null` [n]：`NOT NULL to_stage`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_opportunity_stage_history_pkey ON public.crm_opportunity_stage_history USING btree (history_id)`
- `CREATE INDEX idx_crm_opportunity_history ON public.crm_opportunity_stage_history USING btree (opportunity_id, occurred_at, history_id)`

真实触发器：

- `CREATE TRIGGER crm_opportunity_history_append_only BEFORE DELETE OR UPDATE ON crm_opportunity_stage_history FOR EACH ROW EXECUTE FUNCTION crm_opportunity_history_append_only()`

### public.crm_relations

联系人关系

源码依据：`server/adapters/postgres/schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | integer | 否 | identity=d;  | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `contact_id_a` | integer | 否 | — | 关系起点联系人ID |
| `contact_id_b` | integer | 否 | — | 关系终点联系人ID |
| `relation_type` | text | 否 | — | 联系人关系类型文本 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_relations_check` [c]：`CHECK (contact_id_a <> contact_id_b)`；validated=true，deferrable=false
- `crm_relations_contact_id_a_contact_id_b_relation_type_key` [u]：`UNIQUE (contact_id_a, contact_id_b, relation_type)`；validated=true，deferrable=false
- `crm_relations_contact_id_a_fkey` [f]：`FOREIGN KEY (contact_id_a) REFERENCES contacts(id)`；validated=true，deferrable=false
- `crm_relations_contact_id_a_not_null` [n]：`NOT NULL contact_id_a`；validated=true，deferrable=false
- `crm_relations_contact_id_b_fkey` [f]：`FOREIGN KEY (contact_id_b) REFERENCES contacts(id)`；validated=true，deferrable=false
- `crm_relations_contact_id_b_not_null` [n]：`NOT NULL contact_id_b`；validated=true，deferrable=false
- `crm_relations_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `crm_relations_id_not_null` [n]：`NOT NULL id`；validated=true，deferrable=false
- `crm_relations_pkey` [p]：`PRIMARY KEY (id)`；validated=true，deferrable=false
- `crm_relations_relation_type_not_null` [n]：`NOT NULL relation_type`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_relations_contact_id_a_contact_id_b_relation_type_key ON public.crm_relations USING btree (contact_id_a, contact_id_b, relation_type)`
- `CREATE UNIQUE INDEX crm_relations_pkey ON public.crm_relations USING btree (id)`

### public.crm_schema_migrations

中心迁移版本及DDL校验摘要

源码依据：；`server/adapters/postgres/repository.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `version` | text | 否 | — | 本表乐观并发版本；与联系人/任务等其他表版本独立 |
| `checksum` | text | 否 | — | 迁移DDL的SHA256摘要 |
| `applied_at` | timestamp with time zone | 否 | now() | 结构迁移应用时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_schema_migrations_applied_at_not_null` [n]：`NOT NULL applied_at`；validated=true，deferrable=false
- `crm_schema_migrations_checksum_not_null` [n]：`NOT NULL checksum`；validated=true，deferrable=false
- `crm_schema_migrations_pkey` [p]：`PRIMARY KEY (version)`；validated=true，deferrable=false
- `crm_schema_migrations_version_not_null` [n]：`NOT NULL version`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_schema_migrations_pkey ON public.crm_schema_migrations USING btree (version)`

### public.crm_shared_activities

中心共享跟进、邮件触达及商机活动

源码依据：`server/adapters/postgres/lead-schema.ts`、`server/adapters/postgres/followup-schema.ts`、`server/adapters/postgres/opportunity-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | bigint | 否 | identity=a;  | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `customer_id` | uuid | 否 | — | 中心客户容器UUID |
| `interaction_id` | integer | 是 | — | 兼容历史互动记录ID；新增中心跟进可为空 |
| `actor_id` | uuid | 否 | — | 操作人中心身份UUID |
| `note` | text | 否 | — | 中心跟进或运价/舱位备注 |
| `stage` | text | 是 | — | 本表阶段；contacts为发送轮次/旧字段，客户关系/商机阶段见所属表约束 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |
| `method` | text | 否 | 'legacy'::text | 中心跟进方式email/phone/visit/other/note/legacy |
| `occurred_at` | timestamp with time zone | 否 | now() | 业务事实实际发生时间 |
| `recorded_at` | timestamp with time zone | 否 | now() | 中心收到并记账时间 |
| `contact_id` | integer | 是 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `contact_status` | text | 是 | — | 中心跟进活动记录的触达状态 |
| `opportunity_id` | uuid | 是 | — | 中心商机UUID |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_activity_opportunity_customer_fk` [f]：`FOREIGN KEY (opportunity_id, customer_id) REFERENCES crm_opportunities(opportunity_id, customer_id)`；validated=true，deferrable=false
- `crm_activity_touch_requires_contact` [c]：`CHECK (contact_status IS NULL OR contact_id IS NOT NULL AND (method <> ALL (ARRAY['note'::text, 'legacy'::text])))`；validated=true，deferrable=false
- `crm_shared_activities_actor_id_fkey` [f]：`FOREIGN KEY (actor_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_shared_activities_actor_id_not_null` [n]：`NOT NULL actor_id`；validated=true，deferrable=false
- `crm_shared_activities_contact_id_fkey` [f]：`FOREIGN KEY (contact_id) REFERENCES contacts(id)`；validated=true，deferrable=false
- `crm_shared_activities_contact_status_check` [c]：`CHECK (contact_status = ANY (ARRAY['uncontacted'::text, 'contacted'::text, 'replied'::text, 'unreachable'::text]))`；validated=true，deferrable=false
- `crm_shared_activities_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `crm_shared_activities_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `crm_shared_activities_customer_id_not_null` [n]：`NOT NULL customer_id`；validated=true，deferrable=false
- `crm_shared_activities_id_not_null` [n]：`NOT NULL id`；validated=true，deferrable=false
- `crm_shared_activities_interaction_id_fkey` [f]：`FOREIGN KEY (interaction_id) REFERENCES interactions(id)`；validated=true，deferrable=false
- `crm_shared_activities_method_check` [c]：`CHECK (method = ANY (ARRAY['legacy'::text, 'email'::text, 'phone'::text, 'visit'::text, 'other'::text, 'note'::text]))`；validated=true，deferrable=false
- `crm_shared_activities_method_not_null` [n]：`NOT NULL method`；validated=true，deferrable=false
- `crm_shared_activities_note_not_null` [n]：`NOT NULL note`；validated=true，deferrable=false
- `crm_shared_activities_occurred_at_not_null` [n]：`NOT NULL occurred_at`；validated=true，deferrable=false
- `crm_shared_activities_pkey` [p]：`PRIMARY KEY (id)`；validated=true，deferrable=false
- `crm_shared_activities_recorded_at_not_null` [n]：`NOT NULL recorded_at`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_shared_activities_pkey ON public.crm_shared_activities USING btree (id)`
- `CREATE INDEX idx_crm_activities_occurred ON public.crm_shared_activities USING btree (customer_id, occurred_at DESC, id DESC)`
- `CREATE INDEX idx_crm_activity_opportunity ON public.crm_shared_activities USING btree (opportunity_id) WHERE (opportunity_id IS NOT NULL)`
- `CREATE INDEX idx_crm_shared_activities_customer ON public.crm_shared_activities USING btree (customer_id, id DESC)`

### public.crm_task_due_receipts

中心任务版本到期通知回执

源码依据：`server/adapters/postgres/task-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `task_id` | uuid | 否 | — | 中心跟进任务UUID |
| `task_version` | integer | 否 | — | 到期回执对应的任务版本 |
| `responsible_user_id` | uuid | 否 | — | 任务到期时的负责人UUID |
| `event_id` | uuid | 否 | — | 中心事件UUID；具体关联见FK |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_task_due_receipts_event_id_fkey` [f]：`FOREIGN KEY (event_id) REFERENCES identity.outbox(event_id)`；validated=true，deferrable=false
- `crm_task_due_receipts_event_id_key` [u]：`UNIQUE (event_id)`；validated=true，deferrable=false
- `crm_task_due_receipts_event_id_not_null` [n]：`NOT NULL event_id`；validated=true，deferrable=false
- `crm_task_due_receipts_pkey` [p]：`PRIMARY KEY (task_id, task_version)`；validated=true，deferrable=false
- `crm_task_due_receipts_responsible_user_id_fkey` [f]：`FOREIGN KEY (responsible_user_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_task_due_receipts_responsible_user_id_not_null` [n]：`NOT NULL responsible_user_id`；validated=true，deferrable=false
- `crm_task_due_receipts_task_id_fkey` [f]：`FOREIGN KEY (task_id) REFERENCES crm_followup_tasks(task_id)`；validated=true，deferrable=false
- `crm_task_due_receipts_task_id_not_null` [n]：`NOT NULL task_id`；validated=true，deferrable=false
- `crm_task_due_receipts_task_version_check` [c]：`CHECK (task_version > 0)`；validated=true，deferrable=false
- `crm_task_due_receipts_task_version_not_null` [n]：`NOT NULL task_version`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_task_due_receipts_event_id_key ON public.crm_task_due_receipts USING btree (event_id)`
- `CREATE UNIQUE INDEX crm_task_due_receipts_pkey ON public.crm_task_due_receipts USING btree (task_id, task_version)`

### public.crm_workbook_source_mappings

历史工作簿来源引用与中心实体映射

源码依据：`server/adapters/postgres/customer-profile-schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `actor_id` | uuid | 否 | — | 操作人中心身份UUID |
| `source` | text | 否 | — | 业务来源/导入来源文本；不等同origin身份来源 |
| `origin` | text | 否 | — | 线索身份来源：operations管理员来源/personal用户自有 |
| `entity` | text | 否 | — | 来源映射实体类别customer/contact |
| `source_ref` | text | 否 | — | 导入实体原始引用键 |
| `customer_ref` | text | 否 | — | 导入实体指向的原始客户引用键 |
| `customer_id` | uuid | 否 | — | 中心客户容器UUID |
| `contact_id` | integer | 是 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `crm_workbook_source_mappings_actor_id_fkey` [f]：`FOREIGN KEY (actor_id) REFERENCES identity.users(user_id)`；validated=true，deferrable=false
- `crm_workbook_source_mappings_actor_id_not_null` [n]：`NOT NULL actor_id`；validated=true，deferrable=false
- `crm_workbook_source_mappings_check` [c]：`CHECK ((entity = 'contact'::text) = (contact_id IS NOT NULL))`；validated=true，deferrable=false
- `crm_workbook_source_mappings_contact_id_fkey` [f]：`FOREIGN KEY (contact_id) REFERENCES contacts(id)`；validated=true，deferrable=false
- `crm_workbook_source_mappings_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `crm_workbook_source_mappings_customer_id_fkey` [f]：`FOREIGN KEY (customer_id) REFERENCES crm_customers(customer_id)`；validated=true，deferrable=false
- `crm_workbook_source_mappings_customer_id_not_null` [n]：`NOT NULL customer_id`；validated=true，deferrable=false
- `crm_workbook_source_mappings_customer_ref_not_null` [n]：`NOT NULL customer_ref`；validated=true，deferrable=false
- `crm_workbook_source_mappings_entity_check` [c]：`CHECK (entity = ANY (ARRAY['customer'::text, 'contact'::text]))`；validated=true，deferrable=false
- `crm_workbook_source_mappings_entity_not_null` [n]：`NOT NULL entity`；validated=true，deferrable=false
- `crm_workbook_source_mappings_origin_check` [c]：`CHECK (origin = ANY (ARRAY['personal'::text, 'operations'::text]))`；validated=true，deferrable=false
- `crm_workbook_source_mappings_origin_not_null` [n]：`NOT NULL origin`；validated=true，deferrable=false
- `crm_workbook_source_mappings_pkey` [p]：`PRIMARY KEY (actor_id, source, origin, entity, source_ref)`；validated=true，deferrable=false
- `crm_workbook_source_mappings_source_not_null` [n]：`NOT NULL source`；validated=true，deferrable=false
- `crm_workbook_source_mappings_source_ref_not_null` [n]：`NOT NULL source_ref`；validated=true，deferrable=false

真实索引：

- `CREATE UNIQUE INDEX crm_workbook_source_mappings_pkey ON public.crm_workbook_source_mappings USING btree (actor_id, source, origin, entity, source_ref)`

### public.interactions

基础互动事件；PG只有中心跟进/阶段，SQLite保留个人邮件历史

源码依据：`server/adapters/postgres/schema.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | integer | 否 | identity=d;  | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `contact_id` | integer | 否 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `type` | text | 否 | — | 互动事件类型；PG仅followup/stage，个人SQLite允许邮件/备注等历史类型 |
| `direction` | text | 否 | 'internal'::text | 互动/邮件方向 |
| `channel` | text | 否 | 'crm'::text | 互动渠道；PG基础interactions限定crm |
| `body_preview` | text | 是 | — | 邮件/互动预览文本；不导出实际内容 |
| `metadata` | jsonb | 否 | '{}'::jsonb | 互动扩展JSON；未约束key的语义需以写入方为准 |
| `created_at` | timestamp with time zone | 否 | now() | 记录创建时间 |

真实约束（PK主键 / FK外键 / U唯一 / C检查）：

- `interactions_channel_check` [c]：`CHECK (channel = 'crm'::text)`；validated=true，deferrable=false
- `interactions_channel_not_null` [n]：`NOT NULL channel`；validated=true，deferrable=false
- `interactions_contact_id_fkey` [f]：`FOREIGN KEY (contact_id) REFERENCES contacts(id)`；validated=true，deferrable=false
- `interactions_contact_id_not_null` [n]：`NOT NULL contact_id`；validated=true，deferrable=false
- `interactions_created_at_not_null` [n]：`NOT NULL created_at`；validated=true，deferrable=false
- `interactions_direction_check` [c]：`CHECK (direction = 'internal'::text)`；validated=true，deferrable=false
- `interactions_direction_not_null` [n]：`NOT NULL direction`；validated=true，deferrable=false
- `interactions_id_not_null` [n]：`NOT NULL id`；validated=true，deferrable=false
- `interactions_metadata_check` [c]：`CHECK (jsonb_typeof(metadata) = 'object'::text)`；validated=true，deferrable=false
- `interactions_metadata_not_null` [n]：`NOT NULL metadata`；validated=true，deferrable=false
- `interactions_pkey` [p]：`PRIMARY KEY (id)`；validated=true，deferrable=false
- `interactions_type_check` [c]：`CHECK (type = ANY (ARRAY['followup'::text, 'stage'::text]))`；validated=true，deferrable=false
- `interactions_type_not_null` [n]：`NOT NULL type`；validated=true，deferrable=false

真实索引：

- `CREATE INDEX idx_interactions_contact_id ON public.interactions USING btree (contact_id, id DESC)`
- `CREATE UNIQUE INDEX interactions_pkey ON public.interactions USING btree (id)`

## 4. 个人SQLite prospector.db：每表、每列与真实约束

### _migrations

个人SQLite命名迁移注册表

源码依据：`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `name` | TEXT | 否; PK顺位1 | — | 本表对象名称；迁移表为迁移名称 |
| `applied_at` | TEXT | 否 | CURRENT_TIMESTAMP | 结构迁移应用时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE _migrations (
    name TEXT PRIMARY KEY NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
```

实际索引：

- `sqlite_autoindex__migrations_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 name

### agent_conversations

个人Agent会话元信息

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | TEXT | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `title` | TEXT | 否 | '新对话' | 联系人职位或本表对象标题 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |
| `updated_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录更新时间 |
| `archived_at` | TEXT | PRAGMA未设NOT NULL | — | Agent会话归档时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE agent_conversations (
  id text PRIMARY KEY NOT NULL,
  title text DEFAULT '新对话' NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
, archived_at text)
```

实际索引：

- `sqlite_autoindex_agent_conversations_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 id

### agent_facts

Agent提取事实

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `conversation_id` | TEXT | 否 | — | 本地Agent会话ID |
| `tool_name` | TEXT | 否 | — | Agent工具名称 |
| `fact` | TEXT | 否 | — | Agent提取的事实文本 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE agent_facts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL,
  tool_name text NOT NULL, fact text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- `idx_agent_facts_conv`：unique=0, origin=c, partial=0；`CREATE INDEX idx_agent_facts_conv ON agent_facts(conversation_id)`

### agent_gaps

Agent发现的能力/事实缺口

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `wanted` | TEXT | 否 | — | Agent期望但缺少的能力/事实 |
| `scene` | TEXT | PRAGMA未设NOT NULL | — | Agent缺口场景 |
| `workaround` | TEXT | PRAGMA未设NOT NULL | — | Agent缺口替代办法 |
| `hits` | INTEGER | 否 | 1 | 同类Agent缺口出现次数 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |
| `last_seen_at` | TEXT | 否 | CURRENT_TIMESTAMP | Agent缺口最近再出现时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE agent_gaps (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  wanted text NOT NULL, scene text, workaround text,
  hits integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  last_seen_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- 无索引。

### agent_messages

个人Agent会话消息

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `conversation_id` | TEXT | 否 | — | 本地Agent会话ID |
| `role` | TEXT | 否 | — | 身份产品角色、Agent消息角色或邮件关联角色，按所属表契约解释 |
| `content` | TEXT | 否 | — | Agent消息内容或FTS检索内容；不导出内容 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE agent_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL REFERENCES agent_conversations(id),
  role text NOT NULL, content text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

PRAGMA外键：

- conversation_id → agent_conversations.id；on_update=NO ACTION / on_delete=NO ACTION

实际索引：

- `idx_agent_messages_conv`：unique=0, origin=c, partial=0；`CREATE INDEX idx_agent_messages_conv ON agent_messages(conversation_id)`

### agent_suggestions

保留兼容的Agent建议

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `day` | TEXT | 否 | — | 建议所属日期 |
| `group_name` | TEXT | 否 | — | 建议分组 |
| `template` | TEXT | 否 | — | 建议模板文本 |
| `source` | TEXT | 否 | — | 业务来源/导入来源文本；不等同origin身份来源 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE agent_suggestions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  day text NOT NULL, group_name text NOT NULL,
  template text NOT NULL, source text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- `idx_agent_suggestions_day`：unique=0, origin=c, partial=0；`CREATE INDEX idx_agent_suggestions_day ON agent_suggestions(day)`

### agent_tool_calls

Agent工具调用、批准与结果审计

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `conversation_id` | TEXT | 否 | — | 本地Agent会话ID |
| `tool_name` | TEXT | 否 | — | Agent工具名称 |
| `side_effect` | TEXT | 否 | — | Agent工具调用副作用等级 |
| `args_json` | TEXT | PRAGMA未设NOT NULL | — | 工具参数序列化JSON |
| `result_json` | TEXT | PRAGMA未设NOT NULL | — | 工具结果序列化JSON |
| `approval` | TEXT | 否 | — | Agent工具调用批准结论 |
| `error` | TEXT | PRAGMA未设NOT NULL | — | 失败/同步错误说明 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE agent_tool_calls (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL,
  tool_name text NOT NULL, side_effect text NOT NULL,
  args_json text, result_json text,
  approval text NOT NULL, error text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- 无索引。

### agent_working_memory

Agent结构化工作记忆

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `conversation_id` | TEXT | 否 | — | 本地Agent会话ID |
| `kind` | TEXT | 否 | — | 邮件事件/工作记忆/搜索条目类别 |
| `ref_id` | TEXT | 否 | — | 工作记忆引用对象ID |
| `tool_name` | TEXT | 否 | — | Agent工具名称 |
| `context_line` | TEXT | 否 | — | 用于Agent上下文回放的摘要行 |
| `payload_json` | TEXT | 否 | — | 工作记忆结构化序列化JSON |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |
| `updated_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录更新时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE agent_working_memory (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  conversation_id text NOT NULL,
  kind text NOT NULL, ref_id text NOT NULL, tool_name text NOT NULL,
  context_line text NOT NULL, payload_json text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- `idx_awm_conv_kind`：unique=0, origin=c, partial=0；`CREATE INDEX idx_awm_conv_kind ON agent_working_memory(conversation_id, kind)`

### companies

公司主档/背调；PG为中心共享基础资料，SQLite为历史本地数据

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `name` | TEXT | 否 | — | 本表对象名称；迁移表为迁移名称 |
| `domain` | TEXT | PRAGMA未设NOT NULL | — | 公司域名 |
| `industry` | TEXT | PRAGMA未设NOT NULL | — | 公司行业 |
| `country` | TEXT | PRAGMA未设NOT NULL | — | 国家 |
| `size` | TEXT | PRAGMA未设NOT NULL | — | 公司规模 |
| `backcheck_data` | TEXT | PRAGMA未设NOT NULL | — | 公司背调JSON；SQLite为序列化文本，PG为jsonb对象 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |
| `updated_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录更新时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE companies (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL, domain text, industry text, country text, size text,
  backcheck_data text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- `idx_companies_name`：unique=0, origin=c, partial=0；`CREATE INDEX idx_companies_name ON companies(name)`

触发器：

- `search_company_update`（完整SQL见结构JSON）。

### contacts

联系人主档；PG是正式客户页事实源，SQLite为历史本地联系人

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `email` | TEXT | 否 | — | 邮箱地址；唯一性/是否允许空值见实际DDL |
| `company_id` | INTEGER | PRAGMA未设NOT NULL | — | 本库公司主键；不能跨中心与个人SQLite按同号互认 |
| `first_name` | TEXT | PRAGMA未设NOT NULL | — | 联系人名字 |
| `last_name` | TEXT | PRAGMA未设NOT NULL | — | 联系人姓氏 |
| `title` | TEXT | PRAGMA未设NOT NULL | — | 联系人职位或本表对象标题 |
| `phone` | TEXT | PRAGMA未设NOT NULL | — | 联系电话 |
| `linkedin` | TEXT | PRAGMA未设NOT NULL | — | 领英地址 |
| `country` | TEXT | PRAGMA未设NOT NULL | — | 国家 |
| `client_type` | TEXT | PRAGMA未设NOT NULL | — | 联系人客户类型 |
| `language` | TEXT | PRAGMA未设NOT NULL | — | 联系人/模板语言 |
| `stage` | TEXT | PRAGMA未设NOT NULL | 'cold' | 发送轮次/旧开发字段；不以此推定中心客户关系阶段或触达状态 |
| `status` | TEXT | PRAGMA未设NOT NULL | '' | 本表状态；允许值/默认值和状态约束见下方DDL |
| `tags` | TEXT | PRAGMA未设NOT NULL | — | 联系人标签；中心jsonb数组，SQLite为文本存储 |
| `extra` | TEXT | PRAGMA未设NOT NULL | '{}' | 联系人扩展JSON；业务key见后文且未规定的key用途未知 |
| `assignee` | TEXT | PRAGMA未设NOT NULL | '' | 原联系人归属显示/历史文本；不作为中心用户授权依据 |
| `source` | TEXT | PRAGMA未设NOT NULL | 'manual' | 业务来源/导入来源文本；不等同origin身份来源 |
| `source_detail` | TEXT | PRAGMA未设NOT NULL | — | 来源补充说明 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |
| `updated_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录更新时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE contacts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE,
  company_id integer, first_name text, last_name text,
  title text, phone text, linkedin text,
  country text, client_type text, language text,
  stage text DEFAULT 'cold',
  status text DEFAULT '',
  tags text,
  extra text DEFAULT '{}',
  assignee text DEFAULT '',
  source text DEFAULT 'manual', source_detail text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- `idx_contacts_company_id`：unique=0, origin=c, partial=0；`CREATE INDEX idx_contacts_company_id ON contacts(company_id)`
- `idx_contacts_client_type`：unique=0, origin=c, partial=0；`CREATE INDEX idx_contacts_client_type ON contacts(client_type)`
- `idx_contacts_stage`：unique=0, origin=c, partial=0；`CREATE INDEX idx_contacts_stage ON contacts(stage)`
- `idx_contacts_status`：unique=0, origin=c, partial=0；`CREATE INDEX idx_contacts_status ON contacts(status)`
- `idx_contacts_updated_at`：unique=0, origin=c, partial=0；`CREATE INDEX idx_contacts_updated_at ON contacts(updated_at)`
- `idx_contacts_lower_email`：unique=0, origin=c, partial=0；`CREATE INDEX idx_contacts_lower_email ON contacts(lower(email))`
- `sqlite_autoindex_contacts_1`：unique=1, origin=u, partial=0；SQLite自动索引；列 email

触发器：

- `search_contacts_delete`（完整SQL见结构JSON）。
- `search_contacts_insert`（完整SQL见结构JSON）。
- `search_contacts_update`（完整SQL见结构JSON）。

### crm_relations

联系人关系

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `contact_id_a` | INTEGER | 否 | — | 关系起点联系人ID |
| `contact_id_b` | INTEGER | 否 | — | 关系终点联系人ID |
| `relation_type` | TEXT | 否 | — | 联系人关系类型文本 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE crm_relations (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id_a integer NOT NULL REFERENCES contacts(id),
  contact_id_b integer NOT NULL REFERENCES contacts(id),
  relation_type text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

PRAGMA外键：

- contact_id_b → contacts.id；on_update=NO ACTION / on_delete=NO ACTION
- contact_id_a → contacts.id；on_update=NO ACTION / on_delete=NO ACTION

实际索引：

- 无索引。

### crm_send_receipts

已确认SMTP接受的本地持久回执、原文、账号和同步状态；不能当缓存删除

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `send_key` | TEXT | 否; PK顺位1 | — | 确认发送项目的幂等编号（UUID字符串） |
| `center_scope` | TEXT | 否 | — | JSON [centerBaseUrl,userId]，当前账号及中心作用域 |
| `payload` | TEXT | 否 | — | 中心事件或本地待同步邮件事件的JSON负载；见对应契约 |
| `mail_ids` | TEXT | 否 | — | 本地收件箱行号数组；不是中心联系人编号 |
| `recorded_at` | TEXT | 否 | — | 中心收到并记账时间 |
| `synced_at` | TEXT | PRAGMA未设NOT NULL | — | 运价/舱位镜像同步时间 |
| `history_hidden` | INTEGER | 否 | 0 | 仅隐藏历史列表；不删除待同步事实或账号亲和记录 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE crm_send_receipts (
  send_key TEXT PRIMARY KEY NOT NULL,
  center_scope TEXT NOT NULL,
  payload TEXT NOT NULL,
  mail_ids TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  synced_at TEXT,
  history_hidden INTEGER NOT NULL DEFAULT 0
)
```

实际索引：

- `idx_crm_send_receipts_pending`：unique=0, origin=c, partial=0；`CREATE INDEX idx_crm_send_receipts_pending ON crm_send_receipts(center_scope,synced_at)`
- `sqlite_autoindex_crm_send_receipts_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 send_key

### crm_stages

旧本地CRM阶段/提醒表；不等于中心关系阶段

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `contact_id` | INTEGER | 否 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `stage` | TEXT | 否 | — | 本表阶段；contacts为发送轮次/旧字段，客户关系/商机阶段见所属表约束 |
| `notes` | TEXT | PRAGMA未设NOT NULL | — | 旧本地CRM备注 |
| `reminder_at` | TEXT | PRAGMA未设NOT NULL | — | 旧本地CRM提醒时间 |
| `reminder_note` | TEXT | PRAGMA未设NOT NULL | — | 旧本地CRM提醒内容 |
| `updated_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录更新时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE crm_stages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id integer NOT NULL UNIQUE REFERENCES contacts(id),
  stage text NOT NULL, notes text,
  reminder_at text, reminder_note text,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

PRAGMA外键：

- contact_id → contacts.id；on_update=NO ACTION / on_delete=NO ACTION

实际索引：

- `sqlite_autoindex_crm_stages_1`：unique=1, origin=u, partial=0；SQLite自动索引；列 contact_id

### email_accounts

个人邮箱配置与收发健康度

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `email` | TEXT | 否 | — | 邮箱地址；唯一性/是否允许空值见实际DDL |
| `provider` | TEXT | 否 | 'smtp' | 邮箱服务提供方式 |
| `smtp_host` | TEXT | PRAGMA未设NOT NULL | — | SMTP服务器地址 |
| `smtp_port` | INTEGER | PRAGMA未设NOT NULL | — | SMTP端口 |
| `imap_host` | TEXT | PRAGMA未设NOT NULL | — | IMAP服务器地址 |
| `imap_port` | INTEGER | PRAGMA未设NOT NULL | — | IMAP端口 |
| `encrypted_pass` | TEXT | 否 | — | 本地邮箱加密口令；只记录结构，不读取值 |
| `display_name` | TEXT | PRAGMA未设NOT NULL | — | 用户/邮箱账号显示名称 |
| `signature` | TEXT | PRAGMA未设NOT NULL | — | 邮箱签名模板 |
| `consecutive_fails` | INTEGER | 否 | 0 | 连续发信失败计数 |
| `circuit_open_at` | TEXT | PRAGMA未设NOT NULL | — | 发信熔断打开时间 |
| `circuit_reset_after` | TEXT | PRAGMA未设NOT NULL | — | 发信熔断允许复位时间 |
| `circuit_reason` | TEXT | PRAGMA未设NOT NULL | — | 发信受阻原因 |
| `last_fetch_error` | TEXT | PRAGMA未设NOT NULL | — | 最近收信错误说明 |
| `last_fetch_at` | TEXT | PRAGMA未设NOT NULL | — | 最近收信尝试时间（成功/失败另看错误与计数） |
| `fetch_fail_count` | INTEGER | 否 | 0 | 连续收信失败计数 |
| `is_active` | INTEGER | 否 | 1 | 本地对象是否启用（整数布尔） |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE email_accounts (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  email text NOT NULL UNIQUE,
  provider text DEFAULT 'smtp' NOT NULL,
  smtp_host text, smtp_port integer,
  imap_host text, imap_port integer,
  encrypted_pass text NOT NULL, display_name text, signature text,
  consecutive_fails integer DEFAULT 0 NOT NULL,
  circuit_open_at text, circuit_reset_after text, circuit_reason text,
  last_fetch_error text, last_fetch_at text,
  fetch_fail_count integer DEFAULT 0 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- `sqlite_autoindex_email_accounts_1`：unique=1, origin=u, partial=0；SQLite自动索引；列 email

### inbox_bounce_matches

退信与被退历史本地联系人多匹配

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `message_id` | INTEGER | 否 | — | 个人SQLite inbox_messages.id（整数行号）；不是RFC Message-ID，数据库未声明FK |
| `contact_id` | INTEGER | 否 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE inbox_bounce_matches (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  message_id integer NOT NULL, contact_id integer NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  UNIQUE(message_id, contact_id)
)
```

实际索引：

- `sqlite_autoindex_inbox_bounce_matches_1`：unique=1, origin=u, partial=0；SQLite自动索引；列 message_id,contact_id

### inbox_messages

个人邮件头/预览；正文另存文件

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `account_id` | INTEGER | 否 | — | 个人SQLite邮箱账号ID |
| `message_id` | TEXT | PRAGMA未设NOT NULL | — | 邮件协议消息标识；inbox_bounce_matches中专指inbox_messages本地行ID |
| `from_email` | TEXT | 否 | — | 邮件发件人地址 |
| `from_name` | TEXT | PRAGMA未设NOT NULL | — | 邮件发件人显示名 |
| `subject` | TEXT | PRAGMA未设NOT NULL | — | 邮件主题/模板主题 |
| `body_preview` | TEXT | PRAGMA未设NOT NULL | — | 邮件/互动预览文本；不导出实际内容 |
| `classification` | TEXT | PRAGMA未设NOT NULL | — | 收件箱一级分类 |
| `to` | TEXT | PRAGMA未设NOT NULL | — | 收件人文本 |
| `cc` | TEXT | PRAGMA未设NOT NULL | — | 抄送地址文本 |
| `my_role` | TEXT | PRAGMA未设NOT NULL | — | 当前邮箱在邮件里的角色 |
| `matched_contact_id` | INTEGER | PRAGMA未设NOT NULL | — | 历史本地单一主匹配联系人ID；不是中心ID |
| `related_contact_ids` | TEXT | PRAGMA未设NOT NULL | — | 历史本地关联联系人ID列表文本 |
| `is_read` | INTEGER | 否 | 0 | 本地邮件已读标志（整数布尔） |
| `received_at` | TEXT | 否 | — | 邮件收到/导入时记录的邮件时间 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |
| `intent` | TEXT | PRAGMA未设NOT NULL | — | 邮件意图识别结果 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE inbox_messages (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL REFERENCES email_accounts(id),
  message_id text, from_email text NOT NULL, from_name text,
  subject text, body_preview text, classification text,
  "to" text, cc text, my_role text,
  matched_contact_id integer, related_contact_ids text,
  is_read integer DEFAULT 0 NOT NULL,
  received_at text NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
, intent text)
```

PRAGMA外键：

- account_id → email_accounts.id；on_update=NO ACTION / on_delete=NO ACTION

实际索引：

- `idx_inbox_matched`：unique=0, origin=c, partial=0；`CREATE INDEX idx_inbox_matched ON inbox_messages(matched_contact_id)`
- `idx_inbox_unmatched_from`：unique=0, origin=c, partial=1；`CREATE INDEX idx_inbox_unmatched_from ON inbox_messages(lower(from_email)) WHERE matched_contact_id IS NULL`

触发器：

- `search_mail_delete`（完整SQL见结构JSON）。
- `search_mail_insert`（完整SQL见结构JSON）。
- `search_mail_update`（完整SQL见结构JSON）。

### interactions

基础互动事件；PG只有中心跟进/阶段，SQLite保留个人邮件历史

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `contact_id` | INTEGER | 否 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `type` | TEXT | 否 | — | 互动事件类型；PG仅followup/stage，个人SQLite允许邮件/备注等历史类型 |
| `direction` | TEXT | 否 | — | 互动/邮件方向 |
| `channel` | TEXT | 否 | 'email' | 互动渠道；PG基础interactions限定crm |
| `subject` | TEXT | PRAGMA未设NOT NULL | — | 邮件主题/模板主题 |
| `body_preview` | TEXT | PRAGMA未设NOT NULL | — | 邮件/互动预览文本；不导出实际内容 |
| `message_id` | TEXT | PRAGMA未设NOT NULL | — | 邮件协议消息标识；inbox_bounce_matches中专指inbox_messages本地行ID |
| `account_id` | INTEGER | PRAGMA未设NOT NULL | — | 个人SQLite邮箱账号ID |
| `metadata` | TEXT | PRAGMA未设NOT NULL | — | 互动扩展JSON；未约束key的语义需以写入方为准 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE interactions (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  contact_id integer NOT NULL REFERENCES contacts(id),
  type text NOT NULL, direction text NOT NULL,
  channel text DEFAULT 'email' NOT NULL,
  subject text, body_preview text, message_id text,
  account_id integer REFERENCES email_accounts(id),
  metadata text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

PRAGMA外键：

- account_id → email_accounts.id；on_update=NO ACTION / on_delete=NO ACTION
- contact_id → contacts.id；on_update=NO ACTION / on_delete=NO ACTION

实际索引：

- `idx_interactions_created_at`：unique=0, origin=c, partial=0；`CREATE INDEX idx_interactions_created_at ON interactions(created_at)`
- `idx_interactions_type`：unique=0, origin=c, partial=0；`CREATE INDEX idx_interactions_type ON interactions(type)`
- `idx_interactions_contact_id`：unique=0, origin=c, partial=0；`CREATE INDEX idx_interactions_contact_id ON interactions(contact_id)`

触发器：

- `search_notes_delete`（完整SQL见结构JSON）。
- `search_notes_insert`（完整SQL见结构JSON）。
- `search_notes_update`（完整SQL见结构JSON）。

### rate_quotes

运价台账只读查询镜像

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `record_id` | TEXT | 否; PK顺位1 | — | 运价台账来源记录ID；本地只做镜像 |
| `pol` | TEXT | PRAGMA未设NOT NULL | — | 起运港 |
| `pod_raw` | TEXT | 否 | — | 来源目的港原文 |
| `lane` | TEXT | PRAGMA未设NOT NULL | — | 航线分类 |
| `carrier` | TEXT | PRAGMA未设NOT NULL | — | 船公司 |
| `container` | TEXT | PRAGMA未设NOT NULL | — | 镜像规范箱型 |
| `container_raw` | TEXT | PRAGMA未设NOT NULL | — | 来源箱型原文 |
| `ocean_usd` | INTEGER | PRAGMA未设NOT NULL | — | 美元海运费整数 |
| `validity_raw` | TEXT | PRAGMA未设NOT NULL | — | 原始有效期文字 |
| `valid_from` | TEXT | PRAGMA未设NOT NULL | — | 运价有效期起始日 |
| `valid_to` | TEXT | PRAGMA未设NOT NULL | — | 运价有效期结束日 |
| `free_days` | TEXT | PRAGMA未设NOT NULL | — | 免箱期原文 |
| `shortfall_fee` | TEXT | PRAGMA未设NOT NULL | — | 亏舱费原文 |
| `note` | TEXT | PRAGMA未设NOT NULL | — | 中心跟进或运价/舱位备注 |
| `source_group` | TEXT | PRAGMA未设NOT NULL | — | 运价/舱位来源群 |
| `sender` | TEXT | PRAGMA未设NOT NULL | — | 来源消息发送人 |
| `msg_time` | TEXT | PRAGMA未设NOT NULL | — | 来源消息时间 |
| `image_name` | TEXT | PRAGMA未设NOT NULL | — | 来源图片文件名 |
| `etd` | TEXT | PRAGMA未设NOT NULL | — | 预计开航日期/来源原文 |
| `status` | TEXT | PRAGMA未设NOT NULL | — | 本表状态；允许值/默认值和状态约束见下方DDL |
| `message_text` | TEXT | PRAGMA未设NOT NULL | — | 来源消息文字 |
| `synced_at` | TEXT | 否 | CURRENT_TIMESTAMP | 运价/舱位镜像同步时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE rate_quotes (
  record_id text PRIMARY KEY NOT NULL,
  pol text, pod_raw text NOT NULL,
  lane text, carrier text,
  container text, container_raw text,
  ocean_usd integer,
  validity_raw text, valid_from text, valid_to text,
  free_days text, shortfall_fee text, note text,
  source_group text, sender text, msg_time text, image_name text,
  etd text, status text, message_text text,
  synced_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- `idx_rate_quotes_valid_to`：unique=0, origin=c, partial=0；`CREATE INDEX idx_rate_quotes_valid_to ON rate_quotes(valid_to)`
- `idx_rate_quotes_lane`：unique=0, origin=c, partial=0；`CREATE INDEX idx_rate_quotes_lane ON rate_quotes(lane)`
- `sqlite_autoindex_rate_quotes_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 record_id

### search_idx

FTS5虚拟检索表

源码依据：`src/main/db/search-index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `kind` | 未声明 | PRAGMA未设NOT NULL | — | 邮件事件/工作记忆/搜索条目类别 |
| `sourceId` | 未声明 | PRAGMA未设NOT NULL | — | FTS来源记录ID |
| `contactId` | 未声明 | PRAGMA未设NOT NULL | — | FTS关联历史本地联系人ID |
| `title` | 未声明 | PRAGMA未设NOT NULL | — | 联系人职位或本表对象标题 |
| `body` | 未声明 | PRAGMA未设NOT NULL | — | 邮件模板正文或搜索展示正文；不导出内容 |
| `content` | 未声明 | PRAGMA未设NOT NULL | — | Agent消息内容或FTS检索内容；不导出内容 |
| `search_idx` | 未声明 | PRAGMA未设NOT NULL | — | FTS5隐藏控制列，不是业务字段 |
| `rank` | 未声明 | PRAGMA未设NOT NULL | — | FTS5隐藏排序列 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE VIRTUAL TABLE search_idx USING fts5(
    kind UNINDEXED, sourceId UNINDEXED, contactId UNINDEXED, title UNINDEXED, body UNINDEXED, content,
    tokenize='unicode61'
  )
```

实际索引：

- 无索引。

### search_idx_config

FTS5自动影子表；不作为业务主数据

源码依据：`src/main/db/search-index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `k` | 未声明 | 否; PK顺位1 | — | FTS5内部配置key |
| `v` | 未声明 | PRAGMA未设NOT NULL | — | FTS5内部配置value |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE 'search_idx_config'(k PRIMARY KEY, v) WITHOUT ROWID
```

实际索引：

- `sqlite_autoindex_search_idx_config_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 k

### search_idx_content

FTS5自动影子表；不作为业务主数据

源码依据：`src/main/db/search-index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | PRAGMA未设NOT NULL; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `c0` | 未声明 | PRAGMA未设NOT NULL | — | FTS5内部内容列，对应kind/sourceId/contactId/title/body/content的第1列 |
| `c1` | 未声明 | PRAGMA未设NOT NULL | — | FTS5内部内容列，对应kind/sourceId/contactId/title/body/content的第2列 |
| `c2` | 未声明 | PRAGMA未设NOT NULL | — | FTS5内部内容列，对应kind/sourceId/contactId/title/body/content的第3列 |
| `c3` | 未声明 | PRAGMA未设NOT NULL | — | FTS5内部内容列，对应kind/sourceId/contactId/title/body/content的第4列 |
| `c4` | 未声明 | PRAGMA未设NOT NULL | — | FTS5内部内容列，对应kind/sourceId/contactId/title/body/content的第5列 |
| `c5` | 未声明 | PRAGMA未设NOT NULL | — | FTS5内部内容列，对应kind/sourceId/contactId/title/body/content的第6列 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE 'search_idx_content'(id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4, c5)
```

实际索引：

- 无索引。

### search_idx_data

FTS5自动影子表；不作为业务主数据

源码依据：`src/main/db/search-index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | PRAGMA未设NOT NULL; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `block` | BLOB | PRAGMA未设NOT NULL | — | FTS5内部索引块 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE 'search_idx_data'(id INTEGER PRIMARY KEY, block BLOB)
```

实际索引：

- 无索引。

### search_idx_docsize

FTS5自动影子表；不作为业务主数据

源码依据：`src/main/db/search-index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | PRAGMA未设NOT NULL; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `sz` | BLOB | PRAGMA未设NOT NULL | — | FTS5内部文档长度结构 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE 'search_idx_docsize'(id INTEGER PRIMARY KEY, sz BLOB)
```

实际索引：

- 无索引。

### search_idx_idx

FTS5自动影子表；不作为业务主数据

源码依据：`src/main/db/search-index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `segid` | 未声明 | 否; PK顺位1 | — | FTS5内部分段ID |
| `term` | 未声明 | 否; PK顺位2 | — | FTS5内部词条 |
| `pgno` | 未声明 | PRAGMA未设NOT NULL | — | FTS5内部索引页号 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE 'search_idx_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID
```

实际索引：

- `sqlite_autoindex_search_idx_idx_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 segid,term

### send_block_events

账号级发信受阻审计

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `account_id` | INTEGER | 否 | — | 个人SQLite邮箱账号ID |
| `message_id` | TEXT | 否 | — | 邮件协议消息标识；inbox_bounce_matches中专指inbox_messages本地行ID |
| `code` | TEXT | 否 | — | 服务商发信受阻错误代码 |
| `excerpt` | TEXT | PRAGMA未设NOT NULL | — | 发信受阻证据摘录 |
| `occurred_at` | TEXT | 否 | — | 业务事实实际发生时间 |
| `created_at` | TEXT | 否 | — | 记录创建时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE send_block_events (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  account_id integer NOT NULL,
  message_id text NOT NULL UNIQUE,
  code text NOT NULL, excerpt text,
  occurred_at text NOT NULL, created_at text NOT NULL
)
```

实际索引：

- `sqlite_autoindex_send_block_events_1`：unique=1, origin=u, partial=0；SQLite自动索引；列 message_id

### send_campaign_targets

发送任务逐联系人进度

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `campaign_id` | TEXT | 否 | — | 本地开发任务/发送活动ID |
| `contact_id` | INTEGER | 否 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `center_reference_json` | TEXT | PRAGMA未设NOT NULL | — | JSON {reference:{contactId,customerId},scope}；NULL只代表旧本地目标 |
| `status` | TEXT | 否 | 'pending' | 本表状态；允许值/默认值和状态约束见下方DDL |
| `round` | INTEGER | 否 | 0 | 已完成的触点轮次 |
| `next_touch_at` | TEXT | PRAGMA未设NOT NULL | — | 下一轮发送触达的计划时间 |
| `last_sent_at` | TEXT | PRAGMA未设NOT NULL | — | 最近实际发送时间 |
| `updated_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录更新时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE send_campaign_targets (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  campaign_id text NOT NULL,
  contact_id integer NOT NULL,
  center_reference_json text,
  status text DEFAULT 'pending' NOT NULL,
  round integer DEFAULT 0 NOT NULL,
  next_touch_at text,
  last_sent_at text,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- `idx_sct_campaign_contact`：unique=0, origin=c, partial=0；`CREATE INDEX idx_sct_campaign_contact ON send_campaign_targets(campaign_id, contact_id)`
- `idx_sct_status_next`：unique=0, origin=c, partial=0；`CREATE INDEX idx_sct_status_next ON send_campaign_targets(status, next_touch_at)`
- `idx_sct_campaign_status`：unique=0, origin=c, partial=0；`CREATE INDEX idx_sct_campaign_status ON send_campaign_targets(campaign_id, status)`

### send_campaigns

本地开发/发送任务

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | TEXT | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `name` | TEXT | 否 | — | 本表对象名称；迁移表为迁移名称 |
| `status` | TEXT | 否 | 'running' | 本表状态；允许值/默认值和状态约束见下方DDL |
| `auto_send` | INTEGER | 否 | 1 | 本地开发任务是否自动发送（整数布尔） |
| `target_filter_json` | TEXT | 否 | '{}' | 本地开发任务联系人筛选JSON |
| `touch_plan_json` | TEXT | 否 | — | 本地开发任务触达轮次计划JSON |
| `created_by` | TEXT | 否 | 'agent' | 创建入口ui/agent；不是中心创建者UUID |
| `account_policy` | TEXT | 否 | 'rotate' | 发送账号选择策略 |
| `account_ids_json` | TEXT | PRAGMA未设NOT NULL | — | 允许使用的本地邮箱账号ID列表JSON |
| `schedule_json` | TEXT | PRAGMA未设NOT NULL | — | 本地开发任务发送计划JSON |
| `send_mode` | TEXT | 否 | 'individual' | 发送方式individual/bcc；按本表默认和契约解释 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |
| `updated_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录更新时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE send_campaigns (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  status text DEFAULT 'running' NOT NULL,
  auto_send integer DEFAULT 1 NOT NULL,
  target_filter_json text DEFAULT '{}' NOT NULL,
  touch_plan_json text NOT NULL,
  created_by text DEFAULT 'agent' NOT NULL,
  account_policy text DEFAULT 'rotate' NOT NULL,
  account_ids_json text,
  schedule_json text,
  send_mode text DEFAULT 'individual' NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- `sqlite_autoindex_send_campaigns_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 id

### send_queue

本地待发队列（入队不等于发送）

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | TEXT | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `batch_id` | TEXT | 否 | — | 导入或发送批次ID；按本表所属链路解释 |
| `campaign_id` | TEXT | PRAGMA未设NOT NULL | — | 本地开发任务/发送活动ID |
| `company_name` | TEXT | PRAGMA未设NOT NULL | — | 发送队列公司名称快照 |
| `company_id` | INTEGER | PRAGMA未设NOT NULL | — | 本库公司主键；不能跨中心与个人SQLite按同号互认 |
| `recipients` | TEXT | 否 | — | 发送队列收件人结构化文本 |
| `account_id` | INTEGER | 否 | — | 个人SQLite邮箱账号ID |
| `account_email` | TEXT | PRAGMA未设NOT NULL | — | 发送时的账号邮箱快照 |
| `subject` | TEXT | PRAGMA未设NOT NULL | — | 邮件主题/模板主题 |
| `tpl_body` | TEXT | PRAGMA未设NOT NULL | — | 发送队列模板正文快照 |
| `contact_vars` | TEXT | PRAGMA未设NOT NULL | — | 发送队列联系人变量JSON |
| `cc` | TEXT | PRAGMA未设NOT NULL | — | 抄送地址文本 |
| `tpl_name` | TEXT | PRAGMA未设NOT NULL | — | 发送队列模板名称快照 |
| `country` | TEXT | PRAGMA未设NOT NULL | — | 国家 |
| `language` | TEXT | PRAGMA未设NOT NULL | — | 联系人/模板语言 |
| `send_mode` | TEXT | 否 | 'bcc' | 发送方式individual/bcc；按本表默认和契约解释 |
| `status` | TEXT | 否 | 'pending' | 本表状态；允许值/默认值和状态约束见下方DDL |
| `error` | TEXT | PRAGMA未设NOT NULL | — | 失败/同步错误说明 |
| `sent_at` | TEXT | PRAGMA未设NOT NULL | — | 邮件发送时间 |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |
| `error_kind` | TEXT | PRAGMA未设NOT NULL | — | 发送失败子类，blocked与smtp_fail不混同 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE send_queue (
  id text PRIMARY KEY NOT NULL,
  batch_id text NOT NULL,
  campaign_id text,
  company_name text, company_id integer,
  recipients text NOT NULL,
  account_id integer NOT NULL, account_email text,
  subject text, tpl_body text, contact_vars text,
  cc text, tpl_name text, country text, language text,
  send_mode text DEFAULT 'bcc' NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  error text, sent_at text,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
, error_kind text)
```

实际索引：

- `sqlite_autoindex_send_queue_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 id

### space_records

舱位台账只读查询镜像

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `record_id` | TEXT | 否; PK顺位1 | — | 运价台账来源记录ID；本地只做镜像 |
| `pol` | TEXT | PRAGMA未设NOT NULL | — | 起运港 |
| `pod_raw` | TEXT | PRAGMA未设NOT NULL | — | 来源目的港原文 |
| `lane` | TEXT | PRAGMA未设NOT NULL | — | 航线分类 |
| `carrier` | TEXT | PRAGMA未设NOT NULL | — | 船公司 |
| `container` | TEXT | PRAGMA未设NOT NULL | — | 镜像规范箱型 |
| `container_raw` | TEXT | PRAGMA未设NOT NULL | — | 来源箱型原文 |
| `box_qty` | TEXT | PRAGMA未设NOT NULL | — | 舱位箱量原文 |
| `space_type` | TEXT | PRAGMA未设NOT NULL | — | 舱位/容量类型 |
| `vessel` | TEXT | PRAGMA未设NOT NULL | — | 船名/航次信息 |
| `etd` | TEXT | PRAGMA未设NOT NULL | — | 预计开航日期/来源原文 |
| `cutoff_raw` | TEXT | PRAGMA未设NOT NULL | — | 截关日期原文 |
| `price_usd` | TEXT | PRAGMA未设NOT NULL | — | 舱位报价原文文本 |
| `note` | TEXT | PRAGMA未设NOT NULL | — | 中心跟进或运价/舱位备注 |
| `source_group` | TEXT | PRAGMA未设NOT NULL | — | 运价/舱位来源群 |
| `sender` | TEXT | PRAGMA未设NOT NULL | — | 来源消息发送人 |
| `msg_time` | TEXT | PRAGMA未设NOT NULL | — | 来源消息时间 |
| `image_name` | TEXT | PRAGMA未设NOT NULL | — | 来源图片文件名 |
| `status` | TEXT | PRAGMA未设NOT NULL | — | 本表状态；允许值/默认值和状态约束见下方DDL |
| `synced_at` | TEXT | 否 | CURRENT_TIMESTAMP | 运价/舱位镜像同步时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE space_records (
  record_id text PRIMARY KEY NOT NULL,
  pol text, pod_raw text,
  lane text, carrier text,
  container text, container_raw text, box_qty text,
  space_type text, vessel text, etd text, cutoff_raw text,
  price_usd text, note text,
  source_group text, sender text, msg_time text, image_name text, status text,
  synced_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- `idx_space_records_msg_time`：unique=0, origin=c, partial=0；`CREATE INDEX idx_space_records_msg_time ON space_records(msg_time)`
- `idx_space_records_pod_raw`：unique=0, origin=c, partial=0；`CREATE INDEX idx_space_records_pod_raw ON space_records(pod_raw)`
- `idx_space_records_lane`：unique=0, origin=c, partial=0；`CREATE INDEX idx_space_records_lane ON space_records(lane)`
- `sqlite_autoindex_space_records_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 record_id

### sqlite_sequence

SQLite内部自增序列表

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `name` | 未声明 | PRAGMA未设NOT NULL | — | 本表对象名称；迁移表为迁移名称 |
| `seq` | 未声明 | PRAGMA未设NOT NULL | — | SQLite AUTOINCREMENT内部计数 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE sqlite_sequence(name,seq)
```

实际索引：

- 无索引。

### templates

本地邮件模板

源码依据：`src/main/db/schema-sql.ts`、`src/main/db/index.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | 否; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `name` | TEXT | 否 | — | 本表对象名称；迁移表为迁移名称 |
| `language` | TEXT | 否 | — | 联系人/模板语言 |
| `subject` | TEXT | 否 | — | 邮件主题/模板主题 |
| `body` | TEXT | 否 | — | 邮件模板正文或搜索展示正文；不导出内容 |
| `category` | TEXT | PRAGMA未设NOT NULL | — | 邮件模板分类 |
| `stage` | TEXT | PRAGMA未设NOT NULL | — | 本表阶段；contacts为发送轮次/旧字段，客户关系/商机阶段见所属表约束 |
| `version` | INTEGER | 否 | 1 | 本表乐观并发版本；与联系人/任务等其他表版本独立 |
| `is_active` | INTEGER | 否 | 1 | 本地对象是否启用（整数布尔） |
| `created_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录创建时间 |
| `updated_at` | TEXT | 否 | CURRENT_TIMESTAMP | 记录更新时间 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE templates (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  name text NOT NULL, language text NOT NULL,
  subject text NOT NULL, body text NOT NULL,
  category text, stage text, version integer DEFAULT 1 NOT NULL,
  is_active integer DEFAULT 1 NOT NULL,
  created_at text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  updated_at text DEFAULT CURRENT_TIMESTAMP NOT NULL
)
```

实际索引：

- 无索引。

## 5. 账号离线SQLite crm-offline.db：每表、每列与真实约束

### crm_contact_details

账号隔离的中心完整联系人详情缓存；权限指纹读取，完整授权刷新剔除失权条目，拒绝旧版本覆盖

源码依据：`src/main/adapters/contact-mirror-store.adapter.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `contact_id` | INTEGER | 否; PK顺位1 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `customer_id` | TEXT | 否; PK顺位2 | — | 中心客户容器UUID |
| `permission_key` | TEXT | 否 | — | 当前账号权限指纹；不能当成访问令牌 |
| `snapshot` | TEXT | 否 | — | 中心完整CenterContactDetail序列化JSON；不保存离线基础空占位，详细key见第6节 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE crm_contact_details (
  contact_id INTEGER NOT NULL, customer_id TEXT NOT NULL, permission_key TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY(contact_id,customer_id)
)
```

实际索引：

- `sqlite_autoindex_crm_contact_details_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 contact_id,customer_id

### crm_contact_mail_events

中心邮件事实/本地待同步事件（两库不是同一实体表）

源码依据：`src/main/adapters/contact-mirror-store.adapter.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `event_key` | TEXT | PRAGMA未设NOT NULL; PK顺位1 | — | 事件幂等键；中心按actor_id联合唯一 |
| `payload` | TEXT | 否 | — | ContactMailEventInput序列化JSON；首次事件事实保留，确认/失败只改变同步状态 |
| `status` | TEXT | 否 | 'pending' | 本地同步状态pending/acknowledged/failed；不是发送成功状态 |
| `error` | TEXT | PRAGMA未设NOT NULL | — | 失败/同步错误说明 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE crm_contact_mail_events (
  event_key TEXT PRIMARY KEY, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT
)
```

实际索引：

- `crm_contact_mail_events_pending`：unique=0, origin=c, partial=0；`CREATE INDEX crm_contact_mail_events_pending ON crm_contact_mail_events(status)`
- `sqlite_autoindex_crm_contact_mail_events_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 event_key

### crm_contact_mail_links

本地邮件行与中心联系人关系，跨文件用明确ID映射

源码依据：`src/main/adapters/contact-mirror-store.adapter.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `message_key` | TEXT | 否; PK顺位1 | — | 本地/中心邮件匹配的稳定消息键 |
| `local_mail_id` | INTEGER | 否 | — | 个人SQLite收件箱行ID；本离线库无跨文件FK |
| `mail_account_id` | INTEGER | 否 | — | 个人SQLite邮箱账号ID；本离线库无跨文件FK |
| `mailbox` | TEXT | 否 | — | 本地邮件所在邮箱文件夹 |
| `contact_id` | INTEGER | 否; PK顺位2 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `customer_id` | TEXT | 否; PK顺位3 | — | 中心客户容器UUID |
| `role` | TEXT | 否; PK顺位4 | — | 邮件与中心联系人的关联角色primary/to/cc/bounce；源码src/main/core/contact-mirror.ts |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE crm_contact_mail_links (
  message_key TEXT NOT NULL, local_mail_id INTEGER NOT NULL, mail_account_id INTEGER NOT NULL,
  mailbox TEXT NOT NULL, contact_id INTEGER NOT NULL, customer_id TEXT NOT NULL, role TEXT NOT NULL,
  PRIMARY KEY(message_key,contact_id,customer_id,role)
)
```

实际索引：

- `crm_contact_mail_links_local`：unique=0, origin=c, partial=0；`CREATE INDEX crm_contact_mail_links_local ON crm_contact_mail_links(local_mail_id)`
- `sqlite_autoindex_crm_contact_mail_links_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 message_key,contact_id,customer_id,role

### crm_contact_mirror

已授权中心联系人快照，可重建投影

源码依据：`src/main/adapters/contact-mirror-store.adapter.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `contact_id` | INTEGER | PRAGMA未设NOT NULL; PK顺位1 | — | 关联联系人主键；PG/离线镜像为中心ID，个人SQLite为历史本地ID |
| `customer_id` | TEXT | 否 | — | 中心客户容器UUID |
| `email_normalized` | TEXT | PRAGMA未设NOT NULL | — | 镜像联系人的小写去空格邮箱匹配键 |
| `snapshot` | TEXT | 否 | — | 完整CenterContact序列化JSON；详细业务key见第6节 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE crm_contact_mirror (
  contact_id INTEGER PRIMARY KEY, customer_id TEXT NOT NULL, email_normalized TEXT,
  snapshot TEXT NOT NULL
)
```

实际索引：

- `crm_contact_mirror_customer`：unique=0, origin=c, partial=0；`CREATE INDEX crm_contact_mirror_customer ON crm_contact_mirror(customer_id,contact_id)`
- `crm_contact_mirror_email`：unique=0, origin=c, partial=0；`CREATE INDEX crm_contact_mirror_email ON crm_contact_mirror(email_normalized)`

### crm_contact_mirror_meta

完整快照权限/格式标记，单例id=1

源码依据：`src/main/adapters/contact-mirror-store.adapter.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `id` | INTEGER | PRAGMA未设NOT NULL; PK顺位1 | — | 本表记录主键；只在本数据库/表的命名空间内有效 |
| `permission_key` | TEXT | 否 | — | 当前账号权限指纹；不能当成访问令牌 |
| `format_version` | INTEGER | 否 | — | 完整联系人镜像格式版本 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE crm_contact_mirror_meta (
  id INTEGER PRIMARY KEY CHECK(id=1), permission_key TEXT NOT NULL, format_version INTEGER NOT NULL
)
```

实际索引：

- 无索引。

### crm_offline_state

账号隔离离线CRM完整JSON工作集与兼容Outbox

源码依据：`src/main/adapters/offline-crm-store.adapter.ts`

| 字段 | 实际类型 | 允许NULL | 默认值/自增 | 中文用途 |
|---|---|---|---|---|
| `key` | TEXT | PRAGMA未设NOT NULL; PK顺位1 | — | 固定状态键crm |
| `value` | TEXT | 否 | — | OfflineCrmState序列化JSON；详细业务key见第6节 |

实际CREATE SQL（包含PK/UNIQUE/CHECK/FK；不把程序关联冒充数据库FK）：
```sql
CREATE TABLE crm_offline_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)
```

实际索引：

- `sqlite_autoindex_crm_offline_state_1`：unique=1, origin=pk, partial=0；SQLite自动索引；列 key

## 6. JSON字段的业务key与来源

下列为源码类型定义/实际读写定义的key，不是从用户JSON内容取样。不声明额外任意key一定存在。动态Record的键由业务ID、查询条件或幂等键决定。

### crm_contact_mirror.snapshot → CenterContact

来源：`server/core/center-contacts.ts`。

| key | 类型/形态 | 中文用途 |
|---|---|---|
| contactId/customerId/companyId | number/string/number | 中心联系人/客户/公司明确ID |
| customerVersion/contactVersion? | number | 客户/联系人分别独立的并发版本 |
| canEdit?/canAssign?/canFollowup? | boolean | 当前授权派生操作能力 |
| relationshipStage? | CustomerStage | 客户关系阶段 |
| lastFollowupAt?/lastFollowupNote? | string\|null | 最近真实联系时间/内容；备注与商机活动不算联系 |
| companyName | string | 公司名称 |
| email/firstName/lastName/title/phone/linkedinUrl/country/clientType/language | string\|null | 对应联系人基础字段 |
| stage/status | string | 发送旧阶段及状态 |
| tags | string[] | 标签数组 |
| extra | JsonObject | 联系人扩展对象；未知key不臆造 |
| touchStatus | ContactTouchStatus | 中心触达状态 |
| assignee/source/sourceDetail/createdAt/updatedAt | string或null | 对应原主档字段 |
| ownerUserId/ownerName | string\|null | 当前有效负责人及名称 |
| origin | operations\|personal | 来源身份类别 |
| state | LeadState | 客户容器状态 |
| assignmentStatus? | pending\|accepted\|null | 最新分配请求状态，不能只凭负责人推断接受 |

### crm_contact_details.snapshot → CenterContactDetail

来源：`server/core/contact-assignments.ts`。

| key | 类型/形态 | 中文用途 |
|---|---|---|
| contact | CenterContact | 完整中心联系人；key见上表 |
| company | {companyId,name,domain,backcheckData} | 中心公司ID、名称、域名、背调对象或null |
| activities | LeadActivity[] | 该中心联系人有权限查看的活动；key见LeadDetail表 |
| canEdit/canFollowup/canAssign | boolean | 当前权限派生操作能力 |
| mailAvailable | boolean | 邮件补充可用状态 |
| mailEvents | ContactMailEvent[] | 中心邮件事件：ContactMailEventInput所有key，另加eventId/actorId/recordedAt/activityId |
| mailEventLimit | number | 本次中心返回的邮件历史上限 |
| supplementAvailable? | boolean | false仅表示离线基础响应的补充未下载；中心完整缓存通常没有这个key。此表不保存本地空占位 |

### crm_offline_state.value → OfflineCrmState

来源：`src/main/core/offline-crm.ts`。

| key | 类型/形态 | 中文用途 |
|---|---|---|
| permissionKey | string | 工作集权限指纹 |
| bootstrap? | LeadBootstrap | 账号/能力/范围/汇总/通知游标快照 |
| customers | Record<string,LeadDetail> | 按客户UUID/临时ID保存完整客户快照 |
| views | Partial<Record<LeadQuery.view,string[]>> | 查询视图关联的客户ID列表 |
| cache | Record<string,unknown> | 兼容接口查询回执；动态key及值没有统一额外schema |
| outbox | OfflineOperation[] | 待同步本地写操作，不是SMTP发信队列 |
| receipts | Record<string,{digest,response}> | 本地幂等摘要及回执 |
| aliases | Record<string,string> | 临时客户ID到中心客户ID的映射 |
| contacts | Record<string,number> | 本地临时联系人到中心整数ID的映射 |
| versions | Record<string,number> | 中心同步版本记录 |
| nextContactId | number | 离线临时联系人ID计数，起点1_000_000_000_000 |
| lastSyncedAt?/lastAttemptAt?/lastError? | string | 最近同步成功/尝试时间及错误 |

### OfflineCrmState.outbox[] → OfflineOperation

来源：`src/main/core/offline-crm.ts`。

| key | 类型/形态 | 中文用途 |
|---|---|---|
| id | string | 操作幂等ID |
| method/path/body | string/string/Record | HTTP方法、目标路径和请求体 |
| entities | string[] | 该操作涉及的实体ID |
| dependency? | string | 需先同步的前序操作 |
| status | pending\|failed\|conflict | 操作同步状态 |
| message? | string | 错误/冲突说明 |
| response | unknown | 本地返回或同步回执 |
| wire? | {path,body} | 完成ID映射后的实际重放请求 |
| central? | LeadDetail | 冲突时中心快照 |
| replayOnly? | boolean | 只重放标志 |

### OfflineCrmState.customers[] → LeadDetail及内嵌对象

来源：`server/core/leads.ts`。

| key | 类型/形态 | 中文用途 |
|---|---|---|
| customerId/companyName/country/state/version/contactCount | 标量 | 客户ID、公司名称、国家、状态、版本、联系人数量 |
| origin?/stage?/ownerUserId?/source?/primaryContactName?/primaryContactEmail?/ownerName?/recentActivityAt?/hasContacted? | 标量 | 来源、关系阶段、负责人、主联系摘要、最近活动/触达派生结果 |
| source/sourceDetail/customerKey/ownerUserId | string或null | 来源、原始客户键与负责人 |
| businessType?/developmentRestriction?/sourceCreatedAt? | string | 客户业务/开发限制/源日期 |
| contacts[] | LeadContact | contactId,email,name,country,phone?,title?,touchStatus? |
| activities[] | LeadActivity | id,actorId,note,stage,createdAt；可选opportunityId/opportunityTitle/actorName/method/occurredAt/recordedAt/contactId/contactName/contactStatus |
| canEdit?/canFollowup?/canAssign?/stageNeedsReview? | boolean | 授权派生能力及历史阶段待复核 |
| bootstrap.userId/capabilities/scope/summary/feedCursor | 标量/数组/对象 | 账号、能力、范围、summary.pool/mine、通知流游标 |

### crm_contact_mail_events.payload → ContactMailEventInput

来源：`server/core/contact-mail.ts`。

| key | 类型/形态 | 中文用途 |
|---|---|---|
| contactId/customerId | number/string | 中心联系人及客户复合身份 |
| eventKey/mailboxKey/messageKey | string | 事件幂等/邮箱身份/消息稳定键 |
| kind | received\|sent\|replied\|autoreply\|bounced\|cc | 邮件事实类别 |
| direction | inbound\|outbound | 收发方向 |
| occurredAt | string | 实际发生时间 |
| subject/preview/fromEmail | string | 邮件元数据；不包含正文/附件/凭据 |
| toEmails/ccEmails | string[] | 收件人和抄送地址数组 |

### 其他明确JSON结构

来源：`server/adapters/postgres/*-schema.ts 与各业务core`。

| key | 类型/形态 | 中文用途 |
|---|---|---|
| contacts.tags | string[]（PG）/text（SQLite） | PG数组；本地旧分类文本不可按PG等同解析 |
| contacts.extra | object | 开放扩展JSON；未列出的key用途未知 |
| crm_customers.legacy_stage_snapshot[] | {contactId,stage} | 迁移原始联系人阶段证据 |
| companies.backcheck_data | object或null（PG）/text（SQLite） | 背调报告，业务key由背调服务决定，未枚举固定字段 |
| crm_import_batches.mapping | object | 原始列名到业务字段的映射 |
| crm_import_rows.raw_row | object | 原始导入行，字段由原文件决定 |
| identity.product_access.capabilities | string[]或null | 产品能力集合 |
| identity.outbox.payload | object | 事件类型专属投影，不等于统一邮件内容 |
| crm_lead_idempotency.response | JSON | operation对应完整Result回执 |
| interactions.metadata | object（PG）/text（SQLite） | 事件类型专属扩展，未约束全部key |
| send_campaigns.target_filter_json/touch_plan_json/account_ids_json/schedule_json | 序列化JSON | 筛选/触达计划/账号ID列表/发送计划；未在该字段DDL上约束key |
| send_queue.recipients/contact_vars | 序列化JSON | 收件人/联系人模板变量；具体值不导出 |
| agent_tool_calls.args_json/result_json | 序列化JSON | 每个工具自己的契约；没有统一任意key说明 |
| agent_working_memory.payload_json | 序列化JSON | 工作记忆类型专属负载 |

### 源码明确的历史本地扩展JSON

来源：`src/main/services/crm.service.ts、src/main/services/contact.service.ts、src/main/db/schema/send-campaign.ts`。

| key | 类型/形态 | 中文用途 |
|---|---|---|
| contacts.extra.stageChangedAt | string时间 | 历史本地阶段变更时间 |
| contacts.extra.crmReminder.nextFollowupAt | string时间 | 历史本地下一次跟进提醒时间 |
| contacts.extra.note | string | 历史本地联系人备注 |
| send_campaigns.touch_plan_json[] | {round,stage,templateId?,mode?,content?,delayDays} | 触点轮次、发送阶段、模板、模式fixed/userTpl/adaptive/system、内容、间隔日数 |
| send_campaigns.account_ids_json[] | number | 固定账号策略的本地邮箱账号ID |
| send_campaigns.schedule_json | {windowStartHour,windowEndHour,dailyGroupCap} | 每日发送时窗与分组上限；为空继承全局设置 |

### N4 确认发信回执 JSON

| 位置 | 结构 | 说明 |
|---|---|---|
| crm_send_receipts.payload | {receipt,accountEmail} | receipt包含id、accountId、subject、body、messageId、occurredAt、advanceSendStage、companyName、centerScope、可选cc/campaignId及recipients；正文只在本地 |
| receipt.recipients[] | {contactId,email,name,centerReference:{contactId,customerId}} | 仅实际被SMTP接受的收件人；中心引用不作旧本地FK |
| send_campaign_targets.center_reference_json | {reference:{contactId,customerId},scope:string} | scope是JSON.stringify([baseUrl,userId])；NULL为历史本地目标 |
| send_queue.recipients | SendItem.recipients[] | 中心项显式携带centerReference，旧项无该字段 |
| send_queue.contact_vars.__centerScope | string | 作用域保存在原JSON，不增加另一张队列表 |
| crm_contact_mail_events.payload.advanceSendStage? | boolean | 仅confirmed sent/outbound，普通Sent扫描不推进；首次事实摘要保留 |

## 7. 迁移清单与历史边界

| 中心版本 | 源文件 | 实际应用 | 源SHA256对应 |
|---|---|---|---|
| 001-crm-foundation | server/adapters/postgres/schema.ts | 是 | 匹配 |
| 002-identity-foundation | server/adapters/postgres/auth-schema.ts | 是 | 匹配 |
| 003-management-m1 | server/adapters/postgres/admin-schema.ts | 是 | 匹配 |
| 004-mandatory-password-change | server/adapters/postgres/password-schema.ts | 是 | 匹配 |
| 005-lead-collaboration | server/adapters/postgres/lead-schema.ts | 是 | 匹配 |
| 006-notification-m2 | server/adapters/postgres/notification-schema.ts | 是 | 匹配 |
| 007-desktop-session-rotation | server/adapters/postgres/desktop-session-schema.ts | 是 | 匹配 |
| 008-center-customers | server/adapters/postgres/customer-schema.ts | 是 | 匹配 |
| 009-directed-assignment | server/adapters/postgres/assignment-schema.ts | 是 | 匹配 |
| 011-customer-workbook-profile | server/adapters/postgres/customer-profile-schema.ts | 是 | 匹配 |
| 012-customer-followup | server/adapters/postgres/followup-schema.ts | 是 | 匹配 |
| 015-user-lifecycle | server/adapters/postgres/user-lifecycle-schema.ts | 是 | 匹配 |
| 017-followup-tasks | server/adapters/postgres/task-schema.ts | 是 | 匹配 |
| 018-opportunities | server/adapters/postgres/opportunity-schema.ts | 是 | 匹配 |
| 019-contact-assignment-acceptance | server/adapters/postgres/contact-assignment-schema.ts | 是 | 匹配 |
| 020-contact-mail-events | server/adapters/postgres/contact-mail-schema.ts | 是 | 匹配 |
| 021-contact-mail-send-stage | server/adapters/postgres/contact-mail-schema.ts | 是 | 匹配 |

实际个人SQLite命名迁移：

- `v0.39-center-send-receipts`
- `v0.39-center-send-target-reference`
- `v0.9-search-fts5`
- `v4.0-contacts-drop-legacy-cols`
- `v4.0-contacts-language`
- `v4.0-tags-converge`
- `v4.1-inbox-backfill`
- `v4.1-templates-stage`
- `v4.2-send-queue-cols`
- `v4.3-inbox-cols`
- `v4.x-accounts-fetch-health`
- `v4.x-country-normalize`
- `v4.x-stage-normalize`
- `v5.0.3-agent-archived-at`
- `v5.0.3-inbox-intent`
- `v5.1-bounce-matches-seed`
- `v5.7-accounts-circuit-reason`
- `v5.8-send-campaigns-cols`
- `v5.9-send-queue-campaign-id`
- `v5.x-dedup-interactions-events`
- `v5.x-rate-quotes-cols`
- `v5.x-send-queue-error-kind`
- `v6.1-send-mode`

`src/main/db/migrations/0000_curly_boomer.sql` 与 meta 快照属于旧Drizzle历史产物，现运行入口使用schema-sql.ts + runMigrations，不以历史SQL替代实际新建结果。旧SQLite资料、旧发送/Agent调用仍独立存在；新增中心联系人详情、回执和邮件关联并不构成历史资料自动导入。

中心正式联系人复合标识是{customerId,contactId}；crm_customer_contacts.contact_id为PK，customer_id未唯一，所以一个客户可有多联系人，一个公司可有多个客户容器。分配/邮件复合FK保证真实客户-联系人组合；本地跨文件mail_account_id/local_mail_id没有数据库FK，程序需校验账号/邮箱身份。通知消费、投递、用户已读、分配接受、邮件同步acknowledged和实际SMTP发送成功分别独立，不能互相当完成凭据。

知识库：本子任务仅输出结构字典与证据，由主任务在完整节点验收时统一同步项目状态与审阅；未在子任务重复写库。
