# 发送引擎改造规格（熔断误伤修复 + 多流并发）send-engine-multistream-spec

> 版本：0.5.6-alpha.1 适用
> 状态：已实现并全量回归通过（68 files / 661 passed + 27 skipped / 688 total，tsc --noEmit 零报错）
> 对应文件：`src/main/services/send.service.ts`、`src/main/db/schema/send-queue.ts`、`src/main/db/index.ts`、`src/main/services/campaign.service.ts`

## 1. 背景与动机

原发送引擎是**单流全局串行**：`runBatchLoop` 一次只处理一个队列组，所有账号共用一个 `currentItem/delayUntil` 计时器。该设计为了消除"每账号一条并行循环"在共享状态（`currentItem`、`delayUntil`、组间暂停、同公司不连发）上的竞态，但带来两个问题：

1. **熔断误伤**：某账号连败 ≥3 次触发 `tripAccount` 时，会把该账号名下所有剩余 pending 组直接标 `failed`（文案"账号 X 熔断，本组未发送"），且 `failedCount++`。这些组其实**从未发出**，却与"真·发出去被拒"共用一个 failed 状态：
   - `resumeQueue` 只捞 `status=pending` → 被熔断判死的组重启后永不补发；
   - 熔断路径不调 `onCampaignSendFailed` → 任务触点卡在 `queued`，要等 24h 僵尸对账才回 pending 顺延；
   - 看板上这些触点显示为"失败"，但实际根本没发。
2. **无并发**：多任务（多个 campaign）只能排队串行，任务间互相阻塞；运行中追加的任务整批被拒（"已有发送任务运行中"）。

## 2. 方案一：熔断误伤修复——状态区分

### 2.1 数据模型

`send_queue` 新增列 `error_kind`（迁移 `v5.x-send-queue-error-kind`，存量 failed 行不动）：

| error_kind | 含义 | 处理语义 |
|---|---|---|
| `smtp_fail` | 真·发出去被拒（SMTP 535/550 等） | 计失败、计熔断、推进止损；`resumeQueue` 不捞 |
| `blocked` | 熔断/中断导致·未发送 | **不计失败**、不推进 stage、不标退信；任务触点当场回 pending，下一轮扫描重排 |

`SendItem` 接口新增 `errorKind?: "smtp_fail" | "blocked"`。

### 2.2 `tripAccount` 重构

- 摘除组标 `failed + errorKind="blocked"`，文案"账号 X 熔断，本组未发送（账号恢复后由任务扫描自动重排）"；
- **不再 `failedCount++`**（失败统计不虚增）；
- 收集被摘除组的联系人 → 惰性 import `campaign.service.onCampaignSendFailed(cid)`，**触点当场回 pending**（不等 24h）；
- 当**没有任何健康账号**可用时，剩余组整批标 `blocked`（文案"无可用发信账号（全部熔断/停用），本组未发送"）；
- 真失败分支标 `errorKind="smtp_fail"`；"发送器未配置"分支标 `blocked`。

### 2.3 效果

- 熔断不再"误杀"未发送组：它们以 `failed+blocked` 落库，任务触点回 pending 后由扫描器（10min 周期）重新分配合法账号补发；
- 失败统计只计真失败，熔断不计入；
- 看板不再把"未发送"显示成"发送失败"。

## 3. 方案二：引擎并发改造——多流 + 账号级协调器

### 3.1 模块级协调状态

| 状态 | 类型 | 说明 |
|---|---|---|
| `MAX_ACTIVE_TASKS_PER_ACCOUNT` | const = 10 | 每账号同一时刻最多排发 10 个任务组 |
| `accountLoad` | Map<accountId, number> | 当前在发组数（跨流共享） |
| `pendingAppends` | SendItem[] | 运行中追加的组（append 入队） |
| `activePlan` | SendItem[] | 当前批次全部组（**原引用**，流内 status 更新对 `getQueueItems` 可见） |
| `activeStreams` | Set<Promise> | 活跃流句柄 |
| `spawnedIds` | Set<string> | 防重复分桶（每个组只 spawn 一次） |
| `failsByAccount` / `sendAttempts` | Map | 跨流共享的熔断计数（原单流局部变量提级） |

### 3.2 调度模型

