import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Tabs, message } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import { CampaignTasks } from "./CampaignTasks";
import { CampaignWizard } from "./CampaignWizard";
import { HistoryPage } from "../history/HistoryPage";

/**
 * 发送中心 — 开发任务为唯一操作入口。
 * 创建/编辑任务在子窗口（Modal 向导）内完成，配置好的任务组以卡片形式展示在开发任务页；
 * 发送引擎（队列的启动/暂停/止损横幅）以紧凑状态条内嵌在开发任务页顶部，不再单独设页。
 * 首页「自动开发信」跳转：#/campaigns?create=1 → 直接打开创建子窗口。
 */
export function SendCenter() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<string>(() => {
    const h = window.location.hash;
    const qs = h.includes("?") ? h.split("?")[1] : "";
    return new URLSearchParams(qs).get("tab") || "tasks";
  });
  const [wizardOpen, setWizardOpen] = useState(() => {
    const h = window.location.hash;
    const qs = h.includes("?") ? h.split("?")[1] : "";
    return new URLSearchParams(qs).get("create") === "1";
  });
  const [editingDraft, setEditingDraft] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const { data: interruptedData } = useQuery({
    queryKey: ["send", "interruptedBatch"],
    queryFn: () => window.api.invoke("send:getInterruptedBatch") as Promise<{
      success: boolean;
      data?: { batchId: string; startedAt: string; pendingGroups: number; pendingRecipients: number } | null;
    }>,
    refetchInterval: 15_000,
  });
  const interrupted = interruptedData?.success ? interruptedData.data ?? null : null;

  const recoverInterrupted = async () => {
    setRecovering(true);
    try {
      const result = await window.api.invoke("send:resumeInterruptedBatch") as { success: boolean; error?: string; data?: { queued?: number; queuedCount?: number } };
      if (!result.success) {
        message.error(result.error || "恢复失败");
        return;
      }
      message.success(`已恢复 ${result.data?.queued ?? 0} 组 / ${result.data?.queuedCount ?? 0} 位收件人的发送任务`);
      void qc.invalidateQueries({ queryKey: ["send"] });
      void qc.invalidateQueries({ queryKey: ["campaigns"] });
    } catch (err) {
      message.error(`恢复失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRecovering(false);
    }
  };

  return (
    <>
      {interrupted && (
        <Alert
          className="mb-3"
          type="warning"
          showIcon
          message="检测到上次中断的发送批次"
          description={`开始于 ${new Date(interrupted.startedAt).toLocaleString("zh-CN")}，${interrupted.pendingGroups} 组 / ${interrupted.pendingRecipients} 位收件人仍待发送。`}
          action={<Button type="primary" icon={<PlayCircleOutlined />} loading={recovering} onClick={() => { void recoverInterrupted(); }}>恢复此批次</Button>}
        />
      )}
      <Tabs
        activeKey={tab}
        onChange={setTab}
        size="small"
        items={[
          {
            key: "tasks", label: "开发任务",
            children: (
              <CampaignTasks
                onCreate={() => { setEditingDraft(null); setWizardOpen(true); }}
                onEdit={(id) => { setEditingDraft(id); setWizardOpen(true); }}
              />
            ),
          },
          { key: "history", label: "发送历史", children: <HistoryPage /> },
        ]}
      />
      <CampaignWizard
        key={`${editingDraft ?? "new"}-${wizardOpen}`}
        open={wizardOpen}
        draftId={editingDraft}
        onClose={() => setWizardOpen(false)}
        onDone={() => setWizardOpen(false)}
      />
    </>
  );
}
