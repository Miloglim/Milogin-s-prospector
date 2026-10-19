# Navigator 用户授权查价实施计划

目标： Prospector 用户经 Navigator 授权后在线查价；身份、现行权限及去重查询留痕由 Navigator 负责。
架构： 标准授权码 + PKCE S256，系统浏览器登录；Electron 主进程持有凭据。复用现有查询、图片与行为统计，不让客户端指定身份。两仓库已有工作保留，仅改本次文件；不重启生产、不发布。
技术栈： Python 标准库、现有 SQLite/PostgreSQL 适配，Electron/TypeScript/React 及已有依赖。
契约： 本文件包含已在对话中获用户授权的双边契约。

## 双边契约
- client_id 固定 prospector；权限 rates:read space:read images:read。
- GET /api/prospector/authorize: response_type=code,client_id,redirect_uri,state,code_challenge,code_challenge_method=S256。redirect_uri 仅 http://127.0.0.1:<动态端口>/navigator/callback。授权页使用 Navigator 现有账号登录接口，浏览器明确确认授权。
- POST /api/prospector/authorize: 同源浏览器会话 + 上述参数；返回 {ok,data:{redirect_url}}，短时单次授权码，绑定当前用户、PKCE 与完整 redirect_uri。
- POST /api/prospector/token: grant_type=authorization_code,code,code_verifier,client_id,redirect_uri；或 grant_type=refresh_token,refresh_token,client_id。返回 {ok,data:{access_token,refresh_token,token_type:Bearer,expires_in,user:{user_id,name,display_name,role}}}。
- GET /api/prospector/me: Authorization Bearer；返回 {ok,data:{user}}。
- POST /api/prospector/logout: Authorization Bearer；撤销该设备授权的全部令牌。
- API Bearer 仅开放 GET /api/rates /api/space /api/rates_grouped /api/space_grouped /images/<basename> /api/prospector/me；不变更 cookie 账号或采集器权限。
- 服务端每次重新验证用户有效状态、强制改密码和现行授权；令牌仅存 hash；access 900_seconds、授权码120_seconds、refresh2592000_seconds，刷新轮换并拒绝重放。请求与错误日志不能包含令牌、密码、授权码。
- 主动查价参数 query_id=UUID、activity=intentional；服务端绑定 _client_app=prospector，以 user_id+query_id 去重；客户端不能伪造用户名或来源。分页、重试、同一次运价/舱位查询共享 query_id。
- 不改旧浏览器查询统计语义；Prospector 不下载全库绕过登录，不回退旧镜像查询。UI、AI 查价、舱位和报价方案必须统一鉴权，退出后清除缓存及可能含报价的对话现场。
- 图片经主进程带鉴权读取后以 data URI 提供页面，不泄露 Bearer。
- HTTP 仅限本机隔离开发；正式跨机器授权必须 HTTPS。不新增 npm/pip 依赖。

## 执行
- [x] Navigator：契约常量、纯校验、凭据存储适配、授权路由；先写 PKCE／重放／撤销／只读路由／身份测试。
- [x] Navigator：复用现行账号和查询范围；为 Prospector 查询记账加来源和去重；回归浏览器与采集器。
- [x] Prospector：共享类型与 IPC、浏览器登录回调、系统加密凭据、自动续期和退出。
- [x] Prospector：UI 登录入口、在线查价和图片；AI 与其他报价入口不得读取未授权旧镜像。
- [x] 双边：独立测试和文档（架构、IPC、已知陷阱），隔离服务端 + 桌面适配器完成真实 HTTP 契约测试。
- [x] 复核与交付：实际验证范围、未解决生产部署条件；不混入已有改动、不自动发布。
