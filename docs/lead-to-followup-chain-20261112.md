# 运营线索到团队跟进链路契约（2026-11-12）

## 目标

打通并实地验证：运营导入线索 → 发布 → 分配给销售 → 销售接收 → 团队可见或逐人共享 → 客户跟进 → 联系人详情、消息中心和团队协作事实同步。

## 数据与状态契约

- 线索导入、发布、联系人分配继续使用现有 `crm_import_batches`、`crm_import_rows`、`crm_customers`、`contacts`、`crm_contact_assignment_requests`，不新增第二套线索表。
- 销售接收状态为 `pending → accepted`。接收成功后，联系人负责人写入 `crm_contact_ownership`。
- **团队可见**：由当前联系负责人一次性为本团队全部有效销售建立 `crm_contact_shares.status='accepted'` 的只读协作授权；不授予编辑、跟进、改阶段权限。重复执行只跳过已有授权，不重复插入。
- **逐人共享**：继续使用现有 `crm_contact_shares` 邀请/接受状态和 `editable_fields/can_followup/can_change_stage` 权限。
- 共享授权是否有效继续由 `validShareSql` 动态校验：联系人负责人变化、来源失效或账号失权后，旧授权不得继续放行。
- 团队可见和逐人共享都写入版本、幂等键和中心 outbox；共享本身与跟进事实同处中心 PostgreSQL，不使用页面私有状态。

## 原语与接口

| 环节 | 原语 / 接口 | 关键约束 |
|---|---|---|
| 导入 | `POST /api/crm/imports` | 预校验、幂等、逐行结果 |
| 发布 | `POST /api/crm/imports/:batchId/publish` | 版本校验、只发布有效来源行 |
| 分配 | `POST /api/crm/contact-assignments` | 运营权限、联系人锁定、负责人/活动分配校验 |
| 接收 | `POST /api/crm/contact-assignments/:requestId/accept` | 版本校验、接收人权限、原子写 ownership |
| 团队可见 | `online:contact-share-team` → `POST /api/crm/contact-shares/team` | 负责人一次性授权本团队有效销售，只读、幂等 |
| 逐人共享 | `online:contact-share-create/decide` | 逐人授权、接受后生效 |
| 跟进 | `online:contact-followup` → `POST /api/crm/contacts/:contactId/followups` | 版本校验、原子写活动与联系人状态、发 outbox |

## 同步通道

跟进写入后同时进入：

- 联系人详情活动时间线；
- 团队可见成员和逐人共享成员的可见详情；
- 中心 `identity_outbox`，投递到消息中心；
- 团队监控和后续 CRM 聚合可读取的活动事实；
- 本地联系人镜像增量同步。

## 删除与修复

- 联系人负责人变化或共享授权失效后，旧 `crm_contact_shares` 不物理删除；读取时通过有效授权条件排除，并显示为结束/撤销。
- 重复团队可见请求由联系人版本和幂等回执保护；不产生重复授权。
- 异常中断由中心事务回滚；已提交共享和跟进事件由 outbox 重试，不靠前端补偿。

## 实地验证（2026-11-12）

使用真实本地中心 HTTP + PostgreSQL，临时运营账号和 Daisy 组销售账号执行：

1. 导入：`created`。
2. 发布：1 个客户。
3. 分配：`pending` 给销售01。
4. 接收：`accepted`。
5. 团队可见：`我是daisy` 新增 6 名团队销售。
6. 团队内销售02读取该联系人成功。
7. 团队外临时销售逐人共享并接受成功。
8. 销售01记录电话跟进成功。
9. 团队可见销售02和逐人共享销售均能在联系人详情看到该跟进。
10. 中心 outbox 同时存在 `crm.contact.team_visible` 和 `crm.contact.followup`，消息中心收到对应事件。

限定边界：团队可见按当前团队成员快照建立授权；后续新增成员需要再次执行团队可见，后续节点应增加团队成员变化时自动补授权。历史重复通知不自动回删。
