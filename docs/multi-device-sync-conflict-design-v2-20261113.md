# Prospector 多设备同步与冲突处理修正方案

状态：设计稿 v2，已审计，暂缓实施  
日期：2026-11-13  
取代：[初版设计](<D:/Agent Basement/Milogin-s-prospector/docs/multi-device-sync-conflict-design-20261113.md>)  
适用：Prospector 桌面端、中心 PostgreSQL、Navigator 更新服务

> 当前决定（2026-11-13）：Prospector 大概率只在公司内部单一电脑运行，本方案留作后续在线化和多设备实施基线，当前不排期。触发第二台长期设备、邮箱配置跨设备共享、在线多设备灰度或改造单活跃设备登录时，再按本文实施门槛重新评审。

## 1. 结论与核心决定

初版方向可行，但不能直接实施。本修正版把范围收敛为以下决定：

1. 第一版对客户、联系人、任务、商机等普通业务实体采用严格实体版本冲突，不做不同字段自动合并。
2. 多设备登录只能在“拉取、待提交队列、冲突处理和字段镜像”完成并通过灰度后开放，不能先开放再补同步。
3. 中心领域事件是事实，用户同步流只是按可见范围生成的项目。一次业务写入必须在同一 PostgreSQL 事务中完成业务表、identity_outbox、用户项目、幂等回执和必要通知。
4. 设备身份由中心会话推导，客户端提交的 deviceId 不作为信任来源。
5. 普通共享事实通过同步命令写入；发件、领取分配、启动自动任务等有外部副作用的动作继续使用专用接口。
6. 发件采用“意图 + 租约 + fencing token + started/unknown 状态”，任何已开始的发送都不能由另一设备自动重发。
7. 旧客户端的单活跃设备语义必须继续可用，直到最低兼容客户端版本覆盖完成。
8. 所有 API/IPC 使用 { ok, data?, error? }，契约先定义，再做服务和适配器。

### 1.1 目标

- 同账号多台电脑可同时在线，各自拥有独立会话和 refresh family。
- 每台电脑离线修改可持久保存，恢复连接后幂等上传。
- 设备按用户游标拉取变化，未应用游标不会越过未提交页面。
- 同一实体的并发修改不会静默覆盖。
- 删除和撤权不会因旧设备重放而复活数据或恢复访问。
- 发件、分配和自动开发任务只有唯一执行权。
- 邮箱凭据仍只保存在设备安全存储，不进入中心。
- 用户可查看、识别和单独退出设备。

### 1.2 非目标

- 不做字符级 CRDT 或实时共同编辑。
- 不把邮件正文、附件、SMTP/IMAP 授权码上传中心。
- 不让通用同步服务承载领域判断。领域权限、版本和业务锁仍由对应领域服务执行。
- 不在第一版支持发送结果未知后的自动重发。
- 不把本地设备专属状态伪装成跨设备共享状态。

## 2. 数据范围与冲突策略

| 数据 | 中心真源 | 第一版离线 | 写入口 | 冲突规则 |
|---|---|---|---|---|
| 联系人字段 | PostgreSQL | 是 | update_contact | 严格联系人版本 |
| 公司字段 | PostgreSQL | 是 | update_company | 严格客户/公司版本 |
| 跟进记录 | PostgreSQL | 是 | append_followup | 追加事实，不覆盖历史 |
| 客户阶段 | PostgreSQL | 是 | 专用同步命令 | 严格版本 |
| 负责人/分配 | PostgreSQL | 否 | 专用分配接口 | 业务锁和状态检查 |
| 任务状态 | PostgreSQL | 是 | update_task | 严格任务版本 |
| 商机状态 | PostgreSQL | 是 | update_opportunity | 严格商机版本 |
| 标签增删 | PostgreSQL | 是 | add/remove_set_member | 集合并差，禁止 toggle |
| 已读/置顶/待办完成 | 待定 | 第一版允许设备本地 | 专用集合命令 | 幂等设置 true/false |
| 邮箱账号元数据 | PostgreSQL | 是 | update_mailbox | 严格版本 |
| SMTP/IMAP 凭据 | 否 | 是 | 设备本地 | 不跨设备同步 |
| 邮件正文/附件 | 否 | 是 | IMAP 本机缓存 | mailbox + providerMessageId 去重 |
| 自动开发任务 | PostgreSQL | 否 | 专用任务接口 | 严格版本和租约 |
| 发件执行 | 中心意图 + 设备执行 | 否 | 专用发件状态机 | 租约、fencing token、started/unknown |
| AI 会话和运行任务 | 设备本地 | 是 | 设备本地 | 不跨设备 |

### 2.1 字段级合并延后

初版同时要求 baseVersion 严格检查和不同字段自动合并，这两个条件无法依靠单一实体版本同时成立。第一版必须选择安全且简单的规则：

- A 和 B 都基于版本 12 修改同一联系人。
- B 先提交后中心版本变为 13。
- A 后提交 baseVersion=12，中心返回 CONFLICT。
- UI 刷新版本 13，展示 A、B 改动差异；用户确认后才生成新的 mutation。

