import { AssistantReminders } from '../../components/AssistantReminders';

/** 任务页：只展示可执行任务和结构化卡片，不再承载聊天输入。 */
export function AssistantTasksPage() {
  return <div className="h-full min-h-0 overflow-hidden bg-white" aria-label="任务">
    <AssistantReminders variant="workspace" />
  </div>;
}
