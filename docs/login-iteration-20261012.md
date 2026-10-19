# 登录环节迭代交付

日期：2026-10-12。工作区版本0.16.0-alpha.1，未发布。checkpoint：D:/Agent Basement/checkpoints/prospector-login-registration-20261012；保留原有未提交工作。

## 变更与验收

- 原向导布局及动态菱形保留，字标分为小号Milogin’s与主字标Prospector.；不添加教学说明。
- 输入框聚焦边框不变化，无outline/box-shadow；spellcheck=false、autoCorrect=off、autoCapitalize=none，密码管理器autocomplete保留。
- 创建账号打开邮箱/密码/确认密码表单；确认密码仅前端校验。服务端只接email/password，固定销售角色、own数据范围、非管理员。成功回登录，邮箱预填，再走既有登录续期链路。
- 忘记密码仅按钮，无请求、弹窗或恢复链路。连接设置从登录页删除，实际中心地址沿用统一全局配置；本阶段仍回环本机。登录与侧栏开发预览入口删除、RolePreview组件删除；开发者保留dev:dual两个独立真实账号窗口。
- 启动start.bat或npm run dev，创建一个新邮箱账号，再登录；管理员中心用户列表应能看到该用户为销售。邮箱必须使用测试身份或自己的地址；Agent对话不是密码存储，请在程序里输入。

## 契约与一致性

新增online:register → POST /api/auth/desktop/register；OnlineRegistration与RegisteredAccount先声明，IPC/服务/adapter/preload共用常量。在线16个声明与16个处理器对应，桌面认证路由6个。注册不自动颁发会话、不建立另一套账号缓存、不写本地SQLite。

PostgreSQL事务固定写users/login_emails/credentials/product_grants/product_access/management_audit/outbox；并发同邮箱只有一个成功，重复409，角色/管理员注入400。scrypt-v1复用现有适配器，无新依赖、表或迁移。旧接口仍有调用方，不提前删除。

## 验证

完整普通测试819通过/90跳过；真实桌面会话PG/HTTP8通过，含并发注册、唯一邮箱、角色注入、sales/own准入、管理接口403、密码摘要和审计。桌面/服务端类型检查、桌面/管理端构建、架构184文件0例外通过。

实际Electron调用真实IPC/HTTP/PostgreSQL完成注册再登录，身份只有sales、identityAdmin=false、emailVerified=false；输入框正常/聚焦边框一致且无阴影/描边、spellcheck=false；忘记密码无动作、没有连接与DEV入口、pageerror为0。证据.work/login-registration-20261012，截图和不含凭据的report。

## 当前边界与后续对齐

邮箱验证邮件未接入，verified_at=NULL，不宣称邮箱归属已验证或正式公网注册可发布。忘记密码后端未实现。部署时统一中心地址、不重新加入用户地址设置。角色与账号创建由后端裁决，运营/管理员不能由注册表单自选。

最新用户要求覆盖旧R1提案中“注册未开放”“页面DEV合成预览”“恢复账号”。后续按当前环节反馈更新R2–R6方案；仍按重大调整先报告批准、每节点检查点与接口核查推进，不扩大本轮为业务工作台重设计。

### 2026-10-12 固定视口补验

登录容器覆盖向导overflow-y:auto和额外card padding，改为标题栏下flex视口及700/800px高度下的紧凑间距。实际Electron验收7状态（1280x800、1040x660、1366x768登录；最小窗口注册/确认不一致、首次改密/错误）：文档与main均无内容溢出，所有字段/按钮在可见边界，滚轮不移动。登录边界4测试与类型检查通过，不新增IPC/API。checkpoint prospector-login-fixed-viewport-20261012；参考核对[飞书官方登录流程](https://www.feishu.cn/hc/zh-CN/articles/303520488692-登录和退出登录账号)，没有将官方帮助页当成其所有窗口均无滚动的证据。
