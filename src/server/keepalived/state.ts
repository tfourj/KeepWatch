import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db/client";
import { agents, clusters, instanceMembers, nodes, stateTransitions, vrrpInstances } from "../db/schema";
import { emitEvent } from "../events";
import { createLogger } from "../logger";
import { getSettings } from "../settings";
import type { KaStatus, VrrpState } from "../../shared/keepalived";
import { buildNodeSpec } from "./spec";

const log = createLogger("state");

type InstanceRow = typeof vrrpInstances.$inferSelect;
type MemberRow = typeof instanceMembers.$inferSelect;
type NodeRow = typeof nodes.$inferSelect;

function clusterName(id: string) {
  return db.select({ name: clusters.name }).from(clusters).where(eq(clusters.id, id)).get()?.name ?? "cluster";
}

function vipLabel(inst: InstanceRow) {
  return inst.virtualIps.map((v) => v.address).join(", ");
}

function instanceData(inst: InstanceRow) {
  return { cluster: clusterName(inst.clusterId), vip: inst.name, address: vipLabel(inst) };
}

// Node problems: keepalived service, config drift, conflicts and failing checks

type Problem = { key: string; message: string; failed: Parameters<typeof emitEvent>[0]["type"] };

function nodeProblems(node: NodeRow, status: KaStatus): Problem[] {
  const out: Problem[] = [];
  const hasConfig = status.managed || status.instances.length > 0;
  if (status.installed && hasConfig && status.service !== "active") {
    out.push({ key: "service", message: `keepalived is ${status.service}`, failed: "keepalived_service_failed" });
  }
  if (status.drift && node.configMode === "managed") {
    out.push({ key: "drift", message: "keepwatch.conf was changed outside KeepWatch", failed: "config_drift" });
  }
  for (const check of status.checks) {
    if (!check.ok) {
      out.push({ key: `check:${check.id}`, message: check.error ?? `${check.id} failed`, failed: "check_failed" });
    }
  }
  return out;
}

const RECOVERED: Record<string, Parameters<typeof emitEvent>[0]["type"] | null> = {
  keepalived_service_failed: "keepalived_service_recovered",
  check_failed: "check_recovered",
  config_drift: null,
};

function reportProblems(node: NodeRow, status: KaStatus) {
  const current = nodeProblems(node, status);
  const previous = new Set(node.problems ?? []);
  const data = { node: node.name, cluster: node.clusterId ? clusterName(node.clusterId) : null };
  for (const p of current) {
    if (previous.has(p.key)) continue;
    const check = p.key.startsWith("check:") ? p.key.slice(6) : null;
    emitEvent({
      type: p.failed,
      nodeId: node.id,
      clusterId: node.clusterId,
      title: check ? `${check} failing on ${node.name}` : `${node.name}: ${p.message}`,
      message: check ? `Health check ${check} on ${node.name} failed: ${p.message}` : `${node.name}: ${p.message}`,
      data: { ...data, check, error: p.message, state: status.service },
    });
  }
  const now = new Set(current.map((p) => p.key));
  for (const key of previous) {
    if (now.has(key)) continue;
    const kind = key === "service" ? "keepalived_service_failed" : key.startsWith("check:") ? "check_failed" : "";
    const recovered = RECOVERED[kind];
    if (!recovered) continue;
    const check = key.startsWith("check:") ? key.slice(6) : null;
    emitEvent({
      type: recovered,
      nodeId: node.id,
      clusterId: node.clusterId,
      title: check ? `${check} healthy on ${node.name}` : `keepalived running on ${node.name}`,
      message: check ? `Health check ${check} on ${node.name} passes again` : `keepalived on ${node.name} runs again`,
      data: { ...data, check },
    });
  }
  return [...now];
}

// Member states

function holdsAll(inst: InstanceRow, status: KaStatus) {
  const present = new Set(status.addresses.map((a) => a.address));
  return inst.virtualIps.every((v) => present.has(v.address));
}

