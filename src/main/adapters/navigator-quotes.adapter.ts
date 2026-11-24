// 主进程 IO 组合根；服务层通过注入端口编排实时查询。
import { randomUUID } from "crypto";
import { createNavigatorQueries } from "../services/navigator-quotes.service";
import { mapRemoteRow, mapRemoteSpace } from "../services/rate-sync.service";
import { queryNavigatorRates, requireNavigatorAuthorization, navigatorAuthorizationEpoch } from "./navigator-auth.adapter";
import { ensureNavigatorPartnerKey, navigatorPartnerEpoch, queryNavigatorPartnerRows } from "./navigator-partner.adapter";
const queries = createNavigatorQueries({
  authorize: async () => {
    try { await ensureNavigatorPartnerKey(); return { ok: true as const }; }
    catch { return requireNavigatorAuthorization(); }
  },
  query: async (filters, queryId, kind) => {
    if (kind === 'rates') {
      const result = await queryNavigatorPartnerRows(filters, queryId);
      if (result.ok) return result;
    }
    return queryNavigatorRates(filters, queryId, kind);
  },
  epoch: () => navigatorPartnerEpoch() + navigatorAuthorizationEpoch(), queryId: randomUUID, now: Date.now,
  mapRate: mapRemoteRow, mapSpace: mapRemoteSpace,
});
export const { listQuotes, listQuoteRaws, countQuotes, listSpaces } = queries;
