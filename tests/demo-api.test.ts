import { beforeAll, describe, expect, test } from "bun:test";
import { demoRequest, setDemoLatency } from "../src/web/demo/api";
import type { Cluster, KeepNode, Overview } from "../src/web/lib/types";

beforeAll(() => setDemoLatency(0));

describe("demo API", () => {
  test("answers every page the UI loads", async () => {
    const overview = await demoRequest<Overview>("GET", "/overview");
    expect(overview.counts.vips).toBeGreaterThan(0);
    expect(overview.failovers).toHaveLength(30);
    const { nodes } = await demoRequest<{ nodes: KeepNode[] }>("GET", "/nodes");
    expect(nodes.every((n) => n.status && n.agent)).toBe(true);
    for (const path of ["/clusters", "/events?page=1", "/channels", "/settings", "/security", "/logs", "/health"]) {
      expect(await demoRequest("GET", path)).toBeTruthy();
    }
  });

  test("failing over moves the master and records events", async () => {
    const { clusters } = await demoRequest<{ clusters: Cluster[] }>("GET", "/clusters");
    const edge = clusters.find((c) => c.name === "edge")!;
    const web = edge.instances.find((v) => v.name === "VI_web")!;
    const before = web.masterNodeId;
    await demoRequest("POST", `/clusters/${edge.id}/instances/${web.id}/maintenance`, { on: true });
    const after = (await demoRequest<{ clusters: Cluster[] }>("GET", "/clusters")).clusters
      .find((c) => c.id === edge.id)!
      .instances.find((v) => v.id === web.id)!;
    expect(after.masterNodeId).not.toBe(before);
    const events = await demoRequest<{ items: { type: string }[] }>("GET", "/events?page=1");
    expect(events.items.slice(0, 2).map((e) => e.type).sort()).toEqual(["failover", "maintenance_on"]);
  });

  test("actions that need a real node say so", async () => {
    const { nodes } = await demoRequest<{ nodes: KeepNode[] }>("GET", "/nodes");
    await expect(demoRequest("POST", `/nodes/${nodes[0]!.id}/detect`)).rejects.toThrow("Not available in the demo");
  });

  test("validates VIPs like the server", async () => {
    const { clusters } = await demoRequest<{ clusters: Cluster[] }>("GET", "/clusters");
    const edge = clusters.find((c) => c.name === "edge")!;
    const vip = {
      name: "VI_dup",
      vrid: 51,
      interface: "eth0",
      virtualIps: [{ address: "203.0.113.50", prefix: 24 }],
      members: [{ nodeId: edge.nodeIds[0], priority: 100 }],
    };
    await expect(demoRequest("POST", `/clusters/${edge.id}/instances`, vip)).rejects.toThrow("VRID 51");
  });
});
