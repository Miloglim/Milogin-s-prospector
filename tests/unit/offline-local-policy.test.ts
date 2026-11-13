import { describe, expect, it } from 'vitest';
import { offlineLocalChannelAllowed } from '../../src/main/core/offline-local-policy';
import { IPC } from '../../src/main/contract';

describe('offline local channel policy', () => {
  it('allows inbox state changes that only write the local workspace', () => {
    for (const channel of [
      IPC.INBOX.CLASSIFY,
      IPC.INBOX.MARK_READ,
      IPC.INBOX.LABELS,
      IPC.INBOX.LABEL_SAVE,
      IPC.INBOX.MESSAGE_LABELS,
      IPC.INBOX.PIN_MESSAGE,
      IPC.INBOX.TODO_STATE,
      IPC.INBOX.TODO_STATE_BATCH,
      IPC.INBOX.ANALYSIS_RUN,
    ]) expect(offlineLocalChannelAllowed(channel)).toBe(true);
  });

  it('keeps mailbox fetching and real delivery blocked while offline', () => {
    for (const channel of [
      IPC.INBOX.FETCH,
      IPC.INBOX.SYNC_HISTORY,
      IPC.SEND.START,
      IPC.SEND.DYNAMIC,
      IPC.SEND.RESUME,
      IPC.SEND.RESUME_QUEUE,
    ]) expect(offlineLocalChannelAllowed(channel)).toBe(false);
  });
});
