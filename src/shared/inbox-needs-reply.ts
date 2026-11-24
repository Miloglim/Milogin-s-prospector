import type { InboxAnalysisView, InboxTodoState } from './inbox';

export interface InboxNeedsReplyMail {
  classification: string | null;
  isRead: boolean;
  myRole?: string | null;
  todoState?: InboxTodoState | null;
  analysis?: Pick<InboxAnalysisView, 'status' | 'category' | 'priority' | 'requiresAction' | 'dueHint'> | null;
}

export function inboxMailNeedsReply(mail: InboxNeedsReplyMail): boolean {
  return mail.myRole !== 'cc'
    && mail.classification !== 'sent'
    && mail.classification !== 'bounce'
    && mail.classification !== 'autoreply'
    && mail.analysis?.status === 'ready'
    && mail.analysis.requiresAction
    && mail.todoState !== 'done';
}
