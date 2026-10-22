import {describe,it,expect} from 'vitest';
import {contactMailEvent} from '../../server/services/contact-mail';
import {projectContactMail} from '../../server/core/contact-mail-projection';
const mail={contactId:1,customerId:'00000000-0000-0000-0000-000000000001',eventKey:'new',mailboxKey:'mb',messageKey:'msg',kind:'received',direction:'inbound',occurredAt:'2020-01-02T00:00:00.000Z',subject:'same',preview:'same',fromEmail:'customer@example.invalid',toEmails:['me@example.invalid'],ccEmails:[],correction:{previousEventKey:null,classification:'other'}};
describe('mail classification correction contracts',()=>{
 it('accepts explicit other and subsequent original-time correction',()=>{expect(contactMailEvent(mail).ok).toBe(true);expect(contactMailEvent({...mail,kind:'autoreply',correction:{previousEventKey:'older',classification:'autoreply'}}).ok).toBe(true);});
 it('rejects changedkind, outbound, sendadvance and extra authorizations',()=>{for(const patch of [{kind:'autoreply'},{direction:'outbound'},{advanceSendStage:false},{correction:{previousEventKey:null,classification:'other',revision:9}},{correction:{previousEventKey:'',classification:'other'}},{correction:{classification:'other'}}])expect(contactMailEvent({...mail,...patch}).ok).toBe(false);});
 it('recomputes only effective facts while keeping later independent manual results',()=>{
 const reply={kind:'replied' as const,direction:'inbound',occurredAt:'2020-01-02T00:00:00.000Z',recordedAt:'2026-01-02T00:00:00.000Z',fromEmail:'customer@example.invalid',toEmails:['me@example.invalid']};
 expect(projectContactMail('customer@example.invalid',[reply],[])).toEqual({status:'replied',touchStatus:'replied'});
 expect(projectContactMail('customer@example.invalid',[],[])).toEqual({status:'',touchStatus:'uncontacted'});
 expect(projectContactMail('customer@example.invalid',[reply],[{contactStatus:'contacted',occurredAt:'2021-01-02T00:00:00.000Z',recordedAt:'2021-01-02T00:00:00.000Z'}])).toEqual({status:'reached',touchStatus:'contacted'});
 });
 it('retains independent SMTP-sent contact evidence when a reply is removed',()=>{
 const sent={kind:'sent' as const,direction:'outbound',occurredAt:'2019-01-02T00:00:00.000Z',recordedAt:'2019-01-02T00:00:00.000Z',fromEmail:'me@example.invalid',toEmails:['customer@example.invalid']};
 const cleared={kind:'received' as const,direction:'inbound',occurredAt:mail.occurredAt,recordedAt:'2026-01-02T00:00:00.000Z',fromEmail:mail.fromEmail,toEmails:mail.toEmails};
 expect(projectContactMail('customer@example.invalid',[sent,cleared],[])).toEqual({status:'reached',touchStatus:'contacted'});
 });
 it('preserves autoreply and bounce outcomes without relabeling them as only contacted',()=>{for(const kind of ['autoreply','bounced'] as const){expect(projectContactMail('customer@example.invalid',[{kind,direction:'inbound',occurredAt:mail.occurredAt,recordedAt:mail.occurredAt,fromEmail:mail.fromEmail,toEmails:mail.toEmails}],[])).toEqual({status:kind,touchStatus:kind});}});
});
