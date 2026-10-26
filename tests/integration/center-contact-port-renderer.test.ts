import { describe, expect, it } from 'vitest';
import { createCenterContactPort, createCenterImportPort } from '../../src/renderer/pages/customers/centerContactPort';
import { LEAD_IMPORT_FIELDS, leadImportMapping } from '../../server/core/lead-import-fields';
import { ONLINE_CHANNELS, type CenterContact, type ImportRequest } from '../../src/shared/online-crm';

const contact = { contactId: 72, customerId: '12345678-1234-1234-1234-123456789abc', customerVersion: 4, contactVersion: 3, companyId: 9, companyName: 'Center company', email: 'a@example.invalid', firstName: 'Alice', lastName: null, title: 'Manager', phone: null, linkedinUrl: null, country: null, clientType: null, language: null, stage: 'cold', status: '', tags: ['priority'], extra: {}, touchStatus: 'contacted', relationshipStage: 'quoting', assignee: '', source: 'fixture', sourceDetail: null, createdAt: '2026-10-14', updatedAt: '2026-10-14', ownerUserId: null, ownerName: null, origin: 'operations', state: 'draft' } as CenterContact;

describe('center data port for original contact table', () => {
  it('uses the documented aliases and imports all lead fields without requiring a customer number or email',async()=>{
    const raw={'公司名称':'Test Company','国家':'Brazil','客户类型':'代理','业务类型':'海运','官网':'https://example.invalid','联系人姓名':'Alice','联系人title':'Manager','电话':'+55 111','Whats App':'+55 222','来源':'展会','二级来源':'上海展'};
    const calls:unknown[]=[];
    const port=createCenterImportPort(async(channel,input)=>{
      if(channel===ONLINE_CHANNELS.PREVIEW)return {ok:true,data:{headers:Object.keys(raw),rows:[raw],fileName:'test.xlsx'}} as never;
      calls.push(input);return {ok:true,data:{batchId:'b',version:1,rows:[{rowId:'r',index:0,status:'created',customerId:contact.customerId}]}} as never;
    },true,()=>{});
    const file={type:'xlsx' as const,data:'fixture'};
    const preview=await port.preview(file);
    expect(preview.success).toBe(true);
    expect(await port.execute({...file,mapping:preview.data!.suggestedMapping})).toMatchObject({success:true,data:{imported:1}});
    expect(calls[0]).toMatchObject({companyMatching:true,rows:[{companyName:'Test Company',customerType:'代理',businessType:'海运',website:'https://example.invalid',name:'Alice',title:'Manager',email:'',phone:'+55 111',whatsapp:'+55 222',sourceLevel1:'展会',sourceLevel2:'上海展'}]});
    for(const field of LEAD_IMPORT_FIELDS)for(const alias of field.aliases)expect(leadImportMapping([alias])[field.key]).toBe(alias);
    expect(leadImportMapping(['电话','phone']).phone).toBeUndefined();
  });
  it('rejects conflicting company fields before writing any batch',async()=>{
    let writes=0;
    const port=createCenterImportPort(async(channel)=>{
      if(channel===ONLINE_CHANNELS.PREVIEW)return {ok:true,data:{headers:['公司','姓名','客户类型'],rows:[{'公司':'Same','姓名':'A','客户类型':'代理'},{'公司':'Same','姓名':'B','客户类型':'直客'}],fileName:'test.csv'}} as never;
      writes++;throw Error('must not write');
    },true,()=>{});
    const file={type:'csv' as const,data:'fixture'};
    const preview=await port.preview(file);
    expect(await port.execute({...file,mapping:preview.data!.suggestedMapping})).toMatchObject({success:false,error:expect.stringContaining('不一致')});
    expect(writes).toBe(0);
  });
  it('keeps display identity explicit and sends every read to the center', async () => {
    const calls: Array<[string, unknown]> = [];
    const port = createCenterContactPort({ key: 'fixture', invoke: async (channel, input) => { calls.push([channel, input]); return { ok: true, data: { items: [contact], total: 1 } }; } });
    const page = await port.list({ page: 1 });
    expect(page.success).toBe(true);
    expect(page.data?.items[0]).toMatchObject({
      id: 72,
      dataSource: 'center',
      contactId: 72,
      customerId: contact.customerId,
      touchStatus: 'contacted',
      relationshipStage: 'quoting',
      tags: '["priority"]',
    });
    expect(calls[0]?.[0]).toBe(ONLINE_CHANNELS.CONTACT_LIST);
    expect(await port.delete(72)).toMatchObject({ success: false });
    expect(calls.some(([channel]) => channel.startsWith('contacts:'))).toBe(false);
  });
  it('selects every matching page and rejects a partial unavailable selection', async () => {
    const port = createCenterContactPort({ key: 'fixture', invoke: async (_channel, input) => (input as { offset: number }).offset ? { ok: false, error: { code: 'UNAVAILABLE', message: '离线' } } : { ok: true, data: { items: [contact], total: 101 } } });
    expect(await port.listIds({})).toMatchObject({ success: false, error: '离线' });
  });
  it('keeps the follow-up board query filtered instead of scanning all contacts', async () => {
    const calls: Array<[string, unknown]> = [];
    const port = createCenterContactPort({ key: 'board', invoke: async (channel, input) => { calls.push([channel, input]); return { ok: true, data: { items: [contact], total: 1 } }; } });
    expect(await port.readAll({ followupOnly: true })).toMatchObject({ success: true, data: [contact] });
    expect(calls[0]).toEqual([ONLINE_CHANNELS.CONTACT_LIST, expect.objectContaining({ followupOnly: true, limit: 100, offset: 0 })]);
  });
  it('creates through the existing center import contract, preserving all original drawer fields and one retry key', async () => {
    let attempts = 0; const calls: unknown[] = [];
    const port = createCenterContactPort({key:'manual', invoke: async (channel, input) => {
      expect(channel).toBe(ONLINE_CHANNELS.IMPORT); calls.push(input); attempts++;
      return attempts === 1 ? {ok:false,error:{code:'UNAVAILABLE',message:'timeout'}} : {ok:true,data:{batchId:'b',version:1,rows:[{rowId:'r',index:0,status:'created',customerId:contact.customerId}]}};
    }});
    const input = {companyName:'Company',email:'new@example.invalid',firstName:'New',lastName:'Buyer',title:'Manager',linkedinUrl:'https://example.invalid/profile'};
    expect(await port.upsert(input)).toMatchObject({success:false});
    expect(await port.upsert(input)).toMatchObject({success:true});
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toMatchObject({rows:[{firstName:'New',lastName:'Buyer',linkedinUrl:input.linkedinUrl}]});
  });
  it('creates manual contacts with company matching and the same company/contact fields as file import', async () => {
    const calls: ImportRequest[] = [];
    const port = createCenterContactPort({key:'manual-fields',invoke:async (_channel,input)=>{
      calls.push(input as ImportRequest);return {ok:true,data:{batchId:'b',version:1,rows:[{rowId:'r',index:0,status:'created',customerId:contact.customerId}]}};
    }});
    const input={companyName:' Same Company ',customerType:'代理',country:'BR',businessType:'海运',website:'https://example.invalid',firstName:'Alice',phone:'+55 111',whatsapp:'+55 222',sourceLevel1:'展会',sourceLevel2:'上海展',stage:'cold',language:'EN'};
    expect(await port.upsert(input)).toMatchObject({success:true});
    expect(calls[0]).toMatchObject({companyMatching:true,source:'manual',rows:[{...input,companyName:'Same Company',email:''}]});
    expect(calls[0].rows[0]).not.toHaveProperty('clientType');
    await port.upsert({...input,firstName:'Bob',email:'b@example.invalid'});
    expect(calls[0].rows[0].customerKey).toBe(calls[1].rows[0].customerKey);
  });
  it('exports current scope and filters, quotes formula-like values as text, and propagates errors', async () => {
    const port = createCenterContactPort({key:'export',scope:'assigned',invoke: async (_channel,input) => {
      expect(input).toMatchObject({scope:'assigned',search:'test',country:'BR'});
      return {ok:true,data:{items:[{...contact,firstName:'=unsafe',clientType:'agent',businessType:'海运',website:'https://example.invalid',phone:'111',whatsapp:'222',sourceLevel1:'展会',sourceLevel2:'上海展',extra:{note:'Profile：展会客户\n邮箱有效性：有效'}}],total:1}};
    }});
    const result = await port.export!('contacts',{search:'test',country:'BR'});
    expect(result.success).toBe(true); expect(result.data).toContain("'=unsafe");
    for(const value of ['公司名','职位 / Title','客户类型','代理','业务类型','海运','网站','https://example.invalid','WhatsApp','222','一级来源','展会','二级来源','上海展','导入批次来源','备注','Profile：展会客户\n邮箱有效性：有效']) expect(result.data).toContain(`"${value}"`);
  });

});
