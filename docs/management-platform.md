# 本机管理工作台 M1

## 2026-10-21 系统运行（0.55.0-alpha.1，工作区未发布）

管理中心一级导航新增“系统运行”，沿用现有管理中心视觉和权限体系。页面只读展示中心版本与运行时长、Navigator 健康、中心 PostgreSQL 大小、服务器磁盘使用率及自动备份尚未接入状态；后台刷新失败时保留上次快照并显示警告。

实现复用 `ManagementDashboardRepository`，没有引入独立运维服务、控制代理、Shell 或 Docker Socket。Navigator 健康由 transport 使用固定内部地址读取，单个依赖离线不会把整页变成不可用。本节点没有发布、回滚、删除、备份写入或日志查看按钮。

## 2026-10-13 密码与账号字符规范（0.28.2-alpha.1）

创建账号的初始密码、首次改密和重置密码设置统一为至少6位，仅允许英文字母和数字；邮箱拒绝前后空格和中文/空白字符。登录仍兼容既有历史密码，避免规则升级造成存量账号全部无法登录；后续改密必须符合新规则。无新IPC、HTTP路由、依赖或迁移。

## 2026-10-13 删除确认文案（0.28.1-alpha.1）

删除用户仍需超级管理员重新验证自己的管理员密码，并二次输入目标用户邮箱；界面明确标注两者用途，不要求知道目标用户密码。删除原因改为可选，服务端空值统一写入“未填写删除原因”作为审计说明。保留超级管理员权限检查、禁止删除本人、禁止删除最后有效超级管理员、负责人线索保护、CSRF、版本校验和审计。无新IPC、HTTP路由、依赖或迁移。

## 2026-10-12 创建身份与直接保存权限（0.28.0-alpha.1）

当前行为覆盖下文历史创建与权限确认描述：创建用户只填写邮箱和身份（默认用户），不填写姓名，不生成激活链接。超级管理员提交既有POST /admin-api/command的user.create命令；服务端生成初始密码摘要，在一个事务内创建账号、邮箱、凭据及Prospector准入/角色/能力/范围，设置must_change_password=true。初始密码按用户约定，首次登录必须完成改密，业务接口在改密前不可用；显示名暂按邮箱前缀生成。普通管理员不能通过此命令创建或提升超级管理员。旧激活挑战契约保留兼容已生成链接，没有新增账号库。

基础权限user.update与产品授权product.update直接保存，无二次确认或重新输入密码；保留登录态、首次改密拦截、服务端权限/范围校验、CSRF、revision和审计。审计原因由当前保存动作生成。删除与重置密码沿用原确认与重新验密流程。无新HTTP路由、IPC、依赖或迁移。

验证：23项定向单元测试、6项真实PG回滚测试、类型/服务及管理构建/架构检查通过；Chrome真实构建+模拟API验证邮箱/身份创建、基础及产品权限直接保存，页面异常0。固定Agent账号真实读权限边界与退出通过，共享库仍5个身份，无新增持久测试账号。真实超级管理员页面写入未执行。中心已重启，checkpoint D:/Agent Basement/checkpoints/prospector-create-role-direct-save-20261012；浏览器证据.work/direct-create-smoke.json。未发布。

## 2026-10-12 复用Navigator管理页面（0.27.1-alpha.1）

用户要求沿用8795账号管理页面，参考本机Navigator的web/admin-terminal.js、web/admin-terminal.css、core/admin_contracts.py及transport/admin_routes.py。迁移其人员/账号合并列、列表卡片、整页人员档案、头像摘要、返回列表、账号档案与安全分区、灰蓝视觉和紧凑表格；替换原详情抽屉。保留用户要求的两个一级入口及产品选择，未照搬Navigator专有导航和教学文案。

