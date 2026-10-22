import { app, BrowserWindow, Menu, ipcMain, Tray, nativeImage, dialog, session, shell } from "electron";
import * as fs from "fs";
import * as path from "path";
import { initDatabase, runMigrations, saveDatabase, closeDatabase } from "./db";
import { Log } from "./logger";
import { registerOnlineCrmIPC, closeOnlineCrmSession, getOnlineIdentity, isOnlineConnection, onOnlineIdentityChanged, configureOnlineLocalScope, configureOnlineAccountSwitchLifecycle, loginDevelopmentIdentity, startContactMailDataflow } from "./transport/online-crm.ipc";
import { developmentLogin } from './adapters/developer-login.adapter';
import { registerUpdateIPC } from "./transport/update.ipc";
import { registerSystemRestartIPC } from "./transport/system.ipc";
import { initUpdater, cleanupUpdater } from "./updater";
import { APP_ROOT, getResourcesRoot, loadConfig, selectAccountRoot } from "./config";
import { DesktopLocalScope, developerProfileRoot, developmentUserDataRoot, accountProfileRoot } from "./adapters/desktop-local-scope.adapter";
import { registerLockedLocalIPC, registerGuardedLocalIPC } from "./transport/desktop-local.ipc";
import { EVENTS } from "./events";

const developerRoot = developerProfileRoot(process.env.PROSPECTOR_DEV_PROFILE, app.isPackaged);
const developmentUserData = developmentUserDataRoot(developerRoot, app.isPackaged, app.getPath('appData'));
// APP_ROOT already reads the environment at module evaluation; Electron's profile must
// be selected before its lock/session/auth stores are opened as well.
if (developmentUserData) {
  fs.mkdirSync(developmentUserData, { recursive: true });
  app.setPath("userData", developmentUserData);
}
let localScope = new DesktopLocalScope(APP_ROOT, !!developerRoot, getOnlineIdentity, isOnlineConnection);
let normalAccountSelected = false;
let localInitializationStarted = false;
let localInitialized = false;
let identityRestarting = false;
let identityRestartTimer: ReturnType<typeof setTimeout> | null = null;
let lastIdentityScopeState = "";
const IDENTITY_SETTLE_MS = 1_000;
let suspendLocalNetworkWork: () => void = () => {};
const LOCAL_BACKUP_START_MS = 5 * 60_000;
const LOCAL_BACKUP_INTERVAL_MS = 24 * 60 * 60_000;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let trayRestartPending = false;
let restartConfirmation: ((confirmed: boolean) => void) | null = null;
let sessionIpcRegistered = false;

// ── P0-5 崩溃兜底：主进程不再静默消失 ──────────────────────────
// 错误一律落日志；对话框节流 60s 防异常风暴刷屏；进程保持存活（群发批次不受牵连）
let lastCrashDialogAt = 0;
function reportCrash(kind: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  Log.error("crash", `${kind}: ${msg}`);
  const now = Date.now();
  if (now - lastCrashDialogAt > 60_000) {
    lastCrashDialogAt = now;
    try {
      dialog.showErrorBox(
        "程序遇到意外错误",
        `${kind}\n${msg.slice(0, 600)}\n\n错误已记录到日志，程序将继续运行；若反复出现请重启应用。`,
      );
    } catch { /* 对话框本身失败则只留日志 */ }
  }
}
process.on("uncaughtException", (err) => reportCrash("未捕获异常", err));
process.on("unhandledRejection", (reason) => reportCrash("未处理的 Promise 拒绝", reason));

function getIconPath(name: string): string {
  return path.join(getResourcesRoot(), name);
}

