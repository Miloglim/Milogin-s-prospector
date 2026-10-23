# 本机中心账号与 API

## 2026-10-22 管理账号创建与密码重置

### 2026-10-23 管理账号删除

`POST /admin-api/command` 的 `user.delete` 只需一次管理端确认，不再要求管理员密码重新认证，也不再要求删除原因。服务端仍校验浏览器管理会话、CSRF、超级管理员权限和 `revision` 版本冲突，并继续拒绝自删、删除最后一名有效超级管理员、删除仍负责线索或存在未处理联系人分配的用户。旧请求中的空字符串原因按未填写处理，审计写入中性说明。

删除采用软删除并保留邮箱唯一记录，产品语义为“停用并归档”。`GET /admin-api/users` 默认只返回在用账号，`state=archived` 仅允许超级管理员读取归档账号。归档账号通过 `user.restore` 显式恢复，必须提交 `userId`、`revision` 和新初始密码；恢复后账号启用、强制首次改密、旧会话保持撤销，原有产品授权保留。`user.create` 和 `POST /api/auth/desktop/register` 遇到归档邮箱都返回 `CONFLICT`，不得静默恢复或接管；管理员应先到“已归档”列表执行恢复。

`GET /admin-api/users` 在数据库分页前按权限排序：身份超级管理员、当前管理产品的超级管理员、管理员、用户、审计员、未授权；同权限按创建时间倒序。未传 `productId` 时按 CRM 权限排序，查看 Navigator 用户时按该产品当前有效角色排序。

`POST /admin-api/command` 的 `user.create` 必须在请求体的独立 `password` 字段中携带管理员为账号设置的初始密码；该值只进入密码哈希，不写入管理命令、审计、日志或返回体。账号创建后仍设置 `must_change_password=true`，首次登录必须改成本人密码。服务端拒绝缺失或不符合账号密码规则的初始密码，禁止再用固定默认密码。

`user.delete` 的原因保持可选；页面发送未填写或空字符串时，服务端统一记录“未填写删除原因”，不得返回 `INVALID_INPUT`。

`POST /admin-api/command` 的 `user.reset-password` 会生成一次性恢复链接；`POST /admin-api/challenge` 在生产 HTTPS 环境同样可用，不依赖 `test_mode`。消费时仍校验同源、来源限流、15 分钟有效期、一次性令牌、账号未停用/删除和目标邮箱未变化；成功后更新中心凭据、撤销旧会话并记录审计。账号激活类 `challenge.issue` 仍只保留本机开通流程。

## 2026-10-21 只读系统运行摘要

`GET /admin-api/operations` 只接受有效浏览器管理会话，返回统一 `{ok:true,data:OperationsSummary}`。`OperationsSummary` 包含中心版本、`uptime_seconds`、检查时间和中心/数据库/磁盘/备份检查；transport 在读取中心快照后附加 Navigator `/api/health/live` 结果，Navigator 不可用时单项返回 `offline`，不影响其余中心状态返回。

读取权限与现有管理中心数据看板一致：中心超级管理员，或数据范围为 `summary`、具备 `metrics.read` 且身份为管理员/审计员。接口不返回连接串、文件路径、进程环境、Token 或日志；该节点没有发布、备份写入、Shell 或容器控制能力。

## 2026-10-21 账号资料与成长摘要

`GET /api/account/profile` 要求有效 API Bearer 会话，返回 `{ok:true,data:AccountProfile}`。服务端先从会话取得当前中心用户，再读取共享显示名、`identity.user_profiles.avatar_id/bio` 和 `identity.account_growth_projection`；不接受客户端 userId。无资料行时头像 ID 为 `default`、简介为空；无成长投影时 `growth=null`。存在投影时 `growth` 返回 `totalXp/cycle/level/levelProgress/levelCost/todayXp/todayKey`，等级进度由共享总经验派生。

