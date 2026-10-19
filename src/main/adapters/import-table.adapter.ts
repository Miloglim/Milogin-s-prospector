import * as XLSX from 'xlsx';
import { failure, success } from '../../../server/core/crm';
import { ONLINE_LIMITS, type ImportPreview, type Result } from '../../shared/online-crm';
import { WORKBOOK_LIMITS, type ImportSheetPreview } from '../../../server/core/customer-import';

const UTF16_LE_BOM = 0xFEFF;
const UTF16_BE_BOM = 0xFFFE;
const BOM_BYTES = 2;
const PREVIEW_EXTRA_ROWS = 2;
function csvText(bytes: Uint8Array): string {
  const bom = bytes.length >= BOM_BYTES ? bytes[0]! | bytes[1]! << 8 : 0;
  if (bom === UTF16_LE_BOM || bom === UTF16_BE_BOM) return new TextDecoder(bom === UTF16_LE_BOM ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { /* Legacy Excel CSV may use GBK/GB18030; strict fallback never inserts replacement characters. */ return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
}
/** Each worksheet validates independently; irrelevant sheets never block choosing a valid sheet. */
export function parseWorkbookImport(bytes: Uint8Array, fileName: string): Result<ImportPreview> {
  if (bytes.byteLength > ONLINE_LIMITS.fileBytes) return failure('PAYLOAD_TOO_LARGE', '文件超过10MiB限制');
  try {
    const csv = /\.csv$/i.test(fileName);
    const workbook = XLSX.read(csv ? csvText(bytes) : bytes, { type: csv ? 'string' : 'buffer', sheetRows: WORKBOOK_LIMITS.entityRows + PREVIEW_EXTRA_ROWS, raw: csv });
    if (!workbook.SheetNames.length) return failure('INVALID_INPUT', '文件没有可读取的工作表');
    if (workbook.SheetNames.length > WORKBOOK_LIMITS.sheets) return failure('PAYLOAD_TOO_LARGE', '工作表超过20张限制');
    const sheets: ImportSheetPreview[] = workbook.SheetNames.map(sheetName => {
      const result: ImportSheetPreview = { sheetName, headers: [], rows: [], rowNumbers: [] };
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) return { ...result, error: '工作表无法读取' };
      const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : undefined;
      if (range && range.e.c + 1 > WORKBOOK_LIMITS.columns) return { ...result, error: '工作表超过100列限制' };
      // Explicit zero-based range preserves physical row numbers even when !ref starts below row one.
      const grid = range ? XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false, blankrows: true, range: { s: { r: 0, c: 0 }, e: range.e } }) : [];
      const first = grid.findIndex(row => row.some(value => String(value).trim()));
      if (first < 0) return { ...result, error: '工作表没有数据' };
      result.headers = grid[first]!.map(value => String(value).trim());
      while (result.headers.length && !result.headers.at(-1) && grid.slice(first + 1).every(row => !String(row[result.headers.length - 1] ?? '').trim())) result.headers.pop();
      if (result.headers.some(header => !header) || new Set(result.headers.map(header => header.toLowerCase())).size !== result.headers.length) {
        result.error = '表头存在空列名或重复列名，请修正工作表'; return result;
      }
      if (grid.slice(first + 1).some(row => row.slice(result.headers.length).some(value => String(value).trim()))) {
        result.error = '部分数据列没有表头'; return result;
      }
      for (let index = first + 1; index < grid.length; index++) {
        const row = grid[index]!; if (!row.some(value => String(value).trim())) continue;
        result.rows.push(Object.fromEntries(result.headers.map((header, column) => [header, String(row[column] ?? '')]))); result.rowNumbers.push(index + 1);
      }
      if (result.rows.length > WORKBOOK_LIMITS.entityRows || sheet['!fullref'] && sheet['!fullref'] !== sheet['!ref']) result.error = '工作表超过10000行限制，预览已截断，不可导入';
      else if (!result.rows.length) result.error = '工作表只有表头，没有数据记录';
      return result;
    });
    const first = sheets[0]!;
    return success({ fileName, headers: first.headers, rows: first.rows, rowNumbers: first.rowNumbers, sheets });
  } catch { /* Encoding and corrupt workbook failures are returned visibly; source bytes are never changed. */ return failure('INVALID_INPUT', '文件编码或表格格式无效，请使用 UTF-8 CSV 或 XLSX'); }
}
/** Pure buffer parsing, shared by the desktop preview adapter and file regression tests. */
export function parseImportTable(bytes: Uint8Array, fileName: string): Result<ImportPreview> {
  if (bytes.byteLength > ONLINE_LIMITS.fileBytes) return failure('PAYLOAD_TOO_LARGE', '文件超过10MiB限制');
  try {
    const tsv = /\.tsv$/i.test(fileName);
    const csv = /\.(csv|tsv)$/i.test(fileName);
    const workbook = XLSX.read(csv ? csvText(bytes) : bytes, { type: csv ? 'string' : 'buffer', sheetRows: ONLINE_LIMITS.fileRows + PREVIEW_EXTRA_ROWS, raw: csv, ...(tsv ? { FS: '\t' } : {}) });
    const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
    if (!sheet) return failure('INVALID_INPUT', '文件没有可读取的工作表');
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false, blankrows: true });
    const first = grid.findIndex(row => row.some(value => String(value).trim()));
    if (first < 0) return failure('INVALID_INPUT', '文件没有数据');
    const headers = grid[first]!.map(value => String(value).trim());
    while (headers.length && !headers.at(-1) && grid.slice(first + 1).every(row => !String(row[headers.length - 1] ?? '').trim())) headers.pop();
    if (headers.some(header => !header) || new Set(headers.map(header => header.toLowerCase())).size !== headers.length) return failure('INVALID_INPUT', '表头存在空列名或重复列名，请修正后重选文件');
    if (grid.slice(first + 1).some(row => row.slice(headers.length).some(value => String(value).trim()))) return failure('INVALID_INPUT', '部分数据列没有表头');
    const rows: Record<string, string>[] = []; const rowNumbers: number[] = [];
    for (let index = first + 1; index < grid.length; index++) {
      const row = grid[index]!; if (!row.some(value => String(value).trim())) continue;
      rows.push(Object.fromEntries(headers.map((header, column) => [header, String(row[column] ?? '')]))); rowNumbers.push(index + 1);
    }
    if (!rows.length) return failure('INVALID_INPUT', '文件只有表头，没有客户记录');
    if (rows.length > ONLINE_LIMITS.fileRows || sheet['!fullref'] && sheet['!fullref'] !== sheet['!ref']) return failure('PAYLOAD_TOO_LARGE', '文件行数过多，请拆分文件');
    return success({ headers, rows, rowNumbers, fileName });
  } catch { /* Invalid encoding or workbook data is a visible validation error, not a silent partial import. */ return failure('INVALID_INPUT', '文件编码或表格格式无效，请使用 UTF-8 CSV 或 XLSX'); }
}
