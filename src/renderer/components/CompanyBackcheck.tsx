import { invalidateDomain } from "../lib/cacheDeps";
import { useState } from "react";
import { Button, Modal, Form, Input, Rate, Tag, message, Empty, Alert } from "antd";
import { SafetyCertificateOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";

export interface BackcheckReport {
  summary: string;
  importActivity: string;
  categories: string[];
  logisticsFit: string;
  rating: number;
  risk: string[];
  sources: Array<{ title: string; url: string }>;
}

export interface CompanyRow {
  id: number;
  name: string;
  domain: string | null;
  backcheckData: string | null;
}

/** 联系人详情里的"公司背调"卡片；当前仅在界面隐藏，后端与历史报告保留。 */
export const COMPANY_BACKCHECK_UI_ENABLED = false;

export function CompanyBackcheck({ companyId, centerCompany, run }: { companyId: number | null; centerCompany?: CompanyRow; run?: (input: {companyName:string;website?:string;country?:string}) => Promise<{success:boolean;error?:string}> }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm();
  const [running, setRunning] = useState(false);

  // 公司信息 + 已有背调报告
  const { data: companyData, isLoading } = useQuery({
    queryKey: ["companies", companyId],
    queryFn: () => window.api.invoke("companies:getById", companyId) as Promise<{
      success: boolean; data?: CompanyRow; error?: string;
    }>,
    enabled: !centerCompany && !!companyId && companyId > 0,
  });

  const company = centerCompany ?? (companyData?.success ? companyData.data : null);
  let report: BackcheckReport | null = null;
  if (company?.backcheckData) {
    try { report = JSON.parse(company.backcheckData) as BackcheckReport; } catch { /* 坏 JSON 忽略 */ }
  }

  const handleRun = async () => {
    const v = await form.validateFields();
    setRunning(true);
    try {
      if (run) {
        const result = await run(v);
        if (result.success) { message.success('背调完成'); setOpen(false); form.resetFields(); } else message.error(result.error || '背调失败');
        return;
      }
      const r = await window.api.invoke("ai:backcheck", {
        companyName: v.companyName, website: v.website, country: v.country,
      }) as { success: boolean; data?: { report: BackcheckReport; companyId: number }; error?: string };
      if (r?.success && r.data) {
        message.success("背调完成");
        setOpen(false);
        form.resetFields();
        // 刷新公司查询（新 companyId 或更新后的 backcheckData）
        void invalidateDomain(qc, "contacts");
      } else {
        message.error(r?.error || "背调失败");
      }
    } catch {
      message.error("背调失败");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded border border-gray-100 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-gray-50 border-b border-gray-100">
        <span className="text-[11px] font-semibold text-gray-600 flex items-center gap-1.5">
          <SafetyCertificateOutlined /> 公司背调
        </span>
        <Button size="small" type={report ? "default" : "primary"} icon={<ThunderboltOutlined />}
          disabled={!!centerCompany && !run}
          loading={running}
          onClick={() => {
            form.setFieldsValue({
              companyName: company?.name || "",
              website: company?.domain || "",
            });
            setOpen(true);
          }}
        >{report ? "重新背调" : "开始背调"}</Button>
      </div>

      <div className="p-3">
        {isLoading ? <div className="text-xs text-gray-400 py-2 text-center">加载中...</div> :
          !report ? (
            <Empty description="尚未背调" image={Empty.PRESENTED_IMAGE_SIMPLE}
              imageStyle={{ height: 40 }} className="my-2" />
          ) : (
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <Rate disabled allowHalf value={report.rating} style={{ fontSize: 12 }} />
                <span className="text-[10px] text-gray-400">契合度</span>
              </div>
              <div className="text-gray-700 leading-relaxed">{report.summary}</div>
              <div className="text-gray-600">
                <b>进口活跃度：</b>{report.importActivity}
              </div>
              <div>
                <b className="text-gray-600">主营品类：</b>
                {report.categories?.map((c, i) => <Tag key={i} className="text-[10px] my-0">{c}</Tag>)}
              </div>
              <div className="text-gray-600">
                <b>货代契合点：</b>{report.logisticsFit}
              </div>
              {report.risk && report.risk.length > 0 && (
                <div className="text-gray-600">
                  <b>注意点：</b>
                  {report.risk.map((r, i) => <span key={i} className="text-red-500">{i > 0 ? "；" : ""}{r}</span>)}
                </div>
              )}
              {report.sources && report.sources.length > 0 && (
                <div className="pt-1">
                  <div className="text-[10px] text-gray-400 mb-1">来源：</div>
                  {report.sources.map((s, i) => (
                    <div key={i}>
                      <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-500 text-[10px] line-clamp-1">
                        {s.title || s.url}
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        }
      </div>

      {/* 背调弹窗 */}
      <Modal title="公司背调" open={open} onCancel={() => setOpen(false)}
        onOk={handleRun} okText="开始背调" confirmLoading={running}
        width={420}
      >
        <Alert type="info" showIcon className="mb-3"
          message="搜索公司资料并生成背调报告" />
        <Form form={form} layout="vertical" size="small">
          <Form.Item name="companyName" label="公司名" rules={[{ required: true }]}>
            <Input placeholder="如 ABC Logistics" />
          </Form.Item>
          <Form.Item name="website" label="网站（可选）">
            <Input placeholder="https://abclogistics.com" />
          </Form.Item>
          <Form.Item name="country" label="国家/地区（可选）">
            <Input placeholder="如 Brazil" maxLength={30} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
