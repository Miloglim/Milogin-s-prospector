import {describe,it,expect} from 'vitest';
import {contactShareCreate,contactShareQuery,contactShareDecision,contactShareUpdate} from '../../server/services/contact-sharing';
const id='00000000-0000-0000-0000-000000000001';
const create={contactId:1,customerId:id,targetUserId:id,expectedVersion:1,idempotencyKey:'key',editableFields:['phone'],canFollowup:false,canChangeStage:true};
describe('contact sharing input contracts',()=>{
 it('accepts independent followup, stage, send-independent field grants',()=>{expect(contactShareCreate(create).ok).toBe(true);expect(contactShareCreate({...create,editableFields:[]}).ok).toBe(true);});
 it('rejects undelegable fields and caller-supplied send/ownership flags',()=>{for(const f of ['email','stage','status','tags','preferences'])expect(contactShareCreate({...create,editableFields:[f]}).ok).toBe(false);expect(contactShareCreate({...create,canSendMail:true}).ok).toBe(false);expect(contactShareCreate({...create,editableFields:['phone','phone']}).ok).toBe(false);});
 it('validates query bounds and unexpected role scope',()=>{expect(contactShareQuery({}).ok).toBe(true);expect(contactShareQuery({limit:101}).ok).toBe(false);expect(contactShareQuery({view:'all'}).ok).toBe(false);expect(contactShareQuery({userId:id}).ok).toBe(false);});
 it('requires independent share version and valid action body',()=>{expect(contactShareDecision({shareId:id,expectedVersion:1,idempotencyKey:'x'}).ok).toBe(true);expect(contactShareDecision({shareId:id,expectedVersion:0,idempotencyKey:'x'}).ok).toBe(false);expect(contactShareUpdate({shareId:id,expectedVersion:1,idempotencyKey:'x',editableFields:[],canFollowup:false,canChangeStage:false}).ok).toBe(true);});
});
