import { and, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { agents, clusters, commands, instanceMembers, nodes, vrrpInstances } from "../db/schema";
import { createEnrollmentToken } from "../agents/enroll";
import { agentHub } from "../agents/hub";
import { checkAgentUpdateNow } from "../agents/releases";
import { serializeAgent } from "../agents/serialize";
import { env } from "../env";
import { nodeBehind } from "../keepalived/state";
import { buildNodeSpec } from "../keepalived/spec";
import { compareNames } from "../../shared/sort";
import { NAME_RE } from "../../shared/keepalived";
import { parseBody } from "./util";

export const nodeRoutes = new Hono();

type NodeRow = typeof nodes.$inferSelect;

const SCRIPT_BASE = `https://raw.githubusercontent.com/${env.agentRepo}/main/agent`;

function agentOf(nodeId: string) {
  return db.select().from(agents).where(eq(agents.nodeId, nodeId)).get();
}

export function serializeNode(node: NodeRow) {
  const agent = agentOf(node.id);
  const members = db
    .select({
      instanceId: instanceMembers.instanceId,
      name: vrrpInstances.name,
      service: vrrpInstances.service,
      priority: instanceMembers.priority,
      state: instanceMembers.state,
      maintenance: instanceMembers.maintenance,
      stateSince: instanceMembers.stateSince,
    })
    .from(instanceMembers)
    .innerJoin(vrrpInstances, eq(vrrpInstances.id, instanceMembers.instanceId))
    .where(eq(instanceMembers.nodeId, node.id))
    .all();
  const cluster = node.clusterId
    ? db.select({ id: clusters.id, name: clusters.name }).from(clusters).where(eq(clusters.id, node.clusterId)).get()
    : null;
  return {
    ...node,
    cluster: cluster ?? null,
    agent: serializeAgent(agent),
    interfaces: agent?.interfaces ?? [],
    members,
    behind: members.length > 0 && nodeBehind(node),
  };
}

function enrollment(nodeId: string) {
  const { token, expiresAt } = createEnrollmentToken(nodeId);
  const flags = [`--server ${env.baseUrl}`, `--token ${token}`];
  if (env.baseUrl.startsWith("http://")) flags.push("--allow-http");
  return {
    expiresAt,
    serverUrl: env.baseUrl,
    insecure: env.baseUrl.startsWith("http://"),
    command: `curl -fsSL ${SCRIPT_BASE}/install.sh | sh -s -- ${flags.join(" ")}`,
    uninstallCommand: `curl -fsSL ${SCRIPT_BASE}/uninstall.sh | sh`,
  };
}

function findNode(id: string) {
  return db.select().from(nodes).where(eq(nodes.id, id)).get();
}

const nodeInput = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(300).nullable().default(null),
  clusterId: z.string().max(64).nullable().default(null),
});

function checkCluster(clusterId: string | null | undefined) {
  if (!clusterId) return true;
  return !!db.select().from(clusters).where(eq(clusters.id, clusterId)).get();
}

nodeRoutes.get("/", (c) => {
  const rows = db.select().from(nodes).all().sort((a, b) => compareNames(a.name, b.name));
  return c.json({ nodes: rows.map(serializeNode) });
});

nodeRoutes.post("/", async (c) => {
  const body = await parseBody(c, nodeInput);
  if (body instanceof Response) return body;
  if (!checkCluster(body.clusterId)) return c.json({ error: "cluster not found" }, 400);
  const node = db.insert(nodes).values(body).returning().get();
  return c.json({ node: serializeNode(node), enrollment: enrollment(node.id) }, 201);
});

nodeRoutes.get("/:id", (c) => {
  const node = findNode(c.req.param("id"));
  return node ? c.json({ node: serializeNode(node) }) : c.json({ error: "not found" }, 404);
});

nodeRoutes.patch("/:id", async (c) => {
  const node = findNode(c.req.param("id"));
  if (!node) return c.json({ error: "not found" }, 404);
  const body = await parseBody(c, nodeInput.partial());
  if (body instanceof Response) return body;
  if (!checkCluster(body.clusterId)) return c.json({ error: "cluster not found" }, 400);
  if (body.clusterId !== undefined && body.clusterId !== node.clusterId) {
    const member = db.select().from(instanceMembers).where(eq(instanceMembers.nodeId, node.id)).get();
    if (member) return c.json({ error: "remove the node from its VIPs before moving it to another cluster" }, 409);
  }
  const updated = db
    .update(nodes)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(nodes.id, node.id))
    .returning()
    .get();
  return c.json({ node: serializeNode(updated) });
});

/** Removes the node. A connected agent is unpaired first; keepalived keeps running with its config. */
nodeRoutes.delete("/:id", (c) => {
  const node = findNode(c.req.param("id"));
  if (!node) return c.json({ error: "not found" }, 404);
  const agent = agentOf(node.id);
  if (agent && agentHub.isConnected(agent.id)) {
    agentHub.send(agent.id, "unpair", {}, { ttlMs: 30_000 });
    setTimeout(() => agentHub.disconnect(agent.id), 2_000);
  }
  db.delete(nodes).where(eq(nodes.id, node.id)).run();
  return c.json({ ok: true });
});

nodeRoutes.post("/:id/enroll", (c) => {
  const node = findNode(c.req.param("id"));
  return node ? c.json(enrollment(node.id)) : c.json({ error: "not found" }, 404);
});

nodeRoutes.post("/:id/unpair", (c) => {
  const node = findNode(c.req.param("id"));
  const agent = node && agentOf(node.id);
  if (!agent) return c.json({ error: "no agent paired" }, 404);
  if (agentHub.isConnected(agent.id)) agentHub.send(agent.id, "unpair", {}, { ttlMs: 30_000 });
  setTimeout(() => agentHub.disconnect(agent.id), 2_000);
  db.delete(agents).where(eq(agents.id, agent.id)).run();
  db.update(nodes).set({ online: false, configMode: null, status: null }).where(eq(nodes.id, node!.id)).run();
  return c.json({ ok: true });
});

