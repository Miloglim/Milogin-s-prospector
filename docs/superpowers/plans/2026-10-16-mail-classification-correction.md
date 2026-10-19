# 邮件分类更正同步

用户2026-10-16批准。保持原界面，修正既有分类链路；不含迟到SMTP撤权归档、N6通用离线字段编辑、真实外发或发布。

1. 契约先行：既有contact-mail-events增加可选correction={previousEventKey:string|null,classification:'other'|'replied'|'autoreply'|'bounced'}；只用于inbound，禁止advanceSendStage。输出可选correctionRevision由中心生成。不改原事件发生时间或历史事实。
2. 中心加法迁移024：现有事件表增加classification_correction和classification_revision，按操作者/邮箱/消息/联系人流串联更正。当前联系人行锁内复核前驱，重复同键回执幂等，错误前驱报冲突。没有更正时保持旧摘要路径；有更正时从每条邮件当前有效分类与独立人工跟进重新计算状态，排除旧邮件活动的重复贡献，保留活动历史及发送轮次。
3. 本地保留原inbox:classify入口，持久保存分类改动标识，沿既有邮件事件队列上传。每次更正产生新键，普通重扫不重复产生更正；原邮件分类/时间不被异步旧结果覆盖。改为其他、退信原关联、断网重启、账号隔离均覆盖。跨设备旧前驱报冲突，不能自动覆盖。
4. 先写失败回归，再实现；隔离中心PG、真实Electron/原收件界面及双角色同步验收。每节点checkpoint，迁本机测试库前备份；正式库不动。更新架构、契约、字段、版本和知识库，交付说明未解决边界。

Checkpoint：D:/Agent Basement/checkpoints/prospector-mail-correction-20261016。

2026-10-16实施完成：以上四项已落地并在本机验收，024已备份部署至55844测试中心。最终1475普通回归、205隔离中心与10条真实桌面链路通过；详情、字段及未决边界见[交付记录](../../mail-classification-correction-delivery-20261016.md)。无真实外发、正式部署、推送或发布。跨设备冲突人工处理界面与迟到SMTP撤权归档不在本节点完成范围。
