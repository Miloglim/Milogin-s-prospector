import type { LogSink } from "../core/crm";

/** Callers provide fixed, non-sensitive messages, never connection errors or business text. */
export const serverLog: LogSink = {
  write(level, context, message) {
    process.stdout.write(`[${new Date().toISOString()}] [${level}] [${context}] ${message}\n`);
  },
};
