import { theme, type ThemeConfig } from "antd";

/** Shared desktop and browser brand. Dark mode preserves the monochrome palette. */
export function brandTheme(dark = false): ThemeConfig {
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: {
      colorPrimary: dark ? "#d8d8d8" : "#1a1a1a",
      colorBgContainer: dark ? "#1a1a1a" : "#ffffff",
      colorBgElevated: dark ? "#242424" : "#ffffff",
      colorBgLayout: dark ? "#141414" : "#f5f5f5",
      colorBorder: dark ? "#404040" : "#e0e0e0",
      colorText: dark ? "#eeeeee" : "#1a1a1a",
      colorTextSecondary: dark ? "#a8a8a8" : "#6b6b6b",
      controlItemBgActive: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.04)",
      controlItemBgActiveHover: dark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.06)",
      borderRadius: 8,
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    },
    components: { Table: { rowHoverBg: dark ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.015)" } },
  };
}
