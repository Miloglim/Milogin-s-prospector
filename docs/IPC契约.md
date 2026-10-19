# IPC 契约

## 2026-10-16 联系人离线命令（0.49）

复用online:contact-update、online:contact-followup及原POST /api/crm/contacts/:id/update、/followups；不增加IPC或HTTP。主进程先持久化命令，再调用原HTTP；返回ok可表示本地已保存，必须用CenterContactDetail.localSync区分中心确认。localSync={pending:number,state:'pending'|'conflict'|'failed',message?:string}仅客户端派生，不能作为服务端权限或版本事实。无localSync表示当前返回为中心确认视图。

复用online:sync-status、online:sync-now、online:sync-resolve，合并旧整客户队列与联系人命令统计；联系人id以contact-command:前缀分流。CrmSyncIssue新增可选contact比较内容（引用、名称、action、fields、note、centralFields），失权时不展示内容。未知pending只原请求重放，禁止保留中心当作撤销；显式conflict可核对后以新键/最新版本重试整组，use-central只移除可安全处理的本地意图，不回滚已保存的中心事实。

## 2026-10-16 联系人协作共享（0.46.0-alpha.1）

新增5个ONLINE_CHANNELS：online:contact-shares（ContactShareQuery→ContactSharePage）、online:contact-share-create（ContactShareCreate→ContactShare）、online:contact-share-decide（ContactShareDecision+action→ContactShare）、online:contact-share-update（ContactShareUpdate→ContactShare）、online:contact-share-members（无业务体→ContactShareMember[]）。统一Result；action只作桌面路由选择，不混入中心严格业务体。

中心GET/POST /api/crm/contact-shares、GET /api/crm/contact-shares/members、POST /api/crm/contact-shares/:shareId/{accept,reject,revoke,update}，共7个HTTP方法/路由组合。类型/常量唯一来源server/core/contact-sharing.ts，经shared重导出、统一preload与transport，未复制详情/字段修改/发信/同步接口。

CenterContact/Detail新增服务端派生permissions与isShared；canEdit只为旧组件兼容，实际逐字段、canFollowup/canChangeStage/canSendMail/canShare分别校验。旧普通字段stage/status写入拒绝，触达/关系阶段走既有followup，邮件结果走既有邮件事实接口；收件箱移除旧CONTACT_UPDATE.status写路。详细输入、表列与限制见[共享交付](contact-sharing-delivery-20261016.md)。

## 2026-10-16 原客户生命周期（0.45.0-alpha.1）

新增 5 个 ONLINE_CHANNELS 常量和对应主进程处理器，preload 白名单与 contract 自动同源；无旧通道增义或删除。公司编辑继续复用原 company-update。

| 通道 | 输入 | data |
|---|---|---|
| online:contact-delete | ContactDelete：contacts[{contactId,customerId,expectedVersion}]，idempotencyKey | ContactDeleteReceipt：deleted[{contactId,customerId,contactVersion}] |
| online:company-list | CompanyQuery：search/scope/limit/offset | CompanyPage：items/total |
| online:company-detail | companyId/scope | CompanyDetail：company/授权 contacts |
| online:company-create | CompanyCreate：name/domain?/idempotencyKey | CompanyDetail |
| online:company-delete | CompanyDelete：companyId/expectedRevision/idempotencyKey | {companyId} |

类型定义唯一来源 server/core/crm-lifecycle.ts，经 shared/online-crm.ts 重导出。统一 Result；联系人最多200条原子删除，服务端复核版本/归属/权限/待接受请求，已分配普通用户不可删。公司只删无任何联系人/客户的空公司，版本为不透明原始PG时间戳。离线拒写；未知结果保持原幂等键重试，切换账号不应用旧结果。删除回执同步失效当前账号投影、详情和邮件匹配；保留历史及阻塞待传事件，不回退旧 SQLite。

详见 [交付与边界](crm-lifecycle-delivery-20261016.md)。

## 2026-10-15 AI联系人复用原契约（0.41.0-alpha.1）

ONLINE仍43项，无新/删IPC或HTTP路由。AI search_contacts读取同账号镜像，update_contact/record_followup调用既有online adapter确认写；不向旧SQLite传中心数字ID。CenterContactUpdate.fields新增preferences?:string[]，最多10个非空唯一项，每项<=200字符，经原contact-update通道/POST update写现有extra.preferences，保留其余extra；拒绝任意extra对象。跟进不再用stage覆盖tags，关系阶段来自活动时间线。尚未适配AI导入/删除/草稿/入队/建任务/旧提醒明确UNAVAILABLE，原发送中心保留。冻结请求仅运行期，见agent-contact-review-20261015.md。


## 2026-10-15 详情/确认写端口统一（0.38.0-alpha.1）

ONLINE仍43项，无新增/删除IPC、HTTP路由或第二套查询协议。

