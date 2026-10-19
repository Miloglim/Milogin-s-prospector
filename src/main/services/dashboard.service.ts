import { getDb } from "../db";
import { contacts } from "../db/schema/contacts";
import { inboxMessages } from "../db/schema/inbox";
import { interactions } from "../db/schema/interactions";
import { sql } from "drizzle-orm";
import { getAgentContactPort } from "./agent-contact.service";
import { failResult, okResult, type Result } from "../errors";
import { Log } from "../logger";

export interface DashboardStats {
  totalContacts: number;
  totalSent: number;
  totalReplied: number;
  bounceCount: number;
  pipelineSummary: Record<string, number>;
  recentActivity: Array<{
    type: string; contactEmail: string; subject: string | null; createdAt: string;
  }>;
}

export function getStats(): Result<DashboardStats> {
  Log.debug("dashboard.stats", "");

  const db = getDb();

  const center = getAgentContactPort()?.snapshot();
  if (center && (!center.ok || !center.data.active())) return failResult(center.ok ? '账号或权限已变化' : center.error.message);
  const totalContacts = center?.ok ? center.data.contacts.length : db.select({ count: sql<number>`count(*)` }).from(contacts).get()?.count || 0;
  // 口径修复：三个数字直查 inbox_messages 按 classification 计数，与收件箱界面的统计同源。
  // 原实现数 interactions.type（sent/replied/bounced），该表只覆盖「匹配到联系人的邮件事件」，
  // 且 markReplied 曾误写 sent 造成虚增 —— 两表天然不一致且随时间漂移。
  const countByClass = (cls: string) =>
    db.select({ count: sql<number>`count(*)` }).from(inboxMessages)
      .where(sql`classification = ${cls}`).get()?.count || 0;
  const totalSent = countByClass("sent");
  const totalReplied = countByClass("replied");
  const bounceCount = countByClass("bounce");

  // 阶段统计 — 从 contacts.tags（CRM 管线标签）读取，crm_stages 已废弃
  const STAGE_KEYS = ["reaching", "quoting", "trial", "cooperating", "lost", "other"];
  const tagRows = center ? [] : db.select({ tags: contacts.tags }).from(contacts).all();
  const pipelineSummary: Record<string, number> = {};
  for (const k of STAGE_KEYS) pipelineSummary[k] = 0;
  if (center?.ok) {
    for (const row of center.data.contacts) {
      if (!['contacted', 'replied'].includes(row.touchStatus)) continue;
      const stage = row.relationshipStage && row.relationshipStage !== 'cold' ? row.relationshipStage : 'reaching';
      if (STAGE_KEYS.includes(stage)) pipelineSummary[stage] = (pipelineSummary[stage] || 0) + 1;
    }
  }
  for (const r of center ? [] : tagRows) {
    let tags: string[] = [];
    try { const p = JSON.parse(r.tags || "[]"); if (Array.isArray(p)) tags = p; } catch { /* 忽略坏 JSON */ }
    const stage = STAGE_KEYS.find(k => tags.includes(k));
    if (stage) pipelineSummary[stage] = (pipelineSummary[stage] || 0) + 1;
  }

  // 最近活动（前 10 条）
  const recentRows = center ? [] : db.select({
    type: interactions.type,
    contactEmail: contacts.email,
    subject: interactions.subject,
    createdAt: interactions.createdAt,
  })
    .from(interactions)
    .leftJoin(contacts, sql`${interactions.contactId} = ${contacts.id}`)
    .orderBy(sql`${interactions.createdAt} DESC`)
    .limit(10)
    .all();

  const recentActivity = center ? db.select({ type: inboxMessages.classification, contactEmail: inboxMessages.fromEmail, subject: inboxMessages.subject, createdAt: inboxMessages.receivedAt }).from(inboxMessages).orderBy(sql`${inboxMessages.receivedAt} DESC`).limit(10).all().map(row => ({ ...row, type: row.type ?? '', contactEmail: row.contactEmail ?? '未知' })) : recentRows.map(r => ({
    type: r.type,
    contactEmail: r.contactEmail || "未知",
    subject: r.subject,
    createdAt: r.createdAt,
  }));

  return okResult({
    totalContacts, totalSent, totalReplied, bounceCount,
    pipelineSummary, recentActivity,
  });
}