function recordTransition(
  member: MemberRow,
  inst: InstanceRow,
  node: NodeRow,
  next: VrrpState,
  maintenance: boolean,
  at: Date,
) {
  db.insert(stateTransitions)
    .values({ instanceId: inst.id, nodeId: node.id, fromState: member.state, toState: next, at })
    .run();
  const data = { ...instanceData(inst), node: node.name, from: member.state, to: next, state: next };
  // Maintenance puts the instance in FAULT on purpose, so it is not reported as one.
  if (next === "FAULT" && !maintenance) {
    emitEvent({
      type: "instance_fault",
      nodeId: node.id,
      clusterId: inst.clusterId,
      instanceId: inst.id,
      title: `${inst.name} in FAULT on ${node.name}`,
      message: `${inst.name} (${vipLabel(inst)}) went from ${member.state ?? "UNKNOWN"} to FAULT on ${node.name}`,
      data,
    });
  } else if (member.state === "FAULT" && !member.maintenance && next !== "FAULT" && next !== "STOP") {
    emitEvent({
      type: "instance_recovered",
      nodeId: node.id,
      clusterId: inst.clusterId,
      instanceId: inst.id,
      title: `${inst.name} recovered on ${node.name}`,
      message: `${inst.name} (${vipLabel(inst)}) is ${next} again on ${node.name}`,
      data,
    });
  }
}

/** Saves one agent report: node status, member states, transitions and problems. */
export function handleStatus(nodeId: string, status: KaStatus, now = new Date()) {
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get();
  if (!node) return;
  const problems = reportProblems(node, status);
  db.update(nodes)
    .set({ status: { ...status, reportedAt: now.getTime() }, problems, online: true, lastSeenAt: now })
    .where(eq(nodes.id, node.id))
    .run();

  const members = db.select().from(instanceMembers).where(eq(instanceMembers.nodeId, node.id)).all();
  if (!members.length) return;
  const instances = db
    .select()
    .from(vrrpInstances)
    .where(inArray(vrrpInstances.id, members.map((m) => m.instanceId)))
    .all();
  for (const member of members) {
    const inst = instances.find((i) => i.id === member.instanceId);
    if (!inst) continue;
    const reported = status.instances.find((i) => i.name === inst.name);
    const next: VrrpState = reported?.state ?? (status.service === "active" ? "UNKNOWN" : "STOP");
    const changed = next !== member.state;
    const maintenance = reported?.maintenance ?? false;
    if (changed) recordTransition(member, inst, node, next, maintenance, now);
    if (maintenance !== member.maintenance) {
      emitEvent({
        type: maintenance ? "maintenance_on" : "maintenance_off",
        nodeId: node.id,
        clusterId: inst.clusterId,
        instanceId: inst.id,
        title: `Maintenance ${maintenance ? "on" : "off"} for ${inst.name} on ${node.name}`,
        message: maintenance
          ? `${node.name} gave up ${inst.name} (${vipLabel(inst)}) for maintenance`
          : `${node.name} takes part in ${inst.name} (${vipLabel(inst)}) again`,
        data: { ...instanceData(inst), node: node.name },
      });
    }
    db.update(instanceMembers)
      .set({
        state: next,
        reportedPriority: reported?.priority ?? null,
        stateSince: changed ? now : (member.stateSince ?? now),
        maintenance,
        holdsVips: holdsAll(inst, status),
        reportedAt: now,
      })
      .where(and(eq(instanceMembers.instanceId, member.instanceId), eq(instanceMembers.nodeId, node.id)))
      .run();
  }
  for (const inst of instances) evaluateInstance(inst.id, now);
}

/** The agent went away: its members no longer count as MASTER. */
export function handleNodeOffline(nodeId: string, now = new Date()) {
  const members = db.select().from(instanceMembers).where(eq(instanceMembers.nodeId, nodeId)).all();
  for (const m of members) evaluateInstance(m.instanceId, now);
}

/** Why the previous master gave up the VIP, as far as KeepWatch can tell. */
function failoverReason(previous: MemberRow | undefined, previousNode: NodeRow | undefined) {
  if (!previous || !previousNode) return "previous master was removed";
  if (!previousNode.online) return `${previousNode.name} went offline`;
  if (previous.maintenance) return `${previousNode.name} is in maintenance`;
  if (previous.state === "FAULT") return `${previousNode.name} is in FAULT`;
  if (previous.state === "STOP") return `keepalived stopped on ${previousNode.name}`;
  return "a member with a higher priority took over";
}

