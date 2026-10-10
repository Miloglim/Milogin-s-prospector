import { RouterProvider } from "@tanstack/react-router";
import { ConfigProvider, App as AntApp } from "antd";
import { AppProvider } from "./AppContext";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { invalidateDomain } from "./lib/cacheDeps";
import { router } from "./router";

export function App() {
  const qc = useQueryClient();
  useEffect(() => {
    // 路由尚未挂载时也要接收现有业务事件，不能依赖某个页面恰好打开。
    const inbox = window.api.on("inbox:newMail", () => { void invalidateDomain(qc, "inbox"); });
    const send = window.api.on("send:progress", () => { void invalidateDomain(qc, "send"); });
    return () => { inbox(); send(); };
  }, [qc]);
  return (
    <AppProvider>
      <ConfigProvider
        theme={{
          token: {
            colorPrimary: "#1a1a1a",
            colorBgContainer: "#ffffff",
            colorBgElevated: "#ffffff",
            colorBgLayout: "#f5f5f5",
            colorBorder: "#e0e0e0",
            colorText: "#1a1a1a",
            colorTextSecondary: "#6b6b6b",
            /* 选择高亮统一成收件箱那套淡黑灰（别用主色近黑去推，否则选中行发黑） */
            controlItemBgActive: "rgba(0,0,0,0.04)",        // 选中项/选中行底色（表格/下拉/菜单通用）
            controlItemBgActiveHover: "rgba(0,0,0,0.06)",   // 选中态再悬停
            borderRadius: 8,
            fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          },
          components: {
            Table: {
              rowHoverBg: "rgba(0,0,0,0.015)",              // 未选中行的悬停底色（收件箱同款）
            },
          },
        }}
      >
        <AntApp>
          <RouterProvider router={router} />
        </AntApp>
      </ConfigProvider>
    </AppProvider>
  );
}