| 原通道 | 共享输入/输出 | 当前正式主进程执行链 |
|---|---|---|
| online:contact-list | CenterContactQuery → Result<CenterContactPage> | 原transport/service → adapter.contacts → ContactLocalReadService → 完整授权mirror |
| online:contact-detail | CenterContactRef → Result<CenterContactDetail> | 原transport/service → adapter.contactDetail → ContactDetailReadService → mirror基础+已下载详情；在线按需requestLive GET原路由 |
| online:contact-update | CenterContactUpdate → Result<CenterContactDetail> | 原transport/service → adapter.contactUpdate → ContactWriteService → requestLive POST原/update → 校引用/版本/成员 → 本地确认快照 |
| online:contact-followup | CenterContactFollowup → Result<CenterContactDetail> | 原transport/service → adapter.contactFollowup → ContactWriteService → requestLive POST原/followups → 同一回执保存 |
| contacts:listForMatch | 原success/data及centerReference | 原transport → 当前账号同一mirror；有效离线授权可读，已观察拒绝不可回退旧contacts |

CenterContactDetail新增可选supplementAvailable:boolean：false只表示离线基础响应，company/history未下载；缺省是原中心完整响应。反馈复用原详情两处位置，外观保持。save回执若本地落盘失败返回DATABASE_ERROR、保留原幂等请求可重试；可能中心已提交，不能暗示中心必未写入。已知撤除成员不被迟到回执重新加回。

内部端口不是新IPC：ContactDetailReadPort / ContactWritePort / ContactMirrorStore.detail/saveDetail/forgetContact / ContactMailSyncPort.contains及invalidate。真实运行接线在contact-mail-runtime.adapter.ts；离线生命周期关闭同时拆除端口。独立旧port测试兼容fallback保留，正式adapter不会绕回路径JSON详情缓存。发送/Agent旧数字ID契约仍未接中心，不可复用中心整数ID。

## 2026-10-14 多账号记忆凭证

`online:logout` 输入增加可选 `OnlineLogout { switchAccount?: boolean }`，无参数仍撤销当前凭证；`switchAccount: true` 保留已记忆的系统加密凭证，清除自动恢复所用的选择并回到登录页。未勾选记忆时仍正常撤销。通道数不变，统一 Result 返回；renderer → service → adapter 同源传递。移除账号、失效和改密不适用此保留策略。

## 2026-10-14 联系人分配接受（0.35.0-alpha.1）

ONLINE_CHANNELS为唯一常量源；纯中心类型由shared重导出，main transport、契约清单和preload白名单同源。新增8、移除无调用的online:assign/online:claim，共43个ONLINE通道；统一Result，不引入第二套通知/登录协议。旧HTTP整客户assign/claim显式拒绝，不能绕过等待接受流程。

| IPC | 输入 | 中心路径与data |
|---|---|---|
| online:contact-detail | CenterContactRef：contactId/customerId | GET /api/crm/contacts/:id?customerId=；CenterContactDetail含完整联系人、同联系人活动、只读公司背调、能力与mailAvailable=false |
| online:contact-update | CenterContactUpdate：关联、expectedVersion、幂等键及字段 | POST /api/crm/contacts/:id/update；CenterContactDetail |
| online:contact-followup | CenterContactFollowup：关联、expectedVersion、幂等键、联系状态/阶段/活动 | POST /api/crm/contacts/:id/followups；CenterContactDetail |
| online:assignment-list | ContactAssignmentQuery：incoming/outgoing、status、分页/搜索、可选requestId | GET /api/crm/contact-assignments；ContactAssignmentPage |
| online:assignment-create | ContactAssignmentCreate：选中联系人关联/版本、targetUserId、notifyUserIds、幂等键 | POST /api/crm/contact-assignments；ContactAssignmentReceipt |
| online:assignment-accept | ContactAssignmentDecision：requestId、expectedVersion、幂等键 | POST /api/crm/contact-assignments/:id/accept；ContactAssignment |
| online:assignment-reject | 同上 | POST /api/crm/contact-assignments/:id/reject；ContactAssignment |
| online:assignment-cancel | 同上 | POST /api/crm/contact-assignments/:id/cancel；ContactAssignment |

联系人列表原online:contact-list增加scope、assignment、followupOnly、crmStage，授权在计数/分页前执行。发送stage不等于CRM relationshipStage；最后实际联系日期/备注由同联系人非商机真实联系活动派生。请求待接受仅返回摘要，不授予详情/开发权；通知requestId精确读取当前状态，定位模式要求空搜索与offset=0，不能因历史pending提示隐藏已接受请求。通知已读不改变请求。

中心写操作和正式导入需真实在线回执；联系人/请求写后失效当前账号缓存，权限拒绝清相应缓存，版本防止写后在途旧响应重新缓存。原客户级离线队列兼容保留，不把中心contactId交旧SQLite协议。API参数和类型细节以server/core/contact-assignments.ts及对应无IO service为准；验收范围见contact-assignment-delivery-20261014.md。

## 2026-10-14 中心完整联系人列表（0.34.0-alpha.2）

新增唯一通道ONLINE_CHANNELS.CONTACT_LIST=`online:contact-list`，输入CenterContactQuery，返回Result<CenterContactPage>，对应唯一GET `/api/crm/contacts`。src/shared/online-crm.ts导出常量/类型，main引用同一对象，transport单handler，preload自动白名单。原contacts:list、crm:listPipeline、online:list用途不变。

search默认空，limit默认50/上限100，offset默认0；可选发送stage、邮件status、精确tags、clientType、联系人country。额外/重复HTTP参数和非法分页拒绝，不接受客户端owner。输出完整联系人items及授权范围total，显式contactId/customerId/customerVersion，无旧本地id。权限、缓存及未切正式入口范围见[交付说明](center-contact-read-delivery-20261014.md)。

