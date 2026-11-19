import { and, eq, inArray, ne } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client";
import { agents, checks, clusters, instanceChecks, instanceMembers, nodes, vrrpInstances } from "../db/schema";
import { agentHub } from "../agents/hub";
import { box } from "../secrets";
import { getRollout, planCluster, RolloutError, startRollout } from "../keepalived/rollout";
import { evaluateInstance } from "../keepalived/state";
import { compareNames } from "../../shared/sort";
import {
  checkInputSchema,
  clusterInputSchema,
  instanceInputProblems,
  instanceInputSchema,
  type InstanceInput,
} from "../../shared/clusters";
import { NAME_RE } from "../../shared/keepalived";
import { parseBody } from "./util";

export const clusterRoutes = new Hono();

type InstanceRow = typeof vrrpInstances.$inferSelect;

function findCluster(id: string) {
  return db.select().from(clusters).where(eq(clusters.id, id)).get();
}

function serializeInstance(inst: InstanceRow) {
  const { authPassEnc, ...rest } = inst;
  const members = db.select().from(instanceMembers).where(eq(instanceMembers.instanceId, inst.id)).all();
  const checkIds = db
    .select({ id: instanceChecks.checkId })
    .from(instanceChecks)
    .where(eq(instanceChecks.instanceId, inst.id))
    .all()
    .map((r) => r.id);
  // The password never leaves the server, the UI only learns whether one is set.
  return { ...rest, hasPassword: !!authPassEnc, members: members.sort((a, b) => b.priority - a.priority), checkIds };
}

export function serializeCluster(cluster: typeof clusters.$inferSelect) {
  const instances = db.select().from(vrrpInstances).where(eq(vrrpInstances.clusterId, cluster.id)).all();
  const checkRows = db.select().from(checks).where(eq(checks.clusterId, cluster.id)).all();
  const nodeRows = db.select().from(nodes).where(eq(nodes.clusterId, cluster.id)).all();
  return {
    ...cluster,
    instances: instances.sort((a, b) => compareNames(a.name, b.name)).map(serializeInstance),
    checks: checkRows.sort((a, b) => compareNames(a.name, b.name)),
    nodeIds: nodeRows.map((n) => n.id),
  };
}

clusterRoutes.get("/", (c) => {
  const rows = db.select().from(clusters).all().sort((a, b) => compareNames(a.name, b.name));
  return c.json({ clusters: rows.map(serializeCluster) });
});

clusterRoutes.post("/", async (c) => {
  const body = await parseBody(c, clusterInputSchema);
  if (body instanceof Response) return body;
  const row = db.insert(clusters).values(body).returning().get();
  return c.json({ cluster: serializeCluster(row) }, 201);
});

clusterRoutes.get("/:id", (c) => {
  const row = findCluster(c.req.param("id"));
  return row ? c.json({ cluster: serializeCluster(row) }) : c.json({ error: "not found" }, 404);
});

clusterRoutes.patch("/:id", async (c) => {
  const row = findCluster(c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  const body = await parseBody(c, clusterInputSchema.partial());
  if (body instanceof Response) return body;
  const updated = db
    .update(clusters)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(clusters.id, row.id))
    .returning()
    .get();
  return c.json({ cluster: serializeCluster(updated) });
});

/** Deleting a cluster keeps its nodes. Their keepalived config stays until the next apply. */
clusterRoutes.delete("/:id", (c) => {
  const row = findCluster(c.req.param("id"));
  if (!row) return c.json({ error: "not found" }, 404);
  db.delete(clusters).where(eq(clusters.id, row.id)).run();
  return c.json({ ok: true });
});

// VIPs

