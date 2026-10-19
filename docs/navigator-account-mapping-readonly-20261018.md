# Navigator 账号只读映射报告

日期：2026-10-18  
状态：源码与结构只读核对，未读取密码、Token 或私钥，未写任一数据库。

## 核对范围

真实 Navigator 路径为 `C:/Users/YQN/Documents/正式版运价库/运价项目/Database`。本报告核对了 `manualdb.py`、`postgresdb.py`、`core/growth_contracts.py`、`services/account_growth.py`、`ops/account_selfservice.py`、`manual_server.py` 和账号测试/契约文件。`D:/Agent Basement/vben-nav-poc/repo` 只作为前端原型参考，不能代表真实运价系统。

## 可迁移字段

| 真实 Navigator 字段 | 中心目标 | 处理 |
|---|---|---|
| `operators.user_id` | `identity.users.user_id` | 建立旧 ID 到中心 UUID 映射，保留旧值作为迁移审计，不覆盖中心 UUID |
| `operators.name` | `identity.login_aliases.alias` | 作为登录别名迁移；它不是独立的 Navigator 昵称 |
| `operators.display_name` | `identity.users.display_name` | 作为跨产品通用昵称，按冲突规则生成待审项 |
| `operators.preferences_json.avatar_id` | `identity.user_profiles.avatar_id` | 中心只存头像 ID，现有白名单静态资源继续由产品页面提供 |
| `account_experience_events` | `identity.account_experience_events` | 保留事件类型、主题键、积分、规则版本和发生时间；迁移前先校验重复键 |
| 成长循环/等级投影 | `identity.account_growth_projection` | 由已迁移事件重建并核对现有 Navigator 摘要 |

## 必须留在 Navigator 的字段

- `routes`、`groups`、`match_mode`、默认页签和运价产品开关。
- `publisher_name`、`publisher_id` 等报价来源业务身份。
- Navigator 审核统计、运价查询事实、审核与治理事件。

Prospector 的邮箱账号、发信人名称和 AI 设置仍由 Prospector 自己保存；这些字段不能覆盖中心通用昵称。

## 迁移前检查

1. 只读统计正式 PostgreSQL 的 `operators` 用户数量、重复邮箱/登录名和缺失显示名。
2. 核对旧 `password_hash` 的算法是否能由中心 `scrypt-v1` 验证；不兼容时保留强制改密路径，不导出明文密码。
3. 以中心 UUID 生成映射预览，重复或缺失项进入待审清单，不自动猜测。
4. 用一名隔离账号演练成长事件迁移，确认每日上限、规则版本和幂等键在迁移前后不变。
5. 观察期内保留 Navigator 旧登录和成长写入的只读回退能力；验证通过后再单独批准登录切换。

## 当前结论

中心 schema 已准备，但真实账号映射、正式数据迁移、Navigator 登录切换和 `navigator` 产品连接状态均未完成。下一阶段应先生成正式库只读映射报告，不应直接改生产账号或删除旧表。

## 2026-10-18 真实 PostgreSQL 只读核对

本次通过本机受控环境文件建立 PostgreSQL 只读事务，仅输出统计，不输出 DSN、密码摘要或会话内容：

| 项目 | 结果 |
|---|---:|
| `operators` 总账号 | 36 |
| `active=1` | 12 |
| 有密码摘要 | 12 |
| 无密码摘要 | 24 |
| 非邮箱格式登录名 | 31 |
| 登录名重复组 | 0 |
| 空显示名 | 33 |
| 显示名重复组 | 0 |
| `account_experience_events` | 5,101 |
| 有经验记录的账号 | 9 |
| 经验事件类型 | 10 |
| 规则版本 | 2 |
| 经验重复键组 | 0 |

密码摘要格式全部为 `pbkdf2_sha256$...`；Prospector 中心当前 `PasswordAdapter` 只接受 `scrypt-v1$131072$8$1$...`。两者不能直接互换。推荐迁移策略是：

1. 中心为迁移期增加受控的旧 PBKDF2 校验分支，成功登录后立即重算并保存 `scrypt-v1`。
2. 没有旧密码摘要的 24 个账号不自动创建密码，统一进入强制重置/邀请流程。
3. 迁移期结束后关闭 PBKDF2 分支，中心只保留 scrypt。
4. 迁移前仍需生成逐账号映射预览；不以显示名自动合并，不迁移旧会话。

本次只读查询未写入正式数据库。密码兼容分支属于下一份独立的认证迁移计划，不能和账号资料 schema 一起直接上线。

Prospector 已先加入 `028-legacy-pbkdf2-compat` 和受限 PBKDF2 校验能力，作为迁移准备。该能力尚未接入 Navigator 账号导入，也没有改变当前中心用户的登录流程；真实迁移仍需逐账号映射预览和强制改密标记。

已在真实 Navigator 项目加入只读工具 `ops/account_mapping_preview.py`。实际预览返回36个账号：33个 `needs_review`、3个 `pending`。`needs_review` 主要由空显示名、无密码摘要触发；工具强制 PostgreSQL 只读事务，不输出任何密码摘要、会话或 Token。

隔离迁移演练已加入 Prospector 并通过：测试账号从 `matched` 开始，使用旧 PBKDF2 摘要验证成功后重算中心 scrypt，替换凭据并把映射标记为 `migrated`；测试结束删除全部隔离数据。该演练没有执行真实账号迁移。

## 正式迁移结果

2026-10-18 已在正式中心执行 `scripts/migrate-navigator-email-accounts.mjs`：导入5个邮箱格式账号，4个空显示名使用邮箱补全，写入5条 Navigator 产品授权和5条 `migrated` 映射；旧 `admin` 及其他非邮箱账号未迁移，中心原超级管理员保持不变。迁移前备份位于 `C:\ProgramData\MiloginCenter\backups`，迁移后核验账号6个、Navigator授权5条、会话0条。密码摘要未输出，仍由受限 PBKDF2 兼容分支等待首次成功登录重算 scrypt。