`POST /api/account/profile` 只接受 `displayName/avatarId/bio` 的非空子集，始终作用于当前会话用户；无实际变化时不增加管理修订或审计。`POST /api/account/growth` 接受 `eventId/sourceProduct/eventType/subjectKey/points/ruleVersion/occurredAt`，服务端重新校验产品准入和事件规则，按 `source_product + event_type + subject_key` 去重，普通行为执行 30 XP 日上限，审批/修正事件不受单项上限，但仍计入当日普通上限消耗。重复请求返回 awarded=false，不重复加经验。

`POST /api/account/password` 供 Navigator 等 Web 产品使用普通 API Bearer 会话修改本人密码，body 为 `{currentPassword,newPassword}`。中心校验当前密码后更新 `identity.credentials`、递增 `security_revision` 并撤销该用户全部会话。Prospector 桌面继续使用 `/api/auth/desktop/password`，其最终凭据写入同一张中心表。任何产品都不得在中心模式下修改本地账号哈希冒充改密。

无令牌、伪造令牌、过期/撤销会话均返回 401；无对应产品准入返回 403；数据库异常返回统一 503，不返回密码、会话 Token 或内部查询信息。Prospector 桌面只经 `online:account-profile` 读取，不直接暴露中心令牌；Navigator 服务端使用同一中心用户会话写入资料并补传经验 outbox。

## 2026-10-16 公司与联系人生命周期接口

以下均要求现有 CRM Bearer 会话、实时账号/产品授权校验，统一 `{ok,data?,error?}`。定义与 IPC 对应见 `server/core/crm-lifecycle.ts`。

| HTTP | 请求 | 成功 data |
|---|---|---|
| GET /api/crm/companies | search/scope(all,personal,assigned)/limit/offset；拒绝未知或重复参数 | CompanyPage |
| GET /api/crm/companies/:id | 可选 scope | CompanyDetail |
| POST /api/crm/companies | name/domain?/idempotencyKey | CompanyDetail |
| POST /api/crm/companies/:id/delete | expectedRevision/idempotencyKey；body companyId 若提供须与路径一致 | {companyId} |
| POST /api/crm/contacts/delete | contacts[{contactId,customerId,expectedVersion}]/idempotencyKey | ContactDeleteReceipt |

分页上限100，批次上限200。创建域名为裸DNS名称，不接受URL。写请求拒绝未知字段；删除前逐条加锁并核对现行能力、归属和版本。版本冲突为CONFLICT；无权限/不存在不返回该记录详情。批量任一失败整体回滚。幂等记录复用crm_lead_idempotency，同键异请求冲突，成功重试不重复审计。联系人软删除不回收邮箱唯一性；公司仅无任何联系人/客户关联时允许软删除。来源管理员或全局超级管理员可删，受分配普通用户不可删；pending请求须先撤回。删除事件是审计，不新增消息中心推送，其他客户端周期同步。

迁移022及验收见 `docs/crm-lifecycle-delivery-20261016.md`。

2026-10-10，身份/API最初节点为0.11.0-alpha.1；当前工作区0.14.0-alpha.1包含 [管理工作台M1](management-platform.md) 与首次强制改密，未发布。下面是原API与边界说明；浏览器入口/细粒度权限/003与004迁移以M1文档为准。原个人模式仍使用SQLite；[M2线索协作](m2-lead-collaboration.md)已接桌面登录、中心线索导入/领取/跟进与持久通知。Navigator、正式运价账号和持续邮件任务不在本节点。

## 启动与测试

在项目根目录运行：

```powershell
npm.cmd run crm:online:start
npm.cmd run crm:online:status
npm.cmd run crm:online:test
npm.cmd run crm:online:stop
```

启动命令编译管理前端与server，核对/启动前节点独立PG，显式 `--test` 启动中心；根地址 `http://127.0.0.1:55844/` 提供管理页面。后台Node不是Windows服务，不随电脑启动。停止中心保留PG与测试身份；停止PG使用前节点 `crm:pg:stop`，不操作已有运价服务。

