import { and, count, desc, eq, inArray, like, or, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { channels, clusters, deliveries, deliveryAttempts, events, nodes } from "../db/schema";
import { retryDeliveries } from "../notify/dispatcher";

export const eventRoutes = new Hono();

eventRoutes.get("/", (c) => {
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(5, Number(c.req.query("pageSize") ?? 25) || 25));
  const filters: SQL[] = [];
  const type = c.req.query("type");
  const severity = c.req.query("severity");
  const clusterId = c.req.query("clusterId");
  const nodeId = c.req.query("nodeId");
  const q = c.req.query("q")?.trim();
  if (type) filters.push(inArray(events.type, type.split(",")));
  if (severity) filters.push(eq(events.severity, severity));
  if (clusterId) filters.push(eq(events.clusterId, clusterId));
  if (nodeId) filters.push(eq(events.nodeId, nodeId));
  if (q) filters.push(or(like(events.title, `%${q}%`), like(events.message, `%${q}%`))!);
  const where = filters.length ? and(...filters) : undefined;

  const total = db.select({ n: count() }).from(events).where(where).get()?.n ?? 0;
  const rows = db
    .select({ event: events, clusterName: clusters.name, nodeName: nodes.name })
    .from(events)
    .leftJoin(clusters, eq(events.clusterId, clusters.id))
    .leftJoin(nodes, eq(events.nodeId, nodes.id))
    .where(where)
    .orderBy(desc(events.createdAt), desc(events.id))
    .limit(pageSize)
    .offset((page - 1) * pageSize)
    .all();

  const ids = rows.map((r) => r.event.id);
  const deliveryRows = ids.length
    ? db
        .select({ delivery: deliveries, channelName: channels.name, channelType: channels.type })
        .from(deliveries)
        .innerJoin(channels, eq(deliveries.channelId, channels.id))
        .where(inArray(deliveries.eventId, ids))
        .all()
    : [];

  return c.json({
    total,
    page,
    pageSize,
    items: rows.map((r) => ({
      ...r.event,
      clusterName: r.clusterName,
      nodeName: r.nodeName,
      deliveries: deliveryRows
        .filter((d) => d.delivery.eventId === r.event.id)
        .map((d) => ({ ...d.delivery, channelName: d.channelName, channelType: d.channelType })),
    })),
  });
});

eventRoutes.get("/deliveries/:id/attempts", (c) => {
  const rows = db
    .select()
    .from(deliveryAttempts)
    .where(eq(deliveryAttempts.deliveryId, Number(c.req.param("id"))))
    .orderBy(desc(deliveryAttempts.attempt))
    .all();
  return c.json(rows);
});

eventRoutes.post("/deliveries/:id/retry", (c) => {
  retryDeliveries([Number(c.req.param("id"))]);
  return c.json({ ok: true });
});
