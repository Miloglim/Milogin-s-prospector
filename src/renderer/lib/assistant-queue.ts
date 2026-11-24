import type { AssistantReminder } from '../../shared/assistant';

/** IPC 成功包统一是 { success, data }，旧调用习惯里的 { ok, data } 也兼容。 */
export function assistantQueueItems(result: unknown): AssistantReminder[] | null {
  if (!result || typeof result !== 'object') return null;
  const value = result as { success?: unknown; ok?: unknown; data?: unknown };
  if (value.success !== true && value.ok !== true) return null;
  return Array.isArray(value.data) ? value.data as AssistantReminder[] : null;
}
