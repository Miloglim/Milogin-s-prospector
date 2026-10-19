import { describe,it,expect,vi } from 'vitest';
import initSqlJs from 'sql.js';
import { drizzle } from 'drizzle-orm/sql-js';
import * as schema from '../../src/main/db/schema';
import * as path from 'node:path';
const state = vi.hoisted(() => ({db:null as any,authorized:false,reset:null as null|(()=>void)}));
vi.mock('../../src/main/db',() => ({getDb:()=>state.db,saveDatabase:()=>{}}));
vi.mock('../../src/main/adapters/navigator-auth.adapter',() => ({navigatorHasAuthorization:()=>state.authorized,onNavigatorIdentityChanged:(fn:()=>void)=>{state.reset=fn;return ()=>{};}}));
vi.mock('../../src/main/services/ai.service',() => ({chat:async()=>({success:true,data:'summary'})}));
const privacy = await import('../../src/main/adapters/navigator-context.adapter');
const memory = await import('../../src/main/services/agent/memory');
const wm = await import('../../src/main/services/agent/working-memory');
const SQL = await initSqlJs({locateFile:f=>path.resolve('node_modules/sql.js/dist',f)});
function sandbox() {
  const raw = new SQL.Database();
  raw.run(`
    CREATE TABLE agent_messages(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT,role TEXT,content TEXT,created_at TEXT);
    CREATE TABLE agent_facts(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT,tool_name TEXT,fact TEXT,created_at TEXT);
    CREATE TABLE agent_tool_calls(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT,tool_name TEXT,side_effect TEXT,args_json TEXT,result_json TEXT,approval TEXT,error TEXT,created_at TEXT);
    CREATE TABLE agent_working_memory(id INTEGER PRIMARY KEY AUTOINCREMENT,conversation_id TEXT,kind TEXT,ref_id TEXT,tool_name TEXT,context_line TEXT,payload_json TEXT,created_at TEXT,updated_at TEXT);
  `);
  state.db=drizzle(raw,{schema});
  state.authorized=false;state.reset!();
  return state.db;
}
describe('Navigator context adapter on isolated history',()=>{
  it('preserves ordinary old conversation and facts without Navigator login',async()=>{
    const db=sandbox();
    const old='2020-01-01T00:00:00Z';
    db.insert(schema.agentMessages).values({conversationId:'ordinary',role:'assistant',content:'Contact Alice tomorrow',createdAt:old}).run();
    db.insert(schema.agentFacts).values({conversationId:'ordinary',toolName:'search_contacts',fact:'Found Alice',createdAt:old}).run();
    const history=await memory.loadConversation('ordinary');
    expect(JSON.stringify(history)).toContain('Contact Alice tomorrow');
    expect(JSON.stringify(history)).toContain('Found Alice');
  });
  it('masks old rate messages, facts and draft workspace without deleting history',async()=>{
    const db=sandbox();const old='2020-01-01T00:00:00Z';
    db.insert(schema.agentMessages).values({conversationId:'rates',role:'assistant',content:'Quoted USD 2500',createdAt:old}).run();
    db.insert(schema.agentFacts).values({conversationId:'rates',toolName:'quote_search',fact:'Lowest 2500',createdAt:old}).run();
    db.insert(schema.agentWorkingMemory).values({conversationId:'rates',kind:'draft',refId:'d',toolName:'generate_draft',contextLine:'Draft USD 2500',payloadJson:'{"rates":[2500]}',createdAt:old,updatedAt:old}).run();
    expect(await memory.loadConversation('rates')).toEqual([]);
    expect(wm.getWork('rates','draft')).toBeNull();
    expect(db.select().from(schema.agentMessages).all()).toHaveLength(1);
    state.authorized=true;state.reset!();
    expect(await memory.loadConversation('rates')).toEqual([]);
  });
  it('permits newly authorized data and then hides it on logout',async()=>{
    const db=sandbox();
    state.authorized=true;state.reset!();
    const current=new Date(Date.now()+1000).toISOString();
    db.insert(schema.agentMessages).values({conversationId:'new',role:'assistant',content:'USD 3300',createdAt:current}).run();
    expect(await memory.loadConversation('new')).toHaveLength(1);
    const epoch=privacy.navigatorContextEpoch();
    state.authorized=false;state.reset!();
    expect(privacy.navigatorContextCurrent(epoch)).toBe(false);
    expect(await memory.loadConversation('new')).toEqual([]);
  });
});
