const MAX_DIAGNOSTIC_LENGTH = 500;

function clean(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .replace(/\b(postgres(?:ql)?:\/\/)[^@\s]+@/gi, "$1[redacted]@")
    .replace(/\b(password|passwd|pwd|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bfor user\s+(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "for user [redacted]")
    .replace(/\b(user|username)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function property(error: unknown, key: string): unknown {
  return error && typeof error === "object" && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

export function postgresErrorDiagnostic(error: unknown): string {
  const cause = property(error, "cause");
  return [
    `code=${clean(property(error, "code"), "UNKNOWN")}`,
    `name=${clean(property(error, "name"), "UNKNOWN")}`,
    `message=${clean(property(error, "message"), "unknown")}`,
    `cause_code=${clean(property(cause, "code"), "UNKNOWN")}`,
    `cause_message=${clean(property(cause, "message"), "unknown")}`,
  ].join(" ");
}
