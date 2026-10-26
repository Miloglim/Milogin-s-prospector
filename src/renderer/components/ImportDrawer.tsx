import {LEAD_IMPORT_FIELDS} from '../../../server/core/lead-import-fields';
import { invalidateDomain } from "../lib/cacheDeps";
import { useState, useRef, useContext } from "react";
import { Drawer, Tabs, Upload, Input, Button, Table, Select, message, Tag, Space } from "antd";
import { InboxOutlined } from "@ant-design/icons";
import { QueryClientContext } from "@tanstack/react-query";
import type { ColumnsType } from "antd/es/table";
import { ONLINE_LIMITS, type ImportFileContent } from "../../shared/online-crm";

const { TextArea } = Input;
const { Dragger } = Upload;
const FILE_ENCODING_CHUNK = 0x8000;

/** Center preview decodes original CSV bytes; local legacy import keeps its text contract. */
export async function readImportFile(file: File, center: boolean): Promise<ImportFileContent> {
  if (file.size > ONLINE_LIMITS.fileBytes) throw new Error('文件超过 10 MiB');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!['csv', 'xls', 'xlsx'].includes(extension ?? '')) throw new Error('请选择 CSV / XLSX 文件');
  const type = extension === 'csv' ? 'csv' : 'xlsx';
  if (type === 'csv' && !center) return { type, data: await file.text() };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > ONLINE_LIMITS.fileBytes) throw new Error('文件超过 10 MiB');
  const parts: string[] = [];
  for (let index = 0; index < bytes.length; index += FILE_ENCODING_CHUNK) parts.push(String.fromCharCode(...bytes.subarray(index, index + FILE_ENCODING_CHUNK)));
  return { type, data: btoa(parts.join('')), ...(center ? { encoding: 'base64' as const } : {}) };
}

// 字段别名指南 — 匹配旧 PE 的 guide-alias-grid（自 ImportPage 移植，两处合一）
const LEGACY_FIELD_ALIASES: { field: string; icon: string; codes: string[] }[] = [
  { field: "邮箱", icon: "✉️", codes: ["邮箱", "邮箱地址", "邮件", "收件人", "email", "e-mail", "to"] },
  { field: "公司名", icon: "🏢", codes: ["公司", "公司名称", "公司全称", "公司名", "客户名称", "客户", "company"] },
  { field: "联系人", icon: "👤", codes: ["姓名", "姓名 | 职位", "姓名职位", "联系人", "contact"] },
  { field: "名", icon: "👤", codes: ["名", "firstname", "first_name"] },
  { field: "姓", icon: "👤", codes: ["姓", "lastname", "last_name"] },
  { field: "职位", icon: "💼", codes: ["职位", "职务", "title", "position"] },
  { field: "电话", icon: "📞", codes: ["电话", "手机", "phone", "tel", "mobile"] },
  { field: "WhatsApp", icon: "💬", codes: ["WhatsApp", "Whats App", "whatsapp", "WA"] },
  { field: "国家", icon: "🌐", codes: ["国家", "country"] },
  { field: "业务类型", icon: "🏷️", codes: ["业务类型", "品类", "行业", "分类", "businessType", "category", "industry"] },
  { field: "网站", icon: "🔗", codes: ["网站", "网址", "官网", "website", "url"] },
  { field: "LinkedIn", icon: "🔗", codes: ["linkedin", "领英"] },
  { field: "一级来源", icon: "🏷️", codes: ["一级来源", "来源一级", "sourceLevel1"] },
  { field: "二级来源", icon: "🏷️", codes: ["二级来源", "来源二级", "sourceLevel2"] },
  { field: "跟进人", icon: "✅", codes: ["跟进人", "负责人", "assignee", "owner"] },
  { field: "对接人", icon: "👥", codes: ["对接人", "contact_person"] },
  { field: "阶段", icon: "🚩", codes: ["阶段", "stage"] },
  { field: "客户类型（代理/直客）", icon: "🚩", codes: ["客户类型", "联系人类型", "类型", "type", "client_type", "clienttype"] },
];

const FIELD_ALIASES = LEAD_IMPORT_FIELDS.map(field=>({field:field.label,icon:'',codes:[...field.aliases],group:field.group,hint:'hint' in field?field.hint:undefined}));

const FIELD_OPTIONS = [
  { value: "", label: "— 忽略 —" },
  { value: "email", label: "邮箱" },
  { value: "companyName", label: "公司" },
  { value: "firstName", label: "名" },
  { value: "lastName", label: "姓" },
  { value: "title", label: "职位" },
  { value: "phone", label: "电话" },
  { value: "country", label: "国家/语言" },
  { value: "stage", label: "发送阶段" },
  { value: "clientType", label: "客户类型（代理/直客）" },
  { value: "assignee", label: "负责人" },
];
const CENTER_FIELD_OPTIONS = [{value:'',label:'— 忽略 —'},...LEAD_IMPORT_FIELDS.map(field=>({value:field.key,label:field.label}))];

