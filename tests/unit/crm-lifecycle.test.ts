import { describe, it, expect } from 'vitest';
import { contactDelete, companyCreate, companyDelete, companyQuery } from '../../server/services/crm-lifecycle';
describe('CRM lifecycle contracts', () => {
  const ref = {contactId:1,customerId:'12345678-1234-1234-1234-123456789abc',expectedVersion:1};
  it('requires explicit versions, distinct references and a bounded atomic batch', () => {
    const input={contacts:[ref],idempotencyKey:'stable'};
    expect(contactDelete(input)).toMatchObject({ok:true});
    for(const value of [{...input,contacts:[ref,ref]},{...input,contacts:[{...ref,expectedVersion:0}]},{...input,contacts:[]},{...input,actorId:'fake'}, {...input,contacts:Array.from({length:201},(_,i)=>({...ref,contactId:i+1}))}]) expect(contactDelete(value)).toMatchObject({ok:false});
  });
  it('normalizes company fields but never accepts caller authority or deletion bypasses', () => {
    expect(companyCreate({name:'  Freight  ',domain:' EXAMPLE.COM ',idempotencyKey:'key'})).toMatchObject({ok:true,data:{name:'Freight',domain:'example.com'}});
    for(const value of [{name:'',idempotencyKey:'key'}, {name:'x',createdBy:'fake',idempotencyKey:'key'},{name:'x',domain:'https://x.com/a',idempotencyKey:'key'}])expect(companyCreate(value)).toMatchObject({ok:false});
    expect(companyDelete({companyId:1,expectedRevision:'revision',idempotencyKey:'key'})).toMatchObject({ok:true});
    expect(companyDelete({companyId:1,expectedRevision:'revision',idempotencyKey:'key',force:true})).toMatchObject({ok:false});
    expect(companyQuery({search:'x',scope:'assigned',limit:50,offset:0})).toMatchObject({ok:true});
    expect(companyQuery({limit:101})).toMatchObject({ok:false});
  });
});
