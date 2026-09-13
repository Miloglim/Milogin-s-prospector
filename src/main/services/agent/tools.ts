// ── Agent Harness 工具层 · 装配 ─────────────────────────────────────
// 原 3074 行巨型文件已按域拆分到 toolkit/：本文件只保留注册元数据（name/description）与
// 审批闸门，工具实现见 toolkit/common.ts / contacts.ts / rates.ts / inbox.ts /
// send.ts / research.ts / meta.ts。拆分原则：execute 闭包提取为 execXxx(ctx, args)
// 独立导出函数，装配层只做 tool() 注册；公共辅助下沉 common.ts，禁止合并回本文件。
// 审批不在这里各写一份：write 类工具的 needsApproval 统一由 buildHarnessTools 返回处
// 按注册表派生（见本文件末尾闸门），execute 只在人工批准后才可能运行。
import { z } from "zod";
import { tool } from "@openai/agents";
import { requiresApprovalOf } from "./policy";
import type { ToolCtx } from "./types";

// 域实现（execute + schema）
import { execSearchContacts, execRecordFollowup, execDeleteContacts, execUpdateContact, execImportContacts } from "./toolkit/contacts";
import { execReadProgramConfig, execUpdateProgramConfig, execUpdatePlan, execExportArtifact, execStartBatchTask, execReportGap } from "./toolkit/meta";
import { execEmailReadFull, execInboxSearch, execEmailSummarize, execMailBrief } from "./toolkit/inbox";
import { execQuoteSearch, execRateUpdatePlan, execRateUpdateEnqueue } from "./toolkit/rates";
import { execMarketResearch, execCompanyBackcheck } from "./toolkit/research";
import { execGenerateDraft, execQueueStatus, execRemindersDue, execAccountsStatus, execListTemplates, execSendQueueAdd, execCampaignCreate, execCampaignStatus, execCampaignControl } from "./toolkit/send";
import { searchContactsSchema, recordFollowupSchema, deleteContactsSchema, updateContactSchema, importContactsSchema } from "./toolkit/contacts";
import { updateProgramConfigSchema, exportArtifactSchema, startBatchTaskSchema, reportGapSchema } from "./toolkit/meta";
import { updatePlanSchema } from "./toolkit/common";
import { emailReadFullSchema, inboxSearchSchema, emailSummarizeSchema } from "./toolkit/inbox";
import { quoteSearchSchema, rateUpdatePlanSchema, rateUpdateEnqueueSchema } from "./toolkit/rates";
import { marketResearchSchema, companyBackcheckSchema } from "./toolkit/research";
import { generateDraftSchema, listTemplatesSchema, sendQueueAddSchema, campaignCreateSchema, campaignStatusSchema, campaignControlSchema } from "./toolkit/send";

// ── 向后兼容的公共导出（外部模块与单测仍从 tools.ts 取这些符号）────────
// 注意：类型/接口必须走 export type（rollup 打包时 interface 会被擦除，
// 混在值导出里会报 "is not exported"，tsc 却放行——两类分开写）
export { MAX_CONSECUTIVE_FAILURES, IMPORT_HEADER, buildImportTsv,
  isToolRuntimeError, isEnvelopeFailure, noteToolOutcome, beijingTime, splitRoute,
  mirrorCompareForPod, isNoneish, normalizePlan, updatePlanSchema,
  auditRejected, programConfigSnapshot, applyConfigPatch } from "./toolkit/common";
export type { ImportContactInput, PlanState, PlanItem, ToolCtx } from "./toolkit/common";
export { searchContactsSchema, recordFollowupSchema, deleteContactsSchema,
  updateContactSchema, importContactsSchema } from "./toolkit/contacts";
export type { ResolvedContact } from "./toolkit/contacts";
export { quoteSearchSchema, rateUpdatePlanSchema, rateUpdateEnqueueSchema } from "./toolkit/rates";
export { inboxSearchSchema, emailSummarizeSchema, emailReadFullSchema } from "./toolkit/inbox";
export { generateDraftSchema, sendQueueAddSchema, campaignCreateSchema, campaignControlSchema,
  listTemplatesSchema, campaignStatusSchema } from "./toolkit/send";
