import * as XLSX from 'xlsx';
import { failure, success } from '../../../server/core/crm';
import { ONLINE_LIMITS, type ImportPreview, type Result } from '../../shared/online-crm';
import { WORKBOOK_LIMITS, type ImportSheetPreview } from '../../../server/core/customer-import';

const UTF16_LE_BOM = 0xFEFF;
const UTF16_BE_BOM = 0xFFFE;
const BOM_BYTES = 2;
const PREVIEW_EXTRA_ROWS = 2;
const UNNAMED_HEADER_PREFIX = '未命名列';
const BASE64_BLOCK_SIZE = 4;
const BASE64_DOUBLE_PADDING = 2;
const BASE64_SINGLE_PADDING = 1;
const BASE64_PADDING = '=';
const ASCII_MAX = 0x7F;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_CHARACTERS = (() => {
  const table = new Uint8Array(ASCII_MAX + 1);
  for (const character of BASE64_ALPHABET) table[character.charCodeAt(0)] = 1;
  return table;
})();

/** Large uploads must not use a repeated regex group; multi-megabyte strings can exhaust the call stack. */
export function isValidBase64(value: string): boolean {
  if (value.length % BASE64_BLOCK_SIZE !== 0) return false;
  const padding = value.endsWith(`${BASE64_PADDING}${BASE64_PADDING}`)
    ? BASE64_DOUBLE_PADDING
    : value.endsWith(BASE64_PADDING) ? BASE64_SINGLE_PADDING : 0;
  const contentEnd = value.length - padding;
  if (contentEnd < 0 || value.length > padding && contentEnd === 0) return false;
  for (let index = 0; index < contentEnd; index++) {
    if (!BASE64_CHARACTERS[value.charCodeAt(index)]) return false;
  }
  for (let index = contentEnd; index < value.length; index++) {
    if (value[index] !== BASE64_PADDING) return false;
  }
  return true;
}
interface SparseSheetRows {
  headers: string[];
  rows: Record<string, string>[];
  rowNumbers: number[];
  hasUnheadedDataColumn: boolean;
  columnCount: number;
}

/** Read only real cells; worksheet !ref may contain a huge sparse rectangle around one stray cell. */
function sparseSheetRows(sheet: XLSX.WorkSheet): SparseSheetRows | undefined {
  const byRow = new Map<number, Map<number, string>>();
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!')) continue;
    const cell = sheet[address] as XLSX.CellObject | undefined;
    if (!cell) continue;
    const value = String(cell.w ?? XLSX.utils.format_cell(cell));
    if (!value.trim()) continue;
    const position = XLSX.utils.decode_cell(address);
    const row = byRow.get(position.r) ?? new Map<number, string>();
    row.set(position.c, value);
    byRow.set(position.r, row);
  }
  const headerRow = Math.min(...byRow.keys());
  if (!Number.isFinite(headerRow)) return undefined;
  const headerCells = byRow.get(headerRow)!;
  const headerWidth = Math.max(...headerCells.keys()) + 1;
  const dataColumns = new Set([...byRow.entries()].filter(([row]) => row > headerRow).flatMap(([, cells]) => [...cells.keys()].filter(column => column < headerWidth)));
  const headerColumns = Array.from({ length: headerWidth }, (_, column) => column)
    .filter(column => Boolean(headerCells.get(column)?.trim()) || dataColumns.has(column))
    .map(column => [column, headerCells.get(column)?.trim() || `${UNNAMED_HEADER_PREFIX}${column + 1}`] as const);
  const headers = headerColumns.map(([, value]) => value);
  const rows: Record<string, string>[] = [];
  const rowNumbers: number[] = [];
  let hasUnheadedDataColumn = false;
  for (const rowNumber of [...byRow.keys()].filter(row => row > headerRow).sort((left, right) => left - right)) {
    const cells = byRow.get(rowNumber)!;
    hasUnheadedDataColumn ||= cells.has(headerWidth);
    if (!headerColumns.some(([column]) => cells.has(column))) continue;
    rows.push(Object.fromEntries(headerColumns.map(([column, header]) => [header.trim(), cells.get(column) ?? ''])));
    rowNumbers.push(rowNumber + 1);
  }
  return { headers, rows, rowNumbers, hasUnheadedDataColumn, columnCount: headerWidth };
}