账号功能适配现有中心链路，非复制Python账号存储：Navigator list/detail → 当前users与用户详情；create_account → challenge.issue activate；security reset_password → user.reset-password；disable/enable → user.update；role → product.update；sessions → sessions/session.revoke；events → 按userId筛选的audit；delete → user.delete软删除。浏览器通信是HTTP API，不是Electron IPC。保留当前重新验密、CSRF、revision、审计和删除保护，不直接调用8795的operators写接口，防止两套身份漂移。

Navigator的工号/部门/经验档案、报价发布人归属、业务记录和安全事件汇总未迁入中心数据库，未新增无数据字段，未宣称两个后端已统一。Navigator仓库仅只读参考，没有修改或重启。无新IPC/API/依赖/表。Checkpoint D:/Agent Basement/checkpoints/prospector-navigator-admin-layout-20261012。

管理类型/构建、16项定向测试、架构及实际Chrome模拟接口验证通过：创建/重置/删除确认、本人保护、人员整页详情、产品切换、用户审计请求，页面异常0。运行时用真实构建与模拟身份，不操作真实账号。本轮未重验真实数据库业务写入。刷新55844查看迁移后的布局。

## 2026-10-12 创建、重置与删除用户（0.27.0-alpha.1）

- 顶部“创建用户”替代邀请/恢复，填写邮箱和姓名，经重新验密与原因确认后生成一次性激活链接，不自动发送邮件。创建全局待激活身份，产品权限仍在详情独立配置，无自动超级管理员授权。重复邮箱（包括软删除身份）返回冲突。
- “重置密码”位于目标用户基础配置，以userId和revision提交，不接收前端邮箱改绑。生成链接时即撤销该用户已有会话、递增安全版本；链接消费后更新密码并再次撤销会话。普通停用/软删除账号不允许重置；本人使用正常改密流程，页面不开放本人重置入口。
- “删除用户”位于详情底部危险区，需要输入目标邮箱确认、重新验密和原因。服务器禁止删除本人/最后一个有效超级管理员/仍负责线索的用户；拒绝旧revision。soft delete设置deleted_at、active=false，递增安全和管理版本，撤销会话/未消费挑战，保留邮箱、角色配置及历史业务外键与审计。普通user.update和挑战消费不能复活删除账号。恢复账号界面未在此节点实现。
- 追加015-user-lifecycle迁移，在identity.users增加deleted_at及已删除不可active约束，旧迁移校验不变。网页用户列表与既有API用户目录均排除deleted_at非空用户；CRM读取/写入与会话轮换沿用active/安全版本鉴权。CRM归属写入和删除共用ADMIN_LOCK，防止检查后又被分配线索。
- 复用POST /admin-api/command及challenge消费路由，AdminCommand新增user.delete/user.reset-password（userId、revision、reason）；注册、返回包装及IPC不变。原challenge.issue保留契约兼容，recover同样执行停用/删除拦截和会话撤销，没有新增重复账号系统或HTTP入口。

验收：24项定向单元测试、5项真实PG回滚测试、管理/服务/桌面类型与构建、架构检查通过。真实Chrome+模拟API通过创建、用户绑定重置、错邮箱不能删除、本人删除禁用，页面异常0；固定Agent真实登录验证原鉴权范围和退出。回滚测试所有临时身份、线索、审计均不提交，当前5个身份包含此前已存在的业务账号，本节点未新增持久测试账号。真实超级管理员页面写入与外发邮件未测试；链接仍15分钟有效，正式投递/账号恢复/过期链接重发入口未实施。

Checkpoint：D:/Agent Basement/checkpoints/prospector-user-lifecycle-20261012；页面证据位于.work/admin-lifecycle-smoke.json及截图。中心已在127.0.0.1:55844运行，未发布。回退代码前须保留已执行生命周期操作，不能仅恢复旧代码重新暴露软删除用户。

## 2026-10-12 用户管理中心重整（0.26.0-alpha.1）

当前导航覆盖下文旧M1分区：一级仅“用户管理中心”和“产品管理中心”。账号是全产品共用身份，超级管理员列表读取全局身份，不以某个产品是否准入筛掉账号。普通管理员仍按服务端原有Prospector成员权限读取，前端导航改名不扩大可见范围。

