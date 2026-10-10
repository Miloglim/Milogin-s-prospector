export type SearchKind = "email" | "note" | "contact";
export interface SearchRequest { query: string; limit?: number }
export interface SearchHit {
  kind: SearchKind; sourceId: number; contactId: number | null; title: string; snippet: string;
}
export interface GlobalSearchData {
  email: SearchHit[]; note: SearchHit[]; contact: SearchHit[];
  /** 返回达到上限时提示用户细化关键词。 */
  truncated: boolean;
}
