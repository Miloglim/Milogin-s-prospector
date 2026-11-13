# Prospector 换机数据连续性方案

状态：待决策方案，2026-11-06。本文不表示已实现、已部署或已通过正式环境验收。

## 1. 结论

当前 Prospector 已实现的只是“新设备替换旧设备会话”：新电脑登录、确认退出旧电脑、旧 refresh family 被撤销。它没有完成“换机”。

目标应改为一次可恢复的设备交接事务：

1. 旧设备先检查并补传未同步状态。
2. 旧设备停止写入和发送，生成数据清单。
3. 中心确认清单完整后撤销旧会话并创建新会话。
4. 新设备恢复中心业务数据、重建本地缓存、重新授权本机密钥。
5. 新设备核对数量、版本和关键对象后才算完成。

判断标准不是“新电脑能登录”，而是“除必须重新授权的密钥外，用户看不到数据丢失、重复或状态倒退”。

## 2. 范围与原则

### 目标

- 联系人、客户、跟进、任务、商机、模板、标签、邮件草稿和发送队列均可跨设备恢复。
- 换机中断后可继续，不会出现旧设备已退出、新设备未恢复的半截状态。
- 同一对象重复上传、响应丢失、应用崩溃和并发双击不会产生重复数据或重复发信。
- 邮件正文、附件和搜索索引等可重建数据通过重新拉取或重建恢复。
- 邮件密码、OAuth 凭据、设备身份和会话令牌永不迁移。
- 方案先落地 Prospector，再抽成 Navigator 可复用的产品级换机协议。

### 暂不纳入

- 不在本方案中迁移旧电脑的 `master.key`、设备 ID、refresh token 或系统凭据。
- 不把整个 Electron `userData` 目录直接复制到新电脑。
- 不在未获真实外发授权时发送任何邮件。
- 不在方案阶段修改正式中心、正式数据库或安装包。

## 3. 数据归属

| 数据 | 当前位置 | 目标真源 | 换机处理 |
| --- | --- | --- | --- |
| 账号、角色、产品准入、设备会话 | 中心 | 中心 | 自动恢复 |
| 联系人、公司、客户、分配、共享、跟进、任务、商机 | 中心 | 中心 | 自动恢复 |
| 联系人本地镜像 | 账号 `crm-offline.db` | 可重建缓存 | 新设备完整基线同步 |
| 联系人离线命令、冲突和确认回执 | 账号 `crm-offline.db` | 本机待同步队列 | 换机前必须补传或显式保留 |
| 邮件素材库模板 | 本机 SQLite `templates` | 中心 | 新增用户级同步 |
| 收件箱自定义标签及邮件打标 | 本机 SQLite `inbox_labels` 等 | 中心 | 新增用户级同步 |
| 邮件草稿 | 当前未见独立持久化表 | 中心 | 若目前仅内存保存，先补持久化再同步 |
| 发送任务定义 | 中心 `crm_campaigns` 与本机执行表并存 | 中心定义、本机执行 | 统一版本和领取凭据 |
| 临时发送队列 `send_queue` | 本机 SQLite | 本机执行、中心台账 | 上传批次和状态，暂停后再恢复 |
| 本地邮件正文、附件、收件缓存 | 本机 SQLite | 邮件服务器或对象存储 | 重新拉取；必要时按对象存储迁移 |
| 邮箱账号非敏感配置 | 本机 SQLite | 中心 | 恢复邮箱、主机、端口、显示名和签名 |
| 邮箱密码、授权码、OAuth 凭据 | 本机加密存储 | 仅本机 | 新设备重新授权 |
| IMAP UID、UIDVALIDITY、同步窗口 | 本机 SQLite | 可重建状态 | 新设备重新同步 |
| AI 会话、工作记忆、工具调用审计 | 本机 SQLite | 待定 | 产品需要跨设备就纳入中心；否则明确提示仅本机 |
| 日志、诊断和运行缓存 | 本机 | 仅本机 | 不迁移 |
| 设备 ID、会话令牌、`master.key` | 本机 | 仅本机 | 永不迁移 |

