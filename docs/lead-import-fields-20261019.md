# 线索导入字段与归属

状态：0.53.1-alpha.1 工作区已实现；仅隔离数据与 Electron 合成中心验证，未部署正式中心迁移。

管理员使用客户页“更多操作 → 导入”，上传 CSV / XLS / XLSX，或粘贴 Excel 数据。第一行为表头，一行一个联系人。只读取第一个工作表。无需客户编号，也无需提前建立公司表。

最终字段映射之外的非空列会由服务端自动生成联系人备注，格式为 `字段名：内容`，每个字段一行；`N/A`、`暂无`、空字符串等占位值忽略。备注写入 `contacts.extra.note`，在联系人详情只读显示、可参与联系人搜索并随联系人 CSV 导出；它不是新的可编辑业务字段，也不会被猜测成客户类型、来源、阶段或状态。单条备注最长 20,000 字符，超限时该行返回 `invalid`，不会静默截断。

## 完整匹配字段

下表与 `server/core/lead-import-fields.ts` 一致；列名忽略大小写、空格、下划线和连字符。多个别名列同时出现时不替用户任选，需要手动映射；一个业务字段只能映射一列。

| 归属 | 字段 | 可识别表头 |
| --- | --- | --- |
| 公司 | 公司名 | 公司名、公司、公司名称、公司全称、客户名称、company、companyName |
| 公司 | 国家 | 国家、所在国家、country |
| 公司 | 客户类型 | 客户类型、客户类别、联系人类型、类型、type、customerType、client_type、clienttype |
| 公司 | 业务类型 | 业务类型、品类、行业、分类、businessType、category、industry |
| 公司 | 网站 | 网站、网址、官网、website、url、domain |
| 联系人 | 联系人姓名 | 联系人姓名、姓名、联系人、contact、name |
| 联系人 | 名 | 名、firstname、first_name |
| 联系人 | 姓 | 姓、lastname、last_name |
| 联系人 | 职位 / Title | 职位、职务、联系人title、title、position |
| 联系人 | 电话 | 电话、手机、联系电话、phone、tel、mobile |
| 联系人 | WhatsApp | WhatsApp、Whats App、WA |
| 联系人 | 邮箱 | 邮箱、邮箱地址、电子邮箱、电子邮件、邮件、email、e-mail |
| 联系人 | LinkedIn | LinkedIn、领英、linkedinUrl |
| 联系人 | 一级来源 | 来源、线索来源、一级来源、来源一级、source、sourceLevel1、primarySource |
| 联系人 | 二级来源 | 二级来源、来源二级、sourceLevel2、secondarySource |
| 联系人 | 发送阶段 | 阶段、发送阶段、stage |
| 联系人 | 语言 | 语言、language |

客户类型只接受“代理 / 直客”；联系人显示和筛选保持原 `agent / direct` 协议，从公司分类推导。历史公司没有分类时兼容读取旧联系人分类，不根据历史员工资料猜测并批量改写公司。国家也以公司字段为准，历史公司为空时兼容旧联系人国家；公司国家和分类应在公司资料入口修改。

公司名必填；联系人姓名（含名/姓）、电话、WhatsApp、邮箱至少填写一种。邮箱有值时须格式有效。姓名与拆分名/姓并存时，拆分名/姓优先；原单元格仍保留。电话与 WhatsApp 可不同；各自为独立文本字段，不把同一单元格内多个号码自动拆成多个联系人。发送阶段属于原发送轮次，不是跟进关系阶段。

一级/二级来源描述本联系人的取得途径，例如“展会 / 上海展”和“网络 / LinkedIn”；同公司不同联系人可以不同。原 `source/source_detail` 仍追溯导入渠道和批次，不替代线索来源。

同一文件中的同公司资料冲突在提交前拦截。服务端还会核对已有公司字段：补空、不静默覆盖冲突，回执保留原始行。邮箱用于联系人去重；无邮箱时只在同一客户内完整联系方式相同才判重复。同名公司有多个候选时要求核对；名称不授予任何联系人访问权。管理员共享运营线索，销售自有线索仍按账号隔离。

## 实现与验证

- 字段词典：`server/core/lead-import-fields.ts`；原导入抽屉直接复用它。
- 平面导入：原 `ONLINE_CHANNELS.IMPORT`、`POST /api/crm/imports`；增加可选 `companyMatching` 与新行字段，无新增 IPC/HTTP 路径。
- 存储：公司分类 `companies.customer_type`，业务类型复用 `companies.industry`，网站复用 `companies.domain`；联系人新增 `whatsapp/source_level1/source_level2`。迁移 `030-lead-field-extension` 在现有 lead 迁移链末尾执行，历史迁移 checksum 不变。
- 公司字段不会通过联系人共享授权修改。WhatsApp 使用联系人字段权限，一级/二级来源仅完整管理权限可改。
- 隔离 PG：24 项通过、1 项十万容量检查未启用。覆盖生成公司、不同联系人来源、无邮箱、重试/重复、公司类型冲突、查询筛选、分配/共享和生命周期回滚。
- 定向单元/适配检查：62 项通过。实际 Electron：生产 renderer + preload + IPC + 合成 HTTP，粘贴/解析/匹配/导入成功，页面错误 0。
- 后续字段修正已同步更新旧界面测试：联系人表不恢复已取消的“线索来源”筛选；通过一级/二级来源列显示联系人的取得渠道。
- 未完成：正式服务应用迁移、正式账号验收、发布。既有部署候选包未重新打包，不包含本轮改动。

续作 checkpoint：`.work/lead-fields-checkpoint`（保留本轮续作起点，不代表所有历史混合修改的干净基线）。视觉证据：`.work/lead-import-desktop/import-guide.png`。无新增依赖。

## 联系人界面补齐（0.53.1-alpha.1，2026-10-19）

- 默认列表显示公司名、国家、客户类型、联系人姓名、职位 / Title、电话、WhatsApp、邮箱、一二级来源及原联系/客户/发送阶段；其他导入字段可在列设置中开启。旧列偏好保留，旧来源列迁移到一二级来源，批次来源单独可选。
- 详情中公司资料只读展示国家、客户类型、公司名、业务类型和网站；来源归联系人，系统信息单列导入批次来源。
- 手动新增分公司资料与联系人/线索来源，复用文件导入词典和公司匹配；不要求编号，邮箱非必填，但公司名及联系人姓名/电话/WhatsApp/邮箱之一必须存在。
- CSV补齐业务类型/网站，并把agent/direct显示为代理/直客，字段名与界面一致。

本轮验证：34项定向测试通过；一次性PostgreSQL实例10项通过、1项十万容量检查未启用；typecheck、server build、Electron build及架构检查通过。真实Electron生产renderer/preload/IPC加合成HTTP已验证列表、详情和无邮箱手动新增，页面错误0。截图在 `.work/contact-fields-desktop/`，checkpoint在 `.work/contact-fields-checkpoint/`。正式中心未迁移、未部署，安装包未更新。
