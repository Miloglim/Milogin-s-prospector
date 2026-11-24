# Prospector 多设备同步与冲突处理方案

> 状态：已被 [修正方案 v2](<D:/Agent Basement/Milogin-s-prospector/docs/multi-device-sync-conflict-design-v2-20261113.md>) 取代。本文件保留为 2026-11-13 审计基线，不再作为实施依据。

状态：设计稿  
日期：2026-11-13  
适用：Prospector 桌面端、中心 PostgreSQL、Navigator 更新服务

## 1. 目标与边界

### 1.1 目标

同一中心账号可以同时登录多台电脑。每台电脑都可以离线工作，联网后在合理时间内收敛到同一份业务状态，不因登录顺序、重复请求、断网重放或设备时钟差异产生静默覆盖和重复业务动作。

完成后应具备：

- 多设备会话，不要求第二台电脑替换第一台。
- 中心增量同步游标；每台设备只拉取尚未应用的变化。
- 本机 outbox；离线写入可恢复、可重试、可去重。
- 每个实体显式版本；并发修改返回冲突，不静默覆盖。
- 删除墓碑；避免已删除数据被旧设备重新推回。
- 按业务类型选择冲突策略，而不是全局“最后写入覆盖一切”。
- 发件、领客、分配、跟进等有副作用的动作具备服务端幂等和唯一执行权。
- 邮箱凭据仍留在设备本机；邮箱配置可同步，邮件正文按 IMAP 在各设备独立缓存。
- 设备管理入口：查看已登录设备、最后活跃时间、单独退出设备。

### 1.2 非目标

- 不把邮箱密码、SMTP/IMAP 授权码上传中心。
- 不把整份本地邮件正文和附件当作中心主数据。
- 不对所有业务实体直接套用通用 CRDT。销售阶段、负责人、分配状态等字段包含明确业务约束，应以服务端命令和版本冲突为准。
- 不在第一版支持两个设备同时编辑同一封富文本草稿的字符级实时协作。

## 2. 核心原则

1. 中心 PostgreSQL 是共享业务事实的唯一真源。
2. 本机 SQLite 是可离线使用的副本和待提交操作队列，不是另一套业务真源。
3. 所有写操作都通过“命令”进入中心，命令带 `mutationId`、`deviceId`、`baseVersion` 和发生时间。
4. 所有共享数据通过用户级单调游标拉取，设备只有在本地事务提交后才推进游标。
5. 重试同一 `mutationId` 必须返回原回执，不重复执行。
6. 删除写墓碑，不在中心直接物理删除共享事实。
7. 运行时状态和设备级凭据不进入共享同步流。
8. 冲突必须可见或可解释；禁止把服务端返回的冲突伪装成保存成功。

## 3. 总体架构

```text
 Device A                         Device B                         Device C
 local SQLite                     local SQLite                     local SQLite
 outbox / inbox cursor            outbox / inbox cursor            outbox / inbox cursor
     |                                |                                |
     +----------------------- HTTPS command + pull --------------------+
                                      |
                              Center API
                    mutation receipts / entity locks
                    sync_heads / sync_changes
                    domain validation / permissions
                                      |
                              PostgreSQL
```

每个设备维护：

- `deviceId`：稳定安装 ID。
- `userId`：当前中心账号。
- `pullCursor`：已经按顺序应用到的中心同步序列。
- `outbox`：尚未被中心确认的本机命令。
- `conflicts`：需要用户处理的并发修改或业务冲突。

中心维护：

- 用户级同步序列。
- 实体当前版本。
- 幂等命令回执。
- 设备注册和会话。
- 权限与可见范围。

## 4. 多设备身份与会话

### 4.1 会话模型

同一用户允许在不同设备上同时存在有效会话。同一设备重复登录时，旧的本机会话族可以撤销，避免同机多份过期凭据累积。

建议表：

