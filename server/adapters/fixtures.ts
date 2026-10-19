import { readFileSync,writeFileSync,existsSync } from "node:fs";
import { randomBytes,randomUUID } from "node:crypto";
import {type CrmRole} from "../core/auth";
import type { PostgresAuthRepository } from "./postgres/auth-repository";
import type { PasswordAdapter } from "./password";

export const FIXTURE_PATH = ".work/pg-crm/online-fixtures.json";
const PRIVATE_FILE_MODE = 0o600;
const PASSWORD_BYTES = 24;
const JSON_INDENT = 2;
const FIXTURE_MARKER = "prospector-online-fixtures-v1";
const FIXTURES: { email: string; displayName: string; identityAdmin: boolean; crmRoles: CrmRole[] }[] = [
  {email:"agent-admin@example.invalid",displayName:"Agent 测试管理员",identityAdmin:false,crmRoles:["operations"]},
  {email:"agent-user@example.invalid",displayName:"Agent 测试用户",identityAdmin:false,crmRoles:["sales"]},
];
interface LocalFixture { email: string; userId: string; password: string; }
export async function initializeFixtures(repo: PostgresAuthRepository, passwords: PasswordAdapter, testMode: boolean) {
  if(!testMode) return;
  if(!existsSync(FIXTURE_PATH)) {
    const accounts = FIXTURES.map(item => ({email:item.email,userId:randomUUID(),password:randomBytes(PASSWORD_BYTES).toString("base64url")}));
    // Write first, then commit users. An interrupted run reuses exactly the same IDs/passwords.
    writeFileSync(FIXTURE_PATH,JSON.stringify({marker:FIXTURE_MARKER,accounts},null,JSON_INDENT),{mode:PRIVATE_FILE_MODE,flag:"wx"});
  }
  const file = JSON.parse(readFileSync(FIXTURE_PATH,"utf8")) as {marker: string; accounts: LocalFixture[]};
  if(file.marker!==FIXTURE_MARKER || !Array.isArray(file.accounts) || file.accounts.length!==FIXTURES.length) throw new Error("测试账户文件不匹配，保留现状");
  for(const definition of FIXTURES) {
    const accounts=file.accounts.filter(item => item.email===definition.email), account=accounts[0];
    if(accounts.length!==1 || !account || typeof account.userId!=="string" || !/^[a-f0-9-]{36}$/.test(account.userId)
      || typeof account.password!=="string" || !/^[A-Za-z0-9_-]{32}$/.test(account.password)) throw new Error("测试账户配置无效");
    const result=await repo.ensureFixture({...definition,userId:account.userId,passwordHash:await passwords.hash(account.password)});
    if(!result.ok) throw new Error("测试账户初始化被拒绝，保留现有身份");
  }
}
