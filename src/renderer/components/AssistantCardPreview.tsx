import { App, Modal } from 'antd';
import { AssistantActionCard, AssistantAttentionList } from './AssistantBriefingCards';
import type { AssistantReminder } from '../../shared/assistant';
import { buildRandomAssistantMock, clearAssistantMock, saveAssistantMock } from '../lib/dev-assistant-mock';
import { useOptionalIdentity } from '../IdentityContext';

const PREVIEW_ITEMS: AssistantReminder[] = buildRandomAssistantMock(10);
const ACTION_SAMPLES = PREVIEW_ITEMS.slice(0, 4);
const ATTENTION_SAMPLES = PREVIEW_ITEMS.slice(4);

export function AssistantCardPreview({ open, onClose }: { open: boolean; onClose: () => void }) {
  const identity = useOptionalIdentity()?.identity ?? null;
  const userId = identity?.userId ?? null;
  const { message } = App.useApp();
  const hint = () => { message.info('预览模式：真实页面会打开对应事项'); };
  const generate = () => {
    saveAssistantMock(buildRandomAssistantMock(10), userId);
    if (window.location.hash !== '#/assistant') window.location.hash = '#/assistant';
    onClose();
    message.success('已生成 10 条随机 Mock，正在任务页展示');
  };
  const clear = () => {
    clearAssistantMock(userId);
    onClose();
    message.success('已清除 Mock，恢复真实提醒');
  };
  return <Modal open={open} title="卡片预览" width={760} footer={null} onCancel={onClose} destroyOnHidden>
    <div className="flex max-h-[72vh] flex-col gap-5 overflow-y-auto pr-1">
      <div className="flex items-center gap-2 border-b border-gray-100 pb-3">
        <button type="button" onClick={generate} className="rounded-md bg-teal-700 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-teal-800">生成 10 条随机 Mock</button>
        <button type="button" onClick={clear} className="rounded-md border border-gray-200 px-3 py-1.5 text-[12px] text-gray-600 hover:border-gray-300">清除 Mock</button>
        <span className="ml-auto text-[10px] text-gray-400">Mock 会替换任务页的真实提醒</span>
      </div>
      <section>
        <div className="text-[11px] text-gray-400">四种行动卡：邮件回复 / 报价确认 / 到期待办 / 停滞跟进</div>
        <div className="mt-2 flex flex-col gap-2">
          {ACTION_SAMPLES.map(item => <AssistantActionCard key={item.reminderId} item={item}
            onOpen={hint}
            onAsk={() => { message.info('预览模式：真实页面会把它交给助手'); }}
            onDismiss={hint} />)}
        </div>
      </section>
      <section>
        <AssistantAttentionList items={ATTENTION_SAMPLES} onOpen={hint} />
        <p className="mt-2 px-1 text-[11px] text-gray-400">真实提醒只保留最优先的 3 条；预览用 6 条检查折叠。超过 4 条会折叠，展开后按原顺序显示，长标题和长详情在窄窗口里截断，不挤压右侧箭头。</p>
      </section>
      <p className="px-1 text-[11px] text-gray-400">预览只使用示例数据，不会写入提醒结果，也不会跳转或发送任何内容。</p>
    </div>
  </Modal>;
}
