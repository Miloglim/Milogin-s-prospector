# Prospector 开发端 Mock 层级

日期：2026-10-30

脚本只连接本机开发中心 `http://127.0.0.1:55847`，并校验配置中的端口、数据库名和应用账号。中心业务表默认位于 `public`；三 schema 环境通过 `PROSPECTOR_MOCK_CRM_SCHEMA=prospector` 切换。脚本不会读取线上中心配置。

本轮只扩展脚本和本文档，没有执行 `setup`、`cleanup` 或写入现有 Mock 数据。当前中心仍保留原有 7 个账号、8 个客户、5 个任务和 10 条邮件事件；累计夹具将在下一次明确执行 `setup` 后生成。

## 账号与团队

保留 7 个 Mock 账号。现有 `admin@yqn.com` 只作为中心超级管理员参与只读监控审计，不计入 Mock 账号数。

| 账号 | 身份 | 团队位置 |
|---|---|---|
| `mock.hierarchy.ops@yqn.com` | 管理员 | `Mock 运营中心` 主负责人 |
| `mock.hierarchy.ops.second@yqn.com` | 管理员 | `Mock 运营中心` 共同负责人 |
| `mock.hierarchy.supervisor.east@yqn.com` | 用户/主管 | `Mock 华东销售组` 负责人 |
| `mock.hierarchy.supervisor.south@yqn.com` | 用户/主管 | `Mock 华南销售组` 负责人 |
| `mock.hierarchy.member.anna@yqn.com` | 用户 | 华东组，完整绩效与关注项样本 |
| `mock.hierarchy.member.ben@yqn.com` | 用户 | 华东组，样本不足成员 |
| `mock.hierarchy.member.cara@yqn.com` | 用户 | 华南组 |

```text
Milogin（公司根）
└─ Mock 运营中心（两名管理员共同负责）
   ├─ Mock 华东销售组（主管 + Anna + Ben）
   └─ Mock 华南销售组（主管 + Cara）
```

密码只从 `PROSPECTOR_MOCK_PASSWORD` 读取，不写入代码、清单、文档或日志。

## 保留与新增数据

原有 8 条线索、5 个任务和各账号本地资料保留。累计夹具新增 7 条线索，预期中心数据为：

- 15 个客户，其中 13 个有当前负责人。
- 24 条邮件事件，覆盖询价、客户回复、自动回复、退信、内部邮件和垃圾邮件。
- 10 个跟进任务，其中 5 个为 CP7 成交样本的已完成任务。
- 7 个账号各有隔离本地资料；只在当前进程未占用对应 profile 时重建。

CP2 分配状态：

- `pending`：`online-pool` 分配给 Anna，华东主管进入监督快照。
- `accepted`：`cp2-accepted` 分配给 Anna，并有前负责人已结束、Anna 当前的完整 ownership 历史。
- `pending_transfer`：`online-replied` 从华东主管转交给 Ben，保留前负责人和转交发起人。
- `expired`：`cp2-expired` 分配给 Cara 后过期。
- 四种状态各写一条对应 `identity_outbox` 通知事件；后续由现有通知分发器投影到消息中心。

CP4 邮件分析：

- 规则询价：`online-contacted`，客户业务、需要报价动作。
- 人工锁定：`personal-replied`，规则历史、人工当前结论、晚到 AI 历史并存；AI 不覆盖人工。
- 无动作：`personal-contacted` 同时包含内部邮件和垃圾邮件，均不产生待办。
- 回复、退信、自动回复同时更新同一 `crm_touch_status`；自动回复不计入有效业务回复。

CP5 团队关注项：

- `online-contacted`：`open`。
- `personal-autoreply`：`acknowledged`。
- `cp7-won-1`：成员填写结果后 `resolved`。
- `cp7-won-2`：主管 `dismissed`。
- 每个状态变化都有审计记录和消息通知回执。

CP6 监控审计：

- 2 条直属主管联系人监督审计。
- 4 条团队监控审计，覆盖主管联系人、主管邮件、运营联系人、超级管理员邮件。
- 汇总接口只读，不改变客户归属、阶段或跟进状态。

CP7 绩效与分级：

- Anna 有 5 个已成交客户，其中一个客户有两笔成交，可计算首动作、有效回复、成交耗时和复购。
- Ben 只有 1 条自有线索，作为样本不足成员。
- A/B/C 均由当前事实实时派生，不保存等级快照。
- 人工覆盖一条 C → B，并保留独立覆盖记录、审计和幂等回执。
- 预期派生等级为 A=5、B=2、C=8；人工覆盖后有效等级为 A=5、B=3、C=7。

## 幂等与清理

`setup` 在同一事务内先清理本脚本标记的旧 Mock 数据，再完整重建；不清理 admin、账号外数据或无关公司。重复执行得到同一业务结构，不累计重复行。

机会阶段历史、团队监控审计和客户等级审计按业务设计是追加式表。Mock 清理只在当前事务内临时禁用以下三个触发器，完成后立即重新启用：

- `crm_opportunity_history_append_only`
- `trg_crm_team_monitoring_audits_immutable`
- `trg_crm_customer_grade_audit_immutable`

这要求应用数据库账号拥有对应表的 `ALTER TABLE` 权限。若权限不足，清理会整体回滚，不会留下半套 Mock 数据。生产审计清理不得复用这个开发脚本。

## 命令

```powershell
$env:PROSPECTOR_MOCK_PASSWORD = '<本次指定的统一临时密码>'
npm run mock:dev:setup

npm run mock:dev:status

# 只演练删除并在事务结束后回滚
npm run mock:dev:cleanup -- --dry-run

# 测试完成后正式删除本脚本创建的账号、团队、线索、邮件、任务和本地资料
npm run mock:dev:cleanup
```

`status` 只读，输出账号、客户、任务、邮件事件、分配状态、分析版本、关注项、监控审计、客户分级和 051-064 迁移状态。缺失表会显示 `available=false`，不会被误报为真实 0 条数据。

## SQL 与运行假设

- 运行前必须已有 051-064 全部迁移，包括 `054a` 旧树修复和 `063` 公共 outbox 外键修复；`setup` 会在事务开始后明确检查版本和目标表，缺一项就停止。
- 默认 schema 为 `public`。公司三 schema 环境需设置 `PROSPECTOR_MOCK_CRM_SCHEMA=prospector`，脚本内 CRM 表均按该值限定。
- 账号、权限、会话和 outbox 固定使用 `public.identity_*`。
- 分配、ownership、分析、关注项、监控、等级覆盖、审计和幂等均直接写当前 migration 定义的 canonical 表，不调用旧 `crm_teams` 或旧分配通知人入口。
- 团队关注项通知会同时写 `identity_outbox` 和 `crm_team_attention_notifications`；分配通知只写 outbox，由现有通知分发器按真实权限投影。
- 当前只完成 Node 语法检查、`git diff --check` 和只读 `status`。没有执行数据库迁移、setup、cleanup 或真实页面点击验收。
