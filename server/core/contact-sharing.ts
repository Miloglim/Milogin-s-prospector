import type {Result} from './crm';
import type {CenterContactRef} from './contact-assignments';
export const CONTACT_SHARING_ROUTES={shares:'/api/crm/contact-shares',members:'/api/crm/contact-shares/members'} as const;
export const CONTACT_SHARING_EVENTS={requested:'crm.contact.share.requested',accepted:'crm.contact.share.accepted',rejected:'crm.contact.share.rejected',revoked:'crm.contact.share.revoked',updated:'crm.contact.share.updated'} as const;
export const CONTACT_SHARED_FIELDS=['firstName','lastName','title','phone','whatsapp','linkedinUrl','country','language','clientType'] as const;
export interface ContactPermissions {editableFields:string[];canFollowup:boolean;canChangeStage:boolean;canSendMail:boolean;canShare:boolean;}
export interface ContactShareGrant {editableFields:string[];canFollowup:boolean;canChangeStage:boolean;}
export type ContactShareStatus='pending'|'accepted'|'rejected'|'revoked';
export interface ContactShare extends CenterContactRef,ContactShareGrant {shareId:string;grantorUserId:string;grantorName:string;targetUserId:string;targetName:string;contactName:string;companyName:string;status:ContactShareStatus;version:number;createdAt:string;canAccept:boolean;canReject:boolean;canManage:boolean;}
export interface ContactShareCreate extends CenterContactRef,ContactShareGrant {expectedVersion:number;targetUserId:string;idempotencyKey:string;}
export interface ContactShareDecision {shareId:string;expectedVersion:number;idempotencyKey:string;}
export interface ContactShareUpdate extends ContactShareDecision,ContactShareGrant {}
export interface ContactShareQuery {view:'incoming'|'outgoing';status?:ContactShareStatus;contactId?:number;customerId?:string;limit:number;offset:number;}
export interface ContactSharePage {items:ContactShare[];total:number;}
export interface ContactShareMember {userId:string;displayName:string;}
export interface ContactSharingRepository {
 shares(hash:string,input:ContactShareQuery):Promise<Result<ContactSharePage>>;
 createShare(hash:string,input:ContactShareCreate):Promise<Result<ContactShare>>;
 decideShare(hash:string,action:'accept'|'reject'|'revoke',input:ContactShareDecision):Promise<Result<ContactShare>>;
 updateShare(hash:string,input:ContactShareUpdate):Promise<Result<ContactShare>>;
 shareMembers(hash:string):Promise<Result<ContactShareMember[]>>;
}
