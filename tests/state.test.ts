import { beforeEach, describe, expect, test } from "bun:test";
import { desc, eq, gt } from "drizzle-orm";
import { db } from "../src/server/db/client";
import { agents, clusters, events, instanceMembers, nodes, stateTransitions } from "../src/server/db/schema";
import { vrrpInstances } from "../src/server/db/schema";
import { checkAlerts, evaluateInstance, handleNodeOffline, handleStatus } from "../src/server/keepalived/state";
import { buildNodeSpec } from "../src/server/keepalived/spec";
import { updateSettings } from "../src/server/settings";
import { box } from "../src/server/secrets";
import type { KaStatus, VrrpState } from "../src/shared/keepalived";

let clusterId: string;
let instanceId: string;
let a: string;
let b: string;
let since: number;

function status(state: VrrpState, holds: boolean, extra: Partial<KaStatus> = {}): KaStatus {
  return {
    installed: true,
    version: "2.2.8",
    service: "active",
    enabled: true,
    managed: true,
    configHash: "h",
    drift: false,
    conflict: null,
    instances: [{ name: "VI_web", state, priority: 100, since: null, maintenance: false }],
    addresses: holds ? [{ iface: "eth0", address: "10.0.0.10", prefix: 24 }] : [],
    checks: [],
    customScripts: false,
    ...extra,
  };
}

function newEvents() {
  return db.select().from(events).where(gt(events.id, since)).orderBy(events.id).all();
}

function agentFor(nodeId: string, address: string) {
  db.insert(agents)
    .values({
      nodeId,
      publicKey: crypto.randomUUID(),
      sealKey: "k",
      interfaces: [{ name: "eth0", mac: "", cidrs: [`${address}/24`, "fe80::1/64"] }],
    })
    .run();
}

beforeEach(() => {
  updateSettings({ flapWindowSec: 0, alertGraceSec: 0 });
  since = db.select().from(events).orderBy(desc(events.id)).get()?.id ?? 0;
  clusterId = db.insert(clusters).values({ name: "edge" }).returning().get().id;
  a = db.insert(nodes).values({ name: "lb1", clusterId, online: true, configMode: "managed" }).returning().get().id;
  b = db.insert(nodes).values({ name: "lb2", clusterId, online: true, configMode: "managed" }).returning().get().id;
  agentFor(a, "10.0.0.2");
  agentFor(b, "10.0.0.3");
  instanceId = db
    .insert(vrrpInstances)
    .values({
      clusterId,
      name: "VI_web",
      vrid: 51,
      interface: "eth0",
      vrrpVersion: 2,
      authPassEnc: box.encrypt("s3cret"),
      virtualIps: [{ address: "10.0.0.10", prefix: 24 }],
    })
    .returning()
    .get().id;
  db.insert(instanceMembers).values({ instanceId, nodeId: a, priority: 150, initialState: "MASTER" }).run();
  db.insert(instanceMembers).values({ instanceId, nodeId: b, priority: 100 }).run();
});

describe("node spec", () => {
  test("fills in unicast peers and seals the password", () => {
    const sealed: string[] = [];
    const built = buildNodeSpec(a, (plain) => {
      sealed.push(plain);
      return "s1:sealed";
    });
    expect(built.problems).toEqual([]);
    const inst = built.spec.instances[0]!;
    expect(inst).toMatchObject({ unicastSrcIp: "10.0.0.2", unicastPeers: ["10.0.0.3"], priority: 150 });
    expect(inst.state).toBe("MASTER");
    expect(inst.authPass).toBe("s1:sealed");
    expect(sealed).toEqual(["s3cret"]);
  });

  test("the hash ignores sealing but follows the config", () => {
    const first = buildNodeSpec(a, () => "s1:one").hash;
    expect(buildNodeSpec(a, () => "s1:two").hash).toBe(first);
    db.update(instanceMembers).set({ priority: 160 }).where(eq(instanceMembers.nodeId, a)).run();
    expect(buildNodeSpec(a).hash).not.toBe(first);
  });

  test("reports a missing address instead of guessing", () => {
    db.update(agents).set({ interfaces: [] }).where(eq(agents.nodeId, b)).run();
    expect(buildNodeSpec(a).problems.join()).toContain("no address on eth0 of lb2");
  });
});