/** Checks a VIP against the rest of the cluster. Returns problems, empty when it can be saved. */
function clusterProblems(clusterId: string, input: InstanceInput, instanceId: string | null, hasPassword: boolean) {
  const problems = instanceInputProblems(input, hasPassword);
  const memberNodes = input.members.length
    ? db.select().from(nodes).where(inArray(nodes.id, input.members.map((m) => m.nodeId))).all()
    : [];
  for (const m of input.members) {
    const node = memberNodes.find((n) => n.id === m.nodeId);
    if (!node) problems.push("A member node does not exist");
    else if (node.clusterId !== clusterId) problems.push(`${node.name} is not in this cluster`);
  }
  const others = db
    .select()
    .from(vrrpInstances)
    .where(
      instanceId
        ? and(eq(vrrpInstances.clusterId, clusterId), ne(vrrpInstances.id, instanceId))
        : eq(vrrpInstances.clusterId, clusterId),
    )
    .all();
  if (others.some((o) => o.name === input.name)) problems.push(`Another VIP is already called ${input.name}`);
  const clash = others.find((o) => o.vrid === input.vrid && o.interface === input.interface);
  if (clash) problems.push(`VRID ${input.vrid} is already used by ${clash.name} on ${input.interface}`);
  const addresses = new Set(others.flatMap((o) => o.virtualIps.map((v) => v.address)));
  for (const vip of input.virtualIps) {
    if (addresses.has(vip.address)) problems.push(`${vip.address} is already used by another VIP`);
  }
  const clusterChecks = db.select({ id: checks.id }).from(checks).where(eq(checks.clusterId, clusterId)).all();
  const known = new Set(clusterChecks.map((r) => r.id));
  if (input.checkIds.some((id) => !known.has(id))) problems.push("A health check does not exist in this cluster");
  return problems;
}

function saveMembersAndChecks(instanceId: string, input: InstanceInput) {
  const existing = db.select().from(instanceMembers).where(eq(instanceMembers.instanceId, instanceId)).all();
  const keep = new Set(input.members.map((m) => m.nodeId));
  for (const old of existing) {
    if (!keep.has(old.nodeId)) {
      db.delete(instanceMembers)
        .where(and(eq(instanceMembers.instanceId, instanceId), eq(instanceMembers.nodeId, old.nodeId)))
        .run();
    }
  }
  for (const m of input.members) {
    const values = { priority: m.priority, interface: m.interface, initialState: m.initialState };
    db.insert(instanceMembers)
      .values({ instanceId, nodeId: m.nodeId, ...values })
      .onConflictDoUpdate({ target: [instanceMembers.instanceId, instanceMembers.nodeId], set: values })
      .run();
  }
  db.delete(instanceChecks).where(eq(instanceChecks.instanceId, instanceId)).run();
  for (const checkId of input.checkIds) db.insert(instanceChecks).values({ instanceId, checkId }).run();
}

function instanceValues(input: InstanceInput) {
  const { members, checkIds, authPass, ...rest } = input;
  return {
    ...rest,
    ...(authPass === undefined ? {} : { authPassEnc: authPass ? box.encrypt(authPass) : null }),
    updatedAt: new Date(),
  };
}

clusterRoutes.post("/:id/instances", async (c) => {
  const cluster = findCluster(c.req.param("id"));
  if (!cluster) return c.json({ error: "not found" }, 404);
  const body = await parseBody(c, instanceInputSchema);
  if (body instanceof Response) return body;
  const problems = clusterProblems(cluster.id, body, null, false);
  if (problems.length) return c.json({ error: problems.join("; "), problems }, 400);
  const row = db.transaction(() => {
    const inst = db
      .insert(vrrpInstances)
      .values({ clusterId: cluster.id, ...instanceValues(body) })
      .returning()
      .get();
    saveMembersAndChecks(inst.id, body);
    return inst;
  });
  return c.json({ instance: serializeInstance(row) }, 201);
});

function findInstance(clusterId: string, id: string) {
  return db
    .select()
    .from(vrrpInstances)
    .where(and(eq(vrrpInstances.id, id), eq(vrrpInstances.clusterId, clusterId)))
    .get();
}

clusterRoutes.put("/:id/instances/:instanceId", async (c) => {
  const inst = findInstance(c.req.param("id"), c.req.param("instanceId"));
  if (!inst) return c.json({ error: "not found" }, 404);
  const body = await parseBody(c, instanceInputSchema);
  if (body instanceof Response) return body;
  const problems = clusterProblems(inst.clusterId, body, inst.id, !!inst.authPassEnc);
  if (problems.length) return c.json({ error: problems.join("; "), problems }, 400);
  const row = db.transaction(() => {
    const updated = db
      .update(vrrpInstances)
      .set(instanceValues(body))
      .where(eq(vrrpInstances.id, inst.id))
      .returning()
      .get();
    saveMembersAndChecks(inst.id, body);
    return updated;
  });
  evaluateInstance(row.id);
  return c.json({ instance: serializeInstance(row) });
});