最高管理员为 `admin@yqn.com`，已一次性初始化，首次必须通过浏览器改密，改密前不提供 API 登录和管理访问。初始密码不在源码/日志中；fixture里的管理员旧随机密码已不生效。其余三个随机账户 agent-admin@example.invalid、agent-user@example.invalid、（已删除的临时账号） 的凭据在本机 `.work/pg-crm/online-fixtures.json`。在本机自行使用，不发送到 Agent 对话；对话不是安全存储。全部 emailVerified=false，不代表已真实验证邮箱。

重新启动复用固定测试 userId 与密码文件；数据库初始化不覆盖现有密码、角色或停用状态。文件缺失或不匹配而数据库已有身份时拒绝初始化，不自动接管已有邮箱。`test_mode=false` 不创建 fixture；生命周期脚本当前仍要求显式 --test，不能将其当作生产部署入口。

`crm:online:test` 显式执行真实PG/HTTP和管理/前端相关测试，文件之间串行运行，避免故障注入互相干扰。普通 `npm test` 跳过需PG的三套集成测试；跳过不算数据库验收。新机器需先按 [PG基础](crm-postgres-foundation.md) 准备安装工具。

## API 契约

### Navigator 产品授权（2026-10-15，测试环境）

复用已有 `navigator` 产品 ID。中心超级管理员在 Navigator 固定为 `admin`；身份超级管理员可通过 `POST /admin-api/command` 的 `navigator.update` 为普通中心账号授予 `operations`（运价库航管）或 `sales`，也可停用准入。CRM 角色不自动产生 Navigator 授权。`GET /api/navigator/access` 使用有效 API bearer，返回 `{ok:true,data:{userId,email,displayName,role}}`，角色为 `admin|operator|sales`；无准入 403，无效/过期会话 401，中心故障 503。每次请求重新核验用户启用、会话、安全版本、强制改密和当前 Navigator grant/access，撤权不等待旧会话到期。此接口供后续运价库服务端核对，不把浏览器角色声明当作凭据。8795 尚未调用此接口；中心仍是回环测试节点。

当会话有效但账号仍处于首次强制改密状态时，`GET /api/navigator/access` 返回 403 `PASSWORD_CHANGE_REQUIRED`；客户端必须提示用户先在管理中心完成初始改密，不得将其解释成账号或 Navigator 产品权限不存在。

### 正式接入前的身份与环境隔离（2026-10-15，进行中）

正式中心仍不是可通过改一个端口投产的服务：原启动器继续强制测试模式并拒绝正式环境混用。数据库适配器与业务仓储已有显式环境校验，独立数据库和单一超管白名单迁移已完成；正式 Web 启动器、开机常驻、备份恢复演练和 HTTPS 反向代理尚未完成，不开放正式浏览器登录。不得修改测试库标记来绕过保护。

代码准备进度：已新增显式 `PROSPECTOR_CENTER_MODE=production` 分支，数据库仅接受 `PROSPECTOR_CENTER_PG_DSN` 指向 `127.0.0.1:55846/milogin_center`、用户 `milogin_app`；HTTP 仅监听 `127.0.0.1:55847`，`PROSPECTOR_CENTER_PUBLIC_ORIGIN` 必须是精确的 HTTPS origin。正式模式的管理请求按该 origin 校验，Cookie 带 Secure，离线签名目录与测试节点分开。没有配置这些值时拒绝正式模式；当前 Web 启动脚本仍只准测试模式，不得手动绕过启动闸门。

2026-10-15 只读盘点当前中心测试库：未删除身份 76 个，其中 `example.invalid` 邮箱 45 个、无登录邮箱 28 个、其他邮箱 3 个；其他邮箱均未完成邮箱验证。这只是当前快照，不代表 3 个就是应迁的真实账号。正式身份迁移必须以稳定 `userId` 和账号所有权核对后的白名单执行；不整库复制身份、测试用户、会话、验证码或临时授权，也不通过同名/同邮箱猜测与运价库账号的关系。正式环境账号名单未确认前，不执行数据迁移或切换。

