# Prospector Team Foundation Delivery

日期：2026-10-29

状态：团队创建、父子团队树、邀请、成员关系、加入/拒绝/撤回、超级管理员全局团队范围和工作台门禁已实现并通过隔离数据库验证。成员线索与跨成员邮件下钻不在本节点范围。

## 新增 HTTP 与 IPC 接口

所有接口统一返回 `{ ok, data?, error? }`。桌面 IPC 由 preload 白名单统一暴露，HTTP 与 IPC 使用同一中心契约。

| 功能 | HTTP | IPC | 请求 | 返回 | 权限 |
|---|---|---|---|---|---|
| 团队上下文 | `GET /api/crm/team-context` | `online:team-context` | 无 | `TeamContext` | 有效 CRM 账号 |
| 团队详情与下级 | `GET /api/crm/teams/:teamId` | `online:team-detail` | `teamId` | `TeamDetail {team,outgoingInvitations,children}` | 团队成员、负责人或管理角色 |
| 邀请候选 | `GET /api/crm/team-invite-candidates` | `online:team-candidates` | `TeamMemberCandidateQuery {search,limit,offset}` | `TeamMemberCandidatePage` | 未加入团队或团队负责人 |
| 创建团队 | `POST /api/crm/teams` | `online:team-create` | `TeamCreateInput {name,parentTeamId,inviteeUserIds,idempotencyKey}` | `TeamCreateReceipt {teamId,context}` | 未加入的 CRM 用户；下级团队仅超级管理员 |
| 邀请成员 | `POST /api/crm/teams/:teamId/invitations` | `online:team-invite` | `TeamInviteInput {userIds,idempotencyKey}` | `TeamContext` | 团队负责人或超级管理员 |
| 接受邀请 | `POST /api/crm/team-invitations/:id/accept` | `online:team-invitation-accept` | `TeamInvitationDecision` | `TeamContext` | 被邀请人 |
| 拒绝邀请 | `POST /api/crm/team-invitations/:id/decline` | `online:team-invitation-decline` | `TeamInvitationDecision` | `TeamContext` | 被邀请人 |
| 撤回邀请 | `POST /api/crm/team-invitations/:id/cancel` | `online:team-invitation-cancel` | `TeamInvitationDecision` | `TeamContext` | 团队负责人或超级管理员 |

`ONLINE_CHANNELS` 从 43 项增加到 51 项，未删除旧通道。

## 数据库

基础迁移：`051-team-foundation-public`。树形迁移：`052-team-tree-public`，checksum `a30fba6ef7c75933daf1a550341109e7f722cab6ba1e94f3936e031d9e07258f`。

| 表/字段 | 作用 | 关键约束 |
|---|---|---|
| `prospector.crm_teams` | 团队主表 | `parent_team_id` 自引用上级团队 |
| `prospector.crm_teams.parent_team_id` | 上下游团队关系 | 外键指向 `crm_teams.team_id`；无父级表示根团队 |
| `prospector.crm_team_members` | 成员关系 | 一个普通账号只能加入一个团队；超级管理员不写成员记录 |
| `prospector.crm_team_invitations` | 邀请及状态 | 同团队同账号只能一条 pending 邀请 |
| `prospector.crm_team_idempotency` | 创建/邀请幂等回执 | 同键异请求返回冲突 |

团队名称唯一范围从全库改为“同一父团队下唯一”：根团队之间不能重名，不同分支可以重名。新增 `idx_crm_teams_parent` 支持上下游查询，原有全局名称索引被 052 替换。

树形版本公司 bootstrap 的理论基线为 93 表、879 字段、949 约束、230 索引、34 条迁移和 2 个视图。三 schema 公司布局下团队表位于 `prospector`；本机兼容中心的运行 search path 当前为 `public`，因此本地实际表名仍是 `public.crm_*`。本节点以 `team-schema.ts` 的未限定表名和 search path 为运行真源，部署前需复核公司模板中的 schema 前缀。

## 权限规则

| 操作 | 规则 |
|---|---|
| 创建根团队 | 未加入团队的 CRM 用户创建后成为负责人 |
| 创建下级团队 | 仅超级管理员可选择任意现有团队作为父级 |
| 超级管理员范围 | `identityAdmin`/`admin` 自动获得全部团队树和详情可见范围，但不写入 `crm_team_members`，成员列表不显示超级管理员 |
| 查看团队树 | `operations`/`admin` 可查看全部节点；团队成员可查看自己的团队详情 |
| 邀请成员 | 团队负责人或超级管理员；只能邀请无团队、有效 CRM、未受限账号 |
| 工作台 | 只有存在真实团队成员关系时才渲染 |

