import { LOG_LEVELS, logBuffer, type LogLevel as Level } from "./log-buffer";

function threshold(): number {
  const value = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
  return LOG_LEVELS[value] ?? LOG_LEVELS.info;
}

function serializeError(value: unknown) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function write(level: Level, scope: string, msg: string, fields?: Record<string, unknown>) {
  if (LOG_LEVELS[level] < threshold()) return;
  const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, scope, msg };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) entry[key] = serializeError(value);
  }
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);

  // A detached copy for the Logs page, split into the fixed parts and the extra fields.
  const { ts, level: _level, scope: _scope, msg: _msg, ...rest } = JSON.parse(line) as Record<string, unknown>;
  logBuffer.push({ time: ts as string, level, scope, msg, fields: rest });
}

export type Logger = ReturnType<typeof createLogger>;

export function createLogger(scope: string) {
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => write("debug", scope, msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => write("info", scope, msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => write("warn", scope, msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => write("error", scope, msg, fields),
  };
}
