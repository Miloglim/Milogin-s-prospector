# 线索范围、重叠标记与成交通知边界

状态：业务规则已确认；数据库范围重叠、导入标记、成交幂等通知和消息展示已在 0.71.0-alpha.17 工作区实现。正式中心尚未执行 065 迁移。

## 一句话

管理员运营线索和用户自有线索按业务范围分别保存；相同或相似客户不强制拦截，只做标记、确认和通知。运营池内部由管理员保证不重复导入，用户自有线索继续用于自动开发信。

## 范围标识

每条客户/联系人必须能直接得到两个范围字段：

- `origin=operations`：管理员上传的运营共享线索。
- `origin=personal`：用户自有线索。
- `owner_user_id`：个人线索所属用户；运营共享线索为空。
- `created_by`：实际上传人，只用于留痕，不直接决定归属。

当前 `crm_customers` 已有 `origin/owner_user_id/created_by`，但 `contacts` 没有这些字段，唯一索引又直接建在邮箱上。因此实现时必须把范围字段冗余到联系人，或在同一事务中建立可索引的 `scope_key`。

## 允许重复的范围

### 运营共享池

- 同一邮箱在运营共享池内应当只有一条。
- 管理员导入时如果运营池已有相同邮箱或高度相似公司，必须显示标记并让管理员确认；系统不做跨管理员静默合并。
- 管理员确认重复是错误时应修改文件或选择已有公司；确认要新录时应保留明确来源和审批记录。

### 用户自有线索

- 同一邮箱可以在运营池和多个用户自有范围中各存一份。
- 同一邮箱在同一用户范围内重复时，标记为该用户重复线索。
- 用户自有线索仍可正常进入自动开发信，不因运营池存在同一邮箱而被禁止。

### 跨范围重复

- 相同邮箱：标记为联系人级重叠。
- 同一公司+国家：标记为公司级重叠。
- 同一公司不同国家：视为不同公司或分支机构，不做公司级重叠。
- 相似公司：标记为疑似重叠，要求人工确认但不阻断导入。

## 导入规则

1. 先按当前业务范围计算邮箱和公司匹配。
2. 当前范围内完全重复：显示“已有线索”，默认关联或跳过。
3. 当前范围内相似：显示疑似重复，用户确认后可继续。
4. 其他运营/用户范围存在相同联系人：允许导入，写入重叠关系并显示“其他范围已存在”。
5. 其他范围存在同一公司+国家：允许导入，写入公司级重叠标记。
6. 所有跨范围冲突只生成标记和通知，不覆盖原归属，不把其他范围的数据暴露给当前用户。

## 成交与通知

- `closed_won` 商机或 `relationship_stage=cooperating` 视为成交/合作后。
- 一个用户成交后，系统按同一联系人，或同一公司+国家，查找其他范围内的活跃线索。
- 对每个命中范围的负责人发送一次幂等通知，内容只显示可见的归属人/团队和重叠对象。
- 其他用户的自动开发任务默认暂停，等待确认停止或申请协作；历史邮件、跟进、任务和商机不删除。
- 成交范围自身继续正常使用。
- 重复触发同一成交事件不能重复通知。

## 数据模型实现

### 联系人范围字段

新增迁移为 `contacts` 增加：

| 字段 | 说明 |
|---|---|
| `origin` | `operations / personal` |
| `owner_user_id` | 个人线索负责人，运营共享池为空 |
| `scope_key` | 运营池固定值或用户 UUID，用于建立范围唯一索引 |
| `created_by` | 上传人留痕 |

回填时通过 `crm_customer_contacts -> crm_customers` 得到每条联系人的 `origin/owner_user_id/created_by`。

### 唯一约束

移除当前全局 `idx_contacts_email`，改为：

- 运营池：`UNIQUE(scope_key, lower(btrim(email))) WHERE origin='operations'`
- 个人范围：`UNIQUE(scope_key, lower(btrim(email))) WHERE origin='personal'`

这样同一邮箱可以同时存在于运营池和多个用户范围，但同一范围内部仍可识别重复。

### 重叠记录

新增 `crm_lead_overlaps`：

| 字段 | 说明 |
|---|---|
| `overlap_id` | 主键 |
| `source_contact_id / target_contact_id` | 发生重叠的两条联系人 |
| `match_type` | `same_email / same_company_country / similar_company` |
| `status` | `open / confirmed / ignored / won` |
| `created_at / updated_at` | 时间 |

同一对联系人相同 `match_type` 只保留一条，避免导入和成交重复生成。

### 成交通知

新增 `crm_deal_overlap_notices`：

| 字段 | 说明 |
|---|---|
| `notice_id` | 主键 |
| `overlap_id` | 对应重叠记录 |
| `winner_contact_id` | 成交范围联系人 |
| `recipient_user_id` | 其他范围负责人 |
| `opportunity_id` | 成交商机 |
| `status` | `pending / acknowledged / stop_requested / collaboration_requested` |
| `version` | 协调状态版本 |

唯一键：`(opportunity_id, recipient_user_id)`。

## 接口实现

- `online:preview` 预览结果增加 `overlapWarnings`：范围、匹配类型、可见归属、是否允许继续。
- `online:import` 回执增加 `overlapIds` 和 `warning`，不允许把跨范围重叠当硬失败。
- 新增 `GET /api/crm/lead-overlaps` 查询当前用户可见的重叠提示。
- 新增 `POST /api/crm/lead-overlaps/:noticeId/acknowledge`，接收版本、幂等键和 `stop / request_collaboration` 动作。
- 成交事件在 `crm_opportunities` 进入 `closed_won` 或客户进入 `cooperating` 时同步生成重叠通知。
- 自动开发发送前检查 `crm_deal_overlap_notices` 和联系人关系状态，命中 `pending` 时阻止后续发送。

## 分阶段上线

1. **范围迁移**：增加联系人范围字段，回填，双写旧客户/联系人关系。
2. **索引切换**：先建新范围索引，验证无冲突后移除全局邮箱唯一索引。
3. **重叠标记**：导入预览显示当前范围重复、跨范围相同、相似公司。
4. **成交通知**：接入 `closed_won/cooperating`，生成幂等通知和自动开发暂停。
5. **界面接入**：导入预览、消息中心、联系人详情和任务页。
6. **旧数据稳定后再处理历史全局唯一冲突**，不直接删除旧客户或联系人。

## 验收场景

- 运营池已有某邮箱，用户仍可导入自己的同类线索并正常发开发信，同时看到“运营池已存在”标记。
- 用户 A 和用户 B 各自导入同一邮箱，两份自有线索都可跟进；双方在成交前不会被系统硬拦截。
- 用户 A 成交后，用户 B 只收到一次通知，B 的自动发送暂停，历史数据保留。
- 运营池内部重复邮箱在管理员导入时被标记，不自动覆盖已有运营线索。
- 同一公司不同国家的联系人不会触发公司级通知，除非邮箱相同。
- 相似公司显示疑似标记，由导入人确认，不直接阻断。

0.71.0-alpha.17 已落地 `065-lead-scope-overlaps`、导入重叠回执、`closed_won` 幂等通知和消息中心提醒；未新增依赖、导入 HTTP/IPC 路由或生产写入。正式部署前仍需在维护窗口执行迁移并完成蓝绿切流。
