# IPC 契约

## 发送中断批次

| 通道 | 参数 | 返回 | 约束 |
|---|---|---|---|
| `send:getInterruptedBatch` | 无 | `{ success, data: InterruptedBatchStatus \| null }` | 只读；返回原批次标识、开始时间、可恢复组数和收件人数。 |
| `send:resumeInterruptedBatch` | 无 | `{ success, data?, error? }` | 只恢复本机保存的中断批次。渲染端不能传入批次 ID，成功后清除中断标记。 |

`send:resumeQueue` 保持原有“恢复全部待发队列”的人工操作语义，不用于启动后中断恢复。
