# 新账号默认全产品开通

## 规则

- 中心管理员创建账号时同时写入 CRM 和 Navigator 产品准入。
- 桌面或 Navigator 自助注册同样同时获得两个产品的销售准入；注册来源只用于审计和本地业务身份，不再限制产品。
- CRM `operations` 映射 Navigator `operations`；`admin`、`sales`、`auditor` 默认获得 Navigator `sales`。中心超级管理员仍由身份属性自动获得 Navigator 管理权限。
- 已有账号只补齐完全缺失的产品记录，不覆盖已停用或已定制的产品权限。

## 实现

管理端 `user.create` 在同一事务内写两个产品授权；自助注册的 `createSalesAccount` 同时写 CRM/Navigator sales。`scripts/backfill-default-product-access.mjs` 默认 dry-run，显式 `--apply` 才补齐历史活跃账号。

## 验证

- 管理端创建四种角色时均检查 CRM + Navigator 记录及 Navigator 默认角色。
- 自助注册从默认入口和 Navigator 入口均返回两个销售产品。
- 正式回填先 dry-run 核对名单，再应用并只读复核；不回显密码、Token 或 DSN。