## 创建流程闭环

- 团队树提供“新建根团队”；进入任意团队详情后提供“创建下级团队”。
- 创建页提供“取消”和“返回团队树”，保留既有所填字段直至用户主动离开。
- 创建成功返回 `teamId`，超级管理员回到团队树并选中新团队；普通用户进入自己的工作台/团队页。
- 团队详情提供“返回团队树”，团队成员可查看上级团队名称和直属下级团队。

## 验证

- 隔离 PostgreSQL 4 项：创建/幂等、邀请/接受、拒绝/撤回、父子树、超级管理员隐式可见、成员列表排除和管理员范围。
- 团队 HTTP 2 项、桌面 IPC 白名单 1 项、团队渲染/交互 7 项、团队权限映射 2 项通过。
- 本机 `55847` 已应用 052，ready 200，`parent_team_id` 与父团队索引存在；本地团队路由无凭证返回 403。

## 本机正式中心升级

旧本机中心仍使用 `identity.*`，当前代码使用 `public.identity_*`。通过 `scripts/upgrade-local-center-public.mjs --apply --confirm-upgrade` 在维护窗口完成迁移，备份位于 `C:\ProgramData\MiloginCenter\pre-public-team-upgrade.dump`。账号、权限、会话和 outbox 已迁移，30 个旧身份外键重指向公共身份表。

## 剩余边界

- 成员线索与跨成员邮件授权。
- 移除成员、退出团队、解散团队、负责人转让。
- 树节点拖拽改父级、跨树移动和循环检测编辑接口。
- 通知仍通过团队上下文轮询呈现。

## 管理员团队工作区（2026-10-29）

管理员团队展示层按 Worksy HR Dashboard 的信息组织方式拆为两个内部页签：

- “团队列表”保留原管理界面：左侧团队导航支持搜索和层级缩进，右侧显示组织概况、成员、直属下级和待接受邀请。
- “组织画布”独立占满内容区，用卡片和正交连接线展示上下游关系；支持任意位置拖动、滚轮围绕指针缩放、按钮缩放、适配视图和展开/收起分支。
- “返回团队树”“新建根团队”“创建下级团队”继续沿用现有创建与详情接口，没有新增 HTTP、IPC、数据库表或前端依赖。
- 1040 宽度下列表页保留导航与概况双栏，画布页保持完整自由视口，避免主内容横向溢出。

验证补充：团队渲染与画布布局 10 项通过；隔离 Electron 管理员场景覆盖团队列表、搜索、详情、画布页签、折叠、滚轮缩放、自由拖动和 1440/1040 布局，页面无异常。截图位于 `docs/designs/prospector-team-operations-admin-1440.png`、`prospector-team-operations-admin-detail-1440.png`、`prospector-team-operations-admin-canvas-1440.png` 及对应 1040 版本。

## 组织画布虚拟根与成员下钻（2026-10-30）

- 画布顶部增加只由前端生成的“超级管理员”根节点，下方连接真实公司节点，再由公司连接运营组和直属销售团队。`YQN Admin` 等混合成员团队保持为真实公司下游团队，不作为超级管理员端点。
- 超级管理员节点不会写入 `crm_org_units` 或 `crm_org_assignments`。现有接口不能返回全部超级管理员名单，因此节点只展示当前已登录且具备超管身份的用户，不推测其他账号。
- 每张真实团队卡片明确显示“群主”、成员数、下级团队数和待接受邀请。点击卡片后根据 `online:team-detail` 展开成员；再次点击成员后打开现有 `online:team-monitoring-member` 监控详情。
- 成员详情沿用既有监控能力，展示联系人、已回复、待办、关注项、触达/回复比例、最近活动、近期动作、关注项和结构化邮件摘要；点击邮件继续读取 `online:team-monitoring-mail`。
- 未新增接口、数据库表、迁移或依赖。截图新增 `prospector-team-operations-admin-canvas-expanded-1440.png` 和 `prospector-team-operations-admin-member-1440.png`。
