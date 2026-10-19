// 主进程 IO 组合根；服务层通过注入端口编排实时查询。
import { randomUUID } from "crypto";
import { createNavigatorQueries } from "../services/navigator-quotes.service";
import { mapRemoteRow, mapRemoteSpace } from "../services/rate-sync.service";
import { queryNavigatorRates, requireNavigatorAuthorization, navigatorAuthorizationEpoch } from "./navigator-auth.adapter";
const queries = createNavigatorQueries({
  authorize: requireNavigatorAuthorization, query: queryNavigatorRates,
  epoch: navigatorAuthorizationEpoch, queryId: randomUUID, now: Date.now,
  mapRate: mapRemoteRow, mapSpace: mapRemoteSpace,
});
export const { listQuotes, listQuoteRaws, countQuotes, listSpaces } = queries;
