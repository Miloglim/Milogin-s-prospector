// ── 自动更新模块 ────────────────────────────────────────────────────────────
// 使用 electron-updater + 公司 Navigator 内部更新源
// main/index.ts 启动时调用 init(mainWindow) 即可

import { autoUpdater } from "electron-updater";
import { app, net } from "electron";
import type { BrowserWindow } from "electron";
import { IPC } from "./contract";
import { Log } from "./logger";
import { compareReleaseVersions, latestReleaseForChannel, type UpdateRelease } from "./services/update-metadata.service";
import { loadConfig } from "./config";
import { readConfiguredRatesBase } from "./adapters/center-endpoint.adapter";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时
const UPDATE_MANIFEST_PATH = "/api/downloads/prospector/latest";
const UPDATE_FILE_PATH = "/downloads/prospector";

let _win: BrowserWindow | null = null;
let _checkTimer: ReturnType<typeof setInterval> | null = null;
let _channel: "stable" | "prerelease" = "stable";

async function fetchReleases(): Promise<UpdateRelease[]> {
  const base = updateBaseUrl();
  const response = await net.fetch(base + UPDATE_MANIFEST_PATH, {
    headers: { "User-Agent": "prospecting-email", Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok || payload?.ok !== true || !payload?.data) {
    throw new Error(`HTTP ${response.status}: ${String(payload?.error || "内部更新清单不可用").slice(0, 200)}`);
  }
  const data = payload.data;
  return [{
    version: String(data.version || "").replace(/^v/i, ""),
    name: `v${String(data.version || "").replace(/^v/i, "")}`,
    publishedAt: String(data.publishedAt || ""),
    prerelease: false,
    htmlUrl: `${base}${UPDATE_FILE_PATH}/${encodeURIComponent(String(data.fileName || ""))}`,
    body: Array.isArray(data.notes) ? data.notes.join(" ").slice(0, 500) : "",
  }];
}

function updateBaseUrl(): string {
  const configured = process.env.RATES_REMOTE_URL?.trim()
    || loadConfig().rates?.url?.trim()
    || readConfiguredRatesBase()
    || "";
  if (!configured) throw new Error("尚未配置 Navigator 内部更新地址");
  return configured.replace(/\/$/, "");
}

function configureAutoUpdaterFeed(): void {
  autoUpdater.setFeedURL({ provider: "generic", url: `${updateBaseUrl()}${UPDATE_FILE_PATH}` });
}

/** 轮询用：比对最新发布与运行版本，更新则推送 update:available（dev/内网都能检测，不依赖 app-update.yml） */
async function pollForUpdate(): Promise<void> {
  try {
    const releases = await fetchReleases();
    const cur = app.getVersion();
    const latest = latestReleaseForChannel(releases, _channel);
    if (latest && compareReleaseVersions(latest.version, cur) > 0) {
      _win?.webContents.send("update:available", { version: latest.version, releaseDate: latest.publishedAt, prerelease: latest.prerelease });
      Log.info("updater", `发现新版本 v${latest.version}（当前 v${cur}）`);
    } else {
      Log.debug("updater", `已是最新（当前 v${cur}${latest ? `，最新 v${latest.version}` : ""}）`);
    }
  } catch (e) {
    Log.warn("updater", `检查更新失败: ${(e as Error).message}`);
  }
}

// ── autoUpdater 事件 → 渲染进程 ──
function bindAutoUpdaterEvents() {
  autoUpdater.on("update-available", (info) => {
    const currentVersion = app.getVersion();
    const remoteVersion = (info.version || "").replace(/^v/i, "");
    if (remoteVersion === currentVersion) return;
    _win?.webContents.send("update:available", {
      version: info.version,
      releaseDate: info.releaseDate,
      prerelease: info.version?.includes("-"),
    });
  });

  autoUpdater.on("download-progress", (p) => {
    _win?.webContents.send("update:download-progress", {
      percent: Math.round(p.percent || 0),
      speedMB: p.bytesPerSecond ? (p.bytesPerSecond / 1024 / 1024).toFixed(1) : "—",
      total: p.total ? (p.total / 1024 / 1024).toFixed(1) : null,
      transferred: p.transferred ? (p.transferred / 1024 / 1024).toFixed(1) : "0.0",
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    _win?.webContents.send("update:downloaded", { version: info.version });
  });

  autoUpdater.on("error", (err) => {
    Log.warn("updater", `检查失败: ${err.message}`);
    _win?.webContents.send("update:error", { message: err.message });
  });
}

// ── 下载一次更新（重复点击复用同一个 Promise）──
let _download: Promise<void> | null = null;

/**
 * downloadUpdate() 只能下载 checkForUpdates() 已经缓存住的那一份（缓存为空时 electron-updater
 * 直接抛英文 "Please check update first" 并派生 error 事件）——旧实现把检查挂在「检查更新」按钮里
 * fire-and-forget，缓存常常还没落位，于是首点没反应、要点几次。下载自己把前置条件补齐。
 */
async function runDownload(): Promise<void> {
  configureAutoUpdaterFeed();
  autoUpdater.allowPrerelease = app.getVersion().includes("-") || _channel === "prerelease";
  autoUpdater.autoDownload = false;
  const res = await autoUpdater.checkForUpdates().catch((e: Error) => {
    Log.warn("updater", `下载前检查失败: ${e.message}`);
    return null;
  });
  if (!res) throw new Error("更新源连接失败，请检查网络后重试");
  if (!res.isUpdateAvailable) throw new Error("已是最新版本");
  Log.info("updater", `开始下载 v${res.updateInfo?.version ?? ""}`);
  await autoUpdater.downloadUpdate();
}

// ── 更新业务函数（IPC 注册统一在 transport/update.ipc.ts，业务逻辑留在此处）──
export async function listVersions(): Promise<{ success: true; data: { currentVersion: string; channel: string; releases: any[] } } | { success: false; error: string }> {
  try {
    const releases = await fetchReleases();
    const currentVersion = app.getVersion();
    const list = releases.map(r => ({
      version: r.version,
      name: r.name,
      publishedAt: r.publishedAt,
      prerelease: r.prerelease,
      htmlUrl: r.htmlUrl,
      body: r.body,
      isCurrent: r.version === currentVersion,
    }));
    return { success: true as const, data: { currentVersion, channel: _channel, releases: list } };
  } catch (e) {
    Log.warn("updater", `获取版本列表失败: ${(e as Error).message}`);
    return { success: false as const, error: (e as Error).message };
  }
}

export async function checkForUpdate(): Promise<{ success: true; data: { version: string; available: boolean } | null } | { success: false; error: string }> {
  // 同步检查只读 Navigator 内部清单；下载前 runDownload 再让 electron-updater 缓存 updateInfo。
  try {
    const releases = await fetchReleases();
    const cur = app.getVersion();
    const latest = latestReleaseForChannel(releases, _channel);
    if (latest && compareReleaseVersions(latest.version, cur) > 0) {
      return { success: true as const, data: { version: latest.version, available: true } };
    }
    return { success: true as const, data: null };
  } catch (e) {
    const msg = (e as Error).message || "";
    if (msg.includes("404") || msg.includes("Not Found")) return { success: false as const, error: "更新发布源未找到，请联系维护者" };
    return { success: false as const, error: msg || "检查失败" };
  }
}

export async function downloadUpdate(): Promise<{ success: true } | { success: false; error: string }> {
  try {
    // 下载中再点 = 等同一次下载（electron-updater 内部也去重），不叠第二次网络请求
    _download ??= runDownload().finally(() => { _download = null; });
    await _download;
    return { success: true as const };
  } catch (e) {
    return { success: false as const, error: (e as Error).message };
  }
}

export function installUpdate(): { success: true } | { success: false; error: string } {
  try {
    autoUpdater.quitAndInstall(true, true);
    return { success: true as const };
  } catch (e) {
    return { success: false as const, error: (e as Error).message };
  }
}

export function setUpdateChannel(ch: string): { success: true } | { success: false; error: string } {
  if (ch === "stable" || ch === "prerelease") {
    _channel = ch;
    autoUpdater.allowPrerelease = ch === "prerelease";
    Log.info("updater", `通道切换: ${ch}`);
    return { success: true as const };
  }
  return { success: false as const, error: "无效通道，只能是 stable 或 prerelease" };
}

export function getUpdateChannel(): { success: true; data: string } {
  return { success: true as const, data: _channel };
}

// ── 启动 ──
export function initUpdater(mainWindow: BrowserWindow) {
  _win = mainWindow;

  try { configureAutoUpdaterFeed(); }
  catch (error) { Log.warn("updater", `内部更新源未配置: ${(error as Error).message}`); }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = app.getVersion().includes("-");

  bindAutoUpdaterEvents();
  // IPC 注册已归位到 transport/update.ipc.ts，由 main/index.ts registerAllIPC 统一调用

  // 启动后 10 秒自动检查公司内部 Navigator 更新清单
  setTimeout(() => { void pollForUpdate(); }, 10_000);

  // 每 4 小时轮询
  _checkTimer = setInterval(() => { void pollForUpdate(); }, CHECK_INTERVAL_MS);
}

export function cleanupUpdater() {
  if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
  _win = null;
}
