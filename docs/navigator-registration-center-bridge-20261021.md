# Navigator 自助注册中心桥接

## 契约

`POST /api/auth/desktop/register` 接受 `{ email, password, product? }`。`product` 只允许 `crm` 或 `navigator`，省略时为 `crm`；服务端固定创建销售身份，不接受角色、能力或数据范围字段。Navigator 自助注册固定发送 `product: "navigator"`，只写入 Navigator 销售授权，不同时开放 CRM 或管理权限。

## 流程

- Navigator 先以中心注册作为账号准入真源，成功后保留同名本地 `operators` 业务身份用于历史关系、角色与产品偏好。
- 新本地业务身份在中心注册失败时回滚；中心不可用不会留下无法登录的半成品。
- 升级前已由旧版 Navigator 创建、仅存在于本地且带原密码摘要的账号，可用原密码重试自助注册；中心成功后清空本地密码摘要，后续统一由中心验证。
- 已有本地账号若密码不一致、停用或无本地密码摘要，不允许通过注册接管。

## 验证边界

中心注册使用隔离 PostgreSQL 验证默认 CRM 销售和显式 Navigator 销售两种授权；Navigator 使用 SQLite 临时库验证创建、失败回滚和旧本地账号绑定，并由 `center_auth` 单测确认请求体不含客户端角色字段。正式部署后还需用一次性测试账号完成中心注册、Navigator 登录和测试数据清理。
