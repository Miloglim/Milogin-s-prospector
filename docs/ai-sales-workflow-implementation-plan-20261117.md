# AI 驱动销售工作流代码实现与优化方案

日期：2026-11-17  
状态：实施基线，供后续代码实现使用  
产品设计：[ai-sales-workflow-design-20261117.md](ai-sales-workflow-design-20261117.md)  
源码检查点：`D:\Agent Basement\checkpoints\pre-ai-20261117T152309Z`

## 1. 实施目标

在不新增 AI 工作区、AI 发送队列或用户可见 AI 模式的前提下，把 AI 内化到现有发送中心、收件箱、联系人、待办和团队协作中。

实现必须满足：

- 冷开发复用现有 Campaign。
- 询盘报价复用现有收件箱和发送入口。
- 主管审核复用现有团队消息和任务。
- AI 只生成内部建议、草稿、摘要和状态推进。
- 外发、最终报价和跨权限操作仍受现有权限及确认约束。

## 2. 不可违反的边界

1. 不新增第二条 SMTP 发送通道。
2. 不新增面向用户的“AI 模式”“AI 分析”“让 AI 处理”按钮。
3. 港口、船司、柜型、价格和截止时间不得由模型凭空补全。
4. AI 不得自行提高 Campaign 限额、跳过确认或启动外发。
5. 中心 AI 用量表不得保存完整邮件正文、附件和模型完整响应。
6. 新增契约必须先定义共享常量和类型，再写实现。
7. 新增依赖先审批；优先复用现有库和标准库。
8. 所有异步副作用必须幂等，可重试且可审计。

## 3. 分层与模块落点

### 3.1 共享契约

新增：

- `server/core/sales-case.ts`
- `server/core/quote-case.ts`
- `server/core/assistant.ts`
- `src/shared/sales-case.ts`
- `src/shared/quote-case.ts`
- `src/shared/assistant.ts`

职责：

- 枚举状态、事件类型、动作类型
- 纯状态迁移函数
- 请求/响应类型
- 统一错误码
- 字段 schema 和证据结构

禁止在这些文件内访问数据库、Electron、网络或文件系统。

### 3.2 中心核心服务

新增：

- `server/services/sales-cases.ts`
- `server/services/quotes.ts`
- `server/services/assistant-brief.ts`

职责：

- Case 授权和状态编排
- AI 建议接受、忽略、修改
- 报价版本、主管审核和回执
- 生成每日助手摘要的业务规则

### 3.3 中心 PostgreSQL 适配器

新增：

- `server/adapters/postgres/sales-case-schema.ts`
- `server/adapters/postgres/sales-case-repository.ts`
- `server/adapters/postgres/quote-case-schema.ts`
- `server/adapters/postgres/quote-case-repository.ts`
- `server/adapters/postgres/assistant-projection-repository.ts`

所有迁移采用追加式版本；已实现的 080 之后只追加，不重写旧迁移：

- `080-ai-sales-workflow-foundation`
- `081-deal-won-proposals`
- `082-ai-sales-workflow-integrity`

迁移只新增表、索引和可空列，不重写已有 Campaign、联系人、任务和文件表。

### 3.4 中心 HTTP

新增：

- `server/transport/sales-case-http.ts`
- `server/transport/quote-http.ts`
- `server/transport/assistant-http.ts`

路由建议：

- `GET /api/crm/sales-cases`
- `GET /api/crm/sales-cases/:id`
- `POST /api/crm/sales-cases/:id/actions`
- `GET /api/crm/quote-cases`
- `GET /api/crm/quote-cases/:id`
- `POST /api/crm/quote-cases/:id/requery`
- `POST /api/crm/quote-cases/:id/revisions`
- `POST /api/crm/quote-cases/:id/review`
- `GET /api/crm/assistant/brief`
- `POST /api/crm/assistant/suggestions/:id/act`

继续使用现有 `{ ok, data?, error? }` 返回结构。

### 3.5 桌面主进程

新增或扩展：

- `src/main/services/sales-case.service.ts`
- `src/main/services/lead-campaign-planner.service.ts`
- `src/main/services/inquiry-analyzer.service.ts`
- `src/main/services/quote-orchestrator.service.ts`
- `src/main/services/send-rate-governor.service.ts`
- `src/main/services/assistant-brief.service.ts`
- `src/main/services/ai-feedback.service.ts`

原则：

- `core` 只做状态和算法。
- `services` 编排业务，不直接读取 Electron 或 HTTP。
- `transport` 只转接 IPC/HTTP。