不得因为 A、B 改了不同字段而自动放行。字段级合并以后只有在增加字段版本或服务端三方基线比较后才允许。

### 2.2 联系人、公司是多表聚合但不是通用实体

联系人和公司可能同时出现在一个详情页，但版本来源不同。实现不得假设一个通用数字就能代表所有表：

- 联系人的 entityType 是 crm.contact，版本来自 contacts.crm_contact_version。
- 公司的 entityType 是 crm.company，版本来自公司归属客户的版本。
- 同一 UI 操作若同时改联系人和公司字段，编排层拆成同一事务内的两条领域命令，或由明确的聚合契约返回两个版本；禁止用一条 SQL 静默覆盖两边。

## 3. 分层与组件

### 3.1 中心端

| 层 | 新增或调整 | 职责 |
|---|---|---|
| server/core/sync.ts | 常量、类型、实体键、游标和错误码 | 零 IO 契约 |
| server/core/entity-versions.ts | 各领域版本来源和命令类型 | 零 IO 规则 |
| server/services/sync.ts | mutation 编排、回执验证、拉取参数 | 业务编排，不碰数据库 |
| server/adapters/postgres/sync-schema.ts | 迁移 DDL | 表、索引、约束 |
| server/adapters/postgres/sync-repository.ts | sync_heads、sync_changes、回执和快照 | PostgreSQL IO |
| server/transport/sync-http.ts | /api/sync/* | 只做 HTTP 参数转接 |
| 领域服务/仓储 | 联系人、任务、商机、邮箱等 | 执行版本检查和领域写入 |

同步服务只负责协议和事务编排，不把领域权限复制进通用路由。领域仓储必须在同一事务中返回领域结果和要写入的 identity_outbox 参数。

### 3.2 桌面端

| 层 | 新增或调整 | 职责 |
|---|---|---|
| src/shared/sync.ts | 前后共享类型 | API/IPC 返回结构 |
| src/main/contract.ts | ONLINE_CHANNELS.SYNC_* | IPC 通道常量 |
| src/main/core/sync.ts | 游标应用、状态机和冲突规则 | 纯函数，零 IO |
| src/main/services/sync.service.ts | 拉取、推送、冲突和快照编排 | 不直接碰 SQLite/fetch |
| src/main/adapters/sync-sqlite.adapter.ts | 本地表和事务 | SQLite IO |
| src/main/adapters/sync-center.adapter.ts | /api/sync/* 客户端 | HTTP IO |
| src/main/transport/sync.ipc.ts | 同步通道 | IPC 路由 |

## 4. 多设备身份与会话

### 4.1 设备与账号分开建模

device_id 表示一台安装设备，不应决定它只能属于一个中心账号。同一台电脑切换账号是现有能力，必须保留。

    identity_device_installations (
      device_id text PRIMARY KEY,
      platform text NOT NULL,
      first_seen_at timestamptz NOT NULL DEFAULT now()
    );

    identity_device_accounts (
      user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
      device_id text NOT NULL REFERENCES identity_device_installations(device_id),
      device_name text NOT NULL,
      app_version text,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      PRIMARY KEY (user_id, device_id)
    );

identity_sessions.desktop_device_id 继续保留兼容列。迁移时先补安装设备记录，再加外键；不要直接假定所有旧会话都已有设备记录。

### 4.2 登录兼容

中心按客户端能力协商会话模式：

- 旧客户端不发送多设备能力：继续返回 DEVICE_REPLACEMENT_REQUIRED，继续使用 handoff。
- 新客户端发送 desktop.capabilities: ['multi-device-v1', 'sync-v1']：允许按设备创建独立会话。
- 服务端开关 MULTI_DEVICE_ENABLED 未开启时，新客户端也只能使用单设备 handoff。
- 开关开启前必须核对最低客户端版本和已安装客户端比例，避免同步前出现两台旧设备。
- 同一用户、产品、设备重复登录时，只撤销该组合的旧会话和 refresh family，不影响其他设备。

目标唯一索引：

    (user_id, desktop_product, desktop_device_id)
    WHERE desktop_product IS NOT NULL AND revoked_at IS NULL

旧索引 idx_identity_sessions_active_desktop_product 在兼容窗口内保留语义。只有旧登录分支下线后才删除，不能仅因为新索引存在就提前删除。

### 4.3 设备管理

- GET /api/account/devices：当前账号的设备和最后活跃时间。
- POST /api/account/devices/:deviceId/revoke：撤销当前账号在该设备上的全部会话。
- POST /api/account/devices/revoke-others：撤销除当前设备外的设备。
- 撤销事务同时写 identity_device_accounts.revoked_at、撤销活动 session、吊销 refresh family 和写审计。
- 管理员可看设备元数据，不可看 Token、邮件凭据或邮件正文。
- 新增审计事件必须同步扩展 identity_audit_event_check，否则事务会因 CHECK 失败整体回滚。

## 5. 中心事件与用户同步项目

### 5.1 只保留一条领域事实链

identity_outbox 继续作为唯一的领域事件来源。sync_changes 是按用户生成的同步项目，不是第二份业务真源。

    领域事务
      -> 业务表
      -> identity_outbox(event_type, revision, customer_id, payload, recipient_user_ids)
      -> 用户同步项目 sync_changes(user_id, seq, entity_type, entity_key, operation, version)
      -> 通知项目 / 联系人变化项目 / 同步拉取

一次事务内完成全部写入。任何 outbox 或同步项目写入失败时，业务写入整体回滚。

### 5.2 收件人规则

领域仓储负责提供 recipient_user_ids，通用同步层只做去重、排序和锁同步头。

- 联系人更新：本人、负责人、有效共享对象、团队可见对象和相关管理员。
- 分配接收：请求者、原负责人、新负责人、明确通知人和相关主管。
- 共享接受：共享目标、授权人、联系人负责人。
- 共享撤销：同一组人，并产生 invalidate。
- 角色、能力、团队范围大变化：递增用户 scope_epoch，客户端按新范围做完整快照；不为每个联系人强行生成大量墓碑。
- 用户停用、密码变化、设备撤销：会话失效，设备停止同步和发信；重新登录前不得继续使用旧授权。

所有接收人按 UUID 升序锁定 sync_heads，避免多个共享写入以不同顺序锁住相同用户而产生死锁。一个事务涉及多个领域实体时，也必须按 entity_type + entity_key 的固定顺序加锁。

### 5.3 新授权和撤权

- 单联系人共享或分配：在该业务事务中向新可见用户写一个 upsert 基线，不能等下一次普通联系人修改。
- 单联系人撤权：写 invalidate，客户端删除镜像和派生摘要。
- 团队/角色范围大变化：更新 scope_epoch，客户端下一次拉取得到 resyncRequired。
- 重新授权：通过新共享/分配事件或完整快照恢复同一联系人，不创建复制客户。
## 6. 中心同步表

### 6.1 同步头

每个用户一条同步头。头行锁同时承担顺序、保留水位和权限范围版本。

    CREATE TABLE public.sync_heads (
      user_id uuid PRIMARY KEY REFERENCES public.identity_users(user_id),
      last_seq bigint NOT NULL DEFAULT 0 CHECK(last_seq >= 0),
      trimmed_through_seq bigint NOT NULL DEFAULT 0 CHECK(trimmed_through_seq >= 0),
      scope_epoch bigint NOT NULL DEFAULT 1 CHECK(scope_epoch > 0),
      force_resync boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      CHECK(trimmed_through_seq <= last_seq)
    );

规则：

- 用户创建时初始化同步头；迁移时为所有有效用户补行。
- 事务内按 user_id 排序锁定。
- 递增使用 last_seq = last_seq + 1，不使用裸 PostgreSQL sequence 作为客户端游标。
- trimmed_through_seq 表示该用户最早的可用增量位置。

### 6.2 用户变化流

    CREATE TABLE public.sync_changes (
      user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
      seq bigint NOT NULL CHECK(seq > 0),
      event_id uuid NOT NULL REFERENCES public.identity_outbox(event_id),
      entity_type text NOT NULL,
      entity_key text NOT NULL,
      operation text NOT NULL CHECK(operation IN ('upsert','tombstone','invalidate')),
      entity_version bigint,
      event_type text NOT NULL,
      access_epoch bigint NOT NULL DEFAULT 1,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(payload)='object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(user_id,seq),
      UNIQUE(user_id,event_id,entity_type,entity_key,operation)
    );

    CREATE INDEX idx_sync_changes_entity
      ON public.sync_changes(user_id,entity_type,entity_key,seq);

entity_key 使用领域常量生成，不能由前端自由拼接：

- crm.contact：customer UUID + contact integer
- crm.company：customer UUID
- crm.task：task UUID
- crm.opportunity：opportunity UUID
- mailbox.config：中心 mailbox UUID

联系人等大实体不在 payload 中放正文或敏感字段，只放实体引用、版本和变更摘要。拉取时由受权快照读取当前实体。

### 6.3 mutation 回执

    CREATE TABLE public.sync_mutation_receipts (
      user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
      mutation_id uuid NOT NULL,
      device_id text NOT NULL,
      request_digest text NOT NULL CHECK(request_digest ~ '^[a-f0-9]{64}$'),
      result_state text NOT NULL CHECK(result_state IN ('applied','conflict','rejected')),
      result jsonb NOT NULL,
      committed_version bigint,
      committed_seq bigint,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(user_id,mutation_id)
    );

重复 mutation 处理：

- 相同 mutationId 和相同 request_digest：返回原回执，不重复执行。
- 相同 mutationId 但 request_digest 不同：返回 CONFLICT，不执行。
- 相同 mutationId 但设备不在当前会话：返回 FORBIDDEN。
- 只有中心事务提交后的回执才可被设备认作完成。
- 回执保留时间不得短于可重试 outbox 生命周期；清理按配置执行。

### 6.4 中心写入事务

任何 mutation 执行顺序固定为：

1. 验证 access token、会话、设备关联、产品准入和 scope_epoch。
2. 按 user_id + mutationId 查回执并校验 digest。
3. 调用领域仓储验证权限、版本和业务锁。
4. 领域仓储写业务表并返回 identity_outbox 参数。
5. 插入 identity_outbox，生成同步项目并锁所有 recipient 的 sync_heads。
6. 写 mutation 回执、必要通知项目和审计。
7. COMMIT。
8. COMMIT 后返回回执。

领域失败必须在事务内回滚。超时、断网、连接重置不能生成成功回执。
## 7. Mutation 契约

### 7.1 请求

    POST /api/sync/mutations
    Authorization: Bearer <access-token>
    Content-Type: application/json

    {
      "protocolVersion": 1,
      "mutationId": "018f-example-uuid",
      "scopeEpoch": 7,
      "entityType": "crm.contact",
      "entityKey": "crm.contact:<customer-uuid>:123",
      "baseVersion": 12,
      "clientOccurredAt": "2026-11-13T09:40:00.000+08:00",
      "command": {
        "type": "update_contact",
        "fields": {
          "country": "Mexico"
        }
      }
    }

deviceId 不在请求体中作为授权依据。中心从当前 session 取得设备；请求体若携带也必须与服务端一致。

### 7.2 处理规则

- protocolVersion 不匹配返回 INVALID_INPUT。
- scopeEpoch 与中心不一致返回 RESYNC_REQUIRED。
- 普通更新先 SELECT FOR UPDATE，校验版本后 UPDATE。
- 返回版本必须是更新后的实体版本。
- 创建命令使用 baseVersion=0，只允许领域创建接口。
- 跟进使用 append_followup，不覆盖旧内容；相同 mutationId 或相同 event key 返回原结果。
- 集合操作使用 add/remove，不接受 toggle。
- 分配、发件、启动自动任务不进入通用 mutation，走专用接口和领域锁。

### 7.3 结果

成功：

    {
      "ok": true,
      "data": {
        "state": "applied",
        "mutationId": "018f-example-uuid",
        "entityVersion": 13,
        "committedSeq": "841",
        "duplicate": false
      }
    }

确定性冲突也进入回执：

    {
      "ok": false,
      "error": {
        "code": "CONFLICT",
        "message": "联系人已在其他设备修改",
        "data": {
          "mutationId": "018f-example-uuid",
          "remoteVersion": 13,
          "remote": {}
        }
      }
    }

CONFLICT、FORBIDDEN、INVALID_INPUT 不自动重试；UNAVAILABLE、DATABASE_ERROR 才按指数退避重试。
## 8. 拉取、快照和游标

### 8.1 拉取头

    GET /api/sync/head

返回：

    {
      "ok": true,
      "data": {
        "headCursor": "841",
        "minAvailableCursor": "420",
        "scopeEpoch": 7,
        "forceResync": false
      }
    }

### 8.2 增量页

    GET /api/sync/changes?after=420&limit=100

- 只返回当前用户可见范围内的项目。
- 按 seq 严格升序。
- 快照内容在响应时再次做权限校验。
- 因权限变化不可读取时返回 invalidate 或 tombstone，不返回敏感 payload。
- hasMore=true 时客户端继续拉取，不能提前推进游标。

### 8.3 应用规则

客户端必须在一个 SQLite 事务中完成：

1. 校验响应的 baseCursor 等于本地 pullCursor。
2. 应用所有 upsert、tombstone、invalidate。
3. 更新实体版本和冲突/待处理状态。
4. 保存 nextCursor。
5. COMMIT。

任何一条应用失败都回滚整页。禁止先保存游标再写镜像，也禁止边拉取边跳过失败行。

远端 upsert 只更新“中心已确认”镜像，不能覆盖本地 pending 草稿。镜像版本变新但本地仍存在旧版本命令时，该命令保留原文并进入冲突处理，不得自动改写 baseVersion 后发送。

### 8.4 全量重建

以下任一条件触发受控 resync：

- 本地游标损坏。
- scopeEpoch 不一致。
- after 小于 minAvailableCursor。
- 中心返回 resyncRequired。
- 本地镜像格式升级。
- 设备重新关联到同一账号但本地基线不明。

流程：

1. 读取 headCursor 和 scopeEpoch。
2. 按 entity_type + entity_key 的稳定顺序分页读取受权快照。
3. 将快照写入本地 staging。
4. 从 headCursor 之后增量回放。
5. 全部成功后原子切换 staging 为可读镜像，保存 headCursor 和 scopeEpoch。
6. 失败时保留旧可读镜像并标记同步不可用，不用半份快照覆盖旧数据。

固定高水位之后的所有变更都必须能由增量流覆盖。快照读取不要求长时间持有数据库事务，但必须使用稳定 keyset 分页和幂等回放。

全量快照不得删除 sync_outbox。快照完成后，本地 pending/sending 命令必须按最新实体版本重新判断：可安全重提的只允许用户确认后重提，其余进入冲突；结果未知的命令仍先用原 mutationId 查询回执。

### 8.5 保留和清理

- sync_changes 只保留配置时间内的增量，例如 sync_change_retention_seconds=30 days。
- 清理事务先提高 sync_heads.trimmed_through_seq，再删除更早记录。
- 客户端 after 小于 minAvailableCursor 时只允许全量重建，不能从当前状态猜缺口。
- 领域表、审计和墓碑不因增量清理而删除。
## 9. 冲突、删除和权限变化

### 9.1 冲突记录

本地冲突不能只写日志：

    sync_conflicts (
      conflict_id text PRIMARY KEY,
      mutation_id text NOT NULL,
      entity_type text NOT NULL,
      entity_key text NOT NULL,
      local_json text NOT NULL,
      remote_json text,
      reason text NOT NULL,
      remote_version integer,
      created_at text NOT NULL,
      resolved_at text,
      resolution text
    );

- 冲突保存完整本地意图和授权范围内的远端快照。
- 用户无权的字段不得进入 remote_json。
- 同一实体的后续 pending 命令全部挂在该冲突后代上，不能越过冲突继续提交。
- 用户退出或权限撤销后，不再展示已失权联系人的完整远端内容；本地冲突需进入受控清理或加密保留策略。

### 9.2 用户处理选项

普通业务字段冲突：

1. 采用中心：丢弃本地意图，保留处理记录。
2. 重新应用本地意图：刷新到最新版本、重新校验权限和业务锁、展示差异，用户再次确认后生成新的 mutationId。
3. 保留跟进事实：跟进是追加数据，不参与普通字段合并；按原事件幂等提交。

联系人不得默认可选“复制为新客户”。同一中心联系人应继续使用原记录、历史和归属；只有用户明确发起新建且通过重叠检查时才创建新客户。

### 9.3 删除

- 删除写领域墓碑并递增版本。
- 旧设备携带旧版本更新时，中心返回 NOT_FOUND 或 CONFLICT，不能复活记录。
- 客户端收到 tombstone 后移除可读镜像，并把仍引用该实体的 outbox 标记为 blocked，不删除本地审计。
- 业务恢复必须走领域恢复命令或新记录创建规则，不能用普通更新覆盖墓碑。

### 9.4 撤权与重新授权

- invalidate 表示当前用户失去读取权，不等于业务删除。
- 客户端收到 invalidate 后删除联系人和关联摘要，但保留最小冲突元数据。
- 撤权期间不得发送真实邮件、读取中心正文或继续提交该实体。
- 重新授权通过共享、分配或完整 scope 快照恢复。
- 权限变化后，本地 pending 命令只有重新校验最新权限、版本和归属后才可提交。
## 10. 发件状态机

### 10.1 中心意图

    CREATE TABLE public.send_intents (
      send_intent_id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
      message_key text NOT NULL,
      payload_digest text NOT NULL,
      state text NOT NULL CHECK(state IN (
        'planned','leased','started','accepted','rejected','unknown','requires_review','cancelled'
      )),
      lease_owner_device_id text,
      lease_generation bigint NOT NULL DEFAULT 0,
      lease_expires_at timestamptz,
      started_at timestamptz,
      smtp_accepted_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE(user_id,message_key),
      CHECK((state='leased')=(lease_expires_at IS NOT NULL AND lease_owner_device_id IS NOT NULL))
    );

### 10.2 状态转换

    planned
      -> leased
      -> started
      -> accepted | rejected | unknown

    rejected -> planned       用户明确重新安排
    unknown  -> requires_review
    requires_review -> planned 仅用户确认“可能已发送”后

规则：

- 两个设备同时领取时只有 planned 或租约过期且从未 started 的意图能成功领取。
- 每次领取递增 lease_generation，旧 generation 永远不能开始 SMTP。
- 设备必须在 SMTP 前写本地 started 标记并向中心提交 start/generation。
- 中心确认 started 后，意图不能再被另一设备普通领取。
- SMTP 已开始但未收到结果：本地和中心都进入 unknown；禁止自动重发。
- SMTP 明确拒绝才允许回到 planned 或失败处理。
- 真实发件必须在线取得开始确认，不能在离线状态下读取旧租约继续发送。
- 发件授权与租约是不同概念：现有一次性 send authorization 继续负责联系人、收件人和内容授权；租约只负责唯一执行权。

### 10.3 与现有自动开发任务的关系

现有 campaign attempt 的 planned/accepted/rejected/unknown 和 lease 可以保留，后续按同一协议接入 send_intents。第一版不重写自动开发 Worker，只保证它和手动发件都不会对同一 message_key 各自取得执行权。
## 11. 本地 SQLite 设计

### 11.1 表

    sync_meta (
      id INTEGER PRIMARY KEY CHECK(id=1),
      user_id TEXT NOT NULL,
      center_url TEXT NOT NULL,
      device_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      pull_cursor TEXT NOT NULL DEFAULT '0',
      head_cursor TEXT,
      scope_epoch INTEGER NOT NULL DEFAULT 0,
      last_success_at TEXT,
      last_error TEXT
    );

    sync_outbox (
      mutation_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      base_version INTEGER NOT NULL,
      command_json TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      predecessor_id TEXT,
      legacy_source TEXT,
      legacy_key TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'pending','sending','acknowledged','conflict','failed','blocked'
      )),
      attempted_at TEXT,
      acknowledged_at TEXT,
      confirmed_seq TEXT,
      confirmed_version INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    sync_entity_versions (
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(entity_type,entity_key)
    );

    sync_receipts (
      mutation_id TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      result_state TEXT NOT NULL,
      result_json TEXT NOT NULL,
      committed_seq TEXT,
      committed_version INTEGER,
      created_at TEXT NOT NULL
    );

本地库仍按中心地址、账号和权限范围隔离。切换账号时，当前同步循环立即失效，不能把旧账号回执或游标写入新账号库。

第一版 CRM 同步账本放在当前账号的 crm-offline.db，避免再造一套数据库。邮件正文和邮箱凭据仍在本机邮件存储；跨数据库操作不得宣称原子提交，若后续同步邮箱元数据，必须另列补偿或迁移步骤。

### 11.2 本地事务

- 用户操作和 outbox 插入必须在一个 SQLite 事务中完成。
- 同一实体用 predecessor_id 形成 FIFO；第一版全局只允许一条 in-flight mutation，减少乱序。
- 发出前持久化 sending 与原 request_digest。
- 断网或超时保持 sending，并用同一 mutationId 重试；不能生成新 idempotency key。
- 回执成功后在同一事务中更新确认镜像、实体版本、receipt 和 outbox 状态。
- outbox ack 后保留最小回执至少一个重试周期，不能立即删除。
- 冲突、失败、blocked 行保留到用户处理或明确的保留期清理。
## 12. 旧数据与分阶段上线

### 12.1 本地旧队列迁移

当前已有 crm_contact_commands 和客户级 outbox。迁移必须逐状态处理，不能全部转成新 mutation：

| 旧状态 | 处理 |
|---|---|
| pending 且未 attempted | 在切换业务域时转换为新 sync_outbox，使用新的稳定 mutationId 和原 request digest |
| sending 或 attempted 但结果未知 | 先用旧接口和原 idempotency key 重放，直到拿到明确回执；确认后才迁移或收口 |
| confirmed | 保留去重凭据，不必重新执行 |
| conflict | 转成 sync_conflicts，要求用户重新选择 |
| failed 且可安全放弃 | 保留处理记录，不自动重发 |
| blocked | 保留阻塞原因，权限恢复后重新校验 |

迁移增加 legacy_source 和 legacy_key 字段，确保同一旧操作只能转换一次。新同步执行器上线后，旧执行器必须按业务域关闭，禁止两套循环同时运行。

### 12.2 中心迁移

建议迁移拆分，具体编号以实施分支下一个可用版本为准：

1. 068-sync-device-installations：设备安装、账号关联和旧会话回填。
2. 069-sync-stream-core：sync_heads、sync_changes、mutation 回执和索引。
3. 070-send-intent-fencing：send_intents、租约代数和 started/unknown 审计。
4. 后续迁移扩展审计事件 CHECK、补用户 scope_epoch 和清理任务元数据。

所有 DDL 使用现有 checksum 迁移机制，先扩表、后回填、再切流。生产 DDL、数据回填和服务重启按现有审批和维护窗口执行，设计评审不等于生产授权。

### 12.3 上线闸门

阶段 0：契约与影子

- 定义 sync API/IPC 类型、领域实体键、错误码和状态机。
- 新增 shadow 同步项目，不改变现有写入。
- 对同一联系人比较 outbox、变化流和本地镜像，确认无漏事件。

阶段 1：只读拉取

- 客户端获得 head、changes、snapshot。
- 完整快照、增量页和游标损坏场景先通过。
- 业务写入仍走旧接口，客户端仍保持单活跃设备。

阶段 2：低风险写入

- 联系人字段、公司字段和跟进切到严格版本 mutation。
- 旧 local outbox 原子迁移。
- 冲突页、重试、刷新版本和撤权处理完成。
- 仍只允许单设备，降低变量。

阶段 3：高风险动作唯一执行权

- 发件意图、租约、fencing token 和 unknown 状态上线。
- 手动发件和自动开发任务共享同一唯一执行保护。
- 证明两个设备不能同时开始同一 message_key。

阶段 4：多设备灰度

- 服务端开关按账号、客户端版本和设备能力开启。
- 首轮只允许测试账号和少量真实账号。
- 观察游标延迟、冲突率、outbox 积压、设备撤销和发件 unknown。
- 未达到兼容版本或能力不完整的设备不能加入多设备模式。

阶段 5：扩展业务域

- 邮箱元数据、任务、商机、集合状态逐域切换。
- 每个域先 shadow，再切写，再关闭旧路径。
- 不把一个通用 mutation 直接覆盖所有业务语义。

阶段 6：清理兼容层

- 至少观察两个发布周期。
- 确认旧客户端比例、旧 outbox 清零、handoff 流量和回滚窗口。
- 再删除单设备索引语义、旧同步入口和旧执行器。

### 12.4 回滚

- 关闭 MULTI_DEVICE_ENABLED 只能阻止新设备加入；已有多设备需要明确撤销策略。
- 关闭某个域的新 mutation 开关后，客户端保留 outbox，不丢本地意图。
- 旧写入路径在观察窗口内保持可用，服务端根据能力选择路径，不能双写。
- 同步流表是新增事实，回滚时保留，不回删业务表和历史回执。
## 13. 契约、配置与可观测性

### 13.1 契约

中心端在 server/core/sync.ts 定义：

    SYNC_ROUTES
    SYNC_LIMITS
    SYNC_PROTOCOL_VERSION = 1
    SYNC_ENTITY_TYPES
    SYNC_OPERATIONS
    SYNC_ERROR_CODES
    SyncEntityRef
    SyncMutationRequest
    SyncMutationReceipt
    SyncChange
    SyncChangePage
    SyncSnapshotItem
    SyncHead
    SyncConflict

桌面端在 src/shared/sync.ts 对齐同一类型。src/main/contract.ts 新增：

    SYNC_STATUS
    SYNC_NOW
    SYNC_RESOLVE
    SYNC_RETRY
    SYNC_DEVICES
    SYNC_REVOKE_DEVICE

renderer 只调用 IPC，不直接访问中心 URL，不自行拼 SQLite 或同步游标。

### 13.2 API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /api/sync/head | 头、保留水位、scope epoch |
| GET | /api/sync/changes | 按用户拉取增量 |
| GET | /api/sync/snapshot | 按稳定 keyset 拉取受权快照 |
| POST | /api/sync/mutations | 提交普通业务 mutation |
| GET | /api/account/devices | 设备列表 |
| POST | /api/account/devices/:deviceId/revoke | 撤销指定设备 |
| POST | /api/account/devices/revoke-others | 撤销其他设备 |
| POST | /api/sync/send-intents/claim | 领取发件意图 |
| POST | /api/sync/send-intents/:id/start | 记录 started 和 generation |
| POST | /api/sync/send-intents/:id/complete | 记录 accepted/rejected/unknown |

所有返回使用统一结构。新增错误码至少包括：

    RESYNC_REQUIRED
    DEVICE_REVOKED
    SYNC_PROTOCOL_UNSUPPORTED
    STALE_LEASE
    SEND_RESULT_UNKNOWN

### 13.3 配置

时间配置统一使用 _seconds 后缀：

    sync_change_retention_seconds
    sync_pull_interval_seconds
    sync_retry_base_seconds
    sync_retry_max_seconds
    send_lease_seconds
    device_last_seen_update_seconds

第一版建议：

- 可见页面短轮询，隐藏窗口暂停；聚焦、网络恢复和手动刷新立即触发一轮。
- 单轮不得重入。
- 第一版允许一条 in-flight mutation，稳定后再评估多实体并发。
- 轮询只拉增量，不重复全量扫描。

### 13.4 日志和诊断

客户端诊断只保存：

- 当前 pull cursor、head cursor、min available cursor。
- scope epoch。
- pending/sending/conflict/failed 数量和最老年龄。
- 最近成功拉取、推送时间。
- 最近错误码和上下文。

日志格式统一 [时间] [级别] [上下文] 消息。禁止记录邮件正文、密码、授权码、Token、完整客户敏感字段和凭据。

### 13.5 安全边界

- 设备元数据不承担密码保存。
- 邮件凭据只进入本机安全存储。
- 撤权设备不能继续刷新会话或取得发件租约。
- 本地镜像按账号隔离，切换账号时同步循环必须带 generation 校验。
- 服务端不得信任客户端提交的 user_id、device_id、scope、role 或 expected permission。
- 管理员不读取普通文本密码、Token、邮件正文或授权码。
## 14. 验证矩阵

### 14.1 会话与设备

- 两台符合最低版本的新设备同时登录成功。
- 旧客户端仍走 handoff，不能悄悄进入多设备模式。
- 同一设备重复登录只撤销本设备旧会话。
- A 退出不影响 B。
- 同机切换账号后，新账号不能读取旧账号 SQLite、游标、冲突或凭据。
- 撤销 A 后 A 的 access、refresh 和发件租约全部失效。
- 修改密码使全部设备失效。
- 设备审计 event 约束允许新增事件，失败时业务事务整体回滚。

### 14.2 同步和版本

- A、B 同时修改同一联系人：后提交者收到 CONFLICT，中心保留先提交版本。
- 字段不同也冲突，验证第一版没有伪自动合并。
- 用户刷新并明确重新应用后产生新 mutationId，旧回执仍可重放。
- 同一 mutationId 重放 10 次只产生一个业务结果。
- 同一 mutationId 携带不同 digest 被拒绝。
- 空响应、超时、连接断开按同一 mutationId 重试。
- 旧响应不会覆盖新版本。
- 设备时钟偏差 30 分钟不影响服务端排序。

### 14.3 拉取和故障

- 页面数据与游标在同一 SQLite 事务提交。
- 强制在应用页后、保存游标前崩溃，重启后重新应用该页且不跳过。
- after 小于 minAvailableCursor 时进入全量重建。
- scopeEpoch 变化时进入全量重建。
- 全量重建过程中发生创建、更新、删除和撤权，最终镜像与中心一致。
- 拉取期间切换账号，旧账号结果不能写入新账号库。
- 隐藏窗口停止高频拉取，聚焦后立即补拉。

### 14.4 权限与删除

- 新共享用户在离线时也收到基线 upsert。
- 撤权后 invalidate 删除镜像和本地摘要。
- 撤权后 pending mutation 变为 blocked，不能继续发送。
- 重新授权后恢复同一联系人，不创建复制记录。
- A 删除，B 离线旧副本重连后不能复活。
- 团队范围变化递增 scopeEpoch 并触发完整快照。

### 14.5 发件与自动任务

- 两个设备同时领取同一 send intent，只有一个取得 generation。
- 旧 generation 调用 start 返回 STALE_LEASE。
- 设备未成功 start 时不能进入 SMTP。
- SMTP 开始后设备崩溃，意图保持 started/unknown，另一设备不能自动重发。
- SMTP 明确拒绝后可按用户确认重新安排。
- 手动发件与自动开发 Worker 对同一 message_key 不能各自开始。
- 离线启动或恢复发送失败关闭。

### 14.6 旧队列迁移

- pending 未尝试的旧命令只迁移一次。
- attempted 但未知的旧命令先通过旧接口重放，不转换后重复执行业务。
- confirmed 旧命令只保留去重凭据。
- conflict/failed/blocked 不自动重发。
- 迁移前后创建、跟进、任务和导入业务结果条数一致。
- 新执行器和旧执行器不会同时处理同一业务域。

### 14.7 分层验证

1. 单元测试：实体键、状态机、游标、digest、版本冲突、重试分类。
2. 中心 PostgreSQL 隔离测试：并发 A/B、多接收人 fanout、锁顺序、回滚、快照和保留水位。
3. SQLite 原生测试：事务崩溃、账号切换、旧队列迁移、outbox 认领和多实例锁。
4. 双设备桌面测试：两个独立 userData 仅用于隔离测试，同一测试账号、原生 IPC/preload/renderer 和合成或隔离 HTTP 中心。
5. 灰度预发：受控测试账号和隔离数据，核对日志、指标和设备撤销。
6. 真实业务冒烟只使用合成联系人；不执行真实外发、生产写入或真实客户邮件。

## 15. 验收标准

只有以下条件全部满足，才能宣称多设备同步可用：

- 两台电脑同时在线，A 修改后 B 无需重启即可收敛。
- A、B 并发修改同一实体时，B 明确看到冲突并完成处理，不静默覆盖。
- 离线修改在断网、崩溃、重启和重复点击后只提交一次。
- 删除和撤权不会被旧设备重放复活。
- 同一发件意图只能由一个设备开始，未知结果不会自动重发。
- 设备可单独退出，修改密码可退出全部设备。
- 同机切换账号不会串库、串游标或串凭据。
- 用户能在现有页面看懂待同步、冲突、blocked 和离线状态。
- 旧客户端兼容窗口内，单设备 handoff 仍可完成。
- 增量保留、全量重建和中心短时 503 均有验证证据。

## 16. 实施顺序

1. 完成本设计评审，确认严格版本冲突和不做字段自动合并。
2. 先写 server/core/sync.ts、src/shared/sync.ts、src/main/contract.ts 契约和测试。
3. 新增设备安装、同步流和发件意图迁移，只扩表不切流。
4. 接入影子同步项目，核对事件无漏。
5. 客户端先只读拉取，修正现有运行时完整扫描和游标事务。
6. 迁移旧 outbox，切换联系人字段和跟进写入。
7. 完成冲突 UI、撤权 block、scope resync 和双设备隔离测试。
8. 完成发件意图 fencing，关闭双设备重复发送窗口。
9. 打开多设备灰度，观察指标后扩域。
10. 观察两个发布周期后清理旧执行器和单设备语义。

文档同步：

- 实现时新增模块和目录同步更新 架构基底.md。
- 新增 IPC/API 同步更新 IPC契约.md。
- 新增表、列、索引同步更新 database-schema.md。
- 新增配置键同步更新 架构基底.md。
- 发布时按 SemVer 和 版本记录.md 记录。
- 每个修复或验证节点同步 docs/prospector-issue-log.md 与知识库当前状态、审阅记录。

## 17. 仍需用户批准的产品取舍

1. 第一版是否接受“任何人先提交都赢，后提交者必须人工处理”的严格冲突，而不是不同字段自动合并。
2. 是否允许第一版把收件箱已读、置顶和本地分析继续保留为设备本地状态；若要求跨设备一致，需要在同一协议中另列集合命令。
3. 发件 unknown 状态是否只允许人工确认后重新安排；本设计默认禁止自动重发。
4. 多设备灰度是否只开放给满足最低客户端版本的账号；本设计默认是。
