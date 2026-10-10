import { expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { invalidateDomain } from "../../src/renderer/lib/cacheDeps";

it("收信、发信和配置变化会刷新保活的 CRM 查询", async () => {
  const qc = new QueryClient(); let follow = "old";
  const observer = new QueryObserver(qc, { queryKey: ["crm", "pipeline"], queryFn: async () => follow, staleTime: Infinity });
  const stop = observer.subscribe(() => {}); await observer.refetch();
  follow = "reply"; await invalidateDomain(qc, "inbox"); expect(qc.getQueryData(["crm", "pipeline"])).toBe("reply");
  follow = "sent"; await invalidateDomain(qc, "send"); expect(qc.getQueryData(["crm", "pipeline"])).toBe("sent");
  follow = "threshold 7"; await invalidateDomain(qc, "settings"); expect(qc.getQueryData(["crm", "pipeline"])).toBe("threshold 7");
  stop(); qc.clear();
});
it("删除联系人也使收件箱、仪表盘和发送资格缓存失效", async () => {
  const qc = new QueryClient();
  for (const key of ["inbox", "crm", "dashboard", "send", "contacts", "search"]) qc.setQueryData([key, "detail"], "old");
  await invalidateDomain(qc, "contacts");
  for (const key of ["inbox", "crm", "dashboard", "send", "contacts", "search"]) expect(qc.getQueryState([key, "detail"])?.isInvalidated).toBe(true);
  qc.clear();
});
