# B2 客户阶段与跟进活动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 客户、联系人触达和发信步骤各自稳定；公司级跟进及历史实际发生时间可追溯，管理员读取同一中心记录。

**Architecture:** 沿用中心PG和followup/detail/list/feed链路，追加012迁移。客户独立relationship_stage，联系人独立crm_touch_status，活动包含方式/发生时间/可选联系人，旧记录及旧stage保留。复用现有客户抽屉，不新增导航、离线写队列或业务消息消费者。

**Tech Stack:** TypeScript、PG、React/Ant Design、既有Vitest/Electron；没有新增依赖。

**Spec:** docs/crm-business-fusion-spec-20261012.md 的 B2，与2026-10-12用户批准方案。

## Global Constraints

- 最新角色称呼管理员/用户/超级管理员；界面克制，无开发教学说明。
- 每节点checkpoint；本节点D:/Agent Basement/checkpoints/prospector-b2-followup-20261012已保存改前源码/测试/脚本/文档。
- 不修改已执行001–011 SQL；只测试集群55843/prospector_crm_test，无运价库或真实邮件外发/Excel导入。
- 契约先行，复用22在线IPC及既有HTTP返回；未知请求保留原键/完整输入，版本并发由中心复核。
- 旧contacts.stage/status保持发送含义，B2不修改SMTP/SQLite业务表，不引入服务器Worker。

## Task 1: 中心表与业务事实

**Files:** server/core/leads.ts、server/services/leads.ts、server/adapters/postgres/lead-repository.ts、新followup-schema.ts、tests/integration/customer-followup.test.ts、新单元边界测试。

**Interfaces:** FollowupRequest新增可选method=邮件/电话/拜访/其他联系/备注、occurredAt带时区ISO、contactId、contactStatus。stage允许原CRM阶段或cold。LeadActivity保留createdAt并增加method/occurredAt/recordedAt/contactId/contactName/contactStatus；LeadContact.touchStatus；LeadDetail.stageNeedsReview。共享类型直接重导出，不复制第二套字典。

- [x] 先写失败测试：零联系人可记电话；仅选联系人更新crm_touch_status；contacts.stage/status原值不变；昨日occurredAt保留、备注不计最近实际联系；外客户contactId、缺contactId的contactStatus、无效时间/未来时间拒绝；同键重试1活动1通知、同键不同输入冲突、旧版本拒绝、无权限不泄露。
- [x] 追加012：crm_customers.relationship_stage CHECK(cold及现CRM枚举)、stage_needs_review、legacy_stage_snapshot；contacts.crm_touch_status独立CHECK；crm_shared_activities.interaction_id可NULL、method默认legacy、occurred_at/recorded_at回填原created_at、contact_id与contact_status。
- [x] 旧客户仅所有联系人一致且合法值时映射；无联系人或全cold视cold；数字发信步骤、冲突或未知值设cold+待核对，保留快照，旧列不改。旧活动不猜联系人/联系方法，legacy排除实际联系排序。新增客户默认cold。
- [x] followup在授权、客户锁、幂等、版本下事务写活动；不再人为挂第一联系人。contactId需属于客户，contactStatus仅指定联系人更新。stage只写客户主体并清待核对标记。occurredAt省略用中心时间，旧客户端method省略按other记录，未来超过60秒拒绝。内部备注不更新触达结果。
- [x] list/filter/detail统一读取客户stage；recentActivityAt按非legacy/非note活动occurred_at派生；activities记录按发生时间排序、保留真实录入时间。原通知关联activityId，不另建事件入口。
- [x] 真实PG测试按单个测试进程串行；迁移重复执行不重置已有值，校验历史快照并保留新人工修正。类型检查、原协作/投影/通知回归。

## Task 2: 客户详情轻量对接

**Files:** src/renderer/pages/customers/CustomersPage.tsx、customers.css，受影响renderer测试。

- [x] 活动表单紧凑两行：联系方法/发生时间、可选联系人/触达结果/可选客户阶段；默认不修改阶段或联系人。备注时不允许设置触达结果。零联系人仍可填写。
- [x] 活动行以方式、发生时间、记录人及联系人组织，补录另显示录入时间；联系人显示各自触达结果，待核对仅简短标记。沿用现主题与抽屉标题栏边界。
- [x] 跟进草稿修改时冻结原version；所有字段属于同一幂等输入，响应未知时禁止改输入但可原键重试；明确写前拒绝允许修正/刷新版本；成功后清字段、刷新同中心列表及详情。
- [x] meaningful renderer测试覆盖联系人选项、零联系人表单、补录、方法切换、请求/重试与版本漂移，验证旧mock字段兼容。

## Task 3: 集成与独立复核

**Files:** scripts/online-server.mjs新增该集成测试登记，.work/b2-followup/runtime.cjs及交付文档。

- [x] 迁移前导出受控测试schema和客户旧stage快照；实际中心重启跑012并检查22IPC仍一一对应，旧API保持调用方。
- [x] 两独立Electron合成管理员/用户：导入/分配多联系人及零联系人客户，用户补录电话仅改指定触达、管理员读取同活动和通知直达；丢响应原请求重试去重、异客联系人/并发旧版本拒绝、未联系新公司cold、网络故障不写SQLite。
- [x] 独立限定审阅权限/通知/事务/迁移/幂等/时间及前端，修复确认问题并重验。
- [x] 普通测试、中心专用、类型、三端构建、架构及检查器验证；版本minor→0.23.0-alpha.1未发布，契约/架构/陷阱/知识库同步并保存checkpoint交付哈希/证据。

## Rulings

客户阶段沿用现字典，不推断Excel未知商机阶段；联系人触达新字段不从原发信status推导。旧活动发生时间未知，保留原created_at作为历史时间且标legacy，不将其冒充真实联系统计。明确客户阶段与记录共同提交，不另建只有UI调用的stage端点。任务/商机/自动邮件识别仍留B3–B5。

最终验证见 `docs/b2-customer-followup-delivery-20261012.md`，本节点实际完成，B3及后续未实施。