### 3.6 渲染端

新增：

- `src/renderer/pages/inbox/InquiryQuoteCard.tsx`
- `src/renderer/pages/inbox/AssistantBriefPopover.tsx`
- `src/renderer/pages/contacts/SalesCaseNextAction.tsx`
- `src/renderer/pages/campaigns/CampaignTaskPrefillBanner.tsx`

修改：

- `CampaignWizard.tsx`：读取预填草稿，不增加 AI 模式。
- `CampaignTasks.tsx`：显示“待确认事项”和数量。
- `InboxList.tsx`：邮件/联系人旁展示询盘和报价状态。
- `Sidebar.tsx`：Logo 助手状态和轻量简报。

不新增导航入口。

## 4. 数据模型

### 4.1 `crm_sales_cases`

| 字段 | 说明 |
|---|---|
| `case_id` | UUID 主键 |
| `customer_id` | 中心客户 UUID |
| `contact_id` | 中心联系人 ID |
| `owner_user_id` | 当前负责人 |
| `state` | Case 状态 |
| `source` | 导入、手工、回复、系统建议 |
| `verified_at` | 验证通过时间 |
| `latest_message_key` | 最新邮件键 |
| `latest_summary` | 增量摘要 |
| `next_action` | 业务下一步 |
| `next_action_at` | 下一动作时间 |
| `stop_reason` | 暂停/流失原因 |
| `version` | 乐观锁版本 |
| `created_at/updated_at` | 时间戳 |

索引：

- `(owner_user_id, state, next_action_at)`
- `(customer_id, updated_at DESC)`
- `(contact_id, updated_at DESC)`
- 唯一约束：同一联系人、同一负责人只保留一个开放 Case

### 4.2 `crm_case_events`

| 字段 | 说明 |
|---|---|
| `event_id` | BIGSERIAL |
| `case_id` | Case ID |
| `event_key` | 幂等键，唯一 |
| `event_type` | 事件类型 |
| `source` | rule/ai/user/system |
| `payload_json` | 结构化事件 |
| `evidence_json` | 邮件、任务、报价证据 |
| `actor_user_id` | 用户或系统 |
| `created_at` | 时间戳 |

事件只追加，不更新。

### 4.3 `crm_ai_proposals`

| 字段 | 说明 |
|---|---|
| `proposal_id` | UUID |
| `case_id` | 所属 Case |
| `proposal_type` | campaign_draft/reply_draft/quote_draft/followup/deal_won |
| `status` | pending/applied_pending_confirmation/accepted/edited/ignored/cancelled/expired |
| `payload_json` | 建议对象 |
| `evidence_json` | 证据 |
| `confidence` | 0–1 |
| `model/version` | 模型与策略版本 |
| `expires_at` | 过期时间 |
| `acted_by/acted_at` | 用户处理 |

### 4.8 `deal_won` 先写后撤销

`deal_won` 是唯一允许“先更新状态、再提示用户”的 AI 建议类型。触发条件必须是客户合同、订单、订舱确认或明确按报价执行等可引用特征，且必须保存原文证据、置信度和来源邮件。

状态处理：

1. AI 命中成交特征后，在中心事务中创建 `deal_won` 建议，状态直接写为 `applied_pending_confirmation`。
2. 有唯一匹配开放商机，且金额、币种、证据齐全时，同一事务推进为 `closed_won`；同时保存上一阶段、金额、币种、证据和版本快照。
3. 没有唯一商机或关键字段不齐时，只更新客户级“AI 已记录成交（待确认）”投影，并提示用户补全商机，不猜金额、币种、合同号或订单号。
4. 用户取消时，将建议改为 `cancelled`，恢复可撤销的客户/商机快照并追加审计；原邮件、活动和证据保留。
5. 提示必须常驻在消息中心或客户详情，直到用户处理；不能只用会自动消失的 toast，也不能提供“忽略后继续显示成交”。
6. 客户等级、销售业绩和跨范围成交通知只读取满足现有证据规则的成交事实；AI 待确认状态可以显示在业务界面，但不能用模型推断冒充最终成交业绩。

### 4.4 `crm_quote_cases`

| 字段 | 说明 |
|---|---|
| `quote_case_id` | UUID |
| `case_id` | 销售 Case |
| `message_key` | 来源邮件 |
| `thread_key` | 会话键 |
| `state` | fields_pending/querying/ready/review/sent/won/lost |
| `fields_json` | 结构化运输字段 |
| `missing_fields_json` | 缺失字段 |
| `selected_quote_json` | 当前选择 |
| `version` | 乐观锁 |

