# CRM 核心 CP1 交付记录

日期：2026-10-30
状态：代码已实现；隔离数据库和真实 Electron 合成验收已通过；本机开发中心尚未执行 055/056 迁移

## 范围

- 建立 canonical 组织模型：`crm_org_units`、`crm_org_assignments`、`crm_org_invitations`、`crm_org_idempotency` 和成员展示分组。
- 节点类型为公司、运营组、销售团队；销售团队是叶子，运营组不能混入普通成员。
- 普通销售最多归属一个销售团队；负责人可管理多个团队；同一组织单元最多一个 primary leader。
- 超级管理员共享公司根，不写入普通成员关系；运营管理员共享运营治理范围。
- 组织创建、负责人选择、移动、换负责人、增删成员、分组维护和过期邀请均接通 HTTP、IPC 和团队页。
- 部署 bootstrap 已同步 canonical 表与触发器；split/rollback/programmable 模板已覆盖 canonical 对象。
- 开发 mock 脚本已改为 canonical 组织表，不再写旧 `crm_team*` 表。

## 验证

- `npm run typecheck`、`npm run crm:pg:build`、`npm run build` 通过。
- 隔离 PostgreSQL 11 项通过：迁移重跑/失败回滚、父子顺序、循环和叶子拒绝、成员与负责人互斥、唯一负责人、邀请过期、双超管、多运营管理员、候选负向矩阵、幂等重放、成员总数和展示分组。
- 组织/API/渲染定向测试通过；团队邀请、成员计数、分组展示和未知结果重试有独立用例。
- 合成 Electron 使用 1440、1040、824 三视口运行销售、运营和邀请场景，内容区无横向溢出，页面错误 0。
- `team-foundation-pg.test.ts` 默认由 `PROSPECTOR_TEAM_TEST=1` 开启；CI 应使用专用隔离 PostgreSQL 强制执行。

## 未完成边界

- 本机开发中心仍运行旧的 051/052 结构；`mock:dev:status` 在迁移和重启前会报 canonical 表不存在。不能把旧进程的 200 响应当作 CP1 已部署。
- 055 若在某个环境已经以旧版本 checksum 记录，启动会拒绝覆盖；需要先按迁移流程升级或重建该环境的测试库。

## 关键约束

- 运行时不读写旧 `crm_team*` 作为组织真源；旧表只保留一次性迁移兼容。
- 销售横向成员信息不通过团队页、候选人、邀请或导出泄露。
- 任何组织写操作先鉴权，再使用版本和幂等键；未知结果必须复用原幂等键重试。
