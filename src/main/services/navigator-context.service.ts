/** Privacy policy has no DB/Electron dependency. Persisted quote context never survives a grant epoch. */
export interface ContextRow { createdAt?:string; updatedAt?:string; content?:string; toolName?:string; kind?:string; fact?:string; contextLine?:string; payloadJson?:string; argsJson?:string|null; resultJson?:string|null; error?:string|null }
const RATE_TOOLS = new Set(['quote_search','rate_update_plan','rate_update_group_body','rate_update_enqueue','space_search']);
const RATE_CONTENT = /(?:运价|报价|舱位|海运费|freight\s*rate|ocean\s*freight|\b(?:USD|US\$|EUR|CNY)\s*\d|[$€¥]\s*\d|\d\s*(?:USD|\/\s*(?:20GP|40HQ|40HC|40GP))|"(?:price(?:_20|_40|_40hq)?|rates|rateDtos|rateQuotes|dtos)"\s*:)/i;
export function sensitiveContext(row:ContextRow): boolean {
  return row.kind === 'rates' || RATE_TOOLS.has(row.toolName ?? '') ||
    RATE_CONTENT.test([row.content,row.fact,row.contextLine,row.payloadJson,row.argsJson,row.resultJson,row.error].filter(Boolean).join('\n'));
}
export function contextTime(row: ContextRow): number {
  const raw = row.updatedAt ?? row.createdAt;
  if (!raw) return 0;
  const value = Date.parse(raw.includes('T') ? raw : `${raw.replace(' ','T')}Z`);
  return Number.isFinite(value) ? value : 0;
}
export class NavigatorContextPolicy {
  epoch = 0;
  private authenticated = false;
  constructor(private floor:number) {}
  reset(authenticated:boolean, now:number): void {this.authenticated=authenticated;this.floor=now;this.epoch++;}
  current(epoch:number):boolean {return epoch === this.epoch;}
  visible(row:ContextRow,conversationSensitive:boolean): boolean {
    if (!conversationSensitive && !sensitiveContext(row)) return true;
    return this.authenticated && contextTime(row) > this.floor;
  }
}
