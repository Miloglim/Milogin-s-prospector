// ── 签名/正文图片引用体检（编辑器侧）──────────────────────────────
// 发信前 main 侧会把本次编辑带入的 data 图片和远程 http(s) 图片转成 CID 内嵌附件；
// 本地路径、悬空 cid 引用和相对路径不会被发信端读取 —— Word/Outlook 里复制图片常留下这种引用，
// 收件人看到的就是裂图。这类问题必须在编辑时就说出来，而不是等发完才发现。
// 判据与 src/main/services/inline-images.ts 的 classify() 对齐，由 tests/unit/signature-lint.test.ts 钉住一致。

const ATTR_RE = /\b(?:src|background)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi;

/** 收件人看不到、发信端也救不回来的图片引用（返回去重后的原值，供提示用） */
export function deadImageRefs(html: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const consider = (raw: string | undefined) => {
    const s = (raw ?? "").trim();
    if (!s || seen.has(s)) return;
    const dead = /^(cid:|blob:|about:)/i.test(s)
      || /^file:/i.test(s) || s.startsWith("/") || /^[a-z]:[\\/]/i.test(s) || s.startsWith("\\\\")
      || (/^(https?:|data:)/i.test(s) === false && /\.[a-z]{2,6}$/i.test(s.split(/[?#]/)[0] ?? ""));
    if (dead) { seen.add(s); out.push(s); }
  };
  for (const m of (html ?? "").matchAll(ATTR_RE)) consider(m[1] ?? m[2]);
  for (const m of (html ?? "").matchAll(CSS_URL_RE)) consider(m[1] ?? m[2] ?? m[3]);
  return out;
}