本机独立库：`node scripts/center-postgres.mjs start|status|backup` 管理 `C:\ProgramData\MiloginCenter` 下的 PostgreSQL 18 专用集群，仅回环监听 55846。口令只保存在受限目录，不在仓库或命令行参数中。`node scripts/center-migrate-admin.mjs` 在空库建表并只迁 `admin@yqn.com` 的稳定身份和密码摘要；目标身份表已存在时拒绝重跑。`node scripts/center-migrate-admin.mjs verify` 只读核验来源与目标身份、账号总数和会话。2026-10-15 已执行：迁移前备份、建表、单一超管迁移、迁移后备份及备份目录清单校验；复核为账号 1、会话 0、刷新凭据 0。没有迁产品授权、测试账号、联系人或业务数据，也没有进行真实密码登录或备份恢复演练。独立集群当前已启动，但未注册 Windows 开机服务；不得据此宣称全天候正式运行。

唯一常量与类型：`server/core/auth.ts`。所有响应使用 `{ ok, data?, error? }`；错误为 `{ code, message }`，不包含异常栈、SQL或凭据。未知路径/方法 404；失败码映射到 400/401/403/409/413/429/503。

| 方法与路径 | 请求/权限 | 成功数据 |
|---|---|---|
| GET /health/live | 无凭据，仅回环 | status、instanceId、pid，用于确认本节点进程 |
| GET /health/ready | 无凭据，仅回环 | ok=true 表示身份表可查询；DB失败503 |
| POST /api/auth/login | application/json；只允许 email、password | token、expiresAt、identity |
| GET /api/auth/me | Authorization: Bearer token | userId、displayName、email、emailVerified、identityAdmin、crmRoles |
| POST /api/auth/logout | 当前有效会话 | ok=true，当前会话撤销；其他会话不受影响 |
| GET /api/admin/users | 当前身份管理权；不因CRM管理员而获得 | 安全身份数组，当前固定上限100，无密码摘要；完整分页后续接入 |
| GET /api/crm/access | 当前CRM产品角色 | capabilities；无准入403，不返回CRM客户数据 |

身份管理权与产品角色分别授权。CRM admin 只有 crm:manage，运营为导入/发布/查看反馈能力，销售为领取/开发能力。此处能力是后续业务接口的授权基础，不代表这些业务接口已实现。任意邮箱正式注册仍须验证及内部邀请/审批，不开放匿名注册。

## 数据、配置与安全边界

001 CRM 迁移原文未改；002-identity-foundation 新增 identity 命名空间的 users、login_emails、credentials、product_grants、sessions、audit。两迁移分别保存校验和，事务/锁防漂移。userId 是稳定 UUID；邮箱不是主键。日志及安全审计不保存密码或会话原文，审计目前记录 fixture/login/logout，正式人员管理审计后续补齐。

密码使用带参数版本的异步 scrypt、独立随机盐和恒时比较。参数 N=131072、r=8、p=1，单任务 maxmem=256MiB，最多并发2项，超限503；依据 [OWASP密码存储建议](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) 和 [Node scrypt文档](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)。本机单次样本约210ms，采样进程峰值RSS约185MiB；不是生产压测或多用户容量结论。

随机32字节短期不透明令牌，只将SHA-256摘要存入会话表。每次请求重新检查账号启用、安全版本、会话撤销/过期及当前产品角色；服务重启不重建已撤销会话。管理员数据查询在同一SQL快照内再次检查管理权，避免先授权后读取之间的撤权空隙。无刷新令牌，到期重新登录。

运行配置 `.work/pg-crm/online.json` 唯一默认值来自 core/auth.ts：

| 键 | 默认/限制 |
|---|---|
| host、port | 127.0.0.1、55844，当前拒绝其他绑定 |
| test_mode | 默认false；显式测试启动首次写true，不自动覆盖已有配置 |
| session_ttl_seconds | 3600，上限86400 |
| login_window_seconds、login_max_attempts | 300、8，同邮箱窗口内累计所有尝试 |
| login_ip_max_attempts | 64，同来源累计，换邮箱也受限 |
| rate_bucket_max | 1000，满时拒绝新键，过期后清理 |
| password_concurrency | 2，当前不允许调高 |
| request_timeout_seconds | 10，HTTP请求/头部与闲置连接超时 |
| request_body_bytes | 4096，当前不允许调高，含chunked请求 |

