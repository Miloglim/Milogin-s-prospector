import * as path from "path";
import * as fs from "fs";
import { z } from "zod";
import { Log } from "./logger";
import { DEFAULT_CRM_OVERDUE_DAYS, DEFAULT_CRM_WARN_DAYS, normalizeCrmThresholds, MAX_CRM_THRESHOLD_DAYS } from "../shared/crm";
import { okResult, failResult, type Result } from "./errors";
import { nudge } from "./services/suggestion-bus";
import { validateNavigatorBase, NavigatorConfigurationError } from "./services/navigator-auth.service";
import { developerProfileRoot } from "./adapters/desktop-local-scope.adapter";

// ponytail: process.resourcesPath 是 Electron 扩展，Node 类型不含它

/** 获取应用根目录。
 *  ponytail: app 模块在 Electron 主进程运行时可用，非 Electron 测试环境用 __dirname 兜底 */
function getAppRoot(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron");
    const developerRoot = developerProfileRoot(process.env.PROSPECTOR_DEV_PROFILE, app.isPackaged);
    if (developerRoot) return developerRoot;
    return app.isPackaged
      ? app.getPath("userData")
      : path.resolve(__dirname, "..", "..");
  } catch {
    // Node tests do not have Electron; the explicit profile still scopes their files.
    const developerRoot = developerProfileRoot(process.env.PROSPECTOR_DEV_PROFILE, false);
    if (developerRoot) return developerRoot;
    return path.resolve(__dirname, "..", "..");
  }
}

export let APP_ROOT = getAppRoot();

/** 资源根目录 */
export function getResourcesRoot(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron");
    return app.isPackaged
      ? path.join((process as unknown as Record<string, string>).resourcesPath || "", "assets")
      : path.resolve(__dirname, "..", "..", "assets");
  } catch {
    return path.resolve(__dirname, "..", "..", "assets");
  }
}

/** 数据库路径 */
export let DB_PATH = path.join(APP_ROOT, "data", "prospector.db");

/** send/config.json 路径 */
let CONFIG_PATH = path.join(APP_ROOT, "send", "config.json");
let accountRootSelected = false;
/** Startup selects one verified account directory before loading personal services.
 * Changing accounts requires process restart; loaded services never change roots. */
export function selectAccountRoot(root: string): void {
  if (!path.isAbsolute(root)) throw new Error('账号资料路径必须为绝对路径');
  if (accountRootSelected && root !== APP_ROOT) throw new Error('切换账号必须重启本地服务');
  APP_ROOT = root;
  DB_PATH = path.join(root, 'data', 'prospector.db');
  CONFIG_PATH = path.join(root, 'send', 'config.json');
  accountRootSelected = true;
}

export interface SendSchedule {
  /** 兼容旧配置；全局发送时段已停用，实际时段仅由开发任务单独控制 */
  timeWindowEnabled: boolean;
  startHour: number;   // 本机时区时（跟操作系统，非固定北京时）
  endHour: number;     // 本机时区时（次日）
  /** 每组人数上限（同公司超过 N 拆多组） */
  groupSize: number;
  /** 组间暂停区间（秒）— 模拟人工一批批发 */
  groupDelayMinSeconds: number;
  groupDelayMaxSeconds: number;
}

export interface RuntimeConfig {
  /** 通用设置 */
  general?: {
    closeAction?: "tray" | "quit"; autoLaunch?: boolean;
    /** 新手向导已被处置过：skipped=点了跳过（此后不再自动弹出），done=走完了向导。
     *  Shift+点侧边栏版本号 的强制重开不看这个标记。 */
    onboarding?: "skipped" | "done";
  };
  /** 全局发信日限额（从首次真实发送起 24h 重置） */
  sendQuota?: { dailyLimit: number; firstSendAt: string | null; sentToday: number };
  /** 发送批次运行中标志：批次真实启动时写入、结束/取消时清除。
   *  退出/崩溃后残留 → 启动时提示用户确认恢复，绝不自动外发。
   *  两步式手动入队（autoStart=false）不写此标志，重启后不会被误提示。 */
  runningBatch?: { batchId: string; startedAt: string } | null;
  /** 异常退出时由启动阶段转存的批次；保留到用户明确恢复成功，供发送中心持续提示。 */
  interruptedBatch?: { batchId: string; startedAt: string } | null;
  /** 无法确定具体邮箱账号时使用的默认发信人名称；实际账号 displayName 优先 */
  fromName: string;
  schedule: SendSchedule;
  /** 测试模式（发信测试用） */
  test: {
    email: string;      // 测试收件邮箱
    company: string;    // 测试用的公司名
    enabled: boolean;   // 启用测试收件人和测试公司资料
    dryRun: boolean;    // 发信阻隔（流程完整但不实际发送）
  };
  /** CRM 客户跟进偏好 */
  crm: {
    silentOverdueDays?: number;
    warnDays?: number;
    /** 阶段 → 默认跟进间隔（天）*/
    followupDays: Record<string, number>;
    /** Dashboard 待办提前天数 */
    todoAdvanceDays: number;
    /** 自动归档天数（发信后 N 天无回复自动标记为 lost，0=禁用） */
    autoArchiveDays: number;
  };
  /** 预设句库自定义主题（key = `${clientType}.${lang}`，如 direct.EN） */
  sentenceSubjects?: Record<string, string>;
  /**
   * Navigator 用户授权服务地址，无内置默认值；RATES_REMOTE_URL 环境变量优先。
   * source 为旧版存量配置，保留读取兼容但不参与选源（公网镜像已废弃）。
   */
  rates?: { source?: "lan" | "remote"; url?: string };
}

