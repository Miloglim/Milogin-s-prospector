import * as nodemailer from "nodemailer";
import type { SendItem } from "../services/send.service";
import { Log } from "../logger";
import { failResult, okResult, type Result } from "../errors";
import { getDb } from "../db";
import { emailAccounts } from "../db/schema/accounts";
import { eq } from "drizzle-orm";
import { getDecryptedPassword } from "../services/account.service";
import { loadConfig } from "../config";
import { embedInlineImages } from "../services/inline-images";
import { netFetch } from "../net-proxy";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
const isHtml = (s: string) => /<[a-z][\s\S]*>/i.test(s);

/**
 * 取远程图片字节；本地路径由 inline-images 在读取前拒绝。为什么必须转 cid：客户端会过滤 base64 内联图，
 * 而远程图片、Word/Outlook 粘贴带来的悬空 cid 引用，收件人端不一定能访问。
 */
const IMG_MAX_BYTES = 4 * 1024 * 1024;

function extOf(name: string, mime?: string | null): string {
  if (mime) {
    if (mime.includes("png")) return "png";
    if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
    if (mime.includes("gif")) return "gif";
    if (mime.includes("webp")) return "webp";
  }
  const m = /\.(png|jpe?g|gif|webp|bmp)/i.exec(name);
  const e = m?.[1]?.toLowerCase();
  return !e ? "png" : e === "jpeg" ? "jpg" : e;
}

async function loadInlineImage(src: string): Promise<{ buffer: Buffer; ext: string } | null> {
  if (/^https?:\/\//i.test(src)) {
    try {
      const res = await netFetch(src, { headers: { Accept: "image/*" } });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > IMG_MAX_BYTES) return null;
      return { buffer: buf, ext: extOf(src.split("?")[0] ?? "", res.headers.get("content-type")) };
    } catch (err) {
      Log.debug("send.image", `远程图片拉不到：${src.slice(0, 80)}（${err instanceof Error ? err.message : "?"}）`);
      return null;
    }
  }
  return null;
}



// ── SMTP 连接池（按账号缓存）─────────────────────────────────────
// 旧实现每发一封都新建连接（TCP+TLS+AUTH 全套握手），大批次整批耗时被握手放大。
// 改为 pooled transporter 按账号复用（maxConnections:1 与全局串行调度匹配）：
// 缓存键含 host/port/密码指纹 → 账号改配置自动重建，不会拿旧凭据硬发；
// 发送成功保留连接，发送失败立即剔除（下次重连新鲜连接，坏连接不会反复失败）。
type PooledTransporter = {
  sendMail: (opts: Record<string, unknown>) => Promise<{ messageId?: string }>;
  close: () => void;
};
const transporterPool = new Map<number, { transporter: PooledTransporter; key: string }>();

