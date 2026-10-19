import { canSendToContact } from '../core/contact-permissions';
import { createHash } from 'node:crypto';
import type { OnlineCrmAdapter } from './online-crm.adapter';
import type { ContactMirrorStore, QueuedContactMailEvent } from '../core/contact-mirror';
import { centerSendContact, setCenterSendPort, type CenterSendItem, type CenterSendReceipt } from '../services/center-send.service';
import { getRawDb } from '../db';
import { SqliteCenterSendReceipts, type StoredSendReceipt } from './center-send-receipts.adapter';
import { CONTACT_ASSIGNMENT_ROUTES, type CenterContactDetail } from '../../../server/core/contact-assignments';
import { CONTACT_MAIL_LIMITS } from '../../../server/core/contact-mail';
import { SEND_ACCEPTANCE_ROUTES, type SendAuthorization, type SendAuthorizationInput } from '../../../server/core/send-acceptance';
import { okResult, failResult } from '../errors';
import { writeBodyFile } from '../services/inbox.service';
import { Log } from '../logger';
import type { ContactMirrorContext } from '../core/contact-mirror';
import { canSendCenterCampaignItem } from '../services/campaign.service';

const DAY_MS=86400000;
const RECENT_DAY_LIMITS={yesterday:2,twoDays:3,fiveDays:5,tenDays:10};
const hash=(parts:unknown[])=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const scopeKey=(ctx:{baseUrl:string;userId:string})=>JSON.stringify([ctx.baseUrl,ctx.userId]);
const lastLabel=(at:string)=>{const days=(Date.now()-Date.parse(at))/DAY_MS;return days<1?'今天':days<RECENT_DAY_LIMITS.yesterday?'1天':days<RECENT_DAY_LIMITS.twoDays?'2天':days<=RECENT_DAY_LIMITS.fiveDays?'3-5天':days<=RECENT_DAY_LIMITS.tenDays?'6-10天':'更早';};
/** Captures the selected account DB. A later account context never receives its accepted receipts. */
export function bindCenterSendRuntime(adapter:OnlineCrmAdapter,mirror:ContactMirrorStore,changed:()=>void,scheduleFlush:()=>void,invalidate?:(ctx:ContactMirrorContext)=>void) {
  const raw=getRawDb();const receipts=new SqliteCenterSendReceipts(raw);let closed=false;let replaying:Promise<void>|null=null;
  const context=()=>closed?null:adapter.contactReadContext();
  const active=(ctx:ReturnType<typeof context>)=>!!ctx&&ctx.active()&&context()?.permissionKey===ctx.permissionKey&&scopeKey(context()!)===scopeKey(ctx);
  const rows=()=>{const ctx=context();if(!ctx||!active(ctx))return failResult('请登录中心账号');if(!mirror.ready(ctx))return failResult('联系人正在同步');return okResult(mirror.contacts(ctx).filter(canSendToContact).map(r=>centerSendContact(r,scopeKey(ctx))));};
  async function replay(allowSchedule=true) {
    if(replaying)return replaying;
    const task=(async()=>{
      const ctx=context();if(!ctx||!active(ctx))return;
      for(const saved of receipts.pending(scopeKey(ctx))) {
        if(!active(ctx))return;
        for(const id of saved.mailIds)await writeBodyFile(id,saved.receipt.body);
        if(!active(ctx))return;
        const event=makeEvents(saved);
        for(const input of event) {
          // Persist the receipt event directly; a read-cache refresh must not silently remove it.
          const localId=saved.mailIds[0];if(localId===undefined)throw new Error('已发邮件本地引用缺失');
          mirror.linkMail(ctx,{...input,localMailId:localId,mailAccountId:saved.receipt.accountId,mailbox:input.mailboxKey,role:'to',event:input});
        }
        if(event.every(input=>mirror.eventAcknowledged?.(ctx,input.eventKey)))receipts.acknowledge(saved.receipt.id,scopeKey(ctx));
        else if(allowSchedule&&adapter.isOnline())scheduleFlush();changed();
      }
    })().catch(error=>Log.error('send.receiptReplay','已发回执保留本地，等待重新同步',error instanceof Error?error.stack:undefined)).finally(()=>{if(replaying===task)replaying=null;});
    replaying=task;return task;
  }
  function makeEvents(saved:StoredSendReceipt):QueuedContactMailEvent[] {
    const {receipt,accountEmail}=saved;const mailboxKey=`mailbox:${hash([accountEmail.trim().toLowerCase()])}`;
    const sourceId=receipt.messageId?.trim()||`local:smtp:${receipt.id}`;
    const messageKey=`message:${hash([mailboxKey])}:${hash([sourceId])}`;
    return receipt.recipients.map(recipient=>({
      ...recipient.centerReference!,mailboxKey,messageKey,
      eventKey:`mail:${hash([mailboxKey,messageKey,recipient.centerReference!.customerId,recipient.contactId,'sent','outbound'])}`,
      kind:'sent',direction:'outbound',occurredAt:receipt.occurredAt,subject:receipt.subject.slice(0,CONTACT_MAIL_LIMITS.subject),preview:receipt.body.slice(0,CONTACT_MAIL_LIMITS.preview),
      fromEmail:accountEmail.trim().toLowerCase(),toEmails:receipt.recipients.map(r=>r.email.toLowerCase()),ccEmails:receipt.cc?.split(/[,;]/).map(s=>s.trim().toLowerCase()).filter(Boolean)||[],
      ...(receipt.advanceSendStage?{advanceSendStage:true}:{}),
      ...(receipt.authorizations ? { sendAuthorizationId: receipt.authorizations.find(grant => grant.contactId === recipient.contactId && grant.customerId === recipient.centerReference!.customerId)!.authorizationId } : {}),
    }));
  }
  setCenterSendPort({
    contacts:rows,
    async authorize(item:CenterSendItem) {
      const ctx=context();if(!ctx||!active(ctx)||!adapter.isOnline())return failResult('中心暂时不可用，发送已暂停');
      if(item.centerScope!==scopeKey(ctx))return failResult('发送任务不属于当前账号');
      for(const target of item.recipients) {
        if(!target.centerReference||target.contactId!==target.centerReference.contactId||!active(ctx))return failResult('中心联系人引用已失效');
        const ref=target.centerReference;
        const result=await adapter.requestLive<CenterContactDetail>('GET',`${CONTACT_ASSIGNMENT_ROUTES.contact}/${encodeURIComponent(String(ref.contactId))}?customerId=${encodeURIComponent(ref.customerId)}`);
        if(!active(ctx))return failResult('账号或权限已变化，发送已停止');
        if(!result.ok){
          if(['FORBIDDEN','NOT_FOUND'].includes(result.error.code)){mirror.forgetContact(ctx,ref);invalidate?.(ctx);changed();}
          return failResult(result.error.message);
        }
        const detail=result.data;
        if(!canSendToContact(detail.contact)||detail.contact.contactId!==ref.contactId||detail.contact.customerId!==ref.customerId)return failResult('当前无权开发该联系人');
        if(detail.contact.email?.trim().toLowerCase()!==target.email.trim().toLowerCase())return failResult('联系人邮箱已变化，请重新选择');
        // Authorization checks do not update contact projections; guarded readers own that cache.
      }
      const campaign = canSendCenterCampaignItem(item);
      if (!campaign.success) return campaign;
      try {
        const account = raw.prepare('SELECT email FROM email_accounts WHERE id=?').get(item.accountId) as { email: string } | undefined;
        if (!account?.email) return failResult('原发件账号不存在');
        const input: SendAuthorizationInput = {
          sendKey: item.id,
          fromEmail: account.email.trim().toLowerCase(),
          subject: item.subject.slice(0, CONTACT_MAIL_LIMITS.subject),
          recipients: item.recipients.map(target => ({ ...target.centerReference!, email: target.email.trim().toLowerCase() })),
          ccEmails: item.cc?.split(/[,;]/).map(email => email.trim().toLowerCase()).filter(Boolean) ?? [],
        };
        const result = await adapter.requestLive<SendAuthorization[]>('POST', SEND_ACCEPTANCE_ROUTES.authorize, input);
        if (!active(ctx) || !adapter.isOnline()) return failResult('账号或网络已变化，发送已停止');
        if (!result.ok) return failResult(result.error.message);
        const currentCampaign = canSendCenterCampaignItem(item);
        if (!currentCampaign.success) return currentCampaign;
        const currentAccount = raw.prepare('SELECT email FROM email_accounts WHERE id=?').get(item.accountId) as { email: string } | undefined;
        if (currentAccount?.email.trim().toLowerCase() !== input.fromEmail) return failResult('发件账号已变化，发送已停止');
        if (!Array.isArray(result.data) || result.data.some(grant => Date.parse(grant.expiresAt) <= Date.now())) return failResult('发送授权已过期，请重新安排');
        receipts.recordAuthorization(scopeKey(ctx), input, result.data);
        return okResult(undefined);
      } catch (error) {
        Log.error('send.authorization', '发送授权未能安全保存，发送已停止', error instanceof Error ? error.stack : undefined);
        return failResult('发送授权未能保存，发送已停止');
      }
    },
    async record(receipt:CenterSendReceipt) {
      try {
        // SMTP may finish after an account switch. Only the original captured DB is consulted.
        const saved = receipts.authorization(receipt.id, receipt.centerScope ?? '');
        if (!saved) throw new Error('已发回执缺少发送前授权，禁止自动补造');
        const authorizations = receipt.recipients.map(recipient => {
          const grant = saved.authorizations.find(candidate => candidate.contactId === recipient.contactId && candidate.customerId === recipient.centerReference?.customerId);
          if (!grant) throw new Error('已发收件人缺少原始发送授权');
          return grant;
        });
        receipts.record({ ...receipt, authorizations });
        await replay();
        return okResult(undefined);
      }
      catch(error){Log.error('send.receipt','SMTP已接受，回执本地保存失败',error instanceof Error?error.stack:undefined);return failResult('邮件已提交，但记录未保存，禁止自动重发');}
    },
    stats() {
      const current=rows();if(!current.success)return current;const ctx=context()!;
      const history=receipts.history(scopeKey(ctx),true);const latest=new Map<number,string>();
      for(const saved of history)for(const target of saved.receipt.recipients)if(!latest.has(target.contactId))latest.set(target.contactId,saved.receipt.occurredAt);
      const visible=new Map(current.data.map(row=>[row.id,row]));
      const targets=raw.prepare(`SELECT t.contact_id,t.center_reference_json,c.name FROM send_campaign_targets t JOIN send_campaigns c ON c.id=t.campaign_id WHERE t.center_reference_json IS NOT NULL AND t.status IN ('pending','queued') AND c.status IN ('draft','running','paused')`).all() as Array<{contact_id:number;center_reference_json:string;name:string}>;
      const inCampaign=new Map<number,string>();
      for(const target of targets){try{const parsed=JSON.parse(target.center_reference_json);const row=visible.get(target.contact_id);if(parsed.scope===scopeKey(ctx)&&row&&row.centerReference.customerId===parsed.reference.customerId)inCampaign.set(row.id,target.name);}catch(error){Log.warn('send.stats',`任务名单引用损坏: ${error instanceof Error?error.message:'unknown'}`);}}
      return okResult({neverIds:current.data.filter(row=>!latest.has(row.id)&&row.stage==='cold'&&!row.status).map(row=>row.id),lastSent:[...latest].filter(([id])=>visible.has(id)).map(([id,at])=>({id,label:lastLabel(at)})),inCampaign:[...inCampaign].map(([id,campaignName])=>({id,campaignName}))});
    },
    lastAccounts(ids) {
      const ctx=context();const result=new Map<number,number>();if(!ctx)return result;
      for(const saved of receipts.history(scopeKey(ctx),true))for(const target of saved.receipt.recipients)if(ids.includes(target.contactId)&&!result.has(target.contactId))result.set(target.contactId,saved.receipt.accountId);
      return result;
    },
    history() {
      const ctx=context();if(!ctx)return failResult('请登录中心账号');
      return okResult(receipts.history(scopeKey(ctx)).flatMap(saved=>saved.receipt.recipients.map((target,index)=>({id:-(saved.mailIds[0]??0)*CONTACT_MAIL_LIMITS.recipients-index,contactId:target.contactId,email:target.email,firstName:target.name,lastName:null,companyName:saved.receipt.companyName,subject:saved.receipt.subject,accountId:saved.receipt.accountId,accountEmail:saved.accountEmail,sentAt:saved.receipt.occurredAt}))));
    },
    clearHistory(){const ctx=context();if(!ctx)return failResult('请登录中心账号');return okResult(receipts.hideHistory(scopeKey(ctx)));},
  });
  void replay();
  return {replay,close(){closed=true;setCenterSendPort(null);}};
}
