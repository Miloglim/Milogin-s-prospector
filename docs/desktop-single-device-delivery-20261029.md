# Prospector 单活跃设备交付（0.67.0）

状态：工作区已实现并完成隔离 PostgreSQL、HTTP 与渲染验证；未部署正式中心，未发布安装包。

检查点：`D:\Agent Basement\checkpoints\prospector-single-device-20261029`（本次功能相关 36 个文件）。

## 结论

Prospector 采用“换设备登录，不做多端同时工作”。同一中心账号同一时间只允许一个活跃 Prospector 设备；新设备首次登录只返回替换确认，不撤销旧设备。用户确认后，中心在一个事务中撤销旧 access/refresh 会话并启用新设备。

规则只作用于 `product='crm'` 的桌面会话。Navigator、管理中心浏览器会话和旧版未携带设备信息的客户端不套用该唯一设备约束。

## 登录链路

| 场景 | 结果 |
|---|---|
| 无活跃设备 | 首次登录直接建立设备会话 |
| 已有一台不同设备，未确认 | `409 DEVICE_REPLACEMENT_REQUIRED`，原设备保持可用，不签发新凭据 |
| 用户点击“退出原电脑并登录” | 第二次登录携带 `replaceActiveDevice=true`，旧会话与 refresh family 在同一事务内撤销 |
| 同设备重新登录 | 替换该设备自己的旧会话，不弹换机确认 |
| 旧设备再次请求 | `401 DEVICE_REPLACED`；主进程清理当前登录并停止旧账号本地任务 |
| 密码修改/停用/管理员撤销 | 继续走原安全路径，撤销对应会话 |

主进程为本机安装持久保存 `prospector-device.json`，其中只有随机设备 ID 和版本，不包含账号、邮箱、Token 或密码。登录请求由主进程附加产品、设备 ID、设备名、平台和应用版本；renderer 不生成或持有这些凭据。

## 数据库

迁移 `008-desktop-active-device-public` 为 `public.identity_sessions` 增加：

- `desktop_product`
- `desktop_device_id`
- `desktop_device_name`
- `desktop_platform`
- `desktop_app_version`
- `revocation_reason`

部分唯一索引 `idx_identity_sessions_active_desktop_product(user_id,desktop_product)` 只约束 `desktop_product IS NOT NULL AND revoked_at IS NULL` 的行。登录事务先锁中心用户，再重验密码之后替换旧会话；两个并发首次登录最终也只会留下一个活跃设备。

## 发送边界

批量发送和 Agent 发信在中心在线时，于 SMTP 前调用当前会话检查；旧设备被替换后返回 `DEVICE_REPLACED`，本组标记停止并暂停发送。中心离线时仍保留现有自有线索本地 SMTP 行为，因此断网旧设备无法即时收到中心换机结果，这是当前离线优先模型的剩余窗口，不能宣称绝对零重复执行。

换机不会迁移旧电脑的未同步修改、邮件附件、发送队列或 SMTP 密码。新电脑从中心重建联系人，并必须重新授权邮箱。

## 验证

- 设备 ID 持久化及契约透传单测通过。
- 桌面会话真实 HTTP + 隔离 PostgreSQL 9 项通过，覆盖首次冲突、取消不踢旧设备、确认替换、旧 access/refresh 失效、唯一活跃设备、并发安全基础和既有安全回归。
- 登录页渲染测试通过，确认第一次请求不带替换标记，只有用户点击明确按钮才发送第二次请求。
- 真实 Electron + 合成中心冒烟通过：首次登录出现换机提示，确认后才发第二次请求，两次使用同一持久设备 ID，页面错误 0。
- 批量发送设备检查和原发信管线 24 项通过。
- 完整 Vitest 使用 `minWorkers=1/maxWorkers=4`：241 个文件通过、35 个外部集成文件跳过，1806 项通过、196 项跳过、0 失败。
- 公司 bootstrap 一次性完整执行：93 张表、885 个字段、949 个约束、231 个索引、35 条迁移、2 个视图；临时库已删除。
- `npm run typecheck`、server/admin/Electron build 与 265 文件架构检查通过。

## 未解决边界

- 正式公司中心尚未应用 `008`，正式安装包尚未发布。
- 管理端尚未展示设备名、平台、应用版本和最后在线时间，也尚未增加单设备撤销入口。
- 离线旧电脑在重新联网前无法得知已被替换。
- 草稿、附件、发送队列和邮箱凭据仍不跨设备同步。
