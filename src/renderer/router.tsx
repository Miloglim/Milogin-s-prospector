import { createRootRoute, createRoute, createRouter, createHashHistory, Outlet, redirect } from "@tanstack/react-router";
import { AppLayout } from "./components/layout/AppLayout";
import { AssistantTasksPage } from "./pages/assistant/AssistantTasksPage";
import { LegacyCustomersPage } from "./pages/customers/LegacyCustomersPage";
import { InboxList } from "./pages/inbox/InboxList";
import { RateBoard } from "./pages/rates/RateBoard";
import { SendCenter } from "./pages/campaigns/SendCenter";
import { SettingsPage } from "./pages/settings/SettingsPage";
import { AccountProfilePage } from './pages/settings/AccountProfilePage';
import { TeamWorkspace } from './pages/team/TeamWorkspace';
import { PRODUCT_EDITION, productEditionAllowsPath } from './lib/product-edition';
import { teamSectionSearch } from '../shared/team-workspace';

import { MessagesPage } from './pages/messages/MessagesPage';

const rootRoute = createRootRoute({
  component: () => <AppLayout />,
  beforeLoad: ({ location }) => {
    if (!productEditionAllowsPath(PRODUCT_EDITION, location.pathname)) throw redirect({ to: '/customers' });
  },
});

const homeRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => { throw redirect({ to: '/assistant' }); },
});

const assistantRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/assistant",
  component: AssistantTasksPage,
});

const customersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers",
  component: LegacyCustomersPage,
  validateSearch: (search: Record<string, unknown>) => ({ customerId: typeof search.customerId === 'string' ? search.customerId : undefined, taskId: typeof search.taskId === 'string' ? search.taskId : undefined, opportunityId: typeof search.opportunityId === 'string' ? search.opportunityId : undefined }),
});

const teamRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/team",
  component: TeamRoutePage,
  validateSearch: teamSectionSearch,
});

function TeamRoutePage() {
  const search = teamRoute.useSearch();
  return <TeamWorkspace requestedSection={search.section} />;
}

const onlineCustomersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/customers-online",
  beforeLoad: () => { throw redirect({ to: '/customers' }); },
});

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/inbox",
  component: InboxList,
});

const ratesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/rates",
  component: RateBoard,
});

const campaignsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/campaigns",
  component: SendCenter,
});

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/templates",
  beforeLoad: () => { throw redirect({ to: '/campaigns', search: { tab: 'templates' } }); },
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/customers-preview', beforeLoad: () => { throw redirect({ to: '/customers' }); } }),
  createRoute({ getParentRoute: () => rootRoute, path: '/messages', component: MessagesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/account', component: AccountProfilePage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/online', beforeLoad: () => { throw redirect({ to: '/customers-online' }); } }),
  homeRedirectRoute,
  assistantRoute,
  customersRoute,
  teamRoute,
  onlineCustomersRoute,
  inboxRoute,
  ratesRoute,
  campaignsRoute,
  templatesRoute,
  settingsRoute,
]);

/** 冷启动默认页 = 新对话：地址里没有路由（无 hash 或裸 "#/"）时，先把地址定到 /assistant 再建 router。
 *  只改首屏落地——深链（#/inbox?… 等）照旧直达；旧的 #/ 入口另由 homeRedirectRoute 兼容跳转。
 *  用 replaceState 而非改 location：不新增历史记录、不触发 hashchange（此刻 router 还没挂）。 */
const bootHash = window.location.hash;
if (bootHash === "" || bootHash === "#" || bootHash === "#/") {
  window.history.replaceState(null, "", "#/assistant");
}

export const router = createRouter({ routeTree, history: createHashHistory() });

/** 路由级 keep-alive 注册表（AppLayout 消费）：页面切走后保持挂载、只隐藏。
 *  只保留发送中心：发送任务在后台运行时页面离开不能重建大选人树；客户页改为离开即卸载，依靠查询缓存恢复。
 *  治的实测问题：发送中心每次从别的页面回来整树重挂 —— 8634+ 行选人表重新初始化、
 *  队列页查询回到 loading 态闪「正在发送」转圈，而真正的发送一直在主进程后台跑着。 */
export const KEEPALIVE_ROUTE_COMPONENTS: Record<string, React.ComponentType> = {
  "/campaigns": SendCenter,
};

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
