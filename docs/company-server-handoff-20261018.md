# 公司服务器交接说明（2026-10-18）

## 当前可交接范围

- Prospector：全量 Vitest 通过，TypeScript、架构检查、Electron 构建、中心 API 构建、管理员前端构建通过。
- Navigator：全量 Python 测试 297 项通过（跳过 61 项外部服务集成测试），中心鉴权专项测试通过。
- 两个本机服务已通过健康检查：中心 API `55847`、Navigator `8795`。

## 交接包不包含

不复制 `.env`、Token、密码、证书私钥、本机 PostgreSQL 数据目录、SQLite 业务库、运行日志和 `node_modules`。这些内容必须由公司部署人员在服务器上手工配置或从正式备份恢复。

## 服务器需要准备

1. Node.js、npm、Python 运行时和 PostgreSQL。
2. 中心数据库 `milogin_center`，先执行 Prospector 的数据库迁移，再启动中心 API。
3. 中心 API、Navigator API、Prospector 客户端/管理端的内部地址和端口。
4. 由公司网络或反向代理提供 HTTPS；本机验证使用的是回环 HTTP，不能直接作为跨机器浏览器地址。
5. 手工写入环境变量：中心数据库 DSN、会话签名密钥、邮件/AI 服务配置、Navigator 的 `NAVIGATOR_CENTER_AUTH_URL`。密钥不通过聊天传递。

## 推荐启动顺序

中心 PostgreSQL → 中心 API → Navigator 8795 → Prospector 客户端或管理端。

部署后必须用真实账号完成一次登录、查价、退出、再次登录和 Navigator 权限拒绝验证；真实密码由公司管理员在服务器环境中配置，不上传到交接包。

## 当前边界

交接包代表“代码和构建可交接”，不代表公司服务器已经上线。服务器网络、HTTPS、数据库恢复、正式账号密码和真实外部服务仍需现场验收。
