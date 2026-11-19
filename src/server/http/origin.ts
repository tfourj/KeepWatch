import type { MiddlewareHandler } from "hono";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects state-changing requests that do not come from the KeepWatch UI. Browsers always send Origin on
 * POST, PATCH and DELETE; requests without it or from another origin are refused.
 */
export function requireSameOrigin(allowed: string[]): MiddlewareHandler {
  const origins = new Set(allowed.map((o) => o.replace(/\/+$/, "")));
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next();
    const origin = c.req.header("origin");
    if (origin && origins.has(origin)) return next();
    if (!origin && c.req.header("sec-fetch-site") === "same-origin") return next();
    return c.json({ error: "Cross-origin request refused" }, 403);
  };
}
