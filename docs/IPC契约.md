# IPC 契约

## 全局搜索（0.9.0-alpha.1）

| 通道 | 参数 | 返回 | 约束 |
|---|---|---|---|
| `search:global` | `{ query: string, limit?: number }` | `Result<GlobalSearchData>` | 只读；query 最多 200 字；limit 为每组上限，默认 20，范围 1–50。按 email/note/contact 分组，结果含 kind/sourceId/contactId/title/snippet；达到上限时 truncated=true。 |

摘要中的 U+0001/U+0002 标记匹配词的起止，renderer 用安全的 React `<mark>` 展示，不执行 HTML。英文使用字面词前缀匹配（多个词 AND），中文使用 LIKE，`%`/`_` 作为字面字符转义。未缓存正文只能检索预览；结果链接跳至 `#/inbox?detail=id` 或已有客户详情深链。

`crm:listPipeline` / `crm:getDetail` 的联系人对象新增 `overdueDays/warnDays`，返回格式与原数组/详情结构兼容；`system:updateConfig` 增加 CRM 阈值校验与嵌套合并，不新增设置通道。

## 模型服务商档案

`ai:profileUpsert` 的档案参数增加可选 `wireApi: "chat_completions" | "responses"`；省略时新档案默认 Chat Completions，编辑旧档案保持原类型。`ai:endpointStatus` 的 `profiles` 和 `endpoint` 返回生效类型。`ai:profileTest` 按档案类型走对应 API，并继续返回 `{ success, data?: { ok, latencyMs, model, preview?, kind?, error? }, error? }`，不会返回密钥。通道名称不变。

## 发送中断批次

| 通道 | 参数 | 返回 | 约束 |
|---|---|---|---|
| `send:getInterruptedBatch` | 无 | `{ success, data: InterruptedBatchStatus \| null }` | 只读；返回原批次标识、开始时间、可恢复组数和收件人数。 |
| `send:resumeInterruptedBatch` | 无 | `{ success, data?, error? }` | 只恢复本机保存的中断批次。渲染端不能传入批次 ID，成功后清除中断标记。 |

`send:resumeQueue` 保持原有“恢复全部待发队列”的人工操作语义，不用于启动后中断恢复。
