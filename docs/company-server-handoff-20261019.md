# Milogin 产品链服务器交接 README

版本：Prospector `0.53.2-alpha.1` 交接候选

这份说明给负责部署和联调的同事阅读。它先说明两个产品是什么，再说明数据怎么流动，最后说明服务器要准备什么、怎样验收。

## 一、两个产品分别做什么

### Prospector：客户线索和销售工作台

Prospector 是桌面 CRM 应用，给管理员和用户使用。

- 管理员导入、整理和分配客户线索。
- 用户查看分配给自己的线索，记录联系、跟进和下一步任务。
- 管理员查看线索流转、跟进状态和团队数据。
- 收件箱、发信、自动开发任务和客户历史仍由 Prospector 统一管理。
- Prospector 可以调用 Navigator 查询运价，但不负责维护运价主数据。

### Navigator：运价查询和运价主数据服务

Navigator 是独立的运价服务。

- 保存和维护公司的运价、舱位和相关业务数据。
- 提供查询接口给 Prospector 使用。
- 运价数据由 Navigator 自己的服务和数据库负责，不写入 Prospector 的 CRM 数据库。
- Navigator 的管理员工作台和 Prospector 的 CRM 界面是两套产品界面。

两者是互联关系，不是把 Navigator 的页面嵌入 Prospector，也不是把两套数据库合成一套。

## 二、完整业务链路

```text
管理员登录
    |
    v
Prospector 中心账号与 CRM
    |
    +--> 管理员导入客户线索
    |        |
    |        +--> 创建/更新公司和联系人
    |        +--> 分配给指定用户
    |        +--> 写入通知和审计记录
    |
    +--> 用户收到分配通知
             |
             +--> 查看自己的线索
             +--> 收发邮件、记录跟进
             +--> 更新联系状态、客户阶段和下一步任务
             +--> 管理员看到跟进变化

Prospector 查询运价
    |
    v
Navigator API
    |
    v
Navigator PostgreSQL 运价库
```

中心 API 负责账号、权限、CRM 线索、分配、通知和审计。Navigator API 负责运价查询。Prospector 客户端的本地 SQLite 只保存本机缓存、邮箱配置、邮件索引和离线待同步记录，不是中心 CRM 的最终数据源。

## 三、数据和数据库怎么分

### 1. 中心 PostgreSQL

保存跨用户、跨客户端必须一致的数据：

- 账号、登录会话和产品权限
- 公司、联系人和线索归属
- 分配、跟进、任务、通知和审计
- 中心 CRM 的版本号、变更记录和同步信息

### 2. Navigator PostgreSQL

保存运价产品自己的数据：

- 运价
- 舱位
- 港口和基础选项
- Navigator 的业务账号和发布身份

### 3. Prospector 客户端 SQLite

保存单台电脑使用所需的本地数据：

- 邮箱账号的本机加密配置
- 邮件和收件箱索引
- CRM 的本地镜像和离线待同步操作
- 本机界面偏好和缓存

中心 CRM 和 Navigator 运价库不会因为客户端 SQLite 存在而产生第三套主数据。客户端恢复联网后，中心数据仍按权限和版本规则同步。

## 四、交付包里有什么

```text
prospector/
  dist-server/       中心 API 编译结果
  dist-admin/        管理工作台编译结果
  scripts/           中心服务启动、停止和状态检查脚本
  production-deployment.env.example
  README-deployment.md

navigator/
  Database/          Navigator Python 服务运行代码
  Skill/.../freight_identity/  Navigator 身份适配代码
  Skill/.../config/            空航管名单和空群清单部署模板
  Skill/navigator-agent-intake/ 外部 Agent 标准 JSON 提交说明与脚本

client/
  prospecting-email-setup-0.53.2-alpha.1.exe

MANIFEST.json        文件清单和排除项
```

包内不包含密码、Token、证书私钥、`.env`、数据库文件、日志、备份和真实业务图片。公司部署人员必须在服务器上单独配置这些内容。

## 五、服务器部署顺序

