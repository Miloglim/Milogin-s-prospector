// ── 自动更新模块 ────────────────────────────────────────────────────────────
// 使用 electron-updater + GitHub Releases
// main/index.ts 启动时调用 init(mainWindow) 即可

import { autoUpdater } from "electron-updater";
import { ipcMain, app } from "electron";
import type { BrowserWindow } from "electron";
import { IPC } from "./contract";
import { Log } from "./logger";
import { netFetch } from "./net-proxy";
import { compareReleaseVersions, latestReleaseForChannel, parseReleaseFeed, type UpdateRelease } from "./services/update-metadata.service";

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时
const RELEASE_FEED = "https://github.com/Miloglim/Milogin-s-prospector/releases.atom";

let _win: BrowserWindow | null = null;
let _checkTimer: ReturnType<typeof setInterval> | null = null;
let _channel: "stable" | "prerelease" = "stable";

async function fetchReleases(): Promise<UpdateRelease[]> {
  const response = await netFetch(RELEASE_FEED, { headers: {
    "User-Agent": "prospecting-email",
    Accept: "application/atom+xml, application/xml, text/xml",
  } });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
  return parseReleaseFeed(await response.text());
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
  autoUpdater.allowPrerelease = _channel === "prerelease";
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
  // 同步检查只读公开 Release Atom，不消耗 GitHub REST API 配额；下载前 runDownload 再让 electron-updater缓存 updateInfo。
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

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  bindAutoUpdaterEvents();
  // IPC 注册已归位到 transport/update.ipc.ts，由 main/index.ts registerAllIPC 统一调用

  // 启动后 10 秒自动检查（公开 Release Atom，不依赖 GitHub REST API 配额）
  setTimeout(() => { void pollForUpdate(); }, 10_000);

  // 每 4 小时轮询
  _checkTimer = setInterval(() => { void pollForUpdate(); }, CHECK_INTERVAL_MS);
}

export function cleanupUpdater() {
  if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
  _win = null;
}
