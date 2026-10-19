# N7 服务端持续任务审查（方向已撤销）

> 用户已确认不采用线上托管发信。本文保留历史审查证据，N7 后续 Worker、凭据接入和真实外发均不再实施。

日期：2026-10-16

## 结论

当前项目没有“客户端关闭后继续自动开发客户”的服务端 Worker。已有的中心任务调度器只处理 CRM 跟进任务到期提醒；自动开发任务仍保存在每台设备的 SQLite，并由 Electron 主进程扫描和调用本地 SMTP。因此，直接把现有 Campaign 轮询搬到中心会造成任务重复执行、凭据越权和 SMTP 结果不确定时盲目重发。

本审查不启用真实发信、不迁移现有 Campaign、不改变前端，也不把本地任务标记为已上云。

## 可复用的安全基础

| 现有部件 | 可复用能力 | 不能直接承担的职责 |
| --- | --- | --- |
| `server/adapters/task-dispatcher.ts` | 服务重启后继续扫描、串行 tick、停止时等待当前扫描结束 | 只有跟进提醒，没有 Campaign 触点或发送执行 |
| `PostgresTaskRepository.processDue()` | `FOR UPDATE SKIP LOCKED`、事务锁、有效负责人复核、唯一到期回执 | 不能记录邮件发送租约和未知 SMTP 结果 |
| `identity.outbox` / notification dispatcher | 持久事件、通知去重与权限过滤 | 不能代替任务状态机，也不能作为邮件发送许可 |
| `crm_lead_idempotency` | 操作人/操作/键/摘要幂等 | 需要按 Campaign 目标和触点序号建立独立执行键 |
| 本地 `campaign.service.ts` | 触点计划、模板选择、账号策略、止损逻辑 | 依赖本地 SQLite、邮箱账号和本地 SMTP，关闭客户端即停止 |

## 当前缺口

1. 中心 PostgreSQL 没有 Campaign 定义、触点账本、执行租约或发送回执表。
2. 计划内容和联系人引用只在本地 `send_campaigns`、`send_campaign_targets` 保存。
3. 中心没有服务端受控邮箱凭据；Windows 本地 DPAPI 密文不能直接搬给服务器。
4. 发送结果可能处于“邮件服务器已接受但中心未收到回执”的未知状态，不能自动改回 pending。
5. 旧客户端与未来 Worker 没有执行权切换标记，双端同时扫描会产生重复发送风险。

## 推荐的 N7-1 最小边界

先只建立可恢复的中心任务基底，不执行邮件：

```text
客户端确认计划
  -> 中心保存 campaign + targets + 触点内容指纹
  -> 状态 awaiting_confirmation / scheduled / paused
  -> Worker 仅领取到期目标并写入 lease
  -> dry-run 记录 planned / blocked / revoked
  -> outbox 通知状态变化
```

建议新增三组中心事实：

- `crm_campaigns`：计划、创建人、状态、版本、停止原因、确认时间。
- `crm_campaign_targets`：联系人中心引用、客户版本、轮次、下一触点时间、状态、租约和重试次数。
- `crm_campaign_attempts`：一次执行尝试的幂等键、状态（`planned`、`accepted`、`rejected`、`unknown`）、错误摘要和回执时间。

所有领取使用事务、`FOR UPDATE SKIP LOCKED` 和短租约；唯一键至少覆盖 `campaign_id + contact_id + round` 与 `execution_key`。暂停、撤权、转派和退订在领取及执行前都重新核验。默认状态不得自动执行，必须存在明确的人工确认事实；到期提醒也不能等同于发信授权。

## 后续分界

- N7-1：只做中心模型、租约、状态机、幂等和 dry-run 测试。
- N7-2：设计服务端凭据接入与执行权切换；仍使用替身邮箱，不发真实邮件。
- N7-3：在隔离邮箱上验证 accepted/rejected/unknown、重启恢复和撤权止损。
- N7-4：单独批准后才接真实外发，并保留“SMTP 接受不等于送达”的状态语义。

## 当前验收边界

## N7-1 实施结果（2026-10-16）

N7-1 已落地为中心任务底座：新增 `crm_campaigns`、`crm_campaign_targets`、`crm_campaign_attempts`、`crm_campaign_receipts` 四张表及 `026-server-campaigns-n7` 迁移；中心服务已注册 `/api/crm/campaigns` 创建、列表、详情、确认、暂停、添加触点、dry-run 领取和回执路由。

本节点只允许 `auto_send=false`。领取使用事务锁、`FOR UPDATE SKIP LOCKED`、短租约和唯一 `execution_key`；确认、暂停、版本、联系人版本和权限会在服务端复核。没有邮箱凭据、SMTP 调用、后台 Worker、前端入口或真实外发，因此它证明的是任务账本和执行边界可用，不代表关机后已经开始自动发信。

N7-1 验证：server TypeScript 编译通过，专项单元测试 3 项通过，中心 PostgreSQL 回归测试 10 项通过，架构边界检查通过。`unknown` 回执会保留为未知状态，不会被压成失败；已确认任务暂停、联系人撤权或版本变化时，`accepted` 会被拒绝。下一节点仍需单独批准后再做 Worker 与替身邮箱验证。
