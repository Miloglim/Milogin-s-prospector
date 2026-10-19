# 旧客户界面隔离节点

## 交付内容

`/customers` 现在进入旧版客户模块：

- 默认视图是原 `ContactList`，仍使用旧 SQLite contacts IPC；
- `#/customers?view=board` 进入原 `CrmPipeline` 跟进看板；
- `#/customers?view=company` 进入原 `CompanyPage` 公司双栏；
- 页面之间沿用旧页面已有的深链跳转，未把 PostgreSQL 客户主档强行转换成旧联系人结构。

现有在线 PostgreSQL 页面没有删除，保存在 `/customers-online`，当前侧栏不指向它。这样可以先在同一程序中验收旧界面和交互，再逐个页面接回在线数据。

## 验收方式

1. 启动程序并登录。
2. 点击侧栏“客户”，确认进入原客户列表：搜索、列设置、导入、新增、批量选择、行操作的布局与旧版一致。
3. 在已有已触达联系人行点击跟进入口，确认地址变为 `#/customers?view=board...` 并进入原纵向跟进看板。
4. 用 `#/customers?view=company` 验收公司左列表/右详情双栏。
5. 重新打开 `#/customers?view=table`，确认回到客户列表。

## 明确边界

本节点只恢复界面入口和旧 IPC 链路，不做 PostgreSQL 字段映射、在线权限适配、数据迁移或功能融合。当前旧页面读写的是本机 SQLite 数据；中心 PostgreSQL 页面仍是独立的后续适配基线。

## 检查点

改动前快照：`D:/Agent Basement/checkpoints/prospector-legacy-customer-ui-20261014`。
