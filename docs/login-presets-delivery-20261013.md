# 登录账号预设 · 2026-10-13

用户批准短设计后实施，工作区版本0.33.0-alpha.1，未发布。checkpoint：[改前源码与文档](<D:/Agent Basement/checkpoints/prospector-login-presets-20261013>)。

## 使用行为

- 原登录页保留菱形、点阵、居中字段、等宽按钮；邮箱右侧下拉展示在本机成功登录过的账号，带字母头像和移除按钮。没有写死账号或添加中心用户。
- 记住密码与自动登录分别勾选：前者保留系统加密的续期凭据，下次需要点登录；后者在成功登录后保存启动恢复选项。自动登录联动勾选记住密码，取消记住联动取消自动。
- 已记住账号的密码框仅显示点状占位，不回填真实密码或Token。用户输入密码则走原密码登录；选定已记住账号并直接点登录则由main走原refresh。
- 退出撤销当前会话并清其本机凭据，保留邮箱预设；其他账号不受影响，也不会作为自动登录备用。移除只删除指定本机预设，不删除中心用户或该账号SQLite资料。
- 初次/被要求改密仍停在原改密页。网络不可用仅凭有效的原72小时签名离线授权进入本地工作区；到期、签名无效、撤销或身份不一致不能靠预设绕过。
- 旧单账号加密文件兼容，原自动恢复语义保留；下一次成功登录写入新登记格式。无明文密码存储或加密失效时的明文退路。

## 数据与接口

ProductLogin → IdentityContext → 三个ONLINE账号预设IPC/原LOGIN与RESTORE → OnlineCrmAdapter → 系统加密账号登记 + 原中心desktop认证API。身份成功后仍由既有中心+用户隔离机制选取个人SQLite，CRM同步链路不变。

只新增online:account-list、online:account-login、online:account-remove；共享常量/生产白名单/handler逐一对应，返回Result。账号列表只有公开元数据，账号登录结果只有公有Identity/SessionSnapshot，凭据不出main。中心HTTP路径、账号表、角色权限和CRM表均不新增。

系统加密登记原子串行更新，按中心/用户组合定位。只清当前凭据与移除指定项，避免原单账号clear的全量删除语义。续期响应在保存前校验用户一致，防止错误身份进入缓存。登录/注册/改密最低长度引用中心AUTH_LIMITS，修正旧前端残留12位和中心6位不一致。

## 验证

- 测试先行：原代码7项存储失败，新增适配2项失败、页面4项失败，然后实现。最终全量1109通过/150条件跳过，133文件通过/21条件跳过。并发高负载下曾出现无关管理端测试5秒超时，限制4个worker后全量通过，未修改该测试或全局超时。
- 类型、桌面构建与201源码架构边界检查通过；IPC测试确认所有声明恰好注册一次，列表不包含凭据。
- 真实隐藏Electron使用生产renderer/preload/ONLINE IPC、Windows DPAPI和HTTP/PostgreSQL完成六链路：记住不自动、双账号选择与最小窗口、真实重启自动、退出只清当前、断网签名恢复、远端撤销及单项移除。页面异常0，1280与1040×660截图核查，无页面滚动或控件越界。
- 使用既有固定Agent用户/管理员，外层PG事务回滚，users=6/sessions=67/customers=62/contacts=994/companies=975/outbox=76前后一致；临时加密资料目录已删除。没有新增测试账号、真实外发或发布release。

证据：[实测报告](<D:/Agent Basement/Milogin-s-prospector/.work/login-presets/runtime/report.json>)、.work/login-presets-all-tests.log、login-presets-typecheck.log、login-presets-build.log、login-presets-architecture.log、runtime/presets-1280.png与presets-1040.png。

## 当前运行边界与验收

用户原窗口主进程28868仍加载旧0.32.2，未强制退出或清其凭据。新main须从托盘“退出”后用start.bat重开；右上X可能仅收起到托盘。新构建已隔离实测，不把Vite热更新视为新IPC已加载。

验收：一次勾记住不勾自动完成登录，退出程序重开应停在登录页、保留预设且无需再输密码；勾自动完成登录，正常退出程序重开应直接进入。切换账号/退出登录后应保留其他预设，删除一个预设应只减少一项。生产远端部署、安装升级和各平台系统加密兼容尚未验收。