```
runBatchLoop（每批次一个）
 ├─ 启动快照：queues 全部组 + pendingAppends 合并，按 seq 排序（跨账号交错序）
 ├─ 入口清理：failsByAccount/sendAttempts/spawnedIds 清空（防跨批次残留污染熔断判定）
 ├─ groupByCampaign 分桶（手动直发归 "__manual__"），每桶 spawnStream → 独立 runStream
 └─ 主调度 while：
     ├─ 每轮先合并 pendingAppends → 开新流（运行中 append 即时并入）
     ├─ 完成判定：activePlan.every(x => x.status === "sent" || x.status === "failed")
     │    （只认终态；"sending"/"pending" 均视为未完成——曾误判导致重试轮批次提前结束）
     └─ 无活跃流但未收敛 → break（防御）→ 收尾
```

### 3.3 账号并发闸 `acquireAccount` / `releaseAccount`

- `campaignId` 存在（任务组）→ `await acquireAccount`：`accountLoad < 10` 放行并 +1，否则 `sleep(500)` 等号；
- 手动直发（无 campaignId）→ **不经过 await**（否则 dryRun 同步场景被微任务挂起）；
- 流结束 `finally releaseAccount`：-1。

### 3.4 runStream 桶内逻辑（与串行版一致 + 并发适配）

窗口外等待 → acquireAccount → 发送前置 `item.status="sending"`（防 tripAccount 跨流误伤）→ dryRun / sendBccFn 分支（瞬态重试 ≤2 次恢复 pending、组间暂停 randBetween、成功落库+阶段推进+onCampaignSendSent、真失败标 smtp_fail+onCampaignSendFailed+tripAccount(n≥3)）→ finally releaseAccount。

### 3.5 startQueue append 分支

- `state.isRunning && !opts?.append` → 拒绝（整批）；
- `append: true` → 重新亲和分配/轮换/交错（不重写 queues、不清旧队）、DB 追加行、`batchId` 沿用当前批次、补 accountStats/totalItems；
- `campaign.service` 扫描器入队统一传 `append: true`：引擎忙时任务组即时并入当前批次，不再整批拒绝。

### 3.6 竞态防护清单（调试中实际踩过的坑）

1. 完成判定只认终态（`sending` 非完成）——否则重试 sleep 期间批次提前结束；
2. 启动快照保持原引用（拷贝会令 `getQueueItems` 读到 pending 旧值）；
3. `failsByAccount/sendAttempts/spawnedIds` 批次入口全清——跨批次残留污染熔断判定；
4. `acquireAccount` 仅任务组（有 campaignId）走 await——dryRun 同步场景不被微任务挂起；
5. 重试分支恢复 `item.status="pending"`——否则下一轮被 `!== "pending"` 跳过；
6. `tripAccount` 遍历 activePlan 跨流摘除，只摘 pending（sending 中的组不误伤）；
7. 流内 `loopGen !== myGen` 检查——批次换代（stop/重启）后旧流立即退出。

## 4. 验证

| 层 | 结果 |
|---|---|
| 引擎回归（7 文件：send-auto-resume / send-state-hydrate / sender-block-circuit / send-pipeline / send-alloc / campaign / agent-campaign-tool） | 92/92 通过（含新增 S7 熔断语义、S8 多任务 append 并行） |
| 全量回归 | 68 files / 661 passed + 27 skipped，零失败 |
| tsc --noEmit | 零报错 |

### S7（熔断语义）要点
7 组轮换 2 账号、A 全 535 失败 → `failedCount=3`（只计真失败）、`sentCount=3`、A 名下 3 条 smtp_fail + 1 条 blocked、`consecutiveFails=3` 且 `circuitOpenAt` 非空、B 账号不受影响。

### S8（append 并行）要点
任务 A（campaignId cam-a，4 组）运行中 append 任务 B（cam-b，4 组）→ 8 组全 sent、同批次（batchId 一致）、B 组即时并入并行开流。

## 5. 已知边界与后续

- 账号并发闸上限 10 为常量，未做运行时配置化；如需动态调整，改 `MAX_ACTIVE_TASKS_PER_ACCOUNT` 或提升为 config。
- 熔断后重排依赖 campaign 扫描器（10min 周期）重新入队；如需更快恢复，可缩短扫描周期或增加事件驱动。
- `send_queue.error_kind` 未建索引；查询量上来后可加 `(status, error_kind)` 复合索引。
