# Prospecting Email Next — 开发规范

> 本文档是项目唯一的开发规范。改动代码前先读一遍，尤其注意「禁止模式」与「交付前检查」。
> （历史说明：本文件由原项目根目录的编码规范文档迁移而来，内容已中性化并修正过时技术栈。）

## 技术栈
Electron + TypeScript + electron-vite + Drizzle ORM（better-sqlite3，WAL 模式）+ React + Ant Design + Tailwind + TanStack Query

## 架构三层
- `src/main/services/` — 业务逻辑 + Drizzle 数据访问。**禁止 import electron 或 ipcMain**
- `src/main/transport/` — IPC 路由（每个 handler ≤15 行，只做参数校验 + 调 service）。**禁止直接查 DB**
- `src/main/contract.ts` — IPC 通道唯一事实源。新增通道必须先在此定义

## 禁止模式（红线）
- ❌ transport 之外注册 `ipcMain.handle`
- ❌ preload 中用字符串直接调 IPC（不经过 contract 常量）
- ❌ service 中 import electron 或 ipcMain
- ❌ 给已有通道加"第二个用途"
- ❌ 返回值不用 `okResult()/failResult()` 包裹
- ❌ renderer 中直接 import `src/main/` 文件
- ❌ 通道名用 `-` `_` 或驼峰（只允许 `domain:action`）
- ❌ service 函数中 throw（必须返回 Result）

## 自主改动边界
**✅ 可直接执行：**
- 修复 TS 编译错误
- 补充缺失的 JSDoc 注释
- 在现有 service 函数内部优化（不改签名）
- 编写/更新单元测试
- 修复 ESLint/Prettier 格式
- 调整页面 UI 布局

**❌ 必须先问负责人：**
- 新增/修改 `contract.ts` 中的 IPC 通道
- 新增/修改 `db/schema/` 中的表结构
- 新增第三方 npm 依赖（先用 stdlib/已有库）
- 修改 `.env` 配置键
- 修改本开发规范文件
- 删超过 20 行代码

## Service 函数模板（5 步）
```typescript
export async function myFunction(id: number): Promise<Result<MyType>> {
  Log.debug("module.func", `id=${id}`);              // 1. 日志
  if (!id) return failResult("参数错误: id 必填");     // 2. 参数校验
  const row = getDb().select()...get();               // 3. 数据操作
  if (!row) return failResult(`不存在: id=${id}`);     // 4. 空值检查
  return okResult(row);                                // 5. 成功返回
}
```

## 前端组件模板（5 状态）
```tsx
export function MyPage() {
  const { data, isLoading, error } = useMyQuery();
  if (isLoading) return <Table loading />;
  if (error) return <ErrorDisplay message={error.message} />;
  const items = data?.success ? data.data : [];
  return <Table dataSource={items} />;
}
```
所有页面必须含：数据获取 → 加载态 → 错误态 → 配置 → 渲染

## 交付前检查
- [ ] `npx tsc --noEmit` 零报错
- [ ] `npx vitest run` 全通过
- [ ] transport 层不 import db，service 层不 import electron
- [ ] 新增 IPC 通道走 contract → transport → preload 三步
- [ ] 所有 catch 块含 Log.error + error.stack
- [ ] 无 console.log 残留

## 已知陷阱
| 场景 | 教训 | 预防 |
|:---|:---|:---|
| `confirm()` 弹窗 | 非 async 回调里 await 冻结渲染进程 | await/async 一致性检查 |
| `process.resourcesPath` | 开发模式指向错误路径 | 统一用 config.ts 的 getResourcesRoot() |
| 配置键时间值 | 混用 `min` 和 `_seconds` 后缀 | 时间值强制 `_seconds` 后缀 |
| IPC 通道三步走 | 漏写 contract 或 preload 导致静默失败 | 编译期检查 + 交付前核对 |
| better-sqlite3 异步 | 忘记 await 导致拿到 Promise 而非数据 | TS 类型检查自动捕获 |
| AppUserModelID | 运行时 `setAppUserModelId` 与打包 `appId` 拼写不一致，任务栏固定图标空白+快捷方式失效 | AUMID 必须与 package.json `build.appId` 完全一致 |

## 注意事项
- better-sqlite3 采用 WAL 模式，写操作后需 `saveDatabase()` 触发 checkpoint（逐事务已落盘）
- main/index.ts 中每 30 秒自动保存一次
- 数据库文件在 `data/prospector.db`；每日备份在 `data/backups/`（保留 7 天）
- 迁移在 `src/main/db/index.ts` 的 `runMigrations()`，命名迁移记入 `_migrations` 表，新增列一律走命名 step