/** Runs a command on the node's agent and waits for the answer. */
type CommandType = Parameters<typeof agentHub.send>[1];

async function run(c: Context, type: CommandType, args: Record<string, unknown> = {}, timeoutMs = 20_000) {
  const node = findNode(c.req.param("id")!);
  const agent = node && agentOf(node.id);
  if (!agent) return c.json({ error: "no agent paired" }, 404);
  const ack = await agentHub.sendAndWait(agent.id, type, args, timeoutMs);
  if (!ack.ok) return c.json({ error: ack.error ?? "command failed" }, 502);
  return c.json(ack.result ?? {});
}

/** Starts a long command and returns its id; the UI follows it with GET /commands/:commandId. */
function start(nodeId: string, type: CommandType, args: Record<string, unknown> = {}) {
  const agent = agentOf(nodeId);
  if (!agent) return { error: "no agent paired" } as const;
  if (!agentHub.isConnected(agent.id)) return { error: "agent is not connected" } as const;
  return { commandId: agentHub.send(agent.id, type, args, { ttlMs: 15 * 60_000 }).id } as const;
}

nodeRoutes.post("/:id/detect", (c) => run(c, "ka_detect"));

nodeRoutes.post("/:id/install", (c) => {
  const started = start(c.req.param("id"), "ka_install");
  return "error" in started ? c.json(started, 409) : c.json(started);
});

nodeRoutes.get("/:id/commands/:commandId", (c) => {
  const node = findNode(c.req.param("id"));
  const agent = node && agentOf(node.id);
  if (!agent) return c.json({ error: "not found" }, 404);
  const row = db
    .select()
    .from(commands)
    .where(and(eq(commands.id, c.req.param("commandId")), eq(commands.agentId, agent.id)))
    .get();
  if (!row) return c.json({ error: "not found" }, 404);
  const expired = row.expiresAt.getTime() < Date.now() && ["pending", "sent"].includes(row.status);
  const status = row.status === "acked" ? "done" : row.status === "failed" || expired ? "failed" : "running";
  const error = expired ? "the agent did not finish in time" : row.error;
  return c.json({ status, error, lines: agentHub.commandOutput(row.id) });
});

const modeSchema = z.object({ mode: z.enum(["managed", "monitor"]) });

/** Records the choice from the setup wizard on the server and the agent. */
nodeRoutes.post("/:id/mode", async (c) => {
  const node = findNode(c.req.param("id"));
  if (!node) return c.json({ error: "not found" }, 404);
  const body = await parseBody(c, modeSchema);
  if (body instanceof Response) return body;
  const agent = agentOf(node.id);
  if (!agent) return c.json({ error: "no agent paired" }, 404);
  const ack = await agentHub.sendAndWait(agent.id, "ka_import", { mode: body.mode });
  if (!ack.ok) return c.json({ error: ack.error ?? "command failed" }, 502);
  db.update(nodes).set({ configMode: body.mode, updatedAt: new Date() }).where(eq(nodes.id, node.id)).run();
  return c.json({ node: serializeNode(findNode(node.id)!), detect: ack.result });
});

const serviceSchema = z.object({ action: z.enum(["start", "stop", "restart", "reload", "enable", "disable"]) });

nodeRoutes.post("/:id/service", async (c) => {
  const body = await parseBody(c, serviceSchema);
  if (body instanceof Response) return body;
  return run(c, "ka_service", { action: body.action }, 30_000);
});

const maintenanceSchema = z.object({
  on: z.boolean(),
  instances: z.array(z.string().regex(NAME_RE)).max(64).default([]),
});

nodeRoutes.post("/:id/maintenance", async (c) => {
  const body = await parseBody(c, maintenanceSchema);
  if (body instanceof Response) return body;
  return run(c, "ka_maintenance", body);
});

nodeRoutes.post("/:id/logs", async (c) => {
  const body = await parseBody(c, z.object({ lines: z.number().int().min(1).max(500).default(200) }));
  if (body instanceof Response) return body;
  return run(c, "ka_logs", body);
});

nodeRoutes.post("/:id/check-update", async (c) => {
  const node = findNode(c.req.param("id"));
  const agent = node && agentOf(node.id);
  if (!agent) return c.json({ error: "no agent paired" }, 404);
  const result = await checkAgentUpdateNow(agent.id);
  return result.ok ? c.json(result) : c.json(result, 502);
});

nodeRoutes.patch("/:id/auto-update", async (c) => {
  const node = findNode(c.req.param("id"));
  const agent = node && agentOf(node.id);
  if (!agent) return c.json({ error: "no agent paired" }, 404);
  const body = await parseBody(c, z.object({ enabled: z.boolean() }));
  if (body instanceof Response) return body;
  db.update(agents).set({ autoUpdate: body.enabled }).where(eq(agents.id, agent.id)).run();
  return c.json({ node: serializeNode(node!) });
});

/** The spec KeepWatch would send, with problems, for the node page. Passwords are left out. */
nodeRoutes.get("/:id/spec", (c) => {
  const node = findNode(c.req.param("id"));
  if (!node) return c.json({ error: "not found" }, 404);
  const { spec, problems } = buildNodeSpec(node.id);
  return c.json({ spec, problems });
});

export function nodesInCluster(clusterId: string) {
  return db.select().from(nodes).where(eq(nodes.clusterId, clusterId)).all();
}

export function nodesById(ids: string[]) {
  return ids.length ? db.select().from(nodes).where(inArray(nodes.id, ids)).all() : [];
}