### 4.5 `crm_quote_drafts` / `crm_quote_revisions`

`crm_quote_drafts` 保存当前报价草稿，`crm_quote_revisions` 保存不可变历史。

必须记录：

- 来源邮件和原文证据
- 查询条件
- 候选运价
- 用户修改
- 主管意见
- 发送状态

### 4.6 `crm_quote_review_requests`

- 报价草稿
- 请求人
- 审核人
- 状态
- 审核意见
- 关联团队消息或任务 ID

### 4.7 本地 SQLite

本地只新增：

- Case/Quote 的离线读模型缓存
- 发送速率窗口和预约
- AI 建议缓存
- 反馈 outbox

不能把中心唯一事实复制成第二套可独立修改的真源。

## 5. 状态机与纯函数

### 5.1 Case 状态

```text
lead_pending
lead_verified
outreach_ready
outreach_running
awaiting_reply
replied
inquiry_detected
quote_preparing
quote_review
quote_sent
negotiating
won
lost
paused
```

必须实现：

- `canTransitionSalesCase(from, to, actor, context)`
- `nextSalesCaseAction(case)`
- `isSalesCaseTerminal(state)`
- `caseStopReasonFromReply(replyClassification)`

### 5.2 Quote 状态

```text
detected
fields_pending
queries_prepared
querying
candidates_ready
draft_ready
review_pending
review_rejected
approved
sent
accepted
rejected
expired
```

必须实现：

- `canTransitionQuote`
- `quoteMissingRequiredFields`
- `mergeQuoteFieldEdit`
- `quoteNeedsRequery`

### 5.3 AI 建议状态

```text
pending
applied_pending_confirmation
accepted
edited
ignored
cancelled
expired
blocked
```

用户修改建议时，原建议标记 `edited`，另写反馈事件。

## 6. 冷开发自动准备

### 6.1 触发

- 导入联系人验证完成后
- 每日扫描已验证但无开放 Campaign 的 Case
- 用户打开发送中心且存在待处理草稿

### 6.2 验证流水线

顺序固定：

1. 本地确定性规则
2. 主数据匹配
3. AI 业务相关性建议
4. 用户确认必须项
5. 创建 Campaign 草稿

任何确定性失败不交给 AI 覆盖。

### 6.3 分组算法

`lead-campaign-planner` 输出 cohort：

- 负责人/团队优先
- 语言/国家
- 客户类型
- 航线/货种
- 可用账号池
- 发送容量

每 cohort 生成一个 CampaignDraft。

输入规模较大时：

- 单次最多 200 个联系人进入规划
- 每 200 个联系人最多生成 10 个 cohort
- 多余联系人进入下一批，不创建大量碎片任务

### 6.4 内容准备

新增 `CampaignContentPort`：

```ts
interface CampaignContentPort {
  prepare(input: CampaignContentInput): Promise<Result<CampaignPreparedContent>>;
}
```

规则：

- fixed/userTpl/system 保持现有逻辑。
- adaptive 可使用上下文建议，但用户界面不新增 AI 模式。
- 同 cohort 只生成一次公共内容。
- 变量替换使用确定性模板。
- 高价值 Case 可单独生成，最多 1 次重试。

内容指纹：

```text
contact_snapshot + case_summary_version + template_version + policy_version
```

指纹相同直接复用缓存。

## 7. 发送速率治理

### 7.1 模块

纯逻辑：

- `src/main/core/send-rate-governor.ts`

IO 服务：

- `src/main/services/send-rate-governor.service.ts`

本地表：

- `send_rate_reservations`
- `send_rate_events`

字段：

- account_id
- recipient_domain
- reserved_at
- expires_at
- state
- message_key

### 7.2 硬规则

- 全局 3600 秒窗口硬上限 180
- 全局 60 秒窗口硬上限 10
- 软目标 150/小时
- 单账号默认 40/小时
- 单域名默认 20/小时
- 平均间隔至少 20 秒，实际随机 20—40 秒

未来可由管理员降低，不能通过普通用户配置提高。

### 7.3 调度

发送前：

1. 查询窗口计数
2. 申请 reservation
3. 进入队列
4. SMTP 前再次确认 reservation 有效
5. 成功/失败后写入事件

并发安全：

