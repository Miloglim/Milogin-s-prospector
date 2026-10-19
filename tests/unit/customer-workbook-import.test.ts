import { describe, expect, it } from 'vitest';
import { autoWorkbookMapping, buildWorkbookPlan, normalizeSourceDate, prepareWorkbookRequests, workbookRowIssue, type ImportSheetPreview, type WorkbookImportRow } from '../../server/core/customer-import';
const sheet = (sheetName:string, rows:Record<string,string>[]):ImportSheetPreview => ({ sheetName, headers:Object.keys(rows[0] ?? {}), rows, rowNumbers:rows.map((_,i)=>i+2) });
describe('workbook association rules',()=>{
  it('maps company customer type and contact channels and sources',()=>{
    expect(autoWorkbookMapping(['公司名称','客户类型','电话','WhatsApp','一级来源','二级来源'],'customer')).toMatchObject({companyName:'公司名称',customerType:'客户类型'});
    expect(autoWorkbookMapping(['公司名称','电话','WhatsApp','一级来源','二级来源'],'contact')).toMatchObject({customerRef:'公司名称',phone:'电话',whatsapp:'WhatsApp',sourceLevel1:'一级来源',sourceLevel2:'二级来源'});
  });
  it('normalizes slash and ISO dates identically and treats zoneless times as UTC',()=>{
    expect(normalizeSourceDate('2026/1/2')).toBe('2026-01-02T00:00:00.000Z');
    expect(normalizeSourceDate('2026/1/2')).toBe(normalizeSourceDate('2026-01-02'));
    expect(normalizeSourceDate('2026/1/2 09:30')).toBe('2026-01-02T09:30:00.000Z');
    expect(normalizeSourceDate('2026-01-02T09:30:00+08:00')).toBe('2026-01-02T01:30:00.000Z');
    expect(normalizeSourceDate('2026-02-30')).toBeUndefined();
  });
  it('rejects oversized request metadata and keys before enqueueing',()=>{
    const row:WorkbookImportRow={entity:'customer',sourceRef:'one',companyName:'One',sheetName:'客户',rowNumber:2,rawRow:{}};
    const base={source:'sheet',sourceDetail:'test',idempotencyKey:'key',kind:'operations' as const};
    for(const change of [{source:'s'.repeat(501)},{sourceDetail:'s'.repeat(501)},{idempotencyKey:'k'.repeat(127)}]) expect(prepareWorkbookRequests({...base,...change},[row])).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    const valid=prepareWorkbookRequests({...base,idempotencyKey:'k'.repeat(126)},[row]);expect(valid.ok).toBe(true);
    if(valid.ok)expect(valid.data[0]?.idempotencyKey).toHaveLength(128);
  });
  it.each(['companyName','country','businessType','developmentRestriction','name','phone','title'])('rejects %s longer than editable profile limits',field=>{
    expect(workbookRowIssue({entity:'customer',sourceRef:'one',companyName:'One',sheetName:'客户',rowNumber:2,rawRow:{},[field]:'x'.repeat(501)})).toContain('过长');
  });
  it.each(['2024-02-29','2024/2/29','2024/2/29 09:30','2024-02-29T09:30:59.123Z','2024-02-29T09:30:59+08:00'])('accepts explicit calendar dates %s',sourceCreatedAt=>{
    expect(workbookRowIssue({entity:'customer',sourceRef:'one',companyName:'One',sheetName:'客户',rowNumber:2,rawRow:{},sourceCreatedAt})).toBeUndefined();
  });
  it.each(['not-a-date','02/03/2024','2023-02-29','2024/2/30','2024-13-01','2024-04-31','2024-01-01T25:00','2024-01-01T12:60','2024-01-01T12:30:99','2024-01-01T12:30+24:00','2024-01-01 nonsense'])('marks invalid source dates as row issues before queueing %s',sourceCreatedAt=>{
    const row:WorkbookImportRow={entity:'customer',sourceRef:'one',companyName:'One',sheetName:'客户',rowNumber:2,rawRow:{},sourceCreatedAt};
    expect(workbookRowIssue(row)).toContain('时间');
    expect(prepareWorkbookRequests({source:'sheet',sourceDetail:'test',idempotencyKey:'key',kind:'operations'},[row])).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
  });
  it('enforces the existing 254-character email limit',()=>{
    expect(workbookRowIssue({entity:'contact',sourceRef:'one',customerRef:'parent',email:'a'.repeat(250)+'@a.invalid',sheetName:'联系人',rowNumber:2,rawRow:{}})).toContain('邮箱');
  });
  it('maps business headers and associates multiple contacts without inventing emails',()=>{
    const customers=sheet('客户',[{客户抬头:' Acme ',所在国家:'中国',客户类别:'直客;不跟进;已合作',创建时间:'2024-01-01'}]);
    const contacts=sheet('联系人',[{客户抬头:'acme',联系人姓名:'张三',职务:'经理',电话:'123'},{客户抬头:'ACME',联系人姓名:'李四',职务:'总监',电话:'456'}]);
    const plan=buildWorkbookPlan(customers,contacts,{customer:autoWorkbookMapping(customers.headers,'customer'),contact:autoWorkbookMapping(contacts.headers,'contact')});
    expect(plan.customers[0]?.input).toMatchObject({companyName:'Acme',customerType:'直客',developmentRestriction:'不跟进',sourceCreatedAt:'2024-01-01'});
    expect(plan.customers[0]?.issue).toContain('已合作');
    expect(plan.contacts).toHaveLength(2);
    expect(plan.contacts.every(row=>!row.issue && row.input.customerRef===plan.customers[0]?.input.sourceRef)).toBe(true);
    expect(plan.contacts[0]?.input.email).toBeUndefined();
  });
  it('keeps every source row and exposes exact duplicate names and unmatched contacts',()=>{
    const customers=sheet('客户',[{ID:'1',客户抬头:'Same'},{ID:'2',客户抬头:' same '},{ID:'3',客户抬头:''}]);
    const contacts=sheet('联系人',[{客户抬头:'SAME',联系人姓名:'One'},{客户抬头:'Missing',联系人姓名:'Two'}]);
    const plan=buildWorkbookPlan(customers,contacts,{customer:autoWorkbookMapping(customers.headers,'customer'),contact:autoWorkbookMapping(contacts.headers,'contact')});
    expect(plan.customers).toHaveLength(3); expect(plan.customers[2]?.issue).toBeTruthy();
    expect(plan.contacts[0]?.candidates).toHaveLength(2); expect(plan.contacts[0]?.issue).toContain('歧义');
    expect(plan.contacts[1]?.issue).toContain('匹配');
  });
  it('rejects duplicate source references and invalid rows, preserves raw source values',()=>{
    const customers=sheet('客户',[{ID:'1',客户抬头:'One'},{ID:'1',客户抬头:'Two'}]);
    const plan=buildWorkbookPlan(customers,undefined,{customer:autoWorkbookMapping(customers.headers,'customer'),contact:{}});
    expect(plan.customers.every(row=>row.issue?.includes('重复'))).toBe(true);
    expect(plan.customers[0]?.input.rawRow).toEqual(customers.rows[0]);
    expect(workbookRowIssue({...plan.customers[0]!.input,sourceRef:''})).toBeTruthy();
  });
  it('splits requests by actual UTF8 bytes and row count without losing rows',()=>{
    const row:WorkbookImportRow={entity:'customer',sourceRef:'one',companyName:'One',sheetName:'客户',rowNumber:2,rawRow:{note:'中'.repeat(3000)}};
    const result=prepareWorkbookRequests({source:'sheet',sourceDetail:'test',idempotencyKey:'key',kind:'operations'},Array.from({length:250},(_,i)=>({...row,sourceRef:String(i),rowNumber:i+2})));
    expect(result.ok).toBe(true); if(!result.ok)return;
    expect(result.data.flatMap(batch=>batch.rows)).toHaveLength(250);
    expect(new Set(result.data.map(batch=>batch.idempotencyKey)).size).toBe(result.data.length);
    expect(result.data.every(batch=>batch.rows.length<=200 && Buffer.byteLength(JSON.stringify(batch),'utf8')<=1048576)).toBe(true);
  });
  it('flags same email reused across customer references with duplicate candidates',()=>{
    const customers=sheet('客户',[{ID:'one',客户抬头:'One'},{ID:'two',客户抬头:'Two'}]);
    const contacts=sheet('联系人',[{客户ID:'one',邮箱:'same@example.invalid'},{客户ID:'two',邮箱:'same@example.invalid'}]);
    const plan=buildWorkbookPlan(customers,contacts,{customer:autoWorkbookMapping(customers.headers,'customer'),contact:autoWorkbookMapping(contacts.headers,'contact')});
    expect(plan.contacts.every(row=>row.issue?.includes('重复') && row.candidates.length===2)).toBe(true);
  });
  it('enforces selected entity limits and rejects a single oversized source row',()=>{
    const row:WorkbookImportRow={entity:'customer',sourceRef:'one',companyName:'One',sheetName:'客户',rowNumber:2,rawRow:{}};
    const base={source:'sheet',sourceDetail:'test',idempotencyKey:'key',kind:'operations' as const};
    expect(prepareWorkbookRequests(base,Array.from({length:10001},()=>row))).toMatchObject({ok:false,error:{code:'PAYLOAD_TOO_LARGE'}});
    expect(prepareWorkbookRequests(base,[{...row,rawRow:{note:'中'.repeat(400000)}}])).toMatchObject({ok:false,error:{code:'PAYLOAD_TOO_LARGE'}});
  });
  it('revalidates edited duplicate references before preparing requests',()=>{
    const row:WorkbookImportRow={entity:'customer',sourceRef:'one',companyName:'One',sheetName:'客户',rowNumber:2,rawRow:{}};
    expect(prepareWorkbookRequests({source:'sheet',sourceDetail:'test',idempotencyKey:'key',kind:'operations'},[row,{...row,sourceRef:' ONE ',rowNumber:3}])).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
  });
  it('does not split a business type merely because it contains a space',()=>{
    const customers=sheet('客户',[{客户抬头:'One',业务类型:'Direct customer'}]);
    const plan=buildWorkbookPlan(customers,undefined,{customer:autoWorkbookMapping(customers.headers,'customer'),contact:{}});
    expect(plan.customers[0]?.input.businessType).toBe('Direct customer');
  });
});
