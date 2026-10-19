# N4 原发送中心联系人接入

用户已纠正逐节点重复请批的执行方式，授权按既定计划连续推进；本轮完成N4，不改前端布局，不真实外发、推送或发布。执行使用superpowers:subagent-driven-development与TDD，各节点先checkpoint，最终独立复核及实际桌面验证。

Goal: 原发送名单、Campaign、快速发信和发送结果采用明确中心引用，复用原发送引擎。

Architecture: 中心PG为联系人和已确认互动权威；既有账号SQLite存发送任务、队列、已确认SMTP回执与正文。中心引用为contactId/customerId，旧本地编号保持隔离。使用center-send内部端口，不增加平行发送系统。

Scope: 原发送入口与模板/邮箱轮换/限额/暂停保持；发前在线GET校权及邮箱一致性，记录实际SMTP接受而非送达。中心同步失败只重传事实，不重发邮件。中心任务未知投递及中断sending不能自动转pending重试。旧Agent工具留N5、远程Worker留N7；既有本地Campaign继续本地执行，不称已上云。

Checkpoint: D:/Agent Basement/checkpoints/prospector-center-send-20261015，完整本轮前src/server/tests/docs/包版本及差异。

- [x] 1. 明确中心发送引用/作用域与内部端口，测试解析失败不退回同号旧库。
- [x] 2. 原发送引擎读端口、发前检查、真实回执保存；明确引用在序列化/恢复保持，未知结果不自动重发。原legacy路径仅兼容历史/未迁移工具。
- [x] 3. 原Campaign与选人器接授权名单，中心引用持久化，未选联系人/旧Campaign回调不能同号串写。
- [x] 4. 账号运行时绑定、原生SQLite原子回执与本地收件记录、待同步事件重放及原历史显示；中心邮件事件可选advanceSendStage仅confirmed outbound接受，事务去重推进轮次一次。
- [x] 5. 真实PG回滚、nativeSQLite/生产Electron、模拟SMTP全链路；断网/撤权/同号隔离/已发记录恢复/重复回执检查，类型/构建/回归/独立复核。
- [x] 6. 更新原架构/契约/版本/陷阱及交付与结构字典，知识同步，临时资料清理。

Ruling: 原发送服务已有IO作为存量兼容边界，新身份校验/本地回执IO放adapter，新内部端口不访问electron。未批准新增依赖不引入。已存在脏工作区及正式路由需要连续保留，使用完整checkpoint与隔离运行资料，不创建会遗漏未提交源码的分支副本。

验收：1331普通回归通过/154条件跳过，另真实PG2项、实际生产Electron11链路、219源码架构/类型/构建通过；独立审查P1/P2已修复。完整交付center-send-delivery-20261015.md、逐字段字典database-dictionary-20261015-n4.md。未真实发信、提交或发布，中心021已加载。
