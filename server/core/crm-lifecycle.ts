import type { Result } from './crm';
import type { CenterContact } from './center-contacts';
import type { CenterContactRef } from './contact-assignments';

export const COMPANY_ROUTE = '/api/crm/companies';
export const CONTACT_DELETE_ROUTE = '/api/crm/contacts/delete';
export const LIFECYCLE_LIMITS = {batch:200,text:500,key:128,page:50,pageMax:100} as const;
export interface ContactDelete {contacts:Array<CenterContactRef & {expectedVersion:number}>;idempotencyKey:string;}
export interface ContactDeleteReceipt {deleted:Array<CenterContactRef & {contactVersion:number}>;}
export interface CompanyCreate {name:string;domain?:string|null;idempotencyKey:string;}
export interface CompanyDelete {companyId:number;expectedRevision:string;idempotencyKey:string;}
export interface CompanyQuery {search:string;scope:'all'|'personal'|'assigned';limit:number;offset:number;}
export interface CenterCompany {
 companyId:number;customerType?:string|null;name:string;domain:string|null;industry:string|null;country:string|null;size:string|null;
 revision:string;createdAt:string;updatedAt:string;contactCount:number;canDelete:boolean;
}
export interface CompanyPage {items:CenterCompany[];total:number;}
export interface CompanyDetail {company:CenterCompany;contacts:CenterContact[];}
export interface LifecycleRepository {
 deleteContacts(hash:string,input:ContactDelete):Promise<Result<ContactDeleteReceipt>>;
 createCompany(hash:string,input:CompanyCreate):Promise<Result<CompanyDetail>>;
 deleteCompany(hash:string,input:CompanyDelete):Promise<Result<{companyId:number}>>;
 companies(hash:string,input:CompanyQuery):Promise<Result<CompanyPage>>;
 companyDetail(hash:string,input:{companyId:number;scope:CompanyQuery['scope']}):Promise<Result<CompanyDetail>>;
}