规则：任何用户以为“保存成功”的数据，都必须属于“中心已保存”“本机待同步且可恢复”或“可明确重建”之一，不能处于无人负责的本地孤岛。

## 4. 换机状态机

```text
idle
  -> preparing              旧设备检查、冻结、补传
  -> ready                  清单完成，可切换
  -> switching              中心原子撤销旧会话并创建新会话
  -> restoring              新设备恢复业务数据和缓存
  -> verifying              核对数量、版本和关键对象
  -> completed

preparing -> waiting_old_device   新设备等待旧设备响应
waiting_old_device -> lost_device_takeover  用户确认旧设备不可用
preparing|waiting_old_device|ready -> cancelled|expired
任意阶段 -> failed        可从中断点续跑或安全回退
```

### 状态要求

- `preparing`：旧设备只读，停止发送，禁止新建或修改业务数据。
- `ready`：旧设备清单和所有可同步对象上传完成；中心保存清单摘要。
- `switching`：中心事务内验证密码、锁用户、替换 session；失败不撤销旧会话。
- `restoring`：新设备从中心读取业务对象并重建本地缓存。
- `verifying`：至少核对对象数量、版本、最近更新时间、待处理队列和关键关联。
- `completed`：新设备可以发送；旧设备即使重新联网也不能继续写或发送。
- `lost_device_takeover`：旧设备无法响应时，用户明确确认风险后才允许；只能保证中心已确认数据，未上传本地状态标记为不可恢复。

## 5. 用户交互

### 新电脑首次登录

登录页在密码验证通过后显示：

- 原设备名称、平台、最后在线时间和最后同步时间。
- 待同步命令、草稿、标签、发送队列数量。
- 默认动作“准备换机并等待旧电脑完成”。
- 次动作“退出旧电脑并继续登录”仅在旧设备超时或用户明确选择“旧设备不可用”后出现。
- 新设备恢复过程显示阶段和可理解的进度，不展示 SQLite、游标或接口术语。

### 旧电脑收到换机请求

- 立即隐藏发送入口并停止调度器。
- 展示待处理对象数量和处理结果。
- 有冲突或不可同步项时禁止自动完成，要求用户先处理。
- 完成后切换为只读并提示账号已在新设备继续。
- 旧设备断网时保留待上传数据；重新联网后只能走恢复流程，不能自行恢复发送。

## 6. 中心契约

### Core 类型

```ts
type DeviceHandoffState =
  | 'preparing' | 'waiting_old_device' | 'ready' | 'switching'
  | 'restoring' | 'verifying' | 'completed'
  | 'cancelled' | 'expired' | 'failed';

interface DeviceHandoffManifest {
  handoffId: string;
  productId: 'crm';
  oldDeviceId: string;
  newDeviceId: string;
  domains: Array<{
    domain: 'contacts' | 'templates' | 'labels' | 'drafts' | 'sendQueue' | 'agent';
    itemCount: number;
    pendingCount: number;
    conflictCount: number;
    headVersion: string | null;
    digest: string;
  }>;
  generatedAt: string;
  expiresAt: string;
}
```

### HTTP 路由

