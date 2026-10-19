import type {Result} from './crm';
export interface PasswordChangeRepository {
 changePassword(tokenHash:string,expectedHash:string,securityRevision:number,newHash:string):Promise<Result<void>>;
}