clusterRoutes.delete("/:id/instances/:instanceId", (c) => {
  const inst = findInstance(c.req.param("id"), c.req.param("instanceId"));
  if (!inst) return c.json({ error: "not found" }, 404);
  db.delete(vrrpInstances).where(eq(vrrpInstances.id, inst.id)).run();
  return c.json({ ok: true });
});

/**
 * Fail over: put the current master of a VIP into maintenance so a backup takes over, or end that maintenance.
 * Only works on managed nodes, where KeepWatch owns the maintenance track file.
 */
clusterRoutes.post("/:id/instances/:instanceId/maintenance", async (c) => {
  const inst = findInstance(c.req.param("id"), c.req.param("instanceId"));
  if (!inst) return c.json({ error: "not found" }, 404);
  const body = await parseBody(c, z.object({ nodeId: z.string().max(64).optional(), on: z.boolean() }));
  if (body instanceof Response) return body;
  const nodeId = body.nodeId ?? inst.masterNodeId;
  if (!nodeId) return c.json({ error: "this VIP has no master to fail over from" }, 409);
  const member = db
    .select()
    .from(instanceMembers)
    .where(and(eq(instanceMembers.instanceId, inst.id), eq(instanceMembers.nodeId, nodeId)))
    .get();
  if (!member) return c.json({ error: "that node is not a member of this VIP" }, 400);
  const agent = db.select().from(agents).where(eq(agents.nodeId, nodeId)).get();
  if (!agent) return c.json({ error: "no agent paired" }, 404);
  const ack = await agentHub.sendAndWait(agent.id, "ka_maintenance", { on: body.on, instances: [inst.name] });
  if (!ack.ok) return c.json({ error: ack.error ?? "command failed" }, 502);
  return c.json({ ok: true });
});

// Health checks

clusterRoutes.post("/:id/checks", async (c) => {
  const cluster = findCluster(c.req.param("id"));
  if (!cluster) return c.json({ error: "not found" }, 404);
  const body = await parseBody(c, checkInputSchema);
  if (body instanceof Response) return body;
  const taken = db
    .select()
    .from(checks)
    .where(and(eq(checks.clusterId, cluster.id), eq(checks.key, body.key)))
    .get();
  if (taken) return c.json({ error: `A check with the id ${body.key} already exists` }, 400);
  const row = db.insert(checks).values({ clusterId: cluster.id, ...body }).returning().get();
  return c.json({ check: row }, 201);
});

clusterRoutes.put("/:id/checks/:checkId", async (c) => {
  const row = db
    .select()
    .from(checks)
    .where(and(eq(checks.id, c.req.param("checkId")), eq(checks.clusterId, c.req.param("id"))))
    .get();
  if (!row) return c.json({ error: "not found" }, 404);
  const body = await parseBody(c, checkInputSchema);
  if (body instanceof Response) return body;
  const taken = db
    .select()
    .from(checks)
    .where(and(eq(checks.clusterId, row.clusterId), eq(checks.key, body.key), ne(checks.id, row.id)))
    .get();
  if (taken) return c.json({ error: `A check with the id ${body.key} already exists` }, 400);
  const updated = db
    .update(checks)
    .set({ ...body, updatedAt: new Date() })
    .where(eq(checks.id, row.id))
    .returning()
    .get();
  return c.json({ check: updated });
});

clusterRoutes.delete("/:id/checks/:checkId", (c) => {
  const row = db
    .select()
    .from(checks)
    .where(and(eq(checks.id, c.req.param("checkId")), eq(checks.clusterId, c.req.param("id"))))
    .get();
  if (!row) return c.json({ error: "not found" }, 404);
  db.delete(checks).where(eq(checks.id, row.id)).run();
  return c.json({ ok: true });
});

// Import of an existing keepalived setup

const importedSchema = z.object({
  nodeId: z.string().max(64),
  instances: z
    .array(
      instanceInputSchema.omit({ members: true, checkIds: true }).extend({
        priority: z.number().int().min(1).max(254),
        initialState: z.enum(["MASTER", "BACKUP"]),
        original: z.string().regex(NAME_RE),
      }),
    )
    .min(1)
    .max(64),
});