```sql
identity_devices (
  device_id text primary key,
  user_id uuid not null references identity_users(user_id),
  device_name text not null,
  platform text not null,
  app_version text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
```

`identity_sessions` 继续保存每台设备的 access session。唯一约束从：

```text
(user_id, desktop_product) where active
```

改为：

```text
(user_id, desktop_product, desktop_device_id) where active
```

### 4.2 设备管理

新增设备接口：

- `GET /api/account/devices`：本人设备列表、最后活跃时间、当前设备标记。
- `POST /api/account/devices/:deviceId/revoke`：退出指定设备。
- `POST /api/account/devices/revoke-others`：退出其他设备。

管理员可查看用户设备元数据，但不能查看邮件授权码、邮件正文或会话 Token。

### 4.3 凭据边界

- access token 和 refresh token 每台设备独立。
- 设备撤销后，该设备 refresh family 立即失效。
- 密码修改可以使所有设备失效。
- 正常退出只退出当前设备；用户也可显式退出全部设备。

## 5. 统一同步协议

### 5.1 中心同步序列

每个用户一条有序同步流。为确保设备看到严格顺序，写入事务内锁住该用户的同步头：

```sql
sync_heads (
  user_id uuid primary key,
  last_seq bigint not null default 0
);

sync_changes (
  user_id uuid not null,
  seq bigint not null,
  product_id text not null,
  entity_type text not null,
  entity_id text not null,
  operation text not null check (operation in ('upsert','tombstone','invalidate')),
  entity_version bigint,
  mutation_id uuid,
  actor_device_id text,
  event_type text not null,
  payload jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, seq)
);
```

大实体采用“引用事件 + 受权读取当前快照”。小配置可内联 `payload`。

### 5.2 提交命令

```http
POST /api/sync/mutations
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "mutationId": "device-a-018f...",
  "deviceId": "device-a",
  "entityType": "crm.customer",
  "entityId": "uuid",
  "baseVersion": 12,
  "clientOccurredAt": "2026-11-13T08:01:02.123+08:00",
  "command": {
    "name": "update_customer",
    "fields": { "country": "Mexico" }
  }
}
```

服务端流程：

1. 验证会话、设备、产品权限。
2. 查询 `mutation_receipts`；若同 `mutationId` 已存在，直接返回原回执。
3. 锁定实体并检查 `baseVersion`。
4. 执行业务命令和领域校验。
5. 实体版本递增。
6. 在同一事务写命令回执、同步序列和必要的通知 outbox。
7. 返回 `{ ok: true, data: { version, seq, duplicate? } }`。

### 5.3 幂等回执

```sql
sync_mutation_receipts (
  user_id uuid not null,
  mutation_id uuid not null,
  device_id text not null,
  entity_type text not null,
  entity_id text not null,
  result jsonb not null,
  committed_version bigint,
  committed_seq bigint,
  created_at timestamptz not null default now(),
  primary key (user_id, mutation_id)
);
```

只有中心事务提交后的回执才能被认为成功。网络超时但本机未收到回执时，使用同一个 `mutationId` 重试。

### 5.4 拉取变化

```http
GET /api/sync/changes?after=1234&limit=100
```

响应：

```json
{
  "ok": true,
  "data": {
    "items": [],
    "nextCursor": "1250",
    "headCursor": "1250",
    "hasMore": false,
    "resyncRequired": false
  }
}
```

客户端应用规则：

- 按 `seq` 严格升序应用。
- 每个变化与本地数据修改、`pullCursor` 更新放在同一个 SQLite 事务。
- 实体读取因权限变化失败时，服务端返回 tombstone 或 `invalidate`，客户端删除不可见镜像。
- 本地游标大于中心 head 时，说明中心恢复或重建，触发全量重新基线。

### 5.5 本机 outbox

