# 客户页同步入口移除（2026-10-19）

## 原因

客户页右上角仍挂载紧凑版同步组件，导致用户看到“同步”按钮。上一节点只移除了同步抽屉中的“立即同步”，没有移除页面入口。

## 改动

- 从 `LegacyCustomersPage` 移除 `CrmSyncPanel` 及其客户页快捷入口；
- 不修改后台自动同步、联网恢复、周期同步或冲突处理 IPC；
- 客户页不再显示同步按钮和同步抽屉。

## 验证

- 客户页同步渲染测试确认页面没有同步控件；
- 离线联系人交互与左下角账号区测试通过；
- 定向测试：3 个文件、25 项通过；
- `npm run typecheck`：通过；
- `npm run check`：通过。

checkpoint：`D:/Agent Basement/Milogin-s-prospector/checkpoints/auto-sync-entry-removal-20261019`。
