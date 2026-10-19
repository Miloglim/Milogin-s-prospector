import {describe,it,expect} from 'vitest';
import {canEditContactField,shareGrantWithin} from '../../src/renderer/pages/customers/contactRights';
const rights={editableFields:['title','phone'],canFollowup:true,canChangeStage:false,canSendMail:true,canShare:false};
describe('contact renderer rights',()=>{
 it('keeps field edit independent from followup and stage',()=>{expect(canEditContactField(rights,'title')).toBe(true);expect(canEditContactField(rights,'email')).toBe(false);expect(canEditContactField(rights,'relationshipStage')).toBe(false);expect(canEditContactField(rights,'status')).toBe(true);});
 it('does not require field editing for sending or stage permission',()=>{expect(canEditContactField({...rights,editableFields:[],canChangeStage:true},'relationshipStage')).toBe(true);expect(canEditContactField({...rights,canFollowup:false},'status')).toBe(false);});
 it('intersects outgoing grants and never escalates rights',()=>{expect(shareGrantWithin(rights,{editableFields:['title','email'],canFollowup:true,canChangeStage:true})).toEqual({editableFields:['title'],canFollowup:true,canChangeStage:false});});
});
