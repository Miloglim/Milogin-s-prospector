import { getRawDb } from '../db';
import type { InboxQuoteCard, InboxQuoteCandidate, InboxQuoteCardState } from '../../shared/inbox';

export const INQUIRY_QUOTE_DDL = `
CREATE TABLE IF NOT EXISTS inbox_quote_cards (
  message_id INTEGER PRIMARY KEY REFERENCES inbox_messages(id) ON DELETE CASCADE,
  message_key TEXT NOT NULL,
  case_id TEXT NOT NULL,
  quote_case_id TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  state TEXT NOT NULL,
  fields_json TEXT NOT NULL DEFAULT '{}',
  missing_fields_json TEXT NOT NULL DEFAULT '[]',
  selected_candidate_json TEXT,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inbox_quote_case ON inbox_quote_cards(quote_case_id);
`;

function candidate(value: unknown): InboxQuoteCandidate | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return {
    id: String(row.id || ''), carrier: typeof row.carrier === 'string' ? row.carrier : null,
    pol: typeof row.pol === 'string' ? row.pol : null, pod: typeof row.pod === 'string' ? row.pod : null,
    containerType: typeof row.containerType === 'string' ? row.containerType : null,
    price: typeof row.price === 'number' ? row.price : null, currency: typeof row.currency === 'string' ? row.currency : null,
    etd: typeof row.etd === 'string' ? row.etd : null, validFrom: typeof row.validFrom === 'string' ? row.validFrom : null,
    validTo: typeof row.validTo === 'string' ? row.validTo : null, sourceUpdatedAt: typeof row.sourceUpdatedAt === 'string' ? row.sourceUpdatedAt : null,
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
  };
}

function parse<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { /* corrupt cache is ignored and rebuilt from center */ return fallback; }
}

export function saveInboxQuoteCard(card: InboxQuoteCard): void {
  getRawDb().prepare(`INSERT INTO inbox_quote_cards(message_id,message_key,case_id,quote_case_id,quote_id,state,fields_json,missing_fields_json,selected_candidate_json,candidates_json,summary,error,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(message_id) DO UPDATE SET message_key=excluded.message_key,case_id=excluded.case_id,quote_case_id=excluded.quote_case_id,
      quote_id=excluded.quote_id,state=excluded.state,fields_json=excluded.fields_json,missing_fields_json=excluded.missing_fields_json,
      selected_candidate_json=excluded.selected_candidate_json,candidates_json=excluded.candidates_json,summary=excluded.summary,
      error=excluded.error,updated_at=CURRENT_TIMESTAMP`).run(
    card.messageId, card.messageKey, card.caseId, card.quoteCaseId, card.quoteId, card.state,
    JSON.stringify(card.fields), JSON.stringify(card.missingFields), card.selectedCandidate ? JSON.stringify(card.selectedCandidate) : null,
    JSON.stringify(card.candidates), card.summary, card.error,
  );
}

export function listInboxQuoteCards(messageIds:number[]):Map<number,InboxQuoteCard>{
  const result=new Map<number,InboxQuoteCard>();
  if(!messageIds.length)return result;
  try{
    for(let start=0;start<messageIds.length;start+=400){
      const chunk=messageIds.slice(start,start+400);
      const rows=getRawDb().prepare(`SELECT * FROM inbox_quote_cards WHERE message_id IN (${chunk.map(()=>'?').join(',')})`).all(...chunk) as Array<Record<string,unknown>>;
      for(const row of rows)result.set(Number(row.message_id),{
        messageId:Number(row.message_id),messageKey:String(row.message_key),caseId:String(row.case_id),
        quoteCaseId:String(row.quote_case_id),quoteId:String(row.quote_id),state:String(row.state) as InboxQuoteCardState,
        fields:parse(String(row.fields_json),{}),missingFields:parse(String(row.missing_fields_json),[]),
        selectedCandidate:candidate(parse(String(row.selected_candidate_json || 'null'),null)),
        candidates:parse<unknown[]>(String(row.candidates_json),[]).map(candidate).filter((item):item is InboxQuoteCandidate=>!!item),
        summary:String(row.summary || ''),error:row.error?String(row.error):null,updatedAt:String(row.updated_at),
      });
    }
  }catch{/* older databases may not have the cache table until migration runs */}
  return result;
}

export function inboxQuoteCard(messageId:number):InboxQuoteCard|null{return listInboxQuoteCards([messageId]).get(messageId)??null;}