function createWindow() {
  // ponytail: 开发模式设独立 name，避免单实例锁跟打包客户端冲突
  if (!app.isPackaged) app.setName("prospecting-email-dev");

  // P0-2: 生产包注入 CSP —— 渲染进程只允许自源脚本；内联样式放行（antd/富文本需要）；
  // 图片允许 data:（粘贴内嵌）与 https:（外链邮件图）。dev 不注入（Vite/react-refresh 需内联脚本）。
  if (app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ws: http://localhost:*",
          ],
        },
      });
    });
  }

  const appIcon = nativeImage.createFromPath(getIconPath("icon.png"));

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1040,
    minHeight: 660,   // 低于此值对话区与能力面板会被挤压；1366×768 屏仍有充分余量
    title: "Milogin's Prospector.",
    icon: appIcon,
    backgroundColor: "#f4f5f6",
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // P1-3: 外链一律交系统浏览器；窗口内禁止导航离开应用本体（防渲染进程被诱导跳外网）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL || "";
    const ok = url.startsWith("file://") || (devUrl && url.startsWith(devUrl));
    if (!ok) event.preventDefault();
  });

  // 关闭行为：读配置决定隐藏到托盘还是直接退出
  mainWindow.on("close", (e) => {
    if (isQuitting) return;
    try {
      const cfg = localInitialized ? loadConfig() : { general: { closeAction: "tray" } };
      const closeAction = cfg.general?.closeAction || "tray";
      if (closeAction === "tray" && tray) {
        e.preventDefault();
        mainWindow?.hide();
      }
    } catch {
      // 配置文件损坏 → 默认托盘
      if (tray) { e.preventDefault(); mainWindow?.hide(); }
    }
  });

  // 开发快捷键：F12 / Ctrl+Shift+I 打开 DevTools
  mainWindow.webContents.on("before-input-event", (_e, input) => {
    if (
      input.key === "F12" ||
      (input.control && input.shift && input.key.toLowerCase() === "i")
    ) {
      mainWindow?.webContents.toggleDevTools();
    }
  });

  // P0-5: 渲染进程崩溃 → 落日志并自动重载（替代 Electron 默认白屏）
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    Log.error("crash", `渲染进程退出: ${details.reason} (exitCode=${details.exitCode})`);
    mainWindow?.webContents.reload();
  });

  // 批处理启动、托盘唤醒和单实例复用都可能让窗口已创建但仍处于隐藏态；
  // 等首屏渲染完成后显式显示，避免只剩后台进程而用户看不到窗口。
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  if (process.env.NODE_ENV === "development" || process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL || "http://localhost:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

async function restartApplication(): Promise<void> {
  if (trayRestartPending || isQuitting || identityRestarting) return;
  trayRestartPending = true;
  try {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
    const confirmed = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => { restartConfirmation = null; resolve(false); }, 30_000);
      restartConfirmation = (value) => { clearTimeout(timeout); restartConfirmation = null; resolve(value); };
      mainWindow?.webContents.send(EVENTS.APP_RESTART_REQUEST);
    });
    if (!confirmed || isQuitting || identityRestarting) return;
    Log.info("app.restart", "用户从托盘重新启动应用");
    app.relaunch();
    identityRestarting = true;
    isQuitting = true;
    // Normal quit runs the existing session/SQLite/updater cleanup; never hide to tray.
    app.quit();
  } catch (error) {
    Log.error("app.restart", error instanceof Error ? error.message : String(error), error instanceof Error ? error.stack : undefined);
  } finally {
    trayRestartPending = false;
  }
}

function createTray() {
  const iconPath = getIconPath("tray-icon.png");
  let trayIcon = nativeImage.createFromPath(iconPath);
  if (trayIcon.isEmpty()) {
    trayIcon = nativeImage.createFromPath(getIconPath("icon.png"));
  }
  if (trayIcon.isEmpty()) return; // 没有图标则跳过
  tray = new Tray(trayIcon);
  tray.setToolTip("Milogin's Prospector.");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "重启应用", click: () => { void restartApplication(); } },
    { label: "退出", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => { mainWindow?.show(); mainWindow?.focus(); });
}

async function confirmInterruptedBatch(batchId: string): Promise<void> {
  const win = mainWindow;
  if (!win || !localScope.allowed() || !isOnlineConnection()) return;
  const answer = await dialog.showMessageBox(win, {
    type: "warning",
    title: "恢复中断的发送批次",
    message: "检测到上次退出时未完成的发送批次。",
    detail: `批次 ${batchId.slice(0, 8)} 尚未自动发送。是否恢复该批次中仍待发送的邮件？`,
    buttons: ["恢复发送", "暂不恢复"],
    defaultId: 1,
    cancelId: 1,
  });
  if (answer.response !== 0) {
    Log.info("send.interrupted", "用户选择暂不恢复中断批次");
    return;
  }
  if (!localScope.allowed() || !isOnlineConnection()) return;
  const { resumeInterruptedBatch } = await import("./services/send.service");
  if (!localScope.allowed() || !isOnlineConnection()) return;
  const result = resumeInterruptedBatch();
  if (result.success) Log.info("send.interrupted", `用户确认恢复中断批次: ${result.data.queued} 组待发`);
  else Log.warn("send.interrupted", `用户确认恢复失败: ${result.error}`);
}

