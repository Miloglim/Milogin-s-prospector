import * as fs from "fs";
import * as path from "path";
import { getRawDb } from "../db";
import { APP_ROOT } from "../config";
import { Log } from "../logger";

const BACKUP_DIR = path.join(APP_ROOT, "data", "backups");
const KEEP_DAYS = 7;

/** 每日备份：VACUUM INTO 生成一致性快照，并 TRUNCATE 收 WAL。失败只记日志，不阻断应用。 */
export function dailyBackup(): void {
  try {
    const db = getRawDb();
    if (!db) return;
    const dir = BACKUP_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 先收 WAL，避免备份体积被 WAL 撑大
    try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* 忽略 */ }
    const date = new Date().toISOString().slice(0, 10);
    const target = path.join(dir, `prospector-${date}.db`);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    Log.info("db.backup", `每日备份完成: ${target}`);
    // 清理 7 天前的备份
    const keep = new Set<string>();
    for (let i = 0; i < KEEP_DAYS; i++) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      keep.add(`prospector-${d}.db`);
    }
    for (const f of fs.readdirSync(dir)) {
      if (/^prospector-\d{4}-\d{2}-\d{2}\.db$/.test(f) && !keep.has(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* 忽略 */ }
      }
    }
  } catch (err) {
    Log.warn("db.backup", `每日备份失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