function csvText(bytes: Uint8Array): string {
  const bom = bytes.length >= BOM_BYTES ? bytes[0]! | bytes[1]! << 8 : 0;
  if (bom === UTF16_LE_BOM || bom === UTF16_BE_BOM) return new TextDecoder(bom === UTF16_LE_BOM ? 'utf-16le' : 'utf-16be', { fatal: true }).decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { /* Legacy Excel CSV may use GBK/GB18030; strict fallback never inserts replacement characters. */ return new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
}
/** Each worksheet validates independently; irrelevant sheets never block choosing a valid sheet. */
export function parseWorkbookImport(bytes: Uint8Array, fileName: string): Result<ImportPreview> {
  try {
    const csv = /\.csv$/i.test(fileName);
    const workbook = XLSX.read(csv ? csvText(bytes) : bytes, { type: csv ? 'string' : 'buffer', sheetRows: WORKBOOK_LIMITS.entityRows + PREVIEW_EXTRA_ROWS, raw: csv });
    if (!workbook.SheetNames.length) return failure('INVALID_INPUT', '文件没有可读取的工作表');
    if (workbook.SheetNames.length > WORKBOOK_LIMITS.sheets) return failure('PAYLOAD_TOO_LARGE', '工作表超过20张限制');
    const sheets: ImportSheetPreview[] = workbook.SheetNames.map(sheetName => {
      const result: ImportSheetPreview = { sheetName, headers: [], rows: [], rowNumbers: [] };
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) return { ...result, error: '工作表无法读取' };
      const parsed = sparseSheetRows(sheet);
      if (!parsed) return { ...result, error: '工作表没有数据' };
      if (parsed.columnCount > WORKBOOK_LIMITS.columns) return { ...result, error: '工作表超过100列限制' };
      result.headers = parsed.headers;
      if (new Set(result.headers.map(header => header.toLowerCase())).size !== result.headers.length) {
        result.error = '表头存在重复列名，请修正工作表'; return result;
      }
      if (parsed.hasUnheadedDataColumn) {
        result.error = '部分数据列没有表头'; return result;
      }
      result.rows = parsed.rows; result.rowNumbers = parsed.rowNumbers;
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
  try {
    const tsv = /\.tsv$/i.test(fileName);
    const csv = /\.(csv|tsv)$/i.test(fileName);
    const workbook = XLSX.read(csv ? csvText(bytes) : bytes, { type: csv ? 'string' : 'buffer', sheetRows: ONLINE_LIMITS.fileRows + PREVIEW_EXTRA_ROWS, raw: csv, ...(tsv ? { FS: '\t' } : {}) });
    const sheet = workbook.Sheets[workbook.SheetNames[0] ?? ''];
    if (!sheet) return failure('INVALID_INPUT', '文件没有可读取的工作表');
    const parsed = sparseSheetRows(sheet);
    if (!parsed) return failure('INVALID_INPUT', '文件没有数据');
    const { headers, rows, rowNumbers } = parsed;
    if (new Set(headers.map(header => header.toLowerCase())).size !== headers.length) return failure('INVALID_INPUT', '表头存在重复列名，请修正后重选文件');
    if (parsed.hasUnheadedDataColumn) return failure('INVALID_INPUT', '部分数据列没有表头');
    if (!rows.length) return failure('INVALID_INPUT', '文件只有表头，没有客户记录');
    if (rows.length > ONLINE_LIMITS.fileRows || sheet['!fullref'] && sheet['!fullref'] !== sheet['!ref']) return failure('PAYLOAD_TOO_LARGE', '文件行数过多，请拆分文件');
    return success({ headers, rows, rowNumbers, fileName });
  } catch { /* Invalid encoding or workbook data is a visible validation error, not a silent partial import. */ return failure('INVALID_INPUT', '文件编码或表格格式无效，请使用 UTF-8 CSV 或 XLSX'); }
}