async function registerAllIPC() {
  // Do not load personal-service modules (including their .env readers) for the
  // locked legacy profile. They are imported only for a verified bound profile.
  const modules = await Promise.all([
    import("./transport/contact.ipc"), import("./transport/company.ipc"),
    import("./transport/send.ipc"), import("./transport/inbox.ipc"),
    import("./transport/crm.ipc"), import("./transport/template.ipc"),
    import("./transport/account.ipc"), import("./transport/export.ipc"),
    import("./transport/dashboard.ipc"), import("./transport/history.ipc"),
    import("./transport/bounce.ipc"), import("./transport/ai.ipc"),
    import("./transport/agent.ipc"), import("./transport/rates.ipc"),
    import("./transport/rate-update.ipc"), import("./transport/dev-letter.ipc"),
    import("./transport/kb.ipc"), import("./transport/system.ipc"),
    import("./transport/search.ipc"),
  ]);
  if (!localScope.allowed() || identityRestarting) return;
  const inboxModule = modules.find(module => 'suspendLocalNetworkWork' in module);
  const [{ stopAll }, backgroundTasks] = await Promise.all([
    import('./services/agent.service'), import('./services/bg-task.service'),
  ]);
  if (!localScope.allowed() || identityRestarting) return;
  backgroundTasks.setBgTaskNetworkAllowed(() => localScope.allowed() && isOnlineConnection());
  if (inboxModule && 'suspendLocalNetworkWork' in inboxModule) {
    const suspendMail = inboxModule.suspendLocalNetworkWork as () => void;
    suspendLocalNetworkWork = () => { suspendMail(); stopAll(); backgroundTasks.cancelAll(); };
  }
  const registrars = modules.map(module => {
    const registration = Object.entries(module).find(([name]) => name.startsWith("register"));
    if (!registration || typeof registration[1] !== "function") throw new Error("本地 IPC 注册入口缺失");
    if (registration[0] === 'registerInboxIPC' || registration[0] === 'registerSendIPC') {
      return () => (registration[1] as (networkAllowed: () => boolean) => void)(() => localScope.allowed() && isOnlineConnection());
    }
    return registration[1] as () => void;
  });
  registerGuardedLocalIPC(localScope, registrars);

  Log.info("ipc", "本地 IPC 通道已按账号资料归属注册");
}

