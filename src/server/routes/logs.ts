import { Hono } from "hono";
import { LOG_LEVELS, logBuffer, type LogLevel } from "../log-buffer";

const isLevel = (value: string | undefined): value is LogLevel => Boolean(value && value in LOG_LEVELS);

/** Recent server log lines, filtered by level, scope and text. Polled with `after` for new lines. */
export const logRoutes = new Hono().get("/", (c) => {
  const after = Number(c.req.query("after"));
  const limit = Number(c.req.query("limit"));
  const level = c.req.query("level");
  const configured = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return c.json({
    entries: logBuffer.query({
      after: Number.isFinite(after) && after > 0 ? after : undefined,
      minLevel: isLevel(level) ? level : undefined,
      scope: c.req.query("scope") || undefined,
      q: c.req.query("q")?.slice(0, 200) || undefined,
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : undefined,
    }),
    lastId: logBuffer.lastId,
    scopes: logBuffer.scopes(),
    logLevel: isLevel(configured) ? configured : "info",
  });
});