// Failovers of one VIP within the flap window are reported once at the end of the window.
const flapping = new Map<string, { count: number; timer: ReturnType<typeof setTimeout>; last: () => void }>();

/** Sends a failover now, or adds it to the VIP's flap group. `emit` gets how many failovers it stands for. */
function reportFailover(inst: InstanceRow, emit: (count: number) => void) {
  const windowMs = getSettings().flapWindowSec * 1000;
  const group = flapping.get(inst.id);
  if (!windowMs) return emit(1);
  if (!group) {
    emit(1);
    const timer = setTimeout(() => {
      const g = flapping.get(inst.id);
      flapping.delete(inst.id);
      if (g && g.count > 1) g.last();
    }, windowMs);
    flapping.set(inst.id, { count: 1, timer, last: () => {} });
    return;
  }
  // The first failover was already sent; the rest are summed up when the window ends.
  group.count++;
  const count = group.count - 1;
  group.last = () => emit(count);
}

/** Works out the master of a VIP and reports failovers, split brain and no master. */
export function evaluateInstance(instanceId: string, now = new Date()) {
  const inst = db.select().from(vrrpInstances).where(eq(vrrpInstances.id, instanceId)).get();
  if (!inst) return;
  const members = db.select().from(instanceMembers).where(eq(instanceMembers.instanceId, inst.id)).all();
  const nodeRows = members.length
    ? db.select().from(nodes).where(inArray(nodes.id, members.map((m) => m.nodeId))).all()
    : [];
  const online = (m: MemberRow) => nodeRows.find((n) => n.id === m.nodeId)?.online ?? false;
  const reported = members.filter((m) => m.reportedAt && online(m));
  const masters = reported.filter((m) => m.state === "MASTER");
  const holders = reported.filter((m) => m.holdsVips);
  const update: Partial<typeof vrrpInstances.$inferInsert> = {};

  if (masters.length === 1 && masters[0]!.nodeId !== inst.masterNodeId) {
    const master = masters[0]!;
    const to = nodeRows.find((n) => n.id === master.nodeId)!;
    const previous = members.find((m) => m.nodeId === inst.masterNodeId);
    const previousNode = nodeRows.find((n) => n.id === inst.masterNodeId);
    if (inst.masterNodeId) {
      const reason = failoverReason(previous, previousNode);
      const from = previousNode?.name ?? "unknown";
      reportFailover(inst, (count) =>
        emitEvent({
          type: "failover",
          nodeId: to.id,
          clusterId: inst.clusterId,
          instanceId: inst.id,
          title: count > 1 ? `${inst.name} failed over ${count} more times` : `${inst.name} moved to ${to.name}`,
          message:
            count > 1
              ? `${inst.name} (${vipLabel(inst)}) changed master ${count} more times, now on ${to.name}`
              : `${inst.name} (${vipLabel(inst)}) moved from ${from} to ${to.name}: ${reason}`,
          data: { ...instanceData(inst), node: to.name, from, to: to.name, reason, count: count > 1 ? count : null },
        }),
      );
    }
    update.masterNodeId = master.nodeId;
    update.masterSince = now;
  }

  const split = masters.length > 1 || holders.length > 1;
  if (split && !inst.splitBrainSince) update.splitBrainSince = now;
  if (!split && inst.splitBrainSince) {
    update.splitBrainSince = null;
    update.splitBrainNotified = false;
    if (inst.splitBrainNotified) {
      emitEvent({
        type: "split_brain_resolved",
        clusterId: inst.clusterId,
        instanceId: inst.id,
        title: `${inst.name} has one master again`,
        message: `Split brain on ${inst.name} (${vipLabel(inst)}) is resolved`,
        data: instanceData(inst),
      });
    }
  }

  const none = reported.length > 0 && masters.length === 0;
  if (none && !inst.noMasterSince) update.noMasterSince = now;
  if (!none && inst.noMasterSince) {
    update.noMasterSince = null;
    update.noMasterNotified = false;
    if (inst.noMasterNotified) {
      const master = nodeRows.find((n) => n.id === masters[0]?.nodeId);
      emitEvent({
        type: "master_restored",
        nodeId: master?.id,
        clusterId: inst.clusterId,
        instanceId: inst.id,
        title: `${inst.name} has a master again`,
        message: `${master?.name ?? "A node"} holds ${inst.name} (${vipLabel(inst)}) again`,
        data: { ...instanceData(inst), node: master?.name },
      });
    }
  }
  if (Object.keys(update).length) {
    db.update(vrrpInstances).set(update).where(eq(vrrpInstances.id, inst.id)).run();
  }
}

