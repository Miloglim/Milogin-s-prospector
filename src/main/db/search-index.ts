import type { Database } from "better-sqlite3";
export const SEARCH_ROW_STRIDE = 3;
const SEARCH_NOTE_OFFSET = 2;

/** 中文保留在原文字段供 LIKE 搜索，但不送入 FTS 词表。 */
export function searchLatin(text: unknown): string {
  return String(text ?? "").replace(/[^\p{Script=Latin}\p{N}\s]/gu, " ");
}

const contactTitle = (ref: string) => `trim(COALESCE(${ref}.first_name,'') || ' ' || COALESCE(${ref}.last_name,'') || ' ' || ${ref}.email)`;
const contactBody = (ref: string) => `COALESCE(${ref}.title,'') || ' ' || COALESCE(${ref}.phone,'') || ' ' || COALESCE((SELECT name FROM companies WHERE id=${ref}.company_id),'')`;
const contactInsert = (ref: string) => `INSERT INTO search_idx(rowid,kind,sourceId,contactId,title,body,content) SELECT ${ref}.id*${SEARCH_ROW_STRIDE},'contact',${ref}.id,${ref}.id,${contactTitle(ref)},${contactBody(ref)},search_latin(${contactTitle(ref)} || ' ' || ${contactBody(ref)});`;
const noteInsert = (ref: string) => `INSERT INTO search_idx(rowid,kind,sourceId,contactId,title,body,content) SELECT ${ref}.id*${SEARCH_ROW_STRIDE}+${SEARCH_NOTE_OFFSET},'note',${ref}.id,${ref}.contact_id,COALESCE(${ref}.subject,'跟进记录'),COALESCE(${ref}.body_preview,''),search_latin(COALESCE(${ref}.subject,'') || ' ' || COALESCE(${ref}.body_preview,'')) WHERE ${ref}.type='note';`;
const mailInsert = (ref: string) => `INSERT INTO search_idx(rowid,kind,sourceId,contactId,title,body,content) SELECT ${ref}.id*${SEARCH_ROW_STRIDE}+1,'email',${ref}.id,${ref}.matched_contact_id,COALESCE(${ref}.subject,'无主题'),COALESCE(${ref}.body_preview,''),search_latin(COALESCE(${ref}.subject,'') || ' ' || ${ref}.from_email || ' ' || COALESCE(${ref}.body_preview,''));`;

/** 命名迁移调用：已有业务表不加列。触发器覆盖 UI、Agent、导入与级联删除所有写入口。 */
export function installSearchIndex(raw: Database): void {
  raw.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_idx USING fts5(
    kind UNINDEXED, sourceId UNINDEXED, contactId UNINDEXED, title UNINDEXED, body UNINDEXED, content,
    tokenize='unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS search_contacts_insert AFTER INSERT ON contacts BEGIN ${contactInsert("NEW")} END;
  CREATE TRIGGER IF NOT EXISTS search_contacts_update AFTER UPDATE OF first_name,last_name,email,title,phone,company_id ON contacts BEGIN
    DELETE FROM search_idx WHERE rowid=OLD.id*${SEARCH_ROW_STRIDE}; ${contactInsert("NEW")} END;
  CREATE TRIGGER IF NOT EXISTS search_contacts_delete AFTER DELETE ON contacts BEGIN DELETE FROM search_idx WHERE rowid=OLD.id*${SEARCH_ROW_STRIDE}; END;
  CREATE TRIGGER IF NOT EXISTS search_notes_insert AFTER INSERT ON interactions BEGIN ${noteInsert("NEW")} END;
  CREATE TRIGGER IF NOT EXISTS search_notes_update AFTER UPDATE OF type,contact_id,subject,body_preview ON interactions BEGIN
    DELETE FROM search_idx WHERE rowid=OLD.id*${SEARCH_ROW_STRIDE}+${SEARCH_NOTE_OFFSET}; ${noteInsert("NEW")} END;
  CREATE TRIGGER IF NOT EXISTS search_notes_delete AFTER DELETE ON interactions BEGIN DELETE FROM search_idx WHERE rowid=OLD.id*${SEARCH_ROW_STRIDE}+${SEARCH_NOTE_OFFSET}; END;
  CREATE TRIGGER IF NOT EXISTS search_mail_insert AFTER INSERT ON inbox_messages BEGIN ${mailInsert("NEW")} END;
  CREATE TRIGGER IF NOT EXISTS search_mail_update AFTER UPDATE OF subject,from_email,body_preview,matched_contact_id ON inbox_messages BEGIN
    UPDATE search_idx SET contactId=NEW.matched_contact_id,title=COALESCE(NEW.subject,'无主题'),
      body=CASE WHEN NEW.body_preview IS OLD.body_preview THEN body ELSE COALESCE(NEW.body_preview,'') END,
      content=search_latin(COALESCE(NEW.subject,'') || ' ' || NEW.from_email || ' ' || CASE WHEN NEW.body_preview IS OLD.body_preview THEN body ELSE COALESCE(NEW.body_preview,'') END)
      WHERE rowid=OLD.id*${SEARCH_ROW_STRIDE}+1;
  END;
  CREATE TRIGGER IF NOT EXISTS search_mail_delete AFTER DELETE ON inbox_messages BEGIN DELETE FROM search_idx WHERE rowid=OLD.id*${SEARCH_ROW_STRIDE}+1; END;
  CREATE TRIGGER IF NOT EXISTS search_company_update AFTER UPDATE OF name ON companies BEGIN
    UPDATE contacts SET company_id=company_id WHERE company_id=NEW.id;
  END;
  INSERT INTO search_idx(rowid,kind,sourceId,contactId,title,body,content)
    SELECT c.id*${SEARCH_ROW_STRIDE},'contact',c.id,c.id,${contactTitle("c")},${contactBody("c")},search_latin(${contactTitle("c")} || ' ' || ${contactBody("c")}) FROM contacts c;
  INSERT INTO search_idx(rowid,kind,sourceId,contactId,title,body,content)
    SELECT id*${SEARCH_ROW_STRIDE}+${SEARCH_NOTE_OFFSET},'note',id,contact_id,COALESCE(subject,'跟进记录'),COALESCE(body_preview,''),search_latin(COALESCE(subject,'') || ' ' || COALESCE(body_preview,'')) FROM interactions WHERE type='note';
  INSERT INTO search_idx(rowid,kind,sourceId,contactId,title,body,content)
    SELECT id*${SEARCH_ROW_STRIDE}+1,'email',id,matched_contact_id,COALESCE(subject,'无主题'),COALESCE(body_preview,''),search_latin(COALESCE(subject,'') || ' ' || from_email || ' ' || COALESCE(body_preview,'')) FROM inbox_messages;
  `);
}
