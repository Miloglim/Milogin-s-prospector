import { readFileSync } from "node:fs";
import path from "node:path";
import { getResourcesRoot } from "../config";
import { validateCenterBase } from "../core/center-endpoint";
import { ONLINE_LIMITS } from "../../shared/online-crm";

interface CenterConfigFile { baseUrl?: unknown }

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
  const file = path.join(resourceRoot, "center.json");
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as CenterConfigFile;
    const valid = validateCenterBase(value.baseUrl);
    if (!valid) throw new Error("assets/center.json 中的 baseUrl 无效");
    return valid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ONLINE_LIMITS.defaultUrl;
    throw error;
  }
}