export const DEFAULT_SCHEDULE: SendSchedule = {
  timeWindowEnabled: false,
  startHour: 9,
  endHour: 8,
  groupSize: 20,
  groupDelayMinSeconds: 300,
  groupDelayMaxSeconds: 600,
};

const DEFAULT_CONFIG: RuntimeConfig = {
  fromName: "",
  sendQuota: { dailyLimit: 800, firstSendAt: null, sentToday: 0 },
  schedule: DEFAULT_SCHEDULE,
  test: { email: "", company: "", enabled: false, dryRun: false },
  // 用户配置 Navigator 服务地址；历史 source 值不再影响选源。
  rates: {},
  crm: {
    silentOverdueDays: DEFAULT_CRM_OVERDUE_DAYS,
    warnDays: DEFAULT_CRM_WARN_DAYS,
    followupDays: { reaching: 3, quoting: 3, trial: 5, cooperating: 7, lost: 14, other: 7 },
    todoAdvanceDays: 2,
    autoArchiveDays: 30,
  },
};

// P1-5: 引擎关键数值的 zod 校验 — 垃圾值（类型错/越界）整体回默认，不进发送引擎
const ScheduleSchema = z.object({
  timeWindowEnabled: z.boolean(),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  groupSize: z.number().int().min(1).max(500),
  groupDelayMinSeconds: z.number().int().min(0).max(86_400),
  groupDelayMaxSeconds: z.number().int().min(0).max(86_400),
}).partial();

const TestSchema = z.object({
  email: z.string(),
  company: z.string(),
  enabled: z.boolean(),
  dryRun: z.boolean(),
}).partial();

function defaults(): RuntimeConfig {
  return { ...DEFAULT_CONFIG, schedule: { ...DEFAULT_SCHEDULE }, test: { ...DEFAULT_CONFIG.test }, crm: { ...DEFAULT_CONFIG.crm, followupDays: { ...DEFAULT_CONFIG.crm.followupDays } } };
}

export function loadConfig(): RuntimeConfig {
  // P1-5: 首启落盘默认配置（用户可见、可手改），不再只存在于内存
  if (!fs.existsSync(CONFIG_PATH)) {
    const def = defaults();
    try { saveConfig(def); } catch { /* 只读环境忽略 */ }
    return def;
  }
  let raw: Partial<RuntimeConfig>;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Partial<RuntimeConfig>;
  } catch (err) {
    // P1-5: 损坏配置 → 备份后回默认（原行为是抛错，靠每个调用方各自兜底）
    try { fs.renameSync(CONFIG_PATH, `${CONFIG_PATH}.corrupt.bak`); } catch { /* 重命名失败也继续 */ }
    Log.error("config", `config.json 解析失败，已备份并回退默认配置: ${err instanceof Error ? err.message : String(err)}`);
    const def = defaults();
    try { saveConfig(def); } catch { /* 只读环境忽略 */ }
    return def;
  }
  const sched = ScheduleSchema.safeParse(raw.schedule);
  const test = TestSchema.safeParse(raw.test);
  const thresholds = normalizeCrmThresholds(raw.crm);
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    schedule: sched.success ? { ...DEFAULT_SCHEDULE, ...sched.data } : DEFAULT_SCHEDULE,
    test: test.success ? { ...DEFAULT_CONFIG.test, ...test.data } : DEFAULT_CONFIG.test,
    crm: { ...DEFAULT_CONFIG.crm, ...(raw.crm || {}), silentOverdueDays: thresholds.overdueDays, warnDays: thresholds.warnDays, followupDays: { ...DEFAULT_CONFIG.crm.followupDays, ...(raw.crm?.followupDays || {}) } },
    rates: { ...DEFAULT_CONFIG.rates, ...(raw.rates || {}) },
  };
}

export function saveConfig(config: RuntimeConfig): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

/** 现有设置通道的写入口：嵌套配置合并，CRM 数值在落盘前校验。 */
export function updateRuntimeConfig(input: unknown): Result<void> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return failResult("配置参数错误");
  try {
    const partial = input as Partial<RuntimeConfig>;
    if (partial.rates?.url !== undefined) {
      if (typeof partial.rates.url !== "string") return failResult("Navigator 地址必须是网址");
      try { partial.rates.url = validateNavigatorBase(partial.rates.url, true); }
      catch (error) {
        if (error instanceof NavigatorConfigurationError) return failResult(error.message);
        throw error;
      }
    }
    for (const value of [partial.crm?.silentOverdueDays, partial.crm?.warnDays]) {
      if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CRM_THRESHOLD_DAYS)) return failResult("跟进阈值须为 1–365 的整数");
    }
    const current = loadConfig();
    const crm = { ...current.crm, ...partial.crm, followupDays: { ...current.crm.followupDays, ...partial.crm?.followupDays } };
    if ((crm.warnDays ?? DEFAULT_CRM_WARN_DAYS) > (crm.silentOverdueDays ?? DEFAULT_CRM_OVERDUE_DAYS)) return failResult("预警天数不能大于逾期天数");
    saveConfig({ ...current, ...partial, crm,
      rates: { ...current.rates, ...partial.rates },
      schedule: { ...DEFAULT_SCHEDULE, ...current.schedule, ...partial.schedule },
      sentenceSubjects: { ...current.sentenceSubjects, ...partial.sentenceSubjects },
    });
    nudge();
    return okResult(undefined);
  } catch (error) {
    Log.error("config.update", "配置保存失败", error instanceof Error ? error.stack : undefined);
    return failResult("配置保存失败");
  }
}
