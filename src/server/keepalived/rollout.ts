import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client";
import { agents, clusters, configRolloutNodes, configRollouts, nodes } from "../db/schema";
import { vrrpInstances, type RolloutNodeStatus } from "../db/schema";
import { agentHub, type AckResult } from "../agents/hub";
import { emitEvent } from "../events";
import { createLogger } from "../logger";
import { buildNodeSpec, clusterMemberNodeIds } from "./spec";

const log = createLogger("rollout");

const APPLY_TIMEOUT_MS = 3 * 60_000;
const PLAN_TIMEOUT_MS = 20_000;
/** Time for a node to settle after an apply before the next one starts. */
const SETTLE_MS = 3_000;

type NodeRow = typeof nodes.$inferSelect;

export type NodePlan = {
  nodeId: string;
  name: string;
  ok: boolean;
  error?: string;
  problems: string[];
  skipped?: string;
  plan?: Record<string, unknown>;
};

/** Why a node cannot get the config right now, or null. */
function skipReason(node: NodeRow, agent: typeof agents.$inferSelect | undefined) {
  if (!agent) return "no agent paired";
  if (node.configMode === "monitor") return "monitored only";
  if (!node.configMode) return "setup not finished";
  if (!agentHub.isConnected(agent.id)) return "agent is offline";
  if (node.status?.installed === false) return "keepalived is not installed";
  return null;
}

function agentOf(nodeId: string) {
  return db.select().from(agents).where(eq(agents.nodeId, nodeId)).get();
}

/** Backups first, current masters last, so the VIPs move as little as possible. */
export function rolloutOrder(clusterId: string, nodeIds: string[]): string[] {
  const masters = new Set(
    db
      .select({ id: vrrpInstances.masterNodeId })
      .from(vrrpInstances)
      .where(eq(vrrpInstances.clusterId, clusterId))
      .all()
      .map((r) => r.id),
  );
  const names = new Map(
    (nodeIds.length ? db.select().from(nodes).where(inArray(nodes.id, nodeIds)).all() : []).map((n) => [n.id, n.name]),
  );
  return [...nodeIds].sort((x, y) => {
    const mx = masters.has(x) ? 1 : 0;
    const my = masters.has(y) ? 1 : 0;
    return mx - my || (names.get(x) ?? "").localeCompare(names.get(y) ?? "");
  });
}

/** Asks every member node what an apply would change, without writing anything. */
export async function planCluster(clusterId: string): Promise<NodePlan[]> {
  const ids = rolloutOrder(clusterId, clusterMemberNodeIds(clusterId));
  return Promise.all(
    ids.map(async (nodeId): Promise<NodePlan> => {
      const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get()!;
      const agent = agentOf(nodeId);
      const base = { nodeId, name: node.name };
      const reason = skipReason(node, agent);
      if (reason) return { ...base, ok: false, skipped: reason, problems: [] };
      let built;
      const command = agentHub.sendSealed(agent!.id, "ka_plan", (seal) => {
        built = buildNodeSpec(nodeId, seal);
        return { spec: built.spec, migrate: node.migrateInstances ?? [] };
      }, { ttlMs: PLAN_TIMEOUT_MS });
      const problems = built!.problems;
      const ack = await agentHub.waitForAck(command.id, PLAN_TIMEOUT_MS);
      if (!ack.ok) return { ...base, ok: false, error: ack.error, problems };
      return { ...base, ok: problems.length === 0, problems, plan: ack.result };
    }),
  );
}

function setNode(rolloutId: string, nodeId: string, values: Partial<typeof configRolloutNodes.$inferInsert>) {
  db.update(configRolloutNodes)
    .set(values)
    .where(and(eq(configRolloutNodes.rolloutId, rolloutId), eq(configRolloutNodes.nodeId, nodeId)))
    .run();
}

const running = new Set<string>();

export class RolloutError extends Error {}

/** Starts applying the cluster's config. Returns the rollout id; progress is read with getRollout. */
export function startRollout(clusterId: string) {
  const cluster = db.select().from(clusters).where(eq(clusters.id, clusterId)).get();
  if (!cluster) throw new RolloutError("cluster not found");
  if (running.has(clusterId)) throw new RolloutError("a rollout is already running for this cluster");
  const ids = rolloutOrder(clusterId, clusterMemberNodeIds(clusterId));
  if (!ids.length) throw new RolloutError("no node is a member of a VIP in this cluster");
  for (const id of ids) {
    const problems = buildNodeSpec(id).problems;
    if (problems.length) throw new RolloutError(problems.join("; "));
  }
  const rollout = db.insert(configRollouts).values({ clusterId }).returning().get();
  ids.forEach((nodeId, position) => {
    db.insert(configRolloutNodes).values({ rolloutId: rollout.id, nodeId, position }).run();
  });
  running.add(clusterId);
  void runRollout(rollout.id, cluster.name, ids)
    .catch((error) => log.error("rollout crashed", { error }))
    .finally(() => running.delete(clusterId));
  return rollout.id;
}