用户详情统一为基础配置、产品权限、交互记录、管理审计；产品通过下拉选择。Prospector沿用准入、角色、能力与范围授权和重新验密/原因确认。Navigator保持未适配状态，不读取运价、不把Prospector权限冒充Navigator权限。产品管理中心只保留未开放空页。

复用`GET /admin-api/audit`，新增可选`userId` UUID参数，和既有`productId`共同筛选：账号必须为日志的actor_id或target_id；不按姓名匹配，不改变现有权限检查。省略userId保持原接口行为。账号与安全范围仍由超级管理员读取，产品范围仍需audit.read。管理审计是授权/身份/会话变更日志，不是邮件或线索业务活动；用户交互记录尚未接入。

无新IPC、路由、依赖、表或角色代码。删除重整页面中不再使用的产品列表请求。账号/产品切换和退出使旧查询失效，详情清空旧记录后再读取。源码checkpoint：`D:/Agent Basement/checkpoints/prospector-admin-navigation-20261012`。

验证：13项定向单元测试、桌面/管理/服务类型检查、管理构建、架构检查通过。实际Chrome运行构建产物，接口模拟验证全局列表、产品切换、UUID审计查询和普通管理员产品范围，页面异常0；固定Agent管理员真实登录验证产品成员200、全局成员403、非法审计UUID400、无审计权限403并退出。身份总数仍4，无新测试账号。超级管理员真实读写及Navigator业务适配未在本节点实测；保留用户首次改密要求。浏览器证据在`.work/admin-navigation-smoke.json`及截图。未发布。

2026-10-10，工作区 `0.14.0-alpha.1`，未发布。已按用户“开始吧”批准实施 M1，并按后续明确要求配置最高管理员与首次强制改密。仅回环测试；原个人CRM保留SQLite，[M2在线协作](m2-lead-collaboration.md)经桌面访问中心PG。本网页仍为账号/授权工作台，业务活动汇总未接；Navigator正式账号与运价数据库未接管。

## 使用

```powershell
npm.cmd run crm:online:start
npm.cmd run crm:online:status
npm.cmd run crm:online:test
npm.cmd run crm:online:stop
```

访问 `http://127.0.0.1:55844/`。启动先构建管理页面与 server，再核对隔离 PG 55843 并启动后台 Node。修改服务源码后先 stop 再 start；已有进程不会自动加载新源码。没有 Windows 常驻服务，不随开机启动。

最高管理员邮箱为 `admin@yqn.com`，具有身份管理权和当前全部 CRM 固定角色/能力。初始密码按用户明确要求一次性设置，数据库只存 scrypt 摘要；源码、日志与文档不记录其原文。首次浏览器登录仅能检查本人会话、退出或改密，其他管理读取/写入及 API 访问均由服务端拒绝。新密码至少12字符、不能与当前密码相同，须验证当前密码。成功后撤销该账号全部会话与未消费挑战、写审计/outbox，重新登录。重启不会重置密码或恢复权限。

一次性本机初始化命令为 `node scripts/bootstrap-admin.mjs --test`（先构建 server）。需要输入时使用无回显标准输入，或在本机手动配置临时 `PROSPECTOR_ADMIN_INITIAL_PASSWORD` 环境变量，不向 Agent 发送密码。初始化同时检查数据库审计与本地 `.work/pg-crm/admin-bootstrap.json` 元数据，并在管理事务锁内复查，重复执行不覆盖已设密码。fixture 文件中的管理员旧随机密码不是当前有效密码；其余运营/销售测试凭据仍可在本机受控 fixture 文件查看。正式邮箱投递与验证尚未接入，该邮箱目前仍未验证。

页面复用桌面 `brandTheme` 的近黑、灰白和既有 Ant Design 组件，支持浅色/深色、紧凑表格、详情抽屉与窄屏。浏览器主题偏好可写 localStorage，凭据、CSRF 和激活材料不写 localStorage。

