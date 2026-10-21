import { describe,it,expect } from "vitest";
import { randomBytes } from "node:crypto";
import { LoginRateGate } from "../../server/adapters/login-rate";
import { PasswordAdapter } from "../../server/adapters/password";
import { createAuthService } from "../../server/services/auth";
import { ONLINE_DEFAULTS } from "../../server/core/auth";
import type { AuthRepository } from "../../server/core/auth";
import { failure,success } from "../../server/core/crm";
import { initializeFixtures } from "../../server/adapters/fixtures";
import type { PostgresAuthRepository } from "../../server/adapters/postgres/auth-repository";

const MILLISECONDS_PER_SECOND = 1000;
const TEST_TIMEOUT_MS=30000;
describe("online boundary guards",()=> {
  it("does not initialize any fixture identities outside explicit test mode",async()=> {
    let writes=0;
    const repo={ensureFixture:async()=>{writes++;return success(undefined);}} as unknown as PostgresAuthRepository;
    await initializeFixtures(repo,{} as PasswordAdapter,false);
    expect(writes).toBe(0);
  });
  it("bounds rotated-email attempts by address and expires both buckets",()=> {
    let now=0;const clock={now:()=>now};
    const gate=new LoginRateGate({...ONLINE_DEFAULTS,login_ip_max_attempts:2},clock);
    expect(gate.allow("a","127.0.0.1")).toBe(true);
    expect(gate.allow("b","127.0.0.1")).toBe(true);
    expect(gate.allow("c","127.0.0.1")).toBe(false);
    now=ONLINE_DEFAULTS.login_window_seconds*MILLISECONDS_PER_SECOND;
    expect(gate.allow("c","127.0.0.1")).toBe(true);
  });
  it("caps bucket memory and fails closed when new keys fill it",()=> {
    const gate=new LoginRateGate({...ONLINE_DEFAULTS,rate_bucket_max:1},{now:()=>0});
    expect(gate.allow("a")).toBe(true);expect(gate.allow("b")).toBe(false);
  });
  it("salts password hashes, refuses unsafe encoded costs, and bounds concurrent work",async()=> {
    const adapter=new PasswordAdapter(1);await adapter.initialize();
    const password=randomBytes(24).toString("base64url");
    const first=await adapter.hash(password),second=await adapter.hash(password);
    expect(first).not.toBe(second);
    expect(await adapter.verify(password,first)).toBe(true);
    expect(await adapter.verify("wrong-password-value",first)).toBe(false);
    expect(await adapter.verify(password,first.replace("131072","1073741824"))).toBe(false);
    const active=adapter.verify(password,first);
    await expect(adapter.verify(password,first)).rejects.toThrow("并发");
    expect(await active).toBe(true);
  },TEST_TIMEOUT_MS);
  it("rejects malformed credentials before accessing identity storage",async()=> {
    let lookups=0;
    const repo={credential:async()=>{lookups++;return success(null);}} as unknown as AuthRepository;
    const service=createAuthService(repo,{verify:async()=>false},{create:()=>"",hash:()=>""},{now:()=>0},ONLINE_DEFAULTS.session_ttl_seconds);
    for(const input of [null,[],{}, {email:3,password:"valid-password"},{email:"x@y.invalid",password:"short"},{email:"x@y.invalid",password:"valid-password",role:"admin"}]) expect((await service.login(input)).ok).toBe(false);
    expect(lookups).toBe(0);
  });
  it("fails closed when DB lookup or password capacity is unavailable",async()=> {
    const input={email:"x@y.invalid",password:"valid-password"};
    const tokens={create:()=>"",hash:()=>""},clock={now:()=>0};
    const broken={credential:async()=>failure("DATABASE_ERROR","unavailable")} as unknown as AuthRepository;
    const result=await createAuthService(broken,{verify:async()=>true},tokens,clock,1).login(input);
    expect(result).toEqual(failure("DATABASE_ERROR","unavailable"));
    const missing={credential:async()=>success(null)} as unknown as AuthRepository;
    const overloaded=await createAuthService(missing,{verify:async()=>{throw new Error("secret must not be returned");}},tokens,clock,1).login(input);
    expect(overloaded.ok).toBe(false);expect(JSON.stringify(overloaded)).not.toContain("secret");
  });
  it("returns only the current session's shared profile summary",async()=>{
    const token="a".repeat(43),hashed="stored-hash";
    const identity={userId:"user-a",displayName:"Zayne",email:"admin@yqn.com",emailVerified:false,identityAdmin:true,crmRoles:["admin" as const]};
    const profile={userId:"user-a",displayName:"Zayne",avatarId:"av-04",bio:"",growth:{totalXp:6612,cycle:7,level:28,levelProgress:16,levelCost:21,todayXp:18,todayKey:"2026-10-21"}};
    const repo={identity:async()=>success(identity),accountProfile:async(hash:string)=>success(hash===hashed?profile:null)} as unknown as AuthRepository;
    const service=createAuthService(repo,{verify:async()=>true},{create:()=>token,hash:()=>hashed},{now:()=>0},1);
    expect(await service.accountProfile(token)).toEqual(success(profile));
    expect(await service.accountProfile(token.slice(1))).toMatchObject({ok:false,error:{code:"UNAUTHORIZED"}});
  });
});