/** Grace before split brain or no master is reported: three adverts plus the configured extra. */
export function alertGraceMs(inst: Pick<InstanceRow, "advertInt">) {
  return (inst.advertInt * 3 + getSettings().alertGraceSec) * 1000;
}

/** Sends split brain and no master alerts once they lasted longer than the grace period. */
export function checkAlerts(now = new Date()) {
  for (const inst of db.select().from(vrrpInstances).all()) {
    const grace = alertGraceMs(inst);
    const masters = db
      .select()
      .from(instanceMembers)
      .where(and(eq(instanceMembers.instanceId, inst.id), eq(instanceMembers.state, "MASTER")))
      .all();
    const names = masters.length
      ? db.select({ name: nodes.name }).from(nodes).where(inArray(nodes.id, masters.map((m) => m.nodeId))).all()
      : [];
    if (inst.splitBrainSince && !inst.splitBrainNotified && now.getTime() - inst.splitBrainSince.getTime() >= grace) {
      db.update(vrrpInstances).set({ splitBrainNotified: true }).where(eq(vrrpInstances.id, inst.id)).run();
      const list = names.map((n) => n.name).join(", ") || "more than one node";
      emitEvent({
        type: "split_brain",
        clusterId: inst.clusterId,
        instanceId: inst.id,
        title: `Split brain on ${inst.name}`,
        message: `${list} all hold ${inst.name} (${vipLabel(inst)}). Check the network between them.`,
        data: { ...instanceData(inst), node: list, count: names.length || null },
      });
    }
    if (inst.noMasterSince && !inst.noMasterNotified && now.getTime() - inst.noMasterSince.getTime() >= grace) {
      db.update(vrrpInstances).set({ noMasterNotified: true }).where(eq(vrrpInstances.id, inst.id)).run();
      emitEvent({
        type: "no_master",
        clusterId: inst.clusterId,
        instanceId: inst.id,
        title: `${inst.name} has no master`,
        message: `No node holds ${inst.name} (${vipLabel(inst)})`,
        data: instanceData(inst),
      });
    }
  }
}

/** Whether a node's last applied config matches what KeepWatch would write now. */
export function nodeBehind(node: Pick<NodeRow, "id" | "appliedSpecHash" | "configMode">) {
  if (node.configMode !== "managed") return false;
  return buildNodeSpec(node.id).hash !== node.appliedSpecHash;
}

export function pruneHistory(now = new Date()) {
  const cutoff = new Date(now.getTime() - getSettings().historyRetentionDays * 86_400_000);
  db.delete(stateTransitions).where(lt(stateTransitions.at, cutoff)).run();
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startStateTracking(hub: {
  onStatus: (hook: (agent: typeof agents.$inferSelect, status: KaStatus) => void) => void;
  onDisconnect: (hook: (agent: typeof agents.$inferSelect) => void) => void;
}) {
  hub.onStatus((agent, status) => handleStatus(agent.nodeId, status));
  hub.onDisconnect((agent) => handleNodeOffline(agent.nodeId));
  if (timer) return;
  timer = setInterval(() => {
    try {
      checkAlerts();
    } catch (error) {
      log.error("alert check failed", { error });
    }
  }, 2_000);
  setInterval(() => pruneHistory(), 6 * 3600_000);
}