## 管理边界

| 分区 | 本节点已实现 | 尚未实现 |
|---|---|---|
| 身份与安全 | 姓名/邮箱分页搜索、全局启停、身份管理标志、设备会话撤销、管理审计、测试邀请/恢复 | 正式注册邮件、邮箱验证码、后台任意 SQL、生产用户迁移 |
| Prospector | 测试成员、产品准入、固定角色/能力子集、数据范围预览、产品管理审计 | 在线线索/客户/邮件/活动读取、领取分配、销售通知、持续开发任务 |
| Navigator | 独立入口及明确未接入状态 | 成员、交互和审计真实适配；中心不提供运价查询 |

身份管理员只有全局身份维护权，不自动获得产品业务内容权。产品授权管理员需当前 CRM `admin` 角色及 `access.manage`、`roles.manage`，不因此成为身份管理员。销售不能授角色。审计员与运营/销售使用固定模板，能力只能取所选模板的子集；未知能力和 Navigator 命令拒绝。

`roles.manage` 允许委托固定 CRM 模板内的能力，不要求管理者本人具有这些业务读取权；授予上限仍限定为 CRM 固定模板及管理者的范围上限。本人不能通过修改角色扩大自己的能力。范围是 own/shared/summary；按角色模板限制，并受管理者范围限制。本节点只维护授权元数据和预览，业务对象与字段范围需下一节点接口落实，不能据此宣称客户数据已经在线隔离。

管理 DTO 的 `crmRoles` 表示配置的角色模板，撤销准入后仍保留；登录身份的 `crmRoles` 只表示当前生效角色。运行授权查 active grants 与 product_access，不将保留的配置当成有效访问权。

## HTTP 契约

唯一常量与类型在 `server/core/admin.ts`，返回 `{ ok, data?, error? }`。API 令牌继续使用 `/api/*` 和 `client=api`，管理页面使用 `/admin-api/*` 和 `client=browser`；两者不可交叉使用。

| 方法与路径 | 入参/成功数据 | 限制 |
|---|---|---|
| GET / | 管理页面静态入口 | 无身份数据，资源仅固定构建目录 |
| POST /admin-api/login | email/password → identity、csrf、expiresAt | 同源、限频；令牌只写 HttpOnly Cookie，不返回 JSON |
| GET /admin-api/me | identity、csrf | 当前有效浏览器会话 |
| POST /admin-api/logout | 当前 Cookie 与 CSRF → ok | 撤销当前会话，清除 Cookie |
| POST /admin-api/password | currentPassword/newPassword → ok | 同源、CSRF、限频；验证当前密码，事务变更并撤销所有会话，清除 Cookie |
| GET /admin-api/users | search/limit/offset/productId? → items、total | 身份管理员全局，或 CRM members.read；计数与分页同一授权快照 |
| GET /admin-api/products | 产品目录、连接状态、本人有效能力/角色/范围 | 当前会话；Navigator connected=false |
| GET /admin-api/sessions | userId → 安全会话列表 | 身份管理员或本人；最多最近100条，无令牌或摘要 |
| GET /admin-api/audit | productId? → 安全管理审计 | 无产品参数需身份管理权；CRM需 audit.read；最多100条 |
| POST /admin-api/command | command/password → mutation结果 | 同源、CSRF、限频、密码重新认证、当前事务内授权 |
| POST /admin-api/challenge | token/password → ok | 同源、限频，仅test_mode；一次性用途绑定激活/恢复 |

command 有 `user.update`（userId/revision/active/identityAdmin/reason）、`product.update`（userId/revision/productId=crm/active/roles/capabilities/scope/reason）、`session.revoke`（userId/sessionId/reason）、`challenge.issue`（purpose/email/displayName/reason）。所有变更必须填写非空原因，不接受声明的操作者身份。版本冲突409，不覆盖新修改。