## 2026-10-13 账号预设与自动登录（0.33.0-alpha.1）

共享ONLINE_CHANNELS仍是唯一常量源，main/contract.ts直接引用，生产preload白名单与transport自动对应；三个新增通道各单一用途，统一Result，不新增HTTP认证端点。

| IPC | 输入 | data |
|---|---|---|
| online:account-list | 无 | LoginAccountQuery：accounts与selectedAccountId；仅邮箱、中心地址、账号标识、记住/自动选项与最近使用时间，禁止密码或Token |
| online:account-login | {accountId,autoLogin:boolean} | OnlineSessionSnapshot；main解密选定续期凭据，复用原refresh，签名离线授权仍按原期限验证 |
| online:account-remove | accountId:string | void；只移除本机预设，正在登录的该账号须先退出，不删除中心用户或SQLite业务资料 |

OnlineLogin新增可选autoLogin，与remember分离：自动登录必须remember=true；旧调用不传autoLogin仍兼容原“记住即自动恢复”。新页面明确传两个选项。普通启动只恢复所选账号且autoLogin=true；手动选择可使用记住但未开启自动登录的凭据。失效/撤销/改密只清所选凭据，不尝试其他账号；mustChangePassword仍停在改密页。STATUS不会偷偷登录未开启自动登录的其他预设。


## 2026-10-13 跟进看板入板条件与详情复刻（0.32.2-alpha.1）

上一轮将“未触达客户不能入板”误读为“普通用户不得使用看板”，该身份限制已全部撤回。crm:listPipeline恢复旧服务查询；原全局中心身份、账号目录隔离与权限边界保留，不新增管理角色检查。

在线列表继续使用online:list与GET /api/crm/leads，LeadQuery新增可选followupOnly:boolean，严格解析true/false，公共池不支持此筛选。中心count和page使用相同的已触达联系人EXISTS条件，在分页前排除未触达客户。LeadPreview只读派生hasContacted来自联系人crm_touch_status为contacted/replied，不新增持久化列，不用客户阶段冒充触达事实；公共池不返回该字段。已触达且客户阶段cold的客户只在看板归入reaching，不修改中心阶段。

离线查询用同一core触达口径与联系人缓存派生筛选，计数和分页在筛选后计算；联网同步仍走原投影/outbox协议。普通用户、管理员、超级管理员按既有可见范围使用看板；未触达客户在普通客户列表和详情保留，但行内入板快捷按钮禁用。无新增IPC、HTTP路径、表、角色字段或依赖。

## 2026-10-13 离线客户同步（0.32.0-alpha.1）

真源：src/shared/online-crm.ts 的 ONLINE_CHANNELS / CrmSyncStatus / CrmSyncResolve。返回均为中心 Result：{ok:true,data} / {ok:false,error:{code,message}}。

| 通道 | 输入 | 成功数据 |
|---|---|---|
| online:sync-status | 无 | connection、syncing、pending、failed、conflicts、lastSyncedAt、lastError、issues（本地/中心对比与导入回执） |
| online:sync-now | 无 | 同步后的 CrmSyncStatus；离线保留待同步队列 |
| online:sync-resolve | {id,action:'retry'\|'use-central'} | void；须联网，无正在同步的同账号任务；冲突重试显式基于核对后的中心版本 |

BOOTSTRAP/LIST/DETAIL 离线可读授权缓存；CREATE_CUSTOMER/UPDATE_CUSTOMER/FOLLOWUP/IMPORT 的成功表示本地事务已保存，中心完成情况读取 SYNC_STATUS，不能当作中心已提交。PREVIEW 离线也可本地解析文件。操作体类型保持既有中心契约；本地临时客户 ID 为 UUID、联系人 ID 为安全整数，上传依赖映射到中心 ID。

WORKBOOK_PREVIEW/WORKBOOK_IMPORT 为停用兼容通道，统一返回 UNAVAILABLE/请使用单表导入，不产生文件选择或写入。服务端历史工作簿路由未删除。

## 2026-10-12 B1分表导入（当前在线通道22个）

| 通道 | 输入 → 输出 | 消费链 |
|---|---|---|
| online:workbook-preview | 无参数 → Result<ImportPreview>；可选sheets含每表headers/rows/rowNumbers/error? | WorkbookImportPanel → IPC/service → 授权文件适配器 |
| online:workbook-import | WorkbookImportRequest {source,sourceDetail,kind:personal/operations,idempotencyKey,rows} → Result<WorkbookImportReceipt> | 面板 → IPC/service → POST /api/crm/workbook-imports → center service/PG |

唯一类型在server/core/customer-import.ts，经shared导出。原PREVIEW/IMPORT保持平面格式；未知响应原键重试，已知参数拒绝可修正。来源引用非授权ID；≤200行/1MiB。主档可选businessType/developmentRestriction/sourceCreatedAt；CustomerCreate/Update允许contacts=[]，无邮箱联系人email=''，中心存NULL并兼容字符串投影。基础ContactDraft邮箱仍必填。22个在线常量/处理器/preload白名单对等；无新配置键。见[交付](crm-business-fusion-b1-delivery-20261012.md)。

## 2026-10-11 R1全局身份补充（0.15.0-alpha.1，工作区未发布）

