# 阿里云正式部署记录

## 地址

- 中心：`https://crm.47.96.159.26.sslip.io`
- Navigator：`https://rates.47.96.159.26.sslip.io`
- 客户端：`https://rates.47.96.159.26.sslip.io/download`

两个地址通过 Caddy 自动签发 HTTPS 证书。`55847`、`8795` 只监听服务器回环地址；公网只开放 `22`、`80`、`443`。

## 运行结构

- 中心正式数据库：同一 `pg-center` 容器内的 `milogin_center`，应用账号 `milogin_app`。
- 旧库 `prospector_center` 保留，不覆盖、不删除。
- Navigator 数据库：`pg-nav` 内的 `navigator_rates`。
- 部署版本目录：`/opt/logistics-api/releases/20261021T083709Z`。
- Caddy、中心和 Navigator 使用 host 网络，数据库与旧业务端口仅绑定 `127.0.0.1`。
- Navigator 使用独立 `logistics-nav:0.54.0` 镜像，PostgreSQL 客户端与 Python 依赖固化在镜像中。

## 凭据与备份

- 一次性中心超级管理员凭据位于中心持久卷 `bootstrap-admin.json`，文件权限 `600`。
- Compose 密钥位于发布目录 `.env`，权限 `600`。
- Navigator PostgreSQL DSN 位于 `/opt/logistics/freight-postgres.env`，权限 `600`。
- 覆盖前备份目录：`/opt/logistics-api/backups/pre-overwrite-20261021T083150Z`。

## 运维入口

```bash
cd /opt/logistics-api/releases/20261021T083709Z
docker compose ps
docker compose logs --tail 100 center-api
docker compose logs --tail 100 nav-api
docker compose logs --tail 100 caddy
docker compose up -d
```

## 回退

先停止当前 Compose，恢复 `old-deployment.tgz` 或 `docker-compose.yml.save`，再使用备份 dump 恢复数据库。旧库和旧业务代码未删除。
