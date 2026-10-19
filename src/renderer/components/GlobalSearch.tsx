import { useState } from "react";
import { Alert, Empty, Input, Modal, Spin, Typography, theme } from "antd";
import { MailOutlined, FileTextOutlined, UserOutlined, RightOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import type { GlobalSearchData, SearchHit } from "../../shared/search";

const GROUPS = [{ key: "email", label: "邮件", icon: MailOutlined }, { key: "note", label: "跟进", icon: FileTextOutlined }, { key: "contact", label: "联系人", icon: UserOutlined }] as const;
const RESULT_MAX_HEIGHT = "min(52vh, 440px)";

function Highlight({ text }: { text: string }) {
  const { token } = theme.useToken();
  return <>{text.split(/(\u0001[^\u0002]*\u0002)/).map((part, i) => part.startsWith("\u0001")
    ? <mark key={i} style={{ background: token.colorFillSecondary, color: token.colorText, fontWeight: token.fontWeightStrong, borderRadius: token.borderRadiusSM }}>{part.slice(1, -1)}</mark> : <span key={i}>{part}</span>)}</>;
}

export function GlobalSearch({ trigger }: { trigger: (onClick: () => void, active: boolean) => React.ReactNode }) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data, isFetching, error } = useQuery({
    queryKey: ["search", "global", submitted],
    queryFn: () => window.api.invoke("search:global", { query: submitted }) as Promise<{ success: boolean; data?: GlobalSearchData; error?: string }>,
    enabled: open && !!submitted,
  });
  const jump = (hit: SearchHit) => {
    setOpen(false);
    window.location.hash = hit.kind === "email" ? `#/inbox?detail=${hit.sourceId}`
      : hit.dataSource === 'center' && hit.customerId ? `#/customers?view=table&centerContact=${hit.contactId}&centerCustomer=${encodeURIComponent(hit.customerId)}`
      : `#/customers?view=${hit.kind === "note" ? "board" : "table"}&detail=${hit.contactId}`;
  };
  const search = () => setSubmitted(query.trim());
  const failure = error ? error.message : data && !data.success ? data.error : undefined;
  const groups = GROUPS.filter(group => data?.data?.[group.key].length);
  return <>
    {trigger(() => setOpen(true), open)}
    <Modal title="全局搜索" open={open} onCancel={() => setOpen(false)} footer={null} width={680}>
      <Input.Search autoFocus placeholder="搜索邮件、跟进记录、联系人" value={query} maxLength={200}
        onChange={e => setQuery(e.target.value)} onSearch={search} enterButton="搜索" loading={isFetching} />
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
        搜索本地已有数据；邮件正文未缓存时只搜索预览。
      </Typography.Paragraph>
      {failure && <Alert type="error" showIcon message={failure} />}
      {isFetching ? <div style={{ padding: token.paddingLG, textAlign: "center" }}><Spin /></div> : submitted && data?.success && <>
        {data.data?.truncated && <Alert type="info" message="结果较多，每组显示前 20 条，请细化关键词。" />}
        {!groups.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到相关内容" /> :
          <div style={{ maxHeight: RESULT_MAX_HEIGHT, overflowY: "auto", marginTop: token.marginSM }}>
            {groups.map(group => <section key={group.key} aria-label={group.label}>
              <div style={{ display: "flex", alignItems: "center", gap: token.marginXS, padding: `${token.paddingSM}px ${token.paddingXS}px`, color: token.colorTextSecondary, fontSize: token.fontSizeSM }}>
                <group.icon /><span>{group.label}</span><span style={{ color: token.colorTextTertiary }}>{data.data?.[group.key].length}</span>
              </div>
              {data.data?.[group.key].map(hit => <button key={hit.sourceId} type="button" className="global-search-hit" aria-label={hit.title} onClick={() => jump(hit)}
                style={{ "--search-hit-hover": token.colorFillTertiary, "--search-hit-focus": token.colorPrimary,
                  display: "flex", alignItems: "center", gap: token.marginSM, width: "100%", textAlign: "left", cursor: "pointer", background: "transparent", border: "none", borderBottom: `${token.lineWidth}px solid ${token.colorBorderSecondary}`, borderRadius: token.borderRadiusSM, padding: token.paddingSM, font: "inherit", color: token.colorText } as React.CSSProperties}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span title={hit.title} style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: token.fontWeightStrong, marginBottom: token.marginXXS }}>{hit.title}</span>
                  <span className="global-search-snippet" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere", color: token.colorTextSecondary, fontSize: token.fontSizeSM, lineHeight: token.lineHeightSM }}><Highlight text={hit.snippet.replace(/\s+/g, " ").trim()} /></span>
                </span>
                <RightOutlined style={{ color: token.colorTextQuaternary, fontSize: token.fontSizeSM }} />
              </button>)}
            </section>)}
          </div>}
      </>}
    </Modal>
  </>;
}