1. 准备 Windows、Node.js 22+、Python 和 PostgreSQL。
2. 创建中心 CRM PostgreSQL 数据库，并执行 Prospector 的数据库迁移。
3. 配置中心 API 的生产环境变量：
   - `PROSPECTOR_CENTER_MODE=production`
   - `PROSPECTOR_CENTER_PG_DSN`
   - `PROSPECTOR_CENTER_PUBLIC_ORIGIN`
4. 设置客户端中心地址。构建时把正式 HTTPS Origin 写入 `assets/center.json`：

   ```json
   { "baseUrl": "https://crm.company.internal" }
   ```

   也可以在受控启动环境中设置 `PROSPECTOR_CENTER_URL` 覆盖。桌面端只接受 HTTPS 中心；回环 HTTP 仅用于本机测试。

   开发机推荐用一条命令完成地址注入、构建和候选打包：

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/build-deployment.ps1 -CenterUrl https://crm.company.internal
   ```

5. 在 `prospector/` 执行：

   ```powershell
   npm ci --omit=dev
   node scripts/production-server.mjs start
   node scripts/production-server.mjs status
   ```

6. 检查中心 API 的 `/health/ready`。
7. 初始化正式超级管理员（仅空中心库执行一次）：

   ```powershell
   $env:PROSPECTOR_ADMIN_EMAIL = 'admin@company.internal'
   node scripts/bootstrap-production-admin.mjs
   ```

   密码通过隐藏输入或受控环境变量提供，不得写入脚本、聊天或交接包。已有超级管理员时脚本拒绝创建第二个。

8. 准备 Navigator PostgreSQL，并按 Navigator 的说明配置 `FREIGHT_POSTGRES_DSN`。
9. 启动 Navigator `manual_server.py`，确认运价接口可访问。

   交付包中的航管账号名单和群清单为空模板，不包含真实姓名或钉钉 ID。启用自动采集前，由受控部署流程写入正式名单和群配置；空名单足以启动查询与审核服务，但不会自动采集任何群。

   外部 Agent 提交已解析群聊记录时，在 Navigator 服务进程中单独设置至少 32 字符的 `NAVIGATOR_AGENT_API_TOKEN`，通过 HTTPS 反向代理访问 `POST /api/agent/intake/v1`。该 Token 与本地人工采集 Token 分开，不进入部署包。随包 `navigator/Skill/navigator-agent-intake/` 提供字段契约和提交脚本。

首次部署也可以在交接包根目录运行 `prospector\scripts\bootstrap-company-server.ps1`。脚本会逐步检查 Node/Python/psql，交互读取两个数据库账号密码，生成 Navigator 的本机配置，安装 PostgreSQL 驱动并初始化表结构；增加 `-StartServices` 才会启动两个服务并执行健康检查。脚本不会删除数据库、不会覆盖已有 DSN 配置，也不会把密码写入项目目录。

推荐的一体化部署入口是 `prospector\scripts\deploy-company-server.ps1`。部署人员通过受控环境变量提供现有 PostgreSQL 管理员 DSN，脚本不会创建新的数据库管理员；它只创建最小权限应用账号 `milogin_app` 和 `navigator_app` 及各自数据库，随机生成应用密码、写入域名和客户端配置、启动中心、创建拥有全部产品权限的默认超级管理员、初始化 Navigator，并执行中心 API、Navigator 与中心到 Navigator 的产品链健康检查。凭据只写入 `%ProgramData%` 下受 ACL 保护的文件。

```powershell
$env:MILOGIN_DATABASE_ADMIN_DSN = '<现有 PostgreSQL 管理员 DSN，手动写入受控环境>'
$env:MILOGIN_DEFAULT_ADMIN_PASSWORD = '<初始应用超级管理员密码，手动写入受控环境>'
.\prospector\scripts\deploy-company-server.ps1 `
  -CenterOrigin https://crm.company.internal `
  -NavigatorOrigin https://rates.company.internal `
  -AdminEmail zayne_jin@yqn.com
