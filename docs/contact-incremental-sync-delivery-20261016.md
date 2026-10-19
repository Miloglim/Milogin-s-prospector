# N6 中心联系人增量同步交付（2026-10-16）

## 改动

新增版本化中心接口 `/api/crm/contact-changes`。中心在 `identity.outbox` 插入后，以 `crm_contact_change_seq` 生成全局单调游标，并为有 CRM 准入的收件人写入变化记录。覆盖联系人资料、跟进、删除、分配状态及共享权限变化；过期或失去可见权限的记录只返回墓碑。迁移通过 `007-contact-change-feed-n6` checksum 防止漂移。

本地新增 `runContactIncrementalSync` 纯 core 应用器和 SQLite `sync_cursor`。首次完整扫描前读取中心 `headCursor`，完整扫描成功后保存同一高水位；后续按 `baseCursor → nextCursor` 增量应用。每页所有 upsert/tombstone 成功后才保存游标，写入异常、权限变化、游标错位、中心要求重扫或不支持接口都会回退完整同步。

## 验收

- `npm run crm:pg:build`：通过。
- `npx vitest run tests/unit/contact-change-feed.test.ts tests/unit/contact-incremental-sync.test.ts`：7/7 通过。
- `npm run crm:pg:test`：现有一次性隔离中心回归 10/10 通过。
- `npm test`：191 个测试文件通过，1593 项通过，169 项按环境跳过，0 失败。
- 独立安全审查发现并修复了管理员必须具有有效 CRM product access、触发器事件白名单和客户更新事件覆盖问题；剩余 PG 专项需要显式 `PROSPECTOR_PG_INTEGRATION=1` 才会执行。

## 运行边界

本节点未改变前端和 IPC；客户端已接入增量同步，首次完整扫描建立基线，异常时回退完整扫描。迁移前历史不回填，首次启用必须完整扫描建立游标基线；游标异常、中心不可用或权限变化继续走完整扫描。未启动正式中心、未写生产数据、未发真实邮件、未发布 release。

checkpoint：`D:/Agent Basement/checkpoints/prospector-contact-local-incremental-20261016`（本节点实施前源码与文档快照）。


