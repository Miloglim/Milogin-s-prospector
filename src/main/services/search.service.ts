import { getAgentContactPort } from "./agent-contact.service";
import { getRawDb } from "../db";
import { DB_PATH } from "../config";
import { htmlToText } from "../core/html-text";
import { searchLatin, SEARCH_ROW_STRIDE } from "../db/search-index";
import { okResult, failResult, type Result } from "../errors";
import { Log } from "../logger";
import type { SearchRequest, SearchHit, GlobalSearchData, SearchKind } from "../../shared/search";
import * as fs from "fs";
import * as path from "path";

const MAX_QUERY_LENGTH = 200;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const SNIPPET_TOKENS = 24;
const SNIPPET_CHARACTERS = 180;
const INDEX_BATCH_SIZE = 50;
const SEARCH_KINDS: SearchKind[] = ["email", "note", "contact"];

/** 每组最多 limit 条；查询不接受 FTS 操作符，关键词始终作为字面词处理。 */
export function searchGlobal(request: SearchRequest): Result<GlobalSearchData> {
  if (!request || typeof request.query !== "string" || request.query.length > MAX_QUERY_LENGTH) return failResult("搜索词最多 200 字");
  const query = request.query.trim();
  const limit = request.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return failResult("搜索条数须为 1–50");
  const data: GlobalSearchData = { email: [], note: [], contact: [], truncated: false };
  if (!query) return okResult(data);
  try {
    const center = getAgentContactPort()?.snapshot();
    if (center && (!center.ok || !center.data.active())) return failResult(center.ok ? '账号或权限已变化' : center.error.message);
    const raw = getRawDb();
    const chinese = /[\u3400-\u9fff]/u.test(query);
    const terms = searchLatin(query).trim().split(/\s+/).filter(Boolean);
    if (!chinese && !terms.length) return okResult(data);
    const match = terms.map(term => `"${term}"*`).join(" AND ");
    const like = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    for (const kind of center ? ['email'] as const : SEARCH_KINDS) {
      const rows = (chinese
        ? raw.prepare(`SELECT kind,sourceId,contactId,title,body AS snippet FROM search_idx
            WHERE kind=? AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') ORDER BY rowid DESC LIMIT ?`).all(kind, like, like, limit + 1)
        : raw.prepare(`SELECT kind,sourceId,contactId,title,snippet(search_idx,5,char(1),char(2),'…',?) AS snippet
            FROM search_idx WHERE search_idx MATCH ? AND kind=? ORDER BY rank LIMIT ?`).all(SNIPPET_TOKENS, match, kind, limit + 1)) as SearchHit[];
      data.truncated ||= rows.length > limit;
      data[kind] = rows.slice(0, limit).map(row => ({ ...row, snippet: chinese ? chineseSnippet(row.snippet, query) : row.snippet }));
    }
    if (center?.ok) {
      const matches = (text: string) => chinese ? text.toLowerCase().includes(query.toLowerCase()) : terms.every(term => searchLatin(text).includes(term));
      const notesByContact = new Map<string, string[]>();
      for (const note of center.data.notes ?? []) { const key = `${note.customerId}:${note.contactId}`; const list = notesByContact.get(key) ?? []; list.push(note.note); notesByContact.set(key,list); }
      for (const row of center.data.contacts) {
        const title = [row.firstName, row.lastName].filter(Boolean).join(' ') || row.email || row.companyName;
        const text = [title, row.email, row.companyName, row.title, row.phone, row.country].filter(Boolean).join(' ');
        const hit = { kind: 'contact' as const, sourceId: row.contactId, contactId: row.contactId, customerId: row.customerId, dataSource: 'center' as const, title, snippet: chineseSnippet(text, query) };
        if (matches(text)) data.contact.push(hit);
        const notes = [...(notesByContact.get(`${row.customerId}:${row.contactId}`) ?? []), row.lastFollowupNote ?? ''].filter(Boolean).join('\n');
        if (notes && matches(notes)) data.note.push({ ...hit, kind: 'note', snippet: chineseSnippet(notes, query) });
      }
      for (const kind of ['contact', 'note'] as const) { data.truncated ||= data[kind].length > limit; data[kind] = data[kind].slice(0, limit); }
      if (!center.data.active()) return failResult('账号或权限已变化');
    }
    return okResult(data);
  } catch (error) {
    Log.error("search.global", "本地搜索失败", error instanceof Error ? error.stack : undefined);
    return failResult("本地搜索索引不可用，请重启程序后重试");
  }
}

function chineseSnippet(body: string, query: string): string {
  const at = body.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARACTERS / 2));
  const snippet = body.slice(start, start + SNIPPET_CHARACTERS).replace(/[\u0001\u0002]/g, "");
  const offset = snippet.toLowerCase().indexOf(query.toLowerCase());
  return offset < 0 ? snippet : snippet.slice(0, offset) + "\u0001" + snippet.slice(offset, offset + query.length) + "\u0002" + snippet.slice(offset + query.length);
}

/** 完整正文仅来自本地缓存；无额外 IMAP 请求。删除邮件后不可复活孤立索引。 */
export function indexEmailBody(id: number, text: string): Result<void> {
  try {
    const raw = getRawDb();
    raw.prepare(`UPDATE search_idx SET body=?, content=search_latin(title || ' ' || COALESCE((SELECT from_email FROM inbox_messages WHERE id=?),'') || ' ' || ?)
      WHERE rowid=? AND kind='email' AND EXISTS(SELECT 1 FROM inbox_messages WHERE id=?)`)
      .run(text.replace(/[\u0001\u0002]/g, ""), id, text, id * SEARCH_ROW_STRIDE + 1, id);
    return okResult(undefined);
  } catch (error) {
    Log.error("search.body", `正文索引失败 id=${id}`, error instanceof Error ? error.stack : undefined);
    return failResult("正文索引失败");
  }
}

export async function backfillLocalSearchBodies(): Promise<Result<number>> {
  try {
    const dir = path.join(path.dirname(DB_PATH), "bodies");
    if (!fs.existsSync(dir)) return okResult(0);
    let indexed = 0;
    // 已索引的完整正文不会在每次启动重新读写；只补仍等于预览的记录。
    const pending = getRawDb().prepare(`SELECT i.id FROM inbox_messages i JOIN search_idx s ON s.rowid=i.id*?+1
      WHERE s.body=COALESCE(i.body_preview,'')`).all(SEARCH_ROW_STRIDE) as { id: number }[];
    for (const { id } of pending) {
      const file = path.join(dir, `${id}.html`);
      if (!fs.existsSync(file)) continue;
      const html = await fs.promises.readFile(file, "utf8");
      if (indexEmailBody(id, htmlToText(html)).success) indexed++;
      if (indexed % INDEX_BATCH_SIZE === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    Log.info("search.backfill", `本地正文索引完成: ${indexed}`);
    return okResult(indexed);
  } catch (error) {
    Log.error("search.backfill", "本地正文索引回填失败", error instanceof Error ? error.stack : undefined);
    return failResult("正文索引回填失败（预览搜索仍可使用）");
  }
}
