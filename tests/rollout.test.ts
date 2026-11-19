import { describe, expect, test } from "bun:test";
import { db } from "../src/server/db/client";
import { clusters, nodes, vrrpInstances } from "../src/server/db/schema";
import { rolloutOrder, RolloutError, startRollout } from "../src/server/keepalived/rollout";

describe("rollout", () => {
  test("applies to backups first and the current master last", () => {
    const clusterId = db.insert(clusters).values({ name: "order" }).returning().get().id;
    const ids = ["c", "a", "b"].map(
      (name) => db.insert(nodes).values({ name: `node-${name}`, clusterId }).returning().get().id,
    );
    db.insert(vrrpInstances)
      .values({
        clusterId,
        name: "VI_x",
        vrid: 9,
        interface: "eth0",
        virtualIps: [{ address: "10.9.0.1", prefix: 24 }],
        masterNodeId: ids[1],
      })
      .run();
    const order = rolloutOrder(clusterId, ids);
    expect(order[order.length - 1]).toBe(ids[1]!);
    expect(order.slice(0, 2)).toEqual([ids[2]!, ids[0]!]);
  });

  test("refuses a cluster without members", () => {
    const clusterId = db.insert(clusters).values({ name: "empty" }).returning().get().id;
    expect(() => startRollout(clusterId)).toThrow(RolloutError);
  });
});
