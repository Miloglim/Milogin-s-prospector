# Prospecting Email Next — 开发规范

> 本文档是工程开发规范。改动代码前先读一遍，尤其注意「禁止模式」与「交付前检查」。功能域的行为契约以对应 `docs/*-spec.md` 为准；运行时与数据结构以源码为准。
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
- better-sqlite3 的每次写操作已落盘；`saveDatabase()` 只做 WAL checkpoint，主要在正常退出和批处理收尾时调用
- 数据库文件在 `data/prospector.db`；每日备份在 `data/backups/`（保留 7 天）
- 迁移在 `src/main/db/index.ts` 的 `runMigrations()`，命名迁移记入 `_migrations` 表，新增列一律走命名 step

## 开发环境搭建

```bash
npm install        # 安装依赖（postinstall 自动按 Electron 版本重编 better-sqlite3）
npm run dev        # 开发模式（界面热更新；主进程改动需重启）
npm test           # 单元与集成测试（vitest）
npm run typecheck  # tsc --noEmit
npm run build      # 三段构建（main / preload / renderer）
npm run pack       # 打 Windows 安装包 → ../dist-release
npm run eval:agent # AI 能力回归评测（需真实端点与 API key）
```

配置放项目根目录 `.env`（已 gitignore，密钥不入库）：

| 变量 | 用途 |
|---|---|
| `AGENT_API_BASE_URL` / `AGENT_API_KEY` / `AGENT_MODEL` | 对话与能力调用的生效端点（可由设置页写入） |
| `LIGHT_API_BASE_URL` / `LIGHT_KEY_ENV` / `LIGHT_MODEL` | 轻任务档（邮件总结、背调报告、会话压缩），不填则用主端点 |
| `EXA_API_KEY` / `TAVILY_API_KEY` | 联网检索源：公司背调与航线行情调研共用（都不配则这两类能力会明确报「未配置」） |
| `KB_BASE_URL` / `KB_TOKEN` / `KB_APPLICATION_ID` | 公司内网 KB 中转（可选） |
| `GH_TOKEN` / `GITHUB_TOKEN` | 读取 releases 与自动更新检查用（私有仓库或限流时需要） |

数据落在 `data/`、运行设置与端点档案在 `send/config.json`、`ai/providers.json`（均不入库）。

网络注意：本机直连 GitHub 下载可能被 TLS 证书拦截，Electron 二进制与 electron-builder 工具下载需走国内镜像：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
```

## 发版流程

1. `package.json` / `package-lock.json` 改版本（`npm version X.Y.Z --no-git-tag-version`）
2. 提交 → 打 tag：`git tag vX.Y.Z && git push origin vX.Y.Z`
3. `npm run pack`（产物在 `../dist-release`，含安装包 + `latest.yml`）
4. 建 Release：`gh release create vX.Y.Z --title "vX.Y.Z" --notes-file release-notes.md --files ../dist-release/prospecting-email-setup-X.Y.Z.exe ../dist-release/prospecting-email-setup-X.Y.Z.exe.blockmap ../dist-release/latest.yml`
5. **必须挂上 `latest.yml`**——缺它应用内自动更新不生效

自动更新依赖仓库 Releases 的 `latest.yml`：`src/main/updater.ts` 的 `GITHUB_API` 与 `package.json` `build.publish` 指向 `Miloglim/Milogin-s-prospector`。
