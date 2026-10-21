import { readFileSync } from "node:fs";
import path from "node:path";
import { getResourcesRoot } from "../config";
import { validateCenterBase } from "../core/center-endpoint";
import { ONLINE_LIMITS } from "../../shared/online-crm";

interface DeploymentConfigFile { baseUrl?: unknown; ratesUrl?: unknown }

function readDeploymentFile(resourceRoot: string): DeploymentConfigFile | null {
  const file = path.join(resourceRoot, "center.json");
  try {
    return JSON.parse(readFileSync(file, "utf8")) as DeploymentConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Deployment override: PROSPECTOR_CENTER_URL > assets/center.json > local test default. */
export function readConfiguredCenterBase(
  env: NodeJS.ProcessEnv = process.env,
  resourceRoot = getResourcesRoot(),
): string {
  const configured = env.PROSPECTOR_CENTER_URL?.trim();
  if (configured) {
    const valid = validateCenterBase(configured);
    if (!valid) throw new Error("PROSPECTOR_CENTER_URL 必须是带 HTTPS 的中心 Origin");
    return valid;
  }
  try {
    const value = readDeploymentFile(resourceRoot);
    if (!value) return ONLINE_LIMITS.defaultUrl;
    const valid = validateCenterBase(value.baseUrl);
    if (!valid) throw new Error("assets/center.json 中的 baseUrl 无效");
    return valid;
  } catch (error) {
    throw error;
  }
}

/** Packaged Navigator default; an explicit user setting or environment value wins in the caller. */
export function readConfiguredRatesBase(resourceRoot = getResourcesRoot()): string | null {
  const value = readDeploymentFile(resourceRoot);
  if (!value || value.ratesUrl === undefined) return null;
  const valid = validateCenterBase(value.ratesUrl);
  if (!valid) throw new Error("assets/center.json 中的 ratesUrl 无效");
  return valid;
}