describe("state tracking", () => {
  test("first master is recorded without a failover, then a move is a failover", () => {
    handleStatus(a, status("MASTER", true));
    handleStatus(b, status("BACKUP", false));
    expect(db.select().from(vrrpInstances).where(eq(vrrpInstances.id, instanceId)).get()?.masterNodeId).toBe(a);
    expect(newEvents().filter((e) => e.type === "failover")).toHaveLength(0);

    handleStatus(a, status("FAULT", false));
    handleStatus(b, status("MASTER", true));
    const types = newEvents().map((e) => e.type);
    expect(types).toContain("instance_fault");
    const failover = newEvents().find((e) => e.type === "failover")!;
    expect(failover.message).toBe("VI_web (10.0.0.10) moved from lb1 to lb2: lb1 is in FAULT");
    expect(failover.data).toMatchObject({ from: "lb1", to: "lb2", cluster: "edge", vip: "VI_web" });
    const history = db.select().from(stateTransitions).where(eq(stateTransitions.instanceId, instanceId)).all();
    expect(history.map((h) => h.toState)).toEqual(["MASTER", "BACKUP", "FAULT", "MASTER"]);
  });

  test("split brain is reported after the grace period and resolved once", () => {
    handleStatus(a, status("MASTER", true));
    handleStatus(b, status("MASTER", true));
    checkAlerts(new Date(Date.now() + 1000));
    expect(newEvents().filter((e) => e.type === "split_brain")).toHaveLength(0);
    checkAlerts(new Date(Date.now() + 10_000));
    checkAlerts(new Date(Date.now() + 20_000));
    expect(newEvents().filter((e) => e.type === "split_brain")).toHaveLength(1);
    handleStatus(b, status("BACKUP", false));
    expect(newEvents().filter((e) => e.type === "split_brain_resolved")).toHaveLength(1);
  });

  test("no master when every member lost the VIP, and back again", () => {
    handleStatus(a, status("MASTER", true));
    handleStatus(a, status("FAULT", false));
    handleStatus(b, status("FAULT", false));
    checkAlerts(new Date(Date.now() + 10_000));
    expect(newEvents().filter((e) => e.type === "no_master")).toHaveLength(1);
    handleStatus(a, status("MASTER", true));
    expect(newEvents().filter((e) => e.type === "master_restored")).toHaveLength(1);
  });

  test("an offline master does not count, so the backup taking over is a failover", () => {
    handleStatus(a, status("MASTER", true));
    handleStatus(b, status("BACKUP", false));
    db.update(nodes).set({ online: false }).where(eq(nodes.id, a)).run();
    handleNodeOffline(a);
    handleStatus(b, status("MASTER", true));
    expect(newEvents().find((e) => e.type === "failover")?.message).toContain("lb1 went offline");
  });

  test("service and check problems are reported once and recover", () => {
    const failing = status("BACKUP", false, {
      service: "failed",
      checks: [{ id: "web", ok: false, error: "connection refused" }],
    });
    handleStatus(a, failing);
    handleStatus(a, failing);
    let types = newEvents().map((e) => e.type);
    expect(types.filter((t) => t === "keepalived_service_failed")).toHaveLength(1);
    expect(types.filter((t) => t === "check_failed")).toHaveLength(1);
    handleStatus(a, status("BACKUP", false, { checks: [{ id: "web", ok: true }] }));
    types = newEvents().map((e) => e.type);
    expect(types).toContain("keepalived_service_recovered");
    expect(types).toContain("check_recovered");
  });

  test("maintenance changes are events", () => {
    handleStatus(a, status("MASTER", true));
    const maint = status("FAULT", false);
    maint.instances[0]!.maintenance = true;
    handleStatus(a, maint);
    const types = newEvents().map((e) => e.type);
    expect(types).toContain("maintenance_on");
    expect(types).not.toContain("instance_fault");
    evaluateInstance(instanceId);
  });
});
