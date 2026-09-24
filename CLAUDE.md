# 已知陷阱

- 邮件 HTML 中的 `file:`、Windows/Unix/UNC 本地绝对路径不得作为图片读取来源。富文本编辑器会将用户直接粘贴的图片转换为 `data:` URL；发送时再转为 CID 附件。遇到旧签名或 Word/Outlook 带入的本地路径，应提示重新粘贴图片，不能恢复“读取本机文件”的兼容逻辑。
- `runningBatch` 只用于发现异常退出时的中断批次。启动阶段不得自动发送；必须经用户确认后调用 `resumeQueue(batchId)`，并且只恢复该批次。
- 架构边界不能用字符串 `includes()` 扫描后声称已强制执行：注释、`require()` 和新增导入形态都会绕过它。统一使用 `npm run check`；临时例外必须登记在 `scripts/architecture-baseline.json` 并附到期日，不能用长期豁免掩盖层间依赖。
- AI 回查的“已保存”必须落到 `companies.backcheckData`，并由公司服务统一更新联系人分类；IPC 层只编排请求。否则页面虽显示成功，后续开发信却读不到回查结果，且持久化规则会在多个入口分叉。
