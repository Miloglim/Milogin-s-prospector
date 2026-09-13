import DOMPurify from "dompurify";

// ── 渲染外部内容（邮件正文 / 模板预览 / AI 草稿）前的统一消毒口 ──
// 邮件正文来自外部发件人，模板与草稿可含用户粘贴的任意 HTML。
// 只放行安全标签；事件属性、script/style/iframe/object 一律剥离，堵 XSS。
const ALLOWED_TAGS = [
  "p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "sub", "sup",
  "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "code",
  "a", "img", "table", "thead", "tbody", "tr", "th", "td", "hr", "font",
];
const ALLOWED_ATTR = [
  "href", "src", "alt", "title", "style", "target", "rel",
  "width", "height", "align", "color", "face", "border", "cellpadding", "cellspacing",
];
// 只放行 http/https/mailto/tel、相对路径、锚点，以及粘贴内嵌图片的 data:image（其余 data: 协议拒绝）
const ALLOWED_URI_REGEXP =
  /^(?:(?:https?:\/\/|mailto:|tel:)[^\s]*|(?:\/|\.{0,2}\/|#)[^\s]*|data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+)$/i;

export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html ?? "", {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
  });
}
