import fs from 'node:fs';
import { Log } from '../logger';
import type { OnlineCrmAdapter } from '../adapters/online-crm.adapter';
import { autoSampleMailBatch, buildPackageFromRows } from './sample-mail.service';

declare const __PROSPECTOR_SAMPLE_MAIL__: boolean;

const FIRST_RUN_DELAY_MS = 20_000;
const RETRY_INTERVAL_MS = 2 * 60_000;
const TOTAL_MESSAGES = 1000;
const BATCH_MESSAGES = 100;
const AUTO_BODY_BYTES = 64 * 1024;
const MAX_REMEMBERED_IDS = 2000;

interface SyncState { uploadedIds: number[]; done: boolean }

let started = false;

/** Temporary: sample-mail builds push up to 1000 unseen messages once after login. */
export function startSampleMailAutoSync(adapter: OnlineCrmAdapter, stateFile: string): void {
  if (!__PROSPECTOR_SAMPLE_MAIL__ || started) return;
  started = true;
  const read = (): SyncState => {
    try {
      const value = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as Partial<SyncState>;
      return { uploadedIds: Array.isArray(value.uploadedIds) ? value.uploadedIds.filter(Number.isSafeInteger) : [], done: value.done === true };
    } catch { return { uploadedIds: [], done: false }; }
  };
  const write = (state: SyncState) => {
    try { fs.writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 }); }
    catch { Log.warn('sample-mail.sync', '自动样例状态写入失败'); }
  };
  let running = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };
  const once = async () => {
    if (running) return;
    const state = read();
    if (state.done) { stop(); return; }
    if (!adapter.currentIdentity() || !adapter.isOnline()) return;
    running = true;
    try {
      let sent = 0;
      while (sent < TOTAL_MESSAGES) {
        const batch = autoSampleMailBatch(state.uploadedIds, BATCH_MESSAGES);
        if (!batch) break;
        const pkg = buildPackageFromRows(batch.accountEmail, batch.rows, 'auto', AUTO_BODY_BYTES);
        const result = await adapter.sampleMailUpload<{ packageId: string }>({
          filename: pkg.filename, accountEmail: pkg.accountEmail, messageCount: pkg.count,
          rangeFrom: null, rangeTo: null, note: 'auto', base64: pkg.base64,
        });
        if (!result.ok) { Log.warn('sample-mail.sync', `自动样例上传失败 ${result.error.code}`); return; }
        state.uploadedIds = [...new Set([...state.uploadedIds, ...pkg.messageIds])].slice(-MAX_REMEMBERED_IDS);
        sent += pkg.count;
        write(state);
        if (batch.rows.length < BATCH_MESSAGES) break;
      }
      state.done = true;
      write(state);
      stop();
      Log.info('sample-mail.sync', `一次性样例同步完成，共 ${sent} 封`);
    } catch (error) {
      Log.warn('sample-mail.sync', `自动样例同步失败 ${error instanceof Error ? error.message : 'unknown'}`);
    } finally { running = false; }
  };
  setTimeout(() => { void once(); }, FIRST_RUN_DELAY_MS).unref?.();
  timer = setInterval(() => { void once(); }, RETRY_INTERVAL_MS);
  timer.unref?.();
  Log.info('sample-mail.sync', '一次性样例同步已启用（临时）');
}