- 使用 SQLite `IMMEDIATE` 事务申请配额。
- reservation 有过期时间，崩溃后可回收。
- 同一 message_key 只允许一个 open reservation。

### 7.4 异常退避

- `421/450/451/454`：指数退避
- 账号认证失败：暂停账号
- 连续限流：降低账号速率 50%
- 退信率超过阈值：暂停 Campaign
- 所有退避写事件账本，不仅保存在内存

## 8. 询盘分析

### 8.1 触发

- 邮件分析 ready 且分类为询盘
- 客户邮件正文、主题或引用中出现运输需求

### 8.2 字段 schema

```ts
interface InquiryFields {
  pol?: FieldValue;
  pod?: FieldValue;
  containerTypes?: FieldValue;
  quantity?: FieldValue;
  commodity?: FieldValue;
  weight?: FieldValue;
  carrierPreference?: FieldValue;
  carrierExclusion?: FieldValue;
  etd?: FieldValue;
  validity?: FieldValue;
  incoterm?: FieldValue;
  specialRequirements?: FieldValue;
  targetPrice?: FieldValue;
}
```

`FieldValue` 必须包含：

- value
- source: email/quote/history/user
- evidence
- confidence
- resolver

### 8.3 解析顺序

1. 现有邮件分析规则
2. 本地字典：港口、船司、柜型、常见缩写
3. LLM 结构化抽取
4. 本地字典再次校验
5. 无法解析字段进入 missing

### 8.4 自动查价条件

- POL/POD 至少一项明确
- 柜型或货物类型明确
- 或者查询策略允许按航线搜索候选后提示缺失

关键字段不足时：

- 不伪造查询
- 生成追问草稿
- Case 保持 `fields_pending`

## 9. 报价查询与卡片

### 9.1 查询适配器

`quote-orchestrator.service.ts` 通过现有 Navigator 查询端口执行：

- 结构化查询
- 最多 5 个查询方案
- 每个方案有超时和取消
- 去重
- 最多返回 20 个候选

查询 hash：

```text
normalized_fields + navigator_data_version + query_policy_version
```

短期缓存建议：

- 相同查询 5 分钟内直接复用
- 价格/有效期数据版本变化时失效

### 9.2 排名

排序权重：

- 条件完全匹配
- 价格
- 有效期
- ETD
- 数据新鲜度
- 船司/用户偏好

每项必须可解释，不能只给一个分数。

### 9.3 报价卡生命周期

- 邮件选中时加载对应 quote case
- 悬浮卡默认延迟 150ms 打开，避免切换邮件闪烁
- 关闭只隐藏投影，不改变状态
- 字段修改 debounce 300ms
- 新查询取消上一查询
- 用户选择后写 revision

### 9.4 主管审核

- 由 quote draft 创建 review request
- 复用团队消息/任务
- 审核结果写回 quote revision
- 不允许通过消息正文解析审批结果

## 10. Logo 助手

### 10.1 数据来源

复用：

- 今日任务
- 新回复
- 待报价
- 即将过期报价
- 异常发送
- 待确认 Campaign

### 10.2 输出限制

- 最多 3 条
- 每条包含 action 和 target route
- 相似建议去重
- 已忽略建议 24 小时内不再出现
- 无事项时不生成动画

### 10.3 前端

- Logo 状态由 CSS class 表达，不动主布局。
- `prefers-reduced-motion` 时禁用动画。
- 简报弹层最大宽度 360px。
- 关闭、路由切换和操作完成立即清理。

## 11. UI 引导

只支持四类轻量引导：

1. 现有按钮轻微高亮
2. 旁边显示一个业务数字或状态
3. 列表行显示下一步动作
4. Logo 显示待处理数量

规则：

- 同时最多一个高亮
- 7 秒后自动降级
- 用户点击、忽略、切换页后取消
- 不使用连续多步 coach mark
- 不遮挡表格和邮件正文

## 12. 反馈账本

新增 `crm_ai_feedback_events`：

- user_id
- object_type/object_id
- action: accepted/edited/ignored/requeried/sent/approved/rejected
- before_json/after_json
- reason
- created_at

不在首期做模型训练；只做统计和策略调整。

## 13. 性能预算

### 中心 API

- 列表 P95 < 500ms
- 详情 P95 < 800ms
- 写操作 P95 < 1s

### 桌面主进程

- 释放 UI 前不等待 AI
- 邮件切换不触发同步网络请求
- 报价查询后台执行，可取消
- 单次 IPC 返回 < 100KB，分页除外