```sql
sync_outbox (
  mutation_id text primary key,
  entity_type text not null,
  entity_id text not null,
  base_version integer not null,
  command_json text not null,
  state text not null,
  attempts integer not null default 0,
  next_retry_at text,
  last_error text,
  created_at text not null,
  updated_at text not null
);
```

状态：`pending / sending / acknowledged / conflict / blocked`。

客户端同一时间只发送一个或少量有序批次，避免后发生的命令先提交。每个实体可以有独立队列，以减少不同实体互相阻塞。

### 5.6 本地冲突表

```sql
sync_conflicts (
  conflict_id text primary key,
  entity_type text not null,
  entity_id text not null,
  mutation_id text not null,
  local_json text not null,
  remote_json text,
  reason text not null,
  created_at text not null,
  resolved_at text
);
```

冲突解决不能只在日志里留痕，必须进入用户可处理的列表或页面内提示。

## 6. 冲突处理策略

### 6.1 按数据类型选择规则

| 数据 | 冲突策略 | 说明 |
|---|---|---|
| 跟进记录、邮件事件、审计 | 只追加 | 生成唯一事实 ID，重复 ID 忽略 |
| 消息已读、置顶、待办完成 | 幂等集合操作 | 写“设置为 true/false”，不写 toggle |
| 联系状态、客户阶段 | 版本严格冲突 | 两设备都基于旧版本时，后提交者需刷新确认 |
| 客户/公司普通字段 | 字段级合并 | 不同字段并发修改可合并；同字段冲突提示 |
| 标签、文件夹 | 集合并集/差集 | 客户端发送 add/remove，不发整个数组 |
| 负责人、分配、接收 | 业务锁 | 中心事务检查唯一负责人、分配状态和权限 |
| 发件队列、任务启动 | 唯一意图 + 设备租约 | 防止两个设备各发一次 |
| 草稿 | 服务端版本 + 冲突副本 | 不支持实时协作时，不静默覆盖另一份草稿 |
| 个人偏好、签名 | 最后修改时间 | 使用服务器提交时间，不信任设备时钟 |
| 邮箱账户元数据 | 版本严格冲突 | 密码/授权码仍是设备本地凭据 |

### 6.2 禁止使用 toggle

错误命令：

```text
toggleRead(messageId)
```

正确命令：

```text
setRead(messageId, true)
```

否则两个设备各执行一次 toggle 会互相抵消。

### 6.3 设备时间

设备时间只用于展示和审计参考，排序以中心 `committed_at` 和 `seq` 为准。客户端时钟明显偏快时不直接拒绝离线工作，但中心回执记录时钟偏差。

## 7. 各业务域同步矩阵

| 业务域 | 中心真源 | 本地缓存 | 同步方式 | 冲突 |
|---|---|---|---|---|
| 账号资料 | 是 | 是 | 版本命令 | 字段冲突 |
| 邮箱账号元数据 | 是 | 是 | 版本命令 | 同字段冲突 |
| SMTP/IMAP 密码 | 否 | 是，设备加密 | 不同步 | 各设备单独配置 |
| 邮件正文/附件 | 否 | 是，按需缓存 | 各设备独立 IMAP | 以 messageId 幂等 |
| 邮件已读/置顶/文件夹 | 是（建议） | 是 | 幂等集合命令 | 集合合并 |
| AI 邮件分类/摘要 | 可同步 | 是 | 派生数据版本 | 同内容哈希覆盖复用 |
| 联系人/公司 | 是 | 是 | 同步事件 + 快照 | 实体版本 |
| 跟进/任务/商机 | 是 | 是 | 追加事件 + 状态版本 | 状态更新严格版本 |
| 团队与权限 | 是 | 只读镜像 | 权限事件 | 服务端权威 |
| 自动开发任务配置 | 是 | 是 | 版本命令 | 严格版本 |
| 发件执行队列 | 是 | 设备执行副本 | 中心 send intent + lease | 唯一执行权 |
| AI 会话与运行任务 | 否/可选 | 是 | 不建议第一版跨设备 | 设备本地 |

