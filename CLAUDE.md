# 已知陷阱

- Windows 无符号链接权限时，electron-builder 的 `winCodeSign` 工具缓存解压可能因 macOS 链接失败。内部无签名构建可在已有 `npm run build` 后运行 `npx electron-builder --win --publish never --config.win.signAndEditExecutable=false`；现有 afterPack 图标钩子仍执行。此参数也跳过 builder 的主 EXE 版本资源编辑；应用版本以包内 package.json 为准。不要为了内部分发购买证书或提升整套构建权限。

- 签名引用边界不能只识别英文 `From:`：葡萄牙语/西班牙语 `De:` 与 `Enviada em:` / `Enviado el:` 会让历史我方签名串入客户公司。先截断当前邮件，再识别落款；HTML 空行不得消耗签名行数。多个电话、双语公司仍按歧义拒识，不任意选第一项。合成样本通过不能代替真实邮件校验。

- 阶段/提醒设置事件不是实际跟进。写活动流后必须在列表和详情的最近跟进查询中排除，且保留首次已知的阶段兜底时间，否则切阶段会把逾期清零。详情时间线有类型白名单，新增 stage 不能只写数据库。
- 收信协议适配器返回的新邮件对象可能使用 id=0；后台处理必须按账号与 Message-ID 找真实行，不能读 `bodies/0.html`。签名只属于实际发件人，不能把抄送/退信正文中的第三人签名填进匹配档案。
- FTS5 触发器依赖连接注册的 `search_latin`；回退到旧代码前必须移除搜索触发器/虚拟表并删除迁移记录。未缓存的正文不能宣称可全文检索；修改主题/匹配关系不能把已经索引的全文降回预览。
- 查询页面保活时，收信只失效 inbox 或发信只失效发送列表会留下 CRM 旧数据。写操作统一通过 `cacheDeps.ts`，既有业务事件在 App 层监听，不能依赖某个页面已经打开。
- 历史运价测试的“当前有效”取决于运行日期；固定样例必须固定测试时钟，不能为通过测试修改真实过期判定。

- 供应商给 Codex 的 `wire_api = "responses"` 配置不能直接当作本程序的 Chat Completions Base URL。网关根路径可能对 `/chat/completions` 返回 HTTP 200 的 HTML 首页；必须检查响应类型，不能把无正文的 maxTurns 当成成功并反复提示「继续」。

- 官方 OpenAI GPT-5.6 Luna 的 Chat Completions 请求不要带 `temperature` 或 `max_tokens`；使用 `max_completion_tokens`，并按任务设置 `reasoning_effort`。连接测试、轻任务、一次性解析和 Agent 会话都要同步更新，不能只改设置页的模型模板。

- 邮件 HTML 中的 `file:`、Windows/Unix/UNC 本地绝对路径不得作为图片读取来源。富文本编辑器会将用户直接粘贴的图片转换为 `data:` URL；发送时再转为 CID 附件。遇到旧签名或 Word/Outlook 带入的本地路径，应提示重新粘贴图片，不能恢复“读取本机文件”的兼容逻辑。
- `runningBatch` 只用于发现异常退出时的中断批次。启动阶段不得自动发送；必须经用户确认后调用 `resumeQueue(batchId)`，并且只恢复该批次。
- 架构边界不能用字符串 `includes()` 扫描后声称已强制执行：注释、`require()` 和新增导入形态都会绕过它。统一使用 `npm run check`；临时例外必须登记在 `scripts/architecture-baseline.json` 并附到期日，不能用长期豁免掩盖层间依赖。
- AI 回查的“已保存”必须落到 `companies.backcheckData`，并由公司服务统一更新联系人分类；IPC 层只编排请求。否则页面虽显示成功，后续开发信却读不到回查结果，且持久化规则会在多个入口分叉。
- 收件箱手动抓取后的退信补匹配、正文预热和 Sent 探测是收件箱用例的一部分，必须由服务层编排；IPC 只注入协议适配器并转发通道。否则不同抓取入口会遗漏后台补齐步骤。
- 发信 IPC 不得重新持有 SMTP 连接或查询账号表。SMTP 行为在 adapters/smtp.adapter.ts，测试发信与队列发信共用 setSendBccFn；迁移时必须验证 TLS、To/BCC、CID 本地路径拒绝和断线重连。
- 邮箱账号验证跨主进程/渲染进程返回 `imapConfigured` 时，旧主进程不会返回该字段；字段缺席不能解释为“未配置收信”。测试提示要结合已保存账号的 `imapHost` 兼容旧契约，SMTP 单独成功不能标成 SMTP+IMAP 均正常；编辑账号后需核对 IMAP 地址落库及列表回显。
- 运价台账当前只在局域网 8795 服务；旧 8788 与公网镜像均不能作为现行源。局域网 HTTP 同步必须直连，通用 netFetch 可能走系统代理导致内网不可达。统一记录的价格列是 `price_usd`，旧映射只读 `freight_usd` 会把有效价格导成空值；同步失败须保留旧镜像。

- Electron 自定义标题栏在最上方且层级高于 Ant Design Drawer。运价详情抽屉若仍从 viewport 顶部定位，标题和关闭按钮会被盖住；Drawer 的 rootStyle 顶部与高度须跟随 `--app-titlebar-height`，并与 AppLayout 标题栏使用同一变量。
