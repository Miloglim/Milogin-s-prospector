# 中心校验与回归修复交付（2026-10-15）

工作区版本：0.42.1-alpha.1，未提交、推送或发布。用户已批准继续修复上轮核查问题；原客户、登录、收件箱布局保持。本轮不推进后续AI提醒或持续Worker。

## 实现与原因

| 位置 | 修改 | 作用与影响 |
|---|---|---|
| server/core/auth.ts | 纯函数 isAccountEmail / isNewAccountPassword | 新账号邮箱统一为未加引号的ASCII邮箱，允许地址必要符号及加号别名，拒绝中文、空白、连续点及非法域名；新密码6至256位，只允许英文字母和数字。 |
| server/services/desktop-session.ts | 注册、桌面改密复用校验 | 非法输入先拒绝，再计算摘要/写库；登录继续沿用原校验和密码验证，历史密码不被新建规则锁住。 |
| server/services/admin.ts、password-change.ts | 管理创建/激活消费/改密复用相同规则 | 创建默认身份和初始密码、强制改密、安全版本与会话撤销机制保持。 |
| server/adapters/postgres/admin-repository.ts | 修复旧激活链接补发 | 仅允许未激活、无密码凭据、未删除身份补发。复用原账号，旧挑战失效；正常、停用但有密码、已删除账号不能通过激活链路重设密码。 |
| tests/integration | 对齐当前联系人级分配 | 发请求→用户接受→只获得选中联系人；详情/跟进改用联系人接口。保留权限、重复提交、并发、版本冲突、事务失败回滚及同公司其他联系人隔离。 |
| server/transport/http.ts | 超限请求仅丢弃数据，读完后返回413 | 修复上传尚未结束就关闭响应引起的偶发ECONNRESET；不保存超额数据、不进入JSON解析或业务写入，沿用现有请求超时。代价是超限请求可能在超时范围内继续占用连接/带宽。 |
| scripts/center-tests.mjs | 独立源码副本与临时PG集群 | 自动选空闲端口、迁移、生成合成账号、串行执行、核实停止后回收临时库和账号，不连接当前中心数据库。失败同样清理；不能确认停止时保留目录并报错。 |
| scripts/online-server.mjs、crm-postgres.mjs | 测试入口委托独立运行器 | `npm run crm:online:test`覆盖当前中心条件测试，`npm run crm:pg:test`只执行PG基础测试，也使用临时实例。 |

旧整客户直接assign/claim仍保持明确拒绝，不为通过测试恢复第二条分配写路。旧激活挑战是保留兼容接口，当前创建用户页面不依赖它。

## 回归测试纠偏

- 密码随机样本由base64url改为hex；Token仍使用原base64url，不改变会话契约。
- 撤销会话按Token摘要精确查session_id，不依赖会话列表第一条。
- 修改联系人后读取当前contactVersion再提交，避免测试凭空使用旧版本。
- 导入语义异常使用未分配的独立数据；已分配联系人限制另行检查，不将权限冲突误当导入歧义。
- 商机通知测试在外层回滚事务隔离无关管理员，仍要求每个授权接收人收到两事件、无关用户不收到。
- 通知摘要检查当前公司/姓名与当前访问权限；完整跟进正文在授权联系人时间线核对，不要求通知消息复制全文。
- 管理中心Navigator占位文案断言对齐当前源码“中心授权已接入，运价库登录未切换”，不修改产品界面。

## 验证与证据

新增账号校验单元测试先复现9失败/5通过，再修复；日志`.work/center-regression-fix-red.log`。最终复跑还捕获lead-http超限请求偶发ECONNRESET：新增声明长度/分块两种真实HTTP回归先2失败，再修复为2通过；`.work/center-regression-http-red.log`保留失败证据，未通过吞错、重试或放宽413断言掩盖。

- 中心隔离运行器（`crm:online:test`复用入口）最终34文件、195项全部通过，包含真实HTTP/PG注册、会话、改密、分配、导入、跟进、邮件、任务、商机与管理权限回归。
- `npm run crm:online:test`此前已实际执行并通过33文件192项；最终新增HTTP专项后通过同一运行器复跑至上述195项，日志`.work/center-regression-fix-pg-final.log`。
- 最终中心全套`.work/center-regression-fix-pg-report.json`及PG入口`.work/center-tests/report.json`：isolated/started/stopped/removed均true，exitCode=0；一次性账号、凭据文件与临时数据库已回收。
- 普通全量串行回归：最终160文件、1381项通过，163项有条件跳过；日志`.work/center-regression-fix-full-final.log`。PG条件测试另由独立运行器开启，跨项目/真实模型等未满足条件的测试不冒充已验证。
- `npm run crm:pg:test`额外实际运行10项通过，清理结果同样为stopped/removed=true。
- `npm run typecheck`、`crm:pg:build`、`crm:admin:build`、`build`通过；架构检查扫描223份桌面源码0例外，检查器5项通过。这不是全仓lint或安全认证。
- 当前55844中心已受控重载，live/ready均200；5种非法注册实际均400 INVALID_INPUT，2MiB超限请求返回413；匹配账号新增0，专项请求前后账号数相同。证据`.work/center-regression-fix-live-after.json`。

整个工作区在本轮还有Navigator接口变动，已保留；checkpoint前后auth API_ROUTES新增navigatorAccess属于该同期变更，原路由均保留。本修复节点未增加IPC/HTTP入口或数据库字段，SQL迁移快照无差异。不能把整个工作区差异全部归入本节点，也不声称全工作区公共契约未变化。

当前中心库在较早快照与最终检查之间账号73→77、会话170→179、事件150→154，联系人1072、客户147不变；该区间包含其他当前活动，未确认全部写入来源，因此不声称整个执行期间中心库计数不变，不清理归属未知账号。本轮中心专项在临时实例执行；实际中心的5个非法注册邮箱逐个查询均不存在，专项检查前后账号77一致，测试账号未写入当前中心。

## 验收与未做范围

1. 登录页创建账号：少于6位、中文、空格或符号密码应被拒绝；标准邮箱和至少6位字母数字密码应按普通用户身份创建。有效创建链路已在可销毁测试库自动验证，无须在当前库额外建号。
2. 原有账号仍可登录，原页面不变；管理员创建用户仍要求首次改密。
3. 联系人分配必须先接受；未选中的同公司联系人不会随之开放，重复接受不产生重复归属或通知。
4. 后续执行`npm run crm:online:test`会自动用临时库，不再把大量合成账号留在当前中心。

没有新增依赖、业务表列、配置键或桌面IPC。中心库、业务SQLite、离线SQLite结构继续以`database-dictionary-20261015-n4.md`为准；未实施历史数据迁移、营销任务整体上云、跨重启未知回执重试或关机持续Worker。本次为后端修复，未替用户进行真实注册、真实外发或逐页桌面人工验收。

Checkpoint：`D:/Agent Basement/checkpoints/prospector-center-regression-fix-20261015`。

知识库：已同步当前状态、聚合审阅与人用总览，check_vault.py返回ok=true、errors=[]。Prospector与运价台账仍有全仓指纹needs_review提示；本轮未覆盖全部并行差异，不重置整体基线。

## 账号增长补充确认（2026-10-15）

用户后续确认：上述账号增长来自正在进行的 Navigator 账号迁移，不再列为未知来源问题。不得将这批迁移账号作为测试残留清理；本轮新增验证继续采用回滚事务。
