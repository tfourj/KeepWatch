import { and, count, desc, eq, gte } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { agents, clusters, events, nodes, vrrpInstances } from "../db/schema";
import { agentHub } from "../agents/hub";
import { compareNames } from "../../shared/sort";
import { serializeCluster } from "./clusters";

export const overviewRoutes = new Hono();

const DAY = 86_400_000;

/** Failovers per day for the last `days` days, oldest first, as UTC day starts. */
export function failoversPerDay(days: number, now = Date.now()) {
  const start = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const rows = db
    .select({ createdAt: events.createdAt })
    .from(events)
    .where(and(eq(events.type, "failover"), gte(events.createdAt, new Date(start))))
    .all();
  const buckets = Array.from({ length: days }, (_, i) => ({ day: start + i * DAY, failovers: 0 }));
  for (const row of rows) {
    const index = Math.floor((row.createdAt.getTime() - start) / DAY);
    if (buckets[index]) buckets[index].failovers++;
  }
  return buckets;
}

overviewRoutes.get("/", (c) => {
  const clusterRows = db.select().from(clusters).all().sort((a, b) => compareNames(a.name, b.name));
  const nodeRows = db.select().from(nodes).all();
  const agentRows = db.select().from(agents).all();
  const instances = db.select().from(vrrpInstances).all();
  const recentEvents = db.select().from(events).orderBy(desc(events.createdAt), desc(events.id)).limit(10).all();
  const since = new Date(Date.now() - DAY);
  const eventsToday = db.select({ n: count() }).from(events).where(gte(events.createdAt, since)).get()?.n ?? 0;
  return c.json({
    clusters: clusterRows.map(serializeCluster),
    nodes: nodeRows.map((n) => ({
      id: n.id,
      name: n.name,
      clusterId: n.clusterId,
      online: n.online,
      configMode: n.configMode,
      service: n.status?.service ?? null,
      drift: n.status?.drift ?? false,
      problems: n.problems ?? [],
    })),
    counts: {
      clusters: clusterRows.length,
      vips: instances.length,
      nodes: nodeRows.length,
      nodesOnline: nodeRows.filter((n) => n.online).length,
      agents: agentRows.length,
      agentsConnected: agentRows.filter((a) => agentHub.isConnected(a.id)).length,
      splitBrain: instances.filter((i) => i.splitBrainNotified).length,
      noMaster: instances.filter((i) => i.noMasterNotified).length,
      eventsToday,
    },
    failovers: failoversPerDay(30),
    recentEvents,
  });
});
