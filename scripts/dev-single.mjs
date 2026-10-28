import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { resolveConfig } from 'electron-vite';
import { createServer } from 'vite';
import { preserveServerForRelaunch } from './dev-single-lifecycle.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const marker = `--prospector-dev-launcher=${root}`;
const electron = resolve(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const RELAUNCH_GRACE_MS = 5_000;
const RELAUNCH_PROBE_INTERVAL_MS = 200;
const env = { ...process.env, NODE_OPTIONS: '' };
// Development is intentionally pinned to the formal local center. A stale
// shell value must not silently route the app back to the isolated test node.
env.PROSPECTOR_CENTER_URL = 'http://127.0.0.1:55847';
for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'PROSPECTOR_DEV_DUAL', 'PROSPECTOR_DEV_AUTOLOGIN']) delete env[key];

const escapedMarker = marker.replaceAll("'", "''");
const processQuery = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.CommandLine -and $_.CommandLine.Contains('${escapedMarker}') }`;
const existingElectronPid = () => process.platform === 'win32'
  ? execFileSync('powershell.exe', ['-NoProfile', '-Command', `${processQuery} | Select-Object -First 1 -ExpandProperty ProcessId`], { windowsHide: true, encoding: 'utf8', timeout: 5_000 }).trim()
  : '';

// A second click must focus the existing application before any rebuild touches
// its files. Electron's userData lock remains the final single-instance guard.
let alreadyRunning = false;
if (process.platform === 'win32') {
  alreadyRunning = existingElectronPid() !== '';
}
if (alreadyRunning) {
  const second = spawn(electron, [root, marker], { cwd: root, windowsHide: true, stdio: 'inherit', env });
  await new Promise((accept, reject) => { second.on('error', reject); second.on('exit', code => code === 0 ? accept() : reject(new Error(`唤醒窗口失败 (${code})`))); });
} else {
  const build = spawn(process.execPath, [resolve(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], { cwd: root, windowsHide: true, stdio: 'inherit', env });
  await new Promise((accept, reject) => { build.on('error', reject); build.on('exit', code => code === 0 ? accept() : reject(new Error(`开发构建失败 (${code})`))); });
  const resolved = await resolveConfig({ root }, 'serve', 'development');
  if (!resolved.config?.renderer) throw new Error('缺少页面开发配置');
  const server = await createServer(resolved.config.renderer);
  await server.listen();
  const rendererUrl = server.resolvedUrls?.local[0];
  if (!rendererUrl) { await server.close(); throw new Error('未取得页面服务地址'); }
  console.log(`[${new Date().toISOString()}] [INFO] [dev.launcher] 单窗口启动，页面服务 ${rendererUrl}`);
  // Electron's Windows console writes UTF-8 bytes, while direct stdio inheritance
  // can make the parent shell decode them with the legacy code page. Decode at
  // this process boundary so Chinese logs remain readable in development.
  const child = spawn(electron, [root, marker], { cwd: root, windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'], env: { ...env, ELECTRON_RENDERER_URL: rendererUrl } });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    // Account switching replaces the child. Stop only this launcher's process tree.
    if (process.platform === 'win32') {
      try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `${processQuery} | ForEach-Object { & taskkill /PID $_.ProcessId /T /F | Out-Null }`], { windowsHide: true, stdio: 'ignore' }); }
      catch (error) { console.error(`[${new Date().toISOString()}] [WARN] [dev.launcher] 清理窗口失败: ${error.message}`); }
    } else child.kill();
    await server.close();
  }
  async function finishWindowExit() {
    if (stopping || process.platform !== 'win32') {
      await stop();
      return;
    }
    try {
      const relaunched = await preserveServerForRelaunch({
        probe: () => existingElectronPid() !== '',
        stop,
        graceMs: RELAUNCH_GRACE_MS,
        probeIntervalMs: RELAUNCH_PROBE_INTERVAL_MS,
      });
      if (relaunched) {
        console.log(`[${new Date().toISOString()}] [INFO] [dev.launcher] 检测到替代窗口，页面服务继续运行`);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] [WARN] [dev.launcher] 探测替代窗口失败: ${error.message}`);
      await stop();
    }
  }
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  child.on('error', error => { console.error(`[${new Date().toISOString()}] [ERROR] [dev.launcher] ${error.message}`); void stop(); });
  child.on('exit', code => {
    if (stopping) return;
    if (code) {
      console.error(`[${new Date().toISOString()}] [ERROR] [dev.launcher] 窗口异常退出 (${code})`);
      void stop();
      return;
    }
    // app.relaunch() also exits with 0. Keep Vite only while its replacement appears.
    void finishWindowExit();
  });
}