限频计数在进程内，重启会清空；本机受控验证允许，公网需独立限频与部署评审。配置、fixture、进程标记和日志均在前节点受控 `.work/pg-crm/` 中，不入Git。Windows继承该目录仅当前用户的ACL，不能只依靠文件mode声称Windows权限已保护。

HTTP拒绝不匹配Host与跨站请求，无宽泛CORS；`/api/*` 仍拒绝浏览器Origin，用于本机非浏览器API客户端。M1新增独立 `/admin-api/*` 同源浏览器Cookie登录，不放宽原API，桌面/PKCE另行接入。跨设备先配置可信TLS；当前不得改绑定地址后直接在局域网明文登录。

身份与CRM目前同进程、同测试PG连接权限，只是模块/命名空间分离，不是正式凭据隔离。正式服务须拆权限及迁移/业务角色。未读取生产身份或真实邮件，不应对现有正式安全风险作修复声明。

## 验收与回退

真实 HTTP/PG 测试覆盖角色伪造、双管理员权限分开、销售独立会话、过期/撤销/安全版本、即时撤权/停用、重启后撤销、密码并发、数据库失败503、Host/Origin、JSON及含chunked体积限制、迁移漂移与fixture不复活。另对独立Node进程执行启动→登录→退出→停止→重启，验证旧令牌拒绝、另一销售会话仍有效、fixture文件不变。

源码/schema改前 checkpoint：`D:/Agent Basement/checkpoints/prospector-auth-api-preflight-20261010-182300`，331份源码与schema-only快照，不含业务行/密钥。只读独立复核未发现可确认P0–P2问题，不代表生产部署安全认证。

原0.11身份节点的回退说明不直接适用于已运行M1的数据库；先按 [M1回退边界](management-platform.md#验证和检查点) 保留新的授权/密码及browser会话变化，禁止只删002账本后DROP整个identity。定向删除结构/数据需单独确认，本轮未执行。不要整仓reset或将schema快照导入正式运价库。


## 测试账号规范（2026-10-12）

- 中心测试数据库只保留两个固定 Agent 账号：`agent-admin@example.invalid`（管理员）和 `agent-user@example.invalid`（用户）。凭据只存本机受控 `.work/pg-crm/online-fixtures.json`，不写入对话、源码、日志。
- 需要临时账号时，测试必须在隔离数据库或可回收事务中创建；任务结束删除账号及关联的线索、通知、会话和审计测试记录，不得写入当前中心测试库。
- 当前历史测试曾直接复用中心库，已在 checkpoint 后清理 965 个临时身份及其关联测试数据，仅保留 4 个真实/固定身份；后续新增集成测试前先完成隔离数据库节点。
- 超级管理员现为 `admin@yqn.com`，user_id 与密码摘要不变，下次登录强制改密；不得在 Agent 对话中传递密码。

## 2026-10-15 共享公司资料写入

`POST /api/crm/contacts/:contactId/company`：请求为`CenterCompanyUpdate`，路径与请求contactId必须相同；customerId仅用于核对授权关联，不授予同公司其他联系人权限。

- 严格字段：contactId/customerId、expectedRevision、idempotencyKey、fields。fields仅接受name/domain/country/industry/size/backcheckData，拒绝额外权限字段、空修改和过大报告。
- 详情company.revision为数据库原始微秒时间戳文本，保存使用行锁和版本比较；冲突不覆盖，返回CONFLICT。不能用经过JS毫秒截断的updatedAt代替。
- 超级管理员或有共享资料编辑资格的创建方可修改；普通受分配用户不能覆盖运营共享公司档案。每次服务端重新验证身份和授权，重放也必须重新授权。
- 写入现有companies字段，以现有幂等记录和contactEvent审计保存回执，不新增数据表。背调仅生成后再调用该接口保存，生成失败不改变公司资料。