### 渲染

- 不新增整页高频轮询
- Logo 简报靠进入、聚焦、事件推送刷新
- 报价卡切换邮件时 150ms 内不显示 loading 闪烁
- 长列表继续使用虚拟滚动

### AI

- 每 cohort 1—2 次模型调用
- 同一内容指纹缓存
- 单次失败最多重试 1 次
- 超时后回退模板

## 14. 日志与审计

日志格式：

```text
[时间] [级别] [sales-case|quote|assistant|send-rate] 消息
```

审计事件：

- 建议创建/接受/忽略
- Campaign 自动准备
- 用户确认
- 报价查询
- 报价修改
- 主管审核
- 发送预约和限流暂停

错误信息不得包含邮件正文、密钥或完整模型响应。

## 15. 测试矩阵

### 单元测试

- Case 状态迁移
- Quote 状态迁移
- 字段缺失判断
- 发信速率 Governor
- 内容指纹和缓存
- 建议去重和过期

### PostgreSQL 集成

- 迁移幂等
- Case/Event 追加
- 乐观锁冲突
- Quote revision 不可变
- 审核权限和团队隔离

### IPC/HTTP 契约

- 通道唯一注册
- `{ok,data,error}` 一致性
- 参数校验
- 幂等键重放

### 渲染测试

- Campaign 待确认项
- 询盘报价卡
- 关闭后状态保留
- 字段修改后重新查询
- Logo 无事项静止
- 引导高亮只出现一次

### 桌面端到端

1. 导入已验证线索
2. 自动出现 Campaign 草稿
3. 用户确认必要项
4. 发送队列执行
5. 模拟客户回复
6. Campaign 停止并生成询盘
7. Navigator 返回候选运价
8. 用户修改柜型并重新查询
9. 请求主管审核
10. 通过现有发送入口回复

## 16. 分阶段实施任务

### 阶段 A：基础契约和事件

1. 新增 Case/Quote/Proposal 类型与状态机。
2. 新增 076/077/078 迁移和仓储。
3. 新增 HTTP/IPC 契约。
4. 接入导入、回复、退信事件。

验收：Case 可创建、查询、推进；所有事件幂等可审计。

### 阶段 B：Campaign 自动准备

1. 新增 lead campaign planner。
2. 导入后生成 Campaign 草稿。
3. UI 显示待确认项。
4. 接入内容端口和内容缓存。
5. 接入速率 Governor。

验收：200 条线索不会生成 200 个任务；180/小时硬上限不可绕过。

### 阶段 C：询盘识别和报价

1. 新增询盘 schema 和解析器。
2. 接入 Navigator 查询适配器。
3. 新增 QuoteDraft/Revision。
4. 新增邮件侧报价浮层。
5. 接入主管审核。

验收：询盘无需用户点分析即可生成报价卡；关闭后可恢复。

### 阶段 D：Logo 助手与引导

1. 新增 brief projection。
2. Logo 状态和弹层。
3. 下一步按钮高亮。
4. 隐式反馈采集。

验收：无事项静止，最多 3 条建议，不阻塞主界面。

### 阶段 E：优化和评估

1. 回复率、询盘率、报价采用率报表。
2. 内容指纹命中率。
3. Navigator 查询耗时和命中率。
4. 建议接受/忽略率。
5. 限流和退信趋势。

验收：所有指标可追溯，不依赖人工估算。

## 17. 低级模型执行约束

给执行代码的模型必须遵守：

1. 每次只实现一个阶段，先契约后实现。
2. 修改公共 API 前先搜索全部调用点。
3. 先写或同步测试，再改核心状态逻辑。
4. 不删除现有功能，不恢复已取消的功能文件夹、AI 模式或第二发送通道。
5. 不新增依赖；如确需依赖，停止并说明。
6. 不修改真实用户数据、生产数据库、密钥和发布产物。
7. 每阶段完成后运行 typecheck、相关测试、build、架构检查和差异检查。
8. 出现契约冲突或不可逆操作时停止，不自行猜测。

## 18. 总体验收

- 用户仍通过现有发送中心、收件箱、联系人和待办完成业务。
- AI 只推动内部准备和状态，用户不寻找 AI 功能。
- 发信通道唯一，速率硬限制可执行。
- 询盘报价有证据、版本和审核。
- 所有 AI 建议可忽略、修改和审计。
- 正常路径无阻塞弹窗、无布局跳动、无明显额外等待。