| 路由 | 调用方 | 用途 |
| --- | --- | --- |
| `POST /api/auth/desktop/login` | 新设备 | 密码验证后发现不同活跃设备，返回 `DEVICE_HANDOFF_REQUIRED` 和短期 `handoffToken` |
| `GET /api/auth/desktop/handoff/:id` | 新/旧设备 | 查询状态、旧设备在线状态、清单进度 |
| `POST /api/auth/desktop/handoff/:id/prepare` | 旧设备 | 冻结并提交清单；会话仍有效 |
| `POST /api/auth/desktop/handoff/:id/ready` | 旧设备 | 所有同步对象上传完成后置为 ready |
| `POST /api/auth/desktop/handoff/:id/complete` | 新设备 | 原子替换会话并签发新凭据 |
| `POST /api/auth/desktop/handoff/:id/takeover` | 新设备 | 旧设备不可用时，经明确确认和审计后接管 |
| `POST /api/auth/desktop/handoff/:id/cancel` | 新/旧设备 | 取消未切换的交接 |
| `POST /api/crm/device-handoff/:id/flush` | 旧设备 | 按域批量上传草稿、标签、模板和队列状态 |
| `POST /api/crm/device-handoff/:id/verify` | 新设备 | 提交恢复核对结果，完成交接 |

所有返回继续使用 `{ ok, data?, error? }`，不在服务层抛裸对象或裸数组。

## 7. 数据库设计

### 中心公共表

