# 路由加载遮罩与标题栏失效修复（2026-10-19）

## 故障

切换客户、收件箱、设置等功能页时可能长期停留在加载动画，主窗口标题栏也无法点击。原因是 `IdentityGate` 将“登录后首次收敛到默认路由”的遮罩误用于所有路由切换；当前路径不是 `/customers` 或 `/inbox` 时，它会渲染一个覆盖整个窗口的固定层，遮挡标题栏并阻止页面交互。

## 修复

- `src/renderer/App.tsx`：将路由加载状态改为账号进入应用时的一次性 gate；普通页面切换不再触发全屏加载层。账号切换或离线/在线入口变化时仍会等待目标入口完成。
- `src/renderer/components/ProductLogin.css`：加载层从标题栏下方开始，标题栏在路由等待期间仍可点击。

## 验收

- 侧栏、收件箱、联系人详情和离线客户渲染测试：33 项通过；
- Electron 离线桌面 smoke：5 项通过，页面错误 0；
- `npm run typecheck`：通过；
- `npm run check`：通过，241 个源码文件，0 项待整改；
- `npm run build`：通过。

没有新增 IPC/API、数据库、依赖或配置。

checkpoint：`D:/Agent Basement/Milogin-s-prospector/checkpoints/identity-route-loading-fix-20261019`。