Cookie 为 HttpOnly、SameSite=Strict、Path=/，当前 HTTP 回环不设 Secure。POST 校验准确 Origin 和 CSRF（登录与匿名挑战消费单独同源校验），无宽泛 CORS；Host 必须匹配监听端点。CSP 禁止外部脚本、对象和嵌入，Referrer-Policy=no-referrer。激活页先移除地址里的挑战，再请求 API；链接不保存为使用统计，不输出到日志或 Git。

账号停用提高 security_revision 并撤销所有会话/未消费挑战；产品变更每次请求读取当前准入，旧 Cookie 不保留旧授权。浏览器退出/失效清空身份相关状态，迟到的旧响应不能写入新身份或退出新会话。共享密码并发上限2、请求体4096字节，登录/重新认证/挑战使用受限内存桶，重启计数会清空；不是公网限频方案。

## 一次性测试邀请

管理员填写邮箱/姓名/用途，重新验证本人密码并填写原因；页面只显示一次挑战链接，不发送真实邮件。用户设自己的密码，管理员不能读取或指定长期密码。链接900秒有效，数据库仅存摘要，消费与密码更新/安全版本/撤会话/审计同事务。

activation 为未设置凭据的 inactive 待激活身份；可重发并使旧链接失效。已有已激活身份禁止 activation，恢复必须用 recovery。停用的已激活账号不能通过 recovery 重新启用。待激活身份不能通过普通 `user.update` 先启用；最后管理员统计要求启用、身份管理权、真实凭据和登录邮箱，并在事务锁内检查，防止同时停用导致全员失去管理入口。`emailVerified` 保持 false，测试挑战不证明邮箱控制权。

## 2026-10-13 Prospector 数据管理看板

产品管理中心的 Prospector 入口新增三个 Tag：运行总览、数据流、数据库。运行总览展示中心数据库正常数、活跃账号、客户记录和待处理事件；数据流展示导入、业务事件投递、跟进任务到期提醒及阶段节点；数据库展示身份库、Prospector 业务库和暂未接入中心遥测的桌面个人数据。

看板通过只读 `GET /admin-api/dashboard` 读取真实中心统计，沿用统一 Result、浏览器会话和管理权限。只有超级管理员，或 summary 范围且具备 metrics.read 的 admin/auditor 可读取全局统计；运营/销售账号收到拒绝结果。未接入的本地数据明确标记为“未接入”，不推断为正常或离线。

数据流“查看回执”抽屉展示每链路最近20条记录：导入新增/重复/无效与限制冲突数、事件消费及通知投影数、当前任务版本的提醒回执。事件已消费不等于用户已读，任务提醒入队不等于已送达；阶段节点是链路说明，不伪造逐阶段运行轨迹。身份与业务区共用一个中心PostgreSQL，记录数以标注的实体为口径；客户时间取最近创建时间，不冒充全表最后更新。当前仅查询与定位，不提供重跑、暂停或修改业务记录。

验收：14项定向单元/API/HTTP/渲染测试、类型/管理构建/服务构建/架构检查通过；生产管理前端与真实PG/HTTP隔离事务中验证200/401/403、三标签、回执抽屉、刷新失败提示及1440/744/390像素无横溢，页面异常0，测试身份/会话回滚前后计数一致。未验证用户本人超级管理员会话及公网部署。本次交付快照与无秘密验收报告：`D:/Agent Basement/checkpoints/prospector-management-dashboard-20261013`。

## 数据与分层

001/002/003 SQL 原文及账本校验保留。003-management-m1 增加用户 management_revision、会话 session_id/client、auditor 角色、产品目录、product_access、management_audit、management_challenges、outbox。004-mandatory-password-change 独立新增用户 must_change_password，现有其他身份默认 false。改密事务检查当前 browser 会话、原凭据摘要和安全版本，使用同一管理锁与行锁，防止撤权或并发改密后旧请求覆盖新密码。角色仍唯一存于 product_grants；product_access 不复制角色，只存准入、范围和可选能力上限。

