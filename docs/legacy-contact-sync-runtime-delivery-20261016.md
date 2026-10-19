# 旧 SQLite 联系人运行时同步（2026-10-16）

## 已接入

旧 SQLite 中处于 `unmatched` 的联系人会在中心联系人完整刷新后进入本地同步队列。只有当前登录身份是普通用户（CRM `sales` 且不是超级管理员）时，运行时才会调用已有 `/api/crm/imports` 接口，并固定发送 `kind=personal`。

每批最多 200 条；请求使用稳定的 `legacy-import-{本批本地ID}` 幂等键。中心返回 `created` 或 `duplicate` 后，队列标记完成，再执行一次中心联系人刷新以回填 `crm_legacy_contact_map`。

## 失败边界

- 中心暂时不可用、网络错误或账号切换：保留 `pending`，下次中心刷新时重试。
- 中心明确拒绝或字段无效：标记 `failed`，不自动反复提交。
- 超级管理员、管理员和审计员：不触发旧联系人上传。
- 不上传邮件原文、历史交互、账号密码或本地 SQLite 编号作为中心业务编号。

## 没有新增

复用现有导入接口，没有新增 IPC、HTTP 路由、第三方依赖或前端组件。新增的 SQLite 队列表只保存账户本地待同步资料和结果。

## 验证

- 旧联系人映射与转换测试：6/6。
- SQLite 队列测试：2/2。
- `npm run typecheck`：通过。
- `npm run check`：架构边界检查通过。
- 隔离中心回归：206 项通过、1 项既有跳过。
- `npm run build`：Electron 主进程、preload 和 renderer 均构建通过。
- 未使用真实联系人数据进行外部中心写入；中心导入契约通过隔离 PostgreSQL 回归验证。
