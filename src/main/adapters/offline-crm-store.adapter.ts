import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { accountProfileRoot } from './desktop-local-scope.adapter';
import { emptyOfflineCrmState, type OfflineCrmContext, type OfflineCrmState, type OfflineCrmStore } from '../core/offline-crm';

const STATE_KEY = 'crm';
const BUSY_TIMEOUT_MS = 5000;
/** A separate account-bound CRM database never adopts an anonymous legacy contacts store. */
export class SqliteOfflineCrmStore implements OfflineCrmStore {
  constructor(private readonly open:(context:OfflineCrmContext)=>Database) {}
  load(ctx:OfflineCrmContext):OfflineCrmState {
    const db=this.open(ctx);
    db.exec('CREATE TABLE IF NOT EXISTS crm_offline_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row=db.prepare('SELECT value FROM crm_offline_state WHERE key=?').get(STATE_KEY) as {value:string}|undefined;
    if(!row)return emptyOfflineCrmState(ctx.permissionKey);
    const state=JSON.parse(row.value) as OfflineCrmState;
    if(!state||!Array.isArray(state.outbox)||!state.customers||!state.views||!state.receipts)throw new Error('本地客户库格式异常，请保留文件后检查');
    return state;
  }
  save(ctx:OfflineCrmContext,state:OfflineCrmState):void {
    const db=this.open(ctx);
    db.transaction(()=>{
      db.prepare('INSERT INTO crm_offline_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(STATE_KEY,JSON.stringify(state));
    })();
  }
}
export function createOfflineCrmStore(parent:string) {
  const databases=new Map<string,Database>();
  const store=new SqliteOfflineCrmStore(ctx=>{
    const root=accountProfileRoot(parent,ctx);const file=join(root,'crm-offline.db');
    let db=databases.get(file);
    if(!db){
      mkdirSync(root,{recursive:true});
      // Native Electron ABI is loaded only when a verified account first uses CRM.
      const Constructor=require('better-sqlite3') as typeof import('better-sqlite3');
      db=new Constructor(file);db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.pragma(`busy_timeout=${BUSY_TIMEOUT_MS}`);
      databases.set(file,db);
    }
    return db;
  });
  return {store,close:()=>{for(const db of databases.values())db.close();databases.clear();}};
}
