import {describe,expect,it} from 'vitest';
import {hasContactedCustomer,customerBoardStage} from '../../server/core/leads';
describe('followup board admission uses contact state rather than account identity',()=>{
 it('does not mistake relationship stage, delivery, or an unsuccessful attempt for contact',()=>{
  expect(hasContactedCustomer([{touchStatus:'uncontacted'},{touchStatus:'unreachable'}])).toBe(false);
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
