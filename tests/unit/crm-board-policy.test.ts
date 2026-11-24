import {describe,expect,it} from 'vitest';
import {BOARD_ACTIVE_RELATIONSHIP_STAGES,CUSTOMER_ATTENTION_URGENCY_PRIORITY,attentionDueDayOffset,customerAttentionUrgency,customerBoardAttentionReason,customerNeedsAttention,hasContactedCustomer,customerBoardStage} from '../../server/core/leads';
describe('customer board admission uses actionable contact-level attention',()=>{
 it('keeps contacted, bounced and autoreply out of board admission by themselves',()=>{
  for(const touchStatus of ['contacted','bounced','autoreply'] as const){
   expect(customerNeedsAttention({touchStatus})).toBe(false);
   expect(customerBoardAttentionReason({touchStatus})).toBeUndefined();
  }
 });
 it('admits a real reply on that contact with reply reason',()=>{
  expect(customerBoardAttentionReason({touchStatus:'replied'})).toBe('reply');
 });
 it('admits an open task only for the matching or deterministic primary contact',()=>{
  expect(customerBoardAttentionReason({openTaskMatchesContact:true})).toBe('task');
  expect(customerNeedsAttention({openTaskMatchesContact:false,isPrimaryContact:true})).toBe(false);
 });
 it.each(BOARD_ACTIVE_RELATIONSHIP_STAGES)('admits active stage %s only for the primary contact',stage=>{
  expect(customerBoardAttentionReason({relationshipStage:stage,isPrimaryContact:true})).toBe('stage');
  expect(customerNeedsAttention({relationshipStage:stage,isPrimaryContact:false})).toBe(false);
 });
 it('does not admit cold or reaching without reply, task or active stage',()=>{
  expect(customerNeedsAttention({touchStatus:'uncontacted',relationshipStage:'cold',isPrimaryContact:true})).toBe(false);
  expect(customerNeedsAttention({touchStatus:'contacted',relationshipStage:'reaching',isPrimaryContact:true})).toBe(false);
 });
});
describe('contact utility compatibility',()=>{
 it('does not mistake relationship stage, delivery, or an unsuccessful attempt for contact',()=>{
  expect(hasContactedCustomer([{touchStatus:'uncontacted'}])).toBe(false);
  expect(hasContactedCustomer([{touchStatus:'bounced'}])).toBe(true);
  expect(hasContactedCustomer([])).toBe(false);
  expect(customerBoardStage({stage:'quoting',hasContacted:false})).toBeUndefined();
 });
 it('includes reached or replied contacts, defaulting an unclassified reached customer to reaching',()=>{
  expect(hasContactedCustomer([{touchStatus:'contacted'}])).toBe(true);
  expect(hasContactedCustomer([{touchStatus:'replied'}])).toBe(true);
  expect(customerBoardStage({stage:'cold',hasContacted:true})).toBe('reaching');
  expect(customerBoardStage({stage:'quoting',hasContacted:true})).toBe('quoting');
 });
});
describe('customer attention urgency',()=>{
 const now=new Date(2026,10,17,12,0,0);
 const due=(day:number,hour=12)=>new Date(2026,10,day,hour,0,0).toISOString();
 it('uses overdue, reply, today, future task, stage precedence',()=>{
  expect(customerAttentionUrgency({attentionReason:'reply',attentionDueAt:due(16)},now)).toBe('overdue');
  expect(customerAttentionUrgency({attentionReason:'reply'},now)).toBe('reply');
  expect(customerAttentionUrgency({attentionReason:'task',attentionDueAt:due(17,23)},now)).toBe('due_today');
  expect(customerAttentionUrgency({attentionReason:'task',attentionDueAt:due(18)},now)).toBe('upcoming_task');
  expect(customerAttentionUrgency({attentionReason:'stage'},now)).toBe('stage');
  expect([
   customerAttentionUrgency({attentionReason:'stage'},now)!,
   customerAttentionUrgency({attentionReason:'task',attentionDueAt:due(18)},now)!,
   customerAttentionUrgency({attentionReason:'task',attentionDueAt:due(17)},now)!,
   customerAttentionUrgency({attentionReason:'reply'},now)!,
   customerAttentionUrgency({attentionReason:'task',attentionDueAt:due(16)},now)!,
  ].sort((left,right)=>CUSTOMER_ATTENTION_URGENCY_PRIORITY[left]-CUSTOMER_ATTENTION_URGENCY_PRIORITY[right])).toEqual(['overdue','reply','due_today','upcoming_task','stage']);
 });
 it('compares calendar days in local time at the day boundary',()=>{
  expect(attentionDueDayOffset(new Date(2026,10,16,23,59).toISOString(),new Date(2026,10,17,0,1))).toBe(-1);
  expect(attentionDueDayOffset(new Date(2026,10,17,0,0).toISOString(),new Date(2026,10,17,23,59))).toBe(0);
  expect(attentionDueDayOffset('not-a-date',now)).toBeNull();
 });
});
