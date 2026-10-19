# 前端交互核查 · 2026-10-15

结论：当前主客户界面仍有明确未接通的交互和新旧数据源错位。N0—N5限定后端链路验证不代表旧界面全部功能恢复。用户暂停后续节点，本轮不修改产品代码、不推进N6。

## 当前实际入口

导航客户页 /customers 使用 LegacyCustomersPage 与中心 dataPort。未将废弃 CustomerLegacyShell 中的占位按钮计入缺陷。/customers-online 仍承接部分任务/商机通知，不是失效路由。

## 已发现的问题

| 位置 | 实际行为 | 核验方式及源码 |
|---|---|---|
| 联系人新增、导出 | 中心模式禁用；导入可用 | 实际桌面验证；ContactList.tsx 的 dataPort 禁用条件 |
| 联系人单条/批量删除、详情删除 | 中心模式禁用；端口直接返回暂未开放 | 源码核对 ContactList.tsx、CenterContactDetail.tsx、centerContactPort.ts |
| 详情 AI 快捷按钮 | 固定禁用，尚未接入独立快捷入口 | CenterContactDetail.tsx；不等于主AI对话入口不可用 |
| 公司背调 | 开始/重新背调禁用 | 实际桌面验证；CompanyBackcheck.tsx 接到 centerCompany 即禁用 |
| 跟进看板运价更新 | 工具栏和批量按钮禁用 | 实际桌面验证；CrmPipeline.tsx 的 dataPort 条件 |
| 公司新增/删除 | 中心模式禁用 | CompanyPage.tsx；删除已实际桌面验证 |
| 公司国家/行业/规模 | 有可编辑视觉效果，但点击直接返回，不打开编辑器 | CompanyPage.tsx；行业已实际桌面点击验证 |
| 详情标签/跟进阶段 | 标签提供旧跟进阶段选项，但保存为普通 contacts.tags；中心看板根据活动时间线的 relationshipStage 分栏，二者不联动 | 源码链路：ContactDetail.tsx → CenterContactDetail.tsx → contact-assignment-repository.ts；CenterContactViews.tsx 根据 relationshipStage 分栏。未写入真实客户验证 |
| 看板提醒/逾期/沉默天数 | 中心适配值仍为 null/false/0，原有提醒提示没有接入 | CenterContactViews.tsx；代码确认，不表示客户级任务提醒工具失效 |
| 仪表盘客户/阶段统计 | 仍读旧本地 contacts/tags；测试存在9个授权中心联系人，统计为0 | 实际主进程调用；dashboard.service.ts |
| 全局搜索联系人/跟进记录 | 仍读旧 search_idx，搜不到已存在的中心联系人；旧联系人命中的跳转参数也被中心页拒绝打开 | 实际搜索验证及 search.service.ts、db/search-index.ts、GlobalSearch.tsx、ContactList.tsx 调用核对；邮件搜索不在此缺陷范围 |

附带发现：AI运价更新群发计划仍从旧本地 contacts 取联系人（toolkit/rates.ts → rate-update.service.ts），不能把已接入的普通草稿/发信工具推广为全部营销入口均已适配。本项仅源码核对，未调用真实运价营销或发信。

## 不计作故障

- 忘记密码为此前明确保留的占位入口，尚无点击链路。
- 普通用户不显示管理员分配操作是权限限制。
- 未触达客户不进入跟进看板符合既定需求。
- 离线限制写入、导入和分配是当前边界。

## 验证范围

原生产Electron主进程、原renderer/preload、原生SQLite、真实HTTP/PostgreSQL；固定Agent账号，合成联系人仅用于事务回滚测试。9项检查通过，页面异常数组为空。通过指核查断言成功，包括成功复现上述缺陷，不表示功能已修复。并非全界面、全部角色或全部按钮覆盖。

账号77、联系人1072、客户147、会话179、事件154前后均不变；邮件正文全局目录不变。无新增账号、无真实外发。临时证据位于 .work/frontend-interaction-audit/report.json 和 ui-audit.json，未改产品源码、协议、数据库结构、版本或发布状态。

## 建议顺序（尚未实施）

1. 先纠正详情跟进阶段与看板、仪表盘和搜索的数据口径，避免看得到但对不上的错误反馈。
2. 再补齐新增/导出、公司资料编辑和背调、运价入口；删除需保留既有归属、邮件关联与审计保护。
3. 核查完整后再继续N6持久重试，不改变已固定的前端样式。

后续修复已实施，边界和验收见[修复交付](frontend-interaction-repair-20261015.md)。本文件保留核查当时的历史状态，不代表修复后的全部现状。
