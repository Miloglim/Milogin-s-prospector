/** One vocabulary for center lead import, mapping controls and the visible field guide. */
export const LEAD_IMPORT_FIELDS = [
  {key:'companyName',label:'公司名',group:'company',aliases:['公司名','公司','公司名称','公司全称','客户名称','company','companyName']},
  {key:'country',label:'国家',group:'company',aliases:['国家','所在国家','country']},
  {key:'customerType',label:'客户类型',group:'company',aliases:['客户类型','客户类别','联系人类型','类型','type','customerType','client_type','clienttype'],hint:'代理 / 直客'},
  {key:'businessType',label:'业务类型',group:'company',aliases:['业务类型','品类','行业','分类','businessType','category','industry']},
  {key:'website',label:'网站',group:'company',aliases:['网站','网址','官网','website','url','domain']},
  {key:'name',label:'联系人姓名',group:'contact',aliases:['联系人姓名','姓名','联系人','contact','name']},
  {key:'firstName',label:'名',group:'contact',aliases:['名','firstname','first_name']},
  {key:'lastName',label:'姓',group:'contact',aliases:['姓','lastname','last_name']},
  {key:'title',label:'职位 / Title',group:'contact',aliases:['职位','职务','联系人title','title','position']},
  {key:'phone',label:'电话',group:'contact',aliases:['电话','手机','联系电话','phone','tel','mobile']},
  {key:'whatsapp',label:'WhatsApp',group:'contact',aliases:['WhatsApp','Whats App','WA']},
  {key:'email',label:'邮箱',group:'contact',aliases:['邮箱','邮箱地址','电子邮箱','电子邮件','邮件','email','e-mail']},
  {key:'linkedinUrl',label:'LinkedIn',group:'contact',aliases:['LinkedIn','领英','linkedinUrl']},
  {key:'sourceLevel1',label:'一级来源',group:'contact',aliases:['来源','线索来源','一级来源','来源一级','source','sourceLevel1','primarySource']},
  {key:'sourceLevel2',label:'二级来源',group:'contact',aliases:['二级来源','来源二级','sourceLevel2','secondarySource']},
  {key:'stage',label:'发送阶段',group:'contact',aliases:['阶段','发送阶段','stage']},
  {key:'language',label:'语言',group:'contact',aliases:['语言','language']},
] as const;
export const normalizeImportHeader=(value:string):string=>value.trim().toLowerCase().replace(/[\s_-]/g,'');
export function leadImportMapping(headers:string[]):Record<string,string> {
  return Object.fromEntries(LEAD_IMPORT_FIELDS.flatMap(field=>{
    const matches=headers.filter(header=>field.aliases.some(alias=>normalizeImportHeader(alias)===normalizeImportHeader(header)));
    return matches.length===1?[[field.key,matches[0]!]]:[];
  }));
}

export const IMPORT_REMARK_MAX = 20000;
const EMPTY_IMPORT_VALUES = new Set(['', 'n/a', 'na', '(n/a)', 'null', 'none', 'nil', '-', '--', '—', '暂无', '无', '未提供']);
const DIRECT_REMARK_HEADERS = new Set(['备注', 'remark', 'note', 'notes', '说明']);
function remarkValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  try { return JSON.stringify(value).trim(); }
  catch { /* Import rows are JSON data; malformed non-JSON values are omitted instead of breaking the batch. */ return ''; }
}
/** Convert every non-empty column that the user did not map into one labelled line per field. */
export function unmatchedImportRemark(rawRow: Record<string, unknown> | undefined, mappedHeaders: Iterable<string>): string {
  if (!rawRow) return '';
  const mapped = new Set(Array.from(mappedHeaders, normalizeImportHeader).filter(Boolean));
  const lines: string[] = [];
  for (const [rawHeader, rawValue] of Object.entries(rawRow)) {
    const header = rawHeader.trim();
    const normalizedHeader = normalizeImportHeader(header);
    if (!header || mapped.has(normalizedHeader)) continue;
    const value = remarkValue(rawValue);
    if (EMPTY_IMPORT_VALUES.has(value.toLowerCase())) continue;
    lines.push(DIRECT_REMARK_HEADERS.has(normalizedHeader) ? value : `${header}：${value}`);
  }
  return lines.join('\n');
}
