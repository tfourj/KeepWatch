import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { COMMIT, VERSION } from "./build-info";
import { runMigrations } from "./db/client";
import { env } from "./env";
import { securityHeaders } from "./http/headers";
import { requireSameOrigin } from "./http/origin";
import { createLogger } from "./logger";
import { serveWeb } from "./static";

const log = createLogger("server");

runMigrations();

const devOrigins = process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173"];

export const app = new Hono();

app.use("*", securityHeaders);
app.use("/api/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));
app.get("/api/health", (c) => c.json({ status: "ok", version: VERSION, commit: COMMIT }));
app.use("/api/*", requireSameOrigin([env.baseUrl, ...devOrigins]));
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
app.get("*", serveWeb);

const server = Bun.serve({
  port: env.port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
});
log.info("listening", { port: server.port, baseUrl: env.baseUrl });