## 8. 邮件与发件特殊处理

### 8.1 邮箱元数据同步

中心只保存：

- 邮箱地址
- provider
- SMTP/IMAP host 和 port
- displayName
- signature
- isActive
- version / deletedAt

第二台电脑收到配置后创建本地账号，但 `credentialConfigured=false`。用户首次使用时输入密码或授权码，凭据进入本机 DPAPI/安全存储。

### 8.2 邮件消息去重

邮件主键建议统一为：

```text
(mailboxId, providerMessageId)
```

没有稳定 `Message-ID` 时使用 `(accountId, folder, uidValidity, uid)` 作为服务商定位键，不能只用主题或时间。

### 8.3 AI 分析复用

AI 分析结果可同步为派生记录：

```text
(mailboxId, messageId, contentHash, analyzerVersion)
```

内容哈希相同且分析版本相同则复用；内容或规则版本变化时重新分析。人工修正优先级高于规则和模型结果。

### 8.4 防止两设备重复发信

即使 SMTP 在各设备本地执行，共享发件队列仍必须由中心分配唯一执行权：

```sql
send_intents (
  send_intent_id uuid primary key,
  user_id uuid not null,
  message_key text not null,
  state text not null,
  leased_device_id text,
  lease_expires_at timestamptz,
  smtp_accepted_at timestamptz,
  unique(user_id, message_key)
);
```

设备发送前先获取租约。SMTP 已接受但设备未来得及回执时，租约到期不能自动重发，必须进入 `unknown / requires-review`，避免重复邮件。

## 9. 同步循环与失败恢复

### 9.1 客户端循环

1. 读取本地 `pullCursor`。
2. 发送最早可发送的 outbox 命令。
3. 处理回执：成功、重复回执、冲突、权限失败、暂时不可用。
4. 按游标拉取中心变化。
5. 在本地事务中应用变化并推进游标。
6. 重试网络失败和 `UNAVAILABLE`；不重试 `FORBIDDEN`、`UNAUTHORIZED`、确定性 `INVALID_INPUT`。
7. 页面重新可见、网络恢复、应用启动、用户手动刷新时立即触发一轮同步。

### 9.2 退避

- 网络错误：指数退避，加随机抖动。
- 中心 503：指数退避。
- 版本冲突：立即停止该实体，不自动重试，进入冲突处理。
- 权限撤销：停止该实体，删除不可见镜像，提示账号权限变化。
- 设备被撤销：清空会话，进入登录页，不再继续同步或发信。

### 9.3 全量重建

发生以下情况时执行受控 resync：

- 本地游标损坏。
- 中心序列重建。
- 本地数据库损坏。
- 实体权限范围发生大变化。

全量重建先获取 `headCursor`，再分页读取快照，最后从该 head 之后继续增量，避免边读边漏。

## 10. UI 与用户感知

不增加独立“同步工作区”。同步状态内化到现有页面：

- 顶栏显示小状态：已同步、同步中、离线待传、存在冲突。
- 页面内只对当前实体显示冲突，不弹全局淹没有效信息。
- 冲突 UI 提供：保留本机、采用中心、复制为副本、查看差异。
- 设置页提供设备管理。
- 离线可继续本地操作，但真实发信、中心写入、换机等高影响动作遵守现有安全边界。
- 后台同步不得因隐藏窗口高频轮询；使用可见轮询、网络恢复事件和中心推送/SSE 结合。

## 11. 权限变化与数据可见性

- 每个同步事件按当前用户可见范围生成。
- 权限撤销时，中心写 `invalidate` 事件；设备删除对应镜像和本地派生摘要。
- 团队可见、逐人共享和分配变更由服务端决定，客户端不自行合并权限。
- 同一联系人被多人修改时仍使用实体版本；冲突提示中不得暴露用户无权看到的历史字段。

## 12. 数据迁移顺序

