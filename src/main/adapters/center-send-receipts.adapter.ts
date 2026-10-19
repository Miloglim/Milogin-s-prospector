import { CENTER_SEND_AUTHORIZATION_DDL, CENTER_SEND_RECEIPT_DDL, CENTER_SEND_RECEIPT_LIMIT, LOCAL_SENT_PREVIEW_LENGTH } from '../core/center-send-storage';
import type { CenterSendReceipt } from '../services/center-send.service';
import type { SendAuthorization, SendAuthorizationInput } from '../../../server/core/send-acceptance';
import { CONTACT_MAIL_LIMITS } from '../../../server/core/contact-mail';

interface Statement {
  get(...args: any[]): unknown;
  all(...args: any[]): unknown[];
  run(...args: any[]): unknown;
}
export interface CenterSendDatabase { prepare(sql: string): Statement; exec(sql: string): unknown; transaction<T>(fn: () => T): () => T }
export interface StoredSendReceipt { receipt: CenterSendReceipt; mailIds: number[]; accountEmail: string }
export interface StoredSendAuthorization { input: SendAuthorizationInput; authorizations: SendAuthorization[] }

const normalizedEmail = (value: string) => value.trim().toLowerCase();
const normalizedCc = (value: string | undefined) => (value ?? '').split(/[,;]/).map(normalizedEmail).filter(Boolean);
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function validateAuthorization(input: SendAuthorizationInput, grants: SendAuthorization[]): void {
  if (!input.sendKey || !input.fromEmail || !input.recipients.length || !Array.isArray(grants) || grants.length !== input.recipients.length) {
    throw new Error('中心发送授权不完整');
  }
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const target of input.recipients) {
    const key = JSON.stringify([target.contactId, target.customerId]);
    const matches = grants.filter(grant => grant.contactId === target.contactId && grant.customerId === target.customerId);
    if (targets.has(key) || matches.length !== 1) throw new Error('中心发送授权目标不匹配');
    targets.add(key);
    const grant = matches[0]!;
    if (!grant.authorizationId || ids.has(grant.authorizationId)
      || normalizedEmail(grant.recipientEmail) !== normalizedEmail(target.email)
      || normalizedEmail(grant.fromEmail) !== normalizedEmail(input.fromEmail)
      || grant.subject !== input.subject
      || !Number.isFinite(Date.parse(grant.issuedAt)) || !Number.isFinite(Date.parse(grant.expiresAt))
      || Date.parse(grant.expiresAt) <= Date.parse(grant.issuedAt)) {
      throw new Error('中心发送授权元数据不匹配');
    }
    ids.add(grant.authorizationId);
  }
}

