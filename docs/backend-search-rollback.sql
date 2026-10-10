-- 应用停止、数据库已备份后执行。仅移除可重建的搜索设施，不删除业务数据。
BEGIN IMMEDIATE;
DROP TRIGGER IF EXISTS search_contacts_insert;
DROP TRIGGER IF EXISTS search_contacts_update;
DROP TRIGGER IF EXISTS search_contacts_delete;
DROP TRIGGER IF EXISTS search_notes_insert;
DROP TRIGGER IF EXISTS search_notes_update;
DROP TRIGGER IF EXISTS search_notes_delete;
DROP TRIGGER IF EXISTS search_mail_insert;
DROP TRIGGER IF EXISTS search_mail_update;
DROP TRIGGER IF EXISTS search_mail_delete;
DROP TRIGGER IF EXISTS search_company_update;
DROP TABLE IF EXISTS search_idx;
DELETE FROM _migrations WHERE name='v0.9-search-fts5';
COMMIT;