### 阶段 A：扩表但不切流

- 新增 `identity_devices`、`sync_heads`、`sync_changes`、`sync_mutation_receipts`。
- 现有业务表补 `sync_version` 或复用已有 `version`。
- 建审计、序列和索引。

### 阶段 B：多设备会话

- 移除单活跃设备唯一索引的约束语义。
- 设备会话独立。
- 旧 handoff 接口保留只用于旧客户端兼容，新客户端不再触发替换。

### 阶段 C：影子同步

- 当前写入路径继续生效。
- 同时写同步事件。
- 客户端只拉取、不依赖同步结果执行业务。
- 对比中心数据和本地镜像，确认没有漏事件。

### 阶段 D：切换读写

- 逐业务域把客户端写入切到 `/api/sync/mutations`。
- 完成一个域，关闭该域旧写入路径。
- 发件与分配最后切换，因为它们有不可逆副作用。

### 阶段 E：清理兼容层

- 观察至少一个发布周期。
- 确认旧客户端比例后，再删除单设备替换和旧同步入口。

## 13. 可观测性

中心指标：

- mutation 成功率、冲突率、幂等重放次数。
- 每用户同步延迟（committed_at 到设备 ack）。
- outbox 积压、sync_changes 增长、慢事务。
- 设备最后活跃时间、被撤销设备尝试访问次数。

客户端诊断：

- 当前 cursor / head cursor。
- 待发送 outbox 数、最老命令年龄、重试次数。
- 最近冲突数量。
- 最近一次成功拉取和推送时间。

日志不得记录邮件正文、密码、Token 或完整客户敏感字段。

## 14. 验证矩阵

### 14.1 会话

- A、B 两设备同时登录同一账号均成功。
- 同设备重复登录撤销该设备旧会话，不影响另一设备。
- 退出 A 不影响 B。
- 修改密码使全部设备失效。

### 14.2 同步

- A 离线修改，B 在线修改不同字段，联网后字段合并。
- A、B 修改同一字段，后提交者收到冲突，数据不静默丢失。
- A 删除，B 离线旧副本重连后不能复活记录。
- 同一 mutationId 重放 10 次只产生一个业务结果。
- 乱序网络响应不会让旧版本覆盖新版本。
- 设备时间偏差 30 分钟不影响服务端排序。

### 14.3 业务

- 两个设备同时接收同一分配请求，只会有一个成功。
- 两个设备同时启动同一发件任务，只会有一个设备取得执行租约。
- SMTP 接受响应丢失时不自动重复发送，进入人工确认。
- 权限撤销后，设备本地不可见镜像被删除。

### 14.4 故障

- 中心 503 时 outbox 保留。
- 本地数据库在应用变化和游标更新之间崩溃，重启后不跳版本。
- 同步中切换账号不得把前一账号变化写入新账号库。

## 15. 实施优先级

1. 多设备会话和设备管理。
2. 通用 `sync_changes`、幂等回执和客户端 outbox。
3. 邮箱账号元数据同步；凭据保持设备本地。
4. 已读、置顶、文件夹、待办等幂等用户状态同步。
5. 联系人/公司字段级冲突与跟进追加事件。
6. 任务、分配和自动开发任务的严格版本冲突。
7. 中心发件意图和设备租约。
8. 冲突 UI、诊断信息和灰度切换。

## 16. 验收标准

多设备同步只有满足以下条件才算完成：

- 两台电脑同时在线，任意一台修改普通业务字段后，另一台在不重启的情况下可收敛。
- 离线修改在恢复联网后可靠上传，重复点击和网络超时不会重复执行。
- 同一实体并发修改不会被无提示覆盖。
- 删除不会因旧设备重放而复活。
- 同一发件任务不会由两个设备重复发送。
- 设备可单独退出，修改密码可退出全部设备。
- 用户能够在不看日志的情况下理解“待同步、冲突、离线”当前状态及处理方法。

