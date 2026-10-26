import {failure} from '../core/crm';
import type {TokenPort} from '../core/auth';
import {NOTIFICATION_LIMITS,NOTIFICATION_CURSOR_MAX,type FeedQuery,type NotificationRepository} from '../core/notifications';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DEVICE=new RegExp(`^[A-Za-z0-9_-]{1,${NOTIFICATION_LIMITS.deviceMax}}$`);
const CURSOR=new RegExp(`^(0|[1-9][0-9]{0,${NOTIFICATION_LIMITS.cursorDigits-1}})$`);
export function createNotificationService(repo:NotificationRepository,tokens:TokenPort){
 return {
  async feed(token:string,input:FeedQuery){
   if(!input||typeof input.deviceId!=='string'||!DEVICE.test(input.deviceId)||typeof input.after!=='string'||!CURSOR.test(input.after)||BigInt(input.after)>NOTIFICATION_CURSOR_MAX||!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>NOTIFICATION_LIMITS.pageMax)return failure('INVALID_INPUT','通知分页参数无效');
   return repo.feed(tokens.hash(token),input);
  },
  async read(token:string,id:string){return UUID.test(id)?repo.read(tokens.hash(token),id):failure('INVALID_INPUT','通知标识无效');},
  async readAll(token:string){return repo.readAll(tokens.hash(token));},
  async watermark(token:string){return repo.watermark(tokens.hash(token));},
 };
}
export type NotificationService=ReturnType<typeof createNotificationService>;