新增online:status、online:restore、online:password三个IPC，沿用online:login/logout与十个CRM通道。ONLINE_CHANNELS是唯一来源，IPC.ONLINE及preload共用，15个声明对应15个处理器，注册测试检查缺失/重复。login输入OnlineLogin新增remember?:boolean；status/restore输出OnlineSessionSnapshot（identity/remembered/baseUrl/localAvailable）；password仅接受currentPassword/newPassword，返回统一Result<void>。

桌面认证五个HTTP真源为server/core/desktop-session.ts：POST /api/auth/desktop/login、refresh、logout、password与GET /api/auth/desktop/me。login/refresh的token与refreshToken仅主进程持有，renderer仅见公开身份。旧/admin-api Cookie与/api/auth原接口仍有调用方，保留且不作为生产桌面第二登录入口。007绑定已有session_id以保证管理会话撤销与桌面续期一致。详情与限制见[R1交付](r1-global-identity-delivery.md)。

## 2026-10-10 强制改密HTTP补充（0.13.0-alpha.1，待发布）

无桌面IPC增删。server/core/admin.ts 新增 POST /admin-api/password，输入 currentPassword/newPassword，返回 { ok, data?, error? }。须同源browser Cookie、CSRF及当前密码；新密码至少12字符且不可复用当前密码。成功撤销全部会话并清Cookie，必须重新登录。identity DTO 增加 mustChangePassword；标记为true时只允许本人会话检查、退出及改密，其他管理/原API路径拒绝（PASSWORD_CHANGE_REQUIRED）。完整约束见 [管理工作台](management-platform.md)。

## 2026-10-10 管理HTTP补充（0.12.0-alpha.1，待发布）