export { marketResearchSchema, companyBackcheckSchema } from "./toolkit/research";
export { exportArtifactSchema, startBatchTaskSchema, updateProgramConfigSchema, reportGapSchema } from "./toolkit/meta";

export function buildHarnessTools(ctx: ToolCtx) {
  // 工具实现由各域 execXxx 承担（从 toolkit 导入）；注册元数据与执行器解耦，
  // 需要改某个工具的行为只动对应域文件，本文件不再承载业务逻辑。

  const searchContacts = tool({
    name: "search_contacts",
    description: "在本地联系人库检索/筛选联系人，返回结构化记录（含 id/姓名/邮箱/公司/国家/阶段/发送状态）。两种用法：①按关键词（姓名/邮箱/公司名）找人；②按结构化条件圈人——country 国家(中英文都认，如 巴西/Brazil)、stage 阶段(cold/f1-f4)、status 发送状态(reached=已触达/replied=已回复/bounced=退信/none=未触达)、industry 行业、silenceDays 沉默天数、validEmail 仅有效邮箱、hasPhone 仅有电话，可组合。冷开发/批量跟进要用②按前置条件精确圈人（如「巴西的冷客户」=country:巴西 + stage:cold），别用单字母关键词全库扫。涉及客户的事实性回答必须且只能基于本工具返回的数据。绝对不要用本工具查运价、邮件或公司公开背景（那是 quote_search / inbox_search / company_backcheck）。",
    parameters: searchContactsSchema,
    execute: (args) => execSearchContacts(ctx, args),
  });
  const recordFollowup = tool({
    name: "record_followup",
    description: "为指定联系人记录一条跟进备注。只用于「把刚发生的事写进这个人的跟进历史」；绝对不要用本工具改客户阶段（那要在 CRM 里操作）、不要用它写开发信正文、也不要拿它代替用户确认发信。写操作，执行前会请求人工确认；被拒绝则放弃。",
    parameters: recordFollowupSchema,
    execute: (args) => execRecordFollowup(ctx, args),
  });
  const deleteContacts = tool({
    name: "delete_contacts",
    description: "删除联系人（可按邮箱后缀批量，如清理 no.email 占位地址）。破坏性操作：往来记录一并删除、收件箱邮件保留但解除关联、无联系人的空壳公司自动清理，**删除不可恢复**。执行前必须弹出人工确认，确认卡上会列命中名单样例；建议用户先在客户页导出备份。单次上限 500 人，超出拒绝并提示分批。查命中多少但暂不删 → 用 search_contacts；本工具只在用户明确说「删除」时调用。",
    parameters: deleteContactsSchema,
    execute: (args) => execDeleteContacts(ctx, args),
  });
  const readProgramConfig = tool({
    name: "read_program_config",
    description: "读取程序当前运行配置：发信时段/组间暂停/每组人数、日限额、测试模式、身份档案、CRM 跟进天数、发信账号清单、生效端点（不含任何密钥）。用户问「程序怎么配的/为什么这个点不发/限额多少」时必须先调本工具，禁止凭印象回答。要改配置用 update_program_config。",
    parameters: z.object({}),
    execute: (args) => execReadProgramConfig(ctx, args),
  });
  const updateProgramConfig = tool({
    name: "update_program_config",
    description: "修改程序配置（写操作，执行前一律弹人工确认）。domain 取 schedule/quota/test/crm/identity；kvs 为多行 key=value（如 \"startHour=9\\nendHour=18\"）。字段白名单：schedule=timeWindowEnabled/startHour/endHour/groupSize/groupDelayMinSeconds/groupDelayMaxSeconds；quota=dailyLimit；test=enabled/dryRun/email/company；crm=followupDays.<阶段>/todoAdvanceDays/autoArchiveDays；identity=fromName（公司身份恒定不可改）。端点/密钥/检索源不在本工具射程——用户要改那些，引导去设置页。先 read_program_config 拿现值，只传要改的键；确认被拒则如实告知未改。",
    parameters: updateProgramConfigSchema,
    execute: (args) => execUpdateProgramConfig(ctx, args),
  });
  const updateContact = tool({
    name: "update_contact",
    description: "更新一位联系人的档案字段（写操作，需确认）。可改：title/phone/country/clientType(agent|direct)/tags(逗号分隔)/preference(偏好备注，追加进 extra.preferences 数组)。定位用 contactId 或 contact（邮箱/姓名/公司名）。不改 status/stage（状态由收信与 CRM 管）。从邮件里读到的客户偏好（语种/航线/柜型习惯）应落到 preference，别只写跟进流水。",
    parameters: updateContactSchema,
    execute: (args) => execUpdateContact(ctx, args),
  });
  const emailReadFull = tool({
    name: "email_read_full",
    description: "按 messageId 读取一封邮件的完整信息：全文正文（本地没有会自动走 IMAP 懒加载）、发件人/收件人/抄送、时间、分类、意图、附件文件名。两种必用场景：①用户要「原文/全文/完整内容」；②上下文邮件注记标了「仅为预览/前段」时，总结或起草回复前必须先读本工具拿全文——预览不是全文，凭它作答就是编造。读全文不需要征求用户同意，直接读；只要摘要用 email_summarize。正文超长会截断并标注。",
    parameters: emailReadFullSchema,
    execute: (args) => execEmailReadFull(ctx, args),
  });
  const quoteSearch = tool({
    name: "quote_search",
    description: "查询本地海运运价镜像库（真源 = 局域网台账 board_server；启动 5 秒后与每 4 小时全量刷新镜像）。绝对不要用它回答客户、联系人、邮件内容或公司背景问题（那是 search_contacts / inbox_search / company_backcheck 的事）。用户给了一个词就原样传 q（不必判断它是航线名还是港口名，工具会跨字段比对）；所有参数均可省略，省略的条件视为不限。用户问题里提到起运港时必须传 pol（如「蛇口到santos」→ q=santos、pod=SANTOS、pol=蛇口）——漏传会把其他起运港的价混进结果；工具检测到漏传会指令你带 pol 重查，照做，但不要依赖这个兜底。没命中时按返回的 notice 指引走：第一轮先照 candidates 换词重试一次，两轮都没命中才按 notice 给的口径回答——「本地镜像查不到」与「该航线没有报价」是两件事，不得混说，更不得编造价格。每次查价都会同批附带该航线/港口最近 21 天的舱位动态（spaces / spaceTable）：回答必须价在前、舱位在后，舱位照表里的原值说并注明以订舱时确认为准。返回 目的港/船司/柜型/USD价/有效期/备注 结构化列表，按价格升序。运价相关问题必须且只能基于本工具结果回答；结果为参考价，回答时须提醒以船司实时报价为准。",
    parameters: quoteSearchSchema,
    execute: (args) => execQuoteSearch(ctx, args),
  });
  const marketResearch = tool({
    name: "market_research",
    description: "联网调研某航线的公开市场行情：多源检索 → 逐页核实 → 交叉核对分级 → 产出带来源链接与日期的报告（不自动落盘，用户点「保存调研报告」才写文件）。用户问「某航线现在什么行情 / 外面报多少 / 最近有没有新船期 / 我们这个价在市场算什么水平」时用本工具；查自己台账里的价用 quote_search。缺起运港或目的港时只追问这两项（其余可默认）。一次调用就跑完整套流程，不要换措辞连续调用；查不到可核实来源时它会如实给缺口，绝不编数字。",
    parameters: marketResearchSchema,
    execute: (args) => execMarketResearch(ctx, args),
  });
  const inboxSearch = tool({
    name: "inbox_search",
    description: "检索本地收件箱邮件（发件人/主题/正文摘要关键词，可按系统分类与未读过滤），返回 发件人/主题/分类/时间/id 列表。用户问「今天有什么新邮件/询盘/退信」「谁给我发过…」时使用本工具；要总结某封邮件先用本工具拿 id。",
    parameters: inboxSearchSchema,
    execute: (args) => execInboxSearch(ctx, args),
  });
  const emailSummarize = tool({
    name: "email_summarize",
    description: "总结一封收件箱邮件并给出下一步跟进建议（输入是一封邮件；绝对不要拿它做客户档案查询或整库统计）。（内部调用 LLM 生成 一句话总结 + nextStep）。先 inbox_search 拿到邮件 id 再调用本工具。",
    parameters: emailSummarizeSchema,
    execute: (args) => execEmailSummarize(ctx, args),
  });
  const companyBackcheck = tool({
    name: "company_backcheck",
    description: "对一家公司做公开网络背调并生成结构化报告（外部公开资料；库里已有的客户事实一律用 search_contacts，不要用本工具去佐证库内数据）。（一句话总结/进口活跃度/主营品类/货代契合点/风险/评分/来源链接）。数据来自 Exa/Tavily 网络搜索，非本地库。用户问「XX公司什么背景/值得开发吗」时使用。",
    parameters: companyBackcheckSchema,
    execute: (args) => execCompanyBackcheck(ctx, args),
  });
  const generateDraft = tool({
    name: "generate_draft",
    description: "生成一封开发信/跟进信/回信的草稿（带 SUBJECT: 主题行 + 正文，支持 EN/ES/PT）。本工具只产出文本、不发送；用户可用结果卡按钮一键存素材库或入队。用户要「回复某封邮件」时必须传 messageId（来自 inbox_search 或上下文邮件锚点「邮件 #N」）走回信模式——草稿会针对对方来信逐条应答，收件人自动从来信解析，无需 contact/contactId；有邮件锚点时绝不允许退回 contact/company 模式凭摘要或预览写（那等于替对方编话）；这时不要先 email_read_full 搬运原文（工具自己会读）。开发信/跟进信不传 messageId：写什么由你从对话与上下文里已有的材料决定，绝对不要为了『起草邮件』先去调 company_backcheck 或其他检索工具（那是跑题）；上下文中没有的关键数字（如成交价、柜型）用 {{占位}} 标出并在结尾一句话提示，不要连环追问。边界：只用于给客户写开发信/跟进信/回信；寒暄、自我介绍、翻译、改写一段现成文字都不要调本工具。开发信模式已知收件人 contactId 时才带上它（结果卡才会出现「入队」按钮）。",
    parameters: generateDraftSchema,
    execute: (args) => execGenerateDraft(ctx, args),
  });
  const queueStatus = tool({
    name: "queue_status",
    description: "查询发信引擎与队列实时状态：是否运行中/已暂停、总组数、已发组数、失败组数、待发的组数与收件人数。用户问「还有多少没发出去」「发送进度」「队列是不是卡住了」时使用。",
    parameters: z.object({}),
    execute: (args) => execQueueStatus(ctx, args),
  });
  const remindersDue = tool({
    name: "reminders_due",
    description: "查询到期与已逾期的跟进提醒（CRM 今日待跟进清单）。只回答「今天/最近该跟进谁」这类清单问题；要看某个人具体资料请用 search_contacts。，返回联系人 id/姓名/公司/提醒时间/跟进备注。用户问「今天该跟进谁」「有哪些到期提醒」「哪些客户 overdue 了」时必须先调用本工具。",
    parameters: z.object({}),
    execute: (args) => execRemindersDue(ctx, args),
  });
  const accountsStatus = tool({
    name: "accounts_status",
    description: "查询发信/收信账号的配置与健康状态：总数、启用数、健康数（无熔断且无连续失败），以及每个异常账号的具体问题（停用/发信熔断/连续失败次数/最近收信错误）。用户问「几个账号能用」「账号有没有问题」「哪个账号挂了」时使用。",
    parameters: z.object({}),
    execute: (args) => execAccountsStatus(ctx, args),
  });
  const listTemplatesTool = tool({
    name: "list_templates",
    description: "列出素材库邮件模板（名称/语言/主题/正文预览，只读）。批量发信用户说「用系统内置模板」「用现成模板」时先调它挑一条，再把选中模板的 subject/body 原样传给 send_queue_add（{{}} 变量照留，系统会按联系人替换）。素材库为空/无启用模板时不是死路：send_queue_add 传 usePreset=true 走程序内置句库（按联系人阶段/语言自动组装）。",
    parameters: listTemplatesSchema,
    execute: (args) => execListTemplates(ctx, args),
  });
  const sendQueueAdd = tool({
    name: "send_queue_add",
    description: "把邮件加入发送队列（只入队不发送：队列建好处于未启动状态，用户仍需在「发送中心」手动点「开始」才真正外发）。发信交互规则——用户提到发信时，只在没说清的情况下用一句话问「单独发还是批量发」，然后：【单独发】详细配置：收件人（contact/contactIds，工具自己定位，不必先 search_contacts）+ 内容（可先 generate_draft 起草给用户过目，认可后入队）。【批量发】不要追问发件账号/发件人身份/语言（账号由系统按健康度与日配额自动轮换），流程三步走完：① search_contacts 圈定收件人（筛选条件有歧义才问一句，如「只发巴西还是全部 cold？」，把命中数报给用户）；② 内容：用户说用系统/现成模板 → 先 list_templates 挑一条、subject/body 原样传入（{{}} 变量照留）；用户没说 → 生成一版草稿给用户过目后再入队；③ 直接调本工具入队，contactIds 一次最多 2000。系统随后会弹人工确认框，那一步就是征求同意，不要只在正文里问「要不要发」而不调用本工具。主题与正文可含 {{company}}/{{firstName}}/{{lastName}} 变量。素材库没有启用中的模板 → 传 usePreset=true 用程序内置句库组装（无需 subject/body），这就是「系统内置模板」路径。",
    parameters: sendQueueAddSchema,
    execute: (args) => execSendQueueAdd(ctx, args),
  });
  const updatePlan = tool({
    name: "update_plan",
    description: "更新界面上展示的任务清单卡，让用户看到多步任务进行到了哪一步。只在任务确实需要 3 步以上时调用（例如「把这几家都背调一遍，各自写一封开发信」「今天该跟进谁，逐个记一条跟进」）：开工前先给一份全 pending 的清单；此后每做完一步再调用一次，把全部步骤重发一遍（已完成的标 done、正在做的标 doing），不要只发增量。单步问答、简单查询一律不要调用本工具。本工具只更新界面清单，不读写任何业务数据。",
    parameters: updatePlanSchema,
    execute: (args) => execUpdatePlan(ctx, args),
  });
  const exportArtifact = tool({
    name: "export_artifact",
    description: "把整理好的内容导出成文件给用户带走（落盘到 outputs/agent，对话里出现文件卡，可「打开位置」「复制路径」）。**仅当用户明确要求「导出/生成文件/存成文件」时才调用**——对话里能直接交付的内容（如贴在正文里的表格）一律不落盘；不确定用户要不要文件时，先在对话里给出内容并问一句，不要直接生成。确要导出时完整内容写进文件，不要在回答正文里再贴一遍全文。md 格式用 content 传 Markdown 正文；csv 格式把表格写成 content 里的多行 TSV 文本（首行表头，每行一条记录，字段间用制表符分隔）。参数只有这三个扁平字段，越简单越不容易写坏 JSON。本工具只写产物目录，不碰任何业务数据。",
    parameters: exportArtifactSchema,
    execute: (args) => execExportArtifact(ctx, args),
  });
  const importContactsTool = tool({
    name: "import_contacts",
    description: "把用户提供的客户信息批量导入本地联系人库。用户粘贴任意格式（名单/表格/邮件签名/一段话）时，先把每条整理成 contacts（姓名/邮箱/公司/国家/职位/电话/阶段/备注）再调用本工具；绝不要反问用户「用 CSV 还是 JSON」。邮箱是去重与写入的键：无效邮箱跳过、库里已存在的邮箱不会被覆盖（只提示疑似已存在）。写操作，执行前请用户确认；被拒绝则不写。完成后给一句结论并询问是否按公司/国家汇总、或挑几位进开发信。",
    parameters: importContactsSchema,
    execute: (args) => execImportContacts(ctx, args),
  });
  const startBatchTask = tool({
    name: "start_batch_task",
    description: "把批量活起成后台任务（对话里出进度卡、逐项推进、可随时取消、不阻塞对话）。三种 kind：backcheck=批量背调（≥3 家）、draft=批量开发信草稿（≥3 家）、email_summary=批量邮件总结（≥3 封，传 messageIds）。凡是要总结多封邮件，一律用本工具（传 messageIds，来自 inbox_search），绝不要用 email_summarize 一封封循环（那会撞每轮调用次数上限、只能做几封）。单封才用 email_summarize，单家才用 company_backcheck / generate_draft。上限：公司 10 家、邮件 60 封；完成后自动生成文件产物。只搜索与生成文本，绝不发送任何邮件。",
    parameters: startBatchTaskSchema,
    execute: (args) => execStartBatchTask(ctx, args),
  });
  const reportGap = tool({
    name: "report_gap",
    description: "登记一条「客户端目前做不到」的能力缺口（开发期需求台账）。触发时机：用户想要的操作在当前工具清单里不存在（例如把人推荐的新联系人加入联系人库、修改客户阶段等），你必须先如实说明做不到并给出绕行办法，然后调用本工具记一笔：wanted=用户想做而做不了的事（一句话）、scene=当时在办的事、workaround=你给出的替代路径。绕行办法只允许描述真实存在的功能（本程序的页面与工具）或「稍后人工处理」，严禁发明本产品没有的系统、页面或功能。同一回合同类缺口只记一次；这只是台账读写，不执行任何业务操作。",
    parameters: reportGapSchema,
    execute: (args) => execReportGap(ctx, args),
  });
  const campaignCreate = tool({
    name: "campaign_create",
    description: "创建发信任务：对一批联系人按触点计划自动跟进——首信发出后隔 N 天自动发下一轮，客户回复/退订/bounce 自动止损，计划走完自动收尾。流程：先 search_contacts 按结构化筛选圈人 → 把命中 id 传给 contactIds → 本工具出预览与确认卡，用户点确认才建档。内容来源：默认用户模板库（机械变量替换），也可 mode=adaptive 同阶段模板随机轮换、mode=system 用内置句库、mode=fixed 传定死内容。schedule 可设发送时段与单日上限（定时器式周期发送，超出顺延次日）。单封/临时批量发信不要用本工具（那是 send_queue_add）。",
    parameters: campaignCreateSchema,
    execute: (args) => execCampaignCreate(ctx, args),
  });
  const campaignStatus = tool({
    name: "campaign_status",
    description: "查询发信任务进度：不带参=全部任务概览（状态/各轮已发/回复/待发/止损计数）；带 campaignId=单任务名单明细。用户问「任务怎么样了」「发了多少、几个回了」用。",
    parameters: campaignStatusSchema,
    execute: (args) => execCampaignStatus(ctx, args),
  });
  const campaignControl = tool({
    name: "campaign_control",
    description: "控制发信任务：pause=暂停（不再排新触点，在途批次照常）；resume=恢复；stop=终止（终态，待发触点全部清空，不可恢复）；restart=已完结任务再启动新周期（退信/退订保持终态，其余触点重置重发；固定内容轮需先编辑补新内容）。用户说「先停一下那个任务」「恢复跑」「这个任务再来一轮」时用。",
    parameters: campaignControlSchema,
    execute: (args) => execCampaignControl(ctx, args),
  });
  const rateUpdatePlan = tool({
    name: "rate_update_plan",
    description: "给客户做定向运价更新：一次调用算完「圈了谁、各自走哪个港、该港当期真价、邮件长什么样」，返回按目的港+语言分好的方案（每组=一封将要发出去的邮件）。用户说「给跟进的客户更新运价」「把新价同步给客户」时用；范围有两层：默认=跟进看板的客户（已触达+已回复）；用户说「所有巴西客户」「冷客户也一起发」时传 scope=contacts + country，**不要**改用 search_contacts 自己拼名单再逐家 quote_search（必漏人、价格也会拼错）。客户没登记港口偏好时，工具会按他所在国家当期报价最多的港兜底；再不行才列入未覆盖。参数什么都不传是最稳的用法（除非用户明确缩小范围）。本工具只读：不写库、不入队、不发送；出方案后把数字讲给用户听，等他点头再调 rate_update_enqueue。价格全部来自本地运价镜像台账，无当期有效价的港口自动不入选，绝不编价、不拿别的港凑数。",
    parameters: rateUpdatePlanSchema,
    execute: (args) => execRateUpdatePlan(ctx, args),
  });
  const mailBrief = tool({
    name: "mail_brief",
    description: "今日邮箱概览（主进程确定性统计，只读快照，不调模型也不改任何状态）：北京时间今天的来信数、未读、客户回复/询价/退信/自动回复分类计数、我方今日发出数，以及「等你回复」清单（今日客户回复且其后再无发往该邮箱的，按已等小时排序）。用户问「今天邮件怎么样」「有没有询盘」「谁还没回」必查它——不要拿 inbox_search 拉一页再自己数分类和时区。",
    parameters: z.object({}),
    execute: (args) => execMailBrief(ctx, args),
  });
  const rateUpdateEnqueue = tool({
    name: "rate_update_enqueue",
    description: "把 rate_update_plan 生成的运价更新方案加入发送队列（写，需确认）。只入队、绝不发送：队列建好处于未启动状态，用户仍要在「发送中心」手动点开始。必须先有方案（planId 来自 rate_update_plan，30 分钟内有效且一次性）；不要为了入队重新拼正文——预览即执行对象，方案里的邮件是什么就发什么。",
    parameters: rateUpdateEnqueueSchema,
    execute: (args) => execRateUpdateEnqueue(ctx, args),
  });

  // ── 审批闸门（唯一收口）────────────────────────────────────────────
  // needsApproval 一律由注册表派生：登记为 sideEffect:"write" 就必须人工确认。
  // 各工具不再自己写一份——漏写不再是「静默执行」的成因（export_artifact 曾把注册表
  // 改成 write/需审批却没接 needsApproval，元数据与真实行为脱节、测试还全绿）。
  // 闸门只向上加严：只可能把 needsApproval 置真，绝不把任何工具置成免审批。
  // 关键：SDK 的 tool() 会把 needsApproval 归一成「函数」，运行时 toolExecution 无条件
  // `await tool.needsApproval(ctx,args,callId)` 当函数调；这里若覆盖成布尔 true，就会
  // `true(...)` → TypeError: needsApproval is not a function，凡调到 write 工具的回合直接崩。
  // 所以必须赋一个返回 true 的函数，而不是布尔。结构锁见 tests/unit/agent-approval-gate.test.ts。
  const tools = [
    searchContacts, recordFollowup, deleteContacts, readProgramConfig, updateProgramConfig, updateContact, emailReadFull, quoteSearch, marketResearch, inboxSearch, emailSummarize, companyBackcheck, generateDraft, queueStatus, remindersDue, accountsStatus, listTemplatesTool, sendQueueAdd, updatePlan, exportArtifact, importContactsTool, startBatchTask, reportGap, campaignCreate, campaignStatus, campaignControl, rateUpdatePlan, mailBrief, rateUpdateEnqueue,
  ];
  for (const t of tools) {
    const name = (t as unknown as { name?: string }).name ?? "";
    if (requiresApprovalOf(name)) (t as unknown as { needsApproval?: unknown }).needsApproval = async () => true;
  }
  return tools;
}