async function waitHealthy(nodeId: string) {
  await Bun.sleep(SETTLE_MS);
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (node?.status && node.status.service !== "active") return `keepalived is ${node.status.service}`;
  return null;
}

async function runRollout(rolloutId: string, clusterName: string, ids: string[]) {
  let failed: string | null = null;
  for (const nodeId of ids) {
    const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
    if (!node) continue;
    if (failed) {
      setNode(rolloutId, nodeId, { status: "skipped", error: "stopped after an earlier node failed" });
      continue;
    }
    const agent = agentOf(nodeId);
    const reason = skipReason(node, agent);
    if (reason) {
      setNode(rolloutId, nodeId, { status: "skipped", error: reason, finishedAt: new Date() });
      continue;
    }
    let hash = "";
    const command = agentHub.sendSealed(agent!.id, "ka_apply", (seal) => {
      const built = buildNodeSpec(nodeId, seal);
      hash = built.hash;
      return { spec: built.spec, migrate: node.migrateInstances ?? [] };
    }, { ttlMs: APPLY_TIMEOUT_MS });
    setNode(rolloutId, nodeId, { status: "applying", commandId: command.id, startedAt: new Date(), hash });
    const ack: AckResult = await agentHub.waitForAck(command.id, APPLY_TIMEOUT_MS);
    const output = agentHub.commandOutput(command.id);
    const data = { cluster: clusterName, node: node.name };
    if (!ack.ok) {
      const rolledBack = ack.result?.rolledBack === true;
      const status: RolloutNodeStatus = rolledBack ? "rolled_back" : "failed";
      setNode(rolloutId, nodeId, { status, error: ack.error ?? "apply failed", output, finishedAt: new Date() });
      emitEvent({
        type: rolledBack ? "config_rolled_back" : "config_failed",
        nodeId,
        clusterId: node.clusterId,
        title: rolledBack ? `Config rolled back on ${node.name}` : `Config not applied on ${node.name}`,
        message: `${node.name}: ${ack.error ?? "apply failed"}`,
        data: { ...data, error: ack.error },
      });
      failed = node.name;
      continue;
    }
    const changed = ack.result?.changed !== false;
    db.update(nodes)
      .set({ appliedSpecHash: hash, appliedAt: new Date(), migrateInstances: null })
      .where(eq(nodes.id, nodeId))
      .run();
    const unhealthy = changed ? await waitHealthy(nodeId) : null;
    if (unhealthy) {
      setNode(rolloutId, nodeId, { status: "failed", error: unhealthy, output, finishedAt: new Date() });
      failed = node.name;
      continue;
    }
    setNode(rolloutId, nodeId, { status: changed ? "applied" : "unchanged", output, finishedAt: new Date() });
  }
  const applied = db
    .select()
    .from(configRolloutNodes)
    .where(and(eq(configRolloutNodes.rolloutId, rolloutId), eq(configRolloutNodes.status, "applied")))
    .all();
  db.update(configRollouts)
    .set({
      status: failed ? "failed" : "succeeded",
      error: failed ? `stopped at ${failed}` : null,
      finishedAt: new Date(),
    })
    .where(eq(configRollouts.id, rolloutId))
    .run();
  const rollout = db.select().from(configRollouts).where(eq(configRollouts.id, rolloutId)).get()!;
  if (!failed && applied.length) {
    emitEvent({
      type: "config_applied",
      clusterId: rollout.clusterId,
      title: `Config applied to ${clusterName}`,
      message: `Applied the keepalived config to ${plural(applied.length, "node")} of ${clusterName}`,
      data: { cluster: clusterName, count: applied.length },
    });
  }
  log.info("rollout finished", { rolloutId, failed });
}

export function getRollout(id: string) {
  const rollout = db.select().from(configRollouts).where(eq(configRollouts.id, id)).get();
  if (!rollout) return null;
  const rows = db
    .select()
    .from(configRolloutNodes)
    .where(eq(configRolloutNodes.rolloutId, id))
    .orderBy(configRolloutNodes.position)
    .all();
  const names = new Map(
    (rows.length ? db.select().from(nodes).where(inArray(nodes.id, rows.map((r) => r.nodeId))).all() : []).map(
      (n) => [n.id, n.name],
    ),
  );
  return {
    ...rollout,
    nodes: rows.map((r) => ({
      ...r,
      name: names.get(r.nodeId) ?? "node",
      // Live output while the node is applying.
      output: r.status === "applying" && r.commandId ? agentHub.commandOutput(r.commandId) : (r.output ?? []),
    })),
  };
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
