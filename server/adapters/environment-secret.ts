import { execFileSync } from 'node:child_process';

const WINDOWS_ENV_KEY = 'HKCU\\Environment';
const REGISTRY_LINE = /^\s*[^\s]+\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/;
const cached = new Map<string, string>();

/** The registry fallback exists for long-running Windows services started before the user env changed. */
export function parseWindowsEnvironmentValue(output: string, name: string): string {
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes(name)) continue;
    const match = REGISTRY_LINE.exec(line);
    if (match) return match[1]?.trim() || '';
  }
  return '';
}

/**
 * Reads a server-side secret name without logging its value. Process env stays
 * authoritative; Windows user env is a read-through fallback for local center.
 */
export function readEnvironmentSecret(name: string): string {
  const direct = process.env[name]?.trim() || '';
  if (direct) return direct;
  const cachedValue = cached.get(name);
  if (cachedValue) return cachedValue;
  if (process.platform !== 'win32' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return '';
  try {
    const output = execFileSync('reg.exe', ['query', WINDOWS_ENV_KEY, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const value = parseWindowsEnvironmentValue(output, name);
    if (value) cached.set(name, value);
    return value;
  } catch {
    // Missing keys are an expected configuration state, not a request failure.
    return '';
  }
}
