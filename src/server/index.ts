import { Hono } from "hono";
import { websocket } from "hono/bun";
import { bodyLimit } from "hono/body-limit";
import { agentHub } from "./agents/hub";
import { startReleaseChecks } from "./agents/releases";
import { auth, hasAccount } from "./auth/auth";
import { COMMIT, VERSION } from "./build-info";
import { withClientIp } from "./client-ip";
import { runMigrations } from "./db/client";
import { env } from "./env";
import { securityHeaders } from "./http/headers";
import { requireSameOrigin } from "./http/origin";
import { createLogger } from "./logger";
import { agentPublicRoutes } from "./routes/agent-public";
import { apiRoutes } from "./routes/api";
import { serveWeb } from "./static";

const log = createLogger("server");

runMigrations();
agentHub.reset();

const devOrigins = process.env.NODE_ENV === "production" ? [] : ["http://localhost:5173"];

export const app = new Hono();

app.use("*", securityHeaders);
app.use("/api/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) }));
app.get("/api/health", (c) => c.json({ status: "ok", version: VERSION, commit: COMMIT }));
app.get("/api/setup", (c) => c.json({ needsSetup: !hasAccount() }));
// Better Auth checks the origin of its own requests against trustedOrigins.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(withClientIp(c)));
// Agents are not browsers: enrollment needs a one-time token, the socket a signed hello.
app.route("/api/agents", agentPublicRoutes);
app.use("/api/*", requireSameOrigin([env.baseUrl, ...devOrigins]));
app.route("/api", apiRoutes);
app.all("/api/*", (c) => c.json({ error: "not found" }, 404));
app.get("*", serveWeb);

const server = Bun.serve({
  port: env.port,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  websocket: { ...websocket, idleTimeout: 90, sendPings: true, maxPayloadLength: 256 * 1024 },
});
log.info("listening", { port: server.port, baseUrl: env.baseUrl });

startReleaseChecks();