```

数据库管理员身份和中心应用身份是两类不同账号：前者只用于建库/建应用角色，不会成为产品登录账号；`-AdminEmail` 指定的中心账号才是 CRM、管理端和 Navigator 共用的产品超级管理员，创建后即可直接登录所有产品。密码不得写入脚本、ZIP 或聊天；必须满足现有至少 6 位 ASCII 字母或数字规则。未提供 `MILOGIN_DEFAULT_ADMIN_PASSWORD` 时，部署脚本会随机生成并写入受 ACL 保护的一次性凭据文件。正式使用后仍建议立即更换初始密码。

域名 DNS 和 HTTPS 反向代理必须先指向本机对应端口：中心 `127.0.0.1:55847`、Navigator `127.0.0.1:8795`。脚本验证 `deployment.json` 中的域名配置和产品链；无法控制云厂商 DNS，因此 DNS 记录本身仍由部署现场创建。

已有环境迁移不要复制 PostgreSQL 数据目录。源机运行：

```powershell
.\prospector\scripts\export-company-deployment.ps1 `
  -OutputDirectory D:\MiloginMigration -IncludeBusinessImages
```

目标服务器通过受控加密通道取得该目录后，在空应用数据库上执行同一部署入口并传入迁移包：

```powershell
.\prospector\scripts\deploy-company-server.ps1 `
  -CenterOrigin https://crm.company.internal `
  -NavigatorOrigin https://rates.company.internal `
  -AdminEmail zayne_jin@yqn.com `
  -MigrationBundle D:\MiloginMigration
```

迁移包包含逻辑数据库备份、业务群/发布人配置和可选运价图片，不包含旧登录会话、桌面刷新 Token、管理挑战或本机应用数据库密码。迁移完成后应删除源端迁移目录并轮换正式密码。
10. 部署 HTTPS 反向代理，再安装 `client/` 中的 Prospector 客户端。

中心 PostgreSQL 和 Navigator PostgreSQL 可以在同一台服务器上，但必须是两个独立数据库，账号权限也应分开。PostgreSQL 的 `5432` 不应直接暴露给客户端。

## 六、交接时需要公司提供或配置的内容

- 正式服务器和内网访问地址
- 中心 PostgreSQL 数据库和备份策略
- Navigator PostgreSQL 数据库和业务数据恢复方案
- HTTPS 证书和反向代理
- 中心服务账号、Navigator 服务账号和最小权限配置
- 邮件服务器、AI 服务和其他外部服务配置
- 正式账号及其权限分配
- 日志目录、备份目录和故障恢复负责人

密码、Token、证书私钥和邮箱授权码不要写进代码、交接包或聊天记录，应由公司部署人员在服务器环境中手工配置。

## 七、交接验收顺序

### 基础连通性

- 中心 API 能启动，`/health/ready` 正常。
- Navigator 能启动，运价查询接口正常。
- 客户端能通过 HTTPS 访问中心 API。

### 账号和权限

- 超级管理员可以登录管理工作台。
- 管理员和用户只能看到各自权限范围内的数据。
- 退出登录、重新登录和撤销会话有效。

### CRM 业务链路

1. 管理员导入一批测试线索。
2. 管理员确认公司和联系人数量正确。
3. 管理员把线索分配给用户。
4. 用户收到通知并看到分配线索。
5. 用户更新联系状态、客户阶段和下一步任务。
6. 管理员能看到状态变化和操作记录。
7. 重启客户端后，数据和未完成任务仍然存在。

### 运价链路

- Prospector 能跳转或调用 Navigator。
- Navigator 授权成功后，Prospector 能查询运价。
- Navigator 授权失败、无权限和服务不可用时，客户端显示明确错误，不白屏。

## 八、当前明确边界

- 当前版本使用邮箱和密码登录，尚未实现钉钉 OAuth/SSO 登录。
- 客户端安装包未做代码签名，公司首次安装可能出现 Windows 安全提示。
- Navigator 目前以 Python 运行时交付，未冻结为独立二进制。
- 交付包是“部署候选包”，不等于公司正式上线；正式账号、真实数据、HTTPS、备份恢复和跨机器验收必须由公司现场完成。
- 交付包不包含真实业务数据库和凭据。

## 九、出现问题时先看什么

1. 先执行中心服务 `status`，确认进程和日志路径。
2. 再检查 PostgreSQL 是否可连接。
3. 再检查 Navigator 是否能单独返回接口结果。
4. 最后检查客户端访问地址和 HTTPS 反向代理。

不要先删除数据库目录或重装客户端。先保留日志和错误时间，按“中心 API → PostgreSQL → Navigator → 客户端”的顺序定位。
