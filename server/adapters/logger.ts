import type { LogSink } from "../core/crm";

/** Callers provide fixed or explicitly sanitized diagnostics, never credentials or business content. */
export const serverLog: LogSink = {
  write(level, context, message) {
    process.stdout.write(`[${new Date().toISOString()}] [${level}] [${context}] ${message}\n`);
  },
};
