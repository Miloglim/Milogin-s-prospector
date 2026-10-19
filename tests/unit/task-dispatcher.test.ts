import { afterEach,describe,expect,it,vi } from 'vitest';
import { startTaskDispatcher } from '../../server/adapters/task-dispatcher';
import type { TaskService } from '../../server/services/tasks';
import { success,failure } from '../../server/core/crm';
import { TASK_LIMITS } from '../../server/core/tasks';
const INTERVAL_MS=TASK_LIMITS.poll_seconds*1000;
afterEach(()=>vi.useRealTimers());
describe('center task worker lifecycle',()=>{
 it('starts immediately without desktop, retries after bounded scan, and stops future work',async()=>{
  vi.useFakeTimers();const processDue=vi.fn().mockResolvedValue(success(0)),log={write:vi.fn()};
  const worker=startTaskDispatcher({processDue} as unknown as TaskService,log);expect(processDue).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(INTERVAL_MS);expect(processDue).toHaveBeenCalledTimes(2);expect(log.write).not.toHaveBeenCalled();
  await worker.stop();await vi.advanceTimersByTimeAsync(INTERVAL_MS*2);expect(processDue).toHaveBeenCalledTimes(2);
 });
 it('never overlaps an active scan and stop waits for its result without scheduling a new scan',async()=>{
  vi.useFakeTimers();let resolve!:(value:ReturnType<typeof success<number>>)=>void;
  const processDue=vi.fn(()=>new Promise<ReturnType<typeof success<number>>>(r=>{resolve=r;})),log={write:vi.fn()};
  const worker=startTaskDispatcher({processDue} as unknown as TaskService,log);
  await vi.advanceTimersByTimeAsync(INTERVAL_MS*3);expect(processDue).toHaveBeenCalledTimes(1);
  let stopped=false;const stopping=worker.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
  resolve(success(1));await stopping;expect(stopped).toBe(true);await vi.advanceTimersByTimeAsync(INTERVAL_MS*2);expect(processDue).toHaveBeenCalledTimes(1);
 });
 it('reports actionable errors and continues subsequent scans',async()=>{
  vi.useFakeTimers();const processDue=vi.fn().mockResolvedValueOnce(failure('DATABASE_ERROR','temporary')).mockRejectedValueOnce(Error('synthetic')).mockResolvedValue(success(0));
  const log={write:vi.fn()},worker=startTaskDispatcher({processDue} as unknown as TaskService,log);
  await vi.advanceTimersByTimeAsync(INTERVAL_MS);expect(log.write).toHaveBeenCalledWith('WARN','tasks.dispatch',expect.any(String));expect(log.write).toHaveBeenCalledWith('ERROR','tasks.dispatch',expect.any(String));
  await vi.advanceTimersByTimeAsync(INTERVAL_MS);expect(processDue).toHaveBeenCalledTimes(3);await worker.stop();
 });
});