function passFingerprint(pass: string): string {
  let h = 5381;
  for (let i = 0; i < pass.length; i++) h = ((h << 5) + h + pass.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function acquireTransporter(account: { id: number; email: string; smtpHost: string | null; smtpPort: number | null }, pass: string): PooledTransporter {
  const port = account.smtpPort || 587;
  const key = `${account.smtpHost}|${port}|${passFingerprint(pass)}`;
  const hit = transporterPool.get(account.id);
  if (hit && hit.key === key) return hit.transporter;
  if (hit) {
    try { hit.transporter.close(); } catch { /* 已断 */ }
    transporterPool.delete(account.id);
    Log.debug("send.pool", `账号 ${account.email} 配置变更，重建连接`);
  }
  const transporter = nodemailer.createTransport({
    host: account.smtpHost || "",
    port,
    secure: port === 465,
    requireTLS: true, // P0-3: 587/25 等端口强制 STARTTLS，拒绝明文发信（465 隐式 TLS 不受影响）
    auth: { user: account.email, pass },
    pool: true, maxConnections: 1, maxMessages: 100,
    connectionTimeout: 15000, socketTimeout: 15000,
  }) as unknown as PooledTransporter;
  transporterPool.set(account.id, { transporter, key });
  return transporter;
}

function evictTransporter(accountId: number, why: string): void {
  const hit = transporterPool.get(accountId);
  if (!hit) return;
  try { hit.transporter.close(); } catch { /* 已断 */ }
  transporterPool.delete(accountId);
  Log.debug("send.pool", `剔除连接（${why}）`);
}

/** 池化连接被服务端闲置掐断的典型报错：不算真失败，换新连接重试一次 */
function idleConnectionError(msg: string): boolean {
  return /idle|connection|socket|ECONNRESET|EPIPE|timed?\s?out/i.test(msg);
}

/** 发送一封邮件（v6.1 发送方式可切换）：individual=单独一封，收件人走 To（像人工手发）；
 *  缺省 bcc=收件人全走 BCC 互不可见。账号从 DB email_accounts 表读取（唯一数据源），密码解密后传给 nodemailer。 */
export async function sendBcc(item: SendItem & { body: string }): Promise<Result<{ messageId: string | null }>> {
  const account = getDb().select().from(emailAccounts).where(eq(emailAccounts.id, item.accountId)).get();
  if (!account) return failResult("账号未找到");

  const passRes = getDecryptedPassword(account.id);
  if (!passRes.success) return failResult("账号密码解密失败: " + passRes.error);

  try {
    const config = loadConfig();
    const displayName = account.displayName || config.fromName || "";
    const emails = item.recipients.map(r => r.email);
    const signature = (account.signature || "").trim();
    const body = item.body || "Hello, I hope this email finds you well.\n\nBest regards";

    const from = displayName ? `"${displayName}" <${account.email}>` : account.email;
    const subject = item.subject || "Regarding our logistics partnership";

    // 抄送：抄送方放 CC（对客户可见，用于同事存档）
    const ccList = (item.cc || "").split(/[,;]/).map(s => s.trim()).filter(Boolean);
    const ccField = ccList.length > 0 ? { cc: ccList } : {};
    // 单发收件人走 To；合并收件人走 BCC（互不可见）
    const rcptField = item.sendMode === "individual" ? { to: emails } : { bcc: emails };

    let mailOptions: Record<string, unknown>;
    if (isHtml(body) || isHtml(signature)) {
      const bodyHtml = isHtml(body) ? body : escapeHtml(body).replace(/\n/g, "<br>");
      const sigHtml = isHtml(signature) ? signature : escapeHtml(signature).replace(/\n/g, "<br>");
      const embedded = await embedInlineImages(bodyHtml + (sigHtml ? `<br><br>${sigHtml}` : ""), loadInlineImage);
      const { html, attachments } = embedded;
      if (embedded.unresolved.length) {
        Log.warn("send.image", `${embedded.unresolved.length} 处图片引用发信端取不到（悬空 cid:/相对路径/读不到），`
          + `收件人可能看到裂图——请把这些图片直接粘贴进签名（会自动转内嵌）：${embedded.unresolved.slice(0, 3).join(" | ")}`);
      }
      mailOptions = {
        from, ...rcptField, ...ccField, subject,
        text: stripHtml(body + (signature ? `\n\n${signature}` : "")),
        html,
        attachments,
      };
    } else {
      mailOptions = {
        from, ...rcptField, ...ccField, subject,
        text: body + (signature ? `\n\n${signature}` : ""),
      };
    }

    let info: { messageId?: string } | null = null;
    try {
      info = await acquireTransporter(account, passRes.data).sendMail(mailOptions);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      evictTransporter(account.id, msg.slice(0, 60));
      // 池化连接闲置被掐：换新连接原参数重试一次，不计为发送失败（防误触连续失败/熔断）
      if (idleConnectionError(msg)) {
        Log.debug("send.pool", `闲置连接断开，重连重试：${msg.slice(0, 60)}`);
        info = await acquireTransporter(account, passRes.data).sendMail(mailOptions);
      } else {
        return failResult(msg);
      }
    }
    Log.debug("send.bcc", `${item.companyName}: ${emails.length} 人`);
    return okResult({ messageId: info?.messageId || null });
  } catch (err: unknown) {
    return failResult(err instanceof Error ? err.message : "发送失败");
  }
}
