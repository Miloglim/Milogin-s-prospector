# 客户界面按旧设计复刻

用户于2026-10-13确认使用 `D:/Agent Basement/checkpoints/prospector-customer-ui-rollback-20261013` 的旧客户界面作基准。本次以其中 `ContactList.reference`、`CrmPipeline.reference` 恢复原设计，公司布局参照仍保留的 `src/renderer/pages/companies/CompanyPage.tsx`。`CustomersPage.tsx.before` 已是中心化改造页，不将其误称为原精细UI。

## 实现与边界

- 联系人视图恢复紧凑搜索/计数/列设置/导入/新增工具栏、多选、原列顺序及行操作；列设置只控制展示，不修改业务数据。中心列表仍是客户主档摘要，默认每客户展示一位主联系人，不宣称全量联系人列表或按“人”计算总数。
- 跟进看板恢复纵向可折叠阶段列表、彩色边线、紧凑行及右侧固定详情卡。阶段使用现中心客户阶段；列计数仅本页，不冒充全库统计。
- 原基本信息、偏好设置、跟进记录、邮件往来标签保留。中心尚未接偏好/邮件往来，标签禁用；任务与商机放在详情的下一步/商机标签。窄卡片标签可换行，活动时间字段不撑出卡片。
- 公司视图恢复左列表/右详情双栏，详情位置由当前布局计算。发/回计数尚未接入，显示缺失占位，不填0。
- 未接入的旧导出、删除、发送阶段/状态/标签/类型/语言筛选、看板国家/跟进人筛选及运价批量更新保留并禁用。已接入的搜索、客户阶段筛选、中心详情、编辑、导入、分配、领取、跟进、任务与商机继续沿用现通道和权限。
- 公共池不展示跟进阶段，禁用看板入口；不调用旧SQLite客户IPC，不建立新API、迁移、依赖或持久化派生业务字段。表格/看板/公司同一中心数据，UUID保持原样。
- 本次仅修改已有 `CustomerLegacyShell.tsx`、`CustomersPage.tsx` 和 `customers.css`，保留并行任务的商机锁定与来源规范等改动，不做全文件回滚或版本回退。

## 验证

49项客户页、跟进和商机渲染回归；类型检查、桌面构建、架构检查。实际Electron/preload/生产renderer以合成IPC响应验证1366px和1040px三视图、列设置、禁用导出、阶段折叠、详情卡边界及详情标签切换；页面异常0。这些UI冒烟不是中心HTTP/PostgreSQL端到端验收，也不是视觉像素一致性的认证。

证据：`.work/customer-ui-tests.log`、`.work/customer-ui-typecheck.log`、`.work/customer-ui-build.log`、`.work/customer-classic/report.json`及同目录截图。测试没有使用真实客户或登录真实账号。

改前checkpoint：`D:/Agent Basement/checkpoints/prospector-ui-faithful-20261013`。工作区未提交/发布；不将其他并行任务的版本号视为本次独立发版。

## 2026-10-13 用户纠正后的复核

0.32.1曾误将客户触达限制当作账号限制，已在0.32.2撤回。已触达/已回复才纳入看板，关系阶段不充当触达事实；删除cold栏并恢复旧六阶段、原色和白色面。中心与离线均先筛选再统计分页，行内未触达客户快捷入口禁用。

联系人双击详情实际复用旧ContactDetailLayout（500px固定头部、Tabs与滚动内容）和SectionTitle/FieldRow字段组件，中心联系人/公司字段按分组展示。原往来记录位置用于已有中心跟进，下一步/商机独立标签保留。公司背调、偏好、旧邮件统计及旧字段编辑仍受既有中心适配边界限制，不宣称整个旧后端已经完全复现；不以中心UUID调用旧SQLite写接口。

checkpoint：D:/Agent Basement/checkpoints/prospector-board-behavior-20261013。验证证据：.work/board-correction-all-tests.log（1093通过/150条件跳过）、board-correction-postgres.log（外层回滚）、board-behavior/runtime/report.json及截图。

本机中心于2026-10-13 19:00已通过受控生命周期重启加载修正，PG与账号数据保留，ready检查通过；用户现有Electron主进程未强制退出，仍需正常重启。最终类型、桌面及中心构建、201源码架构检查通过。知识库源码差异含之前节点，本次不重录全项目基线。
