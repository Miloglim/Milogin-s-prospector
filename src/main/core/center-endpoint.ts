const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

/** Public center addresses must use HTTPS; plain HTTP is reserved for local test servers. */
export function validateCenterBase(input: unknown): string | null {
  if (typeof input !== "string") return null;
  try {
    const url = new URL(input.trim());
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.origin;
  } catch { /* Invalid URL is rejected before it can reach network IO. */ return null; }
}
