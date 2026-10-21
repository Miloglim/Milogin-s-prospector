import fs from "node:fs";
import path from "node:path";

const RUNTIME = path.join(process.env.ProgramData || "C:\\ProgramData", "MiloginCenter");
const DEPLOYMENT_FILE = path.join(RUNTIME, "deployment.json");
const ADMIN_CREDENTIALS_FILE = path.join(RUNTIME, "bootstrap-admin.json");
const skipPublic = process.argv.includes("--skip-public");

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
async function jsonFetch(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error(`invalid JSON response from ${new URL(url).pathname}`); }
  return { response, payload };
}
function requireOk(value, label) {
  if (!value?.ok) throw new Error(`${label} failed`);
  return value.data;
}

async function main() {
  const deployment = readJson(DEPLOYMENT_FILE);
  for (const key of ["centerPublicOrigin", "centerInternalUrl", "navigatorPublicOrigin", "navigatorInternalUrl"]) {
    if (typeof deployment[key] !== "string" || !deployment[key]) throw new Error(`deployment.json missing ${key}`);
  }
  const centerLocal = requireOk((await jsonFetch(`${deployment.centerInternalUrl}/health/live`)).payload, "center local live");
  requireOk((await jsonFetch(`${deployment.centerInternalUrl}/health/ready`)).payload, "center local ready");
  requireOk((await jsonFetch(`${deployment.navigatorInternalUrl}/api/health/live`)).payload, "navigator local live");

  const admin = fs.existsSync(ADMIN_CREDENTIALS_FILE)
    ? readJson(ADMIN_CREDENTIALS_FILE)
    : { email: deployment.adminEmail, password: process.env.MILOGIN_VERIFY_ADMIN_PASSWORD || "" };
  if (typeof admin.email !== "string" || typeof admin.password !== "string" || !admin.password) throw new Error("default administrator credentials unavailable");
  const adminBase = skipPublic ? deployment.centerInternalUrl : deployment.centerPublicOrigin;
  const login = await jsonFetch(`${adminBase}/admin-api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: deployment.centerPublicOrigin },
    body: JSON.stringify({ email: admin.email, password: admin.password }),
  });
  requireOk(login.payload, "default administrator login");
  const cookie = (login.response.headers.get("set-cookie") || "").split(";", 1)[0];
  if (!cookie.startsWith("milogin_admin=")) throw new Error("administrator session cookie missing");
  const headers = { Cookie: cookie, Accept: "application/json" };
  const products = requireOk((await jsonFetch(`${adminBase}/admin-api/products`, { headers })).payload, "product catalog");
  const navigator = products.find(product => product.productId === "navigator");
  if (!navigator?.connected) throw new Error("Navigator product is not connected");
  requireOk((await jsonFetch(`${adminBase}/admin-api/navigator/dashboard`, { headers })).payload, "center to navigator chain");

  if (!skipPublic) {
    requireOk((await jsonFetch(`${deployment.centerPublicOrigin}/health/live`)).payload, "center public live");
    requireOk((await jsonFetch(`${deployment.centerPublicOrigin}/health/ready`)).payload, "center public ready");
    requireOk((await jsonFetch(`${deployment.navigatorPublicOrigin}/api/health/live`)).payload, "navigator public live");
  }
  process.stdout.write(JSON.stringify({ ok: true, data: {
    center: { local: "ready", public: skipPublic ? "skipped" : "ready", instanceId: centerLocal.instanceId },
    navigator: { local: "ready", public: skipPublic ? "skipped" : "ready" },
    administrator: admin.email,
    products: products.map(product => ({ productId: product.productId, connected: product.connected })),
    productChain: "ready",
  } }) + "\n");
}

void main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: "verification_failed", message: error instanceof Error ? error.message : "deployment verification failed" } }) + "\n");
  process.exitCode = 1;
});