本节点无桌面IPC通道增删。新增浏览器HTTP路由由 `server/core/admin.ts` 唯一定义，完整请求/权限/数据见 [管理工作台M1](management-platform.md#http-契约)。浏览器Cookie session与API Bearer session按client资源分别鉴权；管理返回 `{ ok, data?, error? }`，不混用桌面旧返回类型。

## 2026-10-10 收件箱深链兼容（待发布）

`inbox:list` 接受可选 `InboxListRequest = { includeId?: number }`（`shared/inbox.ts`）。旧调用不传参数时行为不变；指定正整数邮件 ID 时，如果目标超出常规分类列表上限，则额外返回该行并复用账号/联系人关联信息。不存在的 ID 不制造占位邮件，非法 ID 返回失败。通道及 `{ success, data?, error? }` 返回形态保持原契约。

## 全局搜索（0.9.0-alpha.1）

| 通道 | 参数 | 返回 | 约束 |
|---|---|---|---|
| `search:global` | `{ query: string, limit?: number }` | `Result<GlobalSearchData>` | 只读；query 最多 200 字；limit 为每组上限，默认 20，范围 1–50。按 email/note/contact 分组，结果含 kind/sourceId/contactId/title/snippet；达到上限时 truncated=true。 |

摘要中的 U+0001/U+0002 标记匹配词的起止，renderer 用安全的 React `<mark>` 展示，不执行 HTML。英文使用字面词前缀匹配（多个词 AND），中文使用 LIKE，`%`/`_` 作为字面字符转义。未缓存正文只能检索预览；结果链接跳至 `#/inbox?detail=id` 或已有客户详情深链。

`crm:listPipeline` / `crm:getDetail` 的联系人对象新增 `overdueDays/warnDays`，返回格式与原数组/详情结构兼容；`system:updateConfig` 增加 CRM 阈值校验与嵌套合并，不新增设置通道。

## 模型服务商档案

`ai:profileUpsert` 的档案参数增加可选 `wireApi: "chat_completions" | "responses"`；省略时新档案默认 Chat Completions，编辑旧档案保持原类型。`ai:endpointStatus` 的 `profiles` 和 `endpoint` 返回生效类型。`ai:profileTest` 按档案类型走对应 API，并继续返回 `{ success, data?: { ok, latencyMs, model, preview?, kind?, error? }, error? }`，不会返回密钥。通道名称不变。

## 发送中断批次

| 通道 | 参数 | 返回 | 约束 |
|---|---|---|---|
| `send:getInterruptedBatch` | 无 | `{ success, data: InterruptedBatchStatus \| null }` | 只读；返回原批次标识、开始时间、可恢复组数和收件人数。 |
| `send:resumeInterruptedBatch` | 无 | `{ success, data?, error? }` | 只恢复本机保存的中断批次。渲染端不能传入批次 ID，成功后清除中断标记。 |

`send:resumeQueue` 保持原有“恢复全部待发队列”的人工操作语义，不用于启动后中断恢复。

## Navigator 授权 IPC（2026-10-10）

- rates:navigatorStatus / rates:navigatorLogin 返回 `{ok,data?:{authenticated,user?,baseUrl},error?}`；login 等待系统浏览器授权完成、拒绝或超时。
- rates:navigatorLogout 返回 `{ok,error?}`；即使远端撤销失败，本机凭据与在途授权已清除。
- rates:image 接收图片 basename，返回 `{ok,data?:dataURI,error?,code?}`，禁止路径与令牌传入渲染端。
- navigator:identityChanged 事件仅携带 `{epoch}`，用于清除报价缓存、草稿和会话现场，绝不携带凭据。
- rates:list 保留 `{success,data?:QuoteDto[],error?}` 旧渲染契约，实现改为当前授权用户的实时 API 查询；不读取旧镜像。rates:sync 为退役失败通道。rates:status 与 navigatorStatus 同为授权状态 `{ok,data?:NavigatorStatus,error?}`，不再返回镜像数量；旧外部调用方需升级。
# Navigator 匹配候选补充（2026-10-10）

`rates:options` 无参数，返回 `NavigatorResult<NavigatorOptions>`；data 仅含 Navigator `ports / portGroups / carriers / routes` 的规范候选，通过只读设备授权获取。身份变化清除候选缓存。桌面 `rates:list` 的 `match: "web"` 配合 `pol/pod` 逗号多值、`carrier/route/ctype` 精确筛选，查询路径与网页共用；未设置该模式的 AI 请求保留关键词规则。

## M2在线协作（0.14.0-alpha.1，2026-10-11）

IPC.ONLINE引用src/shared/online-crm.ts的ONLINE_CHANNELS，避免重复字符串。全部返回Result；主进程发中心HTTP，renderer不获得令牌；在线失败无SQLite回退。

| 通道 | 输入 → 输出 |
|---|---|
| online:login | OnlineLogin → Identity |
| online:logout | 无 → 退出结果 |
| online:bootstrap | 无 → LeadBootstrap |
| online:preview | 无，系统选择CSV/XLSX → ImportPreview |
| online:import | ImportRequest → ImportReceipt |
| online:publish | batchId, PublishRequest → PublishReceipt |
| online:list | LeadQuery → LeadPage |
| online:detail | customerId → LeadDetail |
| online:claim | LeadCommand → LeadDetail |
| online:followup | FollowupRequest → LeadDetail |
| online:feed | 无，adapter维护本会话游标 → OnlineFeed |
| online:read | notificationId → 已读结果 |

具体HTTP、授权、幂等、消息与回退见[M2交付](m2-lead-collaboration.md)，冻结的公开类型以server/core和shared导出为准。

## 2026-10-12 自助注册增量

新增online:register，输入OnlineRegistration {email,password}，输出统一Result<RegisteredAccount>（仅email）。链路为POST /api/auth/desktop/register；拒绝角色、identityAdmin或范围参数，成功不签发令牌，回现有登录链路。

在线常量/处理器/白名单16个，桌面认证路由6个；15/5为R1历史交付。注册只写中心，不写SQLite、不新增身份缓存。地址不在登录页展示，沿用全局配置；部署时统一切换中心地址。

## 2026-10-12 R2 客户中心访问层

新增 online:customer-create（CustomerCreate → LeadDetail）和 online:customer-update（CustomerUpdate → LeadDetail），对应 POST /api/crm/leads 与 POST /api/crm/leads/:customerId/update。18 个 ONLINE 常量、处理器与 preload 白名单一一对应。新建不接收归属／角色字段；更新必须带原联系人 ID、expectedVersion 和 idempotencyKey，不移除已有联系人、不修改来源归属。

客户页列表、详情、预览、导入、跟进复用原通道，无页面私有会话、直连 PG 或本地失败回退。LeadQuery.view 增加 personal／assigned／all，operations 收紧到本人运营来源。ImportRequest.kind=personal 创建本人自有客户；operations 仍为本人运营来源草稿。LeadDetail.canEdit／canFollowup 为当前授权派生值，不存第二份权限状态。

新通道使用统一 Result。旧 CONTACTS／COMPANIES／CRM 数字 ID 通道仍供未迁移模块和隔离开发夹具使用，正常桌面受本地资料守卫拒绝；未把 UUID 强塞旧类型。邮箱／AI／发送尚未中心迁移，不能因此解锁旧匿名库。详见 [R2交付](r2-center-customers-delivery.md)。

## 2026-10-12 设置恢复通道边界

本次没有增删IPC/API。正常身份绑定隔离资料目录后复用原system/accounts/ai等个人通道；这些通道不成为中心客户写入口，中心失败不回写本地CRM。个人服务就绪前不挂载设置页，防止拒绝结果进入配置缓存；注销/撤权后主进程guard立即拒绝，随后个人任务进程退出。账号资料读取全局中心身份，未新增独立账号资料真源。

## 2026-10-12 R3 定向分配与全局消息

| 通道 | 输入 → 输出 |
|---|---|
| online:members | MemberQuery {search,limit,offset} → MemberPage {items:[{userId,displayName,assignable}],total} |
| online:assign | AssignRequest {customerId,expectedVersion,idempotencyKey,salesUserId,notifyUserIds} → LeadDetail |
| online:feed | 可选 OnlineFeedRequest {reset?:boolean} → OnlineFeed；不传仍增量补收 |

HTTP为GET /api/crm/members和POST /api/crm/leads/:id/assign。20个在线常量/处理器/preload白名单一一对应。Notification新增crm.lead.assigned和派生canOpen；无详情权限通知空customerId/0版本且不能打开客户。LeadDetail.canAssign仅查询派生。通知不授予客户权限。契约及回退见[R3交付](r3-assignment-delivery.md)。

## CRM界面契约扩展（2026-10-12）

未新增通道（在线总数20）。online:list沿用LeadQuery，增加可选assignment=unassigned/assigned、stage=现有CrmStage/cold；bridge编码至原GET /api/crm/leads，公共池拒绝stage。count/list相同中心授权谓词，非前端当前页筛选。LeadPreview可选ownerName/recentActivityAt、LeadActivity可选actorName；recentActivityAt为ISO字符串。online:feed沿用游标/读状态，Notification可选summary={companyName,actorName?,note?}，受当前canReadLead控制，notify-only不提供。不独立复制shared类型，不新增详情批量或另一消息端点。见[交付](crm-experience-delivery-20261012.md)。

## 2026-10-12 导入预览与修正

online:preview的ImportPreview增加可选rowNumbers:number[]（表格原始行号，含表头，从1开始），缺省兼容旧预览。online:import仍是原ImportRequest/ImportReceipt：可选映射不发空值，修正仅单行、新键、未知响应原命令重试；rawRow.original/corrected/repairOf是非权限来源说明。没有新增IPC/API通道，20个在线处理器/白名单对等；行错误仍用invalid回执，不返回另一账号详情。

## 2026-10-12 离线本地授权

ONLINE仍22个常量/处理器/preload白名单，无新通道或HTTP路由。OnlineSessionSnapshot新增可选connection='online'|'offline'及offlineExpiresAt；STATUS/RESTORE在可验证本地授权下返回ok:true的公开身份投影，localAvailable仍由隔离本地初始化及现场权限派生。登录/续期响应新增可选offlineAccess={payload,signature,publicKey}，仅主进程消费，不进入renderer、不接受为API bearer。

中心UNAVAILABLE/DATABASE_ERROR/TIMEOUT不视为账号撤权；明确UNAUTHORIZED仍清理身份。离线在线CRM请求返回原Result的UNAVAILABLE，未记住/缺签名/过期不离线恢复。本地旧通道沿用success返回契约，具体允许项由offline-local-policy.ts白名单决定，未知通道默认拒绝；无平行身份、CRM、消息或离线写队列。见[交付](offline-local-access-20261012.md)。

## 2026-10-12 B2 原跟进契约扩展

在线通道仍22个，无新增/删除。`online:followup` → `POST /api/crm/leads/:id/followups` 沿用统一 Result；FollowupRequest 由中心 core 直接重导出。新可选 method/occurredAt/contactId/contactStatus；stage 支持 cold。旧调用省略 method 默认 other、省略时间用中心当前时间、省略阶段保持不变。note 类型不允许修改触达；联系人归属由中心验证。LeadDetail 增加 stageNeedsReview、联系人 touchStatus、活动方式/发生及录入时间/联系人等可选投影。旧 createdAt 保留。

授权检查先于同键缓存；版本、活动、指定触达、公司阶段、幂等结果与 outbox 同事务。中心故障不回写 SQLite。新写路不调用基础服务的旧 changeStage/addFollowup；后者仅内部测试/兼容端口，当前 HTTP 未暴露。字段扩展不建立第二套中心接口。详情、列表及通知读同一主档/活动记录。


## 2026-10-13 原有导入组件接入中心（0.29.0-alpha.1，未发布）

客户默认导入复用ImportDrawer，上传/拖拽/粘贴/自动映射/预览/确认沿用原组件；来源、来源说明与导入去向不再手填。管理员身份导入管理员线索，用户导入自有线索，复用中心IMPORT鉴权和幂等提交，不调用contacts:import本地写入。多表工作簿保持次级入口并自动提供来源；未删除旧本地联系人导入入口。缺少来源客户编号时以联系人邮箱作为去重键，不推测公司名称。

同一online:preview通道增加可选ImportFileContent(type,data)内容输入；无参数保留文件选择行为，仍只解析不写库，复用既有parseImportTable。无新增IPC/API/依赖/数据库迁移。账号变更后忽略旧响应，断线重试保留中心批次幂等键。原组件通过可选port注入中心适配，旧使用者行为保持。

21项单元、13项客户渲染回归及1项完整粘贴到中心提交测试通过，桌面类型/构建/193文件架构检查通过。后续隐藏Electron真实IPC/preload/renderer + HTTP/PG隔离回滚验收覆盖粘贴、丢响应重试、UTF16/GB18030/XLSX、部分失败和管理员导入身份7项，页面错误0；未写入真实业务Excel。旧渲染测试中依赖手填来源/公开池入口的3项已重新对齐。checkpoint D:/Agent Basement/checkpoints/prospector-original-import-20261013。

## 2026-10-13 B3 跟进任务与到期提醒（0.30.0-alpha.1，工作区未发布）

新增四个在线 IPC，并与中心 HTTP 保持同一类型契约：

| 通道 | 输入 → 输出 | 中心路由 |
|---|---|---|
| online:task-list | TaskQuery → TaskPage | GET /api/crm/tasks |
| online:task-create | TaskCreate → FollowupTask | POST /api/crm/tasks |
| online:task-reschedule | TaskReschedule → FollowupTask | POST /api/crm/tasks/:taskId/reschedule |
| online:task-complete | TaskComplete → FollowupTask | POST /api/crm/tasks/:taskId/complete |

在线通道由22增至26，contract → transport → preload → adapter → HTTP逐层复用同一常量和 Result。任务写入以任务版本、客户版本和幂等键保护；管理员可查看其范围内任务，负责人可完成/延期；任务到期由中心受限批次扫描写入持久 outbox，通知按当前负责人、任务版本、状态和能力再次校验，完成/延期/转交后的旧提醒不再展示。

客户详情的“下一步”支持创建、完成反馈、延期和分页；消息点击会定位到客户详情中的具体任务。原有 ImportDrawer 仍是默认客户导入入口，部分批次失败保留原请求并要求同一文件/映射重试。

每个新增任务表与到期回执表使用017-followup-tasks迁移；无SQLite CRM写回、无自动外发邮件、无新增依赖。验证见 `docs/b3-followup-task-plan-20261013.md` 及 checkpoint `D:/Agent Basement/checkpoints/prospector-b3-backend-20261013`。

## 2026-10-13 B4 商机（0.31.0-alpha.1，工作区未发布）

新增online:opportunity-list/create/detail/stage四通道（共30），声明来自src/shared/online-crm.ts，主进程统一注册、preload动态白名单；均返回Result。列表输入customerId/limit/offset；创建OpportunityCreate带客户版本和幂等键；详情只收opportunityId；阶段OpportunityUpdateStage带商机版本与幂等键。POST阶段路径与body ID一致，金额字符串与币种成对。FollowupRequest/TaskCreate可选opportunityId，必须同客户。消息复用原feed/read，新增created/stage_changed事件及可选opportunityId精准定位，不建第二个通知接口。详见b4-opportunity-delivery-20261013.md。

## 2026-10-14 邮件中心事实接线（0.36.0-alpha.1）

无新增IPC，ONLINE仍43条。contacts:listForMatch沿原success/data返回，但已配置中心时仅返回当前账号结构化授权镜像，附加centerReference{contactId,customerId}/contactVersion；无身份失败不回退旧contacts，有效离线授权允许读取。原contact-detail返回mailAvailable=true、mailEvents、mailEventLimit=200；新增HTTP POST /api/crm/contact-mail-events用纯共享ContactMailEventInput→ContactMailEventReceipt，主进程自动调度、真实回执确认。原联系人数字ID协议仍只处理旧本地历史，不接受中心数字ID混用。状态/阶段沿既有online:contact-followup或contact-update单命令，通知沿原outbox/feed，不设第二入口。详见docs/mail-dataflow-delivery-20261014.md。
## 2026-10-15 联系人列表读取源统一

online:contact-list继续CenterContactQuery→Result<CenterContactPage>，43项ONLINE IPC与preload白名单不变；不新增联系人本地/中心两套查询通道。生产主进程读同账号完整crm_contact_mirror，按原筛选/排序/分页及total返回，首次缺完整快照时经原/api/crm/contacts全量刷新。CenterContact只增加可选assignmentStatus(pending/accepted/null)保存真实分配请求状态；不修改ID类型、写接口或详情接口。新筛选离线读取不依赖此前访问过的JSON页。contacts:listForMatch按同权限指纹投影匹配，已检测权限变化/拒绝时不回退旧contacts。CONTACT_DETAIL暂未切换，本节点不宣称所有读写统一。

## 2026-10-15 N4 发送接口增量（0.39.0-alpha.1）

沿用原SEND通道与白名单，无新增/删减IPC或HTTP，ONLINE仍43项。原send:start/dynamic/preview可选centerContactRefs:CenterContactRef[]；send:test可选centerReference；send:campaignPreview保留number[]旧入参，另支持{contactIds,centerContactRefs?}；campaignCreate/updateDraft复用CreateCampaignInput增加可选centerContactRefs。显式中心引用失败必须拒绝，不解释为旧本地contactIds。原SendItem.recipients可选centerReference，centerScope为中心URL+userId；队列持久化到原recipients/contact_vars JSON。

原send:getPickerStats/history接口合并同账号中心回执展示；已有旧本地调用只兼容未迁移历史/工具，不能声明全功能中心化。SMTP返回accepted/rejected，中心回执只包含实际接受者，结果未知不自动重发。内部center-send Result沿旧success/data边界，中心HTTP保持ok/data/error，禁止新增平行裸返回接口。

HTTP复用POST /api/crm/contact-mail-events：ContactMailEventInput新增可选advanceSendStage:boolean，仅sent/outbound允许。false省略；该标记不改变首次邮件事实摘要digest，021标记保证事务内只推进一次。原GET contact detail发前校权；原outbox/feed提供管理侧互动变化，不增加第二套通知。

内部acknowledgeEvent可携带实际已POST payload做条件ack，防止迟到旧确认消耗尚未上传的新确认事实。原Campaign stoploss使用明确contact/customer/scope，旧本地回调不能停止同号中心任务。详细调用与结构见center-send-delivery-20261015.md。

## 2026-10-15 联系人列表字段统一（0.40.0-alpha.1）

不新增IPC或HTTP路由，`online:contact-list`仍为唯一联系人列表通道，返回格式仍为`Result<CenterContactPage>`。`CenterContactQuery`增加可选`touchStatus`与`language`；既有`crmStage`明确表示客户关系阶段，`stage`仍表示发送阶段，`status`保留邮件/兼容状态，`tags`只表示真实标签。HTTP、主进程本地镜像查询和renderer数据端口使用同一查询对象。

旧联系人表仅保留显示组件，中心适配不再把`relationshipStage`写入`tags`。列表显示分别读取`touchStatus`、`relationshipStage`、`stage`和`tags`，语言筛选使用`language`而非`country`。中心ID仍通过`contactId + customerId`定位，不进入旧SQLite数字ID写接口。
# AI 中心发送接入（2026-10-15，0.42）

- 不增加 IPC/HTTP 通道。`generate_draft`、`send_queue_add`、`campaign_create` 工具入参保留；数字联系人编号只在当前授权中心快照中解析，向发送中心显式传 `{contactId, customerId}` 引用。
- 草稿与动作绑定账号/权限快照；切换、撤权或邮箱变化后不能继续执行旧收件人动作。回复按当前中心邮箱精确匹配，不使用旧 SQLite matchedContactId。
- 入队复用原发送中心且 `autoStart=false`；批量任务确认后先创建草稿 `startNow=false`，由发送中心启动。工具成功不代表真实外发。
- 同进程同会话、同账号、同联系人引用及内容的重复入队/建任务复用回执；不承诺跨重启去重。重启动作卡失效。明确失败允许修复后重试；抛异常产生的未知结果保留本次回执，避免自动重放。

## 2026-10-15 公司资料中心保存

| IPC | 输入 | 返回 | 用途 |
|---|---|---|---|
| `online:company-update` | `CenterCompanyUpdate`：contactId/customerId、expectedRevision、idempotencyKey、fields | `Result<CenterContactDetail>` | 复用授权联系人定位共享公司；只写允许的公司字段，禁止按旧SQLite公司编号写入 |

常量由`ONLINE_CHANNELS.COMPANY_UPDATE`定义，preload沿用统一白名单。HTTP映射为`POST /api/crm/contacts/:contactId/company`。公司版本独立于联系人版本；详情返回company.revision/canEdit及真实country/industry/size。背调生成报告与中心保存分开，AI不可直接写旧本地公司资料。未增加其他IPC，联系人新增/导出/阶段修改复用现有通道。
# 变更记录

- 2026-10-16（0.47）：原 `inbox:classify` 参数和返回不变，手动分类成功表示本账号修改已持久保存，不等于中心已确认。`POST /api/crm/contact-mail-events` 原入参加可选 `correction:{previousEventKey:string|null,classification:'other'|'replied'|'autoreply'|'bounced'}`，返回事件可选 `correctionRevision:number`；仅入站，禁止 `advanceSendStage`。同键同载荷幂等、前驱不符返回CONFLICT。普通事实摘要兼容不变。详情 `LeadActivity` 可选 `mailEventId` / `mailSuperseded` 标识邮件关联及历史失效贡献，保留活动；无新增通道或路由。详见mail-classification-correction-delivery-20261016.md。

- 2026-10-16：新增 `app:restartRequest` 事件与 `system:restartConfirm` 返回通道。托盘重启由渲染层统一展示确认窗，主进程仍负责等待、超时取消和实际重启。


## 2026-10-16 已发回执授权与补传（0.48）

无新IPC，原发送入口和客户端统一返回不变。新增内部HTTP两条：POST /api/crm/send-authorizations（SendAuthorizationInput→SendAuthorization[]），POST /api/crm/send-acceptances（SendAcceptanceInput→SendAcceptanceReceipt）。常量/类型唯一来源server/core/send-acceptance.ts，服务/路由/桌面同源。

授权输入绑定原发送编号、发件邮箱、主题及全组联系人和CC；必须实时有权发送且授权持久写入后才SMTP。接受输入为authorizationId、真实SMTP event、可选observedEvent（仅验证此前IMAP原事实）。输出只含eventId/duplicate/archivedAfterRevocation，不含contact；联系人重读当前授权列表。事前授权不开放通用联系人读写或撤权后新发送。

仅本地QueuedContactMailEvent新增sendAuthorizationId和可选smtpAcceptance；上传适配器拆为专用接受请求，不将本地字段发给原contact-mail-events。原普通POST仍按当前权限鉴权。复用原会话、事务、邮件事件及outbox；无第二份联系人或重复IPC。完整时间/幂等/已撤权语义与数据库字段见late-send-receipt-delivery-20261016.md。

## 2026-10-19 导入字段增补（0.53.0-alpha.1）

原 `ONLINE_CHANNELS.IMPORT` / `POST /api/crm/imports` 保留，ImportRequest 可选 `companyMatching:boolean`，ImportRow 增加 `customerType/businessType/website/whatsapp/sourceLevel1/sourceLevel2`。正式抽屉自动生成 customerKey，按公司名核对授权范围内公司；邮箱可为空但需姓名或电话/WhatsApp。分类输入仅代理/直客，公司分类推导联系人原agent/direct；一二级来源为联系人字段，source/sourceDetail仍为批次追溯。CenterCompanyUpdate允许customerType（代理/直客/null），联系人修改不允许改公司分类/国家；详情/列表带whatsapp和sourceLevel1/sourceLevel2。原返回结构与重试键不变。完整匹配词典见 `lead-import-fields-20261019.md`。无新增通道。

### 2026-10-19 联系人显示与新增字段补齐

原CONTACT_LIST/CONTACT_DETAIL的CenterContact增加可选businessType/website，只读派生companies.industry/domain；字段存储与权限不变。原新增表单通过IMPORT发送companyMatching=true、自动公司键及同一导入词典字段，客户类型使用customerType（代理/直客），不再写联系人clientType。CSV使用中文分类并分列一二级来源与批次来源。无新增IPC/HTTP路径。
