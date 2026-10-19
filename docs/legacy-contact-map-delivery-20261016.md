# 旧 SQLite 联系人映射（2026-10-16）

## 这次完成了什么

旧版 SQLite 的 `contacts` 记录现在会在中心联系人完整刷新成功后，按标准化邮箱建立本地映射表 `crm_legacy_contact_map`。映射只保存本地联系人 ID 与中心 `customerId/contactId` 的关系，不改旧联系人表，也不改变收件箱和本地发信行为。

## 匹配规则

- 邮箱只做 `trim + lowercase`，不做姓名、公司名或模糊匹配。
- 本地和中心各自都只有一个同邮箱候选时才标记 `mapped`。
- 任一侧出现多个候选时标记 `ambiguous`，不会猜测。
- 中心暂时没有候选时标记 `unmatched`，后续完整刷新可再次尝试。
- 已删除的本地联系人对应映射会在刷新时清理。

## 表字段

| 字段 | 用途 |
| --- | --- |
| `local_contact_id` | 旧 SQLite `contacts.id`，主键 |
| `center_customer_id` | 中心客户编号，例如 `1-O` |
| `center_contact_id` | 中心联系人编号 |
| `state` | `mapped`、`ambiguous` 或 `unmatched` |
| `reason` | 未映射原因，供后台核查 |
| `matched_at` | 本次映射计算时间 |

## 边界

这一步只建立身份关系。它没有自动把旧联系人创建到中心，也没有上传邮件原文或历史交互；这样可以避免重复建档和错误归属。后续要做旧数据迁移时，必须复用这张映射表，并在中心接口确认权限、版本和幂等键后再写入。

## 验证

- `tests/unit/legacy-contact-map.test.ts`：唯一匹配、重复候选、未匹配三种情况通过。
- `npm run typecheck`：通过。
- `npm run check`：架构边界检查通过。
