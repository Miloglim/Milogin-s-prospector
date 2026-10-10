import { eq } from "drizzle-orm";
import { getDb, saveDatabase } from "../db";
import { contacts } from "../db/schema/contacts";
import { companies } from "../db/schema/companies";
import { inboxMessages } from "../db/schema/inbox";
import { extractSignature } from "../core/signature";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";

const ENRICH_INTERVAL_SECONDS = 24 * 60 * 60;
const MILLISECONDS_PER_SECOND = 1000;
const normalize = (s: string) => s.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** 已匹配来信的本地正文签名回填。无网络、无新公司，不覆盖人工字段。 */
export function enrichMatchedMail(messageId: number, text: string): Result<boolean> {
  try {
    const db = getDb();
    const mail = db.select().from(inboxMessages).where(eq(inboxMessages.id, messageId)).get();
    if (!mail?.matchedContactId || !["replied", "other"].includes(mail.classification || "other")) return okResult(false);
    const contact = db.select().from(contacts).where(eq(contacts.id, mail.matchedContactId)).get();
    if (!contact || contact.email.toLowerCase() !== mail.fromEmail.toLowerCase()) return okResult(false);
    const extra = JSON.parse(contact.extra || "{}") as Record<string, unknown>;
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) return okResult(false);
    const elapsed = Date.now() - Date.parse(String(extra.lastEnrichedAt || ""));
    if (Number.isFinite(elapsed) && elapsed < ENRICH_INTERVAL_SECONDS * MILLISECONDS_PER_SECOND) return okResult(false);
    const fields = extractSignature(text);
    const update: Partial<typeof contacts.$inferInsert> = {};
    if (!contact.title?.trim() && fields.title) update.title = fields.title;
    if (!contact.phone?.trim() && fields.phone) update.phone = fields.phone;
    if (contact.companyId == null && fields.company) {
      const name = normalize(fields.company);
      const candidates = db.select({ id: companies.id, name: companies.name }).from(companies).all();
      const exact = candidates.filter(c => normalize(c.name) === name);
      const matches = exact.length ? exact : candidates.filter(c => {
        const candidate = normalize(c.name);
        return candidate && (name.startsWith(`${candidate} `) || candidate.startsWith(`${name} `));
      });
      if (matches.length === 1) update.companyId = matches[0]!.id;
    }
    if (!Object.keys(update).length) return okResult(false);
    const now = new Date().toISOString();
    db.update(contacts).set({ ...update, extra: JSON.stringify({ ...extra, lastEnrichedAt: now }), updatedAt: now })
      .where(eq(contacts.id, contact.id)).run();
    saveDatabase();
    Log.debug("enrichment.signature", `contactId=${contact.id}, fields=${Object.keys(update).join(",")}`);
    return okResult(true);
  } catch (error) {
    Log.error("enrichment.signature", "签名回填失败，保留原档案", error instanceof Error ? error.stack : undefined);
    return failResult("签名回填失败");
  }
}
