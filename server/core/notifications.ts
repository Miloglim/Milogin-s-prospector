import type {ContactShareStatus} from './contact-sharing';
import type {Result} from './crm';
import type {ContactAssignmentStatus} from './contact-assignments';
export const NOTIFICATION_ROUTES={feed:'/api/crm/notifications',events:'/api/crm/events'} as const;
export const NOTIFICATION_LIMITS={page:50,pageMax:100,scanMax:500,dispatchBatch:50,deviceMax:80,cursorDigits:19,poll_ms:1000,stream_poll_ms:2000,stream_max:32,buffer_bytes:16384} as const;
export const NOTIFICATION_CURSOR_MAX=9223372036854775807n;
export type NotificationEvent='crm.customer.created'|'crm.lead.published'|'crm.lead.claimed'|'crm.lead.followup'|'crm.lead.assigned'|'crm.task.due'|'crm.opportunity.created'|'crm.opportunity.stage_changed'|'crm.contact.assignment.requested'|'crm.contact.assignment.accepted'|'crm.contact.assignment.rejected'|'crm.contact.assignment.cancelled'|'crm.contact.updated'|'crm.contact.followup'|'crm.contact.share.requested'|'crm.contact.share.accepted'|'crm.contact.share.rejected'|'crm.contact.share.revoked'|'crm.contact.share.updated';
export interface Notification {id:string;eventType:NotificationEvent;customerId:string;version:number;cursor:string;createdAt:string;read:boolean;canOpen?:boolean;taskId?:string;opportunityId?:string;shareTargetUserId?:string;shareId?:string;shareStatus?:ContactShareStatus;requestId?:string;assignmentStatus?:ContactAssignmentStatus;contactId?:number;summary?:{companyName:string;contactName?:string|null;actorName?:string|null;note?:string|null};}
export interface FeedQuery {deviceId:string;after:string;limit:number;}
export interface FeedPage {items:Notification[];nextCursor:string;hasMore:boolean;resyncRequired?:boolean;}
export interface NotificationRepository {
 feed(hash:string,query:FeedQuery):Promise<Result<FeedPage>>;
 read(hash:string,id:string):Promise<Result<void>>;
 watermark(hash:string):Promise<Result<string>>;
 dispatch():Promise<Result<number>>;
}

