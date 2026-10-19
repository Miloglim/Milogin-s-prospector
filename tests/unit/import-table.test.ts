import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseImportTable, parseWorkbookImport } from '../../src/main/adapters/import-table.adapter';

const text = '公司名称,邮箱\n中文公司,a@example.invalid\n';
describe('center import file preview', () => {
  it('uses tab separators for pasted Excel cells containing commas and quoted newlines', () => {
    const result = parseImportTable(Buffer.from('公司\t邮箱\t备注\n"Synthetic, Company"\tlead@example.invalid\t"Line one\nLine two"\n'), 'paste.tsv');
    expect(result).toMatchObject({ ok: true, data: { headers: ['公司', '邮箱', '备注'], rows: [{ 公司: 'Synthetic, Company', 邮箱: 'lead@example.invalid', 备注: 'Line one\nLine two' }] } });
  });
  it('enforces raw byte size before parsing a table', () => {
    expect(parseImportTable(Buffer.alloc(10485761), 'too-large.csv')).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
  });
  it('previews a seven-sheet 16740-row workbook with customer2461/contact8760',()=>{
    const book=XLSX.utils.book_new();
    const sizes=[2461,8760,1500,1500,1000,1000,519];
    for(const [index,size] of sizes.entries()) XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['名称'],...Array.from({length:size},(_,row)=>[`行${row}`])]),`表${index}`);
    const result=parseWorkbookImport(XLSX.write(book,{type:'buffer',bookType:'xlsx'}),'all.xlsx');
    expect(result.ok).toBe(true); if(!result.ok)return;
    expect(result.data.sheets?.map(item=>item.rows.length)).toEqual(sizes);
    expect(result.data.sheets?.every(item=>!item.error)).toBe(true);
  });
  it('marks oversized sheets as truncated while retaining other sheets',()=>{
    const book=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['名称'],...Array.from({length:10002},(_,row)=>[`行${row}`])]),'超限');
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['名称'],['正常']]),'正常');
    const result=parseWorkbookImport(XLSX.write(book,{type:'buffer',bookType:'xlsx'}),'all.xlsx');
    expect(result.ok).toBe(true); if(!result.ok)return;
    expect(result.data.sheets?.[0]?.error).toContain('截断'); expect(result.data.sheets?.[1]?.error).toBeUndefined();
  });
  it('preserves seven sheets and per-sheet errors without rejecting valid entity sheets',()=>{
    const book=XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([[],['客户抬头'],['Acme']]),'客户');
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['客户抬头','联系人姓名'],['Acme','张三']]),'联系人');
    XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['重复','重复'],['a','b']]),'无关');
    for(let i=0;i<4;i++) XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['表头'],['值']]),`副本${i}`);
    const result=parseWorkbookImport(XLSX.write(book,{type:'buffer',bookType:'xlsx'}),'all.xlsx');
    expect(result.ok).toBe(true); if(!result.ok)return;
    expect(result.data.sheets).toHaveLength(7); expect(result.data.sheets?.[0]?.rowNumbers).toEqual([3]);
    expect(result.data.sheets?.[2]?.error).toContain('表头');
  });
  it.each(['', '\uFEFF'])('reads Chinese UTF-8 with or without BOM (%j)', bom => {
    const result = parseImportTable(Buffer.from(bom + text), 'leads.csv');
    expect(result).toMatchObject({ ok: true, data: { headers: ['公司名称', '邮箱'], rows: [{ 公司名称: '中文公司', 邮箱: 'a@example.invalid' }], rowNumbers: [2] } });
  });
  it('keeps quoted multiline CSV and actual spreadsheet row numbers', () => {
    const result = parseImportTable(Buffer.from('公司名称,邮箱\n\n"中文,公司\n分部",a@example.invalid\n'), 'leads.csv');
    expect(result).toMatchObject({ ok: true, data: { rows: [{ 公司名称: '中文,公司\n分部', 邮箱: 'a@example.invalid' }], rowNumbers: [3] } });
  });
  it('reads UTF-16LE marked CSV', () => {
    expect(parseImportTable(Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]), 'leads.csv')).toMatchObject({ ok: true, data: { headers: ['公司名称', '邮箱'] } });
  });
  it('reads marked UTF-16BE and rejects undecodable bytes', () => {
    const bytes = Buffer.from('\uFEFF' + text, 'utf16le'); bytes.swap16();
    expect(parseImportTable(bytes, 'leads.csv')).toMatchObject({ ok: true, data: { headers: ['公司名称', '邮箱'] } });
    expect(parseImportTable(Buffer.from([0x81]), 'leads.csv').ok).toBe(false);
  });
  it('rejects over-limit spreadsheets without silently returning a truncated preview', () => {
    const input = Buffer.from('公司,邮箱\n' + 'Test,a@example.invalid\n'.repeat(10001));
    expect(parseImportTable(input, 'leads.csv')).toMatchObject({ ok: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
  });
  it('reads GB18030 CSV using strict decoding', () => {
    const bytes = Buffer.concat([Buffer.from('b9abcbbec3fbb3c62cd3cacfe40a', 'hex'), Buffer.from('Test,a@example.invalid\n')]);
    expect(parseImportTable(bytes, 'leads.csv')).toMatchObject({ ok: true, data: { headers: ['公司名称', '邮箱'] } });
  });
  it('retains XLSX formatting and rejects ambiguous headers instead of silently renaming them', () => {
    const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['公司名称', '邮箱'], ['中文公司', 'a@example.invalid']]), 'Sheet1');
    expect(parseImportTable(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }), 'leads.xlsx')).toMatchObject({ ok: true, data: { rows: [{ 公司名称: '中文公司', 邮箱: 'a@example.invalid' }] } });
    for (const input of ['公司,公司\na,b\n', '公司,\na,b\n', '']) expect(parseImportTable(Buffer.from(input), 'leads.csv').ok).toBe(false);
  });
});
