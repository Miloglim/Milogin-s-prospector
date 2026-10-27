# Prospector 服务器 Docker 部署

## 服务边界

- `postgres`：独立 PostgreSQL，数据库 `milogin_center`，账号 `milogin_app`。
- `center`：中心身份、权限、共享联系人、消息和管理中心，端口 `55847`。
- `bootstrap-admin`：一次性初始化超级管理员，只在首次部署时运行。
- Windows 客户端：继续在本机运行 Electron、SQLite 镜像和 SMTP/IMAP；不把客户邮箱密码或本机邮件库放进服务器容器。

## 首次部署

1. 复制 `.env.example` 为 `.env`，填写数据库密码、中心/Navigator HTTPS 地址和管理员邮箱。
2. 用反向代理把中心公开 HTTPS 地址转发到 `127.0.0.1:55847` 或 Docker 集群内的 `center:55847`。
3. 启动数据库和中心：

```text
docker compose up -d postgres center
```

4. 首次初始化超级管理员：

```text
docker compose --profile tools run --rm bootstrap-admin
```

5. 从 `prospector-center` 持久卷读取 `bootstrap-admin.json`，登录后立即删除该文件并修改密码。

## 运行约束

- `PROSPECTOR_CENTER_PUBLIC_ORIGIN` 必须是完整 HTTPS Origin，不能带路径或账号密码。
- 数据库主机只能来自显式配置，数据库名和用户固定；不要复用 Navigator 或测试数据库。
- 构造镜像和运行日志不得包含 `.env`、管理员密码、邮件授权码或中心会话 Token。
- 更新版本时先备份 `prospector-postgres` 和 `prospector-center`；数据库迁移由中心启动流程执行。

## 验证

- `GET /health/live` 返回进程存活。
- `GET /health/ready` 返回 PostgreSQL 就绪。
- 管理中心登录、创建测试账号、改密和退出可用。
- 桌面客户端指向正式 HTTPS 中心后，首次登录、离线恢复、联系人同步和 Navigator 授权分别验证。
