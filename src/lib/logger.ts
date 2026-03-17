/**
 * Structured JSON logger for gp_core (DD-24, Story 1.9)
 *
 * Zero external dependencies — writes newline-delimited JSON to stdout.
 * Each log line: {"ts":"ISO8601","level":"info","service":"gp_core","action":"..."}
 */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  ts: string;
  level: LogLevel;
  service: "gp_core";
  correlation_id?: string;
  market_id?: string;
  action: string;
  duration_ms?: number;
  error?: string;
  [key: string]: unknown;
}

type LogContext = Omit<
  LogEntry,
  "ts" | "level" | "service" | "action"
>;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): LogLevel {
  const env = process.env.GP_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_PRIORITY) return env as LogLevel;
  return "info";
}

function write(level: LogLevel, action: string, context?: LogContext): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[getMinLevel()]) return;

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    service: "gp_core",
    action,
    ...context,
  };

  process.stdout.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (action: string, context?: LogContext) => write("debug", action, context),
  info: (action: string, context?: LogContext) => write("info", action, context),
  warn: (action: string, context?: LogContext) => write("warn", action, context),
  error: (action: string, context?: LogContext) => write("error", action, context),
};
