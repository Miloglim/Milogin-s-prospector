import { eq } from 'drizzle-orm';
import { getDb } from '../db';
import { agentToolCalls, agentWorkingMemory, agentMessages, agentFacts } from '../db/schema/agent';
import { NavigatorContextPolicy, sensitiveContext, type ContextRow } from '../services/navigator-context.service';
import { navigatorHasAuthorization, onNavigatorIdentityChanged } from './navigator-auth.adapter';
const policy = new NavigatorContextPolicy(Date.now());
const listeners = new Set<() => void>();
onNavigatorIdentityChanged(() => {
  policy.reset(navigatorHasAuthorization(),Date.now());
  for (const listener of listeners) listener();
});
export function onNavigatorContextReset(listener:()=>void):()=>void {listeners.add(listener);return () => {listeners.delete(listener);};}
export const navigatorContextEpoch = () => policy.epoch;
export const navigatorContextCurrent = (epoch:number) => policy.current(epoch);
export function navigatorConversationSensitive(conversationId:string): boolean {
  try {
    const db = getDb();
    return db.select().from(agentToolCalls).where(eq(agentToolCalls.conversationId,conversationId)).all().some(sensitiveContext)
      || db.select().from(agentWorkingMemory).where(eq(agentWorkingMemory.conversationId,conversationId)).all().some(sensitiveContext)
      || db.select().from(agentMessages).where(eq(agentMessages.conversationId,conversationId)).all().some(sensitiveContext)
      || db.select().from(agentFacts).where(eq(agentFacts.conversationId,conversationId)).all().some(sensitiveContext);
  } catch {return true;} // Unknown legacy storage/provenance fails closed, without logging contents.
}
export function navigatorVisibleContext<T extends ContextRow>(conversationId:string, rows:T[]):T[] {
  const sensitive = navigatorConversationSensitive(conversationId);
  return rows.filter(row => policy.visible(row,sensitive));
}
export function navigatorContextRowVisible(conversationId:string,row:ContextRow):boolean {
  return policy.visible(row,navigatorConversationSensitive(conversationId));
}