function registerSessionIPC() {
  if (sessionIpcRegistered) return;
  sessionIpcRegistered = true;
  registerOnlineCrmIPC();
  // Version/updater liveness carry no customer/configuration/credential information.
  registerUpdateIPC();
  registerLockedLocalIPC(app.getVersion(), () => localScope.failure());
  registerSystemRestartIPC(confirmed => restartConfirmation?.(confirmed));

  // 窗口控制
  ipcMain.on("window:minimize", () => mainWindow?.minimize());
  ipcMain.on("window:maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on("window:close", () => mainWindow?.close());

  Log.info("ipc", "所有 IPC 通道注册完成");
}

async function activateLocalProfile(): Promise<void> {
  if (!localScope.allowed() || localInitializationStarted) return;
  localInitializationStarted = true;
  const [{ migrateBodiesOut }, { migrateAccountPasswords }] = await Promise.all([
    import("./services/inbox.service"), import("./services/account.service"),
  ]);
  if (!localScope.allowed() || identityRestarting) return;
  await initDatabase();
  if (!localScope.allowed() || identityRestarting) return;
  runMigrations();
  await migrateBodiesOut();
  if (!localScope.allowed() || identityRestarting) return;
  migrateAccountPasswords();
  await startContactMailDataflow(()=>{if(localScope.allowed()&&mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('inbox:newMail',{count:0});});
  await registerAllIPC();
  if (!localScope.allowed() || identityRestarting) return;
  localInitialized = true;
  const [{ backfillLocalSearchBodies }, { claimInterruptedBatch }, { dailyBackup }] = await Promise.all([
    import("./services/search.service"), import("./services/send.service"), import("./services/backup.service"),
  ]);
  if (!localScope.allowed() || identityRestarting) return;
  void backfillLocalSearchBodies();
  const interruptedBatch = claimInterruptedBatch();
  if (interruptedBatch && isOnlineConnection()) void confirmInterruptedBatch(interruptedBatch.batchId);
  setTimeout(() => { if (localScope.allowed()) dailyBackup(); }, LOCAL_BACKUP_START_MS);
  setInterval(() => { if (localScope.allowed()) dailyBackup(); }, LOCAL_BACKUP_INTERVAL_MS);
  Log.info("local.scope", "隔离资料已绑定当前中心账号");
}

function updateLocalIdentity(): void {
  if (identityRestarting) return;
  if (localInitialized && !isOnlineConnection()) suspendLocalNetworkWork();
  const identity = getOnlineIdentity();
  const identityKey = identity ? `${identity.baseUrl}|${identity.userId}` : "anonymous";
  if (identity && !normalAccountSelected) {
    const root = accountProfileRoot(developmentUserData || app.getPath('userData'), identity);
    selectAccountRoot(root);
    localScope = new DesktopLocalScope(root, true, getOnlineIdentity, isOnlineConnection);
    normalAccountSelected = true;
  }
  localScope.setIdentity(getOnlineIdentity());
  const scopeState = `${identityKey}|started=${localInitializationStarted}|allowed=${localScope.allowed()}`;
  if (scopeState !== lastIdentityScopeState) {
    lastIdentityScopeState = scopeState;
    Log.info("local.scope", `身份范围检查 ${identityKey}，初始化已开始=${localInitializationStarted}，本地可用=${localScope.allowed()}`);
  }
  if (localInitializationStarted && !localScope.allowed()) {
    // Existing services lack a complete stop-all contract (in-flight IMAP/model/SMTP).
    // Terminating this process is the R1 boundary: no previous-account work survives
    // a logout/revocation/switch, and a new account cannot reuse this profile.
    if (identityRestartTimer) return;
    identityRestartTimer = setTimeout(() => {
      identityRestartTimer = null;
      const recovered = getOnlineIdentity();
      if (recovered) localScope.setIdentity(recovered);
      if (localScope.allowed()) {
        Log.info("local.scope", "身份短暂变化后已恢复，取消重启");
        return;
      }
      identityRestarting = true;
      Log.warn("local.scope", "身份已变化，本地任务停止并重启；未保存草稿将丢失");
      app.relaunch();
      app.exit(0);
    }, IDENTITY_SETTLE_MS);
    return;
  }
  if (identityRestartTimer) {
    clearTimeout(identityRestartTimer);
    identityRestartTimer = null;
  }
  void activateLocalProfile().catch(error => {
    Log.error("local.scope", `隔离资料初始化失败: ${error instanceof Error ? error.message : String(error)}`);
    // Never leave a partially registered local runtime behind.
    app.exit(1);
  });
}

// 单实例锁 — 防止重复启动多个进程
app.setAppUserModelId("com.miloglim.prospecting-email");
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

if (gotLock) app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  configureOnlineLocalScope(() => localInitialized && localScope.allowed());
  configureOnlineAccountSwitchLifecycle({
    begin() {
      if (identityRestartTimer) clearTimeout(identityRestartTimer);
      identityRestartTimer = null;
      identityRestarting = true;
      mainWindow?.hide();
      Log.info("local.scope", "开始切换账号，窗口隐藏并准备重启");
    },
    finish(ok) {
      if (!ok) {
        identityRestarting = false;
        mainWindow?.show();
        mainWindow?.focus();
        Log.warn("local.scope", "切换账号未完成，已恢复原窗口");
        return;
      }
      app.relaunch();
      app.exit(0);
    },
  });
  registerSessionIPC();
  onOnlineIdentityChanged(updateLocalIdentity);
  updateLocalIdentity();
  createWindow();
  createTray();
  initUpdater(mainWindow!);
  if(developerRoot)void developmentLogin(app.isPackaged,developerRoot).then(async input=>{
    if(input){const result=await loginDevelopmentIdentity(input);if(!result.ok)Log.warn('dev.login',result.error.message);}
  }).catch(()=>Log.error('dev.login','开发账号自动登录失败，请先启动受控本机测试中心；未绕过鉴权'));


  // 「行动建议」流已改为本地实时拼装 + 事件驱动热更新（suggestion-bus），无需启动批生成

  // P1-1: better-sqlite3 逐事务落盘，无需定时全量保存（旧 sql.js 30s 定时器已移除）

  Log.info("app", `启动完成，版本 ${app.getVersion()}`);
});

app.on("before-quit", () => {
  if (identityRestartTimer) clearTimeout(identityRestartTimer);
  identityRestartTimer = null;
  closeOnlineCrmSession();
  isQuitting = true;
  if (localInitialized) {
    saveDatabase();   // WAL checkpoint 收尾，仅当前账号已绑定的隔离库
    closeDatabase();
  }
  cleanupUpdater();
  Log.info("app", "正在退出...");
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
