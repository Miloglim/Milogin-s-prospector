# Agent 深度辅助方案：客户回复自动洞察 → 首页建议 → 一键采用

> 状态：方案（待评审）｜ 目标版本：0.5.6-alpha 之后｜ 作者：MainAgent 评审
> 关联现状：toolkit 7 域 29 工具 / `inbox:newMail` 事件（InboxList.tsx:333-344，payload `{count, byClass}`）/
> `askAssistant(ctx: contact:id | message:id)` / `contacts.extra`（preferredPorts / crmNote / priceSensitivity /
> decisionRole / annualVolume）/ `rateUpdate:ports` 港口偏好派生（CrmPipeline.tsx:153-159）/
> 写入审批闸门（agent:resolveApproval）。

## 1. 目标（说人话）

现在 Agent 是"你问它才动"。这套方案让它**主动**起来：

- 客户回了邮件 → 程序自动读这封回信；
- 自动分析里面有没有"线索"：偏好港口、价格敏感度、决策角色、年货量、值得记的备注；
- 把分析结果做成首页一张建议卡，问用户："Daniela 提到 Santos 港、问 40HQ 价格 → 要不要更新她的偏好？"
- 用户点"采用"才写入客户资料；点"忽略"就丢掉。Agent 永远**只建议、不擅自改**。

## 2. 为什么必须"建议不直写"

1. LLM 会幻觉：邮件里没提的港口/数字可能被编出来，直接写库等于污染客户画像；
2. 客户资料（preferredPorts / priceSensitivity / decisionRole）是后续报价、运价推送、触达策略的依据，写错代价高；
3. 比赛合规评审会看"写操作有没有人闸"——延续现有审批闸门（agent:resolveApproval）的既有设计，架构统一。

## 3. 链路设计（4 段）

```
① 自动读取               ② 自动分析              ③ 首页建议卡          ④ 一键采用
inbox:newMail         reply-insight.service     /home 建议卡          "采用" → 写 contacts.extra
 事件(byClass)    →   取 replied 新邮件     →   展示：信号+原文摘要  →  "忽略" → 标记已读
 分类=replied        LLM 提取结构化信号          （支持跳转原文）       invalidate contacts/crm
                          ↓
                    草稿暂存（不进库）
```

### ① 自动读取（改动最小）

- 现状：`inbox:newMail` 只推 `{count, byClass}` 计数，不推具体邮件。
- 改动：`fetchInbox` 结束后，把本轮**新增的 replied 邮件**（id + fromEmail + subject + bodyPreview 摘要）随事件一起推，或新增一个只读通道 `inbox:repliedSince`（按时间拉最近 N 封 replied）。
- 建议走后者：事件只发"有 3 封新回复"信号，前端/后台服务再按需拉明细，避免事件包过大。

### ② 自动分析（新服务）

- 新文件 `src/main/services/agent/reply-insight.service.ts`：
  - 订阅 `inbox:newMail`（或由 fetchInbox 直接调用）；
  - 对每封 replied 邮件：取正文 → 调 AI 端点（复用现有 ai 通道/endpoint 配置，不新增密钥体系）→ 用**固定 JSON schema** 提取信号；
  - 信号 schema：
    ```ts
    interface ReplyInsight {
      preferredPorts?: string[];      // 提到的港口/航线
      priceSensitivity?: "low"|"mid"|"high"|null;  // 价格敏感度（有价格相关表达才算）
      decisionRole?: string | null;   // CEO/采购/物流负责人…
      annualVolume?: string | null;   // "每年 200 柜" 这类原话
      crmNote?: string;               // 值得记的一句话备注（≤200 字）
      confidence: "high"|"mid"|"low"; // 信号置信度，low 不生成建议卡
      sourceSnippet: string;          // 原文证据片段（建议卡展示，防幻觉）
    }
    ```
  - **草稿存储**：内存 Map + `data/` 下小 JSON（或复用 suggestion-state.json 模式），**不进 contacts 表**。键 `reply-insight:{contactId}:{messageId}` 幂等。
  - 防重复：同 messageId 只分析一次；低置信度/无信号直接丢弃不打扰。

### ③ 首页建议卡

- 复用现有首页建议卡机制（HomeCards / dev-letter 卡片同款视觉）。
- 新卡片源：queryKey `["home-insights"]`，IPC 通道 `agent:suggestions` 现有流可扩展，或加 `ai:replyInsights`（只读）。
- 卡片内容：联系人名 + 信号摘要 + 原文证据片段 + 两个按钮（采用 / 忽略）。
- 每条卡片可跳收件箱原文（`#/inbox?search=email`）。

### ④ 一键采用（写操作带确认）

- "采用" → 调 `contacts:upsert`（带 `extra` 合并字段）：`extra` 的 preferredPorts / priceSensitivity / decisionRole / annualVolume / crmNote 与现有值**合并而非覆盖**（用户已有的手动偏好优先）。
- 复用 `contacts:upsert`，无需新通道；成功 invalidate `["contacts"]` / `["crm"]` / `["dashboard"]`。
- "忽略" → 标记草稿已读，当天不再推同一条。

## 4. 与现有能力的关系（不重复造轮子）

| 现有能力 | 本方案怎么用 |
|---|---|
| `contacts.extra` 字段 | 采用时的写入目标（已有 schema） |
| `rateUpdate:ports` 港口偏好派生 | 分析出的港口可与"从来信推断"tab 同源展示、一键采用共用 |
| `askAssistant(ctx)` | 建议卡上可加"让 Agent 细说"→ 带 `message:{id}` 上下文进对话页 |
| 写入审批闸门 | 采用按钮本身即人闸；不引入新的无确认写入 |
| `inbox:newMail` | 触发源（只加信号，不改变事件结构） |

## 5. 分阶段落地（每阶段可独立验收）

- **P0（推荐先做）**：`inbox:repliedSince` 只读通道 + reply-insight.service 分析管道 + 草稿存储。产出：日志可见分析结果，无 UI。验收：发一封提到港口的测试回复，日志出现结构化信号。
- **P1**：首页建议卡 + 采用/忽略按钮。验收：卡片出现、采用后 extra 更新、忽略后不再打扰。
- **P2（可选）**：主动对话——建议卡上"问 Agent"直达对话页注入上下文（askAssistant 已有）。

## 6. 风险与边界

- **出网隐私**：邮件正文调 LLM 会出网。默认只分析"新增 replied 邮件"，正文只送摘要（≤2000 字符），完整正文不出网。
- **幻觉**：confidence 机制 + sourceSnippet 证据片段 + 人闸三重兜底；低置信度不生成卡片。
- **性能**：分析排队（每轮最多 5 封），不阻塞收信主流程（Promise 异步 + 失败静默）。
- **幂等**：messageId 唯一键，重复触发不重复分析/不重复出卡。

## 7. 评审点（请用户确认）

1. 分析触发：**只分析"已回复"邮件**，还是也分析首次来信（询盘）？建议先只做 replied。
2. 采用时的字段合并：**用户已有手动偏好优先**（默认不覆盖），还是"AI 信号覆盖旧值"？
3. P0 是否现在就做（涉及新 service + 新只读通道，约半天工作量）？