管理变更与管理审计/outbox 同事务。outbox 当前是待后续消费的事务事件记录，没有消息推送、自动通知或已经送达的保证；不能把它计为在线 CRM 链路完成。身份审计、产品管理审计与未来业务交互数据分开，中心不归集私人邮箱全文或真实报价表。

core 契约 → services 无 IO → PG/密码/静态资源 adapters；transport 只编排 HTTP、安全头、请求和返回。`admin-web/` 为独立管理入口，`vite.admin.config.ts`/`tsconfig.admin.json` 编译到忽略目录 `dist-admin/`；`crm:admin:build` 使用现有依赖，没有新增 npm 包。

## 验证和检查点

0.13 强制改密节点：54项专用测试通过，含3项新增真实PG/HTTP与2项服务单元；普通回归771通过/67跳过，其中37项PG/HTTP由专用命令另验。验证初始短密码例外仅限指定管理员且仅强制改密阶段，管理/API拒绝、CSRF、错当前密码、弱密码/复用、旧会话全部失效、fixture不重置。独立源码复核发现并修复并发初始化覆盖风险，复核无剩余可确认P0–P2；不代表生产安全认证。

本节点改前源码/schema检查点：`D:/Agent Basement/checkpoints/prospector-admin-password-preflight-20261010`，改后交付位于 `delivery/`。不保存密码、会话原文或业务数据行；下述49项结果为前一M1节点历史验证。

真实Edge验证指定管理员初始登录进入改密页、无管理菜单、管理读取403；随后退出，保留其待用户改密状态。另用隔离测试账号完成页面改密→重新登录→管理页面验证，页面异常0。重复初始化命令验证未重置；类型/管理构建与架构检查通过。浏览器脚本与无秘密截图/报告保存在本节点checkpoint。

49项专用测试通过：13项M1真实PG/HTTP、11项原身份HTTP/PG、10项CRM、6项密码与边界、3项浏览器HTTP边界、6项前端API/委托。含两个管理员同时停用、过期邀请重发、无凭据误启用、准入撤销/恢复、会话资源隔离、版本冲突、挑战一次性和HTTP重启后撤权。独立静态复核发现三项缺陷，复现失败测试后修复，复核未发现新增可确认P0–P2问题；不是生产安全认证。

实际 Edge 自动化通过登录、搜索、授权预览、Navigator未接入、浅深主题、390px无页面横溢、邀请重认证、匿名挑战消费与地址清除、真实授予销售角色/撤销准入/保留模板恢复、管理审计与退出；页面异常和服务5xx均为0。完整回归769通过/64跳过，其中34项PG集成已由专用命令执行，其余跳过仍未验收。桌面与管理类型检查、5项架构检查器测试、桌面/管理构建通过。管理构建约1MB未压缩、320KB gzip，有体积提示；本机测试可用，不是生产性能验收。

改前：`D:/Agent Basement/checkpoints/prospector-admin-m1-preflight-20261010`，347份源码/契约及schema-only、哈希；verification含截图与无秘密的浏览器报告。改后交付：同目录 `delivery/` 与清单，保存本节点文件及结构。不包含客户数据行、运行凭据或 `.env`。

回退先停止本机中心，保存实施后的授权/密码变更并核对定向文件清单；不要整仓reset或整库覆盖。仅恢复前置代码仍不足以安全降级：须处理 browser 会话及 auditor 授权，再决定是否定向撤销003结构/账本。含密码/授权的回退需单独确认，不能以schema快照覆盖现状；本轮没有执行数据删除或降级。不要将快照导入正式运价库。

下一节点是 M2：用本套身份和权限接运营导入→销售领取/跟进→运营反馈及通知，实施前另报原因、提升和副作用。Navigator适配、正式邮箱/TLS/常驻备份和生产迁移仍分别后续批准。




