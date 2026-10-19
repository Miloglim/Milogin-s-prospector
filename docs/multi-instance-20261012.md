# 开发多实例

> 2026-10-13 用户已撤回双实例运行。start-multi.bat、dev-dual.mjs、dev:dual/dev:multi 已删除，普通入口使用 dev-single.mjs。下文保留历史交付依据，不再作为启动说明；资料目录未删除。

当前验收：普通入口真实启动成功，重复启动只唤醒同一主进程；页面服务自动选取可用5173，不再要求55845。旧无窗口启动器占55845已精确停止，中心未关闭。隔离生产Electron主进程app.relaunch后登录页正常、页面服务持续可用、页面异常0；类型/架构/最新桌面构建通过。证据 .work/single-start-relaunch-report.json、single-start-relaunch.png及single-start日志。删除前checkpoint：D:/Agent Basement/checkpoints/prospector-single-start-20261013。正式安装包及全部历史闪退路径尚未验证。

2026-10-12；0.25.0-alpha.1工作区未发布。用户批准跨账号多实例。

双击根目录start-multi.bat（或npm run dev:multi），启动共享Vite开发页面的两个真实Electron实例，分别手动登录账号。资料目录为.work/desktop-multi/window-a与window-b；会话、Cookie、绑定和本地业务库分离，连接同一个中心PostgreSQL。重开保留各窗口资料；不要让两个进程共用同一个目录。

沿用scripts/dev-dual.mjs增加--manual参数，不禁用requestSingleInstanceLock。不同userData可各有实例，同目录第二进程退出并唤醒原窗口。原start.bat仍单目录启动；原dev:dual保留隔离合成管理员/用户自动登录，仅首次空白绑定自动登录，不读取用户口令到对话。

启动器清除继承的ELECTRON_RUN_AS_NODE、ELECTRON_RENDERER_URL和PROSPECTOR_DEV_AUTOLOGIN，显式设置各自profile；手动模式不会继承自动登录。停止启动器会关闭它自己创建的两个进程树，原程序和测试中心不受影响。正式打包程序不接受开发profile覆盖，单实例约束保留。

实际start-multi对应命令已运行：两独立目录及两次启动日志，窗口保留给用户登录。另用隔离合成管理员/用户实际Electron登录，Main身份分别核对、userData/绑定分离；同目录重复进程正常退出，两原实例继续可用，页面异常0。14目录/开发登录测试通过；脚本语法及架构194源码0例外检查通过。无IPC/API/数据库迁移/新依赖；B3和导入调整未实施。

Checkpoint：D:/Agent Basement/checkpoints/prospector-multi-instance-20261012。

## 0.25.1-alpha.1 黑屏修复（2026-10-12，未发布）

根因：electron-vite dev 把第一个 Electron 的退出绑定为自身退出。账号切换需要终止已加载的个人服务并重启进程，因而一起关闭 Vite，两个窗口失去页面服务。此前固定开发目录又绑定首次登录用户，换账号不能解锁本地业务。

修复：启动器先构建 main/preload/renderer，再从现有 electron-vite 配置启动独立 Vite 服务，两个 Electron 都成为独立客户端。窗口退出/重启不结束页面服务，Ctrl+C 停止启动器；重启后的子进程通过开发 profile 参数定位清理。开发资料改为 window-a或window-b/accounts/账号哈希，哈希包含中心地址与用户ID；会话继续保存在窗口根目录，账号业务库隔离。原目录资料保留，不自动搬迁未知归属内容。Vite忽略两种测试目录的运行写入。

启动较以前多一次完整构建；修改主进程代码后重新运行启动器，页面代码仍支持HMR。切换账号短暂重启窗口，未保存草稿仍可能丢失，这是既有隔离边界。

验收：真实双 Electron 点击侧栏“切换账号”，重启后登录页显示，第二窗口身份保留且页面服务返回200；第一窗口换不同账号后 localAvailable=true，两个账号业务目录分别绑定。页面异常0，截图已检查。证据 .work/multi-instance-switch-report.json、.work/multi-instance-switch.png。26项相关测试、typecheck、架构检查、完整构建通过。没有新增应用IPC/API、数据库表、依赖或鉴权绕过。此次未验证正式安装包或真实邮箱。

Checkpoint：D:/Agent Basement/checkpoints/prospector-black-screen-20261012。

## 2026-10-12 普通启动入口补齐

用户再次反馈切换账号黑屏，当前进程确认仍由 electron-vite dev 启动。前序修复覆盖 dev:multi/dev:dual，却未覆盖 start.bat/npm run dev。现在 dev 使用现有脚本 --single，单独托管 Vite 后启动一个 Electron；沿用原 userData 和账号目录，不继承开发自动登录或开发 profile。双开命令保持原行为。关闭启动器时通过独立启动标记识别重启后的进程；主进程修改需要重启启动器重新构建。

验证：14项账号隔离/开发登录测试、TypeScript、架构193源码/0例外及桌面构建通过；隔离实际 Electron 执行 app.relaunch 后替代进程显示登录页，页面服务仍返回成功、页面异常0。证据 .work/single-relaunch-report.json 和 .work/single-relaunch.png。此轮未登录用户账号、未点已登录账号的切换按钮，未验证正式安装包；验证覆盖该按钮所用的退出重启机制。当前开发窗口已以新单窗口启动器重开。无新依赖、IPC、配置键或数据迁移，未提交/发布。
