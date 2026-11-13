import { emptyDeviceHandoffSummary, type DeviceHandoffSummary } from '../../../server/core/device-handoff';
import { getRawDb } from '../db';
import { Log } from '../logger';

export function inspectLocalHandoffData(): DeviceHandoffSummary {
  try {
    const raw = getRawDb();
    const count = (sql: string) => {
      const row = raw.prepare(sql).get() as { count: number } | undefined;
      return Number(row?.count ?? 0);
    };
    return {
      checkedAt: new Date().toISOString(),
      counts: {
        contactPending: 0,
        contactFailed: 0,
        offlinePending: 0,
        offlineFailed: 0,
        templates: count('SELECT count(*) AS count FROM templates WHERE is_active=1'),
        inboxLabels: count('SELECT count(*) AS count FROM inbox_labels'),
        queuedSends: count("SELECT count(*) AS count FROM send_queue WHERE status IN ('pending','sending','failed')"),
        activeCampaigns: count("SELECT count(*) AS count FROM send_campaigns WHERE status NOT IN ('done','stopped','completed','cancelled')"),
        pendingMailChanges: count("SELECT count(*) AS count FROM inbox_classification_changes WHERE status='pending'"),
      },
      blockers: [],
    };
  } catch (error) {
    Log.warn('online.handoff', `本地数据盘点失败 ${error instanceof Error ? error.name : 'unknown'}`);
    return { ...emptyDeviceHandoffSummary(), blockers: ['原电脑本地数据暂时无法读取，请确认数据已经同步后再继续'] };
  }
}
