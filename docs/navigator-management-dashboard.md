# Navigator 管理中心业务摘要

## 当前实现

管理中心的 Navigator 页面通过 `GET /admin-api/navigator/dashboard` 代理读取 Navigator 的只读摘要。中心只转发当前浏览器会话的中心 Token，Navigator 再向配置的中心身份服务校验身份和 Navigator 产品准入；中心数据库不复制运价业务数据。

页面展示中心授权账号数、Navigator 服务状态、后端类型、有效运价、舱位条目、待审核、待核问题和最新消息时间，并提供打开 Navigator 运价库的入口。

## 环境边界

测试中心 `55844` 使用隔离中心数据库。正式 Navigator `8795` 当前信任正式中心 `55847`，因此测试中心会话不能读取正式 Navigator 数据；页面应显示权限或服务不可用状态，不能用测试数据冒充正式数据。正式联调需要同时启动正式中心和 Navigator，并配置 `PROSPECTOR_NAVIGATOR_URL`（中心内部访问）与 `PROSPECTOR_NAVIGATOR_ENTRY_URL`（员工浏览器打开的地址）两者，不能把 `127.0.0.1` 当作跨电脑入口。

## 验证范围

已通过 TypeScript 类型检查、管理端构建、管理页渲染测试、管理 HTTP 边界测试和 Navigator Python 语法检查。已验证 Navigator 摘要接口无令牌返回401、伪造令牌不会进入业务摘要；正式中心跨服务联调因 `55847` 当前未运行尚未完成。
