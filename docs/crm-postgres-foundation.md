# CRM PostgreSQL 基础节点

日期：2026-10-10；工作区功能版本 `0.10.0-alpha.1`，未发布。用户批准独立测试库、CRM 表和数据访问层先行，登录/API 后接。

后续进展：0.11.0-alpha.1 已完成独立本机身份/权限HTTP服务，见 [账号与API节点](online-auth-api.md)。本文以下描述0.10基础节点当时的交付范围；桌面仍未切换SQLite或接入在线登录。

## 交付范围

独立 PostgreSQL 18 集群与数据库 `prospector_crm_test`，监听 `127.0.0.1:55843`。仅复用已安装 PostgreSQL 工具，不操作现有运价服务或数据库。测试集群不是 Windows 服务，不自动随系统启动；当前已启动，重启电脑后需手动启动。

四张业务表：companies、contacts、interactions、crm_relations；另有 crm_schema_migrations 迁移账本。公司背调、联系人附加属性与标签为 JSONB，外键、邮箱规范化唯一索引和分页索引在数据库层生效。活动表目前只支持手动跟进和阶段事件，关系表先建结构，关系增删用例后接。

CRM 阶段沿用 contacts.tags，与发信流程 contacts.stage 分开。旧 assignee 文本字段只为后续迁移保留，尚不能充当账号 ID、归属或权限。没有导入真实客户、邮件、邮箱账号或发送任务；桌面程序继续使用原 SQLite。

## 运行

在项目根目录 PowerShell 中运行：

```powershell
npm.cmd run crm:pg:start
npm.cmd run crm:pg:check
npm.cmd run crm:pg:test
npm.cmd run crm:pg:status
# 不用时停止，数据保留
npm.cmd run crm:pg:stop
```

`start` 幂等初始化/启动独立集群；`check` 编译 server 并执行迁移/连通性检查；`test` 显式运行真实 PG 集成测试，仅生成合成数据，故障注入约束在 finally 中解除。普通 `npm test` 跳过此专用套件，避免 CI/其他机器默认依赖本机数据库。需要真实 PG 的 CI 必须单独准备工具并运行 `crm:pg:test`，不能将跳过当作 PG 验收。

工具默认目录为 `C:/Program Files/PostgreSQL/18/bin`；不同安装位置可在本机配置环境变量 `PROSPECTOR_PG_BIN`。固定测试目标与超时唯一来源为 `server/core/postgres-test-settings.json`，配置时间使用 `connection_timeout_seconds`。驱动固定 `pg 8.23.1` / `@types/pg 8.23.1`，不新增 ORM。

运行目录 `.work/pg-crm/` 及编译产物 `dist-server/` 不进入 Git。初始化随机生成本机凭据，目录限制访问，临时密码文件在初始化后删除。凭据应留在本机配置，不粘贴到 Agent 对话。不要删除运行目录来处理连接失败；先查 `status` 和该目录下日志。

## 分层与一致性

- `server/core/crm.ts`：零依赖类型、常量、仓储契约与 `{ ok, data?, error? }`。
- `server/services/crm.ts`：输入校验和用例调用，不做数据库、网络或文件 IO。
- `server/adapters/postgres/`：连接、参数化 SQL、迁移和事务；`server/cli.ts` 为本轮入口，无 HTTP/IPC。

迁移使用事务和 advisory lock，已应用 SQL 的 SHA-256 不一致时拒绝覆盖；后续结构变化必须新增版本，不能改写旧迁移。切阶段采用行锁，阶段和活动同事务提交，重复切到同阶段不追加活动；列表计数与分页使用同一只读快照。

本轮测试角色是独立集群初始化角色，具备建库权限，仅限回环隔离实验；正式服务应分离迁移角色和业务角色，再调整此节点的测试目标保护。当前没有鉴权或 API，不能开放到局域网/公网使用。

## 验证与回退

真实 PG 10 项测试通过：UTF-8/JSON、邮箱唯一与外键、SQL 注入文本/搜索通配符、跟进、阶段原子性、故障回滚、双连接并发、输入校验、迁移幂等与漂移拒绝、目标库保护。独立停止/重启与 CLI 检查通过。桌面类型检查、架构检查、检查器测试及构建通过；现有真实 Electron SQLite 回归也通过。架构检查器原范围为 src，本轮 server 分层另按依赖审阅，不宣称原检查器已覆盖 server。

实施前源码 checkpoint：`D:/Agent Basement/checkpoints/prospector-postgres-preflight-20261010-180033`。回退先停止本测试集群，再按交付文件清单回退新增模块及 package/lock/docs；保留运行目录和其他工作区改动，不整库 reset，也不影响现有 SQLite 或运价库。

下一节点是账号/角色和最小中心 API；需先报告原因、提升、副作用与 checkpoint，再按批准范围接入。本轮不代表在线 CRM 全链路已完成。
