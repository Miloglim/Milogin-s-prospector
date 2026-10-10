import { useState } from "react";
import { Alert, Button, Empty, Input, List, Modal, Spin, Typography } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import type { GlobalSearchData, SearchHit } from "../../shared/search";

const GROUPS = [{ key: "email", label: "邮件" }, { key: "note", label: "跟进" }, { key: "contact", label: "联系人" }] as const;

function Highlight({ text }: { text: string }) {
  return <>{text.split(/(\u0001[^\u0002]*\u0002)/).map((part, i) => part.startsWith("\u0001")
    ? <mark key={i}>{part.slice(1, -1)}</mark> : <span key={i}>{part}</span>)}</>;
}

export function GlobalSearch({ collapsed = false }: { collapsed?: boolean }) {
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
      : `#/customers?view=${hit.kind === "note" ? "board" : "table"}&detail=${hit.contactId}`;
  };
  const search = () => setSubmitted(query.trim());
  const failure = error ? error.message : data && !data.success ? data.error : undefined;
  return <>
    <Button type="text" icon={<SearchOutlined />} title="全局搜索" aria-label="全局搜索"
      style={{ color: "#bbb", margin: collapsed ? "0 auto 8px" : "0 12px 8px" }} onClick={() => setOpen(true)}>
      {!collapsed && "全局搜索"}
    </Button>
    <Modal title="全局搜索" open={open} onCancel={() => setOpen(false)} footer={null} width={680}>
      <Input.Search autoFocus placeholder="搜索邮件、跟进记录、联系人" value={query} maxLength={200}
        onChange={e => setQuery(e.target.value)} onSearch={search} enterButton="搜索" loading={isFetching} />
      <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
        搜索本地已有数据；邮件正文未缓存时只搜索预览。
      </Typography.Paragraph>
      {failure && <Alert type="error" showIcon message={failure} />}
      {isFetching ? <Spin /> : submitted && data?.success && <>
        {data.data?.truncated && <Alert type="info" message="结果较多，每组显示前 20 条，请细化关键词。" />}
        {GROUPS.map(group => <div key={group.key}>
          <Typography.Title level={5}>{group.label}（{data.data?.[group.key].length || 0}）</Typography.Title>
          <List dataSource={data.data?.[group.key] || []} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无匹配" /> }}
            renderItem={hit => <List.Item>
              <div style={{ width: "100%" }}>
                <Button type="link" style={{ padding: 0, maxWidth: "100%" }} onClick={() => jump(hit)}>{hit.title}</Button>
                <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "#6b6b6b" }}><Highlight text={hit.snippet} /></div>
              </div>
            </List.Item>} />
        </div>)}
      </>}
    </Modal>
  </>;
}
