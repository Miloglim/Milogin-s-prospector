// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../../src/renderer/lib/sanitize";

// XSS 消毒层：外部邮件正文/模板/AI 草稿渲染前必经 sanitizeHtml。
// 恶意载荷必须被剥离，合法内容（粗体、外链、粘贴内嵌图）必须保留。
describe("sanitizeHtml", () => {
  it("剥离事件属性（onerror 注入）", () => {
    const out = sanitizeHtml(`<img src="x" onerror="alert(1)">hello`);
    expect(out).not.toContain("onerror");
    expect(out).toContain("hello");
  });

  it("剥离 <script> 标签", () => {
    const out = sanitizeHtml(`<script>alert(1)</script><b>hi</b>`);
    expect(out).not.toContain("<script");
    expect(out).toContain("<b>hi</b>");
  });

  it("剥离 javascript: 协议的链接", () => {
    const out = sanitizeHtml(`<a href="javascript:alert(1)">x</a>`);
    expect(out).not.toContain("javascript:");
  });

  it("剥离 iframe/object/embed 等嵌入标签", () => {
    const out = sanitizeHtml(`<iframe src="https://evil.example"></iframe>ok`);
    expect(out).not.toContain("iframe");
    expect(out).toContain("ok");
  });

  it("保留合法 http(s) 外链", () => {
    const out = sanitizeHtml(`<a href="https://ok.com" target="_blank">go</a>`);
    expect(out).toContain('href="https://ok.com"');
  });

  it("保留合法文本格式标签", () => {
    const out = sanitizeHtml(`<p>Price <b>$120</b> <i>FOB</i></p>`);
    expect(out).toContain("<b>$120</b>");
    expect(out).toContain("<i>FOB</i>");
  });

  it("保留粘贴内嵌的 data:image base64 图片", () => {
    const out = sanitizeHtml(`<img src="data:image/png;base64,AAAA" />`);
    expect(out).toContain("data:image/png;base64,AAAA");
  });

  it("拒绝非图片的 data: 协议（data:text/html）", () => {
    const out = sanitizeHtml(`<a href="data:text/html,<script>alert(1)</script>">x</a>`);
    expect(out).not.toContain("data:text/html");
  });

  it("空/null 输入不抛错", () => {
    expect(sanitizeHtml("")).toBe("");
    expect(sanitizeHtml(undefined as unknown as string)).toBe("");
  });
});
