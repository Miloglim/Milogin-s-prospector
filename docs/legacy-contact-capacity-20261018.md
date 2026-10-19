# 历史联系人映射与容量验证（2026-10-18）

## 结论

本节点完成只读影子核对和隔离容量验证，没有执行历史联系人迁移，也没有写入正式数据库。

## 本机旧 SQLite 影子核对

读取 `C:/Users/YQN/AppData/Roaming/prospecting-email/data/prospector.db` 的只读副本：

| 项目 | 结果 |
|---|---:|
| 文件大小 | 86,638,592 bytes |
| contacts | 8,660 |
| interactions | 3,022 |
| inbox_messages | 3,482 |
| 非空邮箱重复 | 0 |
| `crm_legacy_contact_map` | 不存在 |
| `crm_legacy_mail_sync` | 不存在 |
| 邮箱查询 | 命中 `idx_contacts_lower_email` |

这说明旧本地库可以作为后续映射输入，但当前不能直接声称已与中心联系人打通；没有映射表时，不允许上传旧联系人或把旧本地 ID 当中心 ID。

## 中心容量验证

在一次性隔离 PostgreSQL 中创建 100,000 条合成联系人，验证授权范围、首屏、末页和邮箱搜索分页。事务完成后回滚并回收测试实例，未连接正式中心。测试通过：2 项，容量用例耗时约 8.1 秒。

## 映射规则确认

后续正式迁移仍必须使用标准化邮箱的唯一匹配：

- 本地和中心都只有一个候选时，才建立 `localContactId → customerId/contactId` 映射；
- 重复邮箱标记 `ambiguous`，缺失候选标记 `unmatched`；
- 不按姓名、公司名或旧本地编号猜测；
- 映射前不上传邮件原文、附件或旧邮件事件；
- 销售身份才能触发个人线索迁移，管理员不会自动上传旧本地联系人。

## 验证结果

- 历史映射、旧联系人转换、旧邮件队列和收件箱补挂专项：16 项通过。
- 隔离 PostgreSQL 中心回归：10 项通过。
- 100,000 联系人容量分页：通过。
- 本机旧库：只读读取，未写入、未上传、未发送邮件。

checkpoint：`D:/Agent Basement/Milogin-s-prospector/checkpoints/legacy-contact-capacity-20261018`。

## 未完成

真实迁移前还需要在同一销售账号下取得中心联系人投影，生成映射预览并由管理员确认异常项；本节点不自动导入 8,660 条旧联系人。
