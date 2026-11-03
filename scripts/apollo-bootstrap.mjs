import { pathToFileURL } from "node:url";
import path from "node:path";

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_METADATA = "http://apollo.qa4.yqn.corp:8080";
const DEFAULT_CLUSTER = "qa4";
const DEFAULT_NAMESPACE = "application";
const DEFAULT_APP_ID = "22124";

function enabled(name) {
  return ["1", "true", "yes", "on"].includes(String(process.env[name] || "").trim().toLowerCase());
}

function required(name, fallback = "") {
  return String(process.env[name] || fallback).trim();
}

async function fetchJson(url, context = "") {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    if (response.status === 404 && context) {
      throw new Error(`Apollo configuration is not published: ${context}`);
    }
    throw new Error(`Apollo request failed: HTTP ${response.status} ${url}`);
  }
  return response.json();
}

async function applyApolloEnvironment() {
  if (enabled("APOLLO_DISABLE")) return;

  const appId = required("APP_ID", required("APP_PORT", DEFAULT_APP_ID));
  const cluster = required("YQN_APOLLO_CLUSTER", DEFAULT_CLUSTER);
  const namespace = required("APOLLO_NAMESPACE", DEFAULT_NAMESPACE);
  const metadata = required("YQN_APOLLO_METADATA", DEFAULT_METADATA).replace(/\/+$/, "");

  const configService = required("YQN_APOLLO_CONFIG_SERVICE", metadata).replace(/\/+$/, "");

  const url = `${configService}/configs/${encodeURIComponent(appId)}/${encodeURIComponent(cluster)}/${encodeURIComponent(namespace)}`;
  const payload = await fetchJson(url, `${appId}/${cluster}/${namespace}`);
  const configurations = payload?.configurations;
  if (!configurations || typeof configurations !== "object") {
    throw new Error(`Apollo returned no configurations for ${appId}/${cluster}/${namespace}`);
  }

  let applied = 0;
  for (const [key, rawValue] of Object.entries(configurations)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    process.env[key] = typeof rawValue === "string" ? rawValue : JSON.stringify(rawValue);
    applied += 1;
  }
  process.stdout.write(`[apollo] loaded ${appId}/${cluster}/${namespace} (${applied} keys)\n`);
}

let apolloReady = true;
try {
  await applyApolloEnvironment();
} catch (error) {
  if (enabled("APOLLO_REQUIRED")) {
    process.stderr.write(`[apollo] startup failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
    apolloReady = false;
  } else {
    process.stderr.write(`[apollo] skipped: ${error instanceof Error ? error.message : "unknown error"}\n`);
  }
}

if (apolloReady) {
  const entry = process.argv[2] || "dist-server/adapters/online.cjs";
  await import(pathToFileURL(path.resolve(entry)).href);
}
