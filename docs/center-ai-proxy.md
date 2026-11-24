# 中心 AI 代理与用量管理

## 目标

模型密钥只保存在中心服务器环境变量中，客户端通过中心用户会话调用代理。中心可按用户控制 AI 开关、功能、输出上限和 token 配额，并记录用量。

## 服务端配置

中心应用读取以下环境变量，不要把值写入客户端、Git 或对话：

- `CENTER_AI_BASE_URL`：OpenAI 兼容上游根地址
- `CENTER_AI_API_KEY`：上游密钥
- `CENTER_AI_MODEL`：默认模型名

Windows 本地中心若由早于用户环境变量变更的长进程启动，模型档案引用的 `keyEnv` 可能不在 `process.env`。服务端会先读进程环境，再按需只读回退到当前 Windows 用户的 `HKCU\Environment`；密钥只进入内存，不写日志或响应。

## 客户端调用

- Prospector 桌面端不再提供模型端点、供应商密钥或轻任务档配置；对话与能力调用统一使用当前中心登录会话。
- `GET /api/ai/status`：返回当前用户的 AI 策略和可用状态
- `POST /api/ai/chat/completions`：使用 `Authorization: Bearer <中心会话>` 调用，请求体包含 `feature`、`messages`，可选 `max_tokens`、`temperature`
- `GET /api/ai/receipts?limit=20`：当前用户最近 AI 回执

`feature` 只允许：`agent`、`draft`、`backcheck`、`mail_analysis`、`summary`。上游返回原样透传，中心记录 token、状态、耗时与模型。

## 管理接口

- `GET /admin-api/ai/policies`：读取用户开关、配额和当月用量
- `POST /admin-api/ai/policy`：修改单个用户策略
- `GET /admin-api/ai/usage?days=30`：读取近 N 天汇总用量
- `GET /admin-api/ai/models` / `POST /admin-api/ai/model`：维护模型档案；密钥只保存环境变量名
- `GET /admin-api/ai/usage-events`：按用户、功能、状态、日期读取请求级回执

只有 `identityAdmin` 或 CRM `admin` 可管理 AI 策略。

## 数据库

- `public.ai_user_policies`：用户开关、日/月 token 上限、单次输出上限、允许功能、最后修改人
- `public.ai_usage_events`：每次请求的用户、产品、功能、模型、输入/输出 token、状态、耗时和请求编号
- `public.ai_model_profiles`：模型档案、Base URL、模型名、接口类型、密钥环境变量名、功能范围和默认标记
- `public.ai_policy_audit`：记录管理员修改用户开关/配额前后的策略和原因

迁移版本：`074-ai-user-policies`、`075-ai-operations`。

## 边界

- 不记录完整 prompt 或邮件正文，只记录用量元数据。
- 客户端自定义模型端点仍可作为管理员/开发配置保留；普通用户默认应走中心代理。
- 中心代理当前只实现 Chat Completions 协议；Responses 代理可后续增加。
- 客户端在未配置本地自定义端点时，会优先使用当前中心会话调用代理；代理不可用时仍回到本地确定性规则分类。
