# CRM业务融合B1：客户主档与跨表导入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. 2026-10-12用户批准执行；实际结果以B1交付及验证证据为准。

**Goal:** 在原客户工作面中正确承接分表客户/联系人库，支持多联系人、无邮箱客户、正式业务字段与可追溯的导入结果。

**Architecture:** 沿用中心PG、在线CRM契约、主进程文件读取和现有导入抽屉。core定义规则，services编排无IO，adapter处理工作簿/PG；transport只校验和路由。明确独立WORKBOOK_PREVIEW/WORKBOOK_IMPORT契约，保留旧平面入口；在线通道22个，处理器与白名单对等。

**Tech Stack:** 现有TypeScript/React/Ant Design、xlsx、pg、Vitest和Electron；不新增依赖。

**Spec:** docs/crm-business-fusion-spec-20261012.md；数据依据见docs/crm-model-review-20261012.md。

## Global Constraints

- 无真实数据写入、无真实邮件外发、无未经批准的新依赖。实际Excel仅只读预览统计，集成写入使用隔离合成源及账号。
- 管理员/用户/超级管理员称呼；role、origin、salesUserId权限字段不迁移。
- 先checkpoint（源码、契约、迁移清单、独立测试DB快照），不可重置当前已有脏工作区。
- 返回{ok,data?,error?}；版本冲突与权限由中心处理；复用幂等与行级回执，不落第二份可编辑共享CRM。
- 执行裁定：文件10MiB，选定客户/联系人每实体10000行、合计20000行；实际2461+8760行以200行/1MiB拆批，不把所有7表重复扫入。
- B1不导入历史归属、商机、成交和跟进结果；这些必须在B2/B4规则确定后独立处理。

### Task 1：契约和纯关联规则

**Files:** server/core/leads.ts、src/shared/online-crm.ts、src/renderer/pages/customers/customerImport.ts；新增server/core/customer-import.ts与tests/unit/customer-workbook-import.test.ts。

**Interfaces:** 拟定义WorkbookImportPreview（sheets及原行号）、CustomerImportDraft（customerRef、companyName、country、businessType、developmentRestriction、sourceCreatedAt）、ContactImportDraft（customerRef、email?、name、phone、title、原行定位）和WorkbookImportPlan（确认关联、未匹配、歧义、重复、排除的sheet）。来源引用是暂存关联标识，不作为永久客户ID。原ImportRequest作为现有扁平格式保留；新工作簿使用独立类型和独立入口，禁止猜payload。

- [x] 全调用点核对PREVIEW/IMPORT、ImportRow/ImportRequest和字段校验；契约常量/类型先行，契约文档在交付同步。
- [x] 先建立多联系人、同名歧义、无抬头、无邮箱客户、重复暂存表和同邮箱跨归属测试。
- [x] 纯规则只产生候选和待处理；大小写/空白正规化可用于候选，拼写相似不自动合并。
- [x] 计划包含每个选定源行的去向，不允许无回执丢弃；缺联系人邮箱只阻止邮件发送，不强制删除客户。

### Task 2：主进程多表读取与预览

**Files:** src/main/adapters/import-table.adapter.ts、online-crm.adapter.ts、online-crm.service.ts、transport/online-crm.ipc.ts；tests/unit/import-table.test.ts、online-ipc-contract.test.ts。

**Interfaces:** 保留parseImportTable旧扁平格式入口，新增同模块纯解析多sheet元信息及选定sheet行数据；原行号、header和文件名进入预览。服务调用类型必须先确认Task1最终类型，不能adapter和UI各自造一份契约。

- [x] 回归UTF8/GB18030、XLSX、文件字节/行数边界，确认未修改原文件。
- [x] 管理员选择客户与联系人sheet，忽略“待上传”类副本必须显式显示选择结果，不能按名字静默删数据。
- [x] 实际Excel只读预览验证7sheet可识别，选择客户/联系人主体得到2461/8760源行；不执行在线导入。

### Task 3：中心主档增量迁移和来源映射

**Files:** 新增server/adapters/postgres/customer-profile-schema.ts；修改schema.ts之外的迁移注册、lead-repository.ts、server/services/leads.ts和core/leads.ts；新增tests/integration/customer-workbook-import.test.ts。

**Interfaces:** 同用途导入新增格式的仓储方法及receipt；所有来源映射/联系人冲突在center transaction复核。需要客户和联系人分实体批次，不让一个大payload超过1MiB。

- [x] 先固定增量迁移版本和checksum，添加业务类型/开发限制/源日期/确认映射，不编辑已执行001/005/008迁移正文。
- [x] 明确contacts无邮箱支持方式：优先现有contacts.email可空并保留非空邮箱唯一规范，改动前验证所有发送/查询调用点；如影响本地同名契约则另列具体兼容方案，不用假邮箱绕过。
- [x] 支持先创建客户后追加已确认联系人，全部关联外键一致；现有有邮箱平面CSV保持兼容。
- [x] 同来源稳定映射重导不重建客户；公司名变更不能自动改变身份；跨创建者/归属冲突不越权返回私有详情。
- [x] 新回执明确区分新增客户、追加联系人、重复、缺少关联、歧义、受限冲突和无效；未知响应重用原key。
- [x] 并发/重试/失败回滚/10MiB与1MiB边界/无联系人客户详情及分配专项测试。

### Task 4：客户工作面融合

**Files:** CustomersPage.tsx、customers.css；按责任必要时抽出WorkbookImportPanel.tsx；tests/integration/customer-workbook-import-renderer.test.tsx及r2/r3既有测试。

- [x] 原导入抽屉提供表选择、字段映射、关联预览和异常确认；主要动作固定底部，不另建教学页。
- [x] 客户资料支持业务类型及开发限制；无联系人不假显示“已有收件人”，分配可正常进行。
- [x] 扁平CSV路径继续工作，错误单行修正和同键重试不退化；受限冲突不自动“合并”。
- [x] 确认导入只提交当前已经处理好的行，其余保持待处理与来源行号；不将商机/成交记录装进备注假装已迁移。

### Task 5：验收、检查接口与交付

- [x] 类型检查、桌面/管理中心/服务器构建、架构检查、全部受影响unit及串行PG/HTTP专项通过。
- [x] 真实Electron隔离账号验证管理员多表导入→同客户多联系人→无邮箱客户分配→用户消息直达→回执与归属查询一致。
- [x] 实际Excel只读预览统计与源文件对照；不凭自动近似匹配宣称100%关系恢复。
- [x] IPC数量、白名单、service、HTTP路由及UI调用清单一一核对；旧调用兼容，不产生第二条SQLite CRM写路。
- [x] 每个checkpoint补最终diff和验证证据；记录SemVer版本、架构、IPC契约、已知陷阱以及知识库状态。未发布则明确未发布，不自动推release。
- [x] 交付简报列明可见改动、Agent已测范围、用户验收入口、副作用与B2的下一审批对象。


## 执行结果

B1交付见 ../../crm-business-fusion-b1-delivery-20261012.md。明确裁定：22通道、每实体10000/总20000、名称别名改名手工维持引用、客户端跨重启导入工作台未实现；不声称旧邮件链已完成迁移。