/**
 * Adds instances read from a node's keepalived.conf as VIPs with that node as a member. The originals are commented
 * out on the next apply, so keepalived never runs both. Importing the same VIP from the next node adds it as a member.
 */
clusterRoutes.post("/:id/import", async (c) => {
  const cluster = findCluster(c.req.param("id"));
  if (!cluster) return c.json({ error: "not found" }, 404);
  const body = await parseBody(c, importedSchema);
  if (body instanceof Response) return body;
  const node = db.select().from(nodes).where(eq(nodes.id, body.nodeId)).get();
  if (!node || node.clusterId !== cluster.id) return c.json({ error: "the node is not in this cluster" }, 400);
  const problems: string[] = [];
  try {
    db.transaction(() => importInstances(cluster.id, node, body.instances, problems));
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
  }
  if (problems.length) return c.json({ error: problems.join("; "), problems }, 400);
  return c.json({ cluster: serializeCluster(cluster) });
});

class ImportError extends Error {}

type ImportedInstance = z.infer<typeof importedSchema>["instances"][number];

/** Saves the imported instances, or throws ImportError so the transaction leaves nothing behind. */
function importInstances(
  clusterId: string,
  node: typeof nodes.$inferSelect,
  instances: ImportedInstance[],
  problems: string[],
) {
  for (const imported of instances) {
    const { priority, initialState, original, ...fields } = imported;
    const existing = db
      .select()
      .from(vrrpInstances)
      .where(and(eq(vrrpInstances.clusterId, clusterId), eq(vrrpInstances.vrid, fields.vrid)))
      .all()
      .find((i) => i.virtualIps.some((v) => fields.virtualIps.some((f) => f.address === v.address)));
    const member = { nodeId: node.id, priority, interface: null, initialState };
    if (existing) {
      const current = serializeInstance(existing);
      const members = [
        ...current.members
          .filter((m) => m.nodeId !== node.id)
          .map(({ nodeId, priority, interface: iface, initialState }) => ({
            nodeId,
            priority,
            interface: iface,
            initialState,
          })),
        { ...member, interface: fields.interface === existing.interface ? null : fields.interface },
      ];
      const input = instanceInputSchema.parse({ ...current, members, authPass: undefined });
      const p = clusterProblems(clusterId, input, existing.id, !!existing.authPassEnc);
      if (p.length) problems.push(...p.map((x) => `${original}: ${x}`));
      else saveMembersAndChecks(existing.id, input);
    } else {
      const input = instanceInputSchema.parse({ ...fields, members: [member], checkIds: [] });
      const p = clusterProblems(clusterId, input, null, false);
      if (p.length) {
        problems.push(...p.map((x) => `${original}: ${x}`));
        continue;
      }
      const inst = db
        .insert(vrrpInstances)
        .values({ clusterId, ...instanceValues(input) })
        .returning()
        .get();
      saveMembersAndChecks(inst.id, input);
    }
  }
  if (problems.length) throw new ImportError(problems.join("; "));
  const migrate = [...new Set([...(node.migrateInstances ?? []), ...instances.map((i) => i.original)])];
  db.update(nodes).set({ migrateInstances: migrate, configMode: "managed" }).where(eq(nodes.id, node.id)).run();
}

// Plan and apply

clusterRoutes.post("/:id/plan", async (c) => {
  const cluster = findCluster(c.req.param("id"));
  if (!cluster) return c.json({ error: "not found" }, 404);
  return c.json({ nodes: await planCluster(cluster.id) });
});

clusterRoutes.post("/:id/apply", (c) => {
  const cluster = findCluster(c.req.param("id"));
  if (!cluster) return c.json({ error: "not found" }, 404);
  try {
    return c.json({ rolloutId: startRollout(cluster.id) });
  } catch (error) {
    if (error instanceof RolloutError) return c.json({ error: error.message }, 409);
    throw error;
  }
});

clusterRoutes.get("/:id/rollouts/:rolloutId", (c) => {
  const rollout = getRollout(c.req.param("rolloutId"));
  if (!rollout || rollout.clusterId !== c.req.param("id")) return c.json({ error: "not found" }, 404);
  return c.json({ rollout });
});
