# 已知陷阱

- 邮件 HTML 中的 `file:`、Windows/Unix/UNC 本地绝对路径不得作为图片读取来源。富文本编辑器会将用户直接粘贴的图片转换为 `data:` URL；发送时再转为 CID 附件。遇到旧签名或 Word/Outlook 带入的本地路径，应提示重新粘贴图片，不能恢复“读取本机文件”的兼容逻辑。
- `runningBatch` 只用于发现异常退出时的中断批次。启动阶段不得自动发送；必须经用户确认后调用 `resumeQueue(batchId)`，并且只恢复该批次。
