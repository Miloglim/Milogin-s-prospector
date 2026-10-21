# 生产部署产物交付（2026-10-19）

## 本节点范围

- 新增 `scripts/production-server.mjs`，提供生产中心 API 的 `start/status/stop` 生命周期入口。
- 生产模式必须显式设置 `PROSPECTOR_CENTER_MODE=production`、正式 PostgreSQL DSN 和 HTTPS 对外 origin。
- 生产启动使用独立的 `ProgramData/MiloginCenter` 运行目录、进程标识和日志，不读取测试 `.work/pg-crm`。
- 不修改业务 API、数据库表、客户端 IPC 或 Navigator 业务逻辑。
- 候选包内中心服务只带 `pg` 运行依赖；客户端安装包单独放在 `client/`。

## 交付边界

Prospector 已构建为 `dist-server`、`dist-admin` 和未签名的 Windows NSIS 安装包。Navigator 当前仍是 Python 运行时，未引入 PyInstaller 等新依赖，因此交付包仍包含其运行源码；本节点不宣称“完全无源码部署”。业务数据库、图片、发布身份名单和凭据不在包内，应走受控的数据迁移与配置流程。

## 公司部署顺序

1. 在受控 Windows 服务器上准备 Node.js 22+、Python、PostgreSQL 和 HTTPS 反向代理；Navigator 公司接口凭据使用 Windows DPAPI。
2. 分别准备中心账号/CRM 库和 Navigator 运价业务库；中心库由 `milogin_app` 通过本机 `127.0.0.1:55846` 访问。业务库与发布身份名单需单独受控迁移。
3. 由部署人员在服务器环境变量设置 `PROSPECTOR_CENTER_MODE=production`、`PROSPECTOR_CENTER_PG_DSN`、`PROSPECTOR_CENTER_PUBLIC_ORIGIN`。配置示例在 `prospector/production-deployment.env.example`；真实密钥不要进入仓库或聊天。
4. 在构建客户端前写入正式中心地址：`assets/center.json` 的 `baseUrl`，或部署时设置 `PROSPECTOR_CENTER_URL`。正式中心必须使用 HTTPS；仅本机回环允许 HTTP。
5. 在 `prospector/` 执行 `node scripts/production-server.mjs start`，随后运行 `node scripts/production-server.mjs status` 并检查 `/health/ready`。`pg` 运行依赖已随包附带，无需安装 Electron 依赖。
6. 空中心库首次启动后，用 `scripts/bootstrap-production-admin.mjs` 创建唯一超级管理员；已有超级管理员时不得重复执行创建。
7. 在 `navigator/Database/` 安装 `requirements-postgres.txt`，将 Navigator 运价库 DSN 写入仅服务账号可读的 `freight-postgres.env`（键名 `FREIGHT_POSTGRES_DSN`），然后执行 `python manual_server.py --backend postgres --postgres-env-file <配置文件> --center-auth-url <中心HTTPS地址>`。外部入口也须接入 HTTPS。
8. 为外部解析 Agent 单独配置 `NAVIGATOR_AGENT_API_TOKEN`，HTTPS 对外提供 `POST /api/agent/intake/v1`，并把随包 `navigator/Skill/navigator-agent-intake/` 交给接入方。
9. 安装 `client/` 中的 Windows 客户端，并用隔离真实账号验收登录、退出、查价、权限拒绝、客户读取和备份恢复。

## 未完成边界

- Navigator 仍未冻结为二进制产物；如要求公司完全看不到 Navigator 源码，需要单独批准并引入可复现的 Python 冻结构建链。
- 客户端未签名；公司首次安装可能出现系统信誉提示。本轮按既定范围未配置签名和更新发布。
- HTTPS、正式账号、业务数据迁移、数据库备份恢复和跨机器联调仍需公司现场验收。
