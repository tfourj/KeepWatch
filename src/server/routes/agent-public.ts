import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import { redeemEnrollment, EnrollmentError } from "../agents/enroll";
import { agentHub } from "../agents/hub";
import { enrollRequestSchema } from "../agents/protocol";
import { clientIp } from "../client-ip";
import { emitEvent } from "../events";
import { createLogger } from "../logger";

const log = createLogger("enroll");

/** Unauthenticated agent endpoints. Enrollment needs a one-time token; the socket needs a signed hello. */
export const agentPublicRoutes = new Hono();

const attempts = new Map<string, { count: number; resetAt: number }>();

export function enrollRateLimited(ip: string, now = Date.now()): boolean {
  const entry = attempts.get(ip);
  if (!entry || entry.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count++;
  return entry.count > 10;
}

agentPublicRoutes.post("/enroll", async (c) => {
  const ip = clientIp(c);
  if (enrollRateLimited(ip)) return c.json({ error: "too many attempts" }, 429);
  const parsed = enrollRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid request" }, 400);
  const { token, publicKey, sealKey, info } = parsed.data;
  try {
    const result = redeemEnrollment(token, { publicKey, sealKey }, info);
    log.info("agent enrolled", { node: result.nodeName, agentId: result.agentId, ip, retried: result.retried });
    if (!result.retried) {
      emitEvent({
        type: "agent_enrolled",
        nodeId: result.nodeId,
        title: `${result.nodeName} paired`,
        message: `Agent on ${info.hostname} paired with ${result.nodeName} (v${info.version})`,
        data: { node: result.nodeName, version: info.version },
      });
    }
    return c.json({ agentId: result.agentId, nodeName: result.nodeName, serverPublicKey: result.serverPublicKey });
  } catch (error) {
    if (error instanceof EnrollmentError) {
      log.warn("enrollment rejected", { ip, reason: error.message });
      return c.json({ error: error.message }, 403);
    }
    log.error("enrollment failed", { error });
    return c.json({ error: "enrollment failed" }, 500);
  }
});

agentPublicRoutes.get(
  "/ws",
  upgradeWebSocket((c) => agentHub.handlers(clientIp(c))),
);
