import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Pool } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readTestDatabaseConfig } from "../../server/adapters/postgres/config";
import { PostgresCrmRepository } from "../../server/adapters/postgres/repository";
import { PostgresAuthRepository } from "../../server/adapters/postgres/auth-repository";
import { PasswordAdapter, tokenAdapter } from "../../server/adapters/password";
import { createAuthService } from "../../server/services/auth";
import { createOnlineServer } from "../../server/transport/http";
import { LoginRateGate } from "../../server/adapters/login-rate";
import { API_ROUTES, ONLINE_DEFAULTS, type CrmRole } from "../../server/core/auth";

const TIMEOUT_MS = 30000;
const TTL_SECONDS = 3600;
const INVALID_LOGIN_LIMIT = 3;
const logs: string[] = [];
const logger = { write: (_level: string, _context: string, message: string) => logs.push(message) };
const prefix = `auth-${Date.now()}`;
const password = randomBytes(24).toString("base64url");
const clock = { now: () => Date.now() };
let pool: Pool;
let repo: PostgresAuthRepository;
let passwords: PasswordAdapter;
let server: ReturnType<typeof createOnlineServer>;
let base: string;
const users: Record<string, { userId: string; email: string }> = {};
const tokens: Record<string, string> = {};
function service() {
  return createAuthService(repo, passwords, tokenAdapter, clock, TTL_SECONDS);
}
async function start() {
  server = createOnlineServer(service(), new LoginRateGate({ ...ONLINE_DEFAULTS, login_max_attempts: INVALID_LOGIN_LIMIT }, clock), ONLINE_DEFAULTS, logger);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing TCP address");
  base = `http://127.0.0.1:${address.port}`;
}
async function close() { server.closeAllConnections(); await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
async function request(route: string, options: { method?: string; token?: string; body?: unknown; origin?: string } = {}) {
  const response = await fetch(base + route, {
    method: options.method ?? "GET", headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.origin ? { Origin: options.origin } : {}),
    }, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}
async function login(key: string) {
  const result = await request(API_ROUTES.login, { method: "POST", body: { email: users[key]!.email, password } });
  expect(result.status).toBe(200); expect(result.body.ok).toBe(true);
  return result.body.data.token as string;
}

describe.runIf(process.env.PROSPECTOR_PG_INTEGRATION === "1")("real HTTP and PG identity boundary", () => {
  beforeAll(async () => {
    execFileSync(process.execPath, ["scripts/crm-postgres.mjs", "start"], { timeout: TIMEOUT_MS, stdio: "pipe", windowsHide: true });
    pool = new Pool(readTestDatabaseConfig());
    const crm = new PostgresCrmRepository(pool, logger);
    expect((await crm.migrate()).ok).toBe(true);
    repo = new PostgresAuthRepository(pool, logger);
    expect((await repo.migrate()).ok).toBe(true);
    passwords = new PasswordAdapter(ONLINE_DEFAULTS.password_concurrency);
    await passwords.initialize();
    const hash = await passwords.hash(password);
    for (const [key, roles, admin] of [["admin", ["admin"], true], ["ops", ["operations"], false], ["a", ["sales"], false], ["b", ["sales"], false], ["none", [], false], ["identityOnly", [], true], ["crmAdminOnly", ["admin"], false]] as [string, CrmRole[], boolean][]) {
      const userId = randomUUID(), email = `${prefix}-${key.toLowerCase()}@example.invalid`;
      users[key] = { userId, email };
      expect((await repo.ensureFixture({ userId, email, displayName: key, identityAdmin: admin, crmRoles: roles, passwordHash: hash })).ok).toBe(true);
    }
    await start();
  }, TIMEOUT_MS);
  afterAll(async () => { if (server?.listening) await close(); await pool?.end(); });

  it("has actual health endpoints, rejects anonymous access and leaked fields", async () => {
    expect((await request(API_ROUTES.ready)).status).toBe(200);
    expect((await request(API_ROUTES.me)).status).toBe(401);
    tokens.admin = await login("admin");
    const identity = await request(API_ROUTES.me, { token: tokens.admin });
    expect(identity.body.data.userId).toBe(users.admin!.userId);
    expect(identity.body.data.emailVerified).toBe(false);
    expect(JSON.stringify(identity.body)).not.toMatch(/password|tokenHash|securityRevision/);
    expect(identity.headers.get("cache-control")).toContain("no-store");
  });
  it("serves only the authenticated account's shared profile and derived growth", async () => {
    const token = await login("admin");
    const userId = users.admin!.userId;
    await pool.query("INSERT INTO identity.user_profiles(user_id,avatar_id,bio) VALUES($1,'av-04','') ON CONFLICT(user_id) DO UPDATE SET avatar_id='av-04',bio=''", [userId]);
    await pool.query("INSERT INTO identity.account_growth_projection(user_id,total_xp,cycle,level,today_xp,today_key) VALUES($1,6612,7,28,18,CURRENT_DATE) ON CONFLICT(user_id) DO UPDATE SET total_xp=6612,cycle=7,level=28,today_xp=18,today_key=CURRENT_DATE", [userId]);
    try {
      expect((await request(API_ROUTES.accountProfile)).status).toBe(401);
      const profile = await request(API_ROUTES.accountProfile, { token });
      expect(profile.status).toBe(200);
      expect(profile.body).toMatchObject({ ok: true, data: {
        userId, displayName: "admin", avatarId: "av-04", bio: "",
        growth: { totalXp: 6612, cycle: 7, level: 28, levelProgress: 16, levelCost: 21 },
      } });
    } finally {
      await pool.query("DELETE FROM identity.account_growth_projection WHERE user_id=$1", [userId]);
      await pool.query("DELETE FROM identity.user_profiles WHERE user_id=$1", [userId]);
    }
  });
  it("keeps missing shared profile and growth unknown instead of inventing values", async () => {
    const token = await login("a");
    const profile = await request(API_ROUTES.accountProfile, { token });
    expect(profile.status).toBe(200);
    expect(profile.body).toMatchObject({ ok: true, data: {
      userId: users.a!.userId, displayName: "a", avatarId: "default", bio: "", growth: null,
    } });
  });
  it("enforces manager and product roles server-side, ignoring claimed role", async () => {
    tokens.a = await login("a"); tokens.b = await login("b"); tokens.ops = await login("ops"); tokens.none = await login("none");
    expect((await request(API_ROUTES.users,{token:tokens.a})).status).toBe(403);
    expect((await request(API_ROUTES.users,{token:tokens.admin})).status).toBe(200);
    expect((await request(API_ROUTES.crmAccess,{token:tokens.none})).status).toBe(403);
    const sales = await request(API_ROUTES.crmAccess,{token:tokens.a});
    expect(sales.body.data.capabilities).toContain("leads:claim");
    expect(sales.body.data.capabilities).not.toContain("leads:publish");
    expect((await request(API_ROUTES.login,{method:"POST",body:{email:users.a!.email,password,role:"admin"}})).status).toBe(400);
    expect((await request(API_ROUTES.crmAccess,{token:tokens.ops})).body.data.capabilities).toContain("leads:publish");
  }, TIMEOUT_MS);
  it("separates identity administration from CRM management grants",async()=> {
    const identityOnly=await login("identityOnly"),crmOnly=await login("crmAdminOnly");
    expect((await request(API_ROUTES.users,{token:identityOnly})).status).toBe(200);
    expect((await request(API_ROUTES.crmAccess,{token:identityOnly})).status).toBe(403);
    expect((await request(API_ROUTES.users,{token:crmOnly})).status).toBe(403);
    expect((await request(API_ROUTES.crmAccess,{token:crmOnly})).body.data.capabilities).toEqual(["crm:manage"]);
  });
  it("bounds actual parallel password verification without crashing the HTTP process",async()=> {
    const results=await Promise.all(["identityOnly","crmAdminOnly","none"].map(key=>request(API_ROUTES.login,{method:"POST",body:{email:users[key]!.email,password}})));
    expect(results.filter(result=>result.status===200)).toHaveLength(ONLINE_DEFAULTS.password_concurrency);
    expect(results.filter(result=>result.status===503)).toHaveLength(1);
    expect((await request(API_ROUTES.live)).status).toBe(200);
  });
  it("rejects forged/expired sessions and preserves independent logout across restart", async () => {
    expect((await request(API_ROUTES.me,{token:randomBytes(32).toString("base64url")})).status).toBe(401);
    const expiring = await login("a");
    await pool.query("UPDATE identity.sessions SET created_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE token_hash=$1",[tokenAdapter.hash(expiring)]);
    expect((await request(API_ROUTES.me,{token:expiring})).status).toBe(401);
    expect((await request(API_ROUTES.logout,{method:"POST",token:tokens.a})).status).toBe(200);
    expect((await request(API_ROUTES.me,{token:tokens.a})).status).toBe(401);
    await close(); await start();
    expect((await request(API_ROUTES.me,{token:tokens.a})).status).toBe(401);
    expect((await request(API_ROUTES.me,{token:tokens.b})).status).toBe(200);
  });
  it("reads current disable/revision/grants rather than trusting saved login roles", async () => {
    await pool.query("UPDATE identity.product_grants SET active=false WHERE user_id=$1",[users.b!.userId]);
    expect((await request(API_ROUTES.crmAccess,{token:tokens.b})).status).toBe(403);
    await pool.query("UPDATE identity.users SET active=false WHERE user_id=$1",[users.b!.userId]);
    expect((await request(API_ROUTES.me,{token:tokens.b})).status).toBe(401);
    await pool.query("UPDATE identity.users SET security_revision=security_revision+1 WHERE user_id=$1",[users.ops!.userId]);
    expect((await request(API_ROUTES.me,{token:tokens.ops})).status).toBe(401);
    const original = users.b!;
    const originalHash=(await repo.credential(original.email));
    const fixture = await repo.ensureFixture({ ...original,displayName:"changed",identityAdmin:true,crmRoles:["admin"],passwordHash:await passwords.hash(password) });
    expect(fixture.ok).toBe(true);
    expect((await pool.query("SELECT active FROM identity.users WHERE user_id=$1",[original.userId])).rows[0].active).toBe(false);
    expect(await repo.credential(original.email)).toEqual(originalHash);
  }, TIMEOUT_MS);
  it("returns generic login errors and bounds attempts", async () => {
    const email = `${prefix}-unknown@example.invalid`;
    for(let attempt=0;attempt<INVALID_LOGIN_LIMIT;attempt++) {
      const invalid = await request(API_ROUTES.login,{method:"POST",body:{email,password}});
      expect(invalid.status).toBe(401);expect(invalid.body.error.code).toBe("UNAUTHORIZED");
    }
    expect((await request(API_ROUTES.login,{method:"POST",body:{email,password}})).status).toBe(429);
  }, TIMEOUT_MS);
  it("rejects cross-origin, malformed/oversized bodies and does not log secrets", async () => {
    expect((await request(API_ROUTES.login,{method:"POST",body:{email:users.a!.email,password},origin:"http://evil.invalid"})).status).toBe(403);
    expect((await request(API_ROUTES.login,{method:"POST",body:{email:"x",password:"x"}})).status).toBe(400);
    expect((await request(API_ROUTES.login,{method:"POST",body:{email:"x",password:"x".repeat(ONLINE_DEFAULTS.request_body_bytes)}})).status).toBe(413);
    const raw = await fetch(base+API_ROUTES.login,{method:"POST",headers:{"Content-Type":"application/json"},body:"{"});
    expect(raw.status).toBe(400);
    const combined = logs.join("\n");
    expect(combined).not.toContain(password);
    for(const token of Object.values(tokens)) expect(combined).not.toContain(token);
  });
  it("rejects a forged Host and enforces a chunked body limit without losing the JSON response",async()=> {
    const hostname=new URL(base).hostname,port=new URL(base).port;
    const raw=async(host: string,oversized: boolean)=>new Promise<{status:number;body:any}>((resolve,reject)=>{
      const req=httpRequest({hostname,port,path:API_ROUTES.login,method:"POST",headers:{Host:host,"Content-Type":"application/json"}},res=>{
        const chunks:Buffer[]=[];res.on("data",chunk=>chunks.push(chunk));
        res.on("end",()=>{try{resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString("utf8"))});}catch(error){reject(error);}});
      });
      req.on("error",reject);
      req.write(oversized ? "x".repeat(ONLINE_DEFAULTS.request_body_bytes+1) : "{}");req.end();
    });
    expect((await raw("evil.invalid",false)).status).toBe(403);
    const oversized=await raw(`${hostname}:${port}`,true);
    expect(oversized.status).toBe(413);expect(oversized.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
  it("returns 503 through actual HTTP when the identity database cannot authenticate",async()=> {
    const broken=new Pool({...readTestDatabaseConfig(),password:randomBytes(32).toString("hex"),connectionTimeoutMillis:100});
    const unavailable=new PostgresAuthRepository(broken,logger);
    const service=createAuthService(unavailable,passwords,tokenAdapter,clock,TTL_SECONDS);
    const failed=createOnlineServer(service,new LoginRateGate(ONLINE_DEFAULTS,clock),ONLINE_DEFAULTS,logger);
    await new Promise<void>(resolve=>failed.listen(0,"127.0.0.1",resolve));
    const address=failed.address();
    if(!address || typeof address==="string") throw new Error("missing failed test TCP address");
    try {
      for(const route of [API_ROUTES.ready,API_ROUTES.me]) {
        const result=await fetch(`http://127.0.0.1:${address.port}${route}`,{headers:{Authorization:`Bearer ${tokens.admin}`}});
        expect(result.status).toBe(503);expect((await result.json() as any).ok).toBe(false);
      }
    } finally { failed.closeAllConnections();await new Promise<void>(resolve=>failed.close(()=>resolve()));await broken.end(); }
  });
  it("keeps migrations idempotent, detects checksum drift and fails closed on database errors", async () => {
    expect((await repo.migrate()).ok).toBe(true);
    const before = await pool.query("SELECT checksum FROM crm_schema_migrations WHERE version='002-identity-foundation'");
    try {
      await pool.query("UPDATE crm_schema_migrations SET checksum='bad' WHERE version='002-identity-foundation'");
      expect((await repo.migrate()).ok).toBe(false);
    } finally { await pool.query("UPDATE crm_schema_migrations SET checksum=$1 WHERE version='002-identity-foundation'",[before.rows[0].checksum]); }
    expect((await pool.query("SELECT count(*)::int AS n FROM crm_schema_migrations WHERE version IN ('001-crm-foundation','002-identity-foundation')")).rows[0].n).toBe(2);
    const broken = new Pool({ ...readTestDatabaseConfig(), password:randomBytes(32).toString("hex"),connectionTimeoutMillis:100 });
    const unavailable = new PostgresAuthRepository(broken, logger);
    expect((await unavailable.ready()).ok).toBe(false);
    await broken.end();
  });
});