```sql
CREATE TABLE public.identity_device_handoffs (
  handoff_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.identity_users(user_id),
  product_id text NOT NULL,
  old_device_id text NOT NULL,
  new_device_id text NOT NULL,
  state text NOT NULL,
  handoff_token_hash text NOT NULL,
  manifest jsonb,
  manifest_digest text,
  old_last_seen_at timestamptz,
  expires_at timestamptz NOT NULL,
  forced_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

索引：`(user_id, product_id, state)`、`expires_at`；`handoff_token_hash` 唯一。

### Prospector 用户数据表

- `prospector.email_templates`：用户模板，稳定 UUID、`owner_user_id`、`version`、`deleted_at`、幂等写入口。
- `prospector.inbox_labels`：稳定 UUID、用户、名称、颜色、版本、删除状态。
- `prospector.inbox_label_assignments`：用户、标签、稳定邮件键；邮件键由邮箱地址指纹和 Message-ID 组成，不依赖本机自增 ID。
- `prospector.email_drafts`：用户、发件邮箱、收件人、主题、正文、联系人引用、附件引用、版本、更新时间。
- 发送队列优先扩展既有 `crm_campaigns` / `crm_campaign_targets`，补用户临时批次表和发送领取状态；不建第二套任务系统。
- 附件继续使用 `artifact_ref` 元数据；在对象存储地址确定前，只支持迁移包或明确提示不可迁移。

### 本地同步表

在账号 SQLite 增加统一待同步表：

```sql
CREATE TABLE device_sync_outbox (
  domain text NOT NULL,
  object_id text NOT NULL,
  operation text NOT NULL,
  revision integer NOT NULL,
  idempotency_key text NOT NULL,
  digest text NOT NULL,
  payload text NOT NULL,
  status text NOT NULL,
  attempted_at text,
  confirmed_at text,
  error text,
  PRIMARY KEY(domain, object_id, revision)
);
```

联系人命令继续使用现有 `crm_contact_commands`，不重复迁移。

## 8. 同步与冲突规则

- 所有跨设备对象必须有稳定 UUID、版本号、软删除标记和幂等键。
- 本地写入和 outbox 入队在同一 SQLite 事务完成；网络提交在事务之外。
- 服务端成功回执后才能清空待上传 payload；未知网络结果必须原样重试。
- 换机前有 pending、conflict 或 failed 时默认不能完成正常交接。
- 旧设备离线期间产生的修改进入“孤立本地变更”，不能直接覆盖新设备已经确认的状态。
- 队列状态只允许单向推进：`draft -> scheduled -> claimed -> sending -> sent/failed/unknown`；不得从已发送退回 pending。
- 批量发送和自动任务在 SMTP 前必须持有短期设备租约；租约失效或中心明确拒绝时停止发送。
- 手动单封发送是否允许离线发送需要单独决定；无论是否允许，都不能复用同一队列对象重复发送。

## 9. 邮件与附件

- 不迁移邮箱密码和 OAuth 凭据；新设备只恢复非敏感配置，密码由用户重新输入。
- 收件箱历史按邮箱服务器重新拉取；首次窗口沿用“最近 90 天与最新 200 封并集”，再允许继续补拉。
- 本地搜索索引、联系人镜像和邮件分类临时缓存不迁移，全部可重建。
- 草稿附件是用户状态，换机完成前必须有去处：对象存储、可恢复迁移包或用户明确确认不带附件。
- 已通过 Prospector 发出的邮件至少保留收件人、主题、发件账号、时间、Message-ID、SMTP 回执和联系人引用；正文是否全量上传需单独决定，但不能只留在旧电脑。

## 10. 安全与恢复

- 先验证密码，再签发换机 token；token 短时、一次性、绑定用户、产品、中心和两个设备。
- 旧会话只在 `complete` 或受审计 `takeover` 时撤销；普通“开始换机”不踢旧设备。
- 不允许把 token、密码、`master.key`、OAuth 凭据写入 manifest、日志或审计 payload。
- 换机开始和结束写审计，记录设备名、平台、应用版本、清单摘要和结果，不记录业务正文。
- 新设备必须校验服务端返回的对象数量和版本，发现异常进入 `failed` 而不是宣称恢复成功。
- 旧设备重新联网发现会话已替换时，应停止所有写入、调度和外发，并只能展示恢复入口。

## 11. 实施顺序

### 阶段 0：数据盘点和契约

- 确认当前所有持久化用户状态，尤其是草稿是否只是内存态、哪些 Agent 数据需要跨设备。
- 新增 `server/core/device-handoff.ts`、`src/shared/device-handoff.ts` 和本地/服务端端口类型。
- 建立换机验收矩阵和禁止迁移字段清单。

### 阶段 1：换机状态机和登录替换

- 新增 `identity_device_handoffs` 迁移和仓库。
- 改造桌面登录冲突：从直接 `replaceActiveDevice=true` 改为 handoff token + 状态查询。
- 保留现有直接替换能力作为旧客户端兼容路径，但新客户端不再默认使用。
- 实现 complete 原子事务、旧会话撤销、审计和并发唯一设备保护。

### 阶段 2：换机前检查和待同步补传

- 新增本地 `DeviceHandoffService`，统一读取联系人命令、各域 outbox、发送队列和草稿状态。
- 旧设备进入只读并停止调度器、SMTP 和 Agent 写工具。
- 在 `ready` 前完成联系人命令和已有 outbox 补传；任何冲突都转为可见的待处理状态。
- 新设备登录页展示旧设备状态和不可迁移项。

### 阶段 3：中心化用户状态

- 模板、收件箱标签、草稿和 Agent 所需状态建表并提供统一版本/幂等接口。
- 本地旧数据首次升级时生成稳定中心 ID 映射。
- 所有页面从本地缓存读取时，仍以中心确认对象为权威；本地只做离线和加速。

### 阶段 4：发送队列和租约

- 将临时发送队列和活动任务纳入中心台账；本机只保存执行缓存。
- 增加短期设备和任务租约，SMTP 前再次校验租约、任务状态、联系人权限和消息幂等键。
- 迁移时导入的队列状态一律先暂停，用户确认后才能恢复。
- 完成晚到回执、重复点击、崩溃重启和旧设备重试测试。

### 阶段 5：新设备恢复与邮箱重建

- 登录成功后恢复联系人镜像、邮件标签、模板、草稿和发送队列状态。
- 邮箱账号只恢复非敏感配置；要求重新授权密码/授权码。
- 重建收件箱、Sent 检测、搜索索引和联系人邮件关联。
- 校验关键对象数量、版本、最近跟进、待发送队列和联系人引用；通过后才允许发送。

### 阶段 6：旧设备不可用分支

- 增加 `takeover`：旧设备超时、用户确认无法使用后接管账号。
- 明确展示“仅中心已确认数据可恢复，旧电脑未上传内容无法保证”。
- 旧设备之后重新上线时进入只读恢复入口，不自动写中心、不自动发送。

### 阶段 7：Navigator 共用协议

- 将 handoff 状态机、设备清单、审计和通用客户端 UI 抽为跨产品协议。
- Navigator 只实现自己的数据域适配器，不复制 Prospector 的队列和邮件实现。
- 统一管理端查看设备、最后在线、换机状态和撤销入口。

## 12. 验收矩阵

| 场景 | 必须结果 |
| --- | --- |
| 旧设备在线且无待同步 | 正常准备、切换、恢复、校验完成 |
| 旧设备有联系人命令待同步 | 未补传前不能完成正常换机 |
| 旧设备有草稿、标签或队列 | 新设备能恢复同一对象和状态 |
| 旧设备网络中断 | 可重试，不撤销旧会话，不丢待上传 payload |
| 切换事务中断 | 要么旧会话仍可用，要么新会话可用；不能两边都失效 |
| 新设备恢复中断 | 可继续恢复，不重复创建对象，不重复发送 |
| 新设备恢复完成前点击发送 | 拒绝发送并说明联系人或队列仍在恢复 |
| 旧设备已被替换后重新联网 | 停止写和发送，显示恢复入口 |
| 两台新设备同时尝试 | 只允许一个 handoff 完成，另一个得到明确冲突 |
| 旧设备丢失 | 通过显式 takeover 恢复中心数据，并记录未恢复本地数据风险 |
| 响应丢失后重放 | 幂等键和摘要一致，不产生重复对象或邮件 |
| 账号、中心或产品权限变化 | 立即停止 handoff，旧数据不泄露到新账号 |
| 测试扫描 | manifest、日志、审计和数据库查询中无密码、Token、Cookie、`master.key` |

## 13. 测试分层

- Core 单测：状态机、manifest、版本冲突、队列单向状态、幂等摘要。
- 隔离 PostgreSQL：迁移 checksum、事务边界、并发唯一活跃设备、换机 token、权限和审计。
- HTTP 集成：登录冲突、prepare、ready、complete、takeover、过期和重放。
- 原生 SQLite：outbox 事务、崩溃恢复、账号隔离、旧数据迁移映射。
- Electron 冒烟：两台真实渲染进程、断网、重启、旧设备只读、新设备恢复、发送前租约拒绝。
- 容量：10 万联系人、数千模板/标签/草稿和大型邮件缓存下的恢复时间、内存和 SQLite 写入。
- 安全审查：凭据不迁移、token 不落日志、服务端授权不能依赖桌面界面隐藏。

## 14. 发布与回滚

- 先在隔离中心和合成账号完成全链路，再使用真实账号做只读/回滚事务验证。
- 中心迁移与客户端发布分开；旧客户端遇到 `DEVICE_HANDOFF_REQUIRED` 时仍走旧替换兼容路径，并明确不具备完整换机能力。
- 新客户端首次升级先执行本地数据盘点并生成报告，不自动上传大文件。
- 任一阶段异常可回退到旧会话；一旦 complete 成功，只能通过再次 handoff 回退，不能恢复旧 refresh token。
- 正式 DDL、正式中心重启和安装包发布必须按现有维护窗口与回滚要求单独批准。

## 15. 需要先拍板的产品取舍

1. 批量/自动发送是否接受“必须有中心短期租约才能发送”。建议接受，否则无法保证旧设备断网后不重复发信。
2. 草稿附件是否必须跨设备恢复。建议必须，否则需要对象存储或迁移包后才能宣称完整换机。
3. Agent 会话、工作记忆和工具调用是否需要跨设备。建议先明确为个人同步数据或本机数据，不能含糊。
4. 邮件正文是否只在邮件服务器保留，还是 Prospector 发送历史也要保存完整正文。至少要保存可查询的发送记录和幂等回执。