export class SqliteCenterSendReceipts {
  constructor(private readonly raw: CenterSendDatabase) {
    raw.exec(CENTER_SEND_RECEIPT_DDL);
    raw.exec(CENTER_SEND_AUTHORIZATION_DDL);
  }
  authorization(sendKey: string, scope: string): StoredSendAuthorization | undefined {
    const row = this.raw.prepare('SELECT payload FROM crm_send_authorizations WHERE send_key=? AND center_scope=?').get(sendKey, scope) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as StoredSendAuthorization : undefined;
  }
  recordAuthorization(scope: string, input: SendAuthorizationInput, authorizations: SendAuthorization[]): void {
    if (!scope) throw new Error('中心发送授权账号缺失');
    validateAuthorization(input, authorizations);
    const saved: StoredSendAuthorization = { input, authorizations };
    this.raw.transaction(() => {
      const previous = this.authorization(input.sendKey, scope);
      if (previous) {
        if (!same(previous, saved)) throw new Error('发送授权编号已用于其他内容');
        return;
      }
      this.raw.prepare('INSERT INTO crm_send_authorizations(send_key,center_scope,payload,recorded_at) VALUES(?,?,?,?)')
        .run(input.sendKey, scope, JSON.stringify(saved), new Date().toISOString());
    })();
  }
  record(receipt: CenterSendReceipt): StoredSendReceipt {
    if (!receipt.centerScope || !receipt.id || !receipt.recipients.length || receipt.recipients.some(r => !r.centerReference || r.contactId !== r.centerReference.contactId)) throw new Error('中心发送回执引用无效');
    return this.raw.transaction(() => {
      const previous = this.raw.prepare('SELECT payload,mail_ids FROM crm_send_receipts WHERE send_key=? AND center_scope=?').get(receipt.id,receipt.centerScope) as {payload:string;mail_ids:string}|undefined;
      if(previous) {
        const saved=JSON.parse(previous.payload) as {receipt:CenterSendReceipt;accountEmail:string};
        if(JSON.stringify(saved.receipt)!==JSON.stringify(receipt))throw new Error('发送回执编号已用于其他内容');
        return {...saved,mailIds:JSON.parse(previous.mail_ids)};
      }
      const authorization = this.authorization(receipt.id, receipt.centerScope!);
      // Sending settings can change after SMTP accepted the original envelope.
      const account = authorization
        ? { email: authorization.input.fromEmail }
        : this.raw.prepare('SELECT email FROM email_accounts WHERE id=?').get(receipt.accountId) as {email:string}|undefined;
      if(!account?.email)throw new Error('原发件账号不存在，已发回执待恢复');
      if (authorization || receipt.authorizations !== undefined) {
        if (!authorization || !receipt.authorizations || receipt.authorizations.length !== receipt.recipients.length) throw new Error('已发回执缺少原始发送授权');
        if (authorization.input.subject !== receipt.subject.slice(0, CONTACT_MAIL_LIMITS.subject)
          || normalizedEmail(authorization.input.fromEmail) !== normalizedEmail(account.email)
          || !same(authorization.input.ccEmails ?? [], normalizedCc(receipt.cc))) throw new Error('已发回执与原始发送授权不匹配');
        const acceptedIds = new Set<string>();
        for (const recipient of receipt.recipients) {
          const granted = authorization.authorizations.find(grant => grant.contactId === recipient.contactId && grant.customerId === recipient.centerReference!.customerId);
          const bound = receipt.authorizations.find(grant => grant.contactId === recipient.contactId && grant.customerId === recipient.centerReference!.customerId);
          if (!granted || !bound || !same(granted, bound) || normalizedEmail(granted.recipientEmail) !== normalizedEmail(recipient.email) || acceptedIds.has(granted.authorizationId)) {
            throw new Error('已发回执收件人与原始发送授权不匹配');
          }
          acceptedIds.add(granted.authorizationId);
        }
      }
      const recipients=receipt.recipients.map(r=>r.email);
      this.raw.prepare('INSERT INTO inbox_messages(account_id,message_id,from_email,from_name,subject,body_preview,classification,"to",cc,my_role,matched_contact_id,is_read,received_at) VALUES(?,?,?,?,?,?,\'sent\',?,?,\'sender\',NULL,1,?)').run(
        receipt.accountId,receipt.messageId||`local:smtp:${receipt.id}`,account.email,receipt.companyName,receipt.subject,receipt.body.slice(0,LOCAL_SENT_PREVIEW_LENGTH),JSON.stringify(recipients),receipt.cc||null,receipt.occurredAt);
      const mailId=(this.raw.prepare('SELECT last_insert_rowid() AS id').get() as {id:number}).id;
      const mailIds=[mailId]; const saved={receipt,accountEmail:account.email};
      this.raw.prepare('INSERT INTO crm_send_receipts(send_key,center_scope,payload,mail_ids,recorded_at) VALUES(?,?,?,?,?)').run(receipt.id,receipt.centerScope,JSON.stringify(saved),JSON.stringify(mailIds),new Date().toISOString());
      this.raw.prepare('UPDATE send_queue SET status=\'sent\',sent_at=? WHERE id=?').run(receipt.occurredAt,receipt.id);
      return {...saved,mailIds};
    })();
  }
  pending(scope:string):StoredSendReceipt[] {
    return (this.raw.prepare('SELECT payload,mail_ids FROM crm_send_receipts WHERE center_scope=? AND synced_at IS NULL ORDER BY recorded_at LIMIT ?').all(scope,CENTER_SEND_RECEIPT_LIMIT) as Array<{payload:string;mail_ids:string}>).map(row=>({...JSON.parse(row.payload),mailIds:JSON.parse(row.mail_ids)}));
  }
  history(scope:string,includeHidden=false):StoredSendReceipt[] {
    return (this.raw.prepare(`SELECT payload,mail_ids FROM crm_send_receipts WHERE center_scope=? ${includeHidden?'':'AND history_hidden=0'} ORDER BY recorded_at DESC`).all(scope) as Array<{payload:string;mail_ids:string}>).map(row=>({...JSON.parse(row.payload),mailIds:JSON.parse(row.mail_ids)}));
  }
  hideHistory(scope:string):number {
    const count=(this.raw.prepare('SELECT count(*) AS n FROM crm_send_receipts WHERE center_scope=? AND history_hidden=0').get(scope) as {n:number}).n;
    this.raw.prepare('UPDATE crm_send_receipts SET history_hidden=1 WHERE center_scope=?').run(scope);return count;
  }
  acknowledge(key:string,scope:string):void {
    this.raw.prepare('UPDATE crm_send_receipts SET synced_at=? WHERE send_key=? AND center_scope=?').run(new Date().toISOString(),key,scope);
  }
}