export interface PreviewData {
  headers: string[];
  previewRows: string[][];
  totalRows: number;
  suggestedMapping: Record<string, string>;
  duplicateEmails: string[];
}

type Step = "input" | "preview";

export interface ImportDrawerPort {
  preview(input:ImportFileContent):Promise<{success:boolean;data?:PreviewData;error?:string}>;
  execute(input:ImportFileContent & {mapping:Record<string,string>}):Promise<{success:boolean;data?:{imported:number;skipped:number};error?:string}>;
}
export function ImportDrawer({ open, onClose, port, disabled = false }: { open: boolean; onClose: () => void; port?:ImportDrawerPort; disabled?: boolean }) {
  const qc = useContext(QueryClientContext);
  const [step, setStep] = useState<Step>("input");
  const [inputTab, setInputTab] = useState<string>("file");
  const [pasteText, setPasteText] = useState("");
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // 缓存原始数据，execute 时重新送后端解析全部行
  const rawDataRef = useRef<ImportFileContent | null>(null);

  const reset = () => {
    setStep("input");
    setPasteText("");
    setPreview(null);
    setMapping({});
    setLoading(false);
    setImporting(false);
    rawDataRef.current = null;
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // 读取文件内容 → 送后端预览（P0-4: 不再把本地路径传给主进程，内容经 File API 读取）
  const processFile = async (file: File) => {
    setLoading(true);
    try {
      const content = await readImportFile(file, !!port);
      rawDataRef.current = content;
      const r = await (port ? port.preview(content) : window.api.invoke("contacts:import", { mode: "preview", ...content })) as {
        success: boolean; data?: PreviewData; error?: string;
      };
      if (r.success && r.data) {
        setPreview(r.data);
        setMapping(r.data.suggestedMapping);
        setStep("preview");
      } else {
        message.error(r.error || "解析失败");
      }
    } catch (err) {
      message.error("文件读取失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  // 粘贴文本 → 送后端预览
  const processPaste = async () => {
    if (!pasteText.trim()) return;
    setLoading(true);
    try {
      rawDataRef.current = { type: "tsv", data: pasteText };

      const r = await (port ? port.preview({type:"tsv",data:pasteText}) : window.api.invoke("contacts:import", {
        mode: "preview", type: "tsv", data: pasteText,
      })) as { success: boolean; data?: PreviewData; error?: string };
      if (r.success && r.data) {
        setPreview(r.data);
        setMapping(r.data.suggestedMapping);
        setStep("preview");
      } else {
        message.error(r.error || "解析失败");
      }
    } catch (err) {
      message.error("解析失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setLoading(false);
    }
  };

  // 确认导入 — 重新送原始数据 + 最终 mapping
  const executeImport = async () => {
    if (disabled) { message.error('导入需要连接服务器'); return; }
    if (!rawDataRef.current) return;
    setImporting(true);
    try {
      const r = await (port ? port.execute({...rawDataRef.current,mapping}) : window.api.invoke("contacts:import", {
        mode: "execute", ...rawDataRef.current, mapping,
      })) as { success: boolean; data?: { imported: number; skipped: number }; error?: string };

      if (r.success && r.data) {
        message.success(`导入 ${r.data.imported} 条，跳过 ${r.data.skipped} 条（重复）`);
        if (!port && qc) void invalidateDomain(qc, "contacts");
        handleClose();
      } else {
        message.error(r.error || "导入失败");
      }
    } catch (err) {
      message.error("导入失败: " + (err instanceof Error ? err.message : String(err)));
    } finally {
      setImporting(false);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const columns: ColumnsType<any> = preview
    ? preview.headers.map((h) => ({
        title: (
          <Select
            size="small"
            value={mapping[h] || ""}
            onChange={(v) => setMapping(prev => ({ ...prev, [h]: v }))}
            aria-label={`映射 ${h}`}
            options={port ? CENTER_FIELD_OPTIONS : FIELD_OPTIONS}
            className="w-24"
            popupMatchSelectWidth={false}
          />
        ),
        key: h,
        dataIndex: h,
        width: 130,
        ellipsis: true,
        render: (v: string) => (
          <span className={`contact-import-value text-xs ${!v ? "text-gray-300" : "text-gray-700"}`} title={v || undefined}>
            {v || "—"}
          </span>
        ),
      }))
    : [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataSource: any[] = preview
    ? preview.previewRows.map((row, idx) => {
        const obj: Record<string, string | number> = { __idx: idx };
        preview.headers.forEach((h, i) => { obj[h] = row[i] || ""; });
        return obj;
      })
    : [];

  const dupCount = preview?.duplicateEmails.length || 0;
  const newCount = preview ? preview.totalRows - dupCount : 0;
  const emailMapped = preview?.headers.some(h => mapping[h] === "email");
  const readyToImport = port ? Object.values(mapping).includes('companyName') && ['email','name','firstName','lastName','phone','whatsapp'].some(field=>Object.values(mapping).includes(field)) : emailMapped;
  const drawerWidth = step === "input" ? "min(620px, calc(100vw - 24px))" : "min(1180px, calc(100vw - 24px))";

  return (
    <Drawer rootClassName="app-drawer-below-titlebar" title="导入联系人" open={open} onClose={handleClose}
      width={drawerWidth}
      footer={step === "preview" && preview ? <div className="flex justify-end">
        <Space>
          <Button size="small" onClick={() => setStep("input")}>返回</Button>
          <Button type="primary" size="small"
            loading={importing}
            disabled={!readyToImport || disabled}
            onClick={executeImport}>
            确认导入 {newCount} 条
          </Button>
        </Space>
      </div> : undefined}
    >
      {step === "input" && (
        <div className="space-y-4">
          <Tabs activeKey={inputTab} onChange={setInputTab} size="small"
          items={[
            {
              key: "file",
              label: "上传文件",
              children: (
                <div className="space-y-4 pt-4">
                  <Dragger
                    accept=".csv,.xlsx,.xls"
                    maxCount={1}
                    beforeUpload={(file) => { processFile(file); return false; }}
                    showUploadList={false}
                  >
                    <p className="text-3xl text-gray-300 mb-2"><InboxOutlined /></p>
                    <p className="text-xs text-gray-500">点击或拖拽 CSV / XLSX 文件到此处</p>
                  </Dragger>
                </div>
              ),
            },
            {
              key: "paste",
              label: "粘贴数据",
              children: (
                <div className="space-y-4 pt-4">
                  <TextArea
                    rows={14}
                    placeholder={`从 Excel 复制后粘贴到这里（Tab 分隔，第一行为表头）\n\n示例：\n邮箱\t公司\t名\t姓\njohn@acme.com\tACME\tJohn\tSmith`}
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                  />
                  <Button type="primary" size="small" block
                    loading={loading}
                    disabled={!pasteText.trim()}
                    onClick={processPaste}>
                    解析预览
                  </Button>
                </div>
              ),
            },
          ]}
        />

        {/* 字段识别指南（自 ImportPage 移植） */}
        <details className="rounded-lg border border-gray-200 bg-white p-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-xs font-semibold text-gray-500 [&::-webkit-details-marker]:hidden">
            <span>字段识别说明</span>
            <span className="text-[11px] font-normal text-gray-400">查看支持的列名</span>
          </summary>
          <p className="mb-3 mt-3 text-[11px] text-gray-400">
            第一行为表头，系统会自动匹配中英文列名并忽略大小写与空格。
            {port ? '未匹配的非空列会自动汇总为联系人备注。' : '未匹配的列保留在「额外信息」中。'}
          </p>
          {(port ? [
            {title:'公司资料',fields:FIELD_ALIASES.filter(field=>field.group==='company')},
            {title:'联系人与线索来源',fields:FIELD_ALIASES.filter(field=>field.group==='contact')},
          ] : [{title:'',fields:LEGACY_FIELD_ALIASES}]).map(group=><section key={group.title} className="mt-4 first:mt-0">
            {group.title && <h3 className="mb-2 border-b border-gray-100 pb-2 text-xs font-medium text-gray-700">{group.title}</h3>}
            <div className="grid grid-cols-1 gap-x-5 sm:grid-cols-2">
              {group.fields.map(fa=><div key={fa.field} className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-2 border-b border-gray-100/80 py-2 text-[11px]">
                <span className="pt-0.5 font-medium leading-5 text-gray-600">{fa.field}{'hint' in fa && fa.hint ? <small className="block font-normal text-gray-400">{String(fa.hint)}</small> : null}</span>
                <span className="flex min-w-0 flex-wrap gap-1">{fa.codes.map(code=><code key={code} className="rounded bg-gray-50 px-1.5 py-0.5 text-[10px] leading-4 text-gray-500">{code}</code>)}</span>
              </div>)}
            </div>
          </section>)}
        </details>
        </div>
      )}

      {step === "preview" && preview && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 text-xs flex-wrap">
            <Tag color="blue">共 {preview.totalRows} 行</Tag>
            <Tag color="green">{port ? "待处理" : "新增"} {newCount} 条</Tag>
            {dupCount > 0 && <Tag color="orange">重复 {dupCount} 条（跳过）</Tag>}
            {!readyToImport && <Tag color="red">{port ? "请选择公司及联系人姓名或联系方式" : "未映射邮箱列"}</Tag>}
          </div>

          {preview.previewRows.length < preview.totalRows && (
            <div className="text-[11px] text-gray-400">
              预览前 {preview.previewRows.length} 行（共 {preview.totalRows} 行），每列下拉可调整字段映射
            </div>
          )}

          <Table
            columns={columns}
            dataSource={dataSource}
            rowKey="__idx"
            size="small"
            tableLayout="fixed"
            scroll={{ x: preview.headers.length * 130 }}
            pagination={false}
            className="contact-import-preview-table [&_.ant-table-thead>tr>th]:!text-[10px] [&_.ant-table-thead>tr>th]:!p-1"
          />

        </div>
      )}
    </Drawer>
  );
}
