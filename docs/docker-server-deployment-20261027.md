# Prospector 服务器 Docker 部署

## 服务边界

- 公司 PostgreSQL：只提供 `milogin_center` 数据库和一个应用账号，Prospector/Navigator 共用 `public`；中心表使用 `identity_` 前缀。
- `center`：中心身份、权限、共享联系人、消息和管理中心，默认连接公司数据库，端口 `55847`。
- `bootstrap-admin`：一次性初始化超级管理员，只在首次部署时运行。
- `postgres`：仅用于本机演练的 `local-db` profile，生产不启动。
- Windows 客户端：继续在本机运行 Electron、SQLite 镜像和 SMTP/IMAP；不把客户邮箱密码或本机邮件库放进服务器容器。

## 首次部署

1. 由管理员在 `milogin_center/public` 执行 `deployment-templates/company-postgres-bootstrap.sql` 数据变更工单。脚本只用于空库，已有同名对象时不得直接覆盖。
2. 通过 KMS/部署环境填写 `PROSPECTOR_CENTER_PG_HOST`、`PROSPECTOR_CENTER_PG_PORT`、`PROSPECTOR_CENTER_PG_USER` 和 `PROSPECTOR_CENTER_PG_PASSWORD`；真实账号密码不得进入仓库、Compose 或日志。
3. 用反向代理把中心公开 HTTPS 地址转发到 `127.0.0.1:55847` 或 Docker 集群内的 `center:55847`。
4. 启动中心：

```text
docker compose up -d center
```

5. 首次初始化超级管理员：

```text
docker compose --profile tools run --rm bootstrap-admin
```

6. 从 `prospector-center` 持久卷读取 `bootstrap-admin.json`，登录后立即删除该文件并修改密码。

## 运行约束

- `PROSPECTOR_CENTER_PUBLIC_ORIGIN` 必须是完整 HTTPS Origin，不能带路径或账号密码。
- 数据库名固定为 `milogin_center`，主机、端口、用户和密码由受保护环境注入；不要复用测试库或启动生产本地卷。
- 构造镜像和运行日志不得包含 `.env`、管理员密码、邮件授权码或中心会话 Token。
- 更新版本时先备份公司数据库和 `prospector-center`；数据库迁移由中心启动流程执行并核对 checksum。

本机演练需要显式启动本地数据库 profile：`docker compose --profile local-db up -d postgres center`。

## 验证

- `GET /health/live` 返回进程存活。
- `GET /health/ready` 返回 PostgreSQL 就绪。
- 管理中心登录、创建测试账号、改密和退出可用。
- 桌面客户端指向正式 HTTPS 中心后，首次登录、离线恢复、联系人同步和 Navigator 授权分别验证。
