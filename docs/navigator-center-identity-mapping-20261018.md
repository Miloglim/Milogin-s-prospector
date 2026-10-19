# Navigator 与中心账号统一方案（字段对照）

日期：2026-10-18  
状态：方案与字段核对，未实施数据库迁移，未修改登录链路。

## 当前事实

前一轮把两个目录混为一个 Navigator，结论需要纠正：`D:/Agent Basement/vben-nav-poc/repo` 是独立的前端看板原型，使用 `mock/ledger.ts`；真正的 Navigator/运价系统位于 `C:/Users/YQN/Documents/正式版运价库/运价项目/Database`，其 `manual_server.py` 已提供真实运价查询、审核、账号资料和成长接口，并支持 SQLite/PostgreSQL。

真实 Navigator 已有账号成长模型：`account_experience_events` 经验流水、统一成长投影、循环等级、每日上限、跨日幂等和 SQLite/PostgreSQL 启动结构；账号资料接口 `/api/account/profile` 已支持显示名、头像预设、个人查看偏好，个人成长接口为 `/api/account/growth`。因此经验机制不是待发现的空白，而是迁移时需要提升到中心的既有能力。

Prospector 中心已经有统一身份基础：`identity.users`、`identity.login_emails`、`identity.credentials`、`identity.sessions`、`identity.product_grants`、`identity.product_access`。中心当前已经登记 `navigator` 产品，但产品记录仍标记为未连接，Navigator 的正式登录和业务接口尚未切换到中心身份。

## 字段归属

| Navigator 当前字段或能力 | 中心统一账号 | Navigator 专属资料 | Prospector 专属资料 | 处理方式 |
|---|---|---|---|---|
| 登录邮箱 | `identity.login_emails.email` | — | — | 只保留中心一份，Navigator 迁移时按邮箱建立映射 |
| 密码 | `identity.credentials.password_hash` | — | — | 只迁移密码哈希；禁止读取或迁移明文密码 |
| 用户 ID | `identity.users.user_id` | — | — | 中心 UUID 作为两个产品共同 ID，旧 Navigator ID 留映射表 |
| 姓名/显示名 | `identity.users.display_name` | — | — | 通用显示名统一走中心 |
| 头像 | 中心用户资料字段或关联资料表 | — | — | 两个产品共用头像；Navigator 页面继续保留上传/编辑体验 |
| 登录账号/用户名 | 中心登录标识（需要补充唯一登录名时新增） | — | — | 真实 Navigator 的 `operators.name` 是登录账号，不应再造一个 Navigator 用户名；迁移为中心登录标识或受控登录别名 |
| 角色 | `identity.product_grants` + `identity.product_access` | Navigator 业务角色映射 | CRM 角色映射 | 不把 Navigator 角色字符串直接写进中心用户表 |
| 个人简介 | 通用资料字段（必要时新增） | — | — | 作为账号通用资料统一保存 |
| 经验值/等级/成长 | 中心成长流水与投影 | — | — | 现有 Navigator `account_experience_events` 提升为中心共享成长机制；两个产品读取同一总经验、等级和循环，不各自计算 |
| 审核严重程度“等级” | — | — | — | 这是待审数据字段，不是用户等级，不能迁移为账号经验 |
| 运价审核统计 | — | Navigator 统计表 | — | 按中心 `user_id` 关联，不能复制成用户基础字段 |
| 发信人名称 | — | — | Prospector 邮箱/身份配置 | 继续由 Prospector 管理，不能覆盖通用显示名 |
| `publisher_name` / 报价身份 | — | Navigator 报价来源业务身份 | — | 它用于匹配运价发布人和来源，不是登录用户名或通用昵称，不能与中心显示名合并 |

## 推荐数据结构

```text
identity.users                 登录身份、通用显示名、状态
identity.login_emails          登录邮箱
identity.credentials           密码哈希
identity.sessions              统一登录态
identity.product_grants        产品角色
identity.product_access        产品开通、范围、能力
identity.user_profiles         头像、简介等跨产品资料
identity.account_experience_events 统一经验流水，带 source_product 和幂等 subject_key
identity.account_growth_projection 统一总经验、等级、循环和每日状态
navigator_profiles             Navigator 专属偏好、航线/来源群默认筛选、报价业务资料
prospector_profiles            发信身份、邮箱和 AI 配置
```

`identity.users` 保存跨产品都成立的身份事实；头像、简介和成长机制也属于账号通用能力，因此应进入中心账号域，但经验流水不要直接塞进 `identity.users` 主表，应放在中心账号成长表中。Navigator 的航线偏好、来源群偏好、默认页签和运价产品开关仍属于 Navigator 专属配置。

## 实施顺序

1. 盘点真实 Navigator `operators`、`account_experience_events`、`account_security`、`preferences_json` 和账号资料接口，生成旧账号到中心 UUID 的只读迁移映射。
2. 中心增加通用资料表和统一成长表；把现有 Navigator 成长规则、事件幂等、每日上限和等级投影原样迁入中心，先保证数值不变。
3. 将 Navigator 登录改为中心登录，使用中心 session/token 和 `navigator` 产品权限。
4. Navigator 账号页改为：头像、显示名、简介、成长进度读写中心；航线偏好、来源群、默认页签等写 Navigator 产品配置表；页面外观和现有编辑体验保留。
5. Prospector 账号页也读取同一中心头像、显示名和成长摘要；Prospector 发信人名称继续使用自己的邮箱身份配置。
6. 用同一测试账号验证两个产品的登录、退出、禁用、角色变化、头像、显示名、经验增加和跨设备幂等，再做旧账号只读观察期。
7. 观察期稳定后，停止 Navigator 旧账号库身份和成长写入；确认可回退窗口结束后再归档旧表。

## 当前未决项

- Navigator 真实账号数据库和成长表已经定位为 `Database` 下的 `operators`、`account_experience_events` 等结构；正式迁移前仍需核对实际生产 PostgreSQL 的用户数量、旧账号登录名和密码哈希兼容性。
- 头像和显示名应在中心统一；头像文件继续使用现有白名单静态资源，中心只保存头像 ID，不保存图片字节。
- 经验机制应统一到中心，但需要定义产品事件来源和奖励规则版本，防止 Prospector 与 Navigator 对同一行为重复奖励。
- 中心 `navigator` 产品已经登记，但仍是未连接状态；正式接入前不能把管理端状态改成已连接。

## 2026-10-18 中心 schema 准备完成

Prospector 已在身份迁移链中加入两个 checksum 迁移：`026-unified-account-profile` 和 `027-unified-account-growth`。中心现在具备 `identity.user_profiles`、`identity.login_aliases`、`identity.account_experience_events`、`identity.account_growth_projection` 的结构约束，并通过隔离 PostgreSQL 验证了重复迁移安全、用户级级联清理和成长事件幂等。

这只是中心数据域的结构准备。真实 Navigator 账号、头像、经验历史尚未复制，Navigator 登录仍未切换到中心，生产 PostgreSQL 未写入，`identity.products.navigator.connected` 仍保持未连接。下一步是只读生成真实账号映射和密码哈希兼容性报告，再单独设计迁移演练。

字段级只读核对与迁移前检查清单见 [`navigator-account-mapping-readonly-20261018.md`](navigator-account-mapping-readonly-20261018.md)。

